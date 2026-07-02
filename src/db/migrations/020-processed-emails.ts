import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration020: Migration = {
  version: 20,
  name: 'processed-emails',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS processed_email_threads (
        thread_id    TEXT PRIMARY KEY,
        subject      TEXT,
        processed_at TEXT NOT NULL
      );
    `);
  },
};
