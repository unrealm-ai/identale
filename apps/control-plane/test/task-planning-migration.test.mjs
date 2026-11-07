import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {migrateTaskPlanning} from '../dist/task-planning-migration.js';
function legacy(t,broken=false){
  const dir=mkdtempSync(join(tmpdir(),'dentity-task-migrate-')),db=new DatabaseSync(join(dir,'test.sqlite'));t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE tasks(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,entity_id TEXT NOT NULL,user_id TEXT,actor_key TEXT NOT NULL,owner_key TEXT NOT NULL,conversation_id TEXT NOT NULL,operation_id TEXT NOT NULL,input TEXT NOT NULL,run_id ${broken?'INTEGER':'TEXT'} NOT NULL UNIQUE,created_at INTEGER NOT NULL,UNIQUE(user_id,entity_id,operation_id));
    CREATE UNIQUE INDEX tasks_principal_operation ON tasks(workspace_id,entity_id,actor_key,owner_key,operation_id);
    CREATE TABLE runs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id));
    CREATE TABLE task_inputs(task_id TEXT NOT NULL REFERENCES tasks(id),text TEXT NOT NULL);
    CREATE TABLE task_updates(task_id TEXT NOT NULL REFERENCES tasks(id),run_id TEXT NOT NULL REFERENCES runs(id));
    CREATE TABLE task_outbox(task_id TEXT NOT NULL REFERENCES tasks(id),run_id TEXT NOT NULL REFERENCES runs(id));
    CREATE TABLE deliveries(task_id TEXT NOT NULL REFERENCES tasks(id),text TEXT NOT NULL);
    CREATE TABLE task_operations(task_id TEXT NOT NULL REFERENCES tasks(id),operation_id TEXT NOT NULL);
    INSERT INTO tasks(rowid,id,workspace_id,entity_id,user_id,actor_key,owner_key,conversation_id,operation_id,input,run_id,created_at) VALUES(42,'t','w','e','u','actor','owner','c','op','untouched intent','r',1000);
    INSERT INTO runs VALUES('r','t'); INSERT INTO task_inputs VALUES('t','untouched input'); INSERT INTO task_updates VALUES('t','r'); INSERT INTO task_outbox VALUES('t','r'); INSERT INTO deliveries VALUES('t','untouched delivery'); INSERT INTO task_operations VALUES('t','mutation');
    CREATE TRIGGER task_input_immutable BEFORE UPDATE OF input ON tasks BEGIN SELECT RAISE(ABORT,'preserved trigger'); END;
  `);return db;
}
test('nullable Run migration preserves Task/Run/data/index/trigger/rowid/FKs and is idempotent',t=>{
  const db=legacy(t);migrateTaskPlanning(db);assert.equal(db.prepare('PRAGMA table_info(tasks)').all().find(c=>c.name==='run_id').notnull,0);assert.equal(db.prepare('SELECT rowid,input,run_id,planned_history_ids_json FROM tasks').get().rowid,42);assert.equal(db.prepare('SELECT input FROM tasks').get().input,'untouched intent');assert.equal(db.prepare('SELECT task_id FROM runs').get().task_id,'t');
  for(const table of ['task_inputs','task_updates','task_outbox','deliveries','task_operations'])assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n,1);
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);assert.throws(()=>db.prepare("UPDATE tasks SET input='changed'").run(),/preserved trigger/);assert.throws(()=>db.prepare("INSERT INTO runs VALUES('wrong','missing')").run(),/FOREIGN KEY/);
  db.prepare("INSERT INTO tasks(id,workspace_id,entity_id,user_id,actor_key,owner_key,conversation_id,operation_id,input,run_id,created_at) VALUES('todo','w','e','u','actor','owner','c2','op','planned',NULL,1001)").run();migrateTaskPlanning(db);assert.equal(db.prepare('SELECT count(*) n FROM tasks').get().n,2);assert.equal(db.prepare("SELECT run_id FROM tasks WHERE id='todo'").get().run_id,null);
});
test('unsupported schema rollback preserves all old facts and foreign-key enforcement',t=>{
  const db=legacy(t,true);assert.throws(()=>migrateTaskPlanning(db),/unsupported_task_planning_schema/);assert.equal(db.prepare('PRAGMA table_info(tasks)').all().some(c=>c.name==='planned_history_ids_json'),false);assert.equal(db.prepare('SELECT input FROM tasks').get().input,'untouched intent');assert.equal(db.prepare('SELECT task_id FROM runs').get().task_id,'t');assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
});
