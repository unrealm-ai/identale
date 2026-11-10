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
 store.run("INSERT INTO members(id,workspace_id,user_id,role,status) VALUES('m','w','u','owner','active'),('m2','w2','u','owner','active')");
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
 const select=(c,person)=>channels.selectWeComMember(c.workspaceId,c.entityId,{sourceId:c.sourceId,userId:person.externalId,selectionToken:person.selectionToken});
 const seed=async(c,ids)=>{for(const id of ids)catalog.set(id,{userid:id,name:'Member '+id,departments:['Engineering']});const page=await search(c,ids);for(const person of page.items)select(c,person);return page;};
 const bulk=async(c,count=7)=>{for(let i=0;i<count;i++){clock++;assert.equal((await search(c,['batch:'+batch++])).items.length,100);}};
 const rule=(c,id)=>({sourceId:c.sourceId,kind:'channel_user',subjectId:channelSubject('channel_user',id,'user_id',c.appId),conversationKinds:['private']});
 const policy=(c,allow=[],deny=[],mode='allowlist')=>capabilities.patchDirectoryAccess(c.workspaceId,c.entityId,{sourceId:c.sourceId,mode,allow:allow.map(id=>rule(c,id)),deny:deny.map(id=>rule(c,id)),allowGroupMembers:false,expectedRevision:capabilities.getDirectoryAccess(c.workspaceId,c.entityId).channelPolicies.find(p=>p.sourceId===c.sourceId).revision});
 const target=(c,id)=>({kind:'wecom_directory',connectionId:c.id,provider:'wecom',appId:c.appId,tenantId:c.eventTenantId,sourceId:c.sourceId,authRevision:c.authRevision,directoryUserId:id,identityNamespace:'user_id'});
 const url=c=>`/api/workspaces/${c.workspaceId}/entities/${c.entityId}/human-confirmation`;
 const candidates=async c=>Promise.all(channels.botContacts.knownPage(current(c)).items.map(async contact=>{const response=await app.inject({method:'POST',url:url(c)+'/resolve',payload:{sourceId:c.sourceId,subjectId:channelSubject('channel_user',contact.user_id,'user_id',c.appId)}});assert.equal(response.statusCode,200,response.body);return response.json();}));
 const saveHuman=async(c,ids,expectedVersion=0)=>{const response=await app.inject({method:'PUT',url:url(c),payload:{expectedVersion,rules:ids.map((id,i)=>({questionScope:i?'Scope '+i:'*',target:target(c,id)}))}});assert.equal(response.statusCode,200,response.body);};
 const start=(c,id)=>channels.startMemberVerification(c.workspaceId,c.entityId,'u',{sourceId:c.sourceId,userId:id,requestId:randomUUID()});
 const accept=(c,id,issued)=>assert.equal(channels.memberVerification.accept(current(c),{text:issued.phrase,callbackUserId:'callback-'+id,eventId:randomUUID(),messageId:randomUUID(),privateMessage:true}),'verified');
 const bind=async(c,id)=>accept(c,id,await start(c,id));
 const savePackage=(c,id,enabled=true)=>capabilities.save(c.workspaceId,c.entityId,{name:'Package '+id,enabled,mode:'inherit',allowMemberIds:[],denyMemberIds:[],resourceIds:[],directoryAccess:{allow:[],deny:[],channelPolicies:[{sourceId:c.sourceId,mode:'inherit',allow:[rule(c,id)],deny:[]}]}});
 const count=c=>store.one('SELECT count(*) n FROM wecom_bot_contacts WHERE connection_id=?',c.id).n;
 return {root,file,store,options,repository,channels,capabilities,app,state,catalog,current,ready,search,select,seed,bulk,rule,policy,target,candidates,saveHuman,start,accept,bind,savePackage,count,advance:ms=>clock+=ms};
}

test('live searches never persist temporary candidates; explicit selection persists authenticated profiles',async t=>{
 const f=await fixture(t),c=await f.ready();f.catalog.set('a',{userid:'a',name:'Member A',departments:['Engineering']});
 const first=await f.search(c,['a']);assert.equal(first.items.length,1);assert.ok(first.items[0].selectionToken);assert.equal(f.count(c),0);
 assert.equal(f.channels.botContacts.selectable(c,'a'),false);assert.throws(()=>f.channels.validateRules('w','e',[f.rule(c,'a')]),/invalid_member_search_candidate/);await assert.rejects(f.start(c,'a'),/invalid_member_search_candidate/);
 f.select(c,first.items[0]);assert.equal(f.count(c),1);assert.equal(f.channels.botContacts.selectable(c,'a'),true);
 f.policy(c,['a']);await f.saveHuman(c,['a']);f.savePackage(c,'a');assert.equal((await f.start(c,'a')).status,'pending');
 await f.search(c,['a']);assert.equal(f.state.queries.length,2,'new keyword search always calls the official search');
 await f.bulk(c,21);assert.equal(f.count(c),1);f.advance(86400000);assert.equal(f.channels.botContacts.get(c,'a').display_name,'Member A');
 assert.deepEqual((await f.search(c,[])).items.map(p=>p.externalId),['a']);
});

test('selection evidence rejects tampering, expiration, user substitution and cross employee scope',async t=>{
 const f=await fixture(t),c=await f.ready(),other=await f.ready('e2');f.catalog.set('a',{userid:'a',name:'A',departments:[]});const person=(await f.search(c,['a'])).items[0];
 assert.throws(()=>f.select(c,{...person,selectionToken:person.selectionToken.slice(0,-8)+'AAAAAAAA'}),/invalid_member_search_candidate/);
 assert.throws(()=>f.select(c,{...person,externalId:'other'}),/invalid_member_search_candidate/);assert.throws(()=>f.select(other,person),/invalid_member_search_candidate/);
 f.advance(30*60_000);assert.throws(()=>f.select(c,person),/invalid_member_search_candidate/);assert.equal(f.count(c),0);
 f.select(c,(await f.search(c,['a'])).items[0]);assert.equal(f.count(c),1);
});

test('search failure is not disguised as cached success and late credentials cannot persist results',async t=>{
 const f=await fixture(t),c=await f.ready();await f.seed(c,['a']);f.state.beforeSearch=async()=>{throw Error('provider unavailable');};
 await assert.rejects(f.search(c,['a']),/unavailable/);assert.equal(f.count(c),1);
 f.state.beforeSearch=async()=>{f.state.beforeSearch=undefined;await f.channels.save('w','e','wecom','u',{appId:c.appId,appSecret:'new-secret',expectedRevision:f.current(c).revision});};
 await assert.rejects(f.search(c,['a']),/channel_configuration_changed/);assert.equal(f.count(c),1);
});

test('selected profiles, pending verification and bindings survive search age and SQLite reopen without external recheck',async t=>{
 const f=await fixture(t),c=await f.ready();await f.seed(c,['mapped','confirmer']);await f.bind(c,'mapped');await f.saveHuman(c,['confirmer']);await f.bulk(c);f.advance(600001);
 const store=new Store(f.file),repository=new EmployeeChannelRepository(store),channels=new EmployeeChannelService(repository,f.options);
 try{const current=repository.byId(c.id);assert.deepEqual(channels.botContacts.retained(current).map(p=>p.user_id),['confirmer','mapped']);assert.equal(channels.botContacts.recent(current).length,2);const queries=f.state.queries.length;await channels.assertWeComPrivateRecipient(c.id,'callback-mapped');assert.equal(f.state.queries.length,queries);}finally{store.close();}
});

for(const change of ['workspace','entity','bot','application','namespace','source','credentials'])test(`contact reads and writes reject ${change} scope confusion`,async t=>{
 const f=await fixture(t),c=await f.ready();await f.seed(c,['member']);await f.bind(c,'member');
 const current=f.current(c),patch={workspace:{workspaceId:'w2'},entity:{entityId:'e2'},bot:{botId:'other-bot'},application:{appId:'other-app'},namespace:{identity:{...current.identity,tenantIdNamespace:'corp_id'}},source:{sourceId:'other-source'},credentials:{authRevision:current.authRevision+1}}[change],foreign={...current,...patch};
 assert.equal(f.channels.botContacts.get(foreign,'member'),undefined);assert.deepEqual(f.channels.botContacts.recent(foreign),[]);assert.deepEqual(f.channels.botContacts.retained(foreign),[]);
 f.channels.botContacts.remember(foreign,[{id:'member',displayName:'Wrong scope',departmentPaths:[]}]);assert.equal(f.channels.botContacts.get(current,'member').display_name,'Member member');
 await assert.rejects(f.channels.botContacts.verifyRecipient(foreign,'callback-member'),/authorization_denied/);
});

for(const change of ['revalidate','credentials','replacement','unbind'])test(`${change} preserves same-bot profiles but fences stale selection tokens`,async t=>{
 const f=await fixture(t),c=await f.ready();const person=(await f.seed(c,['member'])).items[0];const before=f.current(c);
 if(change==='revalidate')await f.channels.revalidate('w','e','wecom','u',before.revision);
 else if(change==='unbind')f.channels.unbind('w','e','wecom','u',{expectedRevision:before.revision});
 else await f.channels.save('w','e','wecom','u',{appId:change==='replacement'?'synthetic-replacement':c.appId,appSecret:'rotated-synthetic',expectedRevision:before.revision,...(change==='replacement'?{replaceSource:true}:{})});
 const expected=['revalidate','credentials'].includes(change)?1:0;assert.equal(f.count(c),expected);assert.equal(f.channels.botContacts.get(before,'member'),undefined);assert.throws(()=>f.select(c,person));assert.equal(f.count(c),expected);
});

test('selected people are pageable beyond 500; no arbitrary count or selection-age limit',async t=>{
 const f=await fixture(t),c=await f.ready();for(let i=0;i<6;i++){const page=await f.search(c,['batch:saved'+i]);for(const p of page.items)f.select(c,p);}
 assert.equal(f.count(c),600);f.advance(86400000);let cursor,ids=[];do{const page=await f.channels.searchWeComMembers('w','e',[],cursor);ids.push(...page.items.map(p=>p.externalId));cursor=page.nextCursor;}while(cursor);
 assert.equal(ids.length,600);assert.equal(new Set(ids).size,600);assert.equal(f.channels.botContacts.knownPage(c,{keywords:['saved0']}).items.length,50);
});

test('legacy temporary rows cannot authorize selections but currently referenced profiles remain usable',async t=>{
 const f=await fixture(t),c=await f.ready();await f.seed(c,['saved','temporary']);f.policy(c,['saved']);f.store.run('UPDATE wecom_bot_contacts SET selected=0 WHERE connection_id=?',c.id);
 assert.equal(f.channels.botContacts.get(c,'temporary'),undefined);assert.equal(f.channels.botContacts.selectable(c,'temporary'),false);assert.equal(f.channels.botContacts.selectable(c,'saved'),true);assert.deepEqual((await f.search(c,[])).items.map(p=>p.externalId),['saved']);
});

test('an in-flight first inbound does not invalidate a search and selection started before confirmation',async t=>{
 const f=await fixture(t),c=f.current(await f.channels.save('w','e','wecom','u',{appId:'synthetic-before-inbound',appSecret:'synthetic-secret'}));
 f.state.beforeSearch=async()=>{f.state.beforeSearch=undefined;f.channels.observeFirstInbound(c.id,{appId:c.appId,botId:c.appId,tenantId:c.appId,tenantNamespace:'app_id'});};
 await f.seed(c,['member']);assert.equal(f.channels.botContacts.selectable(f.current(c),'member'),true);
});

 test('fresh search updates selected profile instead of overwriting it with old local metadata',async t=>{
 const f=await fixture(t),c=await f.ready();await f.seed(c,['renamed']);
 f.catalog.set('renamed',{userid:'renamed',name:'New display name',departments:['New team']});
 const page=await f.search(c,['renamed']),person=page.items.find(p=>p.externalId==='renamed');
 assert.equal(person.displayName,'New display name');assert.deepEqual(person.departmentPaths,['New team']);
 f.select(c,person);assert.equal(f.channels.botContacts.get(f.current(c),'renamed').display_name,'New display name');
 });
