import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration021: Migration = {
  version: 21,
  name: 'news-subscriptions',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS news_subscriptions (
        id                 TEXT PRIMARY KEY,
        session_id         TEXT NOT NULL,
        messaging_group_id TEXT NOT NULL,
        topics_json        TEXT NOT NULL,
        created_at         TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id)
      );
    `);
  },
};
