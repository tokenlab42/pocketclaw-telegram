import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration022: Migration = {
  version: 22,
  name: 'onboarding-codes',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS onboarding_codes (
        code       TEXT PRIMARY KEY,
        used_at    TEXT,
        used_by    TEXT,
        created_at TEXT NOT NULL
      );
    `);
  },
};
