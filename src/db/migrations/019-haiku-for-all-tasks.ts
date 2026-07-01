import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration019: Migration = {
  version: 19,
  name: 'haiku-for-all-tasks',
  up(db: Database.Database) {
    db.exec(`
      UPDATE container_configs
      SET model = 'claude-haiku-4-5-20251001'
      WHERE model = 'claude-sonnet-4-6';
    `);
  },
};
