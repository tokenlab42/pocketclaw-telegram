import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration023: Migration = {
  version: 23,
  name: 'whatsapp-message-log',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS whatsapp_message_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recipient TEXT NOT NULL,
        message_type TEXT NOT NULL,
        category TEXT NOT NULL,
        template_name TEXT,
        sent_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  },
};
