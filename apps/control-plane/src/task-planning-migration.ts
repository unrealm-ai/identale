import type {DatabaseSync} from 'node:sqlite';

/** Rebuild only Task metadata, preserving every dependent table and foreign key. */
export function migrateTaskPlanning(db:DatabaseSync):void {
  const columns=db.prepare('PRAGMA table_info(tasks)').all();
  if(!columns.length)throw new Error('task_planning_schema_missing');
  if(!columns.find(c=>c.name==='run_id')?.notnull&&columns.some(c=>c.name==='planned_history_ids_json'))return;
  const foreignKeys=Number(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys)===1;
  db.exec('PRAGMA foreign_keys=OFF');
  try{
    db.exec('BEGIN IMMEDIATE');
    try{
      const schema=String(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get()?.sql);
      const dependent=db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='tasks' AND type IN ('index','trigger') AND sql IS NOT NULL").all();
      if(!/run_id TEXT NOT NULL UNIQUE/i.test(schema))throw new Error('unsupported_task_planning_schema');
      const rebuilt=schema.replace(/CREATE TABLE (?:IF NOT EXISTS )?["`]?tasks["`]?/i,'CREATE TABLE tasks_planning_upgrade').replace(/run_id TEXT NOT NULL UNIQUE/i,'run_id TEXT UNIQUE').replace(/UNIQUE\(user_id,entity_id,operation_id\)/i,'UNIQUE(user_id,entity_id,conversation_id,operation_id)');
      if(rebuilt===schema||/run_id TEXT NOT NULL/i.test(rebuilt))throw new Error('unsupported_task_planning_schema');
      db.exec(rebuilt);
      const names=columns.map(c=>`"${String(c.name).replaceAll('"','""')}"`).join(',');
      db.exec(`INSERT INTO tasks_planning_upgrade(rowid,${names}) SELECT rowid,${names} FROM tasks; DROP TABLE tasks; ALTER TABLE tasks_planning_upgrade RENAME TO tasks;`);
      for(const object of dependent)db.exec(String(object.sql));
      db.exec('DROP INDEX IF EXISTS tasks_principal_operation; CREATE UNIQUE INDEX tasks_principal_operation ON tasks(workspace_id,entity_id,actor_key,owner_key,conversation_id,operation_id)');
      db.exec("ALTER TABLE tasks ADD COLUMN planned_history_ids_json TEXT NOT NULL DEFAULT '[]'; ALTER TABLE tasks ADD COLUMN planned_package_ids_json TEXT NOT NULL DEFAULT '[]'; CREATE INDEX tasks_conversation_page ON tasks(workspace_id,entity_id,actor_key,owner_key,conversation_id,created_at DESC,id DESC);");
      if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('task_planning_foreign_key_check_failed');
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
  }finally{db.exec(`PRAGMA foreign_keys=${foreignKeys?'ON':'OFF'}`);}
}
