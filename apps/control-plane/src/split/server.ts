import Fastify,{type FastifyRequest,type FastifyInstance} from 'fastify';
import {PROTOCOL_VERSION,healthResponseSchema,readinessResponseSchema,type ServiceName,type HealthResponse,type ReadinessResponse} from '@dentity/contracts';
import {TaskError,AccountError} from '@dentity/application';
import {bootstrap,type ControlPlaneConfig} from '../bootstrap.js';
import type {Store} from '../store.js';
import type {ConfigurationComposition} from './composition.js';
import {ConfigurationPoller,registerConfigurationApi,deriveRuntimeConfigurationKey} from './config-sync.js';
import {authorizeService,serviceEndpoint,serviceToken,serviceJson} from './service-transport.js';
import {EmployeeLifecycleController,registerLifecycleControl,remoteLifecycleTransition} from './lifecycle-control.js';
import {registerChannelObservationApi,installChannelObservationReporter} from './channel-observations.js';
import {defaultDatabasePath} from '../storage-config.js';

export interface PlatformServerOptions extends Partial<ControlPlaneConfig>{
 configurationToken:string;runtimeService:{url:string;token:string};piMonitor?:{url:string;token:string};transport?:typeof fetch;
}
export interface RuntimeServerOptions extends Partial<ControlPlaneConfig>{
 platformConfig:{url:string;token:string;pollMs?:number;maxAgeMs?:number};serviceToken:string;transport?:typeof fetch;
}
const userRoutes=/^\/api\/workspaces\/[^/]+\/(?:recent-conversations(?:\/|$)|chat-employees(?:\/|$)|task-management(?:\/|$)|entities\/[^/]+\/(?:conversations|tasks|todos)(?:\/|$)|entities\/[^/]+\/channels\/[^/]+\/message-status(?:\?|$)|entities\/[^/]+\/triggers\/[^/]+\/events(?:\?|$))/;
// OAuth state, code and tokens remain runtime-owned. This is an authenticated
// browser relay, not a public or generic provider proxy.
const businessUserRoutes=/^\/api\/business-resources\/(?:configuration|materials|feishu\/(?:authorize|callback))$/;
function base(options:Partial<ControlPlaneConfig>,path:string):ControlPlaneConfig{return {...options,databasePath:options.databasePath??path,origin:options.origin??'http://127.0.0.1:15173',secureCookies:options.secureCookies??false,sessionTtlMs:options.sessionTtlMs??28800000,now:options.now??Date.now};}
function alive(server:FastifyInstance,service:ServiceName,ready:()=>boolean,executionAvailable=false){
 server.get('/healthz',{schema:{response:{200:healthResponseSchema}}},():HealthResponse=>({protocolVersion:PROTOCOL_VERSION,service,status:'alive',executionAvailable}));
 server.get('/readyz',{schema:{response:{200:readinessResponseSchema,503:readinessResponseSchema}}},(_request,reply)=>{
  const result:ReadinessResponse=ready()?{protocolVersion:PROTOCOL_VERSION,service,status:'ready',providerConnectivity:'unverified'}:{protocolVersion:PROTOCOL_VERSION,service,status:'not_ready',reason:'configuration_unavailable'};
  return reply.code(result.status==='ready'?200:503).send(result);
 });
}
/** Platform authenticates the browser; the runtime receives only a service-authenticated actor. */
export function createPlatformServer(options:PlatformServerOptions){
 serviceToken(options.configurationToken);serviceToken(options.runtimeService.token);const runtimeUrl=serviceEndpoint(options.runtimeService.url),transport=options.transport??fetch;
 if(options.configurationToken===options.runtimeService.token)throw new Error('Configuration and runtime service credentials must be distinct');
 if(options.piMonitor){serviceEndpoint(options.piMonitor.url);serviceToken(options.piMonitor.token);}
 const server=Fastify({logger:false,bodyLimit:16384});
 server.register(async app=>bootstrap(app,{...base(options,defaultDatabasePath('platform')),split:{role:'platform',notificationKey:options.configurationToken,notificationGroups:async(actorId,path,request)=>{const response=await transport(runtimeUrl+path,{...(request?{method:request.method,body:JSON.stringify(request.body)}:{}),headers:{...(request?{'content-type':'application/json'}:{}),authorization:'Bearer '+options.runtimeService.token,'x-dentity-actor':actorId,origin:options.origin??'http://127.0.0.1:15173'},redirect:'error',signal:AbortSignal.timeout(15000)});if(!response.ok){let code='notification_groups_unavailable';if(request){try{const body=await response.json()as{error?:unknown};if(typeof body.error==='string'&&/^human_[a-z_]{1,70}$/.test(body.error))code=body.error;}catch{}}throw new TaskError(response.status,code);}return response.json();},lifecycleTransition:remoteLifecycleTransition({url:runtimeUrl,token:options.runtimeService.token,fetch:transport}),authenticate:()=>{throw new TaskError(401,'unauthenticated');},async initialize(c){
  registerConfigurationApi(app,{store:c.store,profiles:c.profiles,skills:c.skills,mcp:c.mcp,channels:c.channels,...(c.triggers?{triggers:c.triggers}:{}),token:options.configurationToken,approvedResources:options.approvedResources??[],...(options.modelProfiles?.masterKey?{masterKey:options.modelProfiles.masterKey}:{}),now:c.store?options.now??Date.now:Date.now});
  app.post('/internal/config/directory-demand',request=>{
   authorizeService(request.headers.authorization,options.configurationToken);
   const b=request.body as{connectionId?:unknown;kind?:unknown;id?:unknown};if(!b||Object.keys(b).some(k=>!['connectionId','kind','id'].includes(k))||typeof b.connectionId!=='string'||!c.channels.repository.byId(b.connectionId))throw new TaskError(400,'invalid_directory_request');
   if(b.kind==='department'&&typeof b.id==='string'&&b.id.length>0&&b.id.length<=4096)c.snapshots.requestDepartment(b.connectionId,b.id);
   else if(b.kind==='user'&&b.id&&typeof b.id==='object'&&!Array.isArray(b.id)){const value=b.id as{namespace?:unknown;id?:unknown;applicationId?:unknown};if(Object.keys(value).some(k=>!['namespace','id','applicationId'].includes(k))||typeof value.namespace!=='string'||typeof value.id!=='string'||!value.id||value.id.length>4096||value.applicationId!==undefined&&typeof value.applicationId!=='string')throw new TaskError(400,'invalid_directory_request');c.snapshots.requestUser(b.connectionId,value as Parameters<typeof c.snapshots.requestUser>[1]);}
   else throw new TaskError(400,'invalid_directory_request');return{accepted:true};
  });
  registerChannelObservationApi(app,{token:options.configurationToken,channels:c.channels,store:c.store});
  c.channels.setMemberVerificationReceiver(async(record,requestId)=>{
   const deadline=Date.now()+12000;
   do{
    try{const response=await transport(runtimeUrl+'/internal/control/wecom-member-verification-ready',{method:'POST',headers:{authorization:'Bearer '+options.runtimeService.token,'content-type':'application/json'},body:JSON.stringify({connectionId:record.id,sourceId:record.sourceId,authRevision:record.authRevision,stateVersion:record.stateVersion,requestId}),redirect:'error',signal:AbortSignal.timeout(2000)});if(response.ok&&(await response.json()as{ready?:unknown}).ready===true)return true;}catch{/* Bounded read-only readiness probe; no send before the receiver confirms. */}
    if(Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,250));
   }while(Date.now()<deadline);
   return false;
  });

  const relay=async(request:FastifyRequest,path=request.url)=>{
   const user=c.auth(request),workspace=/^\/api\/workspaces\/([^/?]+)/.exec(path);if(workspace){const role=c.workspaces.get(user.id,decodeURIComponent(workspace[1]!)).role;if(/^\/api\/workspaces\/[^/]+\/task-management(?:\/|$)/.test(path)&&!['owner','admin'].includes(role))throw new TaskError(403,'role_forbidden');}
   const response=await transport(runtimeUrl+path,{method:request.method,headers:{authorization:'Bearer '+options.runtimeService.token,'x-dentity-actor':user.id,origin:options.origin??'http://127.0.0.1:15173',...(request.body===undefined?{}:{'content-type':'application/json'})},...(request.body===undefined?{}:{body:JSON.stringify(request.body)}),redirect:'error',signal:AbortSignal.timeout(30000)});
   return response;
  };
  app.get('/api/workspaces/:workspaceId/entities/:entityId/runtime-status',async request=>{
   const p=request.params as {workspaceId:string;entityId:string};c.entities.requireReader(c.auth(request).id,p.workspaceId,p.entityId);
   try{const response=await relay(request,`/internal/monitor/employees/${encodeURIComponent(p.workspaceId)}/${encodeURIComponent(p.entityId)}`);if(!response.ok)throw new Error();return await response.json();}
   catch{return{status:'unavailable',observedAt:null,configuration:{ready:false,modules:[]},employee:null,error:'runtime_service_unavailable'};}
  });
  app.get('/api/workspaces/:workspaceId/task-management/task-list/:taskId/monitor',async(request,reply)=>{
   const p=request.params as{workspaceId:string;taskId:string};const detail=await relay(request,`/api/workspaces/${encodeURIComponent(p.workspaceId)}/task-management/task-list/${encodeURIComponent(p.taskId)}`);
   if(!detail.ok)return reply.code(detail.status).send(await detail.json());
   const binding=await relay(request,`/internal/monitor/tasks/${encodeURIComponent(p.workspaceId)}/${encodeURIComponent(p.taskId)}`);if(!binding.ok)return reply.code(binding.status).send(await binding.json());
   const runtime=await binding.json() as {executionId:string|null;workspaceId:string;entityId:string;[key:string]:unknown};let execution:unknown=null,error:string|null=null;
   if(runtime.executionId&&options.piMonitor){try{const observed=await serviceJson(transport,options.piMonitor.url+`/internal/monitor/executions/${encodeURIComponent(runtime.executionId)}`,options.piMonitor.token) as{workspaceId?:string;entityId?:string;executionId?:string};if(observed.workspaceId!==runtime.workspaceId||observed.entityId!==runtime.entityId||observed.executionId!==runtime.executionId)throw Error('execution_scope_mismatch');execution=observed;}catch{error='execution_monitor_unavailable';}}
   return{runtime,execution,error};
  });
  app.get('/api/workspaces/:workspaceId/runtime-monitor',async request=>{
   const p=request.params as{workspaceId:string},role=c.workspaces.get(c.auth(request).id,p.workspaceId).role;if(!['owner','admin'].includes(role))throw new TaskError(403,'role_forbidden');
   const runtime=await relay(request,`/internal/monitor/workspaces/${encodeURIComponent(p.workspaceId)}`).then(async r=>r.ok?await r.json():{status:'unavailable'}).catch(()=>({status:'unavailable'}));
   // PI infrastructural health is global metadata; no Session/user records are listed here.
   const execution=options.piMonitor?await serviceJson(transport,options.piMonitor.url+'/internal/monitor/status',options.piMonitor.token).then(value=>{const state=value as{service:string;runtimeId:string;hostId:string};return{service:state.service,runtimeId:state.runtimeId,hostId:state.hostId,status:'reachable'};}).catch(()=>({status:'unavailable'})):null;
   return{runtime,execution};
  });
  await app.register(async ingress=>{
   ingress.removeContentTypeParser('application/json');ingress.addContentTypeParser('application/json',{parseAs:'buffer'},(_request,body,done)=>done(null,body));
   ingress.post('/api/triggers/:kind/:triggerId',{bodyLimit:128000,config:{triggerWebhook:true}},async(request,reply)=>{
    const {kind}=request.params as{kind:string};if(!['webhook','github'].includes(kind))return reply.code(404).send({error:'not_found'});
    const headers:Record<string,string>={};for(const [key,value]of Object.entries(request.headers))if(typeof value==='string'&&['content-type','x-key-id','x-timestamp','x-signature','x-hub-signature-256','x-github-event','x-github-delivery'].includes(key))headers[key]=value;
    try{const response=await transport(runtimeUrl+request.url,{method:'POST',headers,body:Uint8Array.from(request.body as Buffer).buffer,redirect:'error',signal:AbortSignal.timeout(30000)});return reply.code(response.status).header('content-type',response.headers.get('content-type')??'application/json').send(Buffer.from(await response.arrayBuffer()));}catch{return reply.code(503).send({error:'runtime_service_unavailable'});}
   });
  });
  app.setNotFoundHandler(async(request,reply)=>{
   if(!userRoutes.test(request.url.split('?')[0]!)&&!businessUserRoutes.test(request.url.split('?')[0]!))return reply.code(404).send({error:'not_found'});
   try{const response=await relay(request);const opening=request.method==='POST'&&/^\/api\/workspaces\/([^/]+)\/entities\/([^/]+)\/conversations$/.exec(request.url.split('?')[0]!);if(opening&&[403,404,503].includes(response.status)){const error=await response.clone().json().catch(()=>({})) as{error?:string};if(['entity_not_found','workspace_forbidden','workspace_not_found','identity_configuration_not_applied'].includes(error.error??'')){c.entities.requireReader(c.auth(request).id,decodeURIComponent(opening[1]!),decodeURIComponent(opening[2]!));return reply.code(503).header('retry-after','1').send({error:'employee_configuration_pending'});}}reply.code(response.status);const ct=response.headers.get('content-type');if(ct)reply.header('content-type',ct);return reply.send(Buffer.from(await response.arrayBuffer()));}
   catch(error){if(error instanceof TaskError||error instanceof AccountError)throw error;return reply.code(503).send({error:'runtime_service_unavailable'});}
  });
 }} }));
 alive(server,'platform',()=>true);return server;
}

/** Runtime owns every durable queue/task/conversation fact, configuration is only a RAM projection. */
export function createRuntimeServer(options:RuntimeServerOptions){
 serviceToken(options.serviceToken);serviceToken(options.platformConfig.token);serviceEndpoint(options.platformConfig.url);
 if(options.serviceToken===options.platformConfig.token)throw new Error('Configuration and runtime service credentials must be distinct');
 const server=Fastify({logger:false,bodyLimit:16384}),transport=options.transport??fetch;
 let prepareExecution:()=>void=()=>undefined;
 let poller:ConfigurationPoller|undefined;const configurationWaiters=new Set<()=>void>();
 let composition:ConfigurationComposition|undefined;let lifecycle:EmployeeLifecycleController|undefined;let observations:ReturnType<typeof installChannelObservationReporter>|undefined;
 const authenticate=(request:FastifyRequest,store:Store)=>{
  authorizeService(request.headers.authorization,options.serviceToken);
  if(!poller?.status.epoch)throw new TaskError(503,'configuration_unavailable');
  const actor=request.headers['x-dentity-actor'];if(typeof actor!=='string'||!actor||actor.length>160)throw new TaskError(401,'actor_required');
  const user=store.one<{id:string;username:string;displayName:string}>("SELECT id,username,display_name displayName FROM users WHERE id=? AND status='active'",actor);
  if(!user)throw new TaskError(503,'identity_configuration_not_applied');return user;
 };
 server.register(async app=>bootstrap(app,{...base(options,defaultDatabasePath('runtime')),modelProfiles:{...options.modelProfiles,masterKey:deriveRuntimeConfigurationKey(options.platformConfig.token)},employeeChannels:{...options.employeeChannels,masterKey:deriveRuntimeConfigurationKey(options.platformConfig.token)},split:{role:'runtime',notificationKey:options.platformConfig.token,authenticate,hasConfiguration:()=>!!poller?.status.epoch,whenConfigured(work){if(poller?.status.epoch)work();else configurationWaiters.add(work);},assertNewAdmission(){if(!poller?.ready)throw new TaskError(503,'configuration_unavailable');},

  async initialize(c){composition=c;
   app.post('/internal/control/wecom-member-verification-ready',request=>{
    authorizeService(request.headers.authorization,options.serviceToken);
    const b=request.body as{connectionId?:unknown;sourceId?:unknown;authRevision?:unknown;stateVersion?:unknown;requestId?:unknown};
    if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!['connectionId','sourceId','authRevision','stateVersion','requestId'].includes(k))||typeof b.connectionId!=='string'||typeof b.sourceId!=='string'||typeof b.requestId!=='string'||!Number.isSafeInteger(b.authRevision)||!Number.isSafeInteger(b.stateVersion))throw new TaskError(400,'invalid_member_verification_request');
    return{ready:poller?.ready===true&&c.channels.memberVerificationReady(b.connectionId,b.sourceId,b.authRevision as number,b.requestId,b.stateVersion as number)};
   });

   const demand=new Map<string,number>();
   const requestDirectory=(connectionId:string,kind:'user'|'department',id:unknown)=>{const key=JSON.stringify([connectionId,kind,id]),now=(options.now??Date.now)();if((demand.get(key)??0)>now)return;if(demand.size>=1000)demand.delete(demand.keys().next().value!);demand.set(key,now+60000);void serviceJson(transport,options.platformConfig.url+'/internal/config/directory-demand',options.platformConfig.token,{connectionId,kind,id}).catch(()=>{demand.delete(key);});};
   const requestUser=c.snapshots.requestUser.bind(c.snapshots),requestDepartment=c.snapshots.requestDepartment.bind(c.snapshots);
   c.snapshots.requestUser=(connection,id)=>{requestUser(connection,id);requestDirectory(connection,'user',id);};
   c.snapshots.requestDepartment=(connection,id)=>{requestDepartment(connection,id);requestDirectory(connection,'department',id);};
   const before=new Map<string,string>();
   lifecycle=new EmployeeLifecycleController({store:c.store,now:options.now??Date.now,onFenceChanged(w,e){for(const r of c.channels.repository.list(w,e))c.channels.notifyCommitted(r.id);}});
   observations=installChannelObservationReporter(c.store,c.channels.repository,{url:options.platformConfig.url,token:options.platformConfig.token,fetch:transport,now:options.now??Date.now});
   c.channels.setMemberVerificationPersistence(async(r,requestId,callbackUserId)=>{await observations!.flush();const result=await serviceJson(transport,options.platformConfig.url+'/internal/config/wecom-member-confirmed',options.platformConfig.token,{connectionId:r.id,sourceId:r.sourceId,authRevision:r.authRevision,requestId,callbackUserId}) as {confirmed?:boolean};return result.confirmed===true;});
   app.addHook('preClose',()=>observations!.close());
   poller=new ConfigurationPoller({store:c.store,baseUrl:options.platformConfig.url,token:options.platformConfig.token,...(options.platformConfig.pollMs?{pollMs:options.platformConfig.pollMs}:{}),...(options.platformConfig.maxAgeMs?{maxAgeMs:options.platformConfig.maxAgeMs}:{}),fetch:transport,now:options.now??Date.now,onApplied(change){
    queueMicrotask(()=>{if(poller?.status.epoch){for(const work of configurationWaiters)work();configurationWaiters.clear();}});
    if(change.changedModules.some(name=>['identity','permissions','models','resources'].includes(name)))queueMicrotask(()=>prepareExecution());
    c.capabilities.replaceApprovedResources(change.snapshot.approvedResources);observations!.reconcile();lifecycle!.reconcile();
    if(change.changedModules.some(name=>name==='permissions'||name==='identity'))for(const row of c.store.all<{workspace_id:string;id:string}>('SELECT workspace_id,id FROM entities'))c.capabilities.invalidateAdmission(row.workspace_id,row.id);
    const next=new Map(c.channels.repository.all().map(r=>[r.id,JSON.stringify([r.revision,r.authRevision,r.stateVersion,r.enabled])]));for(const id of new Set([...before.keys(),...next.keys()]))if(before.get(id)!==next.get(id))c.channels.notifyCommitted(id);before.clear();for(const [k,v]of next)before.set(k,v);
   }});
   c.profiles.assertUsable=c.profiles.assertConfigured.bind(c.profiles);
   c.profiles.resolve=async(scope,authorize)=>{if(!await authorize(scope))throw new TaskError(403,'model_credential_forbidden');const result=await poller!.request<Awaited<ReturnType<typeof c.profiles.resolve>>>('model',scope);if(!await authorize(scope))throw new TaskError(403,'model_credential_forbidden');return result;};
   server.decorate('configurationPoller',poller);
   await poller.poll();poller.start();observations.start();
app.addHook('preClose',()=>{configurationWaiters.clear();poller!.stop();});
   app.addHook('onRequest',async(request,reply)=>{if(request.url.startsWith('/internal/runtime/')&&!poller!.status.epoch)return reply.code(503).send({error:'configuration_unavailable'});if(request.url.startsWith('/api/workspaces/')){authorizeService(request.headers.authorization,options.serviceToken);if(request.method==='POST'&&/\/(?:conversations|turns|tasks|todos)$|\/todos\/[^/]+\/start$/.test(request.url.split('?')[0]!)&&!poller!.ready)return reply.code(503).send({error:'configuration_unavailable'});}if(request.url.startsWith('/api/triggers/')&&!poller!.ready)return reply.code(503).send({error:'configuration_unavailable'});});
  },resource:(kind,body)=>poller!.request(kind,body),runtimeReady(c){
   const passive=app.getDecorator<import('../runtime-http.js').HttpTaskRuntime|undefined>('passiveRuntime');
   let preparation:Promise<void>|undefined,preparationClosing=false;const prepare=()=>{if(preparation||preparationClosing||!poller?.ready||!passive)return;preparation=passive.prepareConfigured().catch(()=>{}).finally(()=>{preparation=undefined;});};
   prepareExecution=prepare;prepare();const prepareTimer=setInterval(prepare,30000);prepareTimer.unref();app.addHook('preClose',async()=>{preparationClosing=true;clearInterval(prepareTimer);await preparation;});
   registerLifecycleControl(app,{controller:lifecycle!,authenticate(request){authorizeService(request.headers.authorization,options.serviceToken);},authorize(request,w,e){composition!.entities.requireManager(authenticate(request,c.store).id,w,e);},refresh:()=>poller!.poll()});
   app.get('/internal/monitor/employees/:workspaceId/:entityId',request=>{
    const p=request.params as{workspaceId:string;entityId:string};composition!.entities.requireReader(authenticate(request,c.store).id,p.workspaceId,p.entityId);
    const modules=Object.entries(poller!.status.moduleRevisions??{}).map(([name,revision])=>({name,revision,observedAt:poller!.status.lastValidatedAt,error:poller!.status.error}));
    let configured=false,reason:string|null=null;try{c.profiles.assertUsable(p.workspaceId,p.entityId);configured=true;}catch(e){reason=e instanceof Error?e.message:'model_not_configured';}
    const active=!!c.store.one('SELECT 1 FROM entities WHERE workspace_id=? AND id=? AND lifecycle_enabled=1',p.workspaceId,p.entityId);
    return{status:poller!.ready?'available':'not_ready',observedAt:(options.now??Date.now)(),configuration:{ready:poller!.ready,modules},employee:{execution:app.getDecorator<import('../runtime-http.js').HttpTaskRuntime|undefined>('passiveRuntime')?.preparation(p.workspaceId,p.entityId),interaction:{configured,available:poller!.ready&&configured&&active,reason:!active?'entity_disabled':reason},channels:c.channels.list(p.workspaceId,p.entityId).map(r=>{
     const transport=c.ingress.status(r.id);
     return{id:r.id,appId:r.appId,revision:r.revision,authRevision:r.authRevision,provider:r.provider,configured:true,state:transport.state,reason:transport.error??r.lastError,transport};
    })},error:poller!.status.error};
   });
   app.get('/api/workspaces/:workspaceId/entities/:entityId/conversations/:conversationId/locator',request=>{
    const p=request.params as{workspaceId:string;entityId:string;conversationId:string},user=authenticate(request,c.store);
    c.tasks.conversation({workspaceId:p.workspaceId,entityId:p.entityId,userId:user.id},p.conversationId);
    const location=c.journal.location({workspaceId:p.workspaceId,entityId:p.entityId,conversationId:p.conversationId});
    return{ownerService:'interaction-task',storageId:'builtin-records',location,relativePath:location.resourceId+'/current.jsonl',contentAccess:'authorized_conversation_api'};
   });
   app.get('/internal/monitor/workspaces/:workspaceId',request=>{const p=request.params as{workspaceId:string};const user=authenticate(request,c.store),role=composition!.workspaces.get(user.id,p.workspaceId).role;if(!['owner','admin'].includes(role))throw new TaskError(403,'role_forbidden');return{service:'interaction-task',configuration:poller!.status,counts:{conversations:c.store.one<{n:number}>('SELECT count(*) n FROM conversations WHERE workspace_id=?',p.workspaceId)!.n,tasks:c.store.one<{n:number}>('SELECT count(*) n FROM tasks WHERE workspace_id=?',p.workspaceId)!.n}};});
   app.get('/internal/monitor/tasks/:workspaceId/:taskId',request=>{const p=request.params as{workspaceId:string;taskId:string};const user=authenticate(request,c.store),role=composition!.workspaces.get(user.id,p.workspaceId).role;if(!['owner','admin'].includes(role))throw new TaskError(403,'role_forbidden');const t=c.store.one<{id:string;run_id:string|null;entity_id:string;conversation_id:string|null}>('SELECT id,run_id,entity_id,conversation_id FROM tasks WHERE workspace_id=? AND id=?',p.workspaceId,p.taskId);if(!t)throw new TaskError(404,'task_not_found');return{ownerService:'interaction-task',taskId:t.id,workspaceId:p.workspaceId,entityId:t.entity_id,executionId:t.run_id,interactionJournal:t.conversation_id?{ownerService:'interaction-task',storageId:'builtin-records',format:'interaction-jsonl',availability:'authorized_api_only',location:c.journal.location({workspaceId:p.workspaceId,entityId:t.entity_id,conversationId:t.conversation_id})}:null};});
  }
 }}));
 alive(server,'interaction-task',()=>poller?.ready===true,!!(options.runtimeHost??options.runtime));return server;
}
