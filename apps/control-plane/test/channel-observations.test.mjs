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
const candidate={appId:'app',botId:'observed-bot',tenantId:'tenant',robotCode:'robot',challengeText:'challenge-text',eventId:'event-1',messageId:'message-1'};
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
 f.platform.service.recordVerifiedCandidate('c','3',{...candidate,eventId:'other-event',messageId:'other-message',botId:'other-bot'});
 await f.reporter.flush();assert.equal(f.platform.service.isVerificationEvent('c','event-1'),false);assert.equal(f.platform.service.isVerificationEvent('c','other-event'),true);assert.equal(f.sent.length,1);assert.ok(f.reporter.status().every(r=>r.status==='conflict'));assert.equal(f.platform.repository.byId('c').stateVersion,current.stateVersion+1);
});

test('I06 automatic first inbound observation reaches the platform without changing the live configuration revision',async t=>{
 const f=fixture(t),before=f.runtime.repository.byId('c');
 f.runtime.service.observeFirstInbound('c',{appId:'app',botId:'bot',tenantId:'corp',tenantNamespace:'corp_id',robotCode:'distinct-code'});
 assert.equal(f.runtime.repository.byId('c').revision,before.revision);
 assert.equal(f.runtime.repository.byId('c').status,'verified');
 f.lose();await f.reporter.flush();await f.reporter.flush();
 const after=f.platform.repository.byId('c');
 assert.equal(after.eventTenantId,'corp');assert.equal(after.botId,'bot');assert.equal(after.revision,before.revision);
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
