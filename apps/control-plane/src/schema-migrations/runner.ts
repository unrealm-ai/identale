import {createHash, randomUUID} from 'node:crypto';
import {closeSync, fsyncSync, mkdirSync, openSync, realpathSync, rmSync} from 'node:fs';
import {basename, dirname, join, resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

export type MigrationRole = 'platform' | 'runtime' | 'combined';
export interface SchemaMigration {readonly version:number; readonly name:string; readonly sql:string; readonly apply?:(db:DatabaseSync)=>void;}
export interface MigrationOptions {
  role:MigrationRole;
  databasePath:string;
  migrations:readonly SchemaMigration[];
  applicationVersion?:string;
  backupDirectory?:string;
  busyTimeoutMs?:number;
  /** Check an existing unversioned schema before trusting its baseline. Must not mutate. */
  validateBaseline?:(db:DatabaseSync)=>void;
  /** Check the final schema before making the migration history durable. Must not mutate. */
  validateTarget?:(db:DatabaseSync,migrated:boolean)=>void;
}
export interface MigrationResult {applied:number[]; backupPath?:string;}
interface HistoryRow {version:number; name:string; checksum:string;}
const roles:readonly MigrationRole[]=['platform','runtime','combined'];
export function migrationHistoryTable(role:MigrationRole):string {
  if(!roles.includes(role))throw new Error('schema_migration_invalid_role');
  return `${role}_schema_migrations`;
}
export function migrationChecksum(migration:SchemaMigration):string {
  return createHash('sha256').update(JSON.stringify([migration.version,migration.name,migration.sql,migration.apply?.toString()??null])).digest('hex');
}
function assertManifest(migrations:readonly SchemaMigration[]):void {
  let previous=0;
  for(const migration of migrations){
    if(!Number.isSafeInteger(migration.version)||migration.version<=previous||!migration.name.trim()||!migration.sql.trim())throw new Error('schema_migration_invalid_manifest');
    // The runner owns transaction boundaries. Mask quoted values/comments so a
    // harmless literal cannot be mistaken for a transaction statement.
    const structural=migration.sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|--[^\r\n]*|\/\*[\s\S]*?\*\//g,' ');
    if(/(?:^|;)\s*(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|VACUUM|ATTACH|DETACH)\b/i.test(structural))throw new Error(`schema_migration_transaction_statement:${migration.version}`);
    previous=migration.version;
  }
}
function readHistory(db:DatabaseSync,table:string,migrations:readonly SchemaMigration[]):HistoryRow[]{
  if(!db.prepare("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name=?").get(table))return [];
  const rows=db.prepare(`SELECT version,name,checksum FROM main.${table} ORDER BY version`).all() as unknown as HistoryRow[];
  if(rows.length>migrations.length)throw new Error('schema_migration_database_newer_than_code');
  for(let i=0;i<rows.length;i++){
    const row=rows[i]!,expected=migrations[i]!;
    if(row.version>migrations.at(-1)!.version)throw new Error('schema_migration_database_newer_than_code');
    if(row.version!==expected.version)throw new Error(`schema_migration_history_gap:${row.version}`);
    if(row.name!==expected.name||row.checksum!==migrationChecksum(expected))throw new Error(`schema_migration_checksum_mismatch:${row.version}`);
  }
  return rows;
}
/** Snapshot the locked, committed source through SQLite, including WAL data.
 * A second read-only connection is intentional: VACUUM cannot run on the writer
 * connection inside BEGIN IMMEDIATE. No schema/data writes have happened yet. */
function backupDatabase(options:MigrationOptions):string {
  const path=resolve(options.databasePath),root=options.backupDirectory??join(dirname(path),'schema-backups');
  mkdirSync(root,{recursive:true,mode:0o700});
  const directory=join(root,`${options.role}-${Date.now()}-${randomUUID()}`);
  mkdirSync(directory,{mode:0o700});
  const destination=join(directory,basename(path));
  closeSync(openSync(destination,'wx',0o600));
  let source:DatabaseSync|undefined,check:DatabaseSync|undefined;
  try{
    source=new DatabaseSync(path,{readOnly:true});
    source.exec(`PRAGMA busy_timeout=${options.busyTimeoutMs??5000}`);
    source.prepare('VACUUM INTO ?').run(destination);
    source.close();source=undefined;
    check=new DatabaseSync(destination,{readOnly:true});
    const integrity=check.prepare('PRAGMA quick_check').all();
    if(integrity.length!==1||integrity[0]?.['quick_check']!=='ok')throw new Error('schema_migration_backup_invalid');
    check.close();check=undefined;
    const fd=openSync(destination,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
    return destination;
  }catch(error){source?.close();check?.close();rmSync(directory,{recursive:true,force:true});throw error;}
}

/** Run on the raw owning connection, before repositories, workers or readiness.
 * No network calls, await boundaries, or best-effort skips are allowed here. */
export function runSchemaMigrations(db:DatabaseSync,options:MigrationOptions):MigrationResult {
  assertManifest(options.migrations);
  const table=migrationHistoryTable(options.role),timeout=options.busyTimeoutMs??5000;
  if(!Number.isSafeInteger(timeout)||timeout<0||timeout>300_000)throw new Error('schema_migration_invalid_timeout');
  if(db.isTransaction)throw new Error('schema_migration_already_in_transaction');
  const actualPath=String(db.prepare('PRAGMA database_list').all().find(row=>row['name']==='main')?.['file']??'');
  if(options.databasePath===':memory:' ? actualPath!=='' : !actualPath||realpathSync(actualPath)!==realpathSync(resolve(options.databasePath)))throw new Error('schema_migration_database_path_mismatch');
  const previousTimeout=Number(db.prepare('PRAGMA busy_timeout').get()?.['timeout']??0);
  db.exec(`PRAGMA busy_timeout=${timeout}`);
  let locked=false,version:number|undefined;
  try{
    db.exec('BEGIN IMMEDIATE');locked=true;
    for(const role of roles){
      if(role!==options.role&&db.prepare("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name=?").get(migrationHistoryTable(role)))throw new Error('schema_migration_wrong_database_role');
    }
    const history=readHistory(db,table,options.migrations),pending=options.migrations.slice(history.length);
    const existing=!!db.prepare("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!=? LIMIT 1").get(table);
    if(history.length===0&&existing)options.validateBaseline?.(db);
    if(!pending.length){options.validateTarget?.(db,false);db.exec('COMMIT');locked=false;return {applied:[]};}
    let backupPath:string|undefined;
    if((existing||history.length>0)&&options.databasePath!==':memory:')backupPath=backupDatabase(options);
    db.exec(`CREATE TABLE IF NOT EXISTS main.${table}(version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at INTEGER NOT NULL,application_version TEXT NOT NULL)`);
    const insert=db.prepare(`INSERT INTO main.${table}(version,name,checksum,applied_at,application_version) VALUES(?,?,?,?,?)`);
    for(const migration of pending){
      version=migration.version;
      if(migration.apply){
        if(migration.apply.constructor.name==='AsyncFunction')throw new Error('schema_migration_async_callback');
        const result:unknown=migration.apply(db);
        if(result&&typeof result==='object'&&'then' in result)throw new Error('schema_migration_async_callback');
      }else db.exec(migration.sql);
      if(!db.isTransaction)throw new Error('schema_migration_transaction_lost');
      insert.run(migration.version,migration.name,migrationChecksum(migration),Date.now(),options.applicationVersion??'unversioned');
    }
    options.validateTarget?.(db,true);
    db.exec('COMMIT');locked=false;
    return {applied:pending.map(m=>m.version),...(backupPath?{backupPath}:{})};
  }catch(error){
    if(locked&&db.isTransaction)db.exec('ROLLBACK');
    throw new Error(`schema_migration_failed:${options.role}:${version??'preflight'}:${error instanceof Error?error.message:String(error)}`,{cause:error});
  }finally{db.exec(`PRAGMA busy_timeout=${previousTimeout}`);}
}
