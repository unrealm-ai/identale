import type {DatabaseSync} from 'node:sqlite';
/** Metadata-only, transactional migration. Never opens a database or touches journal payloads. */
export function migratePrincipalStorage(db:DatabaseSync):void {
  const columns=(table:string)=>db.prepare(`PRAGMA table_info(${table})`).all();
  if(columns('tasks').some(c=>c.name==='actor_key')&&columns('conversations').some(c=>c.name==='owner_key'))return;
  const foreignKeys=Number(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys)===1;
  db.exec('PRAGMA foreign_keys=OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      // Only the supported Web schema has an unambiguous historic owner.
      if(db.prepare("SELECT id FROM conversations WHERE channel!='web' OR user_id IS NULL LIMIT 1").get())throw new Error('unsupported_legacy_principal_storage');
      db.exec("ALTER TABLE conversations ADD COLUMN owner_key TEXT NOT NULL DEFAULT ''; ALTER TABLE conversations ADD COLUMN scope_json TEXT; ALTER TABLE tasks ADD COLUMN actor_key TEXT NOT NULL DEFAULT ''; ALTER TABLE tasks ADD COLUMN owner_key TEXT NOT NULL DEFAULT '';");
      for(const row of db.prepare('SELECT id,workspace_id,entity_id,user_id FROM conversations').all()){
        const key=JSON.stringify(['platform',row.user_id]);
        db.prepare('UPDATE conversations SET owner_key=?,scope_json=? WHERE id=?').run(key,JSON.stringify({workspaceId:row.workspace_id,entityId:row.entity_id,userId:row.user_id}),String(row.id));
      }
      for(const row of db.prepare('SELECT id,workspace_id,entity_id,user_id FROM tasks').all()){
        const key=JSON.stringify(['platform',row.user_id]);
        db.prepare('UPDATE tasks SET actor_key=?,owner_key=? WHERE id=?').run(key,key,String(row.id));
      }
      for(const table of ['conversations','tasks']){
        const schema=String(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql);
        const dependent=db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL").all(table);
        if(!/user_id TEXT NOT NULL REFERENCES users\(id\)/i.test(schema))throw new Error('unsupported_principal_schema');
        const rebuilt=schema.replace(new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?["\\x60]?${table}["\\x60]?`,'i'),`CREATE TABLE ${table}_principal_upgrade`).replace(/user_id TEXT NOT NULL REFERENCES users\(id\)/i,'user_id TEXT REFERENCES users(id)');
        if(rebuilt===schema||/user_id TEXT NOT NULL/i.test(rebuilt))throw new Error('unsupported_principal_schema');
        db.exec(rebuilt);
        const names=columns(table).map(c=>`"${String(c.name).replaceAll('"','""')}"`).join(',');
        db.exec(`INSERT INTO ${table}_principal_upgrade(${names}) SELECT ${names} FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${table}_principal_upgrade RENAME TO ${table};`);
        for(const object of dependent)db.exec(String(object.sql));
      }
      db.exec('CREATE UNIQUE INDEX conversations_principal_operation ON conversations(workspace_id,entity_id,owner_key,operation_id); CREATE UNIQUE INDEX tasks_principal_operation ON tasks(workspace_id,entity_id,actor_key,owner_key,operation_id);');
      if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('principal_migration_foreign_key_check_failed');
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
  }finally{db.exec(`PRAGMA foreign_keys=${foreignKeys?'ON':'OFF'}`);}
}
