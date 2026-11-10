import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../dist/store.js';
import {splitLegacyStorage} from '../dist/split/migration.js';
import {resetLegacyBuiltinHistory} from '../dist/adapters/sqlite/builtin-history-reset.js';
import {validateDatabaseVersion} from '../dist/schema-migrations/catalog.js';

function fixture(t,role){const root=mkdtempSync(join(tmpdir(),'identale-offline-version-')),path=join(root,'source.sqlite');new Store(path,role?{role}:undefined).close();t.after(()=>rmSync(root,{recursive:true,force:true}));return{root,path};}

test('offline split validates combined history and initializes independent destination histories',async t=>{
 const {root,path}=fixture(t),before=readFileSync(path),dest=join(root,'split');
 const result=await splitLegacyStorage({sourceDatabasePath:path,destinationDirectory:dest,confirmOffline:true});
 assert.deepEqual(readFileSync(path),before);
 assert.ok(result.manifest.files.some(file=>file.path.includes('schema-backups')));
 for(const [role,file]of [['platform',result.platformDatabasePath],['runtime',result.runtimeDatabasePath]]){
  const db=new DatabaseSync(file,{readOnly:true});try{
   assert.equal(validateDatabaseVersion(db,role),role);
   assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='combined_schema_migrations'").get(),undefined);
   assert.deepEqual(db.prepare(`SELECT version FROM ${role}_schema_migrations ORDER BY version`).all().map(row=>row.version),[1,2,3]);
  }finally{db.close();}
 }
 assert.equal((await splitLegacyStorage({sourceDatabasePath:path,destinationDirectory:dest,confirmOffline:true})).reused,true);
});

for(const mode of ['future','checksum'])test(`offline split and history reset reject ${mode} version before mutation`,async t=>{
 const {root,path}=fixture(t),db=new DatabaseSync(path);
 db.exec(mode==='future'?"UPDATE combined_schema_migrations SET version=99 WHERE version=2":"UPDATE combined_schema_migrations SET checksum='tampered'");db.close();
 const before=readFileSync(path),dest=join(root,'split'),pattern=/schema_migration_(?:checksum_or_version_mismatch|database_newer_than_code|checksum_mismatch)/;
 await assert.rejects(splitLegacyStorage({sourceDatabasePath:path,destinationDirectory:dest,confirmOffline:true}),pattern);
 assert.equal(existsSync(dest),false);
 await assert.rejects(resetLegacyBuiltinHistory({databasePath:path,journalRoot:join(root,'absent'),dryRun:true}),pattern);
 await assert.rejects(resetLegacyBuiltinHistory({databasePath:path,journalRoot:join(root,'absent'),dryRun:false,offlineConfirmed:true,backupDirectory:join(root,'reset-backup')}),pattern);
 assert.equal(existsSync(join(root,'reset-backup')),false);assert.deepEqual(readFileSync(path),before);
});

test('history reset rejects a platform database instead of reporting no history',async t=>{
 const {root,path}=fixture(t,'platform');await assert.rejects(resetLegacyBuiltinHistory({databasePath:path,journalRoot:join(root,'absent'),dryRun:true}),/wrong_database_role/);
});
