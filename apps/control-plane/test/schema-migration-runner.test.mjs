import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,readdirSync,statSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {runSchemaMigrations,migrationChecksum} from '../dist/schema-migrations/runner.js';
const initial={version:1,name:'create things',sql:'CREATE TABLE things(id INTEGER PRIMARY KEY, value TEXT);'};
const next={version:2,name:'add flag',sql:"ALTER TABLE things ADD COLUMN flag INTEGER NOT NULL DEFAULT 0; INSERT INTO things(value) VALUES('new');"};
function fixture(t){const root=mkdtempSync(join(tmpdir(),'identale-schema-runner-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const path=join(root,'db.sqlite'),db=new DatabaseSync(path);t.after(()=>db.close());return {root,path,db};}
function opts(path,migrations=[initial]){return{role:'platform',databasePath:path,migrations};}
function child(code){return new Promise((resolve,reject)=>{const p=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.on('error',reject);p.on('exit',(status,signal)=>resolve({status,signal,out,err}));});}
const runnerUrl=new URL('../dist/schema-migrations/runner.js',import.meta.url).href;

test('new database, ordered upgrade, protected consistent backup and no-op repeat',t=>{
 const {root,path,db}=fixture(t);db.exec('PRAGMA journal_mode=WAL');
 assert.deepEqual(runSchemaMigrations(db,opts(path)),{applied:[1]});assert.equal(existsSync(join(root,'schema-backups')),false);
 db.prepare('INSERT INTO things(value) VALUES(?)').run('existing');
 const result=runSchemaMigrations(db,opts(path,[initial,next]));assert.deepEqual(result.applied,[2]);
 assert.equal(statSync(result.backupPath).mode&0o777,0o600);
 const copy=new DatabaseSync(result.backupPath,{readOnly:true});try{assert.deepEqual(copy.prepare('SELECT value FROM things').all().map(x=>x.value),['existing']);assert.equal(copy.prepare('PRAGMA table_info(things)').all().some(c=>c.name==='flag'),false);assert.equal(copy.prepare('PRAGMA quick_check').get().quick_check,'ok');}finally{copy.close();}
 assert.deepEqual(runSchemaMigrations(db,opts(path,[initial,next])),{applied:[]});assert.equal(readdirSync(join(root,'schema-backups')).length,1);
 assert.deepEqual(db.prepare('SELECT value,flag FROM things ORDER BY id').all().map(r=>({...r})),[{value:'existing',flag:0},{value:'new',flag:0}]);
 assert.equal(db.prepare('SELECT checksum FROM platform_schema_migrations WHERE version=1').get().checksum,migrationChecksum(initial));
});

test('pending migrations and history roll back together; repeat can recover',t=>{
 const {path,db}=fixture(t);runSchemaMigrations(db,opts(path));
 const broken={version:3,name:'broken',sql:'INSERT INTO does_not_exist VALUES(1)'};
 assert.throws(()=>runSchemaMigrations(db,opts(path,[initial,next,broken])),/schema_migration_failed:platform:3/);
 assert.equal(db.prepare('PRAGMA table_info(things)').all().some(c=>c.name==='flag'),false);assert.equal(db.prepare('SELECT count(*) n FROM platform_schema_migrations').get().n,1);
 assert.deepEqual(runSchemaMigrations(db,opts(path,[initial,next])).applied,[2]);
});

test('checksum changes, history gaps, future versions and wrong role fail closed',t=>{
 const {path,db}=fixture(t);runSchemaMigrations(db,opts(path,[initial,next]));
 assert.throws(()=>runSchemaMigrations(db,opts(path,[{...initial,sql:initial.sql+' '},next])),/checksum_mismatch/);
 assert.throws(()=>runSchemaMigrations(db,opts(path)),/database_newer_than_code/);
 assert.throws(()=>runSchemaMigrations(db,{...opts(path,[initial,next]),role:'runtime'}),/wrong_database_role/);
 db.exec('DELETE FROM platform_schema_migrations WHERE version=1');
 assert.throws(()=>runSchemaMigrations(db,opts(path,[initial,next])),/history_gap/);
});

test('existing unversioned database is checked before writes and failed target check rolls back',t=>{
 const {path,db}=fixture(t);db.exec('CREATE TABLE old_table(value TEXT);INSERT INTO old_table VALUES(\'old\')');
 assert.throws(()=>runSchemaMigrations(db,{...opts(path),validateBaseline(){throw new Error('unrecognized_schema');}}),/unrecognized_schema/);
 assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='platform_schema_migrations'").get().n,0);
 assert.throws(()=>runSchemaMigrations(db,{...opts(path),validateBaseline(d){assert.equal(d.prepare('SELECT value FROM old_table').get().value,'old');},validateTarget(){throw new Error('target_invalid');}}),/target_invalid/);
 assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='things'").get().n,0);
});

test('invalid manifests and transaction ownership cannot bypass atomic history',t=>{
 const {path,db}=fixture(t);
 for(const sql of ['BEGIN;CREATE TABLE x(a);COMMIT','--comment\nCOMMIT;','CREATE TABLE x(a); END;','VACUUM;','ATTACH DATABASE \'x\' AS x'])assert.throws(()=>runSchemaMigrations(db,opts(path,[{...initial,sql}])),/transaction_statement/);
 assert.throws(()=>runSchemaMigrations(db,opts(path,[next,initial])),/invalid_manifest/);
 db.exec('BEGIN');assert.throws(()=>runSchemaMigrations(db,opts(path)),/already_in_transaction/);db.exec('ROLLBACK');
 assert.deepEqual(runSchemaMigrations(db,opts(path,[{...initial,sql:"CREATE TABLE x(value TEXT DEFAULT 'COMMIT;'); -- BEGIN"}])).applied,[1]);
});

test('two processes recheck history under the lock and apply once',async t=>{
 const {path,db}=fixture(t);db.exec('PRAGMA journal_mode=WAL');
 const migration={version:1,name:'slow seed',sql:'CREATE TABLE applied(id INTEGER PRIMARY KEY);INSERT INTO applied VALUES(1);'};
 const code=`import{DatabaseSync}from'node:sqlite';import{runSchemaMigrations}from${JSON.stringify(runnerUrl)};const db=new DatabaseSync(${JSON.stringify(path)});try{console.log(JSON.stringify(runSchemaMigrations(db,{role:'platform',databasePath:${JSON.stringify(path)},migrations:${JSON.stringify([migration])},validateTarget(){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);}})));}finally{db.close();}`;
 const results=await Promise.all([child(code),child(code)]);for(const r of results)assert.equal(r.status,0,r.err);
 assert.deepEqual(results.map(r=>JSON.parse(r.out).applied.length).sort(),[0,1]);assert.equal(db.prepare('SELECT count(*) n FROM applied').get().n,1);
});

test('busy lock fails in bounded time without recording success',async t=>{
 const {path,db}=fixture(t);db.exec('BEGIN IMMEDIATE');
 const result=await child(`import{DatabaseSync}from'node:sqlite';import{runSchemaMigrations}from${JSON.stringify(runnerUrl)};const d=new DatabaseSync(${JSON.stringify(path)});try{runSchemaMigrations(d,{...${JSON.stringify(opts(path))},busyTimeoutMs:50});process.exitCode=2;}catch(e){console.log(e.message);}finally{d.close();}`);
 db.exec('ROLLBACK');assert.equal(result.status,0,result.err);assert.match(result.out,/locked/);assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='platform_schema_migrations'").get().n,0);
});

test('killed process rolls back schema and history and next start recovers',async t=>{
 const {path,db}=fixture(t);runSchemaMigrations(db,opts(path));
 const result=await child(`import{DatabaseSync}from'node:sqlite';import{runSchemaMigrations}from${JSON.stringify(runnerUrl)};const db=new DatabaseSync(${JSON.stringify(path)});runSchemaMigrations(db,{...${JSON.stringify(opts(path,[initial,next]))},validateTarget(){process.kill(process.pid,'SIGKILL');}});`);
 assert.equal(result.signal,'SIGKILL');assert.equal(db.prepare('SELECT count(*) n FROM platform_schema_migrations').get().n,1);assert.equal(db.prepare('PRAGMA table_info(things)').all().some(c=>c.name==='flag'),false);
 assert.deepEqual(runSchemaMigrations(db,opts(path,[initial,next])).applied,[2]);
});

test('callback migration source participates in checksum and failures roll back',t=>{
 const {path,db}=fixture(t);
 const callback={version:2,name:'explicit legacy field',sql:'-- explicit field upgrade v1',apply(db){db.exec('ALTER TABLE things ADD COLUMN active INTEGER DEFAULT 0');}};
 runSchemaMigrations(db,opts(path,[initial,callback]));
 assert.equal(db.prepare('PRAGMA table_info(things)').all().some(c=>c.name==='active'),true);
 assert.throws(()=>runSchemaMigrations(db,opts(path,[initial,{...callback,apply(db){db.exec('SELECT 1');}}])),/checksum_mismatch/);
 const broken={version:3,name:'callback fails',sql:'-- test rollback',apply(db){db.exec('CREATE TABLE transient(id INTEGER)');throw new Error('injected');}};
 assert.throws(()=>runSchemaMigrations(db,opts(path,[initial,callback,broken])),/injected/);
 assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='transient'").get(),undefined);
});

test('a different backup source is rejected before schema mutation',t=>{
 const {path,db,root}=fixture(t),otherPath=join(root,'other.sqlite'),other=new DatabaseSync(otherPath);other.close();
 assert.throws(()=>runSchemaMigrations(db,opts(otherPath)),/database_path_mismatch/);
 assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='things'").get(),undefined);
 assert.throws(()=>runSchemaMigrations(db,opts(':memory:')),/database_path_mismatch/);
 assert.deepEqual(runSchemaMigrations(db,opts(path)),{applied:[1]});
});

test('rollback-journal source backup preserves committed data',t=>{
 const {path,db}=fixture(t);db.exec('PRAGMA journal_mode=DELETE');runSchemaMigrations(db,opts(path));db.exec("INSERT INTO things(value) VALUES('rollback-journal-data')");
 const result=runSchemaMigrations(db,opts(path,[initial,next]));const backup=new DatabaseSync(result.backupPath,{readOnly:true});try{assert.equal(backup.prepare('SELECT value FROM things').get().value,'rollback-journal-data');}finally{backup.close();}
});
