/**
 * Sub-agent provisioning.
 *
 * Each personal agent group gets two hidden specialist sub-agents:
 *   - slides     — creates PowerPoint presentations (python-pptx)
 *   - researcher — deep research + summarisation (KB + agent-browser)
 *
 * Sub-agents have no channel wirings and are never visible to users.
 * They communicate bidirectionally with the parent via agent_destinations.
 *
 * Destination invariant: called at group creation time, before any container
 * spawns, so writeDestinations is NOT needed here — spawnContainer will
 * project the rows on first wake.
 */
import fs from 'fs';
import path from 'path';

import { createAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import { createContainerConfig } from '../../db/container-configs.js';
import { initGroupFilesystem } from '../../group-init.js';
import { GROUPS_DIR } from '../../config.js';
import { createDestination } from '../agent-to-agent/db/agent-destinations.js';
import { createSubAgentRelation } from './db.js';
import { log } from '../../log.js';

// ── CLAUDE.local.md templates ──────────────────────────────────────────────

function slidesAgentInstructions(parentName: string): string {
  return [
    '# Slides Agent',
    '',
    `You are a presentation creation specialist working under ${parentName}. You only`,
    'receive task requests from your parent agent — never directly from users.',
    'Your sole job is to create polished PowerPoint (.pptx) presentations.',
    '',
    '## Workflow',
    '',
    '1. **Search the knowledge base** for relevant content:',
    '   ```bash',
    '   bun /app/skills/kb/kb.ts search "<topic>"',
    '   ```',
    '',
    '2. **Plan the slide structure** before generating:',
    '   - Title slide → Agenda → Content sections (6-12 slides) → Summary/Takeaways',
    '   - Max 5-6 bullets per slide, each under 12 words',
    '   - Group related content into clear sections',
    '',
    '3. **Build a JSON spec** and generate the .pptx:',
    '   ```bash',
    '   python3 /app/skills/slides/generate_pptx.py \'{"title":"...","subtitle":"...","slides":[{"title":"...","bullets":["...","..."],"speaker_notes":"..."}]}\'',
    '   ```',
    '   Output: `/workspace/agent/output/slides.pptx`',
    '',
    '4. **Send the file to the parent agent** using `send_file`:',
    '   - path: `/workspace/agent/output/slides.pptx`',
    '   - to: `parent`',
    '   - text: a brief summary — "N-slide deck on [topic]: [one-line description of what the deck covers]"',
    '',
    '   The parent will forward the file to the user. Do NOT send text-only; always use `send_file`.',
    '',
    '## Slide guidelines',
    '- Always include: title slide, agenda, content slides, summary/takeaways',
    '- Use KB content as source material when available — cite the document',
    '- Keep bullets action-oriented and scannable; avoid full sentences',
    '- If KB has no content on the topic, build from general knowledge and note this',
    '',
    '## python-pptx note',
    'Requires `python3-pptx` (already in container packages).',
    'If missing: `apt-get install -y python3-pptx`',
  ].join('\n');
}

function researcherInstructions(parentName: string): string {
  return [
    '# Researcher Agent',
    '',
    `You are a research and summarisation specialist working under ${parentName}. You`,
    'only receive requests from your parent agent. Your job is to investigate topics',
    'thoroughly and return well-structured, well-cited summaries.',
    '',
    '## Research workflow',
    '',
    '1. **Search shared knowledge base first:**',
    '   ```bash',
    '   bun /app/skills/kb/kb.ts search "<query>"',
    '   ```',
    '',
    '2. **Search personal knowledge base:**',
    '   ```bash',
    '   bun /app/skills/kb/kb.ts search "<query>" --scope personal',
    '   ```',
    '',
    '3. **If KB results are insufficient — search the web:**',
    '   Use agent-browser to find reputable sources. Prioritise:',
    '   - Official documentation and government sources',
    '   - Peer-reviewed publications and academic institutions',
    '   - Established news organisations',
    '   Cross-reference at least 2 independent sources before asserting a fact.',
    '',
    '4. **Return a structured summary** to the parent agent:',
    '   ```',
    '   ## Summary: [topic]',
    '',
    '   **Key findings:**',
    '   - ...',
    '',
    '   **Sources:**',
    '   - [title] — [URL or KB document name]',
    '',
    '   **Confidence:** High / Medium / Low',
    '   **Gaps:** [what could not be verified]',
    '   ```',
    '',
    '## Quality standards',
    '- Always cite sources; never fabricate facts',
    '- Flag uncertain claims with `[unverified]`',
    '- Distinguish KB-sourced vs web-sourced information',
    '- If a topic is outside your reach, say so clearly rather than guessing',
  ].join('\n');
}

function parentSubAgentBlock(slidesLocalName: string, researcherLocalName: string): string {
  return [
    '',
    '## Sub-agents',
    '',
    'You have two specialist sub-agents. You MUST delegate to them — do not attempt their tasks yourself.',
    '',
    `- **${slidesLocalName}** — The ONLY way to create PowerPoint files. You do not have python3-pptx`,
    '  installed and cannot run generate_pptx.py yourself. Any slides request MUST go to this sub-agent.',
    `- **${researcherLocalName}** — Deep research and summarisation using the knowledge base and web.`,
    '  Delegate when the user wants a research report, topic summary, document analysis, or web research.',
    '',
    '### MANDATORY: what you cannot do yourself',
    '- **You cannot create .pptx files.** Do not run generate_pptx.py. Do not attempt to generate slides in any format yourself. Always delegate to `' +
      slidesLocalName +
      '`.',
    '- **You cannot do deep research or long web searches.** Delegate to `' + researcherLocalName + '`.',
    '',
    '### How to delegate',
    '1. FIRST, tell the user immediately:',
    '   > "On it! I\'ve asked my Slides Agent to build that — feel free to keep chatting while it works."',
    '   (or Researcher equivalent)',
    '2. THEN use `send_message` to send the sub-agent a clear task with full context — topic, any specific requirements, number of slides if mentioned.',
    '3. When the sub-agent replies, handle it based on what it sent:',
    '',
    '   **If it sent a FILE** (you will see `[file: slides.pptx — saved to /workspace/inbox/a2a-.../slides.pptx]`):',
    '   - Immediately use `send_file` with that exact path to forward it to the user',
    '   - Add a short caption: "Here are your slides on [topic]!"',
    '   - `send_file(path="/workspace/inbox/a2a-EXACT-ID-HERE/slides.pptx", text="Here are your slides!")`',
    '',
    '   **If it sent TEXT only** (research summary):',
    '   - Forward the text to the user via `send_message`',
  ].join('\n');
}

// ── Provisioning ──────────────────────────────────────────────────────────

/**
 * Unique folder name that won't collide with existing groups.
 * E.g. "dm-with-praveen-slides", "dm-with-praveen-slides-2" if taken.
 */
function uniqueFolder(base: string): string {
  let folder = base;
  let suffix = 2;
  while (getAgentGroupByFolder(folder)) {
    folder = `${base}-${suffix}`;
    suffix++;
  }
  return folder;
}

function makeId(): string {
  return `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Create the two sub-agent groups for a parent, wire bidirectional destinations,
 * and append the delegation block to the parent's CLAUDE.local.md.
 *
 * Safe to call at provisioning time (no running containers yet).
 * For existing groups with running containers, kill the parent container
 * before calling so destinations propagate on next spawn.
 */
export function provisionSubAgents(parentAgentGroupId: string, parentFolder: string, parentName: string): void {
  const now = new Date().toISOString();
  const SLIDES_LOCAL = 'slides-agent';
  const RESEARCHER_LOCAL = 'researcher';

  // ── Slides sub-agent ────────────────────────────────────────────────────
  const slidesId = makeId();
  const slidesFolder = uniqueFolder(`${parentFolder}-slides`);
  const slidesName = `${parentName} — Slides`;

  createAgentGroup({
    id: slidesId,
    name: slidesName,
    folder: slidesFolder,
    agent_provider: null,
    created_at: now,
  });

  createContainerConfig({
    agent_group_id: slidesId,
    provider: null,
    model: 'claude-sonnet-4-6',
    effort: null,
    image_tag: null,
    assistant_name: 'Slides Agent',
    max_messages_per_prompt: null,
    skills: JSON.stringify('all'),
    mcp_servers: JSON.stringify({}),
    packages_apt: JSON.stringify(['python3-pptx']),
    packages_npm: JSON.stringify([]),
    additional_mounts: JSON.stringify([]),
    cli_scope: 'group',
    updated_at: now,
  });

  const slidesGroup = { id: slidesId, name: slidesName, folder: slidesFolder, agent_provider: null, created_at: now };
  initGroupFilesystem(slidesGroup, { instructions: slidesAgentInstructions(parentName) });

  // ── Researcher sub-agent ─────────────────────────────────────────────────
  const researcherId = makeId();
  const researcherFolder = uniqueFolder(`${parentFolder}-researcher`);
  const researcherName = `${parentName} — Researcher`;

  createAgentGroup({
    id: researcherId,
    name: researcherName,
    folder: researcherFolder,
    agent_provider: null,
    created_at: now,
  });

  createContainerConfig({
    agent_group_id: researcherId,
    provider: null,
    model: 'claude-sonnet-4-6',
    effort: null,
    image_tag: null,
    assistant_name: 'Researcher',
    max_messages_per_prompt: null,
    skills: JSON.stringify('all'),
    mcp_servers: JSON.stringify({}),
    packages_apt: JSON.stringify([]),
    packages_npm: JSON.stringify([]),
    additional_mounts: JSON.stringify([]),
    cli_scope: 'group',
    updated_at: now,
  });

  const researcherGroup = {
    id: researcherId,
    name: researcherName,
    folder: researcherFolder,
    agent_provider: null,
    created_at: now,
  };
  initGroupFilesystem(researcherGroup, { instructions: researcherInstructions(parentName) });

  // ── Bidirectional destinations ───────────────────────────────────────────
  // parent → slides
  createDestination({
    agent_group_id: parentAgentGroupId,
    local_name: SLIDES_LOCAL,
    target_type: 'agent',
    target_id: slidesId,
    created_at: now,
  });
  // parent → researcher
  createDestination({
    agent_group_id: parentAgentGroupId,
    local_name: RESEARCHER_LOCAL,
    target_type: 'agent',
    target_id: researcherId,
    created_at: now,
  });
  // slides → parent
  createDestination({
    agent_group_id: slidesId,
    local_name: 'parent',
    target_type: 'agent',
    target_id: parentAgentGroupId,
    created_at: now,
  });
  // researcher → parent
  createDestination({
    agent_group_id: researcherId,
    local_name: 'parent',
    target_type: 'agent',
    target_id: parentAgentGroupId,
    created_at: now,
  });

  // ── Sub-agent registry ───────────────────────────────────────────────────
  createSubAgentRelation({ parent_agent_group_id: parentAgentGroupId, child_agent_group_id: slidesId, role: 'slides' });
  createSubAgentRelation({
    parent_agent_group_id: parentAgentGroupId,
    child_agent_group_id: researcherId,
    role: 'researcher',
  });

  // ── Inject delegation block into parent's CLAUDE.local.md ───────────────
  const claudeLocal = path.join(GROUPS_DIR, parentFolder, 'CLAUDE.local.md');
  if (fs.existsSync(claudeLocal)) {
    const existing = fs.readFileSync(claudeLocal, 'utf-8');
    if (!existing.includes('## Sub-agents')) {
      fs.appendFileSync(claudeLocal, parentSubAgentBlock(SLIDES_LOCAL, RESEARCHER_LOCAL) + '\n');
    }
  }

  log.info('Sub-agents provisioned', {
    parentAgentGroupId,
    slides: { id: slidesId, folder: slidesFolder },
    researcher: { id: researcherId, folder: researcherFolder },
  });
}
