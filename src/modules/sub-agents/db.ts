import type { SubAgentGroup } from '../../types.js';
import { getDb } from '../../db/connection.js';

export function createSubAgentRelation(row: SubAgentGroup): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO sub_agent_groups
         (parent_agent_group_id, child_agent_group_id, role)
       VALUES (?, ?, ?)`,
    )
    .run(row.parent_agent_group_id, row.child_agent_group_id, row.role);
}

export function getSubAgents(parentId: string): SubAgentGroup[] {
  return getDb()
    .prepare('SELECT * FROM sub_agent_groups WHERE parent_agent_group_id = ?')
    .all(parentId) as SubAgentGroup[];
}

export function getParentAgent(childId: string): SubAgentGroup | undefined {
  return getDb().prepare('SELECT * FROM sub_agent_groups WHERE child_agent_group_id = ?').get(childId) as
    | SubAgentGroup
    | undefined;
}

export function deleteSubAgentRelation(parentId: string, role: string): void {
  getDb().prepare('DELETE FROM sub_agent_groups WHERE parent_agent_group_id = ? AND role = ?').run(parentId, role);
}
