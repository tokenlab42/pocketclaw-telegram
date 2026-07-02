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

/** CLAUDE.local.md section instructing an agent on its two allowed Chroma collections. */
export function chromaInstructions(collectionId: string): string {
  return (
    '\n## Long-term memory (Chroma)\n\n' +
    'You have an MCP server named `chroma` for vector-DB storage. There are exactly two ' +
    'collection names you are allowed to use:\n' +
    `- \`${collectionId}\` — your personal collection. Use this exact UUID as the ` +
    "collection_name for anything you'd normally put in long-term memory. Call " +
    'chroma_create_collection with this name if it does not already exist — never invent ' +
    'your own human-readable collection name.\n' +
    '- `news` — a collection shared by every agent. Anyone can read or write here. ' +
    'For any chunk retrieved from the `news` collection, the `source` field in its metadata ' +
    'contains the filename (e.g. `thread-123.md`). You can read the full, structured file ' +
    'directly from the filesystem at `/workspace/global/news/{source}` using your command ' +
    'execution tools if a chunk is cut off or if you need to fetch links/original formatting. ' +
    'CRITICAL: Whenever the user asks you for news, updates, or newsletters, you MUST query ' +
    'this shared `news` collection in Chroma first to retrieve the latest updates before answering.\n\n' +
    'Never call chroma_list_collections, and never query or write to any collection name ' +
    "other than these two — other agents' personal collections are off-limits even if you " +
    'discover their names.\n'
  );
}
