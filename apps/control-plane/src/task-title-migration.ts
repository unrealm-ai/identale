import type { DatabaseSync } from 'node:sqlite';
/** Additive metadata only: preserve historical input, hashes, rowids and execution facts. */
export function migrateTaskTitles(db: DatabaseSync) {
  if (!db.prepare('PRAGMA table_info(tasks)').all().some(column => column.name === 'title')) {
    db.exec('ALTER TABLE tasks ADD COLUMN title TEXT');
  }
}
