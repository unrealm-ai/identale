import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {channelInvocationScope} from '@dentity/application';
import {Store} from '../dist/store.js';
import {EmployeeChannelRepository} from '../dist/employee-channels/repository.js';
import {EmployeeChannelService,channelSubject} from '../dist/employee-channels/service.js';
import {CapabilityConfigService} from '../dist/capability-config.js';
import {ChannelTaskAuthorization} from '../dist/channel-loop/authorization.js';

// Existing isolated SQLite and synthetic search-candidate fixture convention.
// Identity joins use the real issued-code and callback mapping implementation;
// no provider, model, live application, or external recipient is contacted.
async function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'wecom-partial-whitelist-')),store=new Store(join(root,'test.sqlite'));
 const now=()=>1_800_000_000_000;
 store.run("INSERT INTO users(id,username,display_name) VALUES('u','fixture','Owner')");
 store.run("INSERT INTO workspaces(id,name,created_by) VALUES('w','Fixture','u')");
 store.run("INSERT INTO members(id,workspace_id,user_id,role) VALUES('m','w','u','owner')");
 store.run("INSERT INTO entities(id,workspace_id,name,owner_member_id,created_by_member_id,own_web_use,web_use_user_id,interaction_runtime) VALUES('e','w','Employee','m','m',1,'u','builtin'),('e2','w','Second','m','m',1,'u','builtin')");
 const repository=new EmployeeChannelRepository(store),channels=new EmployeeChannelService(repository,{masterKey:Buffer.alloc(32,41),now,fetch:async()=>{throw Error('unexpected external request');}});
 const capabilities=new CapabilityConfigService(store,[],channels,undefined,undefined,undefined,now);
 channels.setMemberVerificationReceiver(async()=>true);
 channels.setAccessCheck((...args)=>capabilities.authorizeChannel(...args));
 t.after(()=>{capabilities.close();store.close();rmSync(root,{recursive:true,force:true});});
 const record=c=>repository.byId(c.id);
 const ready=async(entity='e')=>{
  const c=await channels.save('w',entity,'wecom','u',{appId:'synthetic-bot-'+entity,appSecret:'synthetic-partial-whitelist-secret'});
  channels.observeFirstInbound(c.id,{appId:c.appId,botId:c.appId,tenantId:c.appId,tenantNamespace:'app_id'});
  channels.botContacts.remember(record(c),['a','b','c'].map(id=>({id:'search-'+id,displayName:'Synthetic Member '+id,departmentPaths:[]})));
  return record(c);
 };
 const rule=(c,id)=>({sourceId:c.sourceId,kind:'channel_user',subjectId:channelSubject('channel_user','search-'+id,'user_id',c.appId),conversationKinds:['private','group']});
 const policy=(c,{allow=['a','b'],deny=[],mode='allowlist'}={})=>capabilities.patchDirectoryAccess('w',c.entityId,{sourceId:c.sourceId,mode,allow:allow.map(id=>rule(c,id)),deny:deny.map(id=>rule(c,id)),allowGroupMembers:false,expectedRevision:capabilities.getDirectoryAccess('w',c.entityId).channelPolicies.find(p=>p.sourceId===c.sourceId).revision});
 const start=(c,id)=>channels.startMemberVerification('w',c.entityId,'u',{userId:'search-'+id,sourceId:c.sourceId,requestId:randomUUID()});
 const accept=(c,id,issued)=>{
  assert.match(issued.phrase,/^[0-9]{6}$/);
  assert.equal(channels.memberVerification.accept(record(c),{text:issued.phrase,callbackUserId:'callback-'+id,eventId:randomUUID(),messageId:randomUUID(),privateMessage:true}),'verified');
  assert.ok(record(c).wecomContactMappings.some(m=>m.userId==='search-'+id&&m.callbackUserId==='callback-'+id));
 };
 const bind=async(c,id)=>accept(c,id,await start(c,id));
 const access=async(c,id,kind='private')=>{
  const b=await channels.resolveBinding(c.id),actor={externalId:'callback-'+id,idNamespace:'user_id',applicationId:c.appId,kind:'human',identityEvidence:'channel_verified'};
  assert.ok(b);
  const task=channelInvocationScope(b,{schemaVersion:1,origin:'live',connectionId:c.id,tenantId:b.connection.tenantId,eventId:'event-'+id,receivedAt:now(),message:{id:'message-'+id,conversationKind:kind,conversation:{provider:'wecom',connectionId:c.id,tenantId:b.connection.tenantId,kind:'conversation',externalId:'chat-'+id,conversationKind:kind,...(kind==='private'?{privateRecipientId:actor.externalId}:{})},author:actor,occurredAt:now(),text:'Synthetic access check',mentions:[]}});
  const scope={workspaceId:'w',entityId:c.entityId,requesterId:actor.externalId,requesterKind:'channel_user',requesterIdentity:{idNamespace:'user_id',applicationId:c.appId},conversationKind:kind,...(kind==='group'?{groupContext:{conversationId:task.source.conversationId,bindingVersion:b.bindingVersion}}:{})};
  return {b,actor,task,scope,invoke:()=>channels.authorizeInvocation(b,actor,kind,task.source),packages:()=>capabilities.usableChannel(scope,b.connection,kind)};
 };
 const savePackage=(c,{mode='inherit',allow=[],deny=[],legacy=false,legacyAllowCheck=false}={})=>capabilities.save('w',c.entityId,{name:'Synthetic '+mode,enabled:true,mode:mode==='allowlist'?'restrict':'inherit',allowMemberIds:[],denyMemberIds:[],resourceIds:[],conversationKinds:['private','group'],directoryAccess:{allow:legacy?allow.map(id=>rule(c,id)):[],deny:legacy?deny.map(id=>rule(c,id)):[],...(!legacy?{channelPolicies:[{sourceId:c.sourceId,mode,allow:allow.map(id=>rule(c,id)),deny:deny.map(id=>rule(c,id)),...(legacyAllowCheck?{legacyAllowCheck:true}:{})}]}:{})}});
 return {store,repository,channels,capabilities,now,record,ready,rule,policy,start,accept,bind,access,savePackage};
}
const forbidden={code:'channel_use_forbidden'};

for(const kind of ['private','group'])test(`employee partial whitelist keeps verified A usable with inherited packages (${kind})`,async t=>{
 const f=await fixture(t),c=await f.ready();await f.bind(c,'a');await f.bind(c,'c');
 const inherited=f.savePackage(c),a=await f.access(c,'a',kind),b=await f.access(c,'b',kind),outsider=await f.access(c,'c',kind);
 f.policy(c,{allow:['a']});await a.invoke();await a.invoke();assert.equal(f.capabilities.admissionCache.size,1,'complete known grant is cacheable');
 f.policy(c);const pending=await f.start(c,'b');assert.equal(f.capabilities.admissionCache.size,0,'adding B invalidates A’s old decision');
 const auth=new ChannelTaskAuthorization(f.store,f.capabilities,f.channels,f.now);
 for(let pass=0;pass<2;pass++){
  await a.invoke();await auth.refreshAuthorization(a.task);
  assert.deepEqual((await auth.resolveForTask(a.task)).packages.map(p=>p.id),[inherited.id]);
  for(const denied of [b,outsider]){await assert.rejects(denied.invoke(),forbidden);await assert.rejects(auth.refreshAuthorization(denied.task),forbidden);}
  assert.equal(f.capabilities.admissionCache.size,0,'unknown B prevents caching, not A’s proven grant');
 }
 const revision=f.capabilities.getDirectoryAccess('w','e').revision;
 f.accept(c,'b',pending);await b.invoke();await a.invoke();await assert.rejects(outsider.invoke(),forbidden);
 assert.equal(f.capabilities.getDirectoryAccess('w','e').revision,revision,'binding B needs no policy resave');
 assert.ok(f.capabilities.admissionCache.size>0,'fully resolved whitelist can be cached');
 f.policy(c,{allow:['b']});await assert.rejects(a.invoke(),forbidden);await b.invoke();
});

for(const legacy of [false,true])test(`independent package whitelist grants A without granting unverified B or outsider C (${legacy?'legacy restrict':'source policy'})`,async t=>{
 const f=await fixture(t),c=await f.ready();await f.bind(c,'a');await f.bind(c,'c');f.policy(c,{mode:'all'});
 const inherited=f.savePackage(c),restricted=f.savePackage(c,{mode:'allowlist',allow:['a','b'],legacy}),pending=await f.start(c,'b');
 const auth=new ChannelTaskAuthorization(f.store,f.capabilities,f.channels,f.now);
 for(let pass=0;pass<2;pass++)for(const id of ['a','b','c']){
  const a=await f.access(c,id);await a.invoke();await auth.refreshAuthorization(a.task);
  const expected=[inherited.id,...(id==='a'?[restricted.id]:[])].sort();
  assert.deepEqual((await a.packages()).map(p=>p.id).sort(),expected);
  assert.deepEqual((await auth.resolveForTask(a.task)).packages.map(p=>p.id).sort(),expected);
 }
 f.accept(c,'b',pending);
 assert.ok((await (await f.access(c,'b')).packages()).some(p=>p.id===restricted.id));
 assert.equal(f.capabilities.list('w','e').find(p=>p.id===restricted.id).version,restricted.version,'verification does not rewrite package rules');
 f.capabilities.setEnabled({workspaceId:'w',entityId:'e',userId:'u'},restricted.id,{enabled:false,expectedVersion:restricted.version});
 assert.deepEqual((await (await f.access(c,'a')).packages()).map(p=>p.id),[inherited.id]);
});

test('unknown and matching denials keep priority over a confirmed positive match',async t=>{
 const f=await fixture(t),c=await f.ready();await f.bind(c,'a');const a=await f.access(c,'a');
 f.policy(c,{allow:['a']});await a.invoke();assert.equal(f.capabilities.admissionCache.size,1);
 f.policy(c,{deny:['b']});await assert.rejects(a.invoke(),forbidden);assert.equal(f.capabilities.admissionCache.size,0);
 await f.bind(c,'b');await a.invoke();await assert.rejects((await f.access(c,'b')).invoke(),forbidden);
 f.policy(c,{deny:['a']});await assert.rejects(a.invoke(),forbidden);
 f.policy(c,{mode:'all',deny:['c']});await assert.rejects(a.invoke(),forbidden);
 f.policy(c,{mode:'all'});
 const p=f.savePackage(c,{mode:'allowlist',allow:['a','b'],deny:['c']});
 assert.equal((await a.packages()).some(value=>value.id===p.id),false,'unknown package denial wins');
 await f.bind(c,'c');assert.equal((await a.packages()).some(value=>value.id===p.id),true);
 const denied=f.savePackage(c,{mode:'allowlist',allow:['a','b'],deny:['a']});
 assert.equal((await a.packages()).some(value=>value.id===denied.id),false,'confirmed package denial wins');
});

test('inheritance cannot use an unresolved legacy allow check to admit unrelated users',async t=>{
 const f=await fixture(t),c=await f.ready();await f.bind(c,'a');f.policy(c,{mode:'all'});
 const packages=[f.savePackage(c,{mode:'inherit',allow:['b'],legacy:true}),f.savePackage(c,{mode:'denylist',allow:['b'],legacyAllowCheck:true})];
 for(const id of ['a','b','c'])assert.deepEqual(await (await f.access(c,id)).packages(),[]);
 await f.bind(c,'b');
 for(const id of ['a','b','c'])assert.deepEqual((await (await f.access(c,id)).packages()).map(p=>p.id).sort(),packages.map(p=>p.id).sort());
});

for(const projected of [false,true])test(`legacy inherit preserves mixed known/unknown allow checks (${projected?'persisted projection':'original format'})`,async t=>{
 const f=await fixture(t),c=await f.ready();await f.bind(c,'a');f.policy(c,{mode:'all'});
 let legacy=f.savePackage(c,{mode:'inherit',allow:['a','b'],legacy:true});
 if(projected){
  const {id,workspaceId,entityId,version,...input}=legacy;
  assert.equal(input.directoryAccess.channelPolicies[0].legacyAllowCheck,true);
  legacy=f.capabilities.save(workspaceId,entityId,{...input,expectedVersion:version},id);
 }
 const raw=JSON.parse(f.store.one('SELECT config_json FROM capability_packages WHERE id=?',legacy.id).config_json);
 assert.equal(!!raw.directoryAccess.channelPolicies,projected);
 const inherited=f.savePackage(c),a=await f.access(c,'a');
 for(const id of ['a','b','c'])assert.deepEqual((await (await f.access(c,id)).packages()).map(p=>p.id),[inherited.id],'legacy unknown dependency stays closed, modern inherit remains available');
 await f.bind(c,'b');assert.deepEqual((await a.packages()).map(p=>p.id).sort(),[legacy.id,inherited.id].sort());
});

for(const cached of [false,true])test(`mapping and credential revocation defeat ${cached?'warm cached':'uncached partial'} grants`,async t=>{
 const f=await fixture(t),c=await f.ready();await f.bind(c,'a');f.policy(c,{allow:cached?['a']:['a','b']});
 const a=await f.access(c,'a');await a.invoke();await a.invoke();assert.equal(f.capabilities.admissionCache.size,cached?1:0);
 const before=f.record(c);assert.equal(f.repository.save({...before,wecomContactMappings:[]},before),true);
 await assert.rejects(a.invoke(),forbidden);assert.equal(f.capabilities.admissionCache.size,0);
 await f.bind(c,'a');await a.invoke();
 await f.channels.revalidate('w','e','wecom','u',f.record(c).revision);
 await assert.rejects(a.invoke(),forbidden);
 f.channels.observeFirstInbound(c.id,{appId:c.appId,botId:c.appId,tenantId:c.appId,tenantNamespace:'app_id'});
 await (await f.access(c,'a')).invoke(); // Same-bot authenticated renewal restores durable member proof.
});

test('the same search/callback IDs do not share grants between robots',async t=>{
 const f=await fixture(t),first=await f.ready(),second=await f.ready('e2');await f.bind(first,'a');f.policy(first);f.policy(second);
 const one=await f.access(first,'a'),two=await f.access(second,'a');await one.invoke();await assert.rejects(two.invoke(),forbidden);
 await f.bind(second,'a');await two.invoke();f.policy(second,{allow:['b']});await assert.rejects(two.invoke(),forbidden);await one.invoke();
 assert.equal(await f.capabilities.authorizeChannel({...one.scope,entityId:'e2'},one.b.connection,'private'),false);
 assert.equal(await f.capabilities.authorizeChannel({...one.scope,requesterIdentity:{...one.scope.requesterIdentity,applicationId:second.appId}},one.b.connection,'private'),false);
});

for(const change of ['policy','source','credentials'])test(`in-flight ${change} changes fence uncached positive decisions`,async t=>{
 const f=await fixture(t),c=await f.ready();await f.bind(c,'a');f.policy(c);const a=await f.access(c,'a');
 const matches=f.channels.matches.bind(f.channels);let changed=false;
 f.channels.matches=async(...args)=>{
  const result=await matches(...args);
  if(result===true&&!changed){changed=true;if(change==='policy')f.policy(c,{allow:['b']});else{const r=f.record(c);assert.equal(f.repository.save({...r,...(change==='source'?{sourceId:'replacement-source'}:{authRevision:r.authRevision+1})},r),true);}}
  return result;
 };
 await assert.rejects(a.invoke(),forbidden);assert.equal(changed,true);assert.equal(f.capabilities.admissionCache.size,0);
});
