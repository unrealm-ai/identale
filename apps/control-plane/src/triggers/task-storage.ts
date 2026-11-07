import type {DatabaseSync} from 'node:sqlite';
/** Metadata-only, versioned/idempotent upgrade. No journal payload or account/configuration is deleted. */
export function migrateTriggerTasks(db:DatabaseSync){
  const columns=(table:string)=>db.prepare(`PRAGMA table_info(${table})`).all();
  const task=columns('tasks'),run=columns('runs');
  if(task.some(c=>c.name==='origin_kind')&&run.some(c=>c.name==='history_manifest_ref'))return;
  const fk=Number(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys)===1;
  db.exec('PRAGMA foreign_keys=OFF');
  try{db.exec('BEGIN IMMEDIATE');try{
    if(task.find(c=>c.name==='conversation_id')?.notnull){
      const schema=String(db.prepare("SELECT sql FROM sqlite_master WHERE name='tasks' AND type='table'").get()?.sql),objects=db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='tasks' AND type IN('index','trigger') AND sql IS NOT NULL").all();
      if(!/conversation_id TEXT NOT NULL REFERENCES conversations\(id\)/i.test(schema))throw new Error('unsupported_trigger_task_schema');
      db.exec(schema.replace(/CREATE TABLE (?:IF NOT EXISTS )?["`]?tasks["`]?/i,'CREATE TABLE tasks_trigger_upgrade').replace(/conversation_id TEXT NOT NULL REFERENCES conversations\(id\)/i,'conversation_id TEXT REFERENCES conversations(id)'));
      const names=task.map(c=>'"'+String(c.name).replaceAll('"','""')+'"').join(',');
      db.exec(`INSERT INTO tasks_trigger_upgrade(rowid,${names}) SELECT rowid,${names} FROM tasks; DROP TABLE tasks; ALTER TABLE tasks_trigger_upgrade RENAME TO tasks;`);for(const object of objects)db.exec(String(object.sql));
    }
    for(const [name,definition]of Object.entries({origin_kind:"TEXT NOT NULL DEFAULT 'conversation'",trigger_id:'TEXT',creation_event_record_id:'TEXT',context_namespace:'TEXT',context_key:'TEXT',policy_revision:'INTEGER',terminal_at:'INTEGER'}))if(!task.some(c=>c.name===name))db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${definition}`);
    if(!run.some(c=>c.name==='attempt')){db.exec('ALTER TABLE runs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1');db.exec('UPDATE runs SET attempt=(SELECT count(*) FROM runs p WHERE p.task_id=runs.task_id AND (p.created_at<runs.created_at OR (p.created_at=runs.created_at AND p.rowid<=runs.rowid)))');}
    if(!run.some(c=>c.name==='terminal_at'))db.exec('ALTER TABLE runs ADD COLUMN terminal_at INTEGER');
    if(!run.some(c=>c.name==='history_manifest_ref'))db.exec('ALTER TABLE runs ADD COLUMN history_manifest_ref TEXT');
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS tasks_trigger_creation_event ON tasks(creation_event_record_id) WHERE creation_event_record_id IS NOT NULL;CREATE UNIQUE INDEX IF NOT EXISTS tasks_trigger_operation ON tasks(workspace_id,entity_id,actor_key,owner_key,operation_id) WHERE origin_kind='trigger';CREATE INDEX IF NOT EXISTS tasks_trigger_history ON tasks(workspace_id,entity_id,origin_kind,context_namespace,context_key,terminal_at,id);CREATE UNIQUE INDEX IF NOT EXISTS runs_task_attempt ON runs(task_id,attempt)");
    if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('trigger_task_foreign_key_check_failed');db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}}finally{db.exec(`PRAGMA foreign_keys=${fk?'ON':'OFF'}`);}
}
