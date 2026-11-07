import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {Store} from '../dist/store.js';
import {CapabilityConfigService,registerCapabilityConfigRoutes} from '../dist/capability-config.js';
import {TriggerStore} from '../dist/triggers/store.js';
const catalog=[{id:'test-skill',kind:'skill',shared:true,resourceId:'approved-summary',version:'1',digest:'a'.repeat(64)},{id:'test-mcp',kind:'mcp',shared:true,serverRef:'approved-server',allowedTools:['lookup']}];
const base={name:'Approved test capability',enabled:true,mode:'inherit',allowMemberIds:[],denyMemberIds:[],resourceIds:['test-skill','test-mcp']};
const scope={workspaceId:'w',entityId:'e',userId:'u'};
const code=c=>e=>e.code===c;
function setup(t){
  const dir=mkdtempSync(join(tmpdir(),'dentity-capability-')),store=new Store(join(dir,'test.sqlite'));
  store.run("INSERT INTO users(id,username,display_name) VALUES('u','user','Owner'),('guest','guest','Guest'),('outsider','outsider','Outsider')");
  store.run("INSERT INTO workspaces(id,name,created_by) VALUES('w','Workspace','u'),('other','Other','outsider')");
  store.run("INSERT INTO members(id,workspace_id,user_id,role) VALUES('m','w','u','owner'),('g','w','guest','admin'),('o','other','outsider','owner')");
  store.run("INSERT INTO entities(id,workspace_id,name,owner_member_id,created_by_member_id,own_web_use,web_use_user_id,interaction_runtime) VALUES('e','w','Entity','m','m',1,'u','builtin')");
  const service=new CapabilityConfigService(store,catalog);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return{service,store};
}
test('explicit user list modes retain dormant lists and respect employee grant and empty-list boundaries',t=>{
 const {service}=setup(t),lists={...base,allowMemberIds:['m'],denyMemberIds:['m']};let p=service.save('w','e',{...lists,userPolicyMode:'allowlist'});
 assert.equal(service.resolveForTask(scope).packages.length,1);assert.equal(service.resolveForAdmittedTask(scope).packages.length,1);assert.deepEqual(service.list('w','e')[0].denyMemberIds,['m']);
 const select=(userPolicyMode,extra={})=>p=service.save('w','e',{...lists,userPolicyMode,...extra},p.id);
 select('denylist');assert.equal(service.resolveForTask(scope).packages.length,0);
 select('inherit');assert.equal(service.resolveForTask(scope).packages.length,1);assert.throws(()=>service.resolveForTask({...scope,userId:'guest'}),code('entity_use_forbidden'));
 select('allowlist',{allowMemberIds:[]});assert.equal(service.resolveForTask(scope).packages.length,0);
 select('denylist',{denyMemberIds:[]});assert.equal(service.resolveForTask(scope).packages.length,1);
 p=service.save('w','e',{...lists,denyMemberIds:[],name:'Old client edit'},p.id);assert.equal(p.userPolicyMode,'denylist');
 assert.throws(()=>select('invalid'),code('invalid_user_policy_mode'));assert.throws(()=>select('inherit',{denyMemberIds:['o']}),code('invalid_workspace_member'));
});
test('employee and package handoff selections intersect, preserve hidden values and fail closed',t=>{
 const {service,store}=setup(t);for(const name of ['A','B'])store.run("INSERT INTO entities(id,workspace_id,name,owner_member_id,created_by_member_id,own_web_use,web_use_user_id,interaction_runtime) VALUES(?,'w',?,'m','m',0,'u','builtin')",name,name);
 const source=sourceEmployeeId=>({workspaceId:'w',entityId:'e',sourceEmployeeId}),lists={mode:'allowlist',allowEmployeeIds:['A'],denyEmployeeIds:['A']};
 const save=(selectionMode,scope=lists,allowAll=false)=>service.saveHandoffAccess('w','e',{expectedVersion:service.getHandoffAccess('w','e').version,allowAll,scope:{...scope,selectionMode}});
 assert.equal(service.getHandoffAccess('w','e').allowAll,true);let p=service.save('w','e',{...base,handoffUsageMode:'custom',handoffUsageScope:{...lists,selectionMode:'allowlist'}});
 save('allowlist');assert.equal(service.resolveForHandoff(source('A')).packages.length,1);assert.throws(()=>service.resolveForHandoff(source('B')),code('employee_handoff_forbidden'));
 save('denylist');assert.throws(()=>service.resolveForHandoff(source('A')),code('employee_handoff_forbidden'));assert.equal(service.resolveForHandoff(source('B')).packages.length,0);
 p=service.save('w','e',{...base,handoffUsageMode:'inherit'},p.id);assert.equal(service.resolveForHandoff(source('B')).packages.length,1);assert.deepEqual(p.handoffUsageScope.allowEmployeeIds,['A']);assert.throws(()=>service.resolveForHandoff(source('A')),code('employee_handoff_forbidden'));
 save('all');assert.equal(service.resolveForHandoff(source('A')).packages.length,1);
 save('allowlist',{...lists,allowEmployeeIds:[]});assert.throws(()=>service.resolveForHandoff(source('A')),code('employee_handoff_forbidden'));
 save('denylist',{...lists,denyEmployeeIds:[]});assert.equal(service.resolveForHandoff(source('B')).packages.length,1);
 const current=service.getHandoffAccess('w','e');service.saveHandoffAccess('w','e',{expectedVersion:current.version,allowAll:false,scope:{mode:'all',allowEmployeeIds:['A'],denyEmployeeIds:[]}});assert.equal(service.getHandoffAccess('w','e').scope.selectionMode,'denylist');
 assert.throws(()=>service.saveHandoffAccess('w','e',{expectedVersion:0,allowAll:true,scope:lists}),code('employee_handoff_version_conflict'));assert.throws(()=>save('all',{...lists,denyEmployeeIds:['foreign']}),code('invalid_handoff_employee_id'));
 store.run("UPDATE entities SET lifecycle_enabled=0 WHERE id='B'");assert.throws(()=>service.resolveForHandoff(source('B')),code('employee_disabled'));
});
test('Trigger selections retain dormant lists with safe defaults and binding fences',t=>{
 const {service,store}=setup(t),triggers=new TriggerStore(store),bind=name=>triggers.save({workspaceId:'w',entityId:'e',name,type:'schedule',enabled:true,allowedActions:['create_task'],config:{cron:'0 9 * * *',description:'Synthetic only'}}),a=bind('A'),b=bind('B');
 const source=triggerId=>({workspaceId:'w',entityId:'e',triggerId,bindingVersion:1}),lists={mode:'allowlist',allowTriggerIds:[a.id],denyTriggerIds:[a.id]};let p=service.save('w','e',base);
 assert.equal(service.resolveForTrigger(source(a.id)).packages.length,1);const select=(selectionMode,scope=lists)=>p=service.save('w','e',{...base,triggerUsageScope:{...scope,selectionMode}},p.id);
 select('allowlist');assert.equal(service.resolveForTrigger(source(a.id)).packages.length,1);assert.equal(service.resolveForTrigger(source(b.id)).packages.length,0);
 select('denylist');assert.equal(service.resolveForTrigger(source(a.id)).packages.length,0);assert.equal(service.resolveForTrigger(source(b.id)).packages.length,1);
 select('all');assert.equal(service.resolveForTrigger(source(a.id)).packages.length,1);assert.deepEqual(p.triggerUsageScope.denyTriggerIds,[a.id]);
 select('allowlist',{...lists,allowTriggerIds:[]});assert.equal(service.resolveForTrigger(source(a.id)).packages.length,0);select('denylist',{...lists,denyTriggerIds:[]});assert.equal(service.resolveForTrigger(source(a.id)).packages.length,1);
 p=service.save('w','e',{...base,triggerUsageScope:{...lists,denyTriggerIds:[]}},p.id);assert.equal(p.triggerUsageScope.selectionMode,'denylist');assert.throws(()=>select('invalid'),code('invalid_list_selection_mode'));assert.throws(()=>select('all',{...lists,allowTriggerIds:['unknown']}),code('invalid_trigger_scope_id'));
 store.run('UPDATE trigger_bindings SET enabled=0 WHERE id=?',a.id);assert.throws(()=>service.resolveForTrigger(source(a.id)),code('trigger_binding_changed'));
});
test('inherit cannot expand entity grant and admin membership never bypasses use',t=>{
  const {service,store}=setup(t),p=service.save('w','e',base);
  assert.equal(service.resolveForTask(scope,[p.id]).packages[0].id,p.id);
  assert.throws(()=>service.resolveForTask({...scope,userId:'guest'},[p.id]),code('entity_use_forbidden'));
  service.saveWebAccess('w','e',{allowMemberIds:['m','g'],denyMemberIds:[]});
  assert.equal(service.resolveForTask({...scope,userId:'guest'},[p.id]).skills.length,1);
  store.run('UPDATE entities SET own_web_use=0');
  assert.equal(service.resolveForTask(scope,[p.id]).skills.length,1); // Explicit policy replaces legacy grant.
});
test('explicit member policy replaces legacy disabled creator grant without granting creator use',t=>{
  const {service,store}=setup(t);
  store.run('UPDATE entities SET own_web_use=0');
  assert.throws(()=>service.authorizeEntity(scope),code('entity_use_forbidden'));
  assert.deepEqual(service.getWebAccess('w','e').allowMemberIds,[]);
  service.saveWebAccess('w','e',{allowMemberIds:['g'],denyMemberIds:[]});
  service.authorizeEntity({...scope,userId:'guest'});
  assert.throws(()=>service.authorizeEntity(scope),code('entity_use_forbidden'));
});
test('restrict empty denies, paired member rule allows, deny wins at package and entity',t=>{
  const {service}=setup(t);let p=service.save('w','e',{...base,mode:'restrict'});
  assert.deepEqual(service.usable(scope).packages,[]);
  assert.deepEqual(service.resolveForTask(scope).packages,[]);
  p=service.save('w','e',{...base,mode:'restrict',allowMemberIds:['m']},p.id);
  assert.equal(service.resolveForTask(scope,[p.id]).mcpServers[0].allowedTools[0],'lookup');
  p=service.save('w','e',{...base,mode:'restrict',allowMemberIds:['m'],denyMemberIds:['m']},p.id);
  assert.deepEqual(service.resolveForTask(scope).packages,[]);
  service.saveWebAccess('w','e',{allowMemberIds:['m'],denyMemberIds:['m']});
  assert.throws(()=>service.resolveForTask(scope,[]),code('entity_use_forbidden'));
});
test('resource catalogs reject wildcard tools, paths, URLs, extra secret fields and unknown selections',t=>{
  const {service,store}=setup(t);
  assert.throws(()=>service.save('w','e',{...base,resourceIds:['unknown']}),code('unknown_approved_resource'));
  assert.throws(()=>service.save('w','e',{...base,resourceIds:['https://evil.test']}));
  assert.throws(()=>service.save('w','e',{...base,apiKey:'not-real'}));
  for(const entry of [{id:'x',kind:'mcp',shared:true,serverRef:'x',allowedTools:['*']},{id:'x',kind:'mcp',shared:true,serverRef:'https://evil.test',allowedTools:['lookup']},{id:'x',kind:'skill',shared:true,resourceId:'/tmp/skill',version:'1',digest:'a'.repeat(64)},{...catalog[1],secret:'not-real'}]) assert.throws(()=>new CapabilityConfigService(store,[entry]));
  const p=service.save('w','e',base),snapshot=service.resolveForTask(scope,[p.id]);
  assert.equal(JSON.stringify(snapshot).includes('apiKey'),false);
  assert.equal(JSON.stringify(service.list('w','e')).includes('not-real'),false);
  assert.equal(snapshot.resources[0].packageId,p.id);
  assert.ok(Object.isFrozen(snapshot));assert.ok(Object.isFrozen(snapshot.resources[0].resource));
  const emptyCatalog=new CapabilityConfigService(store,[]);
  assert.throws(()=>emptyCatalog.resolveForTask(scope,[p.id]),code('approved_resource_unavailable'));
});
test('cross-workspace member selection, package updates and snapshot substitution are rejected',t=>{
  const {service}=setup(t),p=service.save('w','e',base),snapshot=service.resolveForTask(scope,[p.id]);
  assert.throws(()=>service.saveWebAccess('w','e',{allowMemberIds:['o'],denyMemberIds:[]}),code('invalid_workspace_member'));
  assert.throws(()=>service.save('w','e',{...base,allowMemberIds:['o']}),code('invalid_workspace_member'));
  assert.throws(()=>service.save('other','e',base,p.id),code('entity_not_found'));
  assert.throws(()=>service.revalidateCurrent({...scope,userId:'guest'},snapshot),code('capability_snapshot_scope_mismatch'));
  assert.throws(()=>service.revalidateCurrent(scope,{...snapshot,mcpServers:[]}),code('capability_configuration_changed'));
});
test('current package versions, resource manifests, entity revocation and member revocation checked',t=>{
  const {service,store}=setup(t);let p=service.save('w','e',base),snapshot=service.resolveForTask(scope,[p.id]);
  service.revalidateCurrent(scope,snapshot);
  p=service.save('w','e',{...base,name:'Changed'},p.id);
  assert.throws(()=>service.revalidateCurrent(scope,snapshot),code('capability_configuration_changed'));
  snapshot=service.resolveForTask(scope,[p.id]);
  service.saveWebAccess('w','e',{allowMemberIds:['m'],denyMemberIds:[]});
  assert.throws(()=>service.revalidateCurrent(scope,snapshot),code('capability_configuration_changed'));
  snapshot=service.resolveForTask(scope,[p.id]);
  store.run("UPDATE members SET status='disabled' WHERE id='m'");
  assert.throws(()=>service.revalidateCurrent(scope,snapshot),code('entity_use_forbidden'));
});
test('no authorized packages is resource-free but still requires entity grant',t=>{
  const {service}=setup(t),snapshot=service.resolveForTask(scope,[]);
  assert.deepEqual(snapshot.packages,[]);assert.deepEqual(snapshot.skills,[]);assert.deepEqual(snapshot.mcpServers,[]);
  assert.throws(()=>service.resolveForTask({...scope,userId:'guest'},[]),code('entity_use_forbidden'));
});

test('authorized packages automatically project versioned resources without model-supplied roots',t=>{
  const {store}=setup(t);
  const resource={id:'local-standard-tools',kind:'execution',workspaceIds:['w'],resourceId:'local-standard-tools',version:'1',tools:['read','write','edit','bash']};
  const service=new CapabilityConfigService(store,[...catalog,resource]);
  service.saveWebAccess('w','e',{allowMemberIds:['m','g'],denyMemberIds:[]});
  const p=service.save('w','e',{...base,mode:'restrict',allowMemberIds:['m'],resourceIds:[resource.id]});
  assert.equal(service.resolveForTask(scope).executionResources.length,1);
  const snapshot=service.resolveForTask(scope,[p.id]);
  assert.deepEqual(snapshot.executionResources,[{resourceId:resource.resourceId,version:'1',tools:['read','write','edit','bash']}]);
  assert.equal(JSON.stringify(snapshot).includes('root'),false);
  assert.deepEqual(service.resolveForTask({...scope,userId:'guest'}).packages,[]);
  service.save('w','e',{...base,mode:'restrict',allowMemberIds:[],resourceIds:[resource.id]},p.id);
  assert.throws(()=>service.revalidateCurrent(scope,snapshot),code('capability_package_forbidden'));
  for(const invalid of [{...resource,root:'/tmp/unreviewed'},{...resource,tools:['*']},{...resource,tools:['read','read']},{...resource,tools:['powershell']}])assert.throws(()=>new CapabilityConfigService(store,[invalid]));
});

test('execution roots are not unioned across capability packages and resource visibility still applies',t=>{
  const {store}=setup(t);
  const resources=[{id:'exec-a',kind:'execution',workspaceIds:['w'],resourceId:'exec-a',version:'1',tools:['read']},{id:'exec-b',kind:'execution',workspaceIds:['w'],resourceId:'exec-b',version:'1',tools:['bash']}];
  const service=new CapabilityConfigService(store,resources);
  const first=service.save('w','e',{...base,resourceIds:['exec-a']}),second=service.save('w','e',{...base,resourceIds:['exec-b']});
  assert.throws(()=>service.resolveForTask(scope,[first.id,second.id]),code('execution_resource_conflict'));
  assert.deepEqual(service.resources('other'),[]);
});
test('HTTP configuration routes manager-only, usable catalog filtered for authenticated user',async t=>{
  const {service}=setup(t),app=Fastify();
  await registerCapabilityConfigRoutes(app,service,{currentUser:r=>({id:r.headers['x-user']??'u'}),requireManager:r=>{if(r.headers['x-manager']!=='yes'){const e=new Error('forbidden');e.statusCode=403;throw e;}}});
  t.after(()=>app.close());const root='/api/workspaces/w/entities/e';
  assert.equal((await app.inject({method:'POST',url:root+'/capability-packages',payload:base})).statusCode,403);
  const created=await app.inject({method:'POST',url:root+'/capability-packages',headers:{'x-manager':'yes'},payload:base});assert.equal(created.statusCode,200);
  assert.equal((await app.inject({url:root+'/resource-catalog'})).statusCode,403);
  const members=await app.inject({url:root+'/configuration-members',headers:{'x-manager':'yes'}});assert.equal(members.statusCode,200);assert.equal(members.body.includes('email'),false);
  const usable=await app.inject({url:root+'/usable-capabilities'});assert.equal(usable.json().packages.length,1);
  assert.equal((await app.inject({url:root+'/usable-capabilities',headers:{'x-user':'guest'}})).statusCode,403);
});

test('catalog visibility is explicit, tenant-scoped even for owner, and revalidated after change',async t=>{
  const {store}=setup(t);
  store.run("INSERT INTO entities(id,workspace_id,name,owner_member_id,created_by_member_id,own_web_use,web_use_user_id,interaction_runtime) VALUES('oe','other','Other entity','o','o',1,'outsider','builtin')");
  const privateResource={id:'private-skill',kind:'skill',workspaceIds:['w'],resourceId:'private-summary',version:'1',digest:'b'.repeat(64)};
  const service=new CapabilityConfigService(store,[...catalog,privateResource]);
  const other={workspaceId:'other',entityId:'oe',userId:'outsider'};
  assert.equal(service.resources('w').some(r=>r.id==='private-skill'),true);
  assert.equal(service.resources('other').some(r=>r.id==='private-skill'),false);
  assert.throws(()=>service.save('other','oe',{...base,resourceIds:['private-skill']}),code('unknown_approved_resource'));
  const shared=service.save('other','oe',base);
  assert.equal(service.resolveForTask(other,[shared.id]).skills.length,1);
  assert.equal(service.usable(other).resources.some(r=>r.id==='private-skill'),false);
  const p=service.save('w','e',{...base,resourceIds:['private-skill']}),snapshot=service.resolveForTask(scope,[p.id]);
  assert.deepEqual(Object.keys(snapshot.skills[0]).sort(),['digest','resourceId','version']);
  const changed=new CapabilityConfigService(store,[...catalog,{...privateResource,workspaceIds:['other']}]);
  assert.throws(()=>changed.resolveForTask(scope,[p.id]),code('approved_resource_unavailable'));
  assert.throws(()=>changed.revalidateCurrent(scope,snapshot),code('approved_resource_unavailable'));
  // Even a forged persisted package cannot bypass visibility at execution time.
  store.run('UPDATE capability_packages SET config_json=? WHERE id=?',JSON.stringify({...base,resourceIds:['private-skill']}),shared.id);
  assert.throws(()=>service.resolveForTask(other,[shared.id]),code('approved_resource_unavailable'));
  const app=Fastify();
  await registerCapabilityConfigRoutes(app,service,{currentUser:()=>({id:'outsider'}),requireManager:()=>{}});
  t.after(()=>app.close());
  const response=await app.inject({url:'/api/workspaces/other/entities/oe/resource-catalog'});
  assert.equal(response.statusCode,200);assert.equal(response.body.includes('private-skill'),false);
  const {shared: _shared,...unscoped}=catalog[0];
  for(const resource of [unscoped,{...unscoped,shared:false},{...unscoped,workspaceIds:[]},{...unscoped,workspaceIds:['w','w']},{...unscoped,shared:true,workspaceIds:['w']}]) assert.throws(()=>new CapabilityConfigService(store,[resource]),code('invalid_approved_resource_visibility'));
});

test('automatic package union deduplicates Skills and merges MCP tools; new grants do not rewrite a pinned Run',t=>{
 const {store}=setup(t),service=new CapabilityConfigService(store,[...catalog,{id:'more-mcp',kind:'mcp',shared:true,serverRef:'approved-server',allowedTools:['lookup','other']}]);
 const one=service.save('w','e',base),first=service.resolveForTask(scope);
 service.save('w','e',{...base,name:'Additional authorized package',resourceIds:['test-skill','more-mcp']});
 assert.doesNotThrow(()=>service.revalidateCurrent(scope,first));
 const all=service.resolveForTask(scope);assert.equal(all.packages.length,2);assert.equal(all.skills.length,1);assert.deepEqual(all.mcpServers,[{serverRef:'approved-server',allowedTools:['lookup','other']}]);
 service.save('w','e',{...base,enabled:false},one.id);assert.throws(()=>service.revalidateCurrent(scope,all));assert.equal(service.resolveForTask(scope).packages.length,1);
});

test('package conversation kinds: Web private, missing legacy, empty, meeting and omission-preserving updates',t=>{const{service}=setup(t);const legacy=service.save('w','e',base),group=service.save('w','e',{...base,name:'group',conversationKinds:['group']}),meeting=service.save('w','e',{...base,name:'meeting',conversationKinds:['meeting']}),empty=service.save('w','e',{...base,name:'empty',conversationKinds:[]});assert.deepEqual(service.resolveForAdmittedTask(scope).packages.map(p=>p.id),[legacy.id]);const changed=service.save('w','e',{...base,name:'preserve',expectedVersion:group.version},group.id);assert.deepEqual(changed.conversationKinds,['group']);assert.deepEqual(service.list('w','e').find(p=>p.id===meeting.id).conversationKinds,['meeting']);assert.deepEqual(service.list('w','e').find(p=>p.id===empty.id).conversationKinds,[]);assert.throws(()=>service.save('w','e',{...base,conversationKinds:['unknown']}));});
test('package channel kind intersects inherit/restrict and deny without altering multi-resource snapshot',async t=>{const{store}=setup(t);const directory={beginEvaluation:()=>({}),validateRules:(_w,_e,r)=>r,matches:async(_w,r)=>r.subjectId==='yes'};const service=new CapabilityConfigService(store,catalog,directory);const channel={workspaceId:'w',connectionId:'c',provider:'feishu',tenantId:'t',identity:{externalId:'bot'}},actor={workspaceId:'w',entityId:'e',requesterKind:'channel_user',requesterId:'u'},yes={subjectId:'yes'},no={subjectId:'no'};const p=service.save('w','e',{...base,conversationKinds:['group'],mode:'restrict',directoryAccess:{allow:[yes],deny:[no]}});assert.equal((await service.executionPackages(actor,channel,'private')).length,0);assert.deepEqual((await service.executionPackages(actor,channel,'group'))[0].resourceIds,['test-skill','test-mcp']);service.save('w','e',{...base,expectedVersion:p.version,conversationKinds:['group'],mode:'restrict',directoryAccess:{allow:[yes],deny:[yes]}},p.id);assert.equal((await service.executionPackages(actor,channel,'group')).length,0);});

test('omitted channel rules preserve historical complex restrictions and explicit empty rules clear them',t=>{const{store}=setup(t);const directory={validateRules:(_w,_e,r)=>structuredClone(r)};const service=new CapabilityConfigService(store,catalog,directory),rules={allow:[{sourceId:'s',kind:'department',subjectId:'d',includeDescendants:true,conversationKinds:['meeting']}],deny:[{sourceId:'s',kind:'channel_user',subjectId:'u',conversationKinds:['group']}]};const first=service.save('w','e',{...base,directoryAccess:rules,conversationKinds:['meeting']});const next=service.save('w','e',{...base,expectedVersion:first.version},first.id);assert.deepEqual(next.directoryAccess,rules);assert.deepEqual(next.conversationKinds,['meeting']);const cleared=service.save('w','e',{...base,expectedVersion:next.version,directoryAccess:{allow:[],deny:[]}},first.id);assert.deepEqual(cleared.directoryAccess,{allow:[],deny:[]});});


test('Web policy and admitted execution snapshots share a real preparation fence without broadening admission',t=>{const {service}=setup(t),p=service.save('w','e',base);for(const snapshot of [service.resolveForTask(scope),service.resolveForAdmittedTask(scope)]){assert.equal(snapshot.packagePolicyVersion,JSON.stringify([[p.id,p.version]]));assert.doesNotThrow(()=>service.validatePreparedSnapshot(scope,snapshot));assert.throws(()=>service.validatePreparedSnapshot({...scope,userId:'guest'},snapshot),code('capability_snapshot_scope_mismatch'));}const before=service.resolveForTask(scope);service.save('w','e',{...base,name:'Updated before submission'},p.id);assert.throws(()=>service.validatePreparedSnapshot(scope,before),code('capability_configuration_changed'));service.saveWebAccess('w','e',{allowMemberIds:[],denyMemberIds:[]});assert.throws(()=>service.resolveForTask(scope),code('entity_use_forbidden'));assert.equal(service.resolveForAdmittedTask(scope).packages.length,1,'previously admitted input resolves only execution restrictions');});
