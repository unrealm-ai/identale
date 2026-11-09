import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {Store} from '../dist/store.js';
import {EmployeeChannelRepository} from '../dist/employee-channels/repository.js';
import {EmployeeChannelService} from '../dist/employee-channels/service.js';
import {registerEmployeeChannelRoutes} from '../dist/employee-channels/routes.js';
import {weComMemberCodeCandidates,weComMemberCodeHash} from '../dist/employee-channels/wecom-member-verification.js';
import {DirectoryCredentialVault} from '../dist/directory/secrets.js';
import {configurationSnapshot,deriveRuntimeConfigurationKey} from '../dist/split/config-sync.js';
import {tableOwner} from '../dist/split/table-ownership.js';
import {registerChannelObservationApi,installChannelObservationReporter} from '../dist/split/channel-observations.js';

const day=86_400_000,key=Buffer.alloc(32,47),secret='synthetic-member-code-secret';
const endpoint='/api/workspaces/w/entities/e/channels/wecom/member-verification';

// Reuse the existing isolated SQLite/Fastify fixtures and synthetic contact
// records. No provider, model, external message, or real tenant is contacted.
async function fixture(t,{role}={}){
 const root=mkdtempSync(join(tmpdir(),'wecom-member-code-security-'));
 const path=join(root,'test.sqlite');let now=1_800_000_000_000,serial=0;
 const f={root,path,closeBeforeStore:[]};
 const open=()=>{
  f.store=new Store(path,role?{role}:undefined);
  f.repository=new EmployeeChannelRepository(f.store);
  f.service=new EmployeeChannelService(f.repository,{masterKey:key,now:()=>now,fetch:async()=>{throw Error('unexpected external request');}});
  f.service.setMemberVerificationReceiver(async()=>true);
 };
 open();
 f.store.run("INSERT INTO users(id,username,display_name) VALUES('u','fixture','Owner')");
 f.store.run("INSERT INTO workspaces(id,name,created_by) VALUES('w','Fixture','u')");
 f.store.run("INSERT INTO members(id,workspace_id,user_id,role) VALUES('m','w','u','owner')");
 f.store.run("INSERT INTO entities(id,workspace_id,name,owner_member_id,created_by_member_id,own_web_use,web_use_user_id,interaction_runtime) VALUES('e','w','Employee','m','m',1,'u','builtin')");
 f.record=()=>f.repository.byProvider('w','e','wecom');
 f.authenticate=()=>{const r=f.record();f.service.observeFirstInbound(r.id,{appId:r.appId,botId:r.appId,tenantId:r.appId,tenantNamespace:'app_id'});};
 await f.service.save('w','e','wecom','u',{appId:'synthetic-security-bot',appSecret:secret});f.authenticate();
 f.candidate=userId=>f.service.botContacts.remember(f.record(),[{id:userId,displayName:'Synthetic Member',departmentPaths:[]}]);
 f.start=async(userId='selected-member',{requestId=randomUUID(),replace=false}={})=>{
  f.candidate(userId);return f.service.startMemberVerification('w','e','u',{userId,sourceId:f.record().sourceId,requestId,...(replace?{replace:true}:{})});
 };
 f.status=userId=>f.service.memberVerificationStatus('w','e',{userId,sourceId:f.record().sourceId});
 f.accept=(text,{callback='callback-member',messageId='message-'+(++serial),privateMessage=true}={})=>f.service.memberVerification.accept(f.record(),{text,callbackUserId:callback,eventId:'event-'+messageId,messageId,privateMessage});
 f.control=(text,{callback='callback-member',...patch}={})=>f.service.memberVerification.isControl(f.record(),{body:{msgtype:'text',chattype:'single',from:{userid:callback},text:{content:text},...patch}});
 f.challenges=()=>f.record().wecomMemberChallenges??[];
 f.pending=()=>f.challenges().filter(c=>c.status==='pending'&&c.expiresAt>now);
 f.advance=ms=>now+=ms;f.now=()=>now;f.setNow=value=>now=value;
 f.reopen=()=>{f.store.close();open();};
 f.app=Fastify();await registerEmployeeChannelRoutes(f.app,f.service,{requireManager:()=> 'u'});
 f.get=userId=>f.app.inject({method:'GET',url:endpoint+'?'+new URLSearchParams({userId,sourceId:f.record().sourceId})});
 f.post=(userId,requestId=randomUUID(),extra={})=>{f.candidate(userId);return f.app.inject({method:'POST',url:endpoint,payload:{userId,sourceId:f.record().sourceId,requestId,...extra}});};
 t.after(async()=>{for(const close of f.closeBeforeStore)await close();await f.app.close();f.store.close();rmSync(root,{recursive:true,force:true});});
 return f;
}
const unknown=f=>{
 const known=new Set(f.challenges().map(c=>c.phraseHash)),r=f.record();
 for(let value=0;value<1_000_000;value++){const code=String(value).padStart(6,'0');if(!known.has(weComMemberCodeHash(secret,r,code)))return code;}
 throw Error('fixture exhausted numeric space');
};
function assertNoClearValue(value,code){
 if(typeof value==='string'){assert.notEqual(value,code);if(value.startsWith('{')||value.startsWith('[')){try{value=JSON.parse(value);}catch{return;}}else return;}
 if(value&&typeof value==='object')for(const [name,child]of Object.entries(value)){assert.notEqual(name,'sealed_code');assertNoClearValue(child,code);}
}

test('six-digit codes use scoped keyed HMAC and encrypted platform-only recovery, not clear configuration or raw database strings',async t=>{
 const f=await fixture(t,{role:'platform'}),issued=await f.start(),r=f.record(),challenge=f.challenges()[0];
 assert.match(issued.phrase,/^[0-9]{6}$/);assert.equal(challenge.expiresAt-challenge.createdAt,day);
 assert.equal(challenge.method,'administrator_relay');assert.equal(challenge.createdBy,'u');
 const hmacKey=createHmac('sha256',secret).update('identale-member-code-hmac-key-v1').digest();
 const expected=createHmac('sha256',hmacKey).update(JSON.stringify([r.id,r.sourceId,r.authRevision,issued.phrase])).digest('hex');
 assert.equal(challenge.phraseHash,expected);assert.notEqual(expected,createHash('sha256').update(issued.phrase).digest('hex'));
 for(const [changedSecret,changedRecord]of [['other-secret',r],[secret,{...r,id:'other-connection'}],[secret,{...r,sourceId:'other-source'}],[secret,{...r,authRevision:r.authRevision+1}]])assert.notEqual(weComMemberCodeHash(changedSecret,changedRecord,issued.phrase),expected);
 const row=f.store.one('SELECT * FROM wecom_member_verification_requests WHERE request_id=?',challenge.requestId);
 assert.equal(row.code_hash,expected);assert.match(row.collision_hash,/^[0-9a-f]{64}$/);assert.notEqual(row.sealed_code,issued.phrase);
 const vault=new DirectoryCredentialVault(key),scope=['member-code-v1',r.id,r.sourceId,r.authRevision,challenge.requestId];
 assert.equal(vault.open(JSON.parse(row.sealed_code),scope),issued.phrase);
 assert.throws(()=>vault.open(JSON.parse(row.sealed_code),[...scope.slice(0,-1),'other-request']));
 assertNoClearValue(r,issued.phrase);
 const snapshot=configurationSnapshot({store:f.store,masterKey:key,token:'synthetic-runtime-token',now:f.now});
 assertNoClearValue(snapshot,issued.phrase);
 for(const table of [...snapshot.tables,...snapshot.privateCredentials.tables])assert.equal(table.name.startsWith('wecom_member_verification_'),false);
 assert.equal(tableOwner('wecom_member_verification_requests'),'platform');
 assert.equal(tableOwner('wecom_member_verification_attempts'),'runtime');assert.equal(tableOwner('wecom_member_verification_notices'),'runtime');
 f.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
 for(const name of readdirSync(f.root).filter(name=>name.startsWith('test.sqlite')))assert.equal(readFileSync(join(f.root,name)).includes(Buffer.from(JSON.stringify(issued.phrase))),false,`clear quoted code in ${name}`);
});

test('GET reopens the same code; idempotent POST and a new request for the same person do not regenerate it',async t=>{
 const f=await fixture(t),requestId=randomUUID(),first=await f.post('person-a',requestId);
 assert.equal(first.statusCode,200,first.body);assert.equal(first.headers['cache-control'],'no-store');
 const code=first.json().phrase;assert.match(code,/^[0-9]{6}$/);
 for(const response of [await f.get('person-a'),await f.get('person-a'),await f.post('person-a',requestId),await f.post('person-a')]){
  assert.equal(response.statusCode,200,response.body);assert.equal(response.json().phrase,code);assert.equal(response.headers['cache-control'],'no-store');
 }
 assert.equal(f.pending().length,1);
 const conflict=await f.post('person-b',requestId);assert.equal(conflict.statusCode,409);assert.equal(conflict.json().error,'member_verification_request_conflict');
 f.reopen();assert.equal(f.status('person-a').phrase,code);
});

test('GET and concurrent POST cannot recover a code before the receiver confirms readiness',async t=>{
 const f=await fixture(t);let entered,release;
 const seen=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 f.service.setMemberVerificationReceiver(async()=>{entered();return gate;});
 const requestId=randomUUID(),pending=f.start('person-a',{requestId});await seen;
 assert.equal(f.challenges().length,1);assert.equal(f.store.one('SELECT sealed_code FROM wecom_member_verification_requests WHERE request_id=?',requestId).sealed_code,null);
 const reading=await f.get('person-a');assert.equal(reading.statusCode,200);assert.equal(reading.json().status,'pending');assert.equal(reading.json().phrase,undefined);
 assert.equal((await f.start('person-a',{requestId})).phrase,undefined);assert.equal((await f.start('person-a')).phrase,undefined);
 release(true);const issued=await pending;assert.match(issued.phrase,/^[0-9]{6}$/);
 assert.equal((await f.get('person-a')).json().phrase,issued.phrase);assert.equal((await f.start('person-a',{requestId})).phrase,issued.phrase);assert.equal(f.pending().length,1);
});

test('failed receiver readiness never seals or exposes a recoverable code, including after restart',async t=>{
 const f=await fixture(t);f.service.setMemberVerificationReceiver(async()=>false);
 await assert.rejects(f.start(),{code:'member_verification_receiver_not_ready'});
 assert.equal(f.status('selected-member').status,'failed');assert.equal(f.status('selected-member').phrase,undefined);
 assert.equal(f.store.one('SELECT sealed_code FROM wecom_member_verification_requests').sealed_code,null);
 f.reopen();assert.equal(f.status('selected-member').phrase,undefined);assert.equal(f.pending().length,0);
});

test('source revocation while awaiting receiver readiness cannot seal a code from the old source',async t=>{
 const f=await fixture(t);let entered,release;
 const seen=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 f.service.setMemberVerificationReceiver(async()=>{entered();return gate;});
 const pending=f.start();await seen;const before=f.record();
 assert.equal(f.repository.save({...before,sourceId:'replacement-during-readiness',wecomMemberChallenges:[]},before),true);
 release(true);await assert.rejects(pending,{code:'channel_configuration_changed'});
 assert.equal(f.store.one('SELECT sealed_code FROM wecom_member_verification_requests').sealed_code,null);
 assert.equal(f.status('selected-member').phrase,undefined);
});


test('replacement is immediate, retires the old code, and preserves three days from the first invalidation',async t=>{
 const f=await fixture(t),old=await f.start();f.advance(1000);const retiredAt=f.now();
 const next=await f.start('selected-member',{replace:true});assert.notEqual(next.phrase,old.phrase);
 assert.equal(f.control('这是 '+old.phrase),true);assert.equal(f.accept('这是 '+old.phrase),'revoked');
 assert.equal(f.accept('这是 '+next.phrase),'verified');
 f.setNow(retiredAt+3*day-1);assert.equal(f.control('这是 '+old.phrase),true);assert.equal(f.accept('这是 '+old.phrase),'revoked');
 f.advance(1);assert.equal(f.control('这是 '+old.phrase),false);assert.equal(f.accept('这是 '+old.phrase),'ordinary');
});

test('natural expiry starts exactly at 24 hours, remains old traffic for three days without a timer, then becomes ordinary',async t=>{
 const f=await fixture(t),issued=await f.start(),createdAt=f.now();
 f.setNow(createdAt+day-1);assert.equal(f.status('selected-member').status,'pending');assert.equal(f.control('这是 '+issued.phrase),true);
 f.advance(1);assert.equal(f.status('selected-member').status,'expired');assert.equal(f.accept('这是 '+issued.phrase),'expired');
 f.setNow(createdAt+4*day-1);assert.equal(f.control('这是 '+issued.phrase),true);assert.equal(f.accept('这是 '+issued.phrase),'expired');
 f.advance(1);assert.equal(f.control('这是 '+issued.phrase),false);assert.equal(f.accept('这是 '+issued.phrase),'ordinary');
 assert.equal(f.record().wecomContactMappings,undefined);
});

test('used codes expire from old-code recognition three days after consumption, not three days after original expiry',async t=>{
 const f=await fixture(t),issued=await f.start();f.advance(1234);const consumed=f.now();
 assert.equal(f.accept('这是 '+issued.phrase),'verified');assert.equal(f.accept('这是 '+issued.phrase,{callback:'other-person'}),'used');
 f.setNow(consumed+3*day-1);assert.equal(f.control('这是 '+issued.phrase),true);f.reopen();assert.equal(f.accept('这是 '+issued.phrase),'used');
 f.advance(1);assert.equal(f.control('这是 '+issued.phrase),false);assert.equal(f.accept('这是 '+issued.phrase),'ordinary');
 assert.equal(f.record().wecomContactMappings.length,1);
});

test('late retirement cannot extend a naturally expired code and new issuance prunes only histories outside three days',async t=>{
 const f=await fixture(t),issued=await f.start(),createdAt=f.now();f.advance(2*day);
 const before=f.record();f.repository.save({...before,wecomMemberChallenges:before.wecomMemberChallenges.map(c=>({...c,status:'failed',completedAt:f.now()}))},before);
 f.setNow(createdAt+4*day-1);assert.equal(f.accept('这是 '+issued.phrase),'expired');
 f.advance(1);assert.equal(f.control('这是 '+issued.phrase),false);
 await f.start('other-person');assert.equal(f.challenges().length,1);
 const old=f.store.one('SELECT collision_hash,code_hash,sealed_code FROM wecom_member_verification_requests WHERE request_id=?',before.wecomMemberChallenges[0].requestId);
 assert.deepEqual(Object.values(old),[null,null,null]);
});

test('collision reservations cover the full validity and old-code window but are not permanent',async t=>{
 const f=await fixture(t),issued=await f.start(),row=f.store.one('SELECT * FROM wecom_member_verification_requests WHERE collision_hash IS NOT NULL');
 assert.throws(()=>f.store.run('INSERT INTO wecom_member_verification_requests VALUES(?,?,?,?,?,?,?,?,?,?,?)',row.connection_id,'other-source',row.auth_revision+1,randomUUID(),'other-user',f.now(),row.app_id,row.code_hash,row.collision_hash,null,randomUUID()),/UNIQUE constraint failed/);
 f.advance(4*day-1);await f.start('second-person');
 assert.equal(f.store.one('SELECT collision_hash FROM wecom_member_verification_requests WHERE request_id=?',row.request_id).collision_hash,row.collision_hash);
 f.advance(1);await f.start('third-person');
 assert.equal(f.store.one('SELECT collision_hash FROM wecom_member_verification_requests WHERE request_id=?',row.request_id).collision_hash,null);
 assert.equal(f.control('这是 '+issued.phrase),false);
});

test('concurrent same-person requests share one issued code, while different people have unique active codes',async t=>{
 const f=await fixture(t),same=await Promise.all(Array.from({length:20},()=>f.start('person-a')));
 assert.equal(new Set(same.flatMap(r=>r.phrase?[r.phrase]:[])).size,1);assert.equal(f.pending().length,1);
 const others=await Promise.allSettled(Array.from({length:10},(_,i)=>f.start('person-'+i)));
 assert.equal(others.filter(r=>r.status==='fulfilled').length,9);assert.deepEqual(others.filter(r=>r.status==='rejected').map(r=>r.reason.code),['member_verification_limit']);
 const codes=[f.status('person-a').phrase,...others.flatMap(r=>r.status==='fulfilled'?[r.value.phrase]:[])];assert.equal(new Set(codes).size,10);
});

test('bounded configuration never evicts a still-protected old code to make room for another replacement',async t=>{
 const f=await fixture(t),first=await f.start();for(let i=1;i<100;i++)await f.start('selected-member',{replace:true});
 await assert.rejects(f.start('selected-member',{replace:true}),{code:'member_verification_limit'});
 assert.equal(f.control('这是 '+first.phrase),true);assert.equal(f.accept('这是 '+first.phrase),'revoked');
 f.advance(3*day);await f.start('selected-member',{replace:true});assert.equal(f.control('这是 '+first.phrase),false);
});

for(const change of ['revalidate','credential-save','source','unbind-rebind'])test(`${change} cannot reuse old-scope codes as control traffic or identity proof`,async t=>{
 const f=await fixture(t),issued=await f.start(),before=f.record();
 if(change==='revalidate')await f.service.revalidate('w','e','wecom','u',before.revision);
 if(change==='credential-save')await f.service.save('w','e','wecom','u',{appId:before.appId,appSecret:'synthetic-rotated-secret',expectedRevision:before.revision});
 if(change==='source')assert.equal(f.repository.save({...before,sourceId:'synthetic-replacement-source'},before),true);
 if(change==='unbind-rebind'){f.service.unbind('w','e','wecom','u',{expectedRevision:before.revision});await f.service.save('w','e','wecom','u',{appId:before.appId,appSecret:secret});}
 if(change!=='source')f.authenticate();
 assert.equal(f.control('这是 '+issued.phrase),false);assert.equal(f.accept('这是 '+issued.phrase),'ordinary');assert.equal(f.record().wecomContactMappings,undefined);
 const next=await f.start();assert.notEqual(next.phrase,issued.phrase);assert.equal(f.accept(next.phrase),'verified');
});

test('one-to-one mappings reject conflicting callbacks without overwriting the earlier person',async t=>{
 const f=await fixture(t),a=await f.start('person-a'),b=await f.start('person-b');
 assert.equal(f.accept(a.phrase),'verified');assert.equal(f.accept(b.phrase),'invalid');assert.equal(f.accept(b.phrase),'revoked');
 assert.deepEqual(f.record().wecomContactMappings.map(m=>m.userId),['person-a']);
});

test('six-digit extraction counts occurrences, preserves leading zeroes and never extracts longer-number fragments',()=>{
 for(const text of ['000123','验证码给你 000123','这是000123','a000123b'])assert.deepEqual(weComMemberCodeCandidates(text),['000123']);
 for(const text of ['12345','1234567','0123456789','验证码给你','１２３４５６'])assert.deepEqual(weComMemberCodeCandidates(text),[]);
 assert.deepEqual(weComMemberCodeCandidates('000123 和 000456'),['000123','000456']);
 assert.deepEqual(weComMemberCodeCandidates('000123 000123'),['000123','000123']);
});

test('only exactly one known value is control; words, unknown codes and multiple occurrences remain ordinary',async t=>{
 const f=await fixture(t),issued=await f.start(),bad=unknown(f);
 for(const text of ['验证码','普通消息',bad,'订单编号 '+bad,'验证码 '+bad,issued.phrase+' '+bad,issued.phrase+' '+issued.phrase,'验证码 '+issued.phrase+'7','identale-verify-'+('a'.repeat(32))]){
  assert.equal(f.control(text),false);assert.equal(f.accept(text),'ordinary');
 }
 assert.equal(f.record().wecomContactMappings,undefined);
 assert.equal(f.control('验证码给你 '+issued.phrase),true);assert.equal(f.accept('验证码给你 '+issued.phrase),'verified');
});

test('unknown numeric messages never create attempt budgets or affect a later known code, including legacy frozen records',async t=>{
 const f=await fixture(t),issued=await f.start(),bad=unknown(f),before=f.record();
 f.repository.save({...before,wecomVerificationResetId:'legacy',wecomVerificationLimit:{epoch:'legacy',retryAt:f.now()+day}},before);
 for(let i=0;i<50;i++){assert.equal(f.control('订单编号 '+bad),false);assert.equal(f.accept('订单编号 '+bad),'ordinary');}
 assert.equal(f.status('selected-member').error,undefined);assert.equal(f.accept(issued.phrase),'verified');
 assert.equal(f.store.one("SELECT 1 FROM sqlite_master WHERE name='wecom_member_verification_attempts'"),undefined);
 assert.equal(f.store.one("SELECT 1 FROM sqlite_master WHERE name='wecom_member_verification_notices'"),undefined);
 assert.equal((await f.app.inject({method:'POST',url:endpoint+'/reset',payload:{}})).statusCode,404);
});

test('group, quote and mixed messages do not bind or become verification controls, even with a known code',async t=>{
 const f=await fixture(t),issued=await f.start();
 for(const patch of [{chattype:'group',chatid:'synthetic-group'},{quote:{msgtype:'text',text:{content:'quoted'}}},{text:{content:'收到'},quote:{msgtype:'text',text:{content:issued.phrase}}},{msgtype:'mixed',mixed:{msg_item:[{msgtype:'text',text:{content:issued.phrase}}]}}])assert.equal(f.control(issued.phrase,patch),false);
 assert.equal(f.control('ordinary text',{callback:issued.phrase,msgid:issued.phrase,timestamp:Number(issued.phrase)}),false);
 assert.equal(f.accept(issued.phrase,{privateMessage:false}),'ordinary');assert.equal(f.record().wecomContactMappings,undefined);
});

test('split snapshots carry only scoped digests; active and three-day old-code behavior survives runtime restart',async t=>{
 const f=await fixture(t,{role:'platform'}),issued=await f.start(),token='synthetic-split-security-token',runtimeKey=deriveRuntimeConfigurationKey(token);
 const server=Fastify();registerChannelObservationApi(server,{token,channels:f.service,store:f.store});
 const path=join(f.root,'runtime.sqlite'),sent=[];let runtime,repository,service,reporter;
 const open=()=>{
  runtime=new Store(path,{role:'runtime'});repository=new EmployeeChannelRepository(runtime);service=new EmployeeChannelService(repository,{masterKey:runtimeKey,now:f.now});
  const snap=configurationSnapshot({store:f.store,masterKey:key,token,now:f.now});assertNoClearValue(snap,issued.phrase);
  runtime.replaceConfigurationTables(snap.tables.map(table=>({...table,rows:snap.privateCredentials.tables.find(p=>p.name===table.name)?.rows??table.rows})));
  reporter=installChannelObservationReporter(runtime,repository,{url:'http://127.0.0.1:1',token,now:f.now,fetch:async(_url,init)=>{
   sent.push(JSON.parse(init.body));const response=await server.inject({method:'POST',url:'/internal/config/channel-observation',headers:init.headers,payload:JSON.parse(init.body)});
   return new Response(response.body,{status:response.statusCode,headers:{'content-type':'application/json'}});
  }});
 };
 open();f.closeBeforeStore.push(async()=>{await reporter.close();runtime.close();await server.close();});
 const record=()=>repository.byId(f.record().id),text='这是 '+issued.phrase;
 const control=()=>service.memberVerification.isControl(record(),{body:{chattype:'single',msgtype:'text',text:{content:text}}});
 const accept=id=>service.memberVerification.accept(record(),{text,callbackUserId:'callback',eventId:id,messageId:id,privateMessage:true});
 assert.equal(runtime.one("SELECT 1 FROM main.sqlite_master WHERE name='wecom_member_verification_requests'"),undefined);
 assert.equal(runtime.one('SELECT count(*) n FROM wecom_member_verification_requests').n,0);assert.equal(service.memberVerification.status(record(),'selected-member').phrase,undefined);
 assert.equal(control(),true);assert.equal(accept('runtime-success'),'verified');await reporter.flush();assert.ok(reporter.status().every(row=>row.status==='accepted'));
 assert.equal(f.status('selected-member').status,'verified');assertNoClearValue(sent,issued.phrase);
 await reporter.close();runtime.close();open();assert.equal(control(),true);assert.equal(accept('runtime-success'),'ignored');assert.equal(accept('runtime-repeated'),'used');
 f.advance(3*day);assert.equal(control(),false);assert.equal(accept('runtime-outside-retention'),'ordinary');
 assert.equal(runtime.one("SELECT 1 FROM main.sqlite_master WHERE name LIKE 'wecom_member_code_%'"),undefined);
 runtime.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');assert.equal(readFileSync(path).includes(Buffer.from(JSON.stringify(issued.phrase))),false);
});
