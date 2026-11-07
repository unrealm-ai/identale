import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import type {Store} from '../store.js';
import type {EmployeeChannelService} from '../employee-channels/service.js';
import type {EmployeeChannelRepository} from '../employee-channels/repository.js';
import type {EmployeeChannelRecord} from '../employee-channels/types.js';

const fields=['identity','status','inboundVerified','identityEvidence','eventTenantId','botId','robotCode','previousInstallation','verification','validation','directoryStatus','lastError'] as const;
type Observation=Record<typeof fields[number],unknown>;
interface Report {reportId:string;connectionId:string;expected:{revision:number;authRevision:number;stateVersion:number};revisionDelta:0|1;observation:Observation|null;invalidation?:{sourceId:string;directoryBinding:EmployeeChannelRecord['directoryBinding']};verificationEvents:string[]}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=4096&&!/[\u0000-\u001f]/.test(v);
const version=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
function observation(r:EmployeeChannelRecord):Observation{return Object.fromEntries(fields.map(k=>[k,r[k]??null])) as Observation;}
function matches(r:EmployeeChannelRecord,expected:Report['expected']){return r.revision===expected.revision&&r.authRevision===expected.authRevision&&r.stateVersion===expected.stateVersion;}
function valid(value:unknown):value is Report{
 if(!object(value)||Object.keys(value).some(k=>!['reportId','connectionId','expected','revisionDelta','observation','invalidation','verificationEvents'].includes(k))||!id(value['reportId'])||!id(value['connectionId'])||!object(value['expected'])||Object.keys(value['expected']).sort().join()!=='authRevision,revision,stateVersion'||!Object.values(value['expected']).every(version)||![0,1].includes(value['revisionDelta'] as number)||!Array.isArray(value['verificationEvents'])||value['verificationEvents'].length>100||value['verificationEvents'].some(v=>!id(v)||!/^event:|^message:/.test(v)))return false;
 const o=value['observation'];if(o===null)return value['revisionDelta']===0&&value['invalidation']===undefined;
 if(!object(o)||Object.keys(o).length!==fields.length||fields.some(k=>!(k in o))||Object.keys(o).some(k=>!(fields as readonly string[]).includes(k)))return false;
 if(!object(o['identity'])||Object.keys(o['identity']).sort().join()!=='appId,tenantId,tenantIdNamespace'||!id(o['identity']['appId'])||!id(o['identity']['tenantId'])||!['tenant_key','display_id','corp_id','app_id'].includes(String(o['identity']['tenantIdNamespace']))||!['verified','pending_verification','invalid','disabled'].includes(String(o['status']))||![null,true,false].includes(o['inboundVerified'] as null|boolean)||!['available','unavailable'].includes(String(o['directoryStatus'])))return false;
 for(const k of ['eventTenantId','botId','robotCode','lastError'] as const)if(o[k]!==null&&!id(o[k]))return false;
 if(o['identityEvidence']!==null&&!['provider_api','authenticated_event_confirmed','app_credentials_only','admin_asserted'].includes(String(o['identityEvidence'])))return false;
 if(o['previousInstallation']!==null&&(!object(o['previousInstallation'])||Object.keys(o['previousInstallation']).sort().join()!=='botId,tenantId'||!id(o['previousInstallation']['botId'])||!id(o['previousInstallation']['tenantId'])))return false;
 if(o['verification']!==null){const v=o['verification'];if(!object(v)||Object.keys(v).some(k=>!['challengeId','challengeText','expiresAt','candidate'].includes(k))||!id(v['challengeId'])||!id(v['challengeText'])||!version(v['expiresAt']))return false;if(v['candidate']!==undefined){const c=v['candidate'];if(!object(c)||Object.keys(c).some(k=>!['id','appId','botId','tenantId','robotCode','eventId','messageId'].includes(k))||!['id','appId','botId','tenantId','eventId','messageId'].every(k=>id(c[k]))||c['robotCode']!==undefined&&!id(c['robotCode']))return false;}}
 if(o['validation']!==null){const v=o['validation'];if(!object(v)||Object.keys(v).some(k=>!['version','provider','checkedAt','canContinue','checks'].includes(k))||v['version']!==1||!['feishu','dingtalk','wecom'].includes(String(v['provider']))||!version(v['checkedAt'])||typeof v['canContinue']!=='boolean'||!Array.isArray(v['checks'])||v['checks'].length>100)return false;const allowed=['id','required','supported','status','reason','httpStatus','providerCode','requestId','missingScopes','field','scopeDisclosure','scopeEvidence','scopeInventory','inventoryDiagnostics'];if(v['checks'].some(c=>!object(c)||Object.keys(c).some(k=>!allowed.includes(k))))return false;}
 if(value['invalidation']!==undefined){const i=value['invalidation'];if(!object(i)||Object.keys(i).sort().join()!=='directoryBinding,sourceId'||!id(i['sourceId'])||!object(i['directoryBinding'])||i['directoryBinding']['status']!=='reconfirmation_required'||value['revisionDelta']!==1||o['directoryStatus']!=='unavailable')return false;}
 return true;
}
function apply(old:EmployeeChannelRecord,report:Report):EmployeeChannelRecord{
 if(!report.observation)return old;
 const next={...old,revision:old.revision+report.revisionDelta};
 for(const field of fields){const value=report.observation[field];if(value===null&&field!=='lastError')delete (next as unknown as Record<string,unknown>)[field];else(next as unknown as Record<string,unknown>)[field]=structuredClone(value);}
 if(next.identity.appId!==old.appId)throw Error('channel_observation_invalid');
 if(report.invalidation){const before=old.directoryBinding,after=report.invalidation.directoryBinding;if(!before||!after||after.sourceRevision!==before.sourceRevision+1||JSON.stringify({...after,status:before.status,sourceRevision:before.sourceRevision})!==JSON.stringify(before))throw Error('channel_observation_invalid');next.sourceId=report.invalidation.sourceId;next.directoryBinding=structuredClone(after);}
 // Only operational downgrades may update a disabled configuration.
 if(!old.enabled&&next.status!=='disabled')throw Error('channel_observation_invalid');
 return next;
}
function auth(header:string|undefined,token:string){const a=Buffer.from(header??''),b=Buffer.from('Bearer '+token);return !!token&&a.length===b.length&&timingSafeEqual(a,b);}
export function registerChannelObservationApi(server:FastifyInstance,options:{token:string;channels:EmployeeChannelService;store:Store}):void{
 options.store.db.exec('CREATE TABLE IF NOT EXISTS channel_observation_receipts(id TEXT PRIMARY KEY,body_digest TEXT NOT NULL,response_json TEXT NOT NULL)');
 server.post('/internal/config/channel-observation',{bodyLimit:131072},(request,reply)=>{
  reply.header('cache-control','no-store');
  if(!auth(request.headers.authorization,options.token))return reply.code(401).send({error:'configuration_unauthorized'});
  if(!valid(request.body))return reply.code(400).send({error:'channel_observation_invalid'});
  const report=request.body;
  try{return options.store.transaction(()=>{
   const receipt=options.store.one<{body_digest:string;response_json:string}>('SELECT body_digest,response_json FROM channel_observation_receipts WHERE id=?',report.reportId),hash=digest(report);
   if(receipt){if(receipt.body_digest!==hash)throw Error('channel_observation_conflict');return JSON.parse(receipt.response_json) as unknown;}
   const old=options.channels.repository.byId(report.connectionId);if(!old||!matches(old,report.expected))throw Error('channel_observation_conflict');
   const next=apply(old,report);
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
  if(record.authRevision!==previous.authRevision||record.enabled!==previous.enabled||record.appId!==previous.appId||record.provider!==previous.provider||record.id!==previous.id||record.workspaceId!==previous.workspaceId||record.entityId!==previous.entityId||JSON.stringify(record.credential)!==JSON.stringify(previous.credential)||JSON.stringify(record.context)!==JSON.stringify(previous.context))throw Error('runtime_channel_configuration_readonly');
  const report:Report={reportId:randomUUID(),connectionId:record.id,expected:{revision:previous.revision,authRevision:previous.authRevision,stateVersion:previous.stateVersion},revisionDelta:delta as 0|1,observation:observation(record),verificationEvents:[],...(record.sourceId!==previous.sourceId||JSON.stringify(record.directoryBinding)!==JSON.stringify(previous.directoryBinding)?{invalidation:{sourceId:record.sourceId,directoryBinding:record.directoryBinding}}:{})};
  if(record.authRevision!==previous.authRevision||record.enabled!==previous.enabled||record.appId!==previous.appId||JSON.stringify(record.context)!==JSON.stringify(previous.context)||!valid(report))throw Error('runtime_channel_configuration_readonly');
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
