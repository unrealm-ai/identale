import {createHash} from 'node:crypto';
import {ChannelError,type MessageLoopBinding,type ChannelMessageLoop,type ChannelIngressDisposition} from '@dentity/application';
import type {Store} from '../store.js';
import type {DiscoveredGroups} from './discovered-groups.js';
import type {NormalizedChannelIngress} from '../adapters/channels/ingress/normalize.js';

type Evidence=Extract<NormalizedChannelIngress,{kind:'message'|'membership'}>;
type Pending={id:string;connection_id:string;binding_version:string;payload:string};
/** Only verified Feishu ingress calls this. No model or public HTTP entry point. */
export class FeishuGroupLifecycle {
 private readonly chains=new Map<string,Promise<unknown>>();
 constructor(private readonly store:Store,private readonly groups:DiscoveredGroups,private readonly loop:Pick<ChannelMessageLoop,'membership'>,private readonly now:()=>number){
  store.db.exec(`CREATE TABLE IF NOT EXISTS feishu_group_evidence(id TEXT PRIMARY KEY,connection_id TEXT NOT NULL,binding_version TEXT NOT NULL,chat_id TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',reason TEXT,retry_at INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0);
  CREATE INDEX IF NOT EXISTS feishu_group_evidence_pending ON feishu_group_evidence(status,retry_at);
  CREATE TABLE IF NOT EXISTS feishu_group_disbanded(connection_id TEXT NOT NULL,binding_version TEXT NOT NULL,chat_id TEXT NOT NULL,PRIMARY KEY(connection_id,binding_version,chat_id));`);
 }
 pending(connectionId?:string):Pending[]{return this.store.all<Pending>("SELECT id,connection_id,binding_version,payload FROM feishu_group_evidence WHERE status='pending' AND retry_at<=?"+(connectionId?' AND connection_id=?':'')+' ORDER BY rowid LIMIT 10',this.now(),...(connectionId?[connectionId]:[]));}
 obsolete(id:string){this.store.run("UPDATE feishu_group_evidence SET status='obsolete',reason='binding_changed',payload='{}' WHERE id=?",id);}
 async handle(b:MessageLoopBinding,n:NormalizedChannelIngress,commit:<T>(fn:()=>T)=>T,apply:()=>Promise<ChannelIngressDisposition>):Promise<ChannelIngressDisposition>{
  if(b.provider!=='feishu'||n.kind!=='membership'&&n.kind!=='message')return apply();
  if(n.kind==='message'&&(n.event.origin!=='live'||n.event.message.conversationKind!=='group'||n.event.message.author.kind!=='human'||b.policy.ownSenderIds.includes(n.event.message.author.externalId??'')||!n.event.message.mentions.includes(b.policy.entityMentionId)&&!b.context?.groupListenEnabled))return apply();
  const evidence=n as Evidence,chat=evidence.kind==='membership'?evidence.chatId:evidence.event.message.conversation.externalId;
  const key=JSON.stringify([b.connectionId,chat]),previous=this.chains.get(key)??Promise.resolve();
  const work=previous.catch(()=>{}).then(()=>this.process(b,evidence,chat,commit,apply));this.chains.set(key,work);
  try{return await work;}finally{if(this.chains.get(key)===work)this.chains.delete(key);}
 }
 private async process(b:MessageLoopBinding,n:Evidence,chat:string,commit:<T>(fn:()=>T)=>T,apply:()=>Promise<ChannelIngressDisposition>):Promise<ChannelIngressDisposition>{
  const at=n.kind==='membership'?n.occurredAt:n.event.message.occurredAt;
  const eventId=n.kind==='membership'?n.eventId??JSON.stringify([at,n.present]):n.event.message.id;
  const id=createHash('sha256').update(JSON.stringify([b.connectionId,b.bindingVersion,chat,n.kind,eventId])).digest('hex');
  const receipt=this.store.one<{status:string;retry_at:number}>('SELECT status,retry_at FROM feishu_group_evidence WHERE id=?',id);
  if(receipt&&receipt.status!=='pending')return'duplicate';
  if(receipt&&receipt.retry_at>this.now())return'accepted';
  const state=this.store.one<{present:number;changed_at:number}>('SELECT present,changed_at FROM group_live_membership WHERE connection_id=? AND chat_id=?',b.connectionId,chat);
  const terminal=!!this.store.one('SELECT chat_id FROM feishu_group_disbanded WHERE connection_id=? AND binding_version=? AND chat_id=?',b.connectionId,b.bindingVersion,chat);
  // Ordinary already-admitted paths do not acquire a new remote dependency.
  if(n.kind==='message'&&state?.present!==0&&!terminal&&!receipt)return apply();
  commit(()=>this.store.run('INSERT OR IGNORE INTO feishu_group_evidence(id,connection_id,binding_version,chat_id,payload) VALUES(?,?,?,?,?)',id,b.connectionId,b.bindingVersion,chat,JSON.stringify(n)));
  const finish=(status:string,reason:string|null=null)=>commit(()=>this.store.run("UPDATE feishu_group_evidence SET status=?,reason=?,payload='{}' WHERE id=?",status,reason,id));
  if(terminal){finish('ignored','group_disbanded');return'ignored';}
  if(n.kind==='message'&&state?.present===0&&at<=state.changed_at){finish('ignored','message_before_leave');return'ignored';}
  const set=(present:boolean,watermark=Math.max(at,state?.changed_at??0))=>{this.loop.membership(b.connectionId,chat,present,watermark,true);this.groups.discover(b,chat,at,n.kind==='membership'?n.name:undefined);this.groups.membership(b.connectionId,chat,present,watermark);};
  if(n.kind==='membership'&&n.disbanded){commit(()=>{this.store.run('INSERT OR IGNORE INTO feishu_group_disbanded VALUES(?,?,?)',b.connectionId,b.bindingVersion,chat);set(false);});finish('done');return'accepted';}
  // Fence outgoing work immediately on an authenticated removal while its current-state check is in flight.
  if(n.kind==='membership'&&!n.present)commit(()=>set(false));
  let present=state?.present!==0;
  try{
   if(n.kind==='membership'||!present){
   if(!b.conversation.isBotInGroup)throw new ChannelError('unsupported','membership_check_unsupported');
   present=await b.conversation.isBotInGroup({provider:'feishu',connectionId:b.connectionId,tenantId:b.connection.tenantId,kind:'conversation',externalId:chat,conversationKind:'group'});
   commit(()=>{
    // Activation uses this message's time, allowing the very same message into the window.
    set(present);
   });
   }
  }catch(error){
   commit(()=>{set(false,state?.present===0?state.changed_at:Math.max(at,state?.changed_at??0));this.store.run("UPDATE feishu_group_evidence SET attempts=attempts+1,reason=?,retry_at=? WHERE id=?",error instanceof ChannelError?'membership_'+error.code:'membership_verification_pending',this.now()+30000,id);});
   // Original normalized event remains in private runtime storage for recovery.
   if(error instanceof ChannelError&&error.message==='channel_ingress_generation_expired')throw error;
   return'accepted';
  }
  if(!present){finish('ignored','bot_not_in_group');return'ignored';}
  try{const result=n.kind==='membership'?'accepted':await apply();finish('done');return result;}
  catch(error){commit(()=>this.store.run("UPDATE feishu_group_evidence SET attempts=attempts+1,reason='message_admission_pending',retry_at=? WHERE id=?",this.now()+30000,id));throw error;}
 }
}
