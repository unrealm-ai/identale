import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {Store} from '../dist/store.js';
import {EmployeeChannelRepository} from '../dist/employee-channels/repository.js';
import {EmployeeChannelService} from '../dist/employee-channels/service.js';
import {registerChannelObservationApi,installChannelObservationReporter} from '../dist/split/channel-observations.js';
const token='synthetic-configuration-observation-token';
const record=()=>({id:'c',sourceId:'source',workspaceId:'w',entityId:'e',provider:'dingtalk',appId:'app',identity:{appId:'app',tenantId:'app',tenantIdNamespace:'app_id'},revision:3,authRevision:1,stateVersion:0,status:'pending_verification',enabled:true,inboundVerified:false,directoryStatus:'available',lastError:null,credential:{ciphertext:'synthetic-private-ciphertext',nonce:'synthetic-nonce',tag:'synthetic-tag'},createdBy:'u',updatedBy:'u',context:{historyEnabled:false,groupListenEnabled:false,listenGeneration:4,meetingRefs:[]},verification:{challengeId:'challenge',challengeText:'challenge-text',expiresAt:9999999999999}});
function fixture(t,customize=r=>r){
 const dir=mkdtempSync(join(tmpdir(),'identity-channel-observations-'));
 const stores=[];const setup=name=>{const store=new Store(join(dir,name+'.sqlite'),{role:name==='platform'?'platform':'runtime'});stores.push(store);store.run("INSERT INTO users(id,username,display_name) VALUES('u','fixture','Fixture')");store.run("INSERT INTO workspaces(id,name,created_by) VALUES('w','Fixture','u')");store.run("INSERT INTO members(id,workspace_id,user_id,role) VALUES('m','w','u','owner')");store.run("INSERT INTO entities(id,workspace_id,name,owner_member_id,created_by_member_id,own_web_use,web_use_user_id,interaction_runtime) VALUES('e','w','Employee','m','m',1,'u','builtin')");const repository=new EmployeeChannelRepository(store),service=new EmployeeChannelService(repository);const initial=customize(record());if(initial.directoryBinding)store.run("INSERT INTO employee_channel_directory_credentials(id,workspace_id,provider,corp_id,agent_id,state_version,record_json) VALUES(?,?,'wecom','corp','agent',1,'{}')",initial.directoryBinding.credentialId,'w');repository.save(initial,undefined);return{store,repository,service};};
 const platform=setup('platform'),runtime=setup('runtime'),server=Fastify();registerChannelObservationApi(server,{token,channels:platform.service,store:platform.store});
 const sent=[];let loseResponse=false;const transport=async(url,init)=>{assert.equal(String(url),'http://127.0.0.1:1/internal/config/channel-observation');sent.push(JSON.parse(init.body));const result=await server.inject({method:'POST',url:'/internal/config/channel-observation',headers:init.headers,payload:JSON.parse(init.body)});if(loseResponse){loseResponse=false;throw Error('synthetic lost response');}return new Response(result.body,{status:result.statusCode,headers:{'content-type':'application/json'}});};
 const reporter=installChannelObservationReporter(runtime.store,runtime.repository,{url:'http://127.0.0.1:1',token,fetch:transport});
 t.after(async()=>{await reporter.close();await server.close();for(const store of stores)store.close();rmSync(dir,{recursive:true,force:true});});
 return{platform,runtime,reporter,server,sent,async reopen(){await reporter.close();runtime.store.close();stores.splice(stores.indexOf(runtime.store),1);const reopened=new Store(join(dir,'runtime.sqlite'),{role:'runtime'});stores.push(reopened);return reopened;},lose(){loseResponse=true;}};
}
const candidate={appId:'app',botId:'robot',tenantId:'tenant',robotCode:'robot',challengeText:'challenge-text',eventId:'event-1',messageId:'message-1'};
test('real installation candidate and verification markers reach platform, survive authoritative confirmation',async t=>{
 const f=fixture(t);f.runtime.service.recordVerifiedCandidate('c','3',candidate);
 assert.equal(f.platform.service.verification('w','e','dingtalk').status,'waiting');
 assert.equal(f.runtime.store.one('SELECT count(*) n FROM channel_state_reports').n,2);
 await f.reporter.flush();
 const observed=f.platform.service.verification('w','e','dingtalk');assert.equal(observed.status,'observed');
 assert.equal(f.platform.service.isVerificationEvent('c','event-1'),true);assert.equal(f.platform.service.isVerificationEvent('c','other','message-1'),true);
 const before=f.platform.repository.byId('c'),confirmed=f.platform.service.confirmVerification('w','e','dingtalk','u',{expectedRevision:observed.revision,candidateId:observed.candidateId});
 assert.equal(confirmed.status,'verified');assert.equal(confirmed.inboundVerified,true);assert.equal(confirmed.revision,before.revision+1);assert.equal(f.platform.repository.byId('c').context.listenGeneration,4);
 const json=JSON.stringify(f.sent);assert.equal(json.includes('synthetic-private'),false);assert.equal(json.includes('credential'),false);
});
test('accepted-but-unknown network response reuses report ID and does not repeat CAS update',async t=>{
 const f=fixture(t);const old=f.runtime.repository.byId('c');f.runtime.repository.save({...old,directoryStatus:'unavailable',lastError:'authentication_failed',status:'invalid',revision:old.revision+1},old);f.lose();await f.reporter.flush();
 assert.equal(f.reporter.status()[0].status,'pending');const version=f.platform.repository.byId('c').stateVersion;
 await f.reporter.flush();assert.equal(f.platform.repository.byId('c').stateVersion,version);assert.equal(f.sent[0].reportId,f.sent[1].reportId);assert.equal(f.reporter.status()[0].status,'accepted');
 assert.equal(f.platform.store.one('SELECT count(*) n FROM channel_observation_receipts').n,1);
});
test('admin revision/auth revision/state changes conflict without changing enabled, credentials or context',async t=>{
 for(const field of ['revision','authRevision','stateVersion']){
  const f=fixture(t),old=f.runtime.repository.byId('c');f.runtime.repository.save({...old,status:'invalid',lastError:'authentication_failed',revision:old.revision+1},old);
  const current=f.platform.repository.byId('c');if(field==='stateVersion')f.platform.repository.save({...current,enabled:false,status:'disabled'},current);else f.platform.repository.save({...current,[field]:current[field]+1},current);
  const before=f.platform.repository.byId('c');await f.reporter.flush();assert.deepEqual(f.platform.repository.byId('c'),before);assert.equal(f.reporter.status()[0].status,'conflict');
 }
});
test('authentication, extra configuration fields and report-ID content changes fail closed',async t=>{
 const f=fixture(t),old=f.runtime.repository.byId('c');f.runtime.repository.save({...old,inboundVerified:true},old);await f.reporter.flush();const report=f.sent[0];
 assert.equal((await f.server.inject({method:'POST',url:'/internal/config/channel-observation',payload:report})).statusCode,401);
 for(const field of ['enabled','credential','context','authRevision'])assert.equal((await f.server.inject({method:'POST',url:'/internal/config/channel-observation',headers:{authorization:'Bearer '+token},payload:{...report,observation:{...report.observation,[field]:true}}})).statusCode,400);
 assert.equal((await f.server.inject({method:'POST',url:'/internal/config/channel-observation',headers:{authorization:'Bearer '+token},payload:{...report,verificationEvents:['event:changed']}})).statusCode,409);
});
test('outer transaction rollback removes both local mutation and durable report',t=>{
 const f=fixture(t),old=f.runtime.repository.byId('c');assert.throws(()=>f.runtime.store.transaction(()=>{f.runtime.repository.save({...old,inboundVerified:true},old);throw Error('rollback');}),/rollback/);
 assert.deepEqual(f.runtime.repository.byId('c'),old);assert.equal(f.runtime.store.one('SELECT count(*) n FROM channel_state_reports').n,0);
});
test('snapshot reconciliation reapplies pending observation without generating another report',async t=>{
 const f=fixture(t),old=f.runtime.repository.byId('c');f.runtime.service.recordVerifiedCandidate('c','3',candidate);
 f.runtime.store.run('UPDATE employee_channel_connections SET record_json=?,state_version=? WHERE id=?',JSON.stringify(old),old.stateVersion,old.id);
 f.runtime.store.run('DELETE FROM employee_channel_verification_events');f.reporter.reconcile();
 assert.equal(f.runtime.service.verification('w','e','dingtalk').status,'observed');assert.equal(f.runtime.service.isVerificationEvent('c','event-1'),true);assert.equal(f.runtime.store.one('SELECT count(*) n FROM channel_state_reports').n,2);
 await f.reporter.flush();assert.equal(f.platform.service.verification('w','e','dingtalk').status,'observed');
});
test('runtime cannot turn an operational report into configuration or credential edit',t=>{
 const f=fixture(t),old=f.runtime.repository.byId('c');for(const patch of [{enabled:false},{context:{...old.context,groupListenEnabled:true}},{credential:{...old.credential,tag:'changed'}},{authRevision:2}])assert.throws(()=>f.runtime.repository.save({...old,...patch},old),/readonly/);
 assert.equal(f.runtime.store.one('SELECT count(*) n FROM channel_state_reports').n,0);
});

test('runtime queue is durable while platform channel configuration remains memory-only',t=>{
 const f=fixture(t),old=f.runtime.repository.byId('c');f.runtime.repository.save({...old,inboundVerified:true},old);
 assert.equal(f.runtime.store.one("SELECT count(*) n FROM main.channel_state_reports").n,1);
 assert.equal(f.runtime.store.one("SELECT 1 FROM main.sqlite_master WHERE name='employee_channel_connections'"),undefined);
 assert.equal(f.platform.store.one("SELECT 1 FROM main.sqlite_master WHERE name='channel_observation_receipts'")!==undefined,true);
});

test('a stale snapshot arriving after report acceptance keeps candidate and challenge markers',async t=>{
 const f=fixture(t),old=f.runtime.repository.byId('c');f.runtime.service.recordVerifiedCandidate('c','3',candidate);await f.reporter.flush();
 f.runtime.store.run('UPDATE employee_channel_connections SET record_json=?,state_version=? WHERE id=?',JSON.stringify(old),old.stateVersion,old.id);
 f.runtime.store.run('DELETE FROM employee_channel_verification_events');f.reporter.reconcile();
 assert.equal(f.runtime.service.verification('w','e','dingtalk').status,'observed');assert.equal(f.runtime.service.isVerificationEvent('c','event-1'),true);
});

test('runtime observation cannot change a bot source or reintroduce a traditional directory binding',t=>{
 const f=fixture(t),old=f.runtime.repository.byId('c');
 assert.throws(()=>f.runtime.repository.save({...old,sourceId:'changed'},old),/runtime_channel_configuration_readonly/);
 assert.equal(f.platform.repository.byId('c').sourceId,old.sourceId);
});
test('pending durable reports survive runtime restart without persisting platform configuration',async t=>{
 const f=fixture(t),old=f.runtime.repository.byId('c');f.runtime.repository.save({...old,inboundVerified:true},old);
 const store=await f.reopen(),repository=new EmployeeChannelRepository(store);
 assert.equal(repository.byId('c'),undefined);
 const reporter=installChannelObservationReporter(store,repository,{url:'http://127.0.0.1:1',token,fetch:async(_url,init)=>{const r=await f.server.inject({method:'POST',url:'/internal/config/channel-observation',headers:init.headers,payload:JSON.parse(init.body)});return new Response(r.body,{status:r.statusCode});}});
 try{await reporter.flush();assert.equal(f.platform.repository.byId('c').inboundVerified,true);assert.equal(reporter.status()[0].status,'accepted');}finally{await reporter.close();}
});

test('a rejected parent observation prevents dependent challenge markers from crossing a colliding state version',async t=>{
 const f=fixture(t);f.runtime.service.recordVerifiedCandidate('c','3',candidate);const current=f.platform.repository.byId('c');
 // Another legitimate observer wins the same next state version with a different candidate.
 f.platform.service.recordVerifiedCandidate('c','3',{...candidate,eventId:'other-event',messageId:'other-message',botId:'other-robot',robotCode:'other-robot'});
 await f.reporter.flush();assert.equal(f.platform.service.isVerificationEvent('c','event-1'),false);assert.equal(f.platform.service.isVerificationEvent('c','other-event'),true);assert.equal(f.sent.length,1);assert.ok(f.reporter.status().every(r=>r.status==='conflict'));assert.equal(f.platform.repository.byId('c').stateVersion,current.stateVersion+1);
});

test('I06 automatic first inbound observation reaches the platform without changing the live configuration revision',async t=>{
 const f=fixture(t),before=f.runtime.repository.byId('c');
 f.runtime.service.observeFirstInbound('c',{appId:'app',botId:'distinct-code',tenantId:'corp',tenantNamespace:'corp_id',robotCode:'distinct-code'});
 assert.equal(f.runtime.repository.byId('c').revision,before.revision);
 assert.equal(f.runtime.repository.byId('c').status,'verified');
 f.lose();await f.reporter.flush();await f.reporter.flush();
 const after=f.platform.repository.byId('c');
 assert.equal(after.eventTenantId,'corp');assert.equal(after.botId,'distinct-code');assert.equal(after.revision,before.revision);
 assert.equal(after.stateVersion,before.stateVersion+1);
 assert.equal(f.platform.store.one('SELECT count(*) n FROM channel_observation_receipts').n,1);
});

const feishuPending=r=>({...r,provider:'feishu',identity:{appId:'app',tenantId:'directory-display',tenantIdNamespace:'display_id'},botId:'ou_verified_bot',identityEvidence:'app_credentials_only'});
const feishuFirst={appId:'app',botId:'ou_verified_bot',tenantId:'tenant-key',tenantNamespace:'tenant_key'};
test('Feishu automatic identity report survives stale snapshots and a lost acceptance response without rotating the configuration',async t=>{
 const f=fixture(t,feishuPending),before=f.runtime.repository.byId('c');
 f.runtime.service.observeFirstInbound('c',feishuFirst);
 const local=f.runtime.repository.byId('c');assert.equal(local.status,'verified');assert.equal(local.inboundVerified,true);assert.equal(local.identityEvidence,'authenticated_first_message');assert.equal(local.eventTenantId,'tenant-key');assert.equal(local.botId,'ou_verified_bot');
 assert.equal(local.revision,before.revision);assert.equal(local.authRevision,before.authRevision);assert.equal(local.stateVersion,before.stateVersion+1);assert.deepEqual(local.identity,before.identity);assert.deepEqual(local.context,before.context);assert.equal(local.sourceId,before.sourceId);assert.equal(local.verification,undefined);
 const resetSnapshot=()=>f.runtime.store.run('UPDATE employee_channel_connections SET record_json=?,state_version=? WHERE id=?',JSON.stringify(before),before.stateVersion,before.id);
 resetSnapshot();f.reporter.reconcile();assert.equal(f.runtime.repository.byId('c').eventTenantId,'tenant-key');assert.equal(f.runtime.store.one('SELECT count(*) n FROM channel_state_reports').n,1);
 f.lose();await f.reporter.flush();assert.equal(f.reporter.status()[0].status,'pending');await f.reporter.flush();assert.equal(f.reporter.status()[0].status,'accepted');
 const authoritative=f.platform.repository.byId('c');assert.equal(authoritative.status,'verified');assert.equal(authoritative.stateVersion,before.stateVersion+1);assert.equal(authoritative.revision,before.revision);assert.equal(authoritative.authRevision,before.authRevision);assert.deepEqual(authoritative.identity,before.identity);assert.equal(f.sent[0].reportId,f.sent[1].reportId);
 resetSnapshot();f.reporter.reconcile();assert.equal(f.runtime.repository.byId('c').status,'verified');assert.equal(f.runtime.repository.byId('c').eventTenantId,'tenant-key');
 assert.equal(f.platform.store.one('SELECT count(*) n FROM channel_observation_receipts').n,1);assert.equal(JSON.stringify(f.sent).includes('synthetic-private'),false);
});

test('Feishu delayed automatic identity cannot overwrite admin disable, credential rotation or source replacement',async t=>{
 for(const change of ['disabled','credentials','replacement'])await t.test(change,async t=>{
  const f=fixture(t,feishuPending);f.runtime.service.observeFirstInbound('c',feishuFirst);
  const current=f.platform.repository.byId('c'),patch=change==='disabled'?{enabled:false,status:'disabled',revision:current.revision+1}:change==='credentials'?{authRevision:current.authRevision+1,revision:current.revision+1}:{sourceId:'replacement-source',appId:'new-app',identity:{appId:'new-app',tenantId:'new-display',tenantIdNamespace:'display_id'},botId:'ou_new_bot',revision:current.revision+1,authRevision:current.authRevision+1};
  f.platform.repository.save({...current,...patch},current);const expected=f.platform.repository.byId('c');await f.reporter.flush();assert.deepEqual(f.platform.repository.byId('c'),expected);assert.equal(f.reporter.status()[0].status,'conflict');
  f.runtime.store.run('UPDATE employee_channel_connections SET record_json=?,state_version=?,revision=?,app_id=?,bot_id=? WHERE id=?',JSON.stringify(expected),expected.stateVersion,expected.revision,expected.appId,expected.botId??null,expected.id);
  f.reporter.reconcile();assert.deepEqual(f.runtime.repository.byId('c'),expected);
 });
});

test('Feishu automatic identity and durable observation roll back together and competing tenant evidence cannot overwrite the winner',async t=>{
 const f=fixture(t,feishuPending),before=f.runtime.repository.byId('c');
 assert.throws(()=>f.runtime.store.transaction(()=>{f.runtime.service.observeFirstInbound('c',feishuFirst);throw Error('synthetic rollback');}),/synthetic rollback/);
 assert.deepEqual(f.runtime.repository.byId('c'),before);assert.equal(f.runtime.store.one('SELECT count(*) n FROM channel_state_reports').n,0);
 f.runtime.service.observeFirstInbound('c',feishuFirst);f.platform.service.observeFirstInbound('c',{...feishuFirst,tenantId:'other-tenant-key'});const winner=f.platform.repository.byId('c');
 await f.reporter.flush();assert.deepEqual(f.platform.repository.byId('c'),winner);assert.equal(winner.eventTenantId,'other-tenant-key');assert.equal(f.reporter.status()[0].status,'conflict');
});

test('Feishu automatic identity report survives runtime restart without storing platform credentials in runtime main schema',async t=>{
 const f=fixture(t,feishuPending);f.runtime.service.observeFirstInbound('c',feishuFirst);
 const store=await f.reopen(),repository=new EmployeeChannelRepository(store);assert.equal(repository.byId('c'),undefined);
 const reporter=installChannelObservationReporter(store,repository,{url:'http://127.0.0.1:1',token,fetch:async(_url,init)=>{const r=await f.server.inject({method:'POST',url:'/internal/config/channel-observation',headers:init.headers,payload:JSON.parse(init.body)});return new Response(r.body,{status:r.statusCode});}});
 try{await reporter.flush();const actual=f.platform.repository.byId('c');assert.equal(actual.status,'verified');assert.equal(actual.eventTenantId,'tenant-key');assert.equal(actual.botId,'ou_verified_bot');assert.equal(actual.inboundVerified,true);assert.equal(reporter.status()[0].status,'accepted');assert.equal(store.one("SELECT 1 FROM main.sqlite_master WHERE name='employee_channel_connections'"),undefined);}finally{await reporter.close();}
});

test('WeCom per-member evidence reaches platform without treating the legacy global flag as identity',async t=>{
 const f=fixture(t,r=>({...r,provider:'wecom',botId:'app',eventTenantId:'app',status:'verified',inboundVerified:true,directoryStatus:'unavailable',verification:undefined,wecomContactIdentityRevision:r.authRevision}));
 assert.equal(f.platform.service.dto(f.platform.repository.byId('c')).memberSearchIdentityVerified,false);
 const current=f.runtime.repository.byId('c');
 f.runtime.service.botContacts.remember(current,[{id:'person-one',displayName:'Fixture Member',departmentPaths:[]}]);
 f.runtime.service.observeWeComContact('c','person-one');
 await f.reporter.flush();
 assert.deepEqual(f.platform.repository.byId('c').wecomVerifiedContactIds,['person-one']);
 assert.deepEqual(f.platform.service.dto(f.platform.repository.byId('c')).memberSearchVerifiedUserIds,[],'DTO exposes only configured selections, not all bindings');
 assert.equal(f.platform.repository.byId('c').revision,current.revision);
 const report=f.sent[0];
 for(const ids of [['person-one','person-one'],[''],[1]]){
  const response=await f.server.inject({method:'POST',url:'/internal/config/channel-observation',headers:{authorization:'Bearer '+token},payload:{...report,reportId:'invalid-'+JSON.stringify(ids).length,observation:{...report.observation,wecomVerifiedContactIds:ids}}});
  assert.equal(response.statusCode,400);
 }
});

test('WeCom administrator-relay proof crosses split observations with no clear code stored',async t=>{
 const phrase='000123',now=Date.now(),hash=(await import('../dist/employee-channels/wecom-member-verification.js')).weComMemberCodeHash('fixture-secret',{id:'c',sourceId:'source',authRevision:1},phrase);
 const challenge={requestId:'11111111-1111-4111-8111-111111111111',userId:'search-person',authRevision:1,phraseHash:hash,createdAt:now-1000,expiresAt:now+86399000,status:'pending',method:'administrator_relay',createdBy:'manager',issuedAt:now-500};
 const f=fixture(t,r=>({...r,provider:'wecom',botId:'app',eventTenantId:'app',status:'verified',inboundVerified:true,directoryStatus:'unavailable',verification:undefined,wecomMemberChallenges:[challenge]}));
 const before=f.runtime.repository.byId('c');
 const {WeComMemberVerification}=await import('../dist/employee-channels/wecom-member-verification.js');const verifier=new WeComMemberVerification(f.runtime.repository,Date.now,{secret:()=> 'fixture-secret'});
 assert.equal(verifier.accept(before,{text:phrase,callbackUserId:'callback-person',eventId:'event-proof',messageId:'message-proof',privateMessage:true}),'verified');
 await f.reporter.flush();
 const mapped=f.platform.repository.byId('c');assert.deepEqual(mapped.wecomContactMappings.map(m=>[m.userId,m.callbackUserId]),[['search-person','callback-person']]);
 assert.equal(mapped.wecomMemberChallenges[0].status,'verified');assert.equal(f.platform.service.memberVerification.status(mapped,'search-person').status,'verified');
 assert.equal(f.platform.service.isVerificationEvent('c','event-proof','message-proof'),true);
 assert.equal(JSON.stringify(f.sent).includes(phrase),false);
 const check={connectionId:'c',sourceId:'source',authRevision:1,requestId:challenge.requestId,callbackUserId:'callback-person'};
 assert.equal((await f.server.inject({method:'POST',url:'/internal/config/wecom-member-confirmed',payload:check})).statusCode,401);
 for(const [patch,expected]of [[{},true],[{callbackUserId:'someone-else'},false],[{sourceId:'old-source'},false],[{authRevision:2},false]]){const verified=await f.server.inject({method:'POST',url:'/internal/config/wecom-member-confirmed',headers:{authorization:'Bearer '+token},payload:{...check,...patch}});assert.equal(verified.statusCode,200);assert.equal(verified.json().confirmed,expected);}
 // Lost/older configuration is reconciled from a durable observation without replaying a send.
 f.runtime.store.run('UPDATE employee_channel_connections SET record_json=?,state_version=? WHERE id=?',JSON.stringify(before),before.stateVersion,'c');f.reporter.reconcile();
 assert.deepEqual(f.runtime.repository.byId('c').wecomContactMappings,mapped.wecomContactMappings);
});

test('WeCom completed proof safely merges with a concurrent platform challenge without discarding either',async t=>{
 const phrase='000456',now=Date.now(),hash=(await import('../dist/employee-channels/wecom-member-verification.js')).weComMemberCodeHash('fixture-secret',{id:'c',sourceId:'source',authRevision:1},phrase);
 const challenge={requestId:'22222222-2222-4222-8222-222222222222',userId:'search-a',authRevision:1,phraseHash:hash,createdAt:now-1000,expiresAt:now+86399000,status:'pending',method:'administrator_relay',createdBy:'manager',issuedAt:now-500};
 const f=fixture(t,r=>({...r,provider:'wecom',botId:'app',eventTenantId:'app',status:'verified',inboundVerified:true,directoryStatus:'unavailable',verification:undefined,wecomMemberChallenges:[challenge,{...challenge,requestId:'44444444-4444-4444-8444-444444444444',userId:'historical-failure',status:'failed'}]}));
 const {WeComMemberVerification}=await import('../dist/employee-channels/wecom-member-verification.js');let tick=now;const verification=new WeComMemberVerification(f.runtime.repository,()=>++tick,{secret:()=> 'fixture-secret'});
 verification.accept(f.runtime.repository.byId('c'),{text:phrase,callbackUserId:'callback-a',eventId:'merge-event',messageId:'merge-message',privateMessage:true});
 const before=f.platform.repository.byId('c'),other={...challenge,requestId:'33333333-3333-4333-8333-333333333333',userId:'search-b',phraseHash:'c'.repeat(64)};
 f.platform.repository.save({...before,wecomMemberChallenges:[...before.wecomMemberChallenges,other]},before);
 await f.reporter.flush();
 const after=f.platform.repository.byId('c');assert.equal(after.wecomContactMappings[0].callbackUserId,'callback-a');assert.equal(after.wecomMemberChallenges.length,3);assert.equal(after.wecomMemberChallenges[0].status,'verified');assert.equal(after.wecomMemberChallenges[1].status,'failed');assert.equal(after.wecomMemberChallenges[2].status,'pending');
 assert.equal(f.reporter.status().some(row=>row.status==='conflict'),false);assert.equal(f.platform.service.isVerificationEvent('c','merge-event','merge-message'),true);
});

for(const unexpected of ['expired-history','active-challenge','history-with-new-mapping'])test(`WeCom concurrent pruning reconciles ${unexpected} without granting an unissued identity`,async t=>{
 const day=86400000,phrase='000789',now=Date.now();
 const {WeComMemberVerification,weComMemberCodeHash}=await import('../dist/employee-channels/wecom-member-verification.js');
 const challenge={requestId:'active-request',userId:'active-person',authRevision:1,phraseHash:weComMemberCodeHash('fixture-secret',{id:'c',sourceId:'source',authRevision:1},phrase),createdAt:now-1000,expiresAt:now+day-1000,status:'pending',method:'administrator_relay',createdBy:'manager',issuedAt:now-1000};
 const historical={...challenge,requestId:'old-request',userId:'old-person',phraseHash:'a'.repeat(64),createdAt:now-4*day-1000,expiresAt:now-3*day-1000,issuedAt:now-4*day-1000};
 const f=fixture(t,r=>({...r,provider:'wecom',botId:'app',eventTenantId:'app',status:'verified',inboundVerified:true,directoryStatus:'unavailable',verification:undefined,wecomMemberChallenges:[historical,challenge]}));
 const current=f.platform.repository.byId('c');
 f.platform.repository.save({...current,wecomMemberChallenges:[challenge,{...challenge,requestId:'newly-issued',userId:'new-person',phraseHash:'b'.repeat(64)}]},current);
 const verifier=new WeComMemberVerification(f.runtime.repository,()=>now,{secret:()=> 'fixture-secret'});
 assert.equal(verifier.accept(f.runtime.repository.byId('c'),{text:phrase,callbackUserId:'callback-current',eventId:'prune-proof',messageId:'prune-message',privateMessage:true}),'verified');
 if(unexpected!=='expired-history'){
  const row=f.runtime.store.one("SELECT id,body_json FROM channel_state_reports WHERE json_extract(body_json,'$.observation.wecomContactMappings') IS NOT NULL ORDER BY rowid DESC LIMIT 1");
  const report=JSON.parse(row.body_json);
  if(unexpected==='active-challenge')report.observation.wecomMemberChallenges[0]={...historical,createdAt:now-1000,expiresAt:now+day-1000,issuedAt:now-1000};
  else report.observation.wecomContactMappings.push({userId:'old-person',callbackUserId:'forged-callback',verifiedAt:historical.createdAt+1,requestId:historical.requestId,method:'administrator_relay'});
  f.runtime.store.run('UPDATE channel_state_reports SET body_json=? WHERE id=?',JSON.stringify(report),row.id);
 }
 await f.reporter.flush();
 const after=f.platform.repository.byId('c');
 if(unexpected==='expired-history'){
  assert.equal(after.wecomContactMappings[0].callbackUserId,'callback-current');assert.equal(after.wecomMemberChallenges.length,2);assert.equal(after.wecomMemberChallenges.some(c=>c.requestId==='old-request'),false);assert.ok(f.reporter.status().every(r=>r.status==='accepted'));
 }else{assert.equal(after.wecomContactMappings,undefined);assert.ok(f.reporter.status().some(r=>r.status==='conflict'));}
});


test('WeCom incremental reports stay small above 512KB of persisted bindings and retry/reconcile without loss',async t=>{
 const maps=Array.from({length:4000},(_,i)=>({userId:'person-'+i,callbackUserId:'callback-'+i,requestId:'historical-request-'+i,verifiedAt:1800000000000,method:'administrator_relay'}));
 assert.ok(Buffer.byteLength(JSON.stringify(maps))>524288);
 const f=fixture(t,r=>({...r,provider:'wecom',botId:'app',eventTenantId:'app',status:'verified',inboundVerified:true,directoryStatus:'unavailable',verification:undefined,wecomContactIdentityRevision:r.authRevision,wecomContactMappings:maps}));
 const before=f.runtime.repository.byId('c');
 f.runtime.repository.save({...before,wecomVerifiedContactIds:['new-exact']},before);
 const queued=JSON.parse(f.runtime.store.one('SELECT body_json FROM channel_state_reports').body_json);
 assert.equal(queued.wecomIdentityDelta,true);assert.deepEqual(queued.observation.wecomContactMappings,[]);assert.deepEqual(queued.observation.wecomVerifiedContactIds,['new-exact']);assert.ok(Buffer.byteLength(JSON.stringify(queued))<4096);
 const platform=f.platform.repository.byId('c');f.platform.repository.save({...platform,wecomVerifiedContactIds:['concurrent-exact']},platform);
 f.lose();await f.reporter.flush();const acceptedVersion=f.platform.repository.byId('c').stateVersion;await f.reporter.flush();
 const result=f.platform.repository.byId('c');assert.equal(result.stateVersion,acceptedVersion);assert.equal(result.wecomContactMappings.length,4000);assert.deepEqual(result.wecomVerifiedContactIds,['concurrent-exact','new-exact']);
 f.runtime.store.run('UPDATE employee_channel_connections SET record_json=?,state_version=? WHERE id=?',JSON.stringify(before),before.stateVersion,'c');f.reporter.reconcile();
 assert.equal(f.runtime.repository.byId('c').wecomContactMappings.length,4000);assert.deepEqual(f.runtime.repository.byId('c').wecomVerifiedContactIds,['new-exact']);
 const current=f.runtime.repository.byId('c');assert.throws(()=>f.runtime.repository.save({...current,wecomContactMappings:[]},current),/not_monotonic/);
});

test('WeCom delta cannot cross credential revisions or collide with a persistent binding',async t=>{
 const f=fixture(t,r=>({...r,provider:'wecom',botId:'app',eventTenantId:'app',status:'verified',inboundVerified:true,directoryStatus:'unavailable',verification:undefined,wecomContactIdentityRevision:r.authRevision,wecomVerifiedContactIds:['person']}));
 const before=f.runtime.repository.byId('c');f.runtime.repository.save({...before,wecomVerifiedContactIds:['person','next']},before);
 const report=JSON.parse(f.runtime.store.one('SELECT body_json FROM channel_state_reports').body_json);
 const post=payload=>f.server.inject({method:'POST',url:'/internal/config/channel-observation',headers:{authorization:'Bearer '+token},payload});
 assert.equal((await post({...report,reportId:'cross-auth',expected:{...report.expected,authRevision:2},observation:{...report.observation,wecomContactIdentityRevision:2}})).statusCode,409);
 assert.equal((await post({...report,reportId:'collision',observation:{...report.observation,wecomContactMappings:[{userId:'other',callbackUserId:'person',requestId:'new',verifiedAt:1,method:'administrator_relay'}]}})).statusCode,409);
 assert.deepEqual(f.platform.repository.byId('c').wecomVerifiedContactIds,['person']);
});


test('10k relational identities keep channel JSON bounded, use indexes, and do not enumerate on ingress/report',async t=>{
 const {withIdentityDelta,identityLookup}=await import('../dist/employee-channels/wecom-identity-bindings.js');
 const {weComCallbackUserId,weComSearchUserId}=await import('../dist/employee-channels/wecom-bot-contacts.js');
 const exact=Array.from({length:10000},(_,i)=>'identity-'+i);
 const f=fixture(t,r=>({...r,provider:'wecom',botId:'app',eventTenantId:'app',status:'verified',inboundVerified:true,directoryStatus:'unavailable',verification:undefined,wecomContactIdentityRevision:r.authRevision,wecomVerifiedContactIds:exact}));
 const before=f.runtime.repository.byId('c'),json=f.runtime.store.one('SELECT record_json FROM employee_channel_connections').record_json;
 assert.ok(json.length<2000);assert.equal(json.includes('identity-9999'),false);
 const all=f.runtime.store.all.bind(f.runtime.store);f.runtime.store.all=(sql,...args)=>{if(sql.includes('FROM wecom_identity_bindings'))throw Error('unexpected full relation enumeration');return all(sql,...args);};
 assert.equal(weComCallbackUserId(before,'identity-9999'),'identity-9999');assert.equal(weComSearchUserId(before,'identity-1'),'identity-1');
 f.runtime.repository.save(withIdentityDelta({...before,wecomContactIdentityRevision:before.authRevision},{exact:['new-indexed'],maps:[]}),before);
 assert.equal(identityLookup(f.runtime.repository.byId('c'),'user_id','new-indexed').callback_user_id,'new-indexed');
 const body=f.runtime.store.one('SELECT body_json FROM channel_state_reports').body_json;assert.ok(body.length<4096);assert.equal(body.includes('identity-9999'),false);
 await f.reporter.flush();assert.equal(identityLookup(f.platform.repository.byId('c'),'user_id','new-indexed').callback_user_id,'new-indexed');
 f.runtime.store.all=all;
 for(const column of ['user_id','callback_user_id'])assert.match(f.runtime.store.all(`EXPLAIN QUERY PLAN SELECT * FROM wecom_identity_bindings WHERE connection_id=? AND source_id=? AND auth_revision=? AND ${column}=?`,'c','source',1,'identity-9999').map(x=>x.detail).join(' '),/SEARCH .*INDEX/);
});

test('relational identity writes are atomic with CAS, scoped, and ignore legacy JSON evidence',async t=>{
 const {withIdentityDelta,identityLookup}=await import('../dist/employee-channels/wecom-identity-bindings.js');
 const f=fixture(t,r=>({...r,provider:'wecom',botId:'app',eventTenantId:'app',status:'verified',inboundVerified:true,directoryStatus:'unavailable',verification:undefined,wecomContactIdentityRevision:r.authRevision}));
 const before=f.platform.repository.byId('c');f.platform.repository.save(withIdentityDelta({...before},{exact:['person'],maps:[]}),before);
 assert.equal(f.platform.repository.save(withIdentityDelta({...before},{exact:['stale'],maps:[]}),before),false);assert.equal(identityLookup(f.platform.repository.byId('c'),'user_id','stale'),undefined);
 const current=f.platform.repository.byId('c');assert.throws(()=>f.platform.repository.save(withIdentityDelta({...current},{exact:['rolled-back'],maps:[{userId:'other',callbackUserId:'person',requestId:'conflict',verifiedAt:1,method:'administrator_relay'}]}),current),/UNIQUE/);
 assert.equal(identityLookup(f.platform.repository.byId('c'),'user_id','rolled-back'),undefined);assert.equal(f.platform.repository.byId('c').stateVersion,current.stateVersion);
 f.platform.repository.save({...current,authRevision:2,wecomContactIdentityRevision:undefined},current);assert.equal(f.platform.store.one('SELECT count(*) n FROM wecom_identity_bindings').n,0);
 const fresh=f.platform.repository.byId('c');f.platform.store.run('UPDATE employee_channel_connections SET record_json=? WHERE id=?',JSON.stringify({...fresh,wecomContactIdentityRevision:2,wecomVerifiedContactIds:['legacy-only']}),'c');
 assert.equal(identityLookup(f.platform.repository.byId('c'),'user_id','legacy-only'),undefined);assert.equal(f.platform.repository.byId('c').wecomVerifiedContactIds,undefined);
});
