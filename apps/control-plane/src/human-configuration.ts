import type{FastifyInstance,FastifyRequest}from'fastify';
import{TaskError}from'@dentity/application';
import type{Store}from'./store.js';
import {channelSubject,type EmployeeChannelService}from'./employee-channels/service.js';
import type{HumanTarget}from'./human-confirmation.js';
import {resolveHumanTarget} from './human-target.js';
import type{CapabilityConfigService}from'./capability-config.js';
import {usesWeComBotSearch,weComSearchIdentityVerified,weComCallbackUserId,weComSearchUserId} from './employee-channels/wecom-bot-contacts.js';
/** Platform-owned rules. Opaque selectors are validated against this workspace's actual snapshots. */
export function registerHumanConfiguration(app:FastifyInstance,store:Store,channels:EmployeeChannelService,manager:(r:FastifyRequest,w:string,e:string)=>void,usage:Pick<CapabilityConfigService,'authorizeEntity'|'authorizeChannel'>){
 const base='/api/workspaces/:workspaceId/entities/:entityId/human-confirmation';
 const stored=(w:string,e:string)=>store.one<{version:number;rules_json:string}>('SELECT version,rules_json FROM employee_human_rules WHERE workspace_id=? AND entity_id=?',w,e);
 const candidates=(w:string,e:string)=>{
  const existing=JSON.parse(stored(w,e)?.rules_json??'[]') as {target:HumanTarget}[];
  const people:{label:string;target:HumanTarget;directorySubjectId?:string;identityVerified?:boolean}[]=store.all<{user_id:string;display_name:string;username:string}>("SELECT m.user_id,u.display_name,u.username FROM members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND m.status='active' AND u.status='active'",w).map(x=>({label:(x.display_name||x.username)+' · Web',target:{kind:'web',userId:x.user_id}}));
  for(const c of channels.repository.list(w,e)){if(!c.enabled||c.status!=='verified'||!c.eventTenantId)continue;
   if(usesWeComBotSearch(c)){
    const contacts=[...new Map([...channels.botContacts.recent(c),...channels.botContacts.retained(c)].map(person=>[person.user_id,person])).values()];
    const savedTargets=existing.map(x=>x.target).filter(target=>target.kind!=='web'&&target.connectionId===c.id&&target.provider==='wecom'&&target.appId===c.appId&&target.tenantId===c.eventTenantId&&target.identityNamespace==='user_id');
    for(const target of savedTargets){
     const searchId=target.kind==='wecom_directory'&&target.sourceId===c.sourceId&&target.authRevision===c.authRevision?target.directoryUserId:target.kind==='channel'?weComSearchUserId(c,target.userId):undefined;
     const contact=searchId?channels.botContacts.get(c,searchId):undefined;
     if(contact&&!contacts.some(person=>person.user_id===contact.user_id))contacts.push(contact);
    }
    for(const contact of contacts){
     const paths=JSON.parse(contact.department_paths) as string[],identityVerified=weComSearchIdentityVerified(c,contact.user_id),directorySubjectId=channelSubject('channel_user',contact.user_id,'user_id',c.appId),label=[contact.display_name,...paths,'企业微信',c.appId].join(' · ');
     people.push({label,directorySubjectId,identityVerified,target:{kind:'wecom_directory',connectionId:c.id,provider:'wecom',appId:c.appId,tenantId:c.eventTenantId,sourceId:c.sourceId,authRevision:c.authRevision,directoryUserId:contact.user_id,identityNamespace:'user_id'}});
     // Existing canonical rules remain editable, without rewriting them during GET.
     for(const target of savedTargets)if(target.kind==='channel'&&target.userId===weComCallbackUserId(c,contact.user_id))people.push({label,directorySubjectId,identityVerified,target});
    }
    continue;
   }
   if(c.provider==='wecom'||c.directoryStatus!=='available')continue;
   const rows=store.all<{person_json:string}>('SELECT u.person_json FROM directory_snapshot_users u JOIN directory_sync_tasks t ON t.id=u.task_id WHERE t.workspace_id=? AND t.invalidated=0 AND t.connection_id=?',w,c.id);
   for(const row of rows){const p=JSON.parse(row.person_json)as{displayName:string;id:{id:string;namespace:string;applicationId?:string};aliases:{id:string;namespace:string;applicationId?:string}[];status?:unknown};if(p.status==='inactive')continue;const ids=[p.id,...p.aliases];const id=ids.find(x=>x.namespace===(c.provider==='feishu'?'open_id':'user_id')&&(x.applicationId===undefined||x.applicationId===c.appId));if(!id||!id.id)continue;
    people.push({label:p.displayName+' · '+({feishu:'飞书',dingtalk:'钉钉',wecom:'企业微信'}[c.provider])+' · '+c.appId,target:{kind:'channel',connectionId:c.id,userId:id.id,identityNamespace:id.namespace as 'open_id'|'user_id',provider:c.provider,appId:c.appId,tenantId:c.eventTenantId}});
   }
  }return [...new Map(people.map(x=>[JSON.stringify(x.target),x])).values()];
 };
 app.get(base,request=>{const p=request.params as{workspaceId:string;entityId:string};manager(request,p.workspaceId,p.entityId);const row=stored(p.workspaceId,p.entityId);return{version:row?.version??0,rules:JSON.parse(row?.rules_json??'[]'),subjects:channels.subjects(p.workspaceId,p.entityId),candidates:candidates(p.workspaceId,p.entityId)};});
 // Fence local policy/identity changes across the asynchronous directory check. Directory
 // uncertainty still follows the existing usage evaluator's fail-closed cache semantics.
 const permissionVersion=(w:string,e:string,target:HumanTarget)=>JSON.stringify([store.one('SELECT lifecycle_enabled,own_web_use,web_use_user_id FROM entities WHERE workspace_id=? AND id=?',w,e),store.one('SELECT status FROM workspaces WHERE id=?',w),target.kind==='web'?[store.one('SELECT * FROM entity_web_policies WHERE workspace_id=? AND entity_id=?',w,e),store.one('SELECT m.status AS member_status,u.status AS user_status FROM members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND m.user_id=?',w,target.userId)]:[store.one('SELECT * FROM entity_directory_policies WHERE workspace_id=? AND entity_id=?',w,e),channels.currentBindingVersion(target.connectionId)]]);
 app.put(base,async request=>{const p=request.params as{workspaceId:string;entityId:string};manager(request,p.workspaceId,p.entityId);const body=request.body as{expectedVersion:number;rules:{questionScope:string;target:HumanTarget}[]};if(!body||Object.keys(body).some(k=>!['expectedVersion','rules'].includes(k))||!Number.isSafeInteger(body.expectedVersion)||!Array.isArray(body.rules)||body.rules.length>20)throw new TaskError(400,'invalid_human_rules');
  const allowed=candidates(p.workspaceId,p.entityId),seen=new Set<string>();for(const rule of body.rules){if(!rule||Object.keys(rule).some(k=>!['questionScope','target'].includes(k))||typeof rule.questionScope!=='string'||!rule.questionScope.trim()||rule.questionScope.length>100||seen.has(rule.questionScope)||!allowed.some(x=>JSON.stringify(x.target)===JSON.stringify(rule.target)))throw new TaskError(400,'invalid_human_recipient');seen.add(rule.questionScope);}
  const versions=body.rules.map(rule=>permissionVersion(p.workspaceId,p.entityId,rule.target));
  for(const rule of body.rules){try{
   const target=resolveHumanTarget(channels,p.workspaceId,p.entityId,rule.target);
   // Saving a pending directory choice grants no use or send permission. Normal
   // recipient authorization applies once a callback mapping actually exists.
   if(!target&&rule.target.kind==='wecom_directory')continue;
   if(!target)throw new TaskError(400,'invalid_human_recipient');
   if(target.kind==='web')usage.authorizeEntity({workspaceId:p.workspaceId,entityId:p.entityId,userId:target.userId});
   else{const binding=await channels.resolveBinding(target.connectionId);if(!binding||binding.workspaceId!==p.workspaceId||binding.entityId!==p.entityId||binding.appId!==target.appId||binding.provider!==target.provider||binding.connection.tenantId!==target.tenantId||!await usage.authorizeChannel({workspaceId:p.workspaceId,entityId:p.entityId,requesterKind:'channel_user',requesterId:target.userId,requesterIdentity:{idNamespace:target.identityNamespace,applicationId:target.appId},conversationKind:'private'},binding.connection,'private'))throw new TaskError(403,'human_recipient_use_forbidden');}
  }catch(error){if(error instanceof TaskError)throw error;if(error&&typeof error==='object'&&'code'in error&&error.code==='entity_use_forbidden')throw new TaskError(403,'human_recipient_use_forbidden');throw new TaskError(503,'human_recipient_permission_unavailable');}}
  return store.transaction(()=>{if(body.rules.some((rule,i)=>permissionVersion(p.workspaceId,p.entityId,rule.target)!==versions[i]))throw new TaskError(409,'human_recipient_permissions_changed');const old=store.one<{version:number}>('SELECT version FROM employee_human_rules WHERE workspace_id=? AND entity_id=?',p.workspaceId,p.entityId)?.version??0;if(old!==body.expectedVersion)throw new TaskError(409,'human_rules_changed');store.run('INSERT INTO employee_human_rules VALUES(?,?,?,?) ON CONFLICT(workspace_id,entity_id) DO UPDATE SET version=excluded.version,rules_json=excluded.rules_json',p.workspaceId,p.entityId,old+1,JSON.stringify(body.rules));return{version:old+1,rules:body.rules};});
 });
}
