import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration018: Migration = {
  version: 18,
  name: 'file-memory-messages',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pending_file_messages (
        question_id      TEXT PRIMARY KEY,
        channel_type     TEXT NOT NULL,
        platform_id      TEXT NOT NULL,
        thread_id        TEXT,
        user_id          TEXT,
        title            TEXT NOT NULL,
        options_json     TEXT NOT NULL,
        original_message TEXT NOT NULL,
        created_at       TEXT NOT NULL
      );
    `);
  },
};
