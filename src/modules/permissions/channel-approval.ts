/**
 * Unknown-channel registration flow.
 *
 * When the router hits an unwired messaging group AND the message was
 * addressed to the bot (SDK-confirmed mention or DM), it calls
 * `requestChannelApproval` instead of silently dropping. The flow:
 *
 *   1. Gather all existing agent groups.
 *   2. Pick an eligible approver (owner / admin) and a reachable DM for
 *      them, reusing the same primitives the sender-approval flow uses.
 *   3. Deliver a card with three action families:
 *        a. Connect to [agent] — one button per existing agent group.
 *           Single-agent installs get a one-click connect.
 *        b. Connect new agent — prompts for a free-text name, creates
 *           the agent immediately on reply.
 *        c. Reject — deny the channel.
 *   4. Record a `pending_channel_approvals` row holding the original event
 *      so it can be re-routed on connect/create.
 *
 * On connect (handler in index.ts):
 *   - Create `messaging_group_agents` with defaults
 *     (mention-sticky for groups / pattern='.' for DMs,
 *      sender_scope='known', ignored_message_policy='accumulate')
 *   - Add the triggering sender to `agent_group_members` so sender_scope
 *     doesn't bounce the replayed message into a sender-approval cascade
 *   - Delete the pending row, replay the original event
 *
 * On connect new agent (handler in index.ts):
 *   - Prompt for a free-text agent name via DM
 *   - On reply: create the agent group + filesystem, then wire
 *     and replay as above
 *
 * On reject:
 *   - Set `messaging_groups.denied_at = now()` so the router stops
 *     escalating on this channel until an admin explicitly re-wires
 *   - Delete the pending row
 *
 * Dedup: `pending_channel_approvals` PK on messaging_group_id. Second
 * mention while pending silently dropped.
 *
 * Failure modes (log + no row, so a future attempt can try again):
 *   - No agent groups exist (install never set up a first agent).
 *   - No eligible approver in user_roles (no owner yet).
 *   - Approver has no reachable DM.
 *   - Delivery adapter missing.
 */
import { randomUUID } from 'crypto';

import { normalizeOptions, type NormalizedOption, type RawOption } from '../../channels/ask-question.js';
import {
  createAgentGroup,
  getAgentGroup,
  getAgentGroupByFolder,
  getAllAgentGroups,
  updateAgentGroup,
} from '../../db/agent-groups.js';
import { createContainerConfig } from '../../db/container-configs.js';
import { getChannelAdapter } from '../../channels/channel-registry.js';
import { CHROMA_MCP_SERVER, chromaInstructions } from '../../chroma-onboarding.js';
import { addMcpServer } from '../../db/container-configs.js';
import { getMessagingGroup, updateMessagingGroup } from '../../db/messaging-groups.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { initGroupFilesystem } from '../../group-init.js';
import { log } from '../../log.js';
import type { InboundEvent } from '../../channels/adapter.js';
import type { AgentGroup } from '../../types.js';
import { pickApprovalDelivery, pickApprover } from '../approvals/primitive.js';
import { createPendingChannelApproval, hasInFlightChannelApproval } from './db/pending-channel-approvals.js';
import { hasAdminPrivilege } from './db/user-roles.js';
import { provisionSubAgents } from '../sub-agents/provision.js';

// ── Value constants (response handler in index.ts parses these) ──

export const CONNECT_PREFIX = 'connect:';
export const NEW_AGENT_VALUE = 'new_agent';
export const CHOOSE_EXISTING_VALUE = 'choose_existing';
export const REJECT_VALUE = 'reject';
// Provision a brand-new PERSONAL agent owned by the requesting sender (not the
// approver). The sender becomes scoped admin of their own agent group and gets
// their own container; the agent self-onboards on first wake. DM-only.
export const PROVISION_PERSONAL_VALUE = 'provision_personal';

// ── Utilities ──

function toFolder(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unnamed'
  );
}

// ── Card builders ──

function visibleAgentGroupsForApprover(
  agentGroups: AgentGroup[],
  approverUserId: string | null | undefined,
): AgentGroup[] {
  if (!approverUserId) return agentGroups;
  return agentGroups.filter((agentGroup) => hasAdminPrivilege(approverUserId, agentGroup.id));
}

function buildApprovalOptions(
  agentGroups: AgentGroup[],
  approverUserId?: string | null,
  ctx?: { isGroup?: boolean; senderName?: string },
): RawOption[] {
  const visibleAgentGroups = visibleAgentGroupsForApprover(agentGroups, approverUserId);
  const options: RawOption[] = [];

  // Personal-agent provisioning is the primary multi-tenant path: give the new
  // user their OWN agent + container, not a connection to one of the approver's.
  // DM-only — "personal agent" has no meaning for a shared group chat.
  if (!ctx?.isGroup) {
    const who = ctx?.senderName ?? 'this user';
    options.push({
      label: `🚀 Set up personal agent for ${who}`,
      selectedLabel: `✅ Provisioning personal agent…`,
      value: PROVISION_PERSONAL_VALUE,
    });
  }

  if (visibleAgentGroups.length === 1) {
    options.push({
      label: `Connect to ${visibleAgentGroups[0].name}`,
      selectedLabel: `✅ Connected to ${visibleAgentGroups[0].name}`,
      value: `${CONNECT_PREFIX}${visibleAgentGroups[0].id}`,
    });
  } else if (visibleAgentGroups.length > 1) {
    options.push({
      label: 'Choose existing agent',
      selectedLabel: '📋 Choosing…',
      value: CHOOSE_EXISTING_VALUE,
    });
  }
  options.push({
    label: 'Connect new agent',
    selectedLabel: '🆕 Connecting new agent…',
    value: NEW_AGENT_VALUE,
  });
  options.push({
    label: 'Reject',
    selectedLabel: '🙅 Rejected',
    value: REJECT_VALUE,
  });
  return options;
}

function buildQuestionText(
  isGroup: boolean,
  senderName: string | undefined,
  channelName: string | null,
  channelType: string,
): string {
  const who = senderName ?? 'Someone';
  if (isGroup) {
    const where = channelName ? `${channelName} on ${channelType}` : `a ${channelType} channel`;
    return `${who} mentioned your bot in ${where}. How would you like to handle this channel?`;
  }
  return `${who} sent your bot a DM on ${channelType}. How would you like to handle it?`;
}

// ── Main flow ──

export interface RequestChannelApprovalInput {
  messagingGroupId: string;
  event: InboundEvent;
}

export async function requestChannelApproval(input: RequestChannelApprovalInput): Promise<void> {
  const { messagingGroupId, event } = input;

  if (hasInFlightChannelApproval(messagingGroupId)) {
    log.debug('Channel registration already in flight — dropping retry', { messagingGroupId });
    return;
  }

  const agentGroups = getAllAgentGroups();
  if (agentGroups.length === 0) {
    log.warn('Channel registration skipped — no agent groups configured. Run /init-first-agent.', {
      messagingGroupId,
    });
    return;
  }
  // Use first agent group for approver resolution — owners and global admins
  // are returned regardless of which group we pass.
  const referenceGroup = agentGroups[0];

  const approvers = pickApprover(referenceGroup.id);
  if (approvers.length === 0) {
    log.warn('Channel registration skipped — no owner or admin configured', {
      messagingGroupId,
      targetAgentGroupId: referenceGroup.id,
    });
    return;
  }

  const originMg = getMessagingGroup(messagingGroupId);
  const originChannelType = originMg?.channel_type ?? '';

  // Resolve channel name if not yet persisted.
  if (originMg && !originMg.name) {
    const channelAdapter = getChannelAdapter(originChannelType);
    if (channelAdapter?.resolveChannelName) {
      try {
        const name = await channelAdapter.resolveChannelName(originMg.platform_id);
        if (name) {
          updateMessagingGroup(originMg.id, { name });
          originMg.name = name;
        }
      } catch {
        /* non-critical */
      }
    }
  }

  const delivery = await pickApprovalDelivery(approvers, originChannelType);
  if (!delivery) {
    log.warn('Channel registration skipped — no DM channel for any approver', {
      messagingGroupId,
      targetAgentGroupId: referenceGroup.id,
    });
    return;
  }

  const isGroup = event.message?.isGroup ?? originMg?.is_group === 1;

  let senderName: string | undefined;
  try {
    const parsed = JSON.parse(event.message.content) as Record<string, unknown>;
    senderName = (parsed.senderName ?? parsed.sender) as string | undefined;
  } catch {
    // non-critical
  }

  const channelName = originMg?.name ?? null;
  const title = isGroup ? '📣 Bot mentioned in new channel' : '💬 New direct message';
  const question = buildQuestionText(isGroup, senderName, channelName, originChannelType);
  // Personal-agent provisioning is DM-only. Treat as a DM only when no group
  // signal is present from any source (thread id, adapter flag, or the stored
  // messaging-group row) — this matches how the wiring handler picks engage_mode.
  const isDm = event.threadId === null && !event.message?.isGroup && originMg?.is_group !== 1;
  const options = normalizeOptions(buildApprovalOptions(agentGroups, delivery.userId, { isGroup: !isDm, senderName }));

  createPendingChannelApproval({
    messaging_group_id: messagingGroupId,
    agent_group_id: referenceGroup.id,
    original_message: JSON.stringify(event),
    approver_user_id: delivery.userId,
    created_at: new Date().toISOString(),
    title,
    options_json: JSON.stringify(options),
  });

  const adapter = getDeliveryAdapter();
  if (!adapter) {
    log.error('Channel registration row created but no delivery adapter is wired', { messagingGroupId });
    return;
  }

  try {
    await adapter.deliver(
      delivery.messagingGroup.channel_type,
      delivery.messagingGroup.platform_id,
      null,
      'chat-sdk',
      JSON.stringify({
        type: 'ask_question',
        questionId: messagingGroupId,
        title,
        question,
        options,
      }),
    );
    log.info('Channel registration card delivered', {
      messagingGroupId,
      agentGroupCount: agentGroups.length,
      approver: delivery.userId,
    });
  } catch (err) {
    log.error('Channel registration card delivery failed', { messagingGroupId, err });
  }
}

// ── Helpers for the response handler (index.ts) ──

/**
 * Build normalized options for the agent-selection follow-up card.
 */
export function buildAgentSelectionOptions(
  agentGroups: AgentGroup[],
  approverUserId?: string | null,
): NormalizedOption[] {
  const visibleAgentGroups = visibleAgentGroupsForApprover(agentGroups, approverUserId);
  const options: RawOption[] = visibleAgentGroups.map((ag) => ({
    label: ag.name,
    selectedLabel: `✅ Connected to ${ag.name}`,
    value: `${CONNECT_PREFIX}${ag.id}`,
  }));
  options.push({
    label: 'Cancel',
    selectedLabel: '🙅 Cancelled',
    value: REJECT_VALUE,
  });
  return normalizeOptions(options);
}

/**
 * Create a new agent group and initialize its filesystem. Handles
 * folder-name collisions with numeric suffixes.
 */
export function createNewAgentGroup(name: string): AgentGroup {
  let folder = toFolder(name);
  const baseFolder = folder;
  let suffix = 2;
  while (getAgentGroupByFolder(folder)) {
    folder = `${baseFolder}-${suffix}`;
    suffix++;
  }

  const agId = `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  createAgentGroup({
    id: agId,
    name,
    folder,
    agent_provider: null,
    created_at: new Date().toISOString(),
  });

  const collectionId = randomUUID();
  updateAgentGroup(agId, { chroma_collection_id: collectionId });

  const ag = getAgentGroup(agId)!;
  initGroupFilesystem(ag);
  addMcpServer(ag.id, 'chroma', CHROMA_MCP_SERVER);
  return ag;
}

/**
 * Onboarding directive seeded into a freshly-provisioned personal agent's
 * CLAUDE.local.md. On the agent's first wake it runs a short self-onboarding
 * conversation and persists the result via the `self-customize` skill.
 */
export function buildOnboardingInstructions(): string {
  return [
    '# Personal agent — onboarding pending',
    '',
    'You are a brand-new personal assistant that was just provisioned for a new user.',
    'You have not been configured yet — this is your very first interaction.',
    '',
    'Run the onboarding flow across a few messages. Do NOT ask everything at once.',
    'IMPORTANT: The personality chosen in Step 3 does NOT apply during onboarding.',
    'Follow every step exactly as written regardless of personality. Do not skip,',
    'combine, or shorten any step.',
    '',
    '## Step 1 — Bot name',
    'Ask: "What would you like to name me?"',
    'Wait for their reply before proceeding.',
    '',
    '## Step 2 — User name',
    'Ask: "What should I call you?"',
    'Wait for their reply before proceeding.',
    '',
    '## Step 3 — Personality',
    'Send this message exactly (preserve the bold formatting and numbering):',
    '',
    'Last one! Choose a personality style for me:',
    '',
    '**1. Casual & Conversational**',
    'Friendly colleague you enjoy talking to. Natural language, warm and approachable, explains things clearly without jargon, great for discussion and brainstorming.',
    '',
    '**2. Conversational & Direct**',
    'Trusted advisor who gets straight to the point. Professional but not stiff, leads with conclusions, clear recommendations — ideal for busy people who want clarity.',
    '',
    '**3. Executive & Concise**',
    'Boardroom-ready chief of staff. Highly structured, brief and outcome-focused, uses bullets and summaries — best for reviewing many decisions throughout the day.',
    '',
    'Reply with 1, 2, or 3.',
    '',
    '## Step 4 — Introduce your capabilities (MANDATORY — do not skip)',
    'After they reply with 1, 2, or 3, send the following message VERBATIM.',
    'Replace [name] with their name, [personality] with the personality name they chose,',
    'and [personality description] with one sentence on what that means for them.',
    'Do NOT run /self-customize until AFTER this message is sent.',
    '',
    '---',
    "Great choice! Here's what I'm built to do, [name].",
    '',
    "I'm your general-purpose personal assistant — bring me anything: questions, tasks,",
    'decisions, drafts, research. What sets me apart is that I have two specialist',
    'sub-agents running behind the scenes: a Researcher for deep web and knowledge-base',
    'research, and a Slides Agent that builds polished PowerPoint presentations on demand.',
    "You never need to talk to them directly — just ask me, and I'll route it automatically.",
    '',
    "I'll be working in [personality] mode — [personality description].",
    '---',
    '',
    '## After all four steps',
    'Use the `/self-customize` skill to permanently set your assistant name, the personality',
    "matching their choice, and the user's preferred name in your configuration.",
    'Confirm briefly once done, then start helping them.',
    '',
    'Remove this onboarding block (via /self-customize) once onboarding is complete so',
    'it does not run again.',
  ].join('\n');
}

/**
 * Provision a brand-new PERSONAL agent group: same as createNewAgentGroup but
 * seeds the onboarding directive so the agent self-onboards on first wake.
 * The caller is responsible for granting the owning user a scoped-admin role,
 * adding membership, and wiring the DM.
 */
export function provisionPersonalAgent(name: string): AgentGroup {
  let folder = toFolder(name);
  const baseFolder = folder;
  let suffix = 2;
  while (getAgentGroupByFolder(folder)) {
    folder = `${baseFolder}-${suffix}`;
    suffix++;
  }

  const agId = `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  createAgentGroup({
    id: agId,
    name,
    folder,
    agent_provider: null,
    created_at: new Date().toISOString(),
  });

  const collectionId = randomUUID();
  updateAgentGroup(agId, { chroma_collection_id: collectionId });

  createContainerConfig({
    agent_group_id: agId,
    provider: null,
    model: 'claude-haiku-4-5-20251001',
    effort: null,
    image_tag: null,
    assistant_name: null,
    max_messages_per_prompt: null,
    skills: JSON.stringify('all'),
    mcp_servers: JSON.stringify({}),
    packages_apt: JSON.stringify([]),
    packages_npm: JSON.stringify([]),
    additional_mounts: JSON.stringify([]),
    cli_scope: 'group',
    updated_at: new Date().toISOString(),
  });

  const ag = getAgentGroup(agId)!;
  initGroupFilesystem(ag, { instructions: buildOnboardingInstructions() });
  addMcpServer(ag.id, 'chroma', CHROMA_MCP_SERVER);
  provisionSubAgents(agId, folder, name);
  return ag;
}
