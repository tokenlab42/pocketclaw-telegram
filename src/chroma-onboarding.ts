import type { McpServerConfig } from './container-config.js';

/**
 * Shared Chroma server — already running on the host via Docker.
 *
 * `chroma-mcp` is pre-installed into the image's uv tool venv at build time
 * (see container/Dockerfile) and exposed on PATH at
 * /home/node/.local/bin/chroma-mcp, so we invoke it directly instead of via
 * `uvx` — no per-spawn resolve/cache-check overhead. The cache/HOME env vars
 * redirect chroma-mcp's runtime scratch writes to /tmp: the mounted home dir
 * isn't guaranteed writable in every deployment, and these paths don't need
 * to persist across container restarts.
 */
export const CHROMA_MCP_SERVER: McpServerConfig = {
  command: 'chroma-mcp',
  args: ['--client-type', 'http', '--host', 'host.docker.internal', '--port', '8000', '--ssl', 'false'],
  env: {
    UV_CACHE_DIR: '/tmp/uv-cache',
    XDG_CACHE_HOME: '/tmp/xdg-cache',
    HOME: '/tmp',
  },
};

export function chromaInstructions(collectionId: string): string {
  return (
    '\n## Long-term memory (Chroma)\n\n' +
    'You have an MCP server named `chroma` for vector-DB storage. There are exactly two ' +
    'collection names you are allowed to use:\n' +
    `- \`${collectionId}\` — your personal collection. Use this exact UUID as the ` +
    "collection_name for anything you'd normally put in long-term memory. Call " +
    'chroma_create_collection with this name if it does not already exist — never invent ' +
    'your own human-readable collection name.\n' +
    '- `news` — a shared collection. Normal users can only read this collection. Only owners/admins can write/modify it.\n' +
    '  - The collection contains documents of two types: report indices (`type = "report_index"`) and individual ' +
    'articles (`type = "article"`).\n' +
    '  - CRITICAL: Whenever the user asks you for news, updates, or newsletters, you MUST query ' +
    'this shared `news` collection in Chroma first. Retrieve the latest document where `type = "report_index"`. ' +
    'Present its content directly to the user as-is without any modification, rewriting, or reformatting (do NOT change bullet marks, headers, or add any introductory or closing remarks). Do not output the full descriptions for all articles upfront; ' +
    'instruct the user to ask or reply with the article number if they want to read the full content of a specific ' +
    'news article. If they do ask for a specific article number, determine the target report date first: 1) Inspect the recent chat history to find the date of the news report currently being discussed (e.g. from the broadcast message "*MOH Media Report (6 Jul 2026)*"). 2) If the date cannot be determined from the chat history, query Chroma for all report indices (`type = "report_index"`), compare their `date` metadata fields, and select the most recent date. Once the date is resolved, query Chroma for the document with metadata `type = "article"`, matching the resolved date and requested article number. Present the retrieved article document text directly. You MUST extract the source URL from the metadata `link` field (or from the document body) and always append it at the very end of your response as a raw clickable URL, formatted exactly as "Link: <url>".\n' +
    '  - If the user you are talking to has `role="owner"` or `role="admin"`, you are allowed to write, add, or update the `news` collection.\n' +
    '  - If the user you are talking to has `role="member"` (or any other role), the `news` collection is strictly read-only for you. You can query it but MUST NOT write, add, delete, or update any entries. If a normal user asks you to save or add news, politely refuse and explain that only owners have write permissions.\n\n' +
    'Never call chroma_list_collections, and never query or write to any collection name ' +
    "other than these two — other agents' personal collections are off-limits even if you " +
    'discover their names.\n'
  );
}
