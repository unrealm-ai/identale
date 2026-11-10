import {migrateHumanRuns,migrateHumanRequestInput} from './human-storage.js';
import {migrateTaskTitles} from './task-title-migration.js';
import {migrateTriggerTasks} from './triggers/task-storage.js';
import {migratePrincipalStorage} from './principal-storage-migration.js';
import {migrateTaskPlanning} from './task-planning-migration.js';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {tableOwner} from './split/table-ownership.js';
import {projectionDatabase, replaceConfigurationTables, type StoreRole, type ConfigurationRows, type ConfigurationTable} from './split/sqlite-projection.js';
import { chmodSync, mkdirSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';

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
      const columns=(table:string)=>db.prepare(`PRAGMA table_info(${table})`).all().map(row=>row['name']);
      const exists=(table:string)=>!!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
      if (exists('conversation_messages') || columns('conversation_message_index').includes('text') || columns('interaction_turns').some(name=>['text','output','request_json'].includes(String(name))) || exists('interaction_content') || (exists('builtin_records') && !exists('builtin_storage_metadata'))) {
        throw new LegacyConversationStorageError();
      }
    } finally { db.close(); }
  }
  constructor(path: string, options: {role?: StoreRole; internalSchema?: boolean} = {}) {
    if (options.role) {
      if (!path || path === ':memory:') throw new Error('A persistent SQLite file path is required');
      Store.preflight(path);
      this.databasePath = resolve(path);
      mkdirSync(dirname(path), {recursive:true, mode:0o700});
      const raw = new DatabaseSync(path);
      chmodSync(path, 0o600);
      try {
        const existing = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
        for (const row of existing) {
          const name = String(row['name']), owner = tableOwner(name);
          if (!owner || owner !== options.role) throw new Error(`split_storage_wrong_owner:${name}`);
        }
        raw.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA temp_store=MEMORY');
        this.db = projectionDatabase(raw, options.role);
        const canonical = new Store(':memory:', {internalSchema:true});
        try {
          const schema = canonical.all<{type:string;name:string;sql:string}>("SELECT type,name,sql FROM main.sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END,name");
          for (const object of schema) {
            const statement = object.sql.replace(/CREATE TABLE /i,'CREATE TABLE IF NOT EXISTS ').replace(/CREATE (UNIQUE )?INDEX /i,(_m,unique:string|undefined)=>`CREATE ${unique??''}INDEX IF NOT EXISTS `);
            this.db.exec(statement);
          }
        } finally {canonical.close();}
        if(options.role==='platform'){this.migrateInvitationReuse();this.migrateInitialChannelDefaults();}
        if(options.role==='runtime'){migrateHumanRuns(raw);migrateHumanRequestInput(raw);migrateTaskTitles(raw);}
        this.run('INSERT OR IGNORE INTO builtin_storage_metadata VALUES(1,?)', randomUUID());
        this.databaseId = this.one<{database_id:string}>('SELECT database_id FROM builtin_storage_metadata WHERE id=1')!.database_id;
      } catch(error) {raw.close();throw error;}
      return;
    }
    if (!options.internalSchema && (path === ':memory:' || path.length === 0)) throw new Error('A persistent SQLite file path is required');
    if (!options.internalSchema) Store.preflight(path);
    this.databasePath=options.internalSchema?':memory:':resolve(path);
    if (!options.internalSchema) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (!options.internalSchema) chmodSync(path, 0o600);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active');
      CREATE TABLE IF NOT EXISTS credentials (user_id TEXT PRIMARY KEY REFERENCES users(id), password_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL DEFAULT 'active');
      CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL CHECK(role IN ('owner','admin','member')), status TEXT NOT NULL DEFAULT 'active', UNIQUE(workspace_id,user_id));
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS invitations (token_hash TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), inviter_member_id TEXT NOT NULL REFERENCES members(id), role TEXT NOT NULL CHECK(role IN ('admin','member')), expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, used_by TEXT REFERENCES users(id));
      CREATE TABLE IF NOT EXISTS entities (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL, owner_member_id TEXT NOT NULL REFERENCES members(id), created_by_member_id TEXT NOT NULL REFERENCES members(id), own_web_use INTEGER NOT NULL, web_use_user_id TEXT NOT NULL REFERENCES users(id), interaction_runtime TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entity_create_operations (user_id TEXT NOT NULL REFERENCES users(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id), operation_id TEXT NOT NULL, request_hash TEXT NOT NULL, entity_id TEXT NOT NULL REFERENCES entities(id), PRIMARY KEY(user_id,workspace_id,operation_id));
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), entity_id TEXT NOT NULL REFERENCES entities(id), user_id TEXT NOT NULL REFERENCES users(id), channel TEXT NOT NULL DEFAULT 'web', operation_id TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(user_id,entity_id,operation_id));
      CREATE TABLE IF NOT EXISTS conversation_message_index (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), role TEXT NOT NULL, record_ref TEXT NOT NULL, created_at INTEGER NOT NULL, simulated INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), entity_id TEXT NOT NULL REFERENCES entities(id), user_id TEXT NOT NULL REFERENCES users(id), conversation_id TEXT NOT NULL REFERENCES conversations(id), operation_id TEXT NOT NULL, request_hash TEXT NOT NULL, input TEXT NOT NULL, context_mode TEXT NOT NULL, snapshot_id TEXT NOT NULL, snapshot_json TEXT NOT NULL, snapshot_expires_at INTEGER, source_json TEXT NOT NULL, config_snapshot_json TEXT, status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, input_revision INTEGER NOT NULL DEFAULT 1, run_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(user_id,entity_id,operation_id));
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), session_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, sequence INTEGER NOT NULL DEFAULT 0, result TEXT, result_revision INTEGER, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS task_inputs (task_id TEXT NOT NULL REFERENCES tasks(id), revision INTEGER NOT NULL, operation_id TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY(task_id,revision), UNIQUE(task_id,operation_id));
      CREATE TABLE IF NOT EXISTS task_updates (id INTEGER PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT NOT NULL REFERENCES runs(id), event_id TEXT NOT NULL, sequence INTEGER NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(run_id,event_id), UNIQUE(run_id,sequence));
      CREATE TABLE IF NOT EXISTS task_operations (task_id TEXT NOT NULL REFERENCES tasks(id), operation_id TEXT NOT NULL, kind TEXT NOT NULL, request_hash TEXT NOT NULL, receipt_json TEXT, PRIMARY KEY(task_id,operation_id));
      CREATE TABLE IF NOT EXISTS task_outbox (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT NOT NULL REFERENCES runs(id), operation_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, input_revision INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', lease_until INTEGER NOT NULL DEFAULT 0, lease_token TEXT, attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0, last_error TEXT);
      CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), conversation_id TEXT NOT NULL REFERENCES conversations(id), event_id TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(task_id,event_id));
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, action TEXT NOT NULL, user_id TEXT NOT NULL, workspace_id TEXT);
    `);
    this.db.exec('CREATE TABLE IF NOT EXISTS builtin_storage_metadata(id INTEGER PRIMARY KEY CHECK(id=1), database_id TEXT NOT NULL)');
    this.run('INSERT OR IGNORE INTO builtin_storage_metadata VALUES(1,?)',randomUUID());
    this.databaseId=this.one<{database_id:string}>('SELECT database_id FROM builtin_storage_metadata WHERE id=1')!.database_id;
    this.migrateInvitationReuse();
    if (!this.all<{name:string}>('PRAGMA table_info(entities)').some(column => column.name === 'lifecycle_enabled')) this.db.exec('ALTER TABLE entities ADD COLUMN lifecycle_enabled INTEGER NOT NULL DEFAULT 1 CHECK(lifecycle_enabled IN (0,1))');
    if (!this.all<{name:string}>('PRAGMA table_info(entities)').some(column => column.name === 'lifecycle_revision')) this.db.exec('ALTER TABLE entities ADD COLUMN lifecycle_revision INTEGER NOT NULL DEFAULT 1');
    if (!this.all<{name:string}>('PRAGMA table_info(entities)').some(column => column.name === 'execution_thinking_level')) this.db.exec("ALTER TABLE entities ADD COLUMN execution_thinking_level TEXT NOT NULL DEFAULT 'medium' CHECK(execution_thinking_level IN ('none','low','medium','high'))");
    if (!this.all<{name:string}>('PRAGMA table_info(entities)').some(column => column.name === 'model_settings_revision')) this.db.exec('ALTER TABLE entities ADD COLUMN model_settings_revision INTEGER NOT NULL DEFAULT 0');
    this.db.exec('CREATE TABLE IF NOT EXISTS web_conversation_previews(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,message_id TEXT NOT NULL,message_rowid INTEGER NOT NULL,excerpt TEXT NOT NULL CHECK(length(excerpt)<=160),created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL)');
    if (!this.all<{name:string}>('PRAGMA table_info(entities)').some(column => column.name === 'avatar_preset')) this.db.exec('ALTER TABLE entities ADD COLUMN avatar_preset TEXT');
    this.migrateInitialChannelDefaults();
    if (!this.all<{name:string}>('PRAGMA table_info(entities)').some(column => column.name === 'description')) this.db.exec("ALTER TABLE entities ADD COLUMN description TEXT NOT NULL DEFAULT ''");
    if (!this.all<{name:string}>('PRAGMA table_info(task_operations)').some(column => column.name === 'receipt_json')) this.db.exec('ALTER TABLE task_operations ADD COLUMN receipt_json TEXT');
    if (!this.all<{name:string}>('PRAGMA table_info(tasks)').some(column => column.name === 'snapshot_expires_at')) this.db.exec("ALTER TABLE tasks ADD COLUMN snapshot_expires_at INTEGER; UPDATE tasks SET snapshot_expires_at=0 WHERE snapshot_json!='[]';");
    if (!this.all<{name:string}>('PRAGMA table_info(tasks)').some(column => column.name === 'config_snapshot_json')) this.db.exec('ALTER TABLE tasks ADD COLUMN config_snapshot_json TEXT');
    if (!this.all<{name:string}>('PRAGMA table_info(task_outbox)').some(column => column.name === 'lease_token')) this.db.exec('ALTER TABLE task_outbox ADD COLUMN lease_token TEXT');
    migratePrincipalStorage(this.db);
    migrateTaskPlanning(this.db);
    migrateTriggerTasks(this.db);
    migrateTaskTitles(this.db);
    migrateHumanRuns(this.db);
    this.db.exec(`CREATE TABLE IF NOT EXISTS employee_human_rules(workspace_id TEXT NOT NULL REFERENCES workspaces(id),entity_id TEXT NOT NULL REFERENCES entities(id),version INTEGER NOT NULL DEFAULT 1,rules_json TEXT NOT NULL DEFAULT '[]',PRIMARY KEY(workspace_id,entity_id));
      CREATE TABLE IF NOT EXISTS human_requests(request_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,entity_id TEXT NOT NULL,task_id TEXT NOT NULL REFERENCES tasks(id),source_run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),session_id TEXT NOT NULL,question_json TEXT NOT NULL,question_digest TEXT NOT NULL,input_revision INTEGER NOT NULL DEFAULT 1,content_version INTEGER NOT NULL,safe INTEGER NOT NULL DEFAULT 0,checkpoint_ref TEXT,status TEXT NOT NULL DEFAULT 'waiting',target_json TEXT,target_conversation_id TEXT,notification_status TEXT NOT NULL DEFAULT 'pending',notification_error TEXT,response_json TEXT,response_digest TEXT,continuation_run_id TEXT UNIQUE REFERENCES runs(id),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS human_response_operations(operation_id TEXT PRIMARY KEY,actor_digest TEXT NOT NULL,request_hash TEXT NOT NULL,result_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS human_response_messages(request_id TEXT NOT NULL REFERENCES human_requests(request_id),message_id TEXT NOT NULL,actor_json TEXT NOT NULL,text TEXT NOT NULL,candidate_json TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(request_id,message_id));`);migrateHumanRequestInput(this.db);
  }
  /** CREATE TABLE IF NOT EXISTS cannot upgrade an existing split-platform table. */
  private migrateInitialChannelDefaults(): void {
    this.transaction(() => {
      // Existing employees remain restrictive. Only new entity creation opts in.
      if (this.all<{name:string}>('PRAGMA table_info(entities)').some(column => column.name === 'initial_channel_defaults_json')) return;
      this.db.exec("ALTER TABLE entities ADD COLUMN initial_channel_defaults_json TEXT NOT NULL DEFAULT '{}'");
    });
  }
  private migrateInvitationReuse(): void {
    this.transaction(() => {
      if (this.all<{name: string}>('PRAGMA table_info(invitations)').some(column => column.name === 'reusable')) return;
      this.db.exec('ALTER TABLE invitations ADD COLUMN reusable INTEGER NOT NULL DEFAULT 0 CHECK(reusable IN (0,1))');
    });
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
