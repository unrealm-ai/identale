import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DirectoryError} from '@dentity/application';
import {Store} from '../dist/store.js';
import {EmployeeChannelRepository} from '../dist/employee-channels/repository.js';
import {EmployeeChannelService,channelSubject} from '../dist/employee-channels/service.js';
import {EmployeeApplicationTransport} from '../dist/employee-channels/provider.js';
import {CapabilityConfigService} from '../dist/capability-config.js';
import {registerEmployeeChannelRoutes} from '../dist/employee-channels/routes.js';
import Fastify from 'fastify';
const known=value=>({status:'known',value});
const unknown={status:'unknown'};
const code=code=>error=>error.code===code;
function setup(t){
 const dir=mkdtempSync(join(tmpdir(),'identity-employee-channel-')),store=new Store(join(dir,'test.sqlite'));
 store.run("INSERT INTO users(id,username,display_name) VALUES('u','user','Owner'),('guest','guest','Member')");
 store.run("INSERT INTO workspaces(id,name,created_by) VALUES('w','Workspace','u'),('other','Other','u')");
 store.run("INSERT INTO members(id,workspace_id,user_id,role) VALUES('m','w','u','owner'),('g','w','guest','member')");
 store.run("INSERT INTO entities(id,workspace_id,name,owner_member_id,created_by_member_id,own_web_use,web_use_user_id,interaction_runtime) VALUES('e','w','Entity','m','m',1,'u','builtin'),('e2','w','Second','m','m',0,'u','builtin')");
 const state={clock:1800000000000,dept:'child',active:true,unknown:false,fail:null,calls:0,bot:true,tenant:true};
 const options={now:()=>state.clock,masterKey:new Uint8Array(32).fill(7),verifyApplication:async(provider,appId,secret)=>{if(secret.appSecret==='bad')throw new DirectoryError('authentication_failed');return{identity:{appId,tenantId:state.tenant?'tenant':appId,tenantIdNamespace:state.tenant?'tenant_key':'app_id'},...(state.bot?{botId:'bot-'+appId}:{}),...(state.tenant?{eventTenantId:'tenant'}:{}),directoryStatus:'available'};},adapterFactory:(provider,{appId})=>({provider,capabilities:{},verify:async()=>({appId,tenantId:'tenant',tenantIdNamespace:'tenant_key'}),getAuthorizedScope:async()=>({departmentIds:['root'],userIds:[],entireOrganization:false,revision:'1'}),getDepartment:async id=>({id,namespace:provider==='feishu'?'open_department_id':'department_id',displayName:id,parentId:state.unknown?unknown:known(id==='child'?'root':null),leaders:unknown}),listChildDepartments:async(id,cursor)=>({items:[{id:'child',namespace:'open_department_id',displayName:'Child',parentId:known(id),leaders:unknown}],exhausted:true}),listDepartmentMembers:async()=>({items:[],exhausted:true}),getUser:async id=>{state.calls++;if(state.fail)throw new DirectoryError(state.fail);return{id,displayName:'Person',status:state.active?'active':'inactive',departmentIds:[state.dept],departmentMembershipsKnown:!state.unknown,aliases:[],primaryDepartmentId:unknown,directManager:unknown,dottedLineManagers:unknown};}})};
 const repository=new EmployeeChannelRepository(store),service=new EmployeeChannelService(repository,options),capabilities=new CapabilityConfigService(store,[],service,undefined,undefined,undefined,()=>state.clock);
 service.setAccessCheck((...args)=>capabilities.authorizeChannel(...args));
 t.after(()=>{capabilities.close();store.close();rmSync(dir,{recursive:true,force:true});});return{store,state,options,repository,service,capabilities};
}
async function ready(f,provider='feishu',entity='e',appId='app'){const c=await f.service.save('w',entity,provider,'u',{appId,appSecret:'test-only-secret',expectedRevision:0});if(provider==='dingtalk')f.service.observeFirstInbound(c.id,{appId,botId:'bot-'+appId,tenantId:'tenant',tenantNamespace:'corp_id',robotCode:appId});return c;}
function rule(c,kind='department',subject='root',includeDescendants=true){return{sourceId:c.sourceId,kind,subjectId:channelSubject(kind,subject,kind==='department'?(c.provider==='feishu'?'open_department_id':'department_id'):(c.provider==='feishu'?'open_id':'user_id'),c.appId),...(kind==='department'?{includeDescendants}:{}),conversationKinds:['private','group']};}
function scope(c,user='person'){return{workspaceId:'w',entityId:'e',requesterId:user,requesterKind:'channel_user',requesterIdentity:{idNamespace:c.provider==='feishu'?'open_id':'user_id',applicationId:c.appId},conversationKind:'group'};}
function connection(c){return{workspaceId:'w',connectionId:c.id,provider:c.provider,tenantId:'tenant',identity:{kind:'bot',externalId:c.botId},credentialRef:'server-only'};}


import {ChannelTaskAuthorization} from '../dist/channel-loop/authorization.js';
function actor(c,id='outsider'){return{externalId:id,idNamespace:c.provider==='feishu'?'open_id':'user_id',applicationId:c.appId,kind:'human',identityEvidence:'channel_verified'};}
function taskScope(f,b,chat='group-a',id='outsider',kind='group'){return channelInvocationScope(b,{schemaVersion:1,origin:'live',connectionId:b.connectionId,tenantId:b.connection.tenantId,eventId:'event-'+chat,receivedAt:f.state.clock,message:{id:'message-'+chat,conversationKind:kind,conversation:{provider:b.provider,connectionId:b.connectionId,tenantId:b.connection.tenantId,kind:'conversation',externalId:chat,conversationKind:kind,...(kind==='private'?{privateRecipientId:id}:{})},author:{externalId:id,idNamespace:b.provider==='feishu'?'open_id':'user_id',applicationId:b.appId,kind:'human',identityEvidence:'channel_verified'},occurredAt:f.state.clock,text:'Synthetic group permission input',mentions:[]}});}
function open(f,extra={}){return f.capabilities.saveDirectoryAccess('w','e',{allow:[],deny:[],allowGroupMembers:true,...extra});}

test('new source defaults trusted group open; grants neither private/Web nor unproven group; disable invalidates immediately',async t=>{
 const f=setup(t),c=await ready(f),b=await f.service.resolveBinding(c.id),a=actor(c),s=taskScope(f,b);
 assert.equal(f.capabilities.getDirectoryAccess('w','e').channelPolicies.find(p=>p.sourceId===c.sourceId).allowGroupMembers,true);
 assert.equal(f.capabilities.getDirectoryAccess('w','e').channelPolicies.find(p=>p.sourceId===c.sourceId).mode,'allowlist');
 await f.service.authorizeInvocation(b,a,'group',s.source);
 open(f);await f.service.authorizeInvocation(b,a,'group',s.source);
 await assert.rejects(f.service.authorizeInvocation(b,a,'group'),code('channel_use_forbidden'));
 await assert.rejects(f.service.authorizeInvocation(b,a,'private',{...s.source,conversationKind:'private'}),code('channel_use_forbidden'));
 assert.throws(()=>f.capabilities.authorizeEntity({workspaceId:'w',entityId:'e',userId:'guest'}),code('entity_use_forbidden'));
 f.capabilities.saveDirectoryAccess('w','e',{allow:[],deny:[],allowGroupMembers:false});
 await assert.rejects(f.service.authorizeInvocation(b,a,'group',s.source),code('channel_use_forbidden'));
});
test('old client preserves setting; boolean validation, revision/CAS and transaction rollback',t=>{
 const f=setup(t);assert.throws(()=>open(f,{allowGroupMembers:'true'}),code('invalid_capability_configuration'));
 const a=open(f);assert.equal(a.allowGroupMembers,true);
 assert.throws(()=>open(f,{expectedRevision:0}),code('directory_policy_changed'));
 assert.equal(f.capabilities.saveDirectoryAccess('w','e',{allow:[],deny:[]}).allowGroupMembers,true);
 assert.throws(()=>f.store.transaction(()=>{open(f,{allowGroupMembers:false});throw Error('rollback');}));
 assert.equal(f.capabilities.getDirectoryAccess('w','e').allowGroupMembers,true);
});
test('original personal/department grants still work in private/group; group opening skips positive-list lookup for outsiders',async t=>{
 const f=setup(t),c=await ready(f),b=await f.service.resolveBinding(c.id),s=taskScope(f,b),a=actor(c);
 open(f,{allow:[rule(c)]});await f.service.authorizeInvocation(b,a,'private',{...s.source,conversationKind:'private'});
 f.state.dept='elsewhere';open(f,{allow:[rule(c)]});const before=f.state.calls;
 await f.service.authorizeInvocation(b,a,'group',s.source);assert.equal(f.state.calls,before);
 await assert.rejects(f.service.authorizeInvocation(b,a,'private',{...s.source,conversationKind:'private'}),code('channel_use_forbidden'));
});
test('existing scene-specific deny wins; unknown deny fails closed and never becomes cached allow',async t=>{
 const f=setup(t),c=await ready(f),b=await f.service.resolveBinding(c.id),s=taskScope(f,b),a=actor(c);
 open(f,{deny:[rule(c)]});await assert.rejects(f.service.authorizeInvocation(b,a,'group',s.source),code('channel_use_forbidden'));
 open(f,{deny:[{...rule(c),conversationKinds:['private']}]});await f.service.authorizeInvocation(b,a,'group',s.source);
 f.state.unknown=true;open(f,{deny:[rule(c)]});await assert.rejects(f.service.authorizeInvocation(b,a,'group',s.source),code('channel_use_forbidden'));
 f.state.unknown=false;await assert.rejects(f.service.authorizeInvocation(b,a,'group',s.source),code('channel_use_forbidden'));
});
test('formal TaskAuthorization carries trusted group and narrows inherited/restrict packages without global grants',async t=>{
 const f=setup(t),c=await ready(f),b=await f.service.resolveBinding(c.id),s=taskScope(f,b);open(f);
 const pack=(name,extra={})=>f.capabilities.save('w','e',{name,enabled:true,mode:'inherit',allowMemberIds:[],denyMemberIds:[],resourceIds:[],conversationKinds:['group'],...extra});
 const inherit=pack('inherited'),whitelist=pack('restricted',{mode:'restrict',directoryAccess:{allow:[rule(c,'channel_user','somebody')],deny:[]}});
 pack('private only',{conversationKinds:['private']});pack('disabled',{enabled:false});pack('denied',{directoryAccess:{allow:[],deny:[rule(c)]}});
 const auth=new ChannelTaskAuthorization(f.store,f.capabilities,f.service,()=>f.state.clock);
 await auth.refreshAuthorization(s);auth.authorizeEntity(s);const snap=await auth.resolveForTask(s);assert.deepEqual(snap.packages.map(p=>p.id),[inherit.id]);auth.validatePreparedSnapshot(s,snap);
 const named=taskScope(f,b,'group-a','somebody');await auth.refreshAuthorization(named);const selected=await auth.resolveForTask(named);assert.ok(selected.packages.some(p=>p.id===whitelist.id));
 await assert.rejects(auth.refreshAuthorization({...s,source:{...s.source,conversationKind:'private'}}),code('channel_use_forbidden'));
 open(f,{allowGroupMembers:false});assert.throws(()=>auth.authorizeEntity(s),code('channel_authorization_required'));
});
test('group proof, binding/app/tenant/namespace and lifecycle are checked even on warm cache',async t=>{
 const f=setup(t),c=await ready(f),b=await f.service.resolveBinding(c.id),s=taskScope(f,b),a=actor(c);open(f);
 await f.service.authorizeInvocation(b,a,'group',s.source);
 for(const diff of [{tenantId:'other'},{applicationId:'other'},{bindingVersion:'old'},{connectionId:'other'},{conversationId:''}])await assert.rejects(f.service.authorizeInvocation(b,a,'group',{...s.source,...diff}),code('channel_use_forbidden'));
 await assert.rejects(f.service.authorizeInvocation(b,{...a,idNamespace:'unknown'},'group',s.source),code('channel_use_forbidden'));
 const groupScope={...scope(c,'outsider'),groupContext:{conversationId:'a',bindingVersion:b.bindingVersion}};
 const seen=[],original=f.capabilities.admissionCache.put.bind(f.capabilities.admissionCache);f.capabilities.admissionCache.put=(...args)=>{seen.push(args[1]);return original(...args);};
 await f.capabilities.authorizeChannel(groupScope,connection(c),'group');await f.capabilities.authorizeChannel({...groupScope,groupContext:{...groupScope.groupContext,conversationId:'b'}},connection(c),'group');assert.equal(new Set(seen).size,2);
 f.store.run('UPDATE entities SET lifecycle_enabled=0 WHERE id=?','e');await assert.rejects(f.service.authorizeInvocation(b,a,'group',s.source),code('employee_disabled'));
 f.store.run('UPDATE entities SET lifecycle_enabled=1 WHERE id=?','e');f.service.settings('w','e','feishu','u',{enabled:false,expectedRevision:c.revision});await assert.rejects(f.service.authorizeInvocation(b,a,'group',s.source),code('channel_use_forbidden'));
});
test('old async allow cannot return or refill after group flag/deny change',async t=>{
 const f=setup(t),c=await ready(f),b=await f.service.resolveBinding(c.id),s=taskScope(f,b),a=actor(c);open(f,{deny:[rule(c,'channel_user','unrelated')]});
 const matches=f.service.matches.bind(f.service);let release,started;const waiting=new Promise(r=>release=r),entered=new Promise(r=>started=r);let once=true;
 f.service.matches=async(...args)=>{if(once){once=false;started();await waiting;return false;}return matches(...args);};
 const pending=f.service.authorizeInvocation(b,a,'group',s.source);await entered;open(f,{allowGroupMembers:false});release();await assert.rejects(pending,code('channel_use_forbidden'));
 await assert.rejects(f.service.authorizeInvocation(b,a,'group',s.source),code('channel_use_forbidden'));
});
test('Feishu ordinary grant comes only from verified tenant scope inventory; keyword save never grants it',async t=>{
 const f=setup(t),c=await ready(f);let next=f.service.settings('w','e','feishu','u',{enabled:true,expectedRevision:c.revision,groupTriggerKeywords:['  HELLO  ','hello','需求']});assert.deepEqual(next.context.groupTriggerKeywords,['hello','需求']);
 let b=await f.service.resolveBinding(c.id);assert.equal((await b.conversation.inspectCapabilities()).ordinaryMessageEvents.availability,'authorization_required');
 for(const status of ['denied','unverified','granted']){const r=f.repository.byId(c.id);r.validation={version:1,provider:'feishu',checkedAt:f.state.clock,canContinue:true,checks:[{id:'scope_inventory',required:false,supported:true,status:'pass',scopeInventory:[{scope:'im:message.group_msg',identity:'tenant',status}]}]};assert.ok(f.repository.save(r,f.repository.byId(c.id)));b=await f.service.resolveBinding(c.id);assert.equal((await b.conversation.inspectCapabilities()).ordinaryMessageEvents.availability,status==='granted'?'available':'authorization_required');}
 for(const words of [[''],Array(21).fill('x'),['x'.repeat(81)],['line\nbreak']])assert.throws(()=>f.service.settings('w','e','feishu','u',{enabled:true,expectedRevision:next.revision,groupTriggerKeywords:words}),code('invalid_group_trigger_keywords'));
});

test('group opening is a second allow route; a private-only allow is not a global group prohibition',async t=>{
 const f=setup(t),c=await ready(f),b=await f.service.resolveBinding(c.id),s=taskScope(f,b),a=actor(c);
 open(f,{allow:[{...rule(c,'channel_user','somebody'),conversationKinds:['private']}]});await f.service.authorizeInvocation(b,a,'group',s.source);
 await assert.rejects(f.service.authorizeInvocation(b,a,'private',{...s.source,conversationKind:'private'}),code('channel_use_forbidden'));
 const saved=f.capabilities.getDirectoryAccess('w','e');assert.deepEqual(saved.allow[0].conversationKinds,['private']);
 assert.equal(saved.deny.length,0);
});

// The same real employee service + policy + SQLite path is used in every row.
const employeeMatrix=[
 ['closed empty group',false,'group',[],[],{},false],
 ['open empty group',true,'group',[],[],{},true],
 ['open empty private',true,'private',[],[],{},false],
 ['closed named person group',false,'group',[['channel_user','person']],[],{},true],
 ['closed other person',false,'group',[['channel_user','other']],[],{},false],
 ['closed direct department',false,'group',[['department','child',false]],[],{},true],
 ['closed parent excludes descendants',false,'group',[['department','root',false]],[],{},false],
 ['closed parent includes descendants',false,'group',[['department','root',true]],[],{},true],
 ['unknown department stays closed',false,'group',[['department','root',true]],[],{unknown:true},false],
 ['open is independent of positive unknown department',true,'group',[['department','root',true]],[],{unknown:true},true],
 ['person conflict denied',true,'group',[['channel_user','person']],[['channel_user','person']],{},false],
 ['unrelated deny does not exclude group member',true,'group',[],[['channel_user','other']],{},true],
 ['parent deny includes descendants',true,'group',[],[['department','root',true]],{},false],
 ['parent deny excludes descendants',true,'group',[],[['department','root',false]],{},true],
 ['unknown deny remains conservative',true,'group',[],[['department','root',true]],{unknown:true},false],
 ['private-only deny does not match group',true,'group',[],[['channel_user','person',false,['private']]],{},true],
 ['group-only deny does not match private named grant',true,'private',[['channel_user','person']],[['channel_user','person',false,['group']]],{},true],
 ['private-only allow closed group',false,'group',[['channel_user','person',false,['private']]],[],{},false],
 ['private-only allow plus group opening',true,'group',[['channel_user','person',false,['private']]],[],{},true],
 ['group-only allow cannot grant private',true,'private',[['channel_user','person',false,['group']]],[],{},false],
 ['named grant private independent of group switch',false,'private',[['channel_user','person']],[],{},true],
];
for(const [name,enabled,kind,allow,deny,state,expected]of employeeMatrix)test('employee permission matrix: '+name,async t=>{
 const f=setup(t),c=await ready(f),b=await f.service.resolveBinding(c.id),s=taskScope(f,b,'matrix','person',kind);Object.assign(f.state,state);
 const rules=items=>items.map(([type,id,desc=true,kinds=['private','group']])=>({...rule(c,type,id,desc),conversationKinds:kinds}));
 open(f,{allowGroupMembers:enabled,allow:rules(allow),deny:rules(deny)});
 const auth=new ChannelTaskAuthorization(f.store,f.capabilities,f.service,()=>f.state.clock);
 if(expected){await auth.refreshAuthorization(s);assert.doesNotThrow(()=>auth.authorizeEntity(s));}else await assert.rejects(auth.refreshAuthorization(s),code('channel_use_forbidden'));
});
const packageMatrix=[
 ['inherited group',{},true],['disabled',{enabled:false},false],['private package',{conversationKinds:['private']},false],['no scenes',{conversationKinds:[]},false],
 ['inherited person deny',{deny:[['channel_user','person']]},false],['inherited department deny',{deny:[['department','root',true]]},false],
 ['inherited private deny does not match group',{deny:[['channel_user','person',false,['private']]]},true],
 ['restricted empty',{mode:'restrict'},false],['restricted person',{mode:'restrict',allow:[['channel_user','person']]},true],
 ['restricted department descendants',{mode:'restrict',allow:[['department','root',true]]},true],
 ['restricted unrelated',{mode:'restrict',allow:[['channel_user','other']]},false],
 ['restricted allow denied',{mode:'restrict',allow:[['channel_user','person']],deny:[['channel_user','person']]},false],
 ['restricted allow private-only',{mode:'restrict',allow:[['channel_user','person',false,['private']]]},false],
 ['unknown package deny',{deny:[['department','root',true]],unknown:true},false],
 ['unknown restricted allow',{mode:'restrict',allow:[['department','root',true]],unknown:true},false],
];
for(const [name,options,expected]of packageMatrix)test('package permission matrix after group admission: '+name,async t=>{
 const f=setup(t),c=await ready(f),b=await f.service.resolveBinding(c.id),s=taskScope(f,b,'matrix','person');open(f);f.state.unknown=options.unknown??false;
 const rules=items=>(items??[]).map(([type,id,desc=true,kinds=['private','group']])=>({...rule(c,type,id,desc),conversationKinds:kinds}));
 const p=f.capabilities.save('w','e',{name,enabled:options.enabled??true,mode:options.mode??'inherit',allowMemberIds:[],denyMemberIds:[],resourceIds:[],conversationKinds:options.conversationKinds??['group'],directoryAccess:{allow:rules(options.allow),deny:rules(options.deny)}});
 const auth=new ChannelTaskAuthorization(f.store,f.capabilities,f.service,()=>f.state.clock);await auth.refreshAuthorization(s);const result=await auth.resolveForTask(s);assert.equal(result.packages.some(x=>x.id===p.id),expected);
});

import {TaskService,channelInvocationScope} from '@dentity/application';
import {SqliteTaskRepository} from '../dist/adapters/sqlite/task-repository.js';
import {SqliteConversationRepository} from '../dist/adapters/sqlite/conversation-repository.js';
import {JsonlJournal} from '@dentity/runtime-builtin';
import {dirname} from 'node:path';
class MockRuntime {idempotentDispatch=true;async dispatch(){return{status:'accepted'};}async input(){return{status:'received'};}async cancel(){return{status:'confirmed'};}async events(){return[];}}
test('formal TaskService creates one Run for group member, pins only allowed packages and does not reauthorize already admitted input',async t=>{
 const f=setup(t),c=await ready(f),b=await f.service.resolveBinding(c.id),source=taskScope(f,b,'group-formal','person');open(f);
 const include=f.capabilities.save('w','e',{name:'inherited',enabled:true,mode:'inherit',allowMemberIds:[],denyMemberIds:[],resourceIds:[],conversationKinds:['group']});
 f.capabilities.save('w','e',{name:'restricted',enabled:true,mode:'restrict',allowMemberIds:[],denyMemberIds:[],resourceIds:[],conversationKinds:['group']});
 const journal=new JsonlJournal({root:join(dirname(f.store.databasePath),'records'),ownerId:'group-fixture',serialize:fn=>f.store.transaction(fn)}),conversations=new SqliteConversationRepository(f.store,journal,()=>f.state.clock);conversations.initialize(0);conversations.create('formal-group',source,'formal-conversation',f.state.clock,'real',0);
 const auth=new ChannelTaskAuthorization(f.store,f.capabilities,f.service,()=>f.state.clock),tasks=new TaskService(new SqliteTaskRepository(f.store),()=>f.state.clock,new MockRuntime(),auth,undefined,conversations),s={...source,conversationId:'formal-group'},body={operationId:'formal-create',input:'Synthetic authorized group task',contextMode:'new'};
 const created=await tasks.create(s,body);assert.ok(created.run?.id);assert.equal((await tasks.create(s,body)).id,created.id);assert.equal(f.store.one('SELECT count(*) n FROM runs').n,1);
 const snapshot=JSON.parse(f.store.one('SELECT config_snapshot_json FROM tasks WHERE id=?',created.id).config_snapshot_json);assert.deepEqual(snapshot.packages.map(p=>p.id),[include.id]);
 open(f,{allowGroupMembers:false});await assert.rejects(tasks.create(s,{...body,operationId:'new-unadmitted'}),code('channel_use_forbidden'));
 const alreadyAdmitted=await tasks.create(s,{...body,operationId:'already-admitted'},true);assert.ok(alreadyAdmitted.run?.id);
});

test('warm decisions isolate same external ID by namespace, tenant, application and employee',async t=>{
 const f=setup(t),c=await ready(f),b=await f.service.resolveBinding(c.id),s=taskScope(f,b);open(f);
 const seen=[],put=f.capabilities.admissionCache.put.bind(f.capabilities.admissionCache);f.capabilities.admissionCache.put=(...args)=>{seen.push(args[1]);return put(...args);};
 await f.service.authorizeInvocation(b,actor(c),'group',s.source);await f.service.authorizeInvocation(b,{...actor(c),idNamespace:'user_id'},'group',s.source);assert.equal(new Set(seen).size,2);
 const original=f.options.verifyApplication;f.options.verifyApplication=async(...args)=>({...await original(...args),identity:{appId:'app2',tenantId:'tenant2',tenantIdNamespace:'tenant_key'},eventTenantId:'tenant2'});
 const c2=await ready(f,'feishu','e2','app2'),b2=await f.service.resolveBinding(c2.id),scope2=taskScope(f,b2);scope2.entityId='e2';
 f.capabilities.saveDirectoryAccess('w','e2',{allow:[],deny:[],allowGroupMembers:false});
 await assert.rejects(f.service.authorizeInvocation(b2,actor(c2),'group',scope2.source),code('channel_use_forbidden'));
 f.capabilities.saveDirectoryAccess('w','e2',{allow:[],deny:[],allowGroupMembers:true});await f.service.authorizeInvocation(b2,actor(c2),'group',scope2.source);
 open(f,{allowGroupMembers:false});await assert.rejects(f.service.authorizeInvocation(b,actor(c),'group',s.source),code('channel_use_forbidden'));
});
test('group decision retains fixed one-hour membership TTL, hit never renews it; employee policy edits invalidate immediately',async t=>{
 const f=setup(t),c=await ready(f),b=await f.service.resolveBinding(c.id),s=taskScope(f,b),a=actor(c);f.state.dept='elsewhere';open(f,{deny:[rule(c)]});
 await f.service.authorizeInvocation(b,a,'group',s.source);f.state.dept='child';f.state.clock+=1800000;await f.service.authorizeInvocation(b,a,'group',s.source);
 f.state.clock+=1800000;await assert.rejects(f.service.authorizeInvocation(b,a,'group',s.source),code('channel_use_forbidden'));
 open(f);await f.service.authorizeInvocation(b,a,'group',s.source);open(f,{deny:[rule(c)]});await assert.rejects(f.service.authorizeInvocation(b,a,'group',s.source),code('channel_use_forbidden'));
});

import {ChannelMessageLoop,createInteractionService} from '@dentity/application';
import {SqliteMessageLoopRepository} from '../dist/channel-loop/repository.js';
import {createBuiltinInteractionProvider} from '../dist/adapters/builtin-interaction-provider.js';
test('combined keyword ingress → real employee group admission → builtin task tool → inherited/restricted package snapshot', {timeout:30000},async t=>{
 let loop,provider;t.after(async()=>{await loop?.stop();await provider?.shutdown();});
 const f=setup(t),verify=f.options.verifyApplication,requests=[];f.options.verifyApplication=async(...args)=>({...await verify(...args),validation:{version:1,provider:'feishu',checkedAt:f.state.clock,canContinue:true,checks:[{id:'scope_inventory',required:false,supported:true,status:'pass',scopeInventory:[{scope:'im:message.group_msg',identity:'tenant',status:'granted'}]}]}});
 // Existing vendor HTTP fixture convention: only synthetic token and outbound ACK, no network.
 f.options.fetch=async(url,init)=>{requests.push(String(url));assert.ok(String(url).startsWith('https://open.feishu.cn/'));return new Response(JSON.stringify(String(url).includes('/auth/')?{code:0,tenant_access_token:'synthetic-group-token',expire:7200}:{code:0,data:{message_id:'synthetic-group-reply'}}));};
 const c=await ready(f);f.service.settings('w','e','feishu','u',{enabled:true,expectedRevision:c.revision,groupTriggerKeywords:['help']});open(f);
 const inherited=f.capabilities.save('w','e',{name:'inherited',enabled:true,mode:'inherit',allowMemberIds:[],denyMemberIds:[],resourceIds:[],conversationKinds:['group']});
 const restricted=f.capabilities.save('w','e',{name:'restricted',enabled:true,mode:'restrict',allowMemberIds:[],denyMemberIds:[],resourceIds:[],conversationKinds:['group'],directoryAccess:{allow:[rule(c,'channel_user','someone-else')],deny:[]}});
 const journal=new JsonlJournal({root:join(dirname(f.store.databasePath),'combined-records'),ownerId:'combined-group',serialize:fn=>f.store.transaction(fn)}),conversations=new SqliteConversationRepository(f.store,journal,()=>f.state.clock);conversations.initialize(0);
 const auth=new ChannelTaskAuthorization(f.store,f.capabilities,f.service,()=>f.state.clock),tasks=new TaskService(new SqliteTaskRepository(f.store),()=>f.state.clock,new MockRuntime(),auth,undefined,conversations),models=[];
 provider=createBuiltinInteractionProvider(f.store,conversations,tasks,()=>f.state.clock,{getRuntimeDefinition(){return{name:'Synthetic group helper',description:'isolated test',interactionRuntime:'builtin-interaction'};}},{journal,readAdmittedInput:id=>f.store.one('SELECT input_text FROM channel_inbox WHERE id=?',id)?.input_text??'',modelClient:{async complete(input){models.push(input);return input.messages.at(-1).role==='tool'?{text:'Synthetic task accepted',usage:{inputTokens:1,outputTokens:1}}:{toolCalls:[{id:'group-task-create',name:'task_create',arguments:{input:'Synthetic group work'}}],usage:{inputTokens:1,outputTokens:1}};}}});
 const interaction=createInteractionService(conversations,tasks,provider,()=>f.state.clock),repository=new SqliteMessageLoopRepository(f.store,()=>f.state.clock);
 loop=new ChannelMessageLoop(repository,{resolveBinding:id=>f.service.resolveBinding(id),currentBindingVersion:id=>f.service.currentBindingVersion(id),authorizeInvocation:(...args)=>f.service.authorizeInvocation(...args)},interaction,tasks,()=>f.state.clock);
 const b=await f.service.resolveBinding(c.id),s=taskScope(f,b,'combined-group','outsider'),event={schemaVersion:1,eventId:'combined-event',connectionId:c.id,tenantId:'tenant',receivedAt:f.state.clock,origin:'live',message:{id:'combined-message',conversationKind:'group',conversation:{provider:'feishu',connectionId:c.id,tenantId:'tenant',kind:'conversation',externalId:'combined-group',conversationKind:'group'},author:actor(c),occurredAt:f.state.clock,text:'Please HELP with this',mentions:[]}};
 assert.equal(s.principal.externalUserId,'outsider');assert.equal((await loop.acceptAuthenticatedEvent(c.id,event)).status,'created');assert.equal((await loop.acceptAuthenticatedEvent(c.id,{...event,eventId:'redelivery'})).status,'duplicate');
 for(let i=0;i<40;i++){await loop.tick();await loop.waitForWork();if(f.store.one('SELECT count(*) n FROM tasks').n===1&&models.length>=2)break;await new Promise(setImmediate);}
 assert.equal(f.store.one('SELECT count(*) n FROM tasks').n,1);assert.ok(models.length>=2,'builtin completed task tool and final response');
 const task=f.store.one('SELECT config_snapshot_json,source_json FROM tasks'),snapshot=JSON.parse(task.config_snapshot_json);assert.deepEqual(snapshot.packages.map(p=>p.id),[inherited.id]);assert.ok(!snapshot.packages.some(p=>p.id===restricted.id));assert.equal(JSON.parse(task.source_json).source.conversationId,'combined-group');
 assert.equal(f.store.one('SELECT count(*) n FROM runs').n,1);assert.ok(models[1].messages.filter(m=>m.role==='tool').every(m=>!m.content.includes('channel_use_forbidden')));assert.ok(requests.every(url=>!url.includes('model')));
});

test('DingTalk trusted group opening, deny priority and inherited execution scope use real user_id without opening private/Web',async t=>{const f=setup(t),c=await ready(f,'dingtalk'),b=await f.service.resolveBinding(c.id),s=taskScope(f,b),a=actor(c);f.capabilities.patchDirectoryAccess('w','e',{sourceId:c.sourceId,allow:[],allowGroupMembers:true,expectedRevision:f.capabilities.getDirectoryAccess('w','e').channelPolicies.find(p=>p.sourceId===c.sourceId).revision});await f.service.authorizeInvocation(b,a,'group',s.source);await assert.rejects(f.service.authorizeInvocation(b,a,'private',{...s.source,conversationKind:'private'}),code('channel_use_forbidden'));await assert.rejects(f.service.authorizeInvocation(b,a,'group',{...s.source,bindingVersion:'old'}),code('channel_use_forbidden'));const inherited=f.capabilities.save('w','e',{name:'Ding group',enabled:true,mode:'inherit',allowMemberIds:[],denyMemberIds:[],resourceIds:[],conversationKinds:['group']});const auth=new ChannelTaskAuthorization(f.store,f.capabilities,f.service,()=>f.state.clock);await auth.refreshAuthorization(s);assert.deepEqual((await auth.resolveForTask(s)).packages.map(p=>p.id),[inherited.id]);open(f,{deny:[rule(c)]});await assert.rejects(f.service.authorizeInvocation(b,a,'group',s.source),code('channel_use_forbidden'));});

for(const legacyMode of ['restrict','inherit'])test('legacy '+legacyMode+' package toggle → edit → save preserves projected source restrictions',async t=>{
 const f=setup(t),c=await ready(f),b=await f.service.resolveBinding(c.id);open(f);
 const allow=[rule(c,'channel_user','person')],deny=[rule(c,'channel_user','blocked')];
 let dto=f.capabilities.save('w','e',{name:'Legacy source policy',enabled:true,mode:legacyMode,allowMemberIds:[],denyMemberIds:[],resourceIds:[],directoryAccess:{allow,deny}});
 const expected={sourceId:c.sourceId,mode:legacyMode==='restrict'?'allowlist':'denylist',allow,deny,...(legacyMode==='inherit'?{legacyAllowCheck:true}:{})};
 const policy=value=>value.directoryAccess.channelPolicies.find(p=>p.sourceId===c.sourceId);
 const assertAccess=async()=>{
  for(const [person,allowed]of [['person',true],['blocked',false],['outsider',legacyMode==='inherit']]){
   const s={...scope(c,person),groupContext:{conversationId:'source-policy',bindingVersion:b.bindingVersion}};
   assert.equal((await f.capabilities.usableChannel(s,b.connection,'group')).some(p=>p.id===dto.id),allowed,person);
  }
 };
 assert.deepEqual(policy(dto),expected,'create response carries the same projection as list');
 assert.deepEqual(dto,f.capabilities.list('w','e').find(p=>p.id===dto.id));
 assert.equal(JSON.parse(f.store.one('SELECT config_json FROM capability_packages WHERE id=?',dto.id).config_json).directoryAccess.channelPolicies,undefined,'fixture is an actual legacy package');
 await assertAccess();
 for(const enabled of [false,true]){
  dto=f.capabilities.setEnabled({workspaceId:'w',entityId:'e',userId:'u'},dto.id,{enabled,expectedVersion:dto.version});
  assert.deepEqual(policy(dto),expected,'toggle response must not replace the source policy with inherit');
  assert.deepEqual(dto,f.capabilities.list('w','e').find(p=>p.id===dto.id));
 }
 await assertAccess();
 // Simulate the editor replacing its DTO with the toggle response, editing only the name,
 // and echoing its complete channel policy payload to the save endpoint.
 const {id,workspaceId,entityId,version,...edit}=dto;
 dto=f.capabilities.save(workspaceId,entityId,{...edit,name:'Only the name changed',expectedVersion:version},id);
 assert.deepEqual(policy(dto),expected);assert.deepEqual(dto.directoryAccess.allow,allow);assert.deepEqual(dto.directoryAccess.deny,deny);
 assert.deepEqual(dto,f.capabilities.list('w','e').find(p=>p.id===dto.id));
 await assertAccess();
});

for(const provider of ['feishu','dingtalk','wecom'])test(provider+' durable admitted input survives employee revocation; new calls, package/resource/binding checks remain enforced',async t=>{
 let loop;t.after(async()=>{await loop?.stop();});
 const f=setup(t),c=await ready(f,provider);
 if(provider==='wecom')f.service.observeFirstInbound(c.id,{appId:c.appId,botId:c.appId,tenantId:c.appId,tenantNamespace:'app_id'});
 const b=await f.service.resolveBinding(c.id);assert.ok(b);
 const policy=()=>f.capabilities.getDirectoryAccess('w','e').channelPolicies.find(p=>p.sourceId===c.sourceId);
 f.capabilities.patchDirectoryAccess('w','e',{sourceId:c.sourceId,mode:'all',allow:[],deny:[],allowGroupMembers:false,expectedRevision:policy().revision});
 const resource={id:'admitted-skill',kind:'skill',shared:true,resourceId:'approved-summary',version:'1',digest:'a'.repeat(64)};
 f.capabilities.replaceApprovedResources([resource]);
 let pack=f.capabilities.save('w','e',{name:'Current capability',enabled:true,mode:'inherit',allowMemberIds:[],denyMemberIds:[],resourceIds:[resource.id]});
 const journal=new JsonlJournal({root:join(dirname(f.store.databasePath),'admitted-records'),ownerId:'admitted-'+provider,serialize:fn=>f.store.transaction(fn)}),conversations=new SqliteConversationRepository(f.store,journal,()=>f.state.clock);conversations.initialize(0);
 const auth=new ChannelTaskAuthorization(f.store,f.capabilities,f.service,()=>f.state.clock),tasks=new TaskService(new SqliteTaskRepository(f.store),()=>f.state.clock,new MockRuntime(),auth,undefined,conversations);
 const repository=new SqliteMessageLoopRepository(f.store,()=>f.state.clock);repository.setClaimFilter(()=>false);
 loop=new ChannelMessageLoop(repository,f.service,{},tasks,()=>f.state.clock);
 const event={schemaVersion:1,eventId:'admitted-event',connectionId:c.id,tenantId:b.connection.tenantId,receivedAt:f.state.clock,origin:'live',message:{id:'admitted-message',conversationKind:'private',conversation:{provider,connectionId:c.id,tenantId:b.connection.tenantId,kind:'conversation',externalId:'admitted-chat',conversationKind:'private',privateRecipientId:'person'},author:actor(c,'person'),occurredAt:f.state.clock,text:'Synthetic admitted work',mentions:[]}};
 assert.equal((await loop.acceptAuthenticatedEvent(c.id,event)).status,'created');
 const queued=f.store.one('SELECT scope_json,employee_use_admitted FROM channel_inbox');assert.equal(queued.employee_use_admitted,1);
 const admittedScope=JSON.parse(queued.scope_json);conversations.create('admitted-conversation',admittedScope,'admitted-operation',f.state.clock,'real',0);
 const scope={...admittedScope,conversationId:'admitted-conversation'},body={operationId:'after-employee-revocation',input:'Synthetic admitted work',contextMode:'new'};
 f.capabilities.patchDirectoryAccess('w','e',{sourceId:c.sourceId,mode:'allowlist',allow:[],deny:[],allowGroupMembers:false,expectedRevision:policy().revision});
 await assert.rejects(auth.resolveForTask(scope),code('entity_use_forbidden'));
 await assert.rejects(tasks.create(scope,{...body,employeeUseAdmitted:true}),code('channel_use_forbidden'),'body fields cannot forge the host-only receipt');
 const created=await tasks.create(scope,body,true);assert.ok(created.run?.id);
 const snapshot=JSON.parse(f.store.one('SELECT config_snapshot_json FROM tasks WHERE id=?',created.id).config_snapshot_json);
 assert.deepEqual(snapshot.packages.map(p=>p.id),[pack.id]);assert.deepEqual(snapshot.resources.map(r=>r.resource.id),[resource.id]);
 // An employee-policy-only edit during preparation does not revoke this durable input.
 const prepared=await auth.resolveForTask(scope,{employeeUseAdmitted:true});
 f.capabilities.patchDirectoryAccess('w','e',{sourceId:c.sourceId,allowGroupMembers:true,expectedRevision:policy().revision});
 assert.doesNotThrow(()=>auth.validatePreparedSnapshot(scope,prepared));
 pack=f.capabilities.setEnabled({workspaceId:'w',entityId:'e',userId:'u'},pack.id,{enabled:false,expectedVersion:pack.version});
 assert.throws(()=>auth.validatePreparedSnapshot(scope,prepared),code('capability_configuration_changed'));
 const narrowed=await auth.resolveForTask(scope,{employeeUseAdmitted:true});assert.deepEqual(narrowed.packages,[]);assert.deepEqual(narrowed.resources,[]);
 pack=f.capabilities.setEnabled({workspaceId:'w',entityId:'e',userId:'u'},pack.id,{enabled:true,expectedVersion:pack.version});
 const resourceSnapshot=await auth.resolveForTask(scope,{employeeUseAdmitted:true});f.capabilities.replaceApprovedResources([]);
 assert.throws(()=>auth.validatePreparedSnapshot(scope,resourceSnapshot),code('capability_configuration_changed'));
 await assert.rejects(tasks.create(scope,{...body,operationId:'removed-resource'},true),code('approved_resource_unavailable'));
 f.capabilities.replaceApprovedResources([resource]);
 f.service.settings('w','e',provider,'u',{enabled:false,expectedRevision:f.service.list('w','e').find(channel=>channel.id===c.id).revision});
 await assert.rejects(tasks.create(scope,{...body,operationId:'disabled-binding'},true),code('channel_binding_changed'));
 assert.equal(f.store.one('SELECT count(*) n FROM tasks').n,1);assert.equal(f.store.one('SELECT count(*) n FROM runs').n,1);
});

test('legacy inherited allow-list uncertainty stays fail-closed across DTO reads, toggle and resource-only save',async t=>{
 const f=setup(t),c=await ready(f),b=await f.service.resolveBinding(c.id),s={...scope(c,'outsider'),groupContext:{conversationId:'legacy-unknown',bindingVersion:b.bindingVersion}};open(f);
 const allow=[rule(c)],deny=[rule(c,'channel_user','blocked')];let dto=f.capabilities.save('w','e',{name:'Legacy inherited membership check',enabled:true,mode:'inherit',allowMemberIds:[],denyMemberIds:[],resourceIds:[],directoryAccess:{allow,deny}});
 assert.equal(dto.directoryAccess.channelPolicies[0].legacyAllowCheck,true);
 assert.deepEqual((await f.capabilities.usableChannel(s,b.connection,'group')).map(p=>p.id),[dto.id],'a known matching allow fact inherits');f.state.unknown=true;
 assert.deepEqual(await f.capabilities.usableChannel(s,b.connection,'group'),[],'unknown legacy allow fact must not become inherit');
 for(const enabled of [false,true])dto=f.capabilities.setEnabled({workspaceId:'w',entityId:'e',userId:'u'},dto.id,{enabled,expectedVersion:dto.version});
 assert.equal(dto.directoryAccess.channelPolicies[0].legacyAllowCheck,true);
 const {id,workspaceId,entityId,version,...edit}=dto;dto=f.capabilities.save(workspaceId,entityId,{...edit,name:'Only name changed',expectedVersion:version},id);
 assert.deepEqual(await f.capabilities.usableChannel(s,b.connection,'group'),[]);
 f.state.unknown=false;f.state.dept='outside';
 assert.deepEqual((await f.capabilities.usableChannel(s,b.connection,'group')).map(p=>p.id),[id],'a known nonmatch still inherits: compatibility is not an allowlist');
 f.state.unknown=true;
 const explicit=dto.directoryAccess.channelPolicies.map(({legacyAllowCheck,...policy})=>({...policy,mode:'inherit'}));
 f.capabilities.save('w','e',{...edit,directoryAccess:{allow,deny,channelPolicies:explicit},expectedVersion:dto.version},id);
 assert.deepEqual((await f.capabilities.usableChannel(s,b.connection,'group')).map(p=>p.id),[id],'explicit modern inherit has no legacy positive-list dependency');
});
