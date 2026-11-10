import {identityDelta,withIdentityDelta,identityLookup,identityStore,identityScope} from '../employee-channels/wecom-identity-bindings.js';
import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import type {Store} from '../store.js';
import type {EmployeeChannelService} from '../employee-channels/service.js';
import type {EmployeeChannelRepository} from '../employee-channels/repository.js';
import type {EmployeeChannelRecord,WeComMemberChallenge} from '../employee-channels/types.js';

const fields=['identity','status','inboundVerified','identityEvidence','eventTenantId','botId','robotCode','previousInstallation','verification','validation','directoryStatus','lastError','wecomContactIdentityRevision','wecomVerifiedContactIds','wecomContactMappings','wecomMemberChallenges'] as const;
type Observation=Record<typeof fields[number],unknown>;
interface Report {wecomIdentityDelta?:true;reportId:string;connectionId:string;expected:{revision:number;authRevision:number;stateVersion:number};revisionDelta:0|1;observation:Observation|null;verificationEvents:string[]}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=4096&&!/[\u0000-\u001f]/.test(v);
const version=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
function observation(r:EmployeeChannelRecord):Observation{return Object.fromEntries(fields.map(k=>[k,k==='wecomVerifiedContactIds'||k==='wecomContactMappings'?(Object.getOwnPropertyDescriptor(r,k)?.value??null):r[k]??null])) as Observation;}
function matches(r:EmployeeChannelRecord,expected:Report['expected']){return r.revision===expected.revision&&r.authRevision===expected.authRevision&&r.stateVersion===expected.stateVersion;}
function valid(value:unknown):value is Report{
 if(!object(value)||Object.keys(value).some(k=>!['reportId','connectionId','expected','revisionDelta','observation','verificationEvents','wecomIdentityDelta'].includes(k))||!id(value['reportId'])||!id(value['connectionId'])||!object(value['expected'])||Object.keys(value['expected']).sort().join()!=='authRevision,revision,stateVersion'||!Object.values(value['expected']).every(version)||![0,1].includes(value['revisionDelta'] as number)||!Array.isArray(value['verificationEvents'])||value['verificationEvents'].length>100||value['verificationEvents'].some(v=>!id(v)||!/^event:|^message:/.test(v)))return false;
 if(value['wecomIdentityDelta']!==undefined&&value['wecomIdentityDelta']!==true)return false;
 const authRevision=value['expected']['authRevision'];
 const o=value['observation'];if(o===null)return value['revisionDelta']===0&&value['wecomIdentityDelta']===undefined;
 if(!object(o)||fields.some(k=>!['wecomContactIdentityRevision','wecomVerifiedContactIds','wecomContactMappings','wecomMemberChallenges'].includes(k)&&!(k in o))||Object.keys(o).some(k=>!(fields as readonly string[]).includes(k)))return false;
 if(value['wecomIdentityDelta']&&(o['wecomContactIdentityRevision']!==authRevision||!Array.isArray(o['wecomVerifiedContactIds'])||!Array.isArray(o['wecomContactMappings'])))return false;
 if(o['wecomContactIdentityRevision']!=null&&(!version(o['wecomContactIdentityRevision'])||o['wecomContactIdentityRevision']!==authRevision))return false;
 if(o['wecomVerifiedContactIds']!=null&&(!Array.isArray(o['wecomVerifiedContactIds'])||o['wecomVerifiedContactIds'].some(v=>!id(v)||v.length>256)||new Set(o['wecomVerifiedContactIds']).size!==o['wecomVerifiedContactIds'].length||o['wecomContactIdentityRevision']!==authRevision))return false;
 const maps=o['wecomContactMappings'];
 if(maps!=null&&(!Array.isArray(maps)||maps.some(m=>!object(m)||Object.keys(m).sort().join()!=='callbackUserId,method,requestId,userId,verifiedAt'||!id(m['userId'])||m['userId'].length>256||!id(m['callbackUserId'])||m['callbackUserId'].length>256||!id(m['requestId'])||!version(m['verifiedAt'])||m['method']!=='administrator_relay')||new Set(maps.map(m=>m['userId'])).size!==maps.length||new Set(maps.map(m=>m['callbackUserId'])).size!==maps.length||o['wecomContactIdentityRevision']!==authRevision))return false;
 const challenges=o['wecomMemberChallenges'];
 if(challenges!=null&&(!Array.isArray(challenges)||challenges.length>100||challenges.some(c=>!object(c)||Object.keys(c).some(k=>!['requestId','userId','authRevision','phraseHash','createdAt','expiresAt','status','issuedAt','completedAt','method','createdBy'].includes(k))||!id(c['requestId'])||!id(c['userId'])||String(c['userId']).length>256||c['authRevision']!==authRevision||typeof c['phraseHash']!=='string'||!/^[0-9a-f]{64}$/.test(c['phraseHash'])||!version(c['createdAt'])||!version(c['expiresAt'])||c['expiresAt']!==Number(c['createdAt'])+86400000||!['pending','verified','failed'].includes(String(c['status']))||!version(c['issuedAt'])||c['method']!=='administrator_relay'||!id(c['createdBy'])||c['completedAt']!==undefined&&!version(c['completedAt']))||new Set(challenges.map(c=>c['requestId'])).size!==challenges.length))return false;
 if(!object(o['identity'])||Object.keys(o['identity']).sort().join()!=='appId,tenantId,tenantIdNamespace'||!id(o['identity']['appId'])||!id(o['identity']['tenantId'])||!['tenant_key','display_id','corp_id','app_id'].includes(String(o['identity']['tenantIdNamespace']))||!['verified','pending_verification','invalid','disabled'].includes(String(o['status']))||![null,true,false].includes(o['inboundVerified'] as null|boolean)||!['available','unavailable'].includes(String(o['directoryStatus'])))return false;
 for(const k of ['eventTenantId','botId','robotCode','lastError'] as const)if(o[k]!==null&&!id(o[k]))return false;
 if(o['identityEvidence']!==null&&!['provider_api','authenticated_event_confirmed','authenticated_first_message','app_credentials_only','admin_asserted'].includes(String(o['identityEvidence'])))return false;
 if(o['previousInstallation']!==null&&(!object(o['previousInstallation'])||Object.keys(o['previousInstallation']).sort().join()!=='botId,tenantId'||!id(o['previousInstallation']['botId'])||!id(o['previousInstallation']['tenantId'])))return false;
 if(o['verification']!==null){const v=o['verification'];if(!object(v)||Object.keys(v).some(k=>!['challengeId','challengeText','expiresAt','candidate'].includes(k))||!id(v['challengeId'])||!id(v['challengeText'])||!version(v['expiresAt']))return false;if(v['candidate']!==undefined){const c=v['candidate'];if(!object(c)||Object.keys(c).some(k=>!['id','appId','botId','tenantId','robotCode','eventId','messageId'].includes(k))||!['id','appId','botId','tenantId','eventId','messageId'].every(k=>id(c[k]))||c['robotCode']!==undefined&&!id(c['robotCode']))return false;}}
 if(o['validation']!==null){const v=o['validation'];if(!object(v)||Object.keys(v).some(k=>!['version','provider','checkedAt','canContinue','checks'].includes(k))||v['version']!==1||!['feishu','dingtalk','wecom'].includes(String(v['provider']))||!version(v['checkedAt'])||typeof v['canContinue']!=='boolean'||!Array.isArray(v['checks'])||v['checks'].length>100)return false;const allowed=['id','required','supported','status','reason','httpStatus','providerCode','requestId','missingScopes','field','scopeDisclosure','scopeEvidence','scopeInventory','inventoryDiagnostics'];if(v['checks'].some(c=>!object(c)||Object.keys(c).some(k=>!allowed.includes(k))))return false;}
 return true;
}
function apply(old:EmployeeChannelRecord,report:Report):EmployeeChannelRecord{
 if(!report.observation)return old;
 const next={...old,revision:old.revision+report.revisionDelta};
 if(report.wecomIdentityDelta&&(old.provider!=='wecom'||old.authRevision!==report.expected.authRevision||old.wecomContactIdentityRevision!==undefined&&old.wecomContactIdentityRevision!==old.authRevision))throw Error('channel_observation_invalid');
 for(const field of fields){if(!(field in report.observation))continue;const value=report.observation[field];if(value===null&&field!=='lastError')delete (next as unknown as Record<string,unknown>)[field];else(next as unknown as Record<string,unknown>)[field]=structuredClone(value);}
 if(report.wecomIdentityDelta){
  const exact=(report.observation.wecomVerifiedContactIds??[]) as string[],maps=(report.observation.wecomContactMappings??[]) as NonNullable<EmployeeChannelRecord['wecomContactMappings']>;
  const additions=new Map<string,string>(),reverse=new Map<string,string>();
  for(const m of [...exact.map(userId=>({userId,callbackUserId:userId})),...maps]){
   const byUser=identityLookup(old,'user_id',m.userId),byCallback=identityLookup(old,'callback_user_id',m.callbackUserId);
   if(byUser&&byUser.callback_user_id!==m.callbackUserId||byCallback&&byCallback.user_id!==m.userId||additions.has(m.userId)&&additions.get(m.userId)!==m.callbackUserId||reverse.has(m.callbackUserId)&&reverse.get(m.callbackUserId)!==m.userId)throw Error('channel_observation_conflict');
   additions.set(m.userId,m.callbackUserId);reverse.set(m.callbackUserId,m.userId);
  }
  delete next.wecomVerifiedContactIds;delete next.wecomContactMappings;
  withIdentityDelta(next,{exact,maps});
 }
 if(next.identity.appId!==old.appId)throw Error('channel_observation_invalid');
 // Only operational downgrades may update a disabled configuration.
 if(!old.enabled&&next.status!=='disabled')throw Error('channel_observation_invalid');
 return next;
}
/** Merge only monotonic WeCom identity facts after a same-configuration CAS race.
 * Challenge issuance stays platform-owned; no source, credential, lifecycle or ordinary
 * observation can be rebased by this path. A verified reply must name the exact issued nonce. */
function mergeWeComIdentity(old:EmployeeChannelRecord,report:Report,retains:(c:WeComMemberChallenge)=>boolean):EmployeeChannelRecord|undefined{
 if(old.provider!=='wecom'||old.status!=='verified'||!old.enabled||old.revision!==report.expected.revision||old.authRevision!==report.expected.authRevision||report.revisionDelta!==0)return;
 if(!report.observation)return old;
 const incoming=apply(old,report),identityFields=new Set(['wecomContactIdentityRevision','wecomVerifiedContactIds','wecomContactMappings','wecomMemberChallenges']);
 for(const field of fields)if(!identityFields.has(field)&&JSON.stringify(incoming[field]??null)!==JSON.stringify(old[field]??null))return;
 const challenges=[...(old.wecomMemberChallenges??[])];
 for(const fact of incoming.wecomMemberChallenges??[]){
  const index=challenges.findIndex(c=>c.requestId===fact.requestId),issued=challenges[index];
  // Issuance may prune expired history while this runtime still has the prior
  // snapshot. Ignore only out-of-window facts; they cannot authorize any new
  // mapping below. An unknown active/protected challenge remains a conflict.
  if(!issued){if(!retains(fact))continue;return;}
  if(JSON.stringify(fact)===JSON.stringify(issued))continue;
  for(const field of ['requestId','userId','authRevision','phraseHash','createdAt','expiresAt','issuedAt','method','createdBy'] as const)if(fact[field]!==issued[field])return;
  if(fact.status==='verified'||fact.status==='failed'){
   if(fact.completedAt===undefined||issued.issuedAt===undefined||fact.completedAt<issued.issuedAt||fact.completedAt>issued.expiresAt)return;
   if(issued.status==='failed'&&fact.status==='verified')return;
   if(issued.status!=='verified'&&issued.status!=='failed')challenges[index]=fact;
  }
 }
 const delta=identityDelta(incoming);
 if(delta){
  for(const mapping of delta.maps){
   const existing=identityLookup(old,'user_id',mapping.userId);
   if(existing){if(existing.mapping_json!==JSON.stringify(mapping))return;continue;}
   const challenge=challenges.find(c=>c.requestId===mapping.requestId&&c.userId===mapping.userId&&c.status==='verified'&&c.completedAt===mapping.verifiedAt&&c.authRevision===old.authRevision);if(!challenge)return;
  }
  return withIdentityDelta({...old,wecomContactIdentityRevision:old.authRevision,wecomMemberChallenges:challenges},delta);
 }
 // Legacy non-delta operational reports cannot modify relationship evidence.
 if(report.observation.wecomVerifiedContactIds!=null||report.observation.wecomContactMappings!=null)return;
 return {...old,wecomMemberChallenges:challenges};
}
function auth(header:string|undefined,token:string){const a=Buffer.from(header??''),b=Buffer.from('Bearer '+token);return !!token&&a.length===b.length&&timingSafeEqual(a,b);}
export function registerChannelObservationApi(server:FastifyInstance,options:{token:string;channels:EmployeeChannelService;store:Store}):void{
 options.store.db.exec('CREATE TABLE IF NOT EXISTS channel_observation_receipts(id TEXT PRIMARY KEY,body_digest TEXT NOT NULL,response_json TEXT NOT NULL)');
 server.post('/internal/config/wecom-member-confirmed',(request,reply)=>{reply.header('cache-control','no-store');if(!auth(request.headers.authorization,options.token))return reply.code(401).send({error:'configuration_unauthorized'});const b=request.body;if(!object(b)||Object.keys(b).sort().join()!=='authRevision,callbackUserId,connectionId,requestId,sourceId'||!['callbackUserId','connectionId','requestId','sourceId'].every(k=>id(b[k]))||!version(b['authRevision']))return reply.code(400).send({error:'invalid_member_verification_request'});const r=options.channels.repository.byId(b['connectionId'] as string);return{confirmed:!!r&&r.enabled&&r.status==='verified'&&r.sourceId===b['sourceId']&&r.authRevision===b['authRevision']&&r.wecomContactIdentityRevision===r.authRevision&&JSON.parse(identityLookup(r,'callback_user_id',b['callbackUserId'] as string)?.mapping_json??'null')?.requestId===b['requestId']};});
 server.post('/internal/config/channel-observation',{bodyLimit:524288},(request,reply)=>{
  reply.header('cache-control','no-store');
  if(!auth(request.headers.authorization,options.token))return reply.code(401).send({error:'configuration_unauthorized'});
  if(!valid(request.body))return reply.code(400).send({error:'channel_observation_invalid'});
  const report=request.body;
  try{return options.store.transaction(()=>{
   const receipt=options.store.one<{body_digest:string;response_json:string}>('SELECT body_digest,response_json FROM channel_observation_receipts WHERE id=?',report.reportId),hash=digest(report);
   if(receipt){if(receipt.body_digest!==hash)throw Error('channel_observation_conflict');return JSON.parse(receipt.response_json) as unknown;}
   const old=options.channels.repository.byId(report.connectionId);if(!old)throw Error('channel_observation_conflict');
   const next=matches(old,report.expected)?apply(old,report):mergeWeComIdentity(old,report,c=>options.channels.memberVerification.retains(c));if(!next)throw Error('channel_observation_conflict');
   if(report.observation&&!options.channels.repository.save(next,old))throw Error('channel_observation_conflict');
   for(const key of report.verificationEvents)options.store.run('INSERT OR IGNORE INTO employee_channel_verification_events(connection_id,event_id) VALUES(?,?)',old.id,key);
   const result={accepted:true,reportId:report.reportId,revision:next.revision,authRevision:next.authRevision,stateVersion:next.stateVersion};
   options.store.run('INSERT INTO channel_observation_receipts(id,body_digest,response_json) VALUES(?,?,?)',report.reportId,hash,JSON.stringify(result));
   options.channels.notifyCommitted(old.id);return result;
  });}catch(error){return reply.code(error instanceof Error&&error.message==='channel_observation_invalid'?400:409).send({error:'channel_observation_conflict'});}
 });
}
interface QueueRow{id:string;body_json:string;status:'pending'|'accepted'|'conflict'}
export function installChannelObservationReporter(store:Store,repository:EmployeeChannelRepository,options:{url:string;token:string;fetch?:typeof fetch;now?:()=>number;intervalMs?:number}){
 const url=new URL(options.url);if(!['https:','http:'].includes(url.protocol)||url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||!options.token||!Number.isSafeInteger(options.intervalMs??1000)||(options.intervalMs??1000)<1)throw Error('channel_observation_options_invalid');
 store.db.exec("CREATE TABLE IF NOT EXISTS channel_state_reports(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,connection_id TEXT NOT NULL,body_json TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','accepted','conflict')),created_at INTEGER NOT NULL);CREATE INDEX IF NOT EXISTS channel_state_report_pending ON channel_state_reports(status,sequence)");
 const originalSave=repository.save,originalMark=repository.markVerificationEvent;let replaying=false,stopped=false,timer:ReturnType<typeof setInterval>|undefined,flight:Promise<void>|undefined,controller:AbortController|undefined;
 function enqueue(report:Report){if(!valid(report))throw Error('channel_observation_invalid');store.run("INSERT INTO channel_state_reports(id,connection_id,body_json,status,created_at) VALUES(?,?,?,'pending',?)",report.reportId,report.connectionId,JSON.stringify(report),(options.now??Date.now)());}
 repository.save=function(record,previous){return store.transaction(()=>{
  if(replaying)return originalSave.call(this,record,previous);
  if(!previous)throw Error('runtime_channel_configuration_readonly');
  const delta=record.revision-previous.revision;
  if(record.sourceId!==previous.sourceId||record.authRevision!==previous.authRevision||record.enabled!==previous.enabled||record.appId!==previous.appId||record.provider!==previous.provider||record.id!==previous.id||record.workspaceId!==previous.workspaceId||record.entityId!==previous.entityId||JSON.stringify(record.credential)!==JSON.stringify(previous.credential)||JSON.stringify(record.context)!==JSON.stringify(previous.context))throw Error('runtime_channel_configuration_readonly');
  const report:Report={reportId:randomUUID(),connectionId:record.id,expected:{revision:previous.revision,authRevision:previous.authRevision,stateVersion:previous.stateVersion},revisionDelta:delta as 0|1,observation:observation(record),verificationEvents:[]};
  // Identity facts are append-only in the runtime. Send only additions; challenge
  // history remains bounded and is still reported for nonce/CAS verification.
  if(record.provider==='wecom'&&record.wecomContactIdentityRevision===record.authRevision){
   let delta=identityDelta(record);
   if(!delta){
    // Explicit array writes are used only by controlled imports/tests; runtime
    // verification produces a small delta directly, without enumerating bindings.
    const ids=Object.getOwnPropertyDescriptor(record,'wecomVerifiedContactIds'),maps=Object.getOwnPropertyDescriptor(record,'wecomContactMappings');
    const exact=ids&&'value'in ids?record.wecomVerifiedContactIds??[]:[],addedMaps=maps&&'value'in maps?record.wecomContactMappings??[]:[];
    if(ids&&'value'in ids&&identityStore(previous)!.one<{n:number}>('SELECT count(*) n FROM wecom_identity_bindings WHERE connection_id=? AND source_id=? AND auth_revision=? AND mapping_json IS NULL',...identityScope(previous))!.n>exact.length||maps&&'value'in maps&&identityStore(previous)!.one<{n:number}>('SELECT count(*) n FROM wecom_identity_bindings WHERE connection_id=? AND source_id=? AND auth_revision=? AND mapping_json IS NOT NULL',...identityScope(previous))!.n>addedMaps.length)throw Error('runtime_channel_identity_not_monotonic');
    for(const mapping of addedMaps){const old=identityLookup(previous,'user_id',mapping.userId);if(old&&old.mapping_json!==JSON.stringify(mapping))throw Error('runtime_channel_identity_not_monotonic');}
    delta={exact:exact.filter(id=>!identityLookup(previous,'user_id',id)),maps:addedMaps.filter(m=>!identityLookup(previous,'user_id',m.userId))};
   }
   report.wecomIdentityDelta=true;
   report.observation!.wecomVerifiedContactIds=delta.exact;
   report.observation!.wecomContactMappings=delta.maps;
  }
  if(record.sourceId!==previous.sourceId||record.authRevision!==previous.authRevision||record.enabled!==previous.enabled||record.appId!==previous.appId||JSON.stringify(record.context)!==JSON.stringify(previous.context)||!valid(report))throw Error('runtime_channel_configuration_readonly');
  const saved=originalSave.call(this,record,previous);if(saved)enqueue(report);return saved;
 });};
 repository.markVerificationEvent=function(connectionId,eventId,messageId){return store.transaction(()=>{
  originalMark.call(this,connectionId,eventId,messageId);if(replaying)return;
  const record=this.byId(connectionId);if(record)enqueue({reportId:randomUUID(),connectionId,expected:{revision:record.revision,authRevision:record.authRevision,stateVersion:record.stateVersion},revisionDelta:0,observation:null,verificationEvents:['event:'+eventId,'message:'+messageId]});
 });};
 async function flush(){if(stopped)return;if(flight)return flight;const run=(async()=>{
  const rows=store.all<QueueRow>("SELECT id,body_json,status FROM channel_state_reports WHERE status='pending' ORDER BY sequence LIMIT 50"),blocked=new Set<string>();
  for(const row of rows){if(stopped)break;const connectionId=(JSON.parse(row.body_json) as Report).connectionId;if(blocked.has(connectionId))continue;controller=new AbortController();try{
   const response=await(options.fetch??fetch)(url.href.replace(/\/$/,'')+'/internal/config/channel-observation',{method:'POST',headers:{authorization:'Bearer '+options.token,'content-type':'application/json'},body:row.body_json,redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10000)])});
   if(response.ok){const result:unknown=await response.json();if(!object(result)||result['accepted']!==true||result['reportId']!==row.id)break;store.run("UPDATE channel_state_reports SET status='accepted' WHERE id=?",row.id);}
   else if(response.status===409||response.status===400){blocked.add(connectionId);store.run("UPDATE channel_state_reports SET status='conflict' WHERE connection_id=? AND status='pending'",connectionId);}
   else break;
  }catch{break;}finally{controller=undefined;}}
 })();flight=run;try{await run;}finally{if(flight===run)flight=undefined;}}
 function reconcile(){replaying=true;const baseline=new Map<string,EmployeeChannelRecord|undefined>();try{store.transaction(()=>{for(const row of store.all<QueueRow>("SELECT id,body_json,status FROM channel_state_reports WHERE status<>'conflict' ORDER BY sequence")){
  const report=JSON.parse(row.body_json) as Report;
  if(!baseline.has(report.connectionId))baseline.set(report.connectionId,repository.byId(report.connectionId));
  const current=repository.byId(report.connectionId),source=baseline.get(report.connectionId);
  if(!current){if(row.status==='accepted')store.run('DELETE FROM channel_state_reports WHERE id=?',row.id);continue;}
  const nextVersion=report.expected.stateVersion+(report.observation?1:0);
  if(row.status==='accepted'&&source&&(source.authRevision!==report.expected.authRevision||source.stateVersion>=nextVersion&&(report.observation!==null||report.verificationEvents.every(key=>!!store.one('SELECT 1 FROM employee_channel_verification_events WHERE connection_id=? AND event_id=?',current.id,key))))){store.run('DELETE FROM channel_state_reports WHERE id=?',row.id);continue;}
  if(matches(current,report.expected)){if(report.observation)originalSave.call(repository,apply(current,report),current);for(const key of report.verificationEvents)store.run('INSERT OR IGNORE INTO employee_channel_verification_events(connection_id,event_id) VALUES(?,?)',current.id,key);}
 } });}finally{replaying=false;}}
 return{flush,reconcile,start(){if(timer||stopped)return;void flush().catch(()=>{});timer=setInterval(()=>{void flush().catch(()=>{});},options.intervalMs??1000);timer.unref();},async close(){stopped=true;if(timer)clearInterval(timer);controller?.abort();await flight;repository.save=originalSave;repository.markVerificationEvent=originalMark;},status(){return store.all<{status:string;count:number}>('SELECT status,count(*) count FROM channel_state_reports GROUP BY status');}};
}
