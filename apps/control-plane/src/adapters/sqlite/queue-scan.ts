import type {Store} from '../../store.js';
export interface QueueScanToken {key:string;epoch:number;sequence:number}
interface Cursor {epoch:number;after_sequence:number;ceiling:number}
/** A scheduling hint, never a lease/authorization receipt. Each finite cycle has
 * a fixed rowid ceiling; skipped candidates cannot pin the next batch forever. */
export class SqliteQueueScan {
 constructor(private store:Store){store.db.exec('CREATE TABLE IF NOT EXISTS queue_scan_cursors(key TEXT PRIMARY KEY,epoch INTEGER NOT NULL,after_sequence INTEGER NOT NULL,ceiling INTEGER NOT NULL)');}
 page<T extends {queue_sequence:number}>(key:string,table:'task_outbox'|'work_item_intents'|'work_item_dispatches',limit:number,read:(after:number,ceiling:number,limit:number)=>T[],restart=true):(T&{scan:QueueScanToken})[]{return this.store.transaction(()=>{
  const old=this.store.one<Cursor>('SELECT * FROM queue_scan_cursors WHERE key=?',key),fresh=!old||old.after_sequence>=old.ceiling;
  if(fresh&&!restart)return [];
  const cursor=fresh?{epoch:(old?.epoch??0)+1,after_sequence:0,ceiling:this.store.one<{n:number}>('SELECT coalesce(max(rowid),0) n FROM '+table)!.n}:old;
  const rows=read(cursor.after_sequence,cursor.ceiling,limit);
  if(!rows.length){if(old&&!fresh)this.store.run('UPDATE queue_scan_cursors SET after_sequence=ceiling WHERE key=? AND epoch=?',key,old.epoch);return [];}
  if(fresh)this.store.run('INSERT INTO queue_scan_cursors VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET epoch=excluded.epoch,after_sequence=excluded.after_sequence,ceiling=excluded.ceiling',key,cursor.epoch,0,cursor.ceiling);
  return rows.map(row=>({...row,scan:{key,epoch:cursor.epoch,sequence:row.queue_sequence}}));
 });}
 advance(token:QueueScanToken){this.store.run('UPDATE queue_scan_cursors SET after_sequence=max(after_sequence,?) WHERE key=? AND epoch=? AND ?<=ceiling AND after_sequence<?',token.sequence,token.key,token.epoch,token.sequence,token.sequence);}
}
