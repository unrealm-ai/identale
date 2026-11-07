import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import type {Store} from '../store.js';
const localOwners=new Set<string>();
/** Local OS ownership evidence, independent of message TTL and ingress leases. */
export class RuntimeProcessOwner {
 readonly instanceId=randomUUID();
 readonly previousOwnerUnavailable:boolean;
 private released=false;
 constructor(private readonly store:Store){
  if(localOwners.has(store.databasePath))throw Error('runtime_process_owner_busy');
  store.db.exec('CREATE TABLE IF NOT EXISTS runtime_process_owner(id INTEGER PRIMARY KEY CHECK(id=1),pid INTEGER NOT NULL,instance_id TEXT NOT NULL,start_identity TEXT NOT NULL,epoch INTEGER NOT NULL,released INTEGER NOT NULL DEFAULT 0)');
  const start=this.identity(process.pid);const previous=store.one<{pid:number;instance_id:string;start_identity:string;epoch:number;released:number}>('SELECT * FROM runtime_process_owner WHERE id=1');
  let dead=false;
  if(previous){dead=previous.released===1;try{if(!dead)process.kill(previous.pid,0);}catch(e){dead=(e as NodeJS.ErrnoException).code==='ESRCH';}const observed=this.identity(previous.pid);if(!dead&&observed&&previous.start_identity&&observed!==previous.start_identity)dead=true;if(!dead)throw Error('runtime_process_owner_busy');}
  else {
   // Legacy records have no PID. Only a successful OS handle inventory proving
   // this process alone has the database open is accepted as restart evidence.
   try{const pids=execFileSync('/usr/sbin/lsof',['-t','--',store.databasePath],{encoding:'utf8',timeout:2000}).trim().split(/\s+/).map(Number);dead=pids.length>0&&pids.every(pid=>pid===process.pid);}catch{/* Missing inventory remains unverified. */}
  }
  this.previousOwnerUnavailable=dead;
  store.transaction(()=>{const current=store.one<{instance_id:string}>('SELECT instance_id FROM runtime_process_owner WHERE id=1');if(current?.instance_id!==previous?.instance_id)throw Error('runtime_process_owner_changed');store.run('INSERT INTO runtime_process_owner VALUES(1,?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET pid=excluded.pid,instance_id=excluded.instance_id,start_identity=excluded.start_identity,epoch=excluded.epoch,released=0',process.pid,this.instanceId,start,(previous?.epoch??0)+1);});localOwners.add(store.databasePath);
 }
 private identity(pid:number){try{return execFileSync('/bin/ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8',timeout:1000}).trim();}catch{return'';}}
 assert(){if(this.released||this.store.one<{instance_id:string}>('SELECT instance_id FROM runtime_process_owner WHERE id=1')?.instance_id!==this.instanceId)throw Error('runtime_process_owner_lost');}
 release(){if(this.released)return;this.released=true;localOwners.delete(this.store.databasePath);this.store.run('UPDATE runtime_process_owner SET released=1 WHERE id=1 AND instance_id=?',this.instanceId);}
}
