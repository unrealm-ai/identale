import type {JournalIndexPort,JournalRecordIndex,JournalContextHead} from '@dentity/runtime-builtin';
import type {Store} from '../../store.js';
/** Indexed immutable-payload identities; no conversation/request body is stored here. */
export function createJournalIndex(store:Store):JournalIndexPort{
 const marker=store.one("SELECT name FROM sqlite_master WHERE type='table' AND name='builtin_journal_scopes'");
 if(!marker){
  const records=store.one("SELECT name FROM sqlite_master WHERE type='table' AND name='builtin_records'");
  if(records&&store.one("SELECT key FROM builtin_records WHERE key LIKE 'builtin:session:%' LIMIT 1"))throw Error('interaction_storage_reset_required');
 }
 store.db.exec(`CREATE TABLE IF NOT EXISTS builtin_journal_scopes(resource_id TEXT PRIMARY KEY,format_version INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS builtin_journal_index(sequence INTEGER PRIMARY KEY AUTOINCREMENT,resource_id TEXT NOT NULL,record_id TEXT NOT NULL,kind TEXT NOT NULL,bytes INTEGER NOT NULL,execution_key TEXT,run_key TEXT,UNIQUE(resource_id,record_id));
 CREATE INDEX IF NOT EXISTS builtin_journal_kind ON builtin_journal_index(resource_id,kind,sequence);
 CREATE INDEX IF NOT EXISTS builtin_journal_execution ON builtin_journal_index(resource_id,execution_key,kind);
 CREATE TABLE IF NOT EXISTS builtin_journal_heads(resource_id TEXT PRIMARY KEY,version TEXT NOT NULL,refs_json TEXT NOT NULL,checksum TEXT NOT NULL);`);
 const record=(r:{record_id:string;kind:string;bytes:number;execution_key:string|null;run_key:string|null}):JournalRecordIndex=>({recordId:r.record_id,kind:r.kind,bytes:r.bytes,...(r.execution_key?{executionKey:r.execution_key}:{}),...(r.run_key?{runKey:r.run_key}:{})});
 return{
  migrated:id=>store.one<{format_version:number}>('SELECT format_version FROM builtin_journal_scopes WHERE resource_id=?',id)?.format_version===2,
  markMigrated:id=>{store.run('INSERT INTO builtin_journal_scopes VALUES(?,2) ON CONFLICT(resource_id) DO UPDATE SET format_version=2',id);},
  get:(id,rid)=>{const row=store.one<Parameters<typeof record>[0]>('SELECT * FROM builtin_journal_index WHERE resource_id=? AND record_id=?',id,rid);return row?record(row):undefined;},
  add:(id,r)=>{const old=store.one<{kind:string;bytes:number}>('SELECT kind,bytes FROM builtin_journal_index WHERE resource_id=? AND record_id=?',id,r.recordId);if(old&&(old.kind!==r.kind||old.bytes!==r.bytes))throw Error('Journal index conflict');store.run('INSERT OR IGNORE INTO builtin_journal_index(resource_id,record_id,kind,bytes,execution_key,run_key) VALUES(?,?,?,?,?,?)',id,r.recordId,r.kind,r.bytes,r.executionKey??null,r.runKey??null);},
  list:(id,kind)=>store.all<Parameters<typeof record>[0]>('SELECT * FROM builtin_journal_index WHERE resource_id=? AND kind=? ORDER BY sequence DESC',id,kind).map(record),
  head:id=>{const row=store.one<{version:string;refs_json:string;checksum:string}>('SELECT * FROM builtin_journal_heads WHERE resource_id=?',id);return row?{version:row.version,refs:JSON.parse(row.refs_json),checksum:row.checksum}:undefined;},
  setHead:(id,h:JournalContextHead)=>{store.run('INSERT INTO builtin_journal_heads VALUES(?,?,?,?) ON CONFLICT(resource_id) DO UPDATE SET version=excluded.version,refs_json=excluded.refs_json,checksum=excluded.checksum',id,h.version,JSON.stringify(h.refs),h.checksum);},
  remove:id=>{store.run('DELETE FROM builtin_journal_index WHERE resource_id=?',id);store.run('DELETE FROM builtin_journal_heads WHERE resource_id=?',id);store.run('DELETE FROM builtin_journal_scopes WHERE resource_id=?',id);},
 };
}
