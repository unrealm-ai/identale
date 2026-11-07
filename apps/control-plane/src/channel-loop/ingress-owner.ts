import {randomUUID} from 'node:crypto';
import {ChannelError} from '@dentity/application';
import type {Store} from '../store.js';
/** Single-machine, shared-database ingress owner. A crashed owner expires. */
export class IngressOwner {
 readonly incarnation=randomUUID();
 private epoch:number|undefined;
 constructor(private readonly store:Store,private readonly now:()=>number,private readonly ttlMs=30_000){
  store.db.exec('CREATE TABLE IF NOT EXISTS channel_ingress_owner(id INTEGER PRIMARY KEY CHECK(id=1),incarnation TEXT NOT NULL,epoch INTEGER NOT NULL,expires_at INTEGER NOT NULL)');
 }
 acquire(){this.store.transaction(()=>{const now=this.now(),row=this.store.one<{epoch:number;expires_at:number}>('SELECT epoch,expires_at FROM channel_ingress_owner WHERE id=1');if(row&&row.expires_at>now)throw new ChannelError('temporarily_unavailable','channel_ingress_owner_busy');const epoch=(row?.epoch??0)+1;this.store.run('INSERT INTO channel_ingress_owner(id,incarnation,epoch,expires_at) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET incarnation=excluded.incarnation,epoch=excluded.epoch,expires_at=excluded.expires_at',this.incarnation,epoch,now+this.ttlMs);this.epoch=epoch;});}
 renew(){if(this.epoch===undefined)return false;return !!this.store.run('UPDATE channel_ingress_owner SET expires_at=? WHERE id=1 AND incarnation=? AND epoch=? AND expires_at>?',this.now()+this.ttlMs,this.incarnation,this.epoch,this.now()).changes;}
 assert(){if(this.epoch===undefined||!this.store.one('SELECT 1 FROM channel_ingress_owner WHERE id=1 AND incarnation=? AND epoch=? AND expires_at>?',this.incarnation,this.epoch,this.now()))throw new ChannelError('forbidden','channel_ingress_owner_lost');}
 commit<T>(write:()=>T):T{return this.store.transaction(()=>{this.assert();return write();});}
 release(){if(this.epoch!==undefined)this.store.run('UPDATE channel_ingress_owner SET expires_at=0 WHERE id=1 AND incarnation=? AND epoch=?',this.incarnation,this.epoch);this.epoch=undefined;}
}
