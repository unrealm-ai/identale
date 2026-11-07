import type{DatabaseSync}from'node:sqlite';
/** Atomic N-Run/one-Session upgrade. Preserve IDs, rowids, columns, indexes and child FKs. */
export function migrateHumanRuns(db:DatabaseSync){
 const sql=String(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='runs'").get()?.sql??'');if(!sql)throw Error('run_schema_missing');
 if(/session_id TEXT NOT NULL UNIQUE/i.test(sql)){
  const fk=Number(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys)===1;db.exec('PRAGMA foreign_keys=OFF');
  try{db.exec('BEGIN IMMEDIATE');try{const columns=db.prepare('PRAGMA table_info(runs)').all().map(x=>'"'+String(x.name).replaceAll('"','""')+'"').join(','),dependent=db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='runs' AND type IN('index','trigger') AND sql IS NOT NULL").all();
   db.exec(sql.replace(/CREATE TABLE (?:IF NOT EXISTS )?["`]?runs["`]?/i,'CREATE TABLE runs_human_upgrade').replace(/session_id TEXT NOT NULL UNIQUE/i,'session_id TEXT NOT NULL'));
   db.exec(`INSERT INTO runs_human_upgrade(rowid,${columns}) SELECT rowid,${columns} FROM runs;DROP TABLE runs;ALTER TABLE runs_human_upgrade RENAME TO runs;`);for(const x of dependent)db.exec(String(x.sql));if(db.prepare('PRAGMA foreign_key_check').all().length)throw Error('run_migration_foreign_key_failure');db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}}finally{db.exec('PRAGMA foreign_keys='+ (fk?'ON':'OFF'));}
 }
 const columns=db.prepare('PRAGMA table_info(runs)').all().map(x=>x.name);for(const [name,definition]of [['kind',"TEXT NOT NULL DEFAULT 'initial'"],['parent_run_id','TEXT REFERENCES runs(id)'],['end_reason','TEXT']]as const)if(!columns.includes(name))db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${definition}`);
 db.exec('CREATE INDEX IF NOT EXISTS runs_session_segments ON runs(session_id,created_at,id)');
}

/** This is a new runtime-owned business binding, not a copy of configuration. */
export function migrateHumanRequestInput(db:DatabaseSync){if(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='human_requests'").get()&&!db.prepare('PRAGMA table_info(human_requests)').all().some(c=>c.name==='input_revision'))db.exec('ALTER TABLE human_requests ADD COLUMN input_revision INTEGER NOT NULL DEFAULT 1');if(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='human_requests'").get()&&!db.prepare('PRAGMA table_info(human_requests)').all().some(c=>c.name==='selection_json'))db.exec('ALTER TABLE human_requests ADD COLUMN selection_json TEXT');}
