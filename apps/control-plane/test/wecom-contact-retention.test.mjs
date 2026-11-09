import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {Store} from '../dist/store.js';
import {EmployeeChannelRepository} from '../dist/employee-channels/repository.js';
import {EmployeeChannelService,channelSubject} from '../dist/employee-channels/service.js';
import {CapabilityConfigService} from '../dist/capability-config.js';
import {registerHumanConfiguration} from '../dist/human-configuration.js';
import {weComCallbackUserId} from '../dist/employee-channels/wecom-bot-contacts.js';

// Same isolated SQLite / synthetic provider-search convention as onboarding tests.
// Real service, code issuance, mapping and policy implementations; no external I/O.
const wrap=result=>({errcode:0,results_json:JSON.stringify({result:JSON.stringify(result)})});
async function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'wecom-contact-retention-')),file=join(root,'test.sqlite'),store=new Store(file);
 let clock=1_800_000_000_000,batch=0;
 store.run("INSERT INTO users VALUES('u','owner','Owner','active')");
 store.run("INSERT INTO workspaces VALUES('w','Fixture','u','active'),('w2','Other','u','active')");
 store.run("INSERT INTO members VALUES('m','w','u','owner','active'),('m2','w2','u','owner','active')");
 store.run("INSERT INTO entities(id,workspace_id,name,owner_member_id,created_by_member_id,own_web_use,web_use_user_id,interaction_runtime) VALUES('e','w','Employee','m','m',1,'u','builtin'),('e2','w','Second','m','m',1,'u','builtin'),('e3','w2','Foreign','m2','m2',1,'u','builtin')");
 const catalog=new Map(),state={removed:new Set(),queries:[],beforeSearch:undefined};
 const options={masterKey:Buffer.alloc(32,31),now:()=>clock,fetch:async(url,init)=>{
  const parsed=new URL(url);assert.equal(parsed.origin,'https://qyapi.weixin.qq.com');
  const input=JSON.parse(init.body);
  if(parsed.pathname==='/cgi-bin/aibot/cli/get_cli_config')return Response.json({errcode:0,token:'synthetic-'+input.bot_id});
  if(parsed.pathname==='/cli/service/discovery')return Response.json(wrap({base_url:'https://qyapi.weixin.qq.com/cli',resources:{users:{methods:{search:{path:'/contact/users/search',http_method:'POST'}}}}}));
  assert.equal(parsed.pathname,'/cli/contact/users/search');
  const {keywords}=JSON.parse(input.payload);state.queries.push(keywords);await state.beforeSearch?.();
  const users=keywords[0].startsWith('batch:')?Array.from({length:100},(_,i)=>({userid:keywords[0]+'-'+i,name:'Bulk '+keywords[0]+' '+i,departments:[]})):[...catalog.values()].filter(p=>keywords.includes(p.userid)||keywords.includes(p.name)).filter(p=>!state.removed.has(p.userid));
  return Response.json(wrap({users,users_count:users.length}));
 }};
 const repository=new EmployeeChannelRepository(store),channels=new EmployeeChannelService(repository,options),capabilities=new CapabilityConfigService(store,[],channels,undefined,undefined,undefined,options.now);
 channels.setAccessCheck((...args)=>capabilities.authorizeChannel(...args));channels.setMemberVerificationReceiver(async()=>true);
 const app=Fastify();app.setErrorHandler((error,_r,reply)=>reply.code(error.status??error.statusCode??500).send({error:error.code??error.message}));
 registerHumanConfiguration(app,store,channels,()=>{},capabilities);await app.ready();
 t.after(async()=>{await app.close();capabilities.close();store.close();rmSync(root,{recursive:true,force:true});});
 const current=c=>repository.byId(c.id),ready=async(entityId='e',workspaceId='w')=>{
  const c=await channels.save(workspaceId,entityId,'wecom','u',{appId:'synthetic-'+entityId,appSecret:'synthetic-secret'});
  channels.observeFirstInbound(c.id,{appId:c.appId,botId:c.appId,tenantId:c.appId,tenantNamespace:'app_id'});return current(c);
 };
 const search=(c,keywords)=>channels.searchWeComMembers(c.workspaceId,c.entityId,keywords);
 const seed=async(c,ids)=>{for(const id of ids)catalog.set(id,{userid:id,name:'Member '+id,departments:['Engineering']});return search(c,ids);};
 const bulk=async(c,count=7)=>{for(let i=0;i<count;i++){clock++;assert.equal((await search(c,['batch:'+batch++])).items.length,100);}};
 const rule=(c,id)=>({sourceId:c.sourceId,kind:'channel_user',subjectId:channelSubject('channel_user',id,'user_id',c.appId),conversationKinds:['private']});
 const policy=(c,allow=[],deny=[],mode='allowlist')=>capabilities.patchDirectoryAccess(c.workspaceId,c.entityId,{sourceId:c.sourceId,mode,allow:allow.map(id=>rule(c,id)),deny:deny.map(id=>rule(c,id)),allowGroupMembers:false,expectedRevision:capabilities.getDirectoryAccess(c.workspaceId,c.entityId).channelPolicies.find(p=>p.sourceId===c.sourceId).revision});
 const target=(c,id)=>({kind:'wecom_directory',connectionId:c.id,provider:'wecom',appId:c.appId,tenantId:c.eventTenantId,sourceId:c.sourceId,authRevision:c.authRevision,directoryUserId:id,identityNamespace:'user_id'});
 const url=c=>`/api/workspaces/${c.workspaceId}/entities/${c.entityId}/human-confirmation`;
 const candidates=async c=>(await app.inject({url:url(c)})).json().candidates.filter(x=>x.target.kind==='wecom_directory');
 const saveHuman=async(c,ids,expectedVersion=0)=>{const response=await app.inject({method:'PUT',url:url(c),payload:{expectedVersion,rules:ids.map((id,i)=>({questionScope:i?'Scope '+i:'*',target:target(c,id)}))}});assert.equal(response.statusCode,200,response.body);};
 const start=(c,id)=>channels.startMemberVerification(c.workspaceId,c.entityId,'u',{sourceId:c.sourceId,userId:id,requestId:randomUUID()});
 const accept=(c,id,issued)=>assert.equal(channels.memberVerification.accept(current(c),{text:issued.phrase,callbackUserId:'callback-'+id,eventId:randomUUID(),messageId:randomUUID(),privateMessage:true}),'verified');
 const bind=async(c,id)=>accept(c,id,await start(c,id));
 const savePackage=(c,id,enabled=true)=>capabilities.save(c.workspaceId,c.entityId,{name:'Package '+id,enabled,mode:'inherit',allowMemberIds:[],denyMemberIds:[],resourceIds:[],directoryAccess:{allow:[],deny:[],channelPolicies:[{sourceId:c.sourceId,mode:'inherit',allow:[rule(c,id)],deny:[]}]}});
 const count=c=>store.one('SELECT count(*) n FROM wecom_bot_contacts WHERE connection_id=?',c.id).n;
 return {root,file,store,options,repository,channels,capabilities,app,state,catalog,current,ready,search,seed,bulk,rule,policy,target,candidates,saveHuman,start,accept,bind,savePackage,count,advance:ms=>clock+=ms};
}

test('thousands of searches retain verified, exact-ID and pending members plus 500 ordinary candidates',async t=>{
 const f=await fixture(t),c=await f.ready();await f.seed(c,['mapped','exact','pending','ordinary']);
 await f.bind(c,'mapped');f.channels.observeWeComContact(c.id,'exact');const pending=await f.start(c,'pending');
 f.policy(c,['mapped','exact']);await f.bulk(c,21);
 assert.equal(f.count(c),503);assert.equal(f.channels.botContacts.get(f.current(c),'ordinary'),undefined);
 for(const id of ['mapped','exact','pending'])assert.equal(f.channels.botContacts.get(f.current(c),id).display_name,'Member '+id);
 f.advance(600001);assert.equal(f.channels.botContacts.recent(f.current(c)).length,0);
 const choices=await f.candidates(c);assert.deepEqual(choices.map(x=>x.target.directoryUserId).sort(),['exact','mapped','pending']);
 assert.equal(choices.find(x=>x.target.directoryUserId==='pending').identityVerified,false);
 await f.channels.assertWeComPrivateRecipient(c.id,'callback-mapped');await f.channels.assertWeComPrivateRecipient(c.id,'exact');
 assert.deepEqual(f.state.queries.at(-2),['Member mapped']);
 await assert.rejects(f.channels.assertWeComPrivateRecipient(c.id,'mapped'),/authorization_denied/);
 await assert.rejects(f.channels.assertWeComPrivateRecipient(c.id,'pending'),/authorization_denied/);
 f.accept(c,'pending',pending);await f.bulk(c);await f.channels.assertWeComPrivateRecipient(c.id,'callback-pending');
 assert.equal(f.count(c),503);
});

test('saved inactive lists, disabled packages and unverified human choices retain profiles without binding or authorization',async t=>{
 const f=await fixture(t),c=await f.ready();await f.seed(c,['allow','deny','package','confirmer','ordinary']);
 f.policy(c,['allow'],['deny'],'all');const pkg=f.savePackage(c,'package',false);await f.saveHuman(c,['confirmer']);
 await f.bulk(c);f.advance(600001);
 for(const id of ['allow','deny','package','confirmer'])assert.equal(f.channels.botContacts.get(f.current(c),id).display_name,'Member '+id);
 assert.equal(f.count(c),504);assert.equal(f.channels.botContacts.get(f.current(c),'ordinary'),undefined);
 const choices=await f.candidates(c);assert.equal(choices.length,4);assert.ok(choices.every(x=>!x.identityVerified));
 assert.equal(f.current(c).wecomContactMappings,undefined);assert.equal(f.current(c).wecomVerifiedContactIds,undefined);
 const binding=await f.channels.resolveBinding(c.id);
 for(const id of ['allow','package','confirmer']){
  await assert.rejects(f.channels.assertWeComPrivateRecipient(c.id,id),/authorization_denied/);
  assert.equal(await f.capabilities.authorizeChannel({workspaceId:c.workspaceId,entityId:c.entityId,requesterKind:'channel_user',requesterId:id,requesterIdentity:{idNamespace:'user_id',applicationId:c.appId},conversationKind:'private'},binding.connection,'private'),false);
 }
 assert.equal(f.capabilities.list('w','e').find(p=>p.id===pkg.id).enabled,false);
 assert.equal((await f.start(c,'confirmer')).status,'pending','saved unverified selection remains bindable');
});

test('retention does not renew new-selection freshness or permanently pin deleted references and retired challenges',async t=>{
 const f=await fixture(t),c=await f.ready();await f.seed(c,['configured','package','confirmer','pending','mapped']);
 f.policy(c,['configured']);const pkg=f.savePackage(c,'package');await f.saveHuman(c,['confirmer']);const pending=await f.start(c,'pending');await f.bind(c,'mapped');
 const found=f.channels.botContacts.get(f.current(c),'configured').found_at;
 await f.bulk(c);f.advance(600001);
 assert.equal(f.channels.botContacts.get(f.current(c),'configured').found_at,found);
 assert.equal(f.channels.botContacts.selectable(f.current(c),'configured'),false);
 assert.throws(()=>f.channels.validateRules('w','e',[f.rule(c,'configured')]),/invalid_member_search_candidate/);
 assert.deepEqual(f.channels.validateRules('w','e',[f.rule(c,'configured')],[f.rule(c,'configured')]),[f.rule(c,'configured')]);
 f.policy(c);f.store.run('DELETE FROM capability_packages WHERE id=?',pkg.id);await f.saveHuman(c,[],1);
 const before=f.current(c);f.repository.save({...before,wecomContactMappings:[]},before);
 f.advance(pending.expiresAt-f.options.now());await f.bulk(c);
 assert.equal(f.count(c),500);
 for(const id of ['configured','package','confirmer','pending','mapped'])assert.equal(f.channels.botContacts.get(f.current(c),id),undefined);
});

test('same-name searches never bind or rescue a missing exact provider recipient',async t=>{
 const f=await fixture(t),c=await f.ready();await f.seed(c,['one','two']);await f.bind(c,'one');
 f.catalog.get('two').name='Member one';await f.search(c,['two']);
 await f.bulk(c);f.state.removed.add('one');
 await assert.rejects(f.channels.assertWeComPrivateRecipient(c.id,'callback-one'),/authorization_denied/);
 assert.equal(weComCallbackUserId(f.current(c),'two'),undefined);
 assert.equal(weComCallbackUserId(f.current(c),'one'),'callback-one');
});

test('legacy profile loss stays blocked until current search restores metadata without rebinding',async t=>{
 const f=await fixture(t),c=await f.ready();await f.seed(c,['mapped']);await f.bind(c,'mapped');
 const mapping=f.current(c).wecomContactMappings;f.store.run('DELETE FROM wecom_bot_contacts WHERE connection_id=?',c.id);
 await assert.rejects(f.channels.assertWeComPrivateRecipient(c.id,'callback-mapped'),/authorization_denied/);
 await f.seed(c,['mapped']);await f.bulk(c);await f.channels.assertWeComPrivateRecipient(c.id,'callback-mapped');
 assert.deepEqual(f.current(c).wecomContactMappings,mapping);assert.equal((await f.start(c,'mapped')).status,'verified');
});

for(const change of ['workspace','entity','bot','application','namespace','source','credentials'])test(`contact reads and writes reject ${change} scope confusion`,async t=>{
 const f=await fixture(t),c=await f.ready();await f.seed(c,['member']);await f.bind(c,'member');
 const current=f.current(c),patch={workspace:{workspaceId:'w2'},entity:{entityId:'e2'},bot:{botId:'other-bot'},application:{appId:'other-app'},namespace:{identity:{...current.identity,tenantIdNamespace:'corp_id'}},source:{sourceId:'other-source'},credentials:{authRevision:current.authRevision+1}}[change],foreign={...current,...patch};
 assert.equal(f.channels.botContacts.get(foreign,'member'),undefined);assert.deepEqual(f.channels.botContacts.recent(foreign),[]);assert.deepEqual(f.channels.botContacts.retained(foreign),[]);
 f.channels.botContacts.remember(foreign,[{id:'member',displayName:'Wrong scope',departmentPaths:[]}]);
 assert.equal(f.channels.botContacts.get(current,'member').display_name,'Member member');
 await assert.rejects(f.channels.botContacts.verifyRecipient(foreign,'callback-member',{search:async()=>{throw Error('must not query foreign scope');}}),/authorization_denied/);
});

test('foreign workspace/entity/source/app/auth references do not pin unrelated search history',async t=>{
 const f=await fixture(t),c=await f.ready(),other=await f.ready('e2'),foreign=await f.ready('e3','w2');
 await f.seed(c,['foreign-entity','foreign-workspace','foreign-source','foreign-app','foreign-auth','old-challenge','old-mapping']);
 await f.seed(other,['foreign-entity']);await f.seed(foreign,['foreign-workspace']);f.policy(other,['foreign-entity']);f.policy(foreign,['foreign-workspace']);
 const rules=[{...f.rule(c,'foreign-source'),sourceId:other.sourceId},{...f.rule(c,'foreign-app'),subjectId:channelSubject('channel_user','foreign-app','user_id',other.appId)}];
 f.store.run('UPDATE entity_directory_policies SET allow_json=? WHERE entity_id=?',JSON.stringify(rules),c.entityId);
 f.store.run('INSERT INTO employee_human_rules VALUES(?,?,1,?)',c.workspaceId,c.entityId,JSON.stringify([{questionScope:'*',target:{...f.target(c,'foreign-auth'),authRevision:c.authRevision+1}}]));
 const before=f.current(c);f.repository.save({...before,wecomContactIdentityRevision:c.authRevision-1,wecomVerifiedContactIds:['old-mapping'],wecomMemberChallenges:[{userId:'old-challenge',authRevision:c.authRevision-1,status:'pending',expiresAt:f.options.now()+1000000}]},before);
 await f.bulk(c);assert.equal(f.count(c),500);assert.equal(f.channels.botContacts.retained(f.current(c)).length,0);
 await f.bulk(other);await f.bulk(foreign);
 assert.equal(f.channels.botContacts.get(f.current(other),'foreign-entity').display_name,'Member foreign-entity');assert.equal(f.channels.botContacts.get(f.current(foreign),'foreign-workspace').display_name,'Member foreign-workspace');
});

for(const change of ['revalidate','credentials','replacement','unbind'])test(`${change} clears retained profiles and fences stale restoration`,async t=>{
 const f=await fixture(t),c=await f.ready();await f.seed(c,['mapped','configured','pending']);await f.bind(c,'mapped');f.policy(c,['configured']);await f.start(c,'pending');await f.bulk(c);
 const before=f.current(c);assert.equal(f.count(c),503);
 if(change==='revalidate')await f.channels.revalidate('w','e','wecom','u',before.revision);
 else if(change==='unbind')f.channels.unbind('w','e','wecom','u',{expectedRevision:before.revision});
 else await f.channels.save('w','e','wecom','u',{appId:change==='replacement'?'synthetic-replacement':c.appId,appSecret:'rotated-synthetic',expectedRevision:before.revision,...(change==='replacement'?{replaceSource:true}:{})});
 assert.equal(f.count(c),0);assert.equal(f.channels.botContacts.get(before,'mapped'),undefined);
 f.channels.botContacts.remember(before,[{id:'mapped',displayName:'Stale result',departmentPaths:[]}]);assert.equal(f.count(c),0);
 if(change!=='unbind'){const after=f.current(c);assert.equal(weComCallbackUserId(after,'mapped'),undefined);assert.deepEqual(f.channels.botContacts.retained(after),[]);}
});

test('retained profiles persist across a reopened SQLite service without refreshing search age',async t=>{
 const f=await fixture(t),c=await f.ready();await f.seed(c,['mapped','confirmer']);await f.bind(c,'mapped');await f.saveHuman(c,['confirmer']);await f.bulk(c);f.advance(600001);
 const store=new Store(f.file),repository=new EmployeeChannelRepository(store),channels=new EmployeeChannelService(repository,f.options);
 try{const current=repository.byId(c.id);assert.deepEqual(channels.botContacts.retained(current).map(p=>p.user_id).sort(),['confirmer','mapped']);assert.equal(channels.botContacts.recent(current).length,0);await channels.assertWeComPrivateRecipient(c.id,'callback-mapped');}
 finally{store.close();}
});

test('recipient search result cannot survive an in-flight mapping revocation',async t=>{
 const f=await fixture(t),c=await f.ready();await f.seed(c,['mapped']);await f.bind(c,'mapped');
 f.state.beforeSearch=async()=>{f.state.beforeSearch=undefined;const before=f.current(c);f.repository.save({...before,wecomContactMappings:[]},before);};
 await assert.rejects(f.channels.assertWeComPrivateRecipient(c.id,'callback-mapped'),/authorization_denied/);
});

test('an in-flight first inbound does not discard a search started before bot confirmation',async t=>{
 const f=await fixture(t),c=await f.channels.save('w','e','wecom','u',{appId:'synthetic-before-inbound',appSecret:'synthetic-secret'});
 assert.equal(c.status,'pending_verification');
 f.state.beforeSearch=async()=>{f.state.beforeSearch=undefined;f.channels.observeFirstInbound(c.id,{appId:c.appId,botId:c.appId,tenantId:c.appId,tenantNamespace:'app_id'});};
 const result=await f.seed(f.current(c),['member']);assert.equal(result.items.length,1);
 assert.equal(f.channels.botContacts.get(f.current(c),'member').display_name,'Member member');
 assert.equal(f.channels.botContacts.selectable(f.current(c),'member'),true);
});

test('split configuration projects all retained members beyond 500 and clears them after rotation',async t=>{
 const {configurationSnapshot,ConfigurationPoller,deriveRuntimeConfigurationKey}=await import('../dist/split/config-sync.js');
 const f=await fixture(t),c=await f.ready();
 for(let i=0;i<6;i++){
  const result=await f.search(c,['batch:snapshot'+i]);
  f.capabilities.save('w','e',{name:'Retained batch '+i,enabled:false,mode:'inherit',allowMemberIds:[],denyMemberIds:[],resourceIds:[],directoryAccess:{allow:[],deny:[],channelPolicies:[{sourceId:c.sourceId,mode:'inherit',allow:result.items.map(person=>f.rule(c,person.externalId)),deny:[]}]}});
 }
 await f.seed(c,['mapped','pending']);await f.bind(c,'mapped');await f.start(c,'pending');await f.bulk(c);
 assert.equal(f.count(c),1102);f.advance(600001);
 const token='synthetic-configuration-token',runtime=new Store(join(f.root,'runtime.sqlite'),{role:'runtime'}),repository=new EmployeeChannelRepository(runtime),channels=new EmployeeChannelService(repository,{...f.options,masterKey:deriveRuntimeConfigurationKey(token)});
 const snapshot=()=>configurationSnapshot({store:f.store,masterKey:f.options.masterKey,token,now:f.options.now});
 assert.equal(snapshot().tables.find(table=>table.name==='wecom_bot_contacts').rows.length,1102);
 const poller=new ConfigurationPoller({store:runtime,baseUrl:'http://127.0.0.1:9999',token,now:f.options.now,fetch:async()=>{const value=snapshot();return Response.json(value,{headers:{etag:'"'+value.epoch+'"'}});}});
 try{
  assert.equal(await poller.poll(),true);assert.equal(poller.ready,true);
  const current=repository.byId(c.id);assert.equal(runtime.one('SELECT count(*) n FROM wecom_bot_contacts').n,1102);
  assert.equal(channels.botContacts.retained(current).length,602);assert.equal(channels.botContacts.recent(current).length,0);
  await channels.assertWeComPrivateRecipient(c.id,'callback-mapped');
  await f.channels.revalidate('w','e','wecom','u',f.current(c).revision);assert.equal(await poller.poll(),true);
  assert.equal(runtime.one('SELECT count(*) n FROM wecom_bot_contacts').n,0);assert.equal(channels.botContacts.get(current,'mapped'),undefined);
 }finally{poller.stop();runtime.close();}
});
