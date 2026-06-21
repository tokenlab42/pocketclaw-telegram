import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration016: Migration = {
  version: 16,
  name: 'chroma-collection-id',
  up(db: Database.Database) {
    db.prepare('ALTER TABLE agent_groups ADD COLUMN chroma_collection_id TEXT').run();
  },
};
