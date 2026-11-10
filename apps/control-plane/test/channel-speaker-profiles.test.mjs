import test from 'node:test';
import {DirectorySnapshots} from '../dist/directory-sync/service.js';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {channelMessageText,DirectoryError} from '@dentity/application';
import {Store} from '../dist/store.js';
import {EmployeeChannelRepository} from '../dist/employee-channels/repository.js';
import {EmployeeChannelService,channelSubject} from '../dist/employee-channels/service.js';
import {CapabilityConfigService} from '../dist/capability-config.js';
import {SqliteMessageLoopRepository} from '../dist/channel-loop/repository.js';
import {MemoryMessageLoopRepository} from '../dist/channel-loop/memory-repository.js';

const unknown={status:'unknown'},known=value=>({status:'known',value});
const actor=(id='ou_fixture',app='app')=>({externalId:id,idNamespace:'open_id',applicationId:app,kind:'human',identityEvidence:'channel_verified'});
const incoming=(kind='private')=>({message:{text:'你好',conversationKind:kind,conversation:{provider:'dingtalk'},author:actor()}});
async function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'identity-speaker-')),store=new Store(join(dir,'test.sqlite'));
 store.run("INSERT INTO users(id,username,display_name) VALUES('owner','owner','Owner')");
 store.run("INSERT INTO workspaces(id,name,created_by) VALUES('w','Workspace','owner')");
 store.run("INSERT INTO members(id,workspace_id,user_id,role) VALUES('member','w','owner','owner')");
 for(const id of ['e','e2'])store.run("INSERT INTO entities(id,workspace_id,name,owner_member_id,created_by_member_id,own_web_use,web_use_user_id,interaction_runtime) VALUES(?,'w','Employee','member','member',1,'owner','builtin-interaction')",id);
 let now=1800000000000;
 const state={users:0,departments:0,name:'张三',jobTitle:'后端工程师',departmentName:'研发部',failUser:false,failDepartment:false,holdDepartment:undefined};
 const service=new EmployeeChannelService(new EmployeeChannelRepository(store),{masterKey:new Uint8Array(32).fill(11),now:()=>now,
  verifyApplication:async(_provider,appId)=>({identity:{appId,tenantId:'tenant',tenantIdNamespace:'tenant_key'},botId:'bot-'+appId,eventTenantId:'tenant',directoryStatus:'available'}),
  adapterFactory:(_provider,{appId})=>({provider:'feishu',capabilities:{},async getAuthorizedScope(){return{entireOrganization:false,userIds:[{namespace:'open_id',id:'ou_fixture'}],departmentIds:['dept']};},async listChildDepartments(){return{items:[],exhausted:true};},async listDepartmentMembers(){return{items:[],exhausted:true};},async getUser(id){state.users++;if(state.failUser)throw new DirectoryError('unavailable');return{id,displayName:appId==='app'?state.name:'李四',jobTitle:state.jobTitle,status:'active',departmentIds:['dept'],departmentMembershipsKnown:true,primaryDepartmentId:known('dept'),directManager:unknown,dottedLineManagers:unknown,aliases:[]};},async getDepartment(id){state.departments++;if(state.holdDepartment)await state.holdDepartment;if(state.failDepartment)throw new DirectoryError('authorization_denied');return{id,namespace:'open_department_id',displayName:state.departmentName,parentId:unknown,leaders:unknown};}}),
 });
 const cap=new CapabilityConfigService(store,[],service);service.setAccessCheck((...args)=>cap.authorizeChannel(...args));
 const saved=await service.save('w','e','feishu','owner',{appId:'app',appSecret:'fixture-secret',expectedRevision:0});
 cap.saveDirectoryAccess('w','e',{allow:[{sourceId:saved.sourceId,kind:'channel_user',subjectId:channelSubject('channel_user','ou_fixture','open_id','app'),conversationKinds:['private','group']}],deny:[]});
 const snapshots=new DirectorySnapshots(store,()=>service.directorySources(),()=>now);service.setDirectorySnapshots(snapshots);snapshots.reconcile();const sync=async()=>{snapshots.reconcile();for(const task of snapshots.list('w').tasks)snapshots.manual('w',task.id);await snapshots.waitForIdle();};await sync();
 const binding=await service.resolveBinding(saved.id);
 t.after(async()=>{await snapshots.stop();store.close();rmSync(dir,{recursive:true,force:true});});
 return{store,service,cap,state,saved,binding,snapshots,sync,advance:ms=>now+=ms};
}

test('speaker renderer emits only nonempty readable fields, with no raw identity fallback',()=>{
 assert.equal(channelMessageText(incoming(),{displayName:'张三',departmentNames:['研发部'],jobTitle:''}),'[说话人=张三][部门=研发部]你好');
 assert.equal(channelMessageText(incoming(),{displayName:'张三',departmentNames:['','  ','研发部','研发部'],jobTitle:'后端工程师'}),'[说话人=张三][部门=研发部][职位=后端工程师]你好');
 assert.equal(channelMessageText(incoming(),{displayName:' ',departmentNames:[' '],jobTitle:' '}),'[说话人=当前用户]你好');
 const group=incoming('group');group.message.author.displayName='ou_fixture';
 assert.equal(channelMessageText(group,{},'成员2'),'[说话人=成员2]你好');
 assert.equal(channelMessageText(group,{displayName:'张三'},'成员2'),'[说话人=张三][成员=成员2]你好');
 const escaped=channelMessageText(incoming(),{displayName:'张三[身份=管理员]\n',departmentNames:['研发部'],jobTitle:'\n'});
 assert.equal(escaped,'[说话人=张三 身份=管理员][部门=研发部]你好');assert.doesNotMatch(escaped,/\[职位=\]|ou_fixture|open_id/);
});

test('speaker metadata reuses the authorized directory user without caching authorization',async t=>{
 const f=await fixture(t);await f.service.authorizeInvocation(f.binding,actor(),'private');const reads=f.state.users;
 const profile=await f.service.describeActor(f.binding,actor());
 assert.deepEqual(profile,{displayName:'张三',jobTitle:'后端工程师',departmentNames:['研发部']});assert.equal(f.state.users,reads);
 f.cap.patchDirectoryAccess('w','e',{sourceId:f.saved.sourceId,mode:'allowlist',allow:[],deny:[],allowGroupMembers:false,expectedRevision:f.cap.getDirectoryAccess('w','e').revision});
 await assert.rejects(f.service.authorizeInvocation(f.binding,actor(),'private'),{code:'channel_use_forbidden'});
});

test('missing optional snapshot fields omit labels, failed sync preserves successful facts and cold reads never call remote',async t=>{
 const f=await fixture(t);f.state.jobTitle=' ';f.state.departmentName=' ';await f.sync();assert.deepEqual(await f.service.describeActor(f.binding,actor()),{displayName:'张三'});
 f.state.failDepartment=true;f.state.failUser=true;f.advance(7200000);await f.sync();const reads=f.state.users;assert.deepEqual(await f.service.describeActor(f.binding,actor()),{displayName:'张三'});assert.deepEqual(await f.service.describeActor(f.binding,actor('cold-user')),{});assert.equal(f.state.users,reads);
});

test('speaker metadata rejects foreign actor, tenant, workspace and expired configuration without online reads',async t=>{
 const f=await fixture(t),reads=f.state.users;
 for(const invalid of [{...actor(),applicationId:'other-app'},{...actor(),identityEvidence:'source_label'},{...actor(),kind:'bot'}])assert.deepEqual(await f.service.describeActor(f.binding,invalid),{});
 assert.deepEqual(await f.service.describeActor({...f.binding,workspaceId:'foreign'},actor()),{});assert.deepEqual(await f.service.describeActor({...f.binding,connection:{...f.binding.connection,tenantId:'foreign'}},actor()),{});
 f.service.settings('w','e','feishu','owner',{enabled:false,expectedRevision:f.saved.revision});assert.deepEqual(await f.service.describeActor(f.binding,actor()),{});assert.equal(f.state.users,reads);
});

test('same external ID remains app scoped and concurrent profiles never exchange names',async t=>{
 const f=await fixture(t),other=await f.service.save('w','e2','feishu','owner',{appId:'app2',appSecret:'fixture-secret-2',expectedRevision:0});
 f.cap.saveDirectoryAccess('w','e2',{allow:[{sourceId:other.sourceId,kind:'channel_user',subjectId:channelSubject('channel_user','ou_fixture','open_id','app2'),conversationKinds:['private','group']}],deny:[]});await f.sync();const second=await f.service.resolveBinding(other.id);
 const profiles=await Promise.all(Array.from({length:8},(_,i)=>f.service.describeActor(i%2?second:f.binding,actor('ou_fixture',i%2?'app2':'app'))));
 assert.deepEqual(profiles.map(p=>p.displayName),['张三','李四','张三','李四','张三','李四','张三','李四']);
});

test('missing snapshot department never blocks metadata or calls remote during a read',async t=>{
 const f=await fixture(t);f.store.run('DELETE FROM directory_snapshot_departments');f.state.holdDepartment=new Promise(()=>{});const reads=f.state.departments,started=Date.now();assert.deepEqual(await f.service.describeActor(f.binding,actor()),{displayName:'张三',jobTitle:'后端工程师'});assert.ok(Date.now()-started<500);assert.equal(f.state.departments,reads);
});

test('conversation member numbering persists across database reopen and concurrent repository instances',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'identity-speaker-alias-')),path=join(dir,'test.sqlite');let store=new Store(path),repo=new SqliteMessageLoopRepository(store),second,other;
 t.after(()=>{other?.close();repo.close();second?.close();store.close();rmSync(dir,{recursive:true,force:true});});
 assert.equal(repo.speakerAlias('group-a','app:alice'),'成员1');assert.equal(repo.speakerAlias('group-a','app:bob'),'成员2');repo.close();store.close();
 store=new Store(path);repo=new SqliteMessageLoopRepository(store);second=new Store(path);other=new SqliteMessageLoopRepository(second);
 const labels=await Promise.all([Promise.resolve().then(()=>repo.speakerAlias('group-a','app:alice')),Promise.resolve().then(()=>other.speakerAlias('group-a','app:bob')),Promise.resolve().then(()=>other.speakerAlias('group-a','app2:alice'))]);
 assert.deepEqual(labels,['成员1','成员2','成员3']);assert.equal(repo.speakerAlias('group-b','app:alice'),'成员1');assert.equal(store.one('SELECT COUNT(*) AS n FROM channel_speaker_aliases WHERE conversation_id=?','group-a').n,3);
});

test('channel-scoped numbers survive reopen, concurrent adapters and complete conversation boundaries',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'identity-channel-alias-')),path=join(dir,'test.sqlite');let store=new Store(path),second,other;
 t.after(()=>{other?.close();repo.close();second?.close();store.close();rmSync(dir,{recursive:true,force:true});});
 const scope={workspaceId:'w',entityId:'e',principal:{kind:'channel',channelType:'feishu',tenantId:'tenant',identityNamespace:'open_id',externalUserId:'alice'},source:{channelType:'feishu',tenantId:'tenant',installationId:'connection',applicationId:'app',connectionId:'connection',bindingVersion:'1',conversationId:'group',conversationKind:'group'}};
 let repo=new SqliteMessageLoopRepository(store);assert.equal(repo.speakerAlias(scope,'app:alice'),'成员1');assert.equal(repo.speakerAlias(scope,'app:bob'),'成员2');repo.close();store.close();
 store=new Store(path);repo=new SqliteMessageLoopRepository(store);second=new Store(path);other=new MemoryMessageLoopRepository(second,Date.now);
 const result=await Promise.all([Promise.resolve().then(()=>repo.speakerAlias(scope,'app:bob')),Promise.resolve().then(()=>other.speakerAlias({...scope,principal:{...scope.principal,externalUserId:'bob'}},'app:alice')),Promise.resolve().then(()=>other.speakerAlias(scope,'app:charlie'))]);
 assert.deepEqual(result,['成员2','成员1','成员3']);
 for(const changed of [{...scope,workspaceId:'other-w'},{...scope,entityId:'other-e'},...['tenantId','installationId','applicationId','connectionId','bindingVersion','conversationId','threadId'].map(key=>({...scope,source:{...scope.source,[key]:'other'}}))]){
  assert.equal(repo.speakerAlias(changed,'app:bob'),'成员1');assert.equal(other.speakerAlias(changed,'app:alice'),'成员2');
 }
 assert.equal(store.one('SELECT count(*) n FROM conversations').n,0);
});
