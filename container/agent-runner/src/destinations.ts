/**
 * Destination map — lives in inbound.db's `destinations` table.
 *
 * The host writes this table before every container wake AND on demand
 * (e.g. when a new child agent is created mid-session). The container
 * queries the table live on every lookup, so admin changes take effect
 * immediately — no restart required.
 *
 * This table is BOTH the routing map and the container-visible ACL.
 * The host re-validates on the delivery side against the central DB,
 * so even if this table is stale the host's enforcement is authoritative.
 */
import { getInboundDb } from './db/connection.js';

export interface DestinationEntry {
  name: string;
  displayName: string;
  type: 'channel' | 'agent';
  channelType?: string;
  platformId?: string;
  agentGroupId?: string;
}

interface DestRow {
  name: string;
  display_name: string | null;
  type: 'channel' | 'agent';
  channel_type: string | null;
  platform_id: string | null;
  agent_group_id: string | null;
}

function rowToEntry(row: DestRow): DestinationEntry {
  return {
    name: row.name,
    displayName: row.display_name ?? row.name,
    type: row.type,
    channelType: row.channel_type ?? undefined,
    platformId: row.platform_id ?? undefined,
    agentGroupId: row.agent_group_id ?? undefined,
  };
}

export function getAllDestinations(): DestinationEntry[] {
  const rows = getInboundDb().prepare('SELECT * FROM destinations ORDER BY name').all() as DestRow[];
  return rows.map(rowToEntry);
}

export function findByName(name: string): DestinationEntry | undefined {
  const row = getInboundDb().prepare('SELECT * FROM destinations WHERE name = ?').get(name) as DestRow | undefined;
  return row ? rowToEntry(row) : undefined;
}

/**
 * Reverse lookup: given routing fields from an inbound message, find
 * which destination they correspond to (what does this agent call the sender?).
 */
export function findByRouting(
  channelType: string | null | undefined,
  platformId: string | null | undefined,
): DestinationEntry | undefined {
  if (!channelType || !platformId) return undefined;
  const db = getInboundDb();
  const row =
    channelType === 'agent'
      ? (db
          .prepare("SELECT * FROM destinations WHERE type = 'agent' AND agent_group_id = ?")
          .get(platformId) as DestRow | undefined)
      : (db
          .prepare("SELECT * FROM destinations WHERE type = 'channel' AND channel_type = ? AND platform_id = ?")
          .get(channelType, platformId) as DestRow | undefined);
  return row ? rowToEntry(row) : undefined;
}

/**
 * Generate the system-prompt addendum: agent identity + destination map.
 *
 * Identity is injected here (not in the shared CLAUDE.md) because it's
 * per-agent-group and changes when the operator renames an agent, while
 * the shared base is identical across all agents.
 */
export function buildSystemPromptAddendum(assistantName?: string): string {
  const sections: string[] = [];

  if (assistantName) {
    sections.push(['# You are ' + assistantName, '', `Your name is **${assistantName}**. Use it when the channel asks who you are, when introducing yourself, and when signing any message that explicitly calls for a signature.`].join('\n'));
  }

  sections.push(buildDestinationsSection());

  const chromaCollectionId = process.env.NANOCLAW_CHROMA_COLLECTION_ID;
  if (chromaCollectionId) {
    sections.push([
      '## Long-term memory (Chroma)',
      '',
      'You have an MCP server named `chroma` for vector-DB storage. There are exactly two collection names you are allowed to use:',
      `- \`${chromaCollectionId}\` — your personal collection. Use this exact UUID as the \`collection_name\` for anything you'd normally put in long-term memory. Call \`chroma_create_collection\` with this name if it does not already exist — never invent your own human-readable collection name.`,
      '- `news` — a shared collection. Normal users can only read this collection. Only owners/admins can write/modify it.',
      '  - The collection contains daily news indexes named `report-YYYY-MM-DD.md` and individual news articles named `article-YYYY-MM-DD-X.md`. For any chunk retrieved from the `news` collection, the `source` field in its metadata contains the filename.',
      '  - CRITICAL: Whenever the user asks you for news, updates, or newsletters, you MUST query this shared `news` collection first. Retrieve the latest `report-*.md` file (which contains the table of contents), read its full content directly from the filesystem at `/workspace/global/news/{source}`, and present it to the user as a clean, categorized table of contents grouped by section headers. For each article, output a bullet point with its number, title, and source name (do NOT include any URLs or clickable links in this initial list). Do not output the full descriptions for all articles upfront; instruct the user to ask or reply with the article number if they want to read the full content of a specific news article. If they do ask, retrieve and read the corresponding `article-*.md` file to fetch the description. You MUST extract the source URL from the file and always append it at the very end of your response as a raw clickable URL, formatted exactly as "Link: <url>".',
      '  - If the user you are talking to has `role="owner"` or `role="admin"`, you are allowed to write, add, or update the `news` collection.',
      '  - If the user you are talking to has `role="member"` (or any other role), the `news` collection is strictly read-only for you. You can query it but MUST NOT write, add, delete, or update any entries. If a normal user asks you to save or add news, politely refuse and explain that only owners have write permissions.',
      '',
      "Never call `chroma_list_collections`, and never query or write to any collection name other than these two — other agents' personal collections are off-limits even if you discover their names."
    ].join('\n'));
  }

  return sections.join('\n\n');
}

function buildDestinationsSection(): string {
  const all = getAllDestinations();

  if (all.length === 0) {
    return [
      '## Sending messages',
      '',
      'You currently have no configured destinations. You cannot send messages until an admin wires one up.',
    ].join('\n');
  }

  const lines = ['## Sending messages', ''];
  if (all.length === 1) {
    const d = all[0];
    const label = d.displayName && d.displayName !== d.name ? ` (${d.displayName})` : '';
    lines.push(`Your destination is \`${d.name}\`${label}.`);
  } else {
    lines.push('You can send messages to the following destinations:', '');
    for (const d of all) {
      const label = d.displayName && d.displayName !== d.name ? ` (${d.displayName})` : '';
      lines.push(`- \`${d.name}\`${label}`);
    }
  }
  lines.push('');
  lines.push(
    'Wrap each delivered message in a `<message to="name">…</message>` block; include several blocks in one response to address several destinations. `<internal>…</internal>` marks thinking you don\'t want sent.',
  );
  lines.push('');
  lines.push(
    'When replying to an incoming message, default to addressing the destination it came `from` (every inbound `<message>` tag carries a `from="name"` attribute). Pick a different destination when the request asks for it (e.g., "tell Laura that…").',
  );
  lines.push('');
  lines.push(
    'The `send_message` MCP tool is the same delivery, available mid-turn — handy for a quick acknowledgment ("on it") before a slow tool call. Each `send_message` call and each final-response `<message>` block lands as its own message in the conversation, so they read as a sequence rather than as one combined reply.',
  );
  return lines.join('\n');
}
