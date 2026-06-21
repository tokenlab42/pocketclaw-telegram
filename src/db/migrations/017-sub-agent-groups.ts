import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration017: Migration = {
  version: 17,
  name: 'sub-agent-groups',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE sub_agent_groups (
        parent_agent_group_id TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        child_agent_group_id  TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        role                  TEXT NOT NULL,
        PRIMARY KEY (parent_agent_group_id, role)
      );
      CREATE UNIQUE INDEX idx_sub_agent_child ON sub_agent_groups(child_agent_group_id);
    `);
  },
};
