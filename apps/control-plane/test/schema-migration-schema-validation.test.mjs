import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../dist/store.js';
import {runSchemaMigrations} from '../dist/schema-migrations/runner.js';

async function fixture(t,role='platform') {
 const root=await mkdtemp(join(tmpdir(),'identale-schema-validation-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const path=join(root,'isolated.sqlite');new Store(path,{role}).close();
 return {path,role};
}
function mutate(path,fn){const db=new DatabaseSync(path);try{fn(db);}finally{db.close();}}
function legacy(db,role){db.exec(`DROP TABLE ${role}_schema_migrations`);}

test('unversioned schema must not normalize case-sensitive default literals',async t=>{
 const {path,role}=await fixture(t);
 mutate(path,db=>{
  legacy(db,role);
  const sql=db.prepare("SELECT sql FROM sqlite_master WHERE name='entities'").get().sql;
  assert.ok(sql.includes("DEFAULT 'medium'"));
  const indexes=db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='entities' AND sql IS NOT NULL").all();
  db.exec('PRAGMA foreign_keys=OFF;DROP TABLE entities');
  db.exec(sql.replace("DEFAULT 'medium'","DEFAULT 'MEDIUM'"));
  for(const row of indexes)db.exec(row.sql);
 });
 assert.throws(()=>new Store(path,{role}),/unrecognized_column:entities.execution_thinking_level/);
 mutate(path,db=>assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='platform_schema_migrations'").get(),undefined));
});

test('unversioned trigger literal case changes are not treated as the known baseline',async t=>{
 const {path,role}=await fixture(t,'runtime');
 mutate(path,db=>{
  legacy(db,role);
  const sql=db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='trigger_result_receipt_insert'").get().sql;
  assert.ok(sql.includes("'outbox'"));
  db.exec('DROP TRIGGER trigger_result_receipt_insert');db.exec(sql.replace("'outbox'","'OUTBOX'"));
 });
 assert.throws(()=>new Store(path,{role}),/unrecognized_object:trigger_result_receipt_insert/);
});

test('unversioned unknown table blocks adoption and leaves its rows intact',async t=>{
 const {path,role}=await fixture(t);
 mutate(path,db=>{legacy(db,role);db.exec("CREATE TABLE unknown_application_state(id TEXT PRIMARY KEY);INSERT INTO unknown_application_state VALUES('preserved')");});
 assert.throws(()=>new Store(path,{role}),/split_storage_wrong_owner:unknown_application_state/);
 mutate(path,db=>assert.equal(db.prepare('SELECT id FROM unknown_application_state').get().id,'preserved'));
});

test('unversioned missing non-allowlisted column is rejected rather than guessed',async t=>{
 const {path,role}=await fixture(t);
 mutate(path,db=>{legacy(db,role);db.exec('ALTER TABLE entities DROP COLUMN own_web_use');});
 assert.throws(()=>new Store(path,{role}),/missing_column:entities.own_web_use/);
});

test('already-versioned missing index is schema drift, not automatic repair',async t=>{
 const {path,role}=await fixture(t,'runtime');
 mutate(path,db=>db.exec('DROP INDEX channel_inbox_claim'));
 assert.throws(()=>new Store(path,{role}),/missing_index:channel_inbox_claim/);
 mutate(path,db=>{
  assert.deepEqual(db.prepare('SELECT version FROM runtime_schema_migrations ORDER BY version').all().map(row=>row.version),[1,2,3]);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='channel_inbox_claim'").get(),undefined);
 });
});


test('async migration callback is rejected before executing or recording success',()=>{
 const db=new DatabaseSync(':memory:');let entered=false;
 try {
  assert.throws(()=>runSchemaMigrations(db,{role:'combined',databasePath:':memory:',migrations:[{version:1,name:'async-invalid',sql:'-- asynchronous fixture',async apply(){entered=true;await Promise.resolve();db.exec('CREATE TABLE late_mutation(id TEXT)');}}]}),/async/);
  assert.equal(entered,false);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='combined_schema_migrations'").get(),undefined);
 }finally{db.close();}
});
