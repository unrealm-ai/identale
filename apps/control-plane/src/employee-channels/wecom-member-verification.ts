import {createHmac,randomInt} from 'node:crypto';
import type {EmployeeChannelRepository} from './repository.js';
import type {EmployeeChannelRecord,WeComMemberChallenge} from './types.js';
import type {DirectoryCredentialVault} from '../directory/secrets.js';
import {usesWeComBotSearch,weComCallbackUserId,weComSearchUserId,weComVerifiedUserIds} from './wecom-bot-contacts.js';

const lifetime=24*60*60_000,retention=3*lifetime;
export const weComMemberCodeCandidates=(text:string)=>text.match(/(?<![0-9])[0-9]{6}(?![0-9])/g)??[];
export function weComMemberCodeHash(secret:string,r:Pick<EmployeeChannelRecord,'id'|'sourceId'|'authRevision'>,code:string){const key=createHmac('sha256',secret).update('identale-member-code-hmac-key-v1').digest();return createHmac('sha256',key).update(JSON.stringify([r.id,r.sourceId,r.authRevision,code])).digest('hex');}
const active=(c:WeComMemberChallenge,now:number)=>c.expiresAt>now&&c.status==='pending';
/** First invalidation wins: natural expiry needs no scheduler or database write. */
const retiredAt=(c:WeComMemberChallenge)=>c.status==='pending'?c.expiresAt:Math.min(c.completedAt??c.expiresAt,c.expiresAt);
const retained=(c:WeComMemberChallenge,now:number)=>active(c,now)||now<retiredAt(c)+retention;
export class WeComMemberVerificationError extends Error {constructor(readonly status:number,readonly code:string){super(code);}}
const fail=(status:number,code:string):never=>{throw new WeComMemberVerificationError(status,code);};
type Crypto={secret(r:EmployeeChannelRecord):string;vault:DirectoryCredentialVault;collisionKey?:Uint8Array};
export type MemberVerificationResult='verified'|'used'|'expired'|'revoked'|'invalid'|'ordinary'|'ignored';
/** A manager relays the code to the selected person. Possession is administrator
 * attestation, not an independent provider identity join. Clear codes stay encrypted
 * in the platform database; runtime configuration receives only scoped keyed digests. */
export class WeComMemberVerification {
 constructor(private readonly repository:EmployeeChannelRepository,private readonly now:()=>number,private readonly crypto?:Crypto){repository.store.db.exec(`
 CREATE TABLE IF NOT EXISTS wecom_member_verification_requests(connection_id TEXT NOT NULL,source_id TEXT NOT NULL,auth_revision INTEGER NOT NULL,request_id TEXT NOT NULL,user_id TEXT NOT NULL,created_at INTEGER NOT NULL,app_id TEXT NOT NULL,code_hash TEXT,collision_hash TEXT,sealed_code TEXT,issued_request_id TEXT NOT NULL,PRIMARY KEY(connection_id,source_id,auth_revision,request_id),UNIQUE(collision_hash));`);}
 remove(connectionId:string){this.repository.store.run('UPDATE wecom_member_verification_requests SET sealed_code=NULL WHERE connection_id=?',connectionId);}
 private current(before:EmployeeChannelRecord){const r=this.repository.byId(before.id);if(!r||!r.enabled||r.status!=='verified'||r.sourceId!==before.sourceId||r.authRevision!==before.authRevision||r.revision!==before.revision||!usesWeComBotSearch(r))return fail(409,'channel_configuration_changed');return r;}
 private save(current:EmployeeChannelRecord,next:EmployeeChannelRecord,actor:string,action:string){this.repository.store.transaction(()=>{if(!this.repository.save(next,current))fail(409,'channel_configuration_changed');this.repository.audit(next,actor,action,this.now());});}
 private hash(r:EmployeeChannelRecord,code:string){if(!this.crypto)fail(503,'member_verification_unavailable');return weComMemberCodeHash(this.crypto!.secret(r),r,code);}
 private scope(r:EmployeeChannelRecord,id:string){return ['member-code-v1',r.id,r.sourceId,r.authRevision,id];}
 private code(r:EmployeeChannelRecord,c:WeComMemberChallenge){const row=this.repository.store.one<{sealed_code:string|null}>('SELECT sealed_code FROM wecom_member_verification_requests WHERE connection_id=? AND source_id=? AND auth_revision=? AND request_id=?',r.id,r.sourceId,r.authRevision,c.requestId);if(!row?.sealed_code||!this.crypto)return;try{return this.crypto.vault.open(JSON.parse(row.sealed_code),this.scope(r,c.requestId));}catch{return;}}
 status(r:EmployeeChannelRecord,userId:string){
  if(weComCallbackUserId(r,userId))return {userId,status:'verified' as const};
  const c=r.wecomMemberChallenges?.filter(c=>c.userId===userId&&c.authRevision===r.authRevision).at(-1);
  if(!c)return {userId,status:'unverified' as const};
  const status=c.status==='verified'?'failed' as const:c.expiresAt<=this.now()?'expired' as const:c.status;
  return {userId,status,expiresAt:c.expiresAt,...(status==='pending'?{phrase:this.code(r,c)}:{})};
 }
 ready(r:EmployeeChannelRecord,requestId:string){const c=r.wecomMemberChallenges?.find(c=>c.requestId===requestId&&c.authRevision===r.authRevision);return !!c&&r.enabled&&r.status==='verified'&&active(c,this.now());}
 retains(challenge:WeComMemberChallenge){return retained(challenge,this.now());}
 async start(before:EmployeeChannelRecord,userId:string,requestId:string,actor:string,io:{ready(record:EmployeeChannelRecord,requestId:string):Promise<boolean>},replace=false){
  let r=this.current(before);if(weComCallbackUserId(r,userId))return this.status(r,userId);
  const previous=this.repository.store.one<{user_id:string}>('SELECT user_id FROM wecom_member_verification_requests WHERE connection_id=? AND source_id=? AND auth_revision=? AND request_id=?',r.id,r.sourceId,r.authRevision,requestId);
  if(previous){if(previous.user_id!==userId)fail(409,'member_verification_request_conflict');return this.status(r,userId);}
  const pending=r.wecomMemberChallenges?.find(c=>c.userId===userId&&c.authRevision===r.authRevision&&active(c,this.now())&&!!this.repository.store.one('SELECT 1 FROM wecom_member_verification_requests WHERE connection_id=? AND source_id=? AND auth_revision=? AND request_id=?',r.id,r.sourceId,r.authRevision,c.requestId));
  if(pending&&!replace){this.repository.store.run('INSERT INTO wecom_member_verification_requests VALUES(?,?,?,?,?,?,?,NULL,NULL,NULL,?)',r.id,r.sourceId,r.authRevision,requestId,userId,this.now(),r.appId,pending.requestId);return this.status(r,userId);}
  if(weComVerifiedUserIds(r).length>=500)fail(409,'member_verification_limit');
  const now=this.now(),history=(r.wecomMemberChallenges??[]).filter(c=>c.authRevision===r.authRevision&&retained(c,now));
  // Configuration capacity limits, not guess budgets: ordinary messages never
  // reserve attempts or trigger cooldowns. Never evict still-protected old codes.
  if(history.length>=100||history.filter(c=>c.userId!==userId&&active(c,now)).length>=10)fail(429,'member_verification_limit');
  if(!this.crypto?.collisionKey)fail(503,'member_verification_unavailable');
  let phrase='';
  this.repository.store.transaction(()=>{
   // No permanent code-space reservation. Keep a conservative four-day issuance
   // window across bots/scopes, covering 24h validity plus every possible 3d old
   // code window. It may outlast early consumption by at most 24h. Idempotency
   // metadata survives; only expired code material/digests are released.
   this.repository.store.run('UPDATE wecom_member_verification_requests SET collision_hash=NULL,code_hash=NULL,sealed_code=NULL WHERE created_at<=? AND collision_hash IS NOT NULL',now-lifetime-retention);
   let collision='';for(let attempt=0;attempt<32;attempt++){
    phrase=String(randomInt(1_000_000)).padStart(6,'0');collision=createHmac('sha256',this.crypto!.collisionKey!).update(JSON.stringify(['member-code-collision-v1',phrase])).digest('hex');
    if(!this.repository.store.one('SELECT 1 FROM wecom_member_verification_requests WHERE collision_hash=?',collision))break;phrase='';
   }
   if(!phrase)fail(503,'member_verification_limit');
   const challenge:WeComMemberChallenge={requestId,userId,authRevision:r.authRevision,phraseHash:this.hash(r,phrase),createdAt:now,expiresAt:now+lifetime,issuedAt:now,status:'pending',method:'administrator_relay',createdBy:actor};
   this.save(r,{...r,wecomMemberChallenges:[...history.map(c=>c.userId===userId&&active(c,now)?{...c,status:'failed' as const,completedAt:now}:c),challenge]},actor,'member_verification_code_created');
   this.repository.store.run('INSERT INTO wecom_member_verification_requests VALUES(?,?,?,?,?,?,?,?,?,?,?)',r.id,r.sourceId,r.authRevision,requestId,userId,now,r.appId,challenge.phraseHash,collision,null,requestId);
  });
  try{r=this.current(before);if(!await io.ready(r,requestId))fail(409,'member_verification_receiver_not_ready');r=this.current(before);if(!r.wecomMemberChallenges?.some(c=>c.requestId===requestId&&active(c,this.now())))fail(409,'member_verification_expired');this.repository.store.run('UPDATE wecom_member_verification_requests SET sealed_code=? WHERE connection_id=? AND source_id=? AND auth_revision=? AND request_id=?',JSON.stringify(this.crypto!.vault.seal(phrase,this.scope(r,requestId))),r.id,r.sourceId,r.authRevision,requestId);return this.status(r,userId);}
  catch(error){try{r=this.current(before);if(r.wecomMemberChallenges?.some(c=>c.requestId===requestId&&active(c,this.now())))this.save(r,{...r,wecomMemberChallenges:r.wecomMemberChallenges!.map(c=>c.requestId===requestId?{...c,status:'failed' as const,completedAt:this.now()}:c)},actor,'member_verification_code_unavailable');}catch{}throw error;}
 }
 private match(r:EmployeeChannelRecord,text:string):WeComMemberChallenge|undefined{
  const codes=weComMemberCodeCandidates(text);if(codes.length!==1)return;
  const now=this.now(),hash=this.hash(r,codes[0]!),matches=(r.wecomMemberChallenges??[]).filter(c=>c.authRevision===r.authRevision&&c.method==='administrator_relay'&&c.phraseHash===hash);
  return matches.find(c=>active(c,now))??matches.find(c=>retained(c,now));
 }
 /** Only one known candidate in an unquoted plain private message is control.
  * Words such as “验证码”, unknown values, multiple candidates and other message
  * forms are ordinary traffic, subject to the normal channel permission checks. */
 isControl(r:EmployeeChannelRecord,envelope:unknown):boolean{
  const body=(envelope as {body?:Record<string,unknown>}|null)?.body;
  if(!body||body.chattype!=='single'||body.msgtype!=='text'||['quote','mixed','image','file','voice'].some(k=>body[k]!==undefined))return false;
  const text=(body.text as {content?:unknown}|undefined)?.content;
  return typeof text==='string'&&!!this.match(r,text);
 }
 accept(before:EmployeeChannelRecord,input:{text:string;callbackUserId:string;eventId:string;messageId:string;privateMessage:boolean}):MemberVerificationResult{
  if(!input.privateMessage)return'ordinary';
  if(this.repository.verificationEvent(before.id,input.eventId,input.messageId))return'ignored';
  let r=this.current(before);const challenge=this.match(r,input.text);if(!challenge)return'ordinary';
  this.repository.markVerificationEvent(r.id,input.eventId,input.messageId);
  const completedAt=this.now();
  if(!active(challenge,completedAt))return challenge.completedAt===undefined||challenge.completedAt>=challenge.expiresAt?'expired':challenge.status==='verified'?'used':'revoked';
  const bySearch=weComCallbackUserId(r,challenge.userId),byCallback=weComSearchUserId(r,input.callbackUserId),conflict=(bySearch!==undefined&&bySearch!==input.callbackUserId)||(byCallback!==undefined&&byCallback!==challenge.userId)||weComVerifiedUserIds(r).length>=500;
  const next:EmployeeChannelRecord={...r,wecomMemberChallenges:r.wecomMemberChallenges!.map(c=>c.requestId===challenge.requestId?{...c,status:conflict?'failed':'verified',completedAt}:c),...(!conflict?{wecomContactIdentityRevision:r.authRevision,wecomContactMappings:[...(r.wecomContactIdentityRevision===r.authRevision?r.wecomContactMappings??[]:[]).filter(m=>m.userId!==challenge.userId),{userId:challenge.userId,callbackUserId:input.callbackUserId,verifiedAt:completedAt,requestId:challenge.requestId,method:'administrator_relay' as const}]}:{})};
  try{this.save(r,next,'authenticated-ingress',conflict?'member_verification_conflict':'member_verification_admin_relay_confirmed');return conflict?'invalid':'verified';}catch{return'invalid';}
 }
}
