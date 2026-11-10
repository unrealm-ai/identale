import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../dist/store.js';
import {EmployeeChannelRepository} from '../dist/employee-channels/repository.js';
import {EmployeeChannelService,channelSubject} from '../dist/employee-channels/service.js';
import {CapabilityConfigService} from '../dist/capability-config.js';
import {withIdentityDelta,identityLookup,attachIdentityBindings} from '../dist/employee-channels/wecom-identity-bindings.js';
import {weComCallbackUserId,weComSearchUserId} from '../dist/employee-channels/wecom-bot-contacts.js';

// Same isolated Store/service fixture as wecom-partial-whitelist-access: real
// repository, bindings and permissions, no remote directory or channel calls.
async function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'wecom-bindings-')),store=new Store(join(root,'test.sqlite'));
 store.run("INSERT INTO users(id,username,display_name) VALUES('u','fixture','Owner')");
 store.run("INSERT INTO workspaces(id,name,created_by) VALUES('w','Fixture','u')");
 store.run("INSERT INTO members(id,workspace_id,user_id,role) VALUES('m','w','u','owner')");
 store.run("INSERT INTO entities(id,workspace_id,name,owner_member_id,created_by_member_id,own_web_use,web_use_user_id,interaction_runtime) VALUES('e','w','Employee','m','m',1,'u','builtin'),('e2','w','Second','m','m',1,'u','builtin')");
 const repository=new EmployeeChannelRepository(store),channels=new EmployeeChannelService(repository,{masterKey:Buffer.alloc(32,41),fetch:async()=>{throw Error('unexpected external request');}}),capabilities=new CapabilityConfigService(store,[],channels);
 channels.setAccessCheck((...args)=>capabilities.authorizeChannel(...args));
 t.after(()=>{capabilities.close();store.close();rmSync(root,{recursive:true,force:true});});
 const c=await channels.save('w','e','wecom','u',{appId:'synthetic-bot',appSecret:'synthetic-secret'});
 channels.observeFirstInbound(c.id,{appId:c.appId,botId:c.appId,tenantId:c.appId,tenantNamespace:'app_id'});
 const current=()=>repository.byId(c.id),mapping=(userId,callbackUserId)=>({userId,callbackUserId,requestId:'request-'+userId,verifiedAt:1800000000000,method:'administrator_relay'});
 const bind=(userId,callbackUserId)=>{const old=current();return repository.save(withIdentityDelta({...old,wecomContactIdentityRevision:old.authRevision},{exact:[],maps:[mapping(userId,callbackUserId)]}),old);};
 return {store,file:join(root,'test.sqlite'),repository,channels,capabilities,c,current,mapping,bind};
}

test('legacy JSON evidence is not trusted or silently imported into the binding table',async t=>{
 const f=await fixture(t),r=f.current();
 f.store.run('UPDATE employee_channel_connections SET record_json=? WHERE id=?',JSON.stringify({...r,wecomContactIdentityRevision:r.authRevision,wecomVerifiedContactIds:['legacy'],wecomContactMappings:[f.mapping('old','old-callback')]}),r.id);
 const decoded=f.current();assert.equal(weComCallbackUserId(decoded,'legacy'),undefined);assert.equal(weComCallbackUserId(decoded,'old'),undefined);assert.equal(f.store.one('SELECT count(*) n FROM wecom_identity_bindings').n,0);
});

test('ten thousand durable relationships leave record JSON bounded and both exact lookups indexed',async t=>{
 const f=await fixture(t);f.bind('first','callback-first');const before=f.store.one('SELECT record_json FROM employee_channel_connections WHERE id=?',f.c.id).record_json;
 const old=f.current(),maps=Array.from({length:10000},(_,i)=>f.mapping('person-'+i,'callback-'+i));assert.equal(f.repository.save(withIdentityDelta({...old},{exact:[],maps}),old),true);
 const after=f.store.one('SELECT record_json FROM employee_channel_connections WHERE id=?',f.c.id).record_json;
 const a=JSON.parse(before),b=JSON.parse(after);delete a.stateVersion;delete b.stateVersion;assert.deepEqual(a,b);assert.ok(after.length<before.length+20);
 assert.equal(f.store.one('SELECT count(*) n FROM wecom_identity_bindings').n,10001);
 for(const key of ['user_id','callback_user_id']){const plan=f.store.all(`EXPLAIN QUERY PLAN SELECT user_id,callback_user_id,mapping_json FROM wecom_identity_bindings WHERE connection_id=? AND source_id=? AND auth_revision=? AND ${key}=?`,old.id,old.sourceId,old.authRevision,key==='user_id'?'person-9999':'callback-9999').map(x=>x.detail).join(' ');assert.match(plan,/SEARCH.*INDEX/);}
 assert.equal(weComCallbackUserId(f.current(),'person-9999'),'callback-9999');assert.equal(weComSearchUserId(f.current(),'callback-9999'),'person-9999');
});

test('failed CAS writes no binding and reverse uniqueness conflict rolls back record state',async t=>{
 const f=await fixture(t),stale=f.current();assert.equal(f.bind('a','callback-a'),true);
 assert.equal(f.repository.save(withIdentityDelta({...stale,wecomContactIdentityRevision:stale.authRevision},{exact:[],maps:[f.mapping('b','callback-b')]}),stale),false);assert.equal(identityLookup(f.current(),'user_id','b'),undefined);
 const current=f.current(),before=f.store.one('SELECT record_json FROM employee_channel_connections WHERE id=?',current.id).record_json;
 assert.throws(()=>f.repository.save(withIdentityDelta({...current},{exact:[],maps:[f.mapping('c','callback-c'),f.mapping('d','callback-a')]}),current));
 assert.equal(f.store.one('SELECT record_json FROM employee_channel_connections WHERE id=?',current.id).record_json,before);assert.equal(identityLookup(f.current(),'user_id','c'),undefined);assert.equal(weComCallbackUserId(f.current(),'a'),'callback-a');
});

test('binding queries are partitioned by connection, source and credential generation',async t=>{
 const f=await fixture(t);f.bind('a','callback-a');const r=f.current();
 for(const change of [{id:'other'},{sourceId:'foreign'},{authRevision:r.authRevision+1,wecomContactIdentityRevision:r.authRevision+1}]){const other=attachIdentityBindings(f.store,{...r,...change});assert.equal(weComCallbackUserId(other,'a'),undefined);assert.equal(weComSearchUserId(other,'callback-a'),undefined);}
 const next={...r,authRevision:r.authRevision+1,wecomContactIdentityRevision:undefined};assert.equal(f.repository.save(next,r),true);assert.equal(f.store.one('SELECT count(*) n FROM wecom_identity_bindings').n,0);
});

test('authorization and direct identity lookups never enumerate legacy relationship getters',async t=>{
 const f=await fixture(t);f.bind('a','callback-a');const r=f.current();f.channels.botContacts.remember(r,[{id:'a',displayName:'Synthetic A',departmentPaths:[]}]);
 for(const field of ['wecomVerifiedContactIds','wecomContactMappings'])Object.defineProperty(r,field,{configurable:true,get(){throw Error('full relationship enumeration');}});
 assert.equal(weComCallbackUserId(r,'a'),'callback-a');assert.equal(weComSearchUserId(r,'callback-a'),'a');
 const get=f.repository.byId.bind(f.repository);f.repository.byId=id=>id===r.id?r:get(id);
 const allow={sourceId:r.sourceId,kind:'channel_user',subjectId:channelSubject('channel_user','a','user_id',r.appId),conversationKinds:['private']};f.capabilities.saveDirectoryAccess('w','e',{allow:[allow],deny:[]});
 const binding=await f.channels.resolveBinding(r.id),scope={workspaceId:'w',entityId:'e',requesterId:'callback-a',requesterKind:'channel_user',requesterIdentity:{idNamespace:'user_id',applicationId:r.appId},conversationKind:'private'};
 assert.equal(await f.capabilities.authorizeChannel(scope,binding.connection,'private'),true);assert.equal(await f.capabilities.authorizeChannel(scope,binding.connection,'private'),true);
});


test('a new repository process view resolves durable evidence without a search cache',async t=>{
 const f=await fixture(t);f.bind('a','callback-a');f.store.run('DELETE FROM wecom_bot_contacts');
 const reopened=new Store(f.file);try{const repository=new EmployeeChannelRepository(reopened),r=repository.byId(f.c.id);assert.equal(weComCallbackUserId(r,'a'),'callback-a');assert.equal(weComSearchUserId(r,'callback-a'),'a');assert.equal(reopened.one('SELECT count(*) n FROM wecom_bot_contacts').n,0);}finally{reopened.close();}
});

for(const operation of ['revalidate','rotate'])test(`same bot ${operation} preserves bindings only behind fresh authenticated ingress`,async t=>{
 const f=await fixture(t);f.bind('a','callback-a');const original=f.current();
 const {resolveHumanTarget}=await import('../dist/human-target.js');
 const target={kind:'wecom_directory',connectionId:original.id,provider:'wecom',appId:original.appId,tenantId:original.eventTenantId,sourceId:original.sourceId,authRevision:original.authRevision,directoryUserId:'a',identityNamespace:'user_id'};
 const version=f.channels.currentBindingVersion(original.id);
 for(let i=0;i<2;i++){
  const before=f.current();
  if(operation==='revalidate')await f.channels.revalidate('w','e','wecom','u',before.revision);
  else await f.channels.save('w','e','wecom','u',{appId:before.appId,appSecret:'new-secret-'+i,expectedRevision:before.revision});
  assert.equal(f.channels.currentBindingVersion(original.id),undefined);
  assert.equal(await f.channels.resolveBinding(original.id),undefined);
  assert.throws(()=>resolveHumanTarget(f.channels,'w','e',target),/human_recipient_configuration_changed/);
  assert.equal(f.store.one('SELECT count(*) n FROM wecom_identity_bindings').n,1);
  assert.equal(f.repository.save({...before},before),false);
  const pending=f.current();assert.equal(f.repository.save({...pending,status:'invalid',lastError:'credential_rejected'},pending),true);
  assert.equal(await f.channels.resolveBinding(original.id),undefined);
  assert.throws(()=>resolveHumanTarget(f.channels,'w','e',target),/human_recipient_configuration_changed/);
  const invalid=f.current();assert.equal(f.repository.save({...invalid,status:'pending_verification'},invalid),true);
 }
 assert.throws(()=>f.channels.observeFirstInbound(original.id,{appId:original.appId,botId:'wrong',tenantId:original.appId,tenantNamespace:'app_id'}),/channel_verification_identity_conflict/);
 f.channels.observeFirstInbound(original.id,{appId:original.appId,botId:original.appId,tenantId:original.appId,tenantNamespace:'app_id'});
 assert.equal(weComCallbackUserId(f.current(),'a'),'callback-a');
 assert.equal(resolveHumanTarget(f.channels,'w','e',target).userId,'callback-a');
 assert.equal(f.channels.currentBindingVersion(original.id),version);
 const current=f.current();await f.channels.save('w','e','wecom','u',{appId:'other-bot',appSecret:'other-secret',expectedRevision:current.revision,replaceSource:true});
 assert.equal(f.store.one('SELECT count(*) n FROM wecom_identity_bindings').n,0);
 f.channels.observeFirstInbound(original.id,{appId:'other-bot',botId:'other-bot',tenantId:'other-bot',tenantNamespace:'app_id'});
 assert.throws(()=>resolveHumanTarget(f.channels,'w','e',target),/human_recipient_configuration_changed/);
});
