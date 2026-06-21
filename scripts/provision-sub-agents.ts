#!/usr/bin/env tsx
/**
 * One-shot script: delete old Coder/Researcher groups and provision
 * the new slides + researcher sub-agents for all existing personal agents.
 *
 * Run from repo root:
 *   pnpm exec tsx scripts/provision-sub-agents.ts
 *
 * NanoClaw must be STOPPED before running this script (it writes to v2.db).
 */
import path from 'path';
import fs from 'fs';

import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { getAllAgentGroups, getAgentGroup, deleteAgentGroup } from '../src/db/agent-groups.js';
import { deleteAllDestinationsTouching } from '../src/modules/agent-to-agent/db/agent-destinations.js';
import { getSubAgents } from '../src/modules/sub-agents/db.js';
import { provisionSubAgents } from '../src/modules/sub-agents/provision.js';
import { DATA_DIR, GROUPS_DIR } from '../src/config.js';

const DB_PATH = path.join(DATA_DIR, 'v2.db');

// ── Helpers ──────────────────────────────────────────────────────────────

function deleteGroupFilesystem(folder: string): void {
  const groupDir = path.join(GROUPS_DIR, folder);
  if (fs.existsSync(groupDir)) {
    fs.rmSync(groupDir, { recursive: true, force: true });
    console.log(`  Deleted filesystem: groups/${folder}`);
  }
}

function deleteSessionDir(agentGroupId: string): void {
  const sessDir = path.join(DATA_DIR, 'v2-sessions', agentGroupId);
  if (fs.existsSync(sessDir)) {
    fs.rmSync(sessDir, { recursive: true, force: true });
    console.log(`  Deleted session dir: data/v2-sessions/${agentGroupId}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

console.log('=== NanoClaw sub-agent provisioning ===\n');

const db = initDb(DB_PATH);
runMigrations(db);

const all = getAllAgentGroups();
console.log(`Found ${all.length} agent groups.\n`);

// IDs to delete (old Coder and Researcher)
const OLD_GROUPS = ['ag-1780645078787-sp94yb', 'ag-1780643210992-zqugvj'];

// ── Step 1: Delete old groups ──────────────────────────────────────────────
console.log('--- Step 1: Removing old Coder and Researcher groups ---');
for (const id of OLD_GROUPS) {
  const ag = getAgentGroup(id);
  if (!ag) {
    console.log(`  Skipped ${id} (not found in DB)`);
    continue;
  }
  console.log(`  Removing "${ag.name}" (${id})`);
  // Delete FK-referencing rows in dependency order before the group itself
  db.prepare('DELETE FROM pending_questions WHERE session_id IN (SELECT id FROM sessions WHERE agent_group_id = ?)').run(id);
  db.prepare('DELETE FROM pending_approvals WHERE session_id IN (SELECT id FROM sessions WHERE agent_group_id = ?)').run(id);
  db.prepare('DELETE FROM sessions WHERE agent_group_id = ?').run(id);
  db.prepare('DELETE FROM container_configs WHERE agent_group_id = ?').run(id);
  db.prepare('DELETE FROM user_roles WHERE agent_group_id = ?').run(id);
  db.prepare('DELETE FROM agent_group_members WHERE agent_group_id = ?').run(id);
  db.prepare('DELETE FROM messaging_group_agents WHERE agent_group_id = ?').run(id);
  deleteAllDestinationsTouching(id);
  deleteAgentGroup(id);
  deleteGroupFilesystem(ag.folder);
  deleteSessionDir(id);
}

// ── Step 2: Identify personal agent groups (those with no parent) ──────────
console.log('\n--- Step 2: Identifying personal agent groups to provision ---');

// After deletions, reload
const remaining = getAllAgentGroups();

// Personal agents = groups that are NOT a sub-agent child of any other
// (check sub_agent_groups table — children have a parent row)
const allGroups = remaining;
const personalAgents = allGroups.filter((ag) => {
  // A sub-agent child is in sub_agent_groups.child_agent_group_id
  const parent = db
    .prepare('SELECT 1 FROM sub_agent_groups WHERE child_agent_group_id = ?')
    .get(ag.id);
  return !parent;
});

console.log(`  Personal agents: ${personalAgents.map((a) => a.name).join(', ')}`);

// ── Step 3: Provision sub-agents for each personal agent ──────────────────
console.log('\n--- Step 3: Provisioning sub-agents ---');
for (const ag of personalAgents) {
  const existing = getSubAgents(ag.id);
  if (existing.length >= 2) {
    console.log(`  "${ag.name}" — already has ${existing.length} sub-agents, skipping`);
    continue;
  }
  console.log(`  Provisioning for "${ag.name}" (${ag.id})`);
  provisionSubAgents(ag.id, ag.folder, ag.name);
  console.log(`  Done.`);
}

console.log('\n=== Complete ===');
console.log('Restart NanoClaw. Sub-agents will spawn on next user message.');
