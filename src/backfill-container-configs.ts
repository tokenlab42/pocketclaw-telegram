/**
 * One-time backfill: seed `container_configs` rows from existing
 * `groups/<folder>/container.json` files and `agent_groups.agent_provider`.
 *
 * Runs after migrations, before channel adapters start. Idempotent — skips
 * groups that already have a config row.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import type { McpServerConfig, AdditionalMountConfig } from './container-config.js';
import { getAllAgentGroups, getAgentGroup, updateAgentGroup } from './db/agent-groups.js';
import { getContainerConfig, createContainerConfig, addMcpServer } from './db/container-configs.js';
import { getDb, hasTable } from './db/connection.js';
import { CHROMA_MCP_SERVER } from './chroma-onboarding.js';
import { log } from './log.js';
import type { ContainerConfigRow } from './types.js';

interface LegacyContainerJson {
  mcpServers?: Record<string, McpServerConfig>;
  packages?: { apt?: string[]; npm?: string[] };
  imageTag?: string;
  additionalMounts?: AdditionalMountConfig[];
  skills?: string[] | 'all';
  provider?: string;
  assistantName?: string;
  maxMessagesPerPrompt?: number;
}

export function backfillContainerConfigs(): void {
  const groups = getAllAgentGroups();
  let backfilled = 0;

  for (const group of groups) {
    // Skip if already has a config row
    if (getContainerConfig(group.id)) continue;

    // Read legacy container.json from disk
    const filePath = path.join(GROUPS_DIR, group.folder, 'container.json');
    let legacy: LegacyContainerJson = {};
    if (fs.existsSync(filePath)) {
      try {
        legacy = JSON.parse(fs.readFileSync(filePath, 'utf8')) as LegacyContainerJson;
      } catch (err) {
        log.warn('Backfill: failed to parse container.json, using defaults', {
          folder: group.folder,
          err: String(err),
        });
      }
    }

    // DB agent_provider wins over file provider (matches old cascade)
    const provider = group.agent_provider || legacy.provider || null;

    const row: ContainerConfigRow = {
      agent_group_id: group.id,
      provider,
      model: null,
      effort: null,
      image_tag: legacy.imageTag ?? null,
      assistant_name: legacy.assistantName ?? null,
      max_messages_per_prompt: legacy.maxMessagesPerPrompt ?? null,
      skills: JSON.stringify(legacy.skills ?? 'all'),
      mcp_servers: JSON.stringify(legacy.mcpServers ?? {}),
      packages_apt: JSON.stringify(legacy.packages?.apt ?? []),
      packages_npm: JSON.stringify(legacy.packages?.npm ?? []),
      additional_mounts: JSON.stringify(legacy.additionalMounts ?? []),
      cli_scope: 'group',
      updated_at: new Date().toISOString(),
    };

    createContainerConfig(row);
    backfilled++;
  }

  if (backfilled > 0) {
    log.info('Backfilled container_configs from disk', { count: backfilled });
  }
}

export function backfillChromaSubAgentConfigs(): void {
  const db = getDb();
  if (!hasTable(db, 'sub_agent_groups')) return;

  const relations = db.prepare('SELECT parent_agent_group_id, child_agent_group_id FROM sub_agent_groups').all() as {
    parent_agent_group_id: string;
    child_agent_group_id: string;
  }[];

  let backfilled = 0;

  for (const rel of relations) {
    const parent = getAgentGroup(rel.parent_agent_group_id);
    if (!parent || !parent.chroma_collection_id) continue;

    const child = getAgentGroup(rel.child_agent_group_id);
    if (!child) continue;

    let updatedGroup = false;
    let updatedConfig = false;

    if (!child.chroma_collection_id) {
      updateAgentGroup(child.id, { chroma_collection_id: parent.chroma_collection_id });
      updatedGroup = true;
    }

    const configRow = getContainerConfig(child.id);
    if (configRow) {
      const servers = JSON.parse(configRow.mcp_servers) as Record<string, any>;
      if (!servers.chroma) {
        addMcpServer(child.id, 'chroma', CHROMA_MCP_SERVER);
        updatedConfig = true;
      }
    }

    if (updatedGroup || updatedConfig) {
      backfilled++;
    }
  }

  if (backfilled > 0) {
    log.info('Backfilled Chroma configuration for sub-agents', { count: backfilled });
  }
}
