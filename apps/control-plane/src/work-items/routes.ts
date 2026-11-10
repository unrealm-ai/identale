import type{FastifyInstance,FastifyRequest}from'fastify';
import{createHash}from'node:crypto';
import{TaskError}from'@dentity/application';
import type{HumanConfirmation,HumanTarget}from'../human-confirmation.js';
import{recipientCandidate}from'../human-recipient-router.js';
import type{Store}from'../store.js';
import type{EmployeeChannelRecord}from'../employee-channels/types.js';
import{attachIdentityBindings}from'../employee-channels/wecom-identity-bindings.js';
import{usesWeComBotSearch,weComCallbackUserId,weComSearchUserId}from'../employee-channels/wecom-bot-contacts.js';
import type{WorkItemConfiguration}from'./configuration.js';
import type{WorkItemsService}from'./service.js';
const recipientHash=(identity:unknown)=>createHash('sha256').update(JSON.stringify(identity)).digest('hex');
/** A waiting choice is display-only: never infer a recipient from a different rule revision. */
function pendingRecipient(store:Store,workspaceId:string,entityId:string,selectionJson:string|null){
 if(!selectionJson)return{};
 const selection=JSON.parse(selectionJson)as{status?:string;configDigest?:string;candidateId?:string};
 if(selection.status!=='waiting_identity')return{};
 const rulesJson=store.one<{rules_json:string}>('SELECT rules_json FROM employee_human_rules WHERE workspace_id=? AND entity_id=?',workspaceId,entityId)?.rules_json??'[]';
 if(createHash('sha256').update(rulesJson).digest('hex')!==selection.configDigest)return{changed:true};
 const rules=JSON.parse(rulesJson)as{questionScope:string;target:HumanTarget}[],selected=rules.find(rule=>recipientCandidate(rule.questionScope,rule.target).candidateId===selection.candidateId);
 return selected?.target.kind==='wecom_directory'?{target:selected.target}:{changed:true};
}
/** Resolve names only from current, exact identity evidence after the row visibility check. */
function recipientView(store:Store,workspaceId:string,entityId:string,target:HumanTarget){
 if(target.kind==='web')return{recipientKey:recipientHash(['web',target.userId]),recipientLabel:store.one<{display_name:string}>('SELECT display_name FROM users WHERE id=?',target.userId)?.display_name??'Web确认人'};
 const reference=target.kind==='wecom_directory'?target:target.directoryReference;
 const directoryKey=(sourceId:string,authRevision:number,directoryUserId:string)=>recipientHash(['wecom_directory',target.connectionId,target.appId,target.tenantId,target.identityNamespace,sourceId,authRevision,directoryUserId]);
 let recipientKey=target.kind==='wecom_directory'?directoryKey(target.sourceId,target.authRevision,target.directoryUserId):recipientHash(['channel',target.connectionId,target.provider,target.appId,target.tenantId,target.identityNamespace,target.userId]);
 if(target.provider==='wecom'){
  const record=store.one<{record_json:string}>('SELECT record_json FROM employee_channel_connections WHERE id=? AND workspace_id=? AND entity_id=?',target.connectionId,workspaceId,entityId),current=record?attachIdentityBindings(store,JSON.parse(record.record_json)as EmployeeChannelRecord):undefined;
  const valid=!!current&&usesWeComBotSearch(current)&&current.enabled&&current.status==='verified'&&current.workspaceId===workspaceId&&current.entityId===entityId&&current.id===target.connectionId&&current.appId===target.appId&&current.eventTenantId===target.tenantId&&target.identityNamespace==='user_id'&&(!reference||current.sourceId===reference.sourceId&&current.authRevision===reference.authRevision);
  let searchId:string|undefined,verified=false;
  if(valid&&current){
   if(target.kind==='wecom_directory'){
    searchId=target.directoryUserId;
    const callback=weComCallbackUserId(current,searchId);verified=!!callback&&weComSearchUserId(current,callback)===searchId;
   }else{
    const mapped=weComSearchUserId(current,target.userId);
    if(mapped&&weComCallbackUserId(current,mapped)===target.userId&&(!reference||reference.directoryUserId===mapped)){searchId=mapped;verified=true;}
   }
   if(searchId)recipientKey=directoryKey(current.sourceId,current.authRevision,searchId);
  }
  const contact=searchId&&current?store.one<{display_name:string}>('SELECT display_name FROM wecom_bot_contacts WHERE connection_id=? AND source_id=? AND auth_revision=? AND user_id=?',current.id,current.sourceId,current.authRevision,searchId):undefined;
  const label=contact?.display_name||(target.kind==='wecom_directory'?target.directoryUserId:target.userId);
  return{recipientKey,recipientLabel:label+' · '+(target.kind==='wecom_directory'&&!verified?'待验证':'企业微信')};
 }
 const person=store.one<{person_json:string}>('SELECT u.person_json FROM directory_snapshot_users u JOIN directory_sync_tasks t ON t.id=u.task_id WHERE t.workspace_id=? AND t.connection_id=? AND t.app_id=? AND t.invalidated=0 AND json_extract(u.person_json,\'$.id.id\')=? LIMIT 1',workspaceId,target.connectionId,target.appId,target.userId);
 return{recipientKey,recipientLabel:(person?JSON.parse(person.person_json).displayName:'渠道确认人')+' · '+target.provider};
}
/** Platform authenticates and proxies; it never opens the runtime business database. */
export function registerWorkItemRoutes(app:FastifyInstance,configuration:WorkItemConfiguration,options:{role?:'platform'|'runtime';reader:(r:FastifyRequest,w:string)=>string;manager:(r:FastifyRequest,w:string)=>string;relay?:(actor:string,path:string,request?:{method:'POST';body:unknown})=>Promise<unknown>;human?:()=>HumanConfirmation|undefined;runtime:()=>WorkItemsService|undefined}){
 const base='/api/workspaces/:workspaceId/work-items',runtime=()=>options.runtime()??(()=>{throw new TaskError(503,'work_item_runtime_unavailable');})();
 const remote=(actor:string,path:string)=>options.relay?.(actor,path)??Promise.reject(new TaskError(503,'work_item_runtime_unavailable'));
 app.get(base+'/settings',async r=>{const{workspaceId}=r.params as{workspaceId:string},actor=options.reader(r,workspaceId),configured=configuration.get(workspaceId);let effective;try{effective=options.role==='platform'?await remote(actor,base.replace(':workspaceId',encodeURIComponent(workspaceId))+'/status'):runtime().status(workspaceId);}catch{return{configured,effective:{enabled:false,available:false,error:'work_item_runtime_unavailable'}};}return{configured,effective:{...(effective as object),available:true}};});
 if(options.role!=='runtime')app.put(base+'/settings',r=>{const{workspaceId}=r.params as{workspaceId:string},actor=options.manager(r,workspaceId);return{configured:configuration.save(workspaceId,actor,r.body)};});
 app.get(base+'/status',r=>{const{workspaceId}=r.params as{workspaceId:string},actor=options.reader(r,workspaceId);return options.role==='platform'?remote(actor,r.url):runtime().status(workspaceId);});
 app.get(base+'/pending-human',r=>{const{workspaceId}=r.params as{workspaceId:string},actor=options.reader(r,workspaceId);if(options.role==='platform')return remote(actor,r.url);let manage=false;try{options.manager(r,workspaceId);manage=true;}catch{}const service=runtime(),human=options.human?.(),rows=service.store.all<{request_id:string;entity_id:string;target_json:string|null;selection_json:string|null;target_conversation_id:string|null;status:string;safe:number;notification_status:string;notification_error:string|null;updated_at:number;work_item_id:string|null}>("SELECT h.request_id,h.entity_id,h.target_json,h.selection_json,h.target_conversation_id,h.status,h.safe,h.notification_status,h.notification_error,h.updated_at,l.work_item_id FROM human_requests h LEFT JOIN work_item_task_links l ON l.task_id=h.task_id WHERE h.workspace_id=? AND h.status IN('waiting','confirmed') ORDER BY h.created_at DESC LIMIT 500",workspaceId);
  return{items:rows.flatMap(row=>{const target=row.target_json?JSON.parse(row.target_json)as HumanTarget:undefined,own=target?.kind==='web'&&target.userId===actor;if(!row.work_item_id&&!own&&!manage)return[];const item=row.work_item_id?service.detail(workspaceId,row.work_item_id,{limit:1}).item:undefined,pending=target?{}:pendingRecipient(service.store,workspaceId,row.entity_id,row.selection_json),selected=target??pending.target;
   const recipient=selected?recipientView(service.store,workspaceId,row.entity_id,selected):{recipientKey:pending.changed?recipientHash(['changed',row.request_id]):'unassigned',recipientLabel:pending.changed?'确认人配置已变更':'等待选择确认人'};
   return[{requestId:row.request_id,workItemId:row.work_item_id,title:item?.title??'待本人确认的问题',proposerEmployeeId:row.entity_id,...recipient,status:row.status,safe:row.safe===1,notificationStatus:row.notification_status,notificationError:row.notification_error,updatedAt:row.updated_at,canRetryNotification:manage&&!!human?.canRetryRecipient(row.request_id),canOpenConversation:own&&!!row.target_conversation_id,...(own?{conversationId:row.target_conversation_id}:{})}];})};
 });
 app.post(base+'/pending-human/:requestId/retry',async r=>{const{workspaceId,requestId}=r.params as{workspaceId:string;requestId:string},actor=options.manager(r,workspaceId);if(options.role==='platform')return options.relay?.(actor,r.url,{method:'POST',body:r.body})??Promise.reject(new TaskError(503,'work_item_runtime_unavailable'));const human=options.human?.();if(!human)throw new TaskError(503,'human_confirmation_unavailable');return human.retryRecipient(workspaceId,requestId,r.body);});
 app.get(base,r=>{const{workspaceId}=r.params as{workspaceId:string},actor=options.reader(r,workspaceId);return options.role==='platform'?remote(actor,r.url):runtime().list(workspaceId,r.query);});
 app.get(base+'/:workItemId',r=>{const p=r.params as{workspaceId:string;workItemId:string},actor=options.reader(r,p.workspaceId);return options.role==='platform'?remote(actor,r.url):runtime().detail(p.workspaceId,p.workItemId,r.query);});
}
