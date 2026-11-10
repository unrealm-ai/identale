import type{JsonlJournal,JournalRef}from'@dentity/runtime-builtin';
import{createHash,randomBytes,randomUUID}from'node:crypto';
import type{GroupHistoryAccess,GroupHistoryQuery,GroupSharingSnapshot,SharingGroup,SharingDestination}from'@dentity/contracts';
import{TaskError,ChannelError,scopeFromJson,sharingAllows,sharingTargetKey,type ChannelPage,type ChannelMessage,type MessageLoopBinding}from'@dentity/application';
import type{Store}from'../store.js';
import type{GroupSharingConfiguration}from'./configuration.js';
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
// Provenance belongs to the actual destination, survives app rebindings, and is
// shared only as restriction metadata across employees that can reach that destination.
const key=(s:GroupSharingSnapshot,r:SharingDestination)=>JSON.stringify([s.workspaceId,r.provider,r.provider==='wecom'&&r.kind==='group'?'':r.tenantId,r.kind,r.kind==='person'?r.appId:'',r.id]);
type QueryState={runId:string;group:SharingGroup;query:{startAt:number;endAt:number;order:'asc'|'desc';limit:number;threadId?:string};providerCursor?:string;pendingPage?:ChannelPage<ChannelMessage>;seen:string[];pages:number;count:number;bytes:number;expiresAt:number};
/** Runtime-owned business data service. It never resolves execution configuration. */
export class GroupHistoryService{
 private readonly reading=new Set<string>();
 private readonly bindings=new Map<string,{revision:string;binding:MessageLoopBinding}>();
 constructor(readonly store:Store,readonly configuration:GroupSharingConfiguration,private now:()=>number,private journal:JsonlJournal){
  store.db.exec(`CREATE TABLE IF NOT EXISTS group_history_grants(run_id TEXT PRIMARY KEY,host_id TEXT NOT NULL,digest TEXT NOT NULL UNIQUE,credential TEXT NOT NULL,endpoint TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS group_history_queries(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,state_json TEXT NOT NULL,result_json TEXT,next_cursor TEXT);
   CREATE TABLE IF NOT EXISTS group_history_reads(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,run_id TEXT NOT NULL,source_json TEXT NOT NULL,destination_json TEXT NOT NULL,rules_json TEXT NOT NULL,at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS group_sharing_lineage(scope_key TEXT PRIMARY KEY,sources_json TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS group_history_run_budget(run_id TEXT PRIMARY KEY,pages INTEGER NOT NULL DEFAULT 0,bytes INTEGER NOT NULL DEFAULT 0);`);
 }
 access(runId:string,hostId:string,endpoint:string,prior?:GroupHistoryAccess):GroupHistoryAccess{
  const url=new URL(endpoint);if(!['http:','https:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash)throw Error('invalid_group_history_endpoint');
  const row=this.store.one<{digest:string;host_id:string;credential:string;endpoint:string}>('SELECT * FROM group_history_grants WHERE run_id=?',runId);
  if(row){if(row.host_id!==hostId||row.endpoint!==endpoint||hash(row.credential)!==row.digest||prior&&(prior.runId!==runId||prior.hostId!==hostId||prior.endpoint!==endpoint||hash(prior.credential)!==row.digest))throw new TaskError(409,'group_history_binding_changed');return{version:1,endpoint,credential:row.credential,runId,hostId};}
  const credential=randomBytes(32).toString('base64url');this.store.run('INSERT INTO group_history_grants VALUES(?,?,?,?,?)',runId,hostId,hash(credential),credential,endpoint);return{version:1,endpoint,credential,runId,hostId};
 }
 authorize(credential:unknown,hostId:unknown,runId:unknown){
  if(typeof credential!=='string'||credential.length>200||typeof hostId!=='string'||typeof runId!=='string')throw new TaskError(401,'history_unauthenticated');
  const grant=this.store.one<{run_id:string;host_id:string}>('SELECT run_id,host_id FROM group_history_grants WHERE digest=?',hash(credential));
  if(!grant||grant.run_id!==runId||grant.host_id!==hostId)throw new TaskError(401,'history_unauthenticated');
  const run=this.store.one<{task_id:string;session_id:string}>('SELECT task_id,session_id FROM runs WHERE id=?',runId),task=run&&this.store.one<{id:string;workspace_id:string;entity_id:string;run_id:string;status:string;config_snapshot_json:string;source_json:string}>('SELECT * FROM tasks WHERE id=?',run.task_id);
  const binding=this.store.one<{host_instance_id:string;command_json:string}>('SELECT host_instance_id,command_json FROM task_host_bindings WHERE run_id=?',runId);
  const command=binding&&JSON.parse(binding.command_json)as{sessionId:string;taskId:string;workspaceId:string;entityId:string};
  if(!task||!run||!binding||!command||binding.host_instance_id!==hostId||command.sessionId!==run.session_id||command.taskId!==task.id||command.workspaceId!==task.workspace_id||command.entityId!==task.entity_id||task.run_id!==runId||!['queued','running'].includes(task.status))throw new TaskError(403,'history_run_inactive');
  const snapshot=JSON.parse(task.config_snapshot_json??'null')?.groupSharing as GroupSharingSnapshot|undefined;
  if(!snapshot||snapshot.version!==1||snapshot.workspaceId!==task.workspace_id||snapshot.entityId!==task.entity_id)throw new TaskError(403,'history_not_granted');
  const scope=scopeFromJson(task.source_json);const expected=this.configuration.snapshot(scope);if(!expected||sharingTargetKey(expected.destination)!==sharingTargetKey(snapshot.destination)||expected.destinationThreadId!==snapshot.destinationThreadId)throw new TaskError(403,'history_destination_mismatch');
  if(snapshot.topicRead&&(!expected?.topicRead||JSON.stringify(snapshot.topicRead)!==JSON.stringify(expected.topicRead)))throw new TaskError(403,'history_thread_binding_mismatch');
  this.configuration.assertCurrent(task.workspace_id,task.entity_id,snapshot.destination);return{task,snapshot,runId};
 }
 private lineage(snapshot:GroupSharingSnapshot,ref:SharingDestination){return JSON.parse(this.store.one<{sources_json:string}>('SELECT sources_json FROM group_sharing_lineage WHERE scope_key=?',key(snapshot,ref))?.sources_json??'[]')as SharingGroup[];}
 private inherit(snapshot:GroupSharingSnapshot,source:SharingGroup){
  const own=this.lineage(snapshot,snapshot.destination),inherited=[source,...this.lineage(snapshot,source)],all=[...new Map([...own,...inherited].map(g=>[sharingTargetKey(g),g])).values()];
  this.store.run('INSERT INTO group_sharing_lineage VALUES(?,?) ON CONFLICT(scope_key) DO UPDATE SET sources_json=excluded.sources_json',key(snapshot,snapshot.destination),JSON.stringify(all));
 }
 private allowed(snapshot:GroupSharingSnapshot,source:SharingGroup){
  if(!sharingAllows(snapshot,source))throw new TaskError(403,'history_source_forbidden');
  // Conservative durable provenance: all later material from a destination inherits
  // its previously read sources, including summaries and unidentified send receipts.
  if(sharingTargetKey(source)!==sharingTargetKey(snapshot.destination)&&this.lineage(snapshot,source).some(g=>!sharingAllows(snapshot,g)))throw new TaskError(403,'history_derived_source_forbidden');
  this.configuration.assertCurrent(snapshot.workspaceId,snapshot.entityId,source);
 }
 private groups(snapshot:GroupSharingSnapshot){const groups=snapshot.sources.map(s=>s.group);if(snapshot.destination.kind==='group'&&sharingAllows(snapshot,snapshot.destination))groups.unshift(snapshot.destination);return groups;}
 private contexts(snapshot:GroupSharingSnapshot){const groups=this.groups(snapshot).map(group=>({group,groupRef:hash(sharingTargetKey(group)),type:'group' as 'group'|'thread',name:group.label,threadId:undefined as string|undefined}));if(snapshot.destination.kind==='group'&&snapshot.topicRead&&sharingAllows(snapshot,snapshot.destination))groups.unshift({group:snapshot.destination,groupRef:hash(JSON.stringify([sharingTargetKey(snapshot.destination),'thread',snapshot.topicRead.threadId])),type:'thread',name:'当前话题',threadId:snapshot.topicRead.threadId});return groups;}
 list(auth:ReturnType<GroupHistoryService['authorize']>){return{items:this.contexts(auth.snapshot).flatMap(context=>{try{this.allowed(auth.snapshot,context.group);return[{groupRef:context.groupRef,contextRef:context.groupRef,type:context.type,name:context.name,...(context.threadId?{threadId:context.threadId}:{})}];}catch{return[];}}),provider:auth.snapshot.destination.provider,...(auth.snapshot.destination.provider==='wecom'?{queryHints:{maxLookbackDays:7,orders:['desc'],timeZone:'Asia/Shanghai',recordIds:'query_local'}}:{}),coverage:'explicit_authorized_contexts',warnings:['Only this task source and directly authorized groups are readable. Files require separate grants; group pages do not expand all threads.']};}
 private async binding(group:SharingGroup){
  const row=this.configuration.channels.repository.byId(group.connectionId)!,revision=JSON.stringify([row.revision,row.authRevision,row.stateVersion]);let cached=this.bindings.get(group.connectionId);
  if(cached?.revision!==revision){const binding=await this.configuration.channels.resolveHistoryBinding(group.connectionId);if(!binding)throw new TaskError(409,'history_channel_unavailable');cached={revision,binding};this.bindings.set(group.connectionId,cached);}
  return cached.binding;
 }
 private journalScope(auth:ReturnType<GroupHistoryService['authorize']>){return{workspaceId:auth.snapshot.workspaceId,entityId:auth.snapshot.entityId,conversationId:'group-history:'+auth.task.id};}
 private assertActive(auth:ReturnType<GroupHistoryService['authorize']>){if(!this.store.one("SELECT id FROM tasks WHERE id=? AND run_id=? AND status IN ('queued','running')",auth.task.id,auth.runId))throw new TaskError(403,'history_run_inactive');}
 async read(auth:ReturnType<GroupHistoryService['authorize']>,value:unknown){if(this.reading.has(auth.runId))throw new TaskError(409,'history_read_in_progress');this.reading.add(auth.runId);try{return await this.readPage(auth,value);}finally{this.reading.delete(auth.runId);}}
 private async readPage(auth:ReturnType<GroupHistoryService['authorize']>,value:unknown){this.assertActive(auth);
  const q=value as GroupHistoryQuery;if(!q||Object.keys(q).some(k=>!['groupRef','startAt','endAt','order','cursor','limit'].includes(k))||typeof q.groupRef!=='string'||q.groupRef.length>100||q.cursor!==undefined&&(typeof q.cursor!=='string'||q.cursor.length>100))throw new TaskError(400,'invalid_history_query');
  const context=this.contexts(auth.snapshot).find(g=>g.groupRef===q.groupRef),source=context?.group;if(!source)throw new TaskError(403,'history_source_forbidden');this.allowed(auth.snapshot,source);
  const id=q.cursor??randomUUID();const saved=q.cursor?this.store.one<{state_json:string;result_json:string|null;next_cursor:string|null}>('SELECT state_json,result_json,next_cursor FROM group_history_queries WHERE id=?',id):undefined;
  let state:QueryState;if(q.cursor){if(!saved)throw new TaskError(400,'history_cursor_invalid');state=JSON.parse(saved.state_json)as QueryState;
   if(state.runId!==auth.runId||state.query.threadId!==context?.threadId||sharingTargetKey(state.group)!==sharingTargetKey(source)||state.expiresAt<=this.now()||(['startAt','endAt','order','limit']as const).some(k=>q[k]!==undefined&&q[k]!==state.query[k]))throw new TaskError(400,'history_cursor_invalid');
   if(saved.result_json){this.inherit(auth.snapshot,source);return this.journal.read(this.journalScope(auth),JSON.parse(saved.result_json)as JournalRef);}
  }else{const endAt=q.endAt??Math.floor(this.now()/1000)*1000,startAt=q.startAt??endAt-86400000,limit=q.limit??50,order=q.order??(source.provider==='wecom'?'desc':'asc');
   if(!Number.isSafeInteger(startAt)||startAt<0||startAt%1000||!Number.isSafeInteger(endAt)||endAt<=startAt||endAt%1000||!Number.isInteger(limit)||limit<1||limit>50||!['asc','desc'].includes(order))throw new TaskError(400,'invalid_history_query');
   state={runId:auth.runId,group:source,query:{startAt,endAt,limit,order,...(context?.threadId?{threadId:context.threadId}:{})},seen:[],pages:0,count:0,bytes:0,expiresAt:this.now()+900000};this.store.run('INSERT INTO group_history_queries(id,run_id,state_json) VALUES(?,?,?)',id,auth.runId,JSON.stringify(state));
  }
  const budget=this.store.one<{pages:number;bytes:number}>('SELECT pages,bytes FROM group_history_run_budget WHERE run_id=?',auth.runId)??{pages:0,bytes:0};if(budget.pages>=20||budget.bytes>=128000)throw new TaskError(429,'history_run_budget_exhausted');
  const binding=await this.binding(source);let page:ChannelPage<ChannelMessage>;
  try{page=state.pendingPage??await binding.conversation.listMessages({provider:source.provider,connectionId:source.connectionId,tenantId:source.tenantId,kind:'conversation',externalId:source.id,conversationKind:'group'},{...state.query,...(state.providerCursor?{cursor:state.providerCursor}:{})});}
  catch(error){if(error instanceof ChannelError)throw new TaskError(error.code==='forbidden'?403:error.code==='unsupported'?422:error.code==='invalid_request'?400:error.code==='rate_limited'?429:503,error.code==='invalid_request'&&q.cursor?'history_cursor_expired':error.code);throw error;}
  const remainder=page.items.slice(state.query.limit),providerPage=page;page={...page,items:page.items.slice(0,state.query.limit),exhausted:page.exhausted&&remainder.length===0};
  this.assertActive(auth);this.allowed(auth.snapshot,source);const messages:{id:string;sourceRef:string;author:ChannelMessage['author'];occurredAt:number;text:string;threadId?:string;rootMessageId?:string}[]=[];let bytes=0,truncated=false;
  for(const m of page.items){if(m.occurredAt<state.query.startAt||m.occurredAt>=state.query.endAt||state.seen.includes(m.id))continue;
   const projected={id:m.id,sourceRef:q.groupRef,author:m.author,occurredAt:m.occurredAt,text:m.text,...(m.threadId?{threadId:m.threadId}:{}),...(m.rootMessageId?{rootMessageId:m.rootMessageId}:{})},size=Buffer.byteLength(JSON.stringify(projected));
   if(state.bytes+bytes+size>64000||budget.bytes+bytes+size>128000||state.count+messages.length>=500){truncated=true;break;}messages.push(projected);bytes+=size;
  }
  const pages=state.pages+1,count=state.count+messages.length,capped=truncated||pages>=10||count>=500||state.bytes+bytes>=64000||budget.pages+1>=20;
  const more=!page.exhausted&&!capped,next=more?randomUUID():undefined;
  const result={messages,...(next?{nextCursor:next}:{}),exhausted:page.exhausted&&!truncated,coverage:truncated||capped&&!page.exhausted?'partial':page.coverage,fetchedAt:page.fetchedAt,range:state.query,truncated:truncated||capped&&!page.exhausted,warnings:[...(page.warnings??[]),'Source restrictions persist in derived results; this is not complete group history.','Text projection only; no file download or automatic expansion of other threads.',...(capped&&!page.exhausted?['Query budget reached; later messages were not read.']:[])]};
  this.store.transaction(()=>{
   if(this.store.one<{result_json:string|null}>('SELECT result_json FROM group_history_queries WHERE id=?',id)?.result_json)throw new TaskError(409,'history_page_concurrent');
   // Persist provenance before exposing text. A crash may over-restrict, never lose a source.
   this.inherit(auth.snapshot,source);this.store.run('INSERT INTO group_history_reads VALUES(?,?,?,?,?,?,?)',id,auth.task.id,auth.runId,JSON.stringify(source),JSON.stringify(auth.snapshot.destination),JSON.stringify(auth.snapshot.sources.find(g=>sharingTargetKey(g.group)===sharingTargetKey(source))?.rules??[]),this.now());
   const resultRef=this.journal.put(this.journalScope(auth),'group_history_page',result);
   this.store.run('UPDATE group_history_queries SET result_json=?,next_cursor=? WHERE id=?',JSON.stringify(resultRef),next??null,id);
   this.store.run('INSERT INTO group_history_run_budget VALUES(?,?,?) ON CONFLICT(run_id) DO UPDATE SET pages=pages+excluded.pages,bytes=bytes+excluded.bytes',auth.runId,1,bytes);
   if(next)this.store.run('INSERT INTO group_history_queries(id,run_id,state_json) VALUES(?,?,?)',next,auth.runId,JSON.stringify({...state,pages,count,bytes:state.bytes+bytes,seen:[...state.seen,...page.items.map(m=>m.id)],providerCursor:providerPage.nextCursor,...(remainder.length?{pendingPage:{...providerPage,items:remainder}}:{pendingPage:undefined})}));
  });return result;
 }
}
