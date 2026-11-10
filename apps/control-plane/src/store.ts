import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {tableOwner} from './split/table-ownership.js';
import {migrateDatabase,schemaForRole} from './schema-migrations/catalog.js';
import {projectionDatabase, replaceConfigurationTables, type StoreRole, type ConfigurationRows, type ConfigurationTable} from './split/sqlite-projection.js';
import { chmodSync, mkdirSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';

/** WAL mode transitions can return SQLITE_BUSY without invoking SQLite's busy
 * handler. Retry only this idempotent connection setup, never a migration body. */
function configureConnection(db:DatabaseSync):void {
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA temp_store=MEMORY');
  const deadline=performance.now()+5000,wait=new Int32Array(new SharedArrayBuffer(4));
  try {
    for(;;){
      const remaining=Math.max(0,Math.ceil(deadline-performance.now()));
      db.exec(`PRAGMA busy_timeout=${remaining}`);
      try{db.exec('PRAGMA journal_mode=WAL');return;}
      catch(error){
        if(!error||typeof error!=='object'||!('errcode' in error)||(Number(error.errcode)&255)!==5||performance.now()>=deadline)throw error;
        Atomics.wait(wait,0,0,Math.min(25,Math.max(0,deadline-performance.now())));
      }
    }
  } finally {db.exec('PRAGMA busy_timeout=5000');}
}

export class LegacyConversationStorageError extends Error {
  constructor(){super('Legacy conversation storage detected; no migration is supported. Configure a new database and journal root. Existing data was not changed.');this.name='LegacyConversationStorageError';}
}

/** Infrastructure-only SQLite adapter. Transactions never cross an await boundary. */
export class Store {
  readonly db: DatabaseSync;
  readonly databaseId: string;
  readonly databasePath: string;
  private transactionDepth = 0;
  /** Read-only preflight: never mutate or migrate legacy conversation storage. */
  static preflight(path:string):void {
    if (!existsSync(path)) return;
    const db=new DatabaseSync(path,{readOnly:true});
    try {
      db.exec('PRAGMA busy_timeout=5000');
      const columns=(table:string)=>db.prepare(`PRAGMA table_info(${table})`).all().map(row=>row['name']);
      const exists=(table:string)=>!!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
      if (exists('conversation_messages') || columns('conversation_message_index').includes('text') || columns('interaction_turns').some(name=>['text','output','request_json'].includes(String(name))) || exists('interaction_content') || (exists('builtin_records') && !exists('builtin_storage_metadata'))) {
        throw new LegacyConversationStorageError();
      }
    } finally { db.close(); }
  }
  constructor(path: string, options: {role?: StoreRole; internalSchema?: boolean} = {}) {
    if(options.internalSchema && (path!==':memory:'||options.role))throw new Error('Internal schema must use an isolated memory database');
    if (!options.internalSchema && (!path || path === ':memory:')) throw new Error('A persistent SQLite file path is required');
    if (!options.internalSchema) Store.preflight(path);
    this.databasePath = options.internalSchema ? ':memory:' : resolve(path);
    if (!options.internalSchema) mkdirSync(dirname(path), {recursive:true,mode:0o700});
    const raw = new DatabaseSync(path);
    if (!options.internalSchema) chmodSync(path,0o600);
    try {
      configureConnection(raw);
      if(options.role)for(const row of raw.prepare("SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()){const name=String(row['name']);if(tableOwner(name)!==options.role)throw Error(`split_storage_wrong_owner:${name}`);}
      // Version history and structural changes only ever operate on main, never
      // on runtime's replaceable platform configuration projection.
      migrateDatabase(raw,this.databasePath,options.role??'combined');
      this.db = options.role ? projectionDatabase(raw,options.role) : raw;
      if (options.role) {
        for (const object of schemaForRole('combined')) {
          if (tableOwner(object.tbl_name)===options.role || object.type==='trigger') continue;
          this.db.exec(object.sql.replace(/CREATE TABLE /i,'CREATE TABLE IF NOT EXISTS ').replace(/CREATE (UNIQUE )?INDEX /i,(_m,unique:string|undefined)=>`CREATE ${unique??''}INDEX IF NOT EXISTS `));
        }
      }
      this.run('INSERT OR IGNORE INTO builtin_storage_metadata VALUES(1,?)',randomUUID());
      this.databaseId=this.one<{database_id:string}>('SELECT database_id FROM builtin_storage_metadata WHERE id=1')!.database_id;
    } catch(error) {raw.close();throw error;}
  }
  one<T>(sql: string, ...args: SQLInputValue[]): T | undefined { return this.db.prepare(sql).get(...args) as T | undefined; }
  all<T>(sql: string, ...args: SQLInputValue[]): T[] { return this.db.prepare(sql).all(...args) as T[]; }
  run(sql: string, ...args: SQLInputValue[]) { return this.db.prepare(sql).run(...args); }
  transaction<T>(fn: () => T): T {
    const nested=this.transactionDepth>0, savepoint=`nested_${this.transactionDepth++}`;
    try {
      this.db.exec(nested?`SAVEPOINT ${savepoint}`:'BEGIN IMMEDIATE');
      try { const value=fn(); this.db.exec(nested?`RELEASE ${savepoint}`:'COMMIT'); return value; }
      catch(error) { this.db.exec(nested?`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`:'ROLLBACK'); throw error; }
    } finally { this.transactionDepth--; }
  }
  /** Platform facts in runtime memory only; runtime-owned tables can never be replaced. */
  replaceConfigurationTables(snapshot: ConfigurationRows | readonly ConfigurationTable[]): void {replaceConfigurationTables(this.db, snapshot);}
  close() { this.db.close(); }
}
