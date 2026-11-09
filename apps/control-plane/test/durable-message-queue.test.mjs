import test from'node:test';import assert from'node:assert/strict';import{mkdtemp,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';
import{Store}from'../dist/store.js';import{SqliteMessageLoopRepository}from'../dist/channel-loop/repository.js';import{MemoryMessageLoopRepository}from'../dist/channel-loop/memory-repository.js';
const epoch=1800000000000,day=86400000;
const scope=(chat='a')=>({workspaceId:'w',entityId:'e',principal:{kind:'channel',channelType:'feishu',tenantId:'tenant',identityNamespace:'open_id',externalUserId:'user'},source:{channelType:'feishu',tenantId:'tenant',installationId:'connection',applicationId:'app',connectionId:'connection',bindingVersion:'binding',conversationId:chat,conversationKind:'private',replyToMessageId:'message'}});
const inbox=(id,chat='a',createdAt=epoch)=>({id,lane:chat,connectionId:'connection',bindingVersion:'binding',scopeJson:JSON.stringify(scope(chat)),eventJson:JSON.stringify({source:id,text:'SYNTHETIC DURABLE BODY'}),status:'queued',conversationId:null,turnId:null,leaseToken:null,createdAt});
const out=(id,chat='a')=>({id,scopeJson:JSON.stringify(scope(chat)),targetJson:JSON.stringify({conversation:{provider:'feishu',connectionId:'connection',tenantId:'tenant',kind:'conversation',externalId:chat,conversationKind:'private'}}),text:'SYNTHETIC DURABLE OUTPUT',status:'queued',taskDeliveryId:null,leaseToken:null});
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'identity-durable-queue-')),store=new Store(join(root,'isolated.sqlite'));let at=epoch;const repos=[];const make=()=>{const r=new SqliteMessageLoopRepository(store,()=>at);repos.push(r);return r;};const repo=make();await repo.cleanupComplete();t.after(async()=>{for(const r of repos)r.close();store.close();await rm(root,{recursive:true,force:true});});return{repo,store,make,advance:n=>at+=n,now:()=>at};}
function claim(f,id='token'){return f.repo.claimInbox(f.now(),f.now()+60000,id);}
function complete(f,id,token='token'){const r=claim(f,token);assert.equal(r.id,id);f.repo.bindTurn(id,token,'conversation','turn-'+id);f.repo.beginSubmission(id,token);f.repo.markAccepted(id,token);f.repo.applyInputReceipt(id,'committed');f.repo.markTerminal(id,'succeeded');}

test('SQLite payloads and prepared group input survive shutdown/reopen without normal TTL or count/size quota',async t=>{const f=await fixture(t);for(let i=0;i<1100;i++)f.repo.accept(inbox('id-'+i,'chat-'+i));const first=claim(f);f.repo.prepareInput(first.id,'token','fixed-group-input','batch-fixed');f.repo.close();f.advance(20*day);const reopened=f.make();await reopened.cleanupComplete();const next=reopened.claimInbox(f.now(),f.now()+60000,'new');assert.equal(next.id,'id-0');assert.equal(next.inputText,'fixed-group-input');assert.equal(next.historyBatchId,'batch-fixed');assert.match(next.eventJson,/SYNTHETIC DURABLE BODY/);assert.equal(reopened.health('connection').queue.inboxCount,1100);assert.equal(reopened.accept(inbox('id-0')),'duplicate');assert.equal(f.store.one('SELECT count(*) n FROM channel_inbox').n,1100);const compat=new MemoryMessageLoopRepository(f.store,f.now,1);f.advance(day);assert.match(compat.claimInbox(f.now(),f.now()+60000,'compat').eventJson,/SYNTHETIC/);compat.close();});

test('accepted is durable and does not revert unknown; fixed 30s submitting budget releases its lane without replay',async t=>{const f=await fixture(t);f.repo.accept(inbox('first'));f.repo.accept(inbox('second'));assert.equal(claim(f).id,'first');const submission=f.repo.beginSubmission('first','token');f.advance(20000);assert.equal(f.repo.beginSubmission('first','token').deadlineAt,submission.deadlineAt);assert.equal(claim(f,'blocked'),undefined);f.advance(10001);assert.equal(claim(f,'second-token').id,'second');assert.equal(f.store.one("SELECT status FROM channel_inbox WHERE id='first'").status,'unknown');assert.equal(f.repo.pendingReceipts().length,0);f.repo.bindTurn('second','second-token','conversation','turn-second');f.repo.beginSubmission('second','second-token');f.repo.markAccepted('second','second-token');f.advance(day);assert.equal(claim(f,'later'),undefined);assert.equal(f.store.one("SELECT status FROM channel_inbox WHERE id='second'").status,'accepted');f.repo.applyInputReceipt('first','committed');assert.equal(f.store.one("SELECT status FROM channel_inbox WHERE id='first'").status,'committed');assert.equal(f.repo.accept(inbox('first')),'duplicate');});

test('committed input remains available for independent RT output events and cursor never moves backwards',async t=>{const f=await fixture(t);f.repo.accept(inbox('input'));const r=claim(f);f.repo.bindTurn(r.id,'token','conversation','turn');f.repo.beginSubmission(r.id,'token');f.repo.markAccepted(r.id,'token');f.repo.applyInputReceipt(r.id,'committed');assert.equal(f.repo.pendingReceipts()[0].id,'input');f.repo.advanceEventCursor(r.id,'7');f.repo.advanceEventCursor(r.id,'2');assert.equal(f.repo.eventCursor(r.id),'7');f.repo.markTerminal(r.id,'succeeded');assert.equal(f.repo.pendingReceipts().length,0);});

test('old memory_queue_lost unknown and expired receipts remain facts but cannot block fresh private input or replay',async t=>{const f=await fixture(t);f.store.run("INSERT INTO channel_message_receipts(id,kind,lane,connection_id,status,created_at,updated_at,error) VALUES('legacy','inbox','a','connection','unknown',?,?,'memory_queue_lost_on_restart')",epoch,epoch);f.store.run("INSERT INTO channel_message_receipts(id,kind,lane,connection_id,status,created_at,updated_at,error) VALUES('old-hi','inbox','a','connection','expired',?,?,'memory_message_expired')",epoch,epoch);const upgrade=f.make();assert.equal(upgrade.accept(inbox('old-hi')),'duplicate');assert.equal(upgrade.accept(inbox('legacy')),'duplicate');upgrade.accept(inbox('fresh'));assert.equal(upgrade.claimInbox(f.now(),f.now()+60000,'new').id,'fresh');assert.equal(upgrade.health('connection').recovery.blockedConversationCount,0);assert.equal(upgrade.health('connection').recovery.unknownConversationCount,1);assert.equal(f.store.one("SELECT count(*) n FROM channel_inbox WHERE id IN ('legacy','old-hi')").n,0);});

test('outbox body survives restart and unknown send cannot resend; 30s budget unlocks later output, late sent only patches original',async t=>{const f=await fixture(t);f.repo.enqueueDelivery(out('one'),epoch);f.repo.enqueueDelivery(out('two'),epoch);const first=f.repo.claimDelivery(f.now(),f.now()+60000,'one-send');assert.equal(first.id,'one');f.repo.close();const upgraded=f.make();assert.equal(upgraded.claimDelivery(f.now(),f.now()+60000,'early'),undefined);f.advance(30001);const second=upgraded.claimDelivery(f.now(),f.now()+60000,'two-send');assert.equal(second.id,'two');assert.match(second.text,/DURABLE OUTPUT/);assert.equal(f.store.one("SELECT status FROM channel_deliveries WHERE id='one'").status,'unknown');upgraded.reconcileDelivery('one','sent','provider-one');assert.equal(f.store.one("SELECT status,message_id FROM channel_deliveries WHERE id='one'").message_id,'provider-one');upgraded.finishDelivery('two','two-send','sent');assert.equal(upgraded.claimDelivery(f.now(),f.now()+60000,'none'),undefined);});

test('permission quick reply bypasses ordinary sending lane; it is still durably routed and deduplicated',async t=>{const f=await fixture(t);f.repo.enqueueDelivery(out('ordinary'),epoch);f.repo.claimDelivery(f.now(),f.now()+60000,'ordinary');const event={provider:'feishu',connectionId:'connection',tenantId:'tenant',kind:'conversation',externalId:'a',conversationKind:'group'};const route={workspaceId:'w',entityId:'e',connectionId:'connection',bindingVersion:'binding',appId:'app',conversation:event,messageId:'source',eventId:'event'};const quick={...out('quick'),scopeJson:JSON.stringify({kind:'channel_quick_reply',route,replyKind:'permission',source:{connectionId:'connection'}})};assert.equal(f.repo.enqueueDelivery(quick,epoch),'created');assert.equal(f.repo.enqueueDelivery(quick,epoch),'duplicate');assert.equal(f.repo.claimDelivery(f.now(),f.now()+60000,'priority').id,'quick');});

test('safe retries honor RetryAfter/backoff and stop at five attempts; unknown never qualifies',async t=>{const f=await fixture(t);f.repo.enqueueDelivery(out('retry'),epoch);for(let attempt=1;attempt<=5;attempt++){const token='try-'+attempt;assert.equal(f.repo.claimDelivery(f.now(),f.now()+60000,token).id,'retry');f.repo.deferDelivery('retry',token,{safeToRetry:true,retryAfterMs:2000});if(attempt<5){assert.equal(f.repo.claimDelivery(f.now(),f.now()+60000,'too-early'),undefined);f.advance(Math.max(2000,1000*2**(attempt-1)));}}assert.equal(f.store.one("SELECT status,attempts FROM channel_deliveries WHERE id='retry'").status,'failed');assert.equal(f.repo.claimDelivery(f.now(),f.now()+60000,'six'),undefined);f.repo.enqueueDelivery(out('unsafe'),f.now());f.repo.claimDelivery(f.now(),f.now()+60000,'unsafe');f.repo.deferDelivery('unsafe','unsafe',{safeToRetry:false});f.advance(30001);assert.equal(f.repo.claimDelivery(f.now(),f.now()+60000,'never'),undefined);assert.equal(f.store.one("SELECT attempts FROM channel_deliveries WHERE id='unsafe'").attempts,1);});

test('retention uses closure time, keeps live/referenced rows, clears safe successful bodies at 24h and dedup after 30d',async t=>{const f=await fixture(t);f.repo.accept(inbox('completed'));complete(f,'completed');f.repo.accept(inbox('live','live'));f.repo.accept(inbox('protected','protected'));const r=claim(f,'protected-token');assert.equal(r.id,'live');f.repo.finishInbox(r.id,'protected-token','blocked',undefined,30000);const p=claim(f,'protected-token');assert.equal(p.id,'protected');f.repo.bindTurn(p.id,'protected-token','conv','turn-protected');f.repo.beginSubmission(p.id,'protected-token');f.repo.markAccepted(p.id,'protected-token');f.repo.applyInputReceipt(p.id,'committed');f.repo.markTerminal(p.id,'succeeded');f.repo.setRetentionReferenceGuard((_kind,id)=>id==='protected');f.advance(day+1);f.repo.cleanup(f.now());await f.repo.cleanupComplete();assert.equal(f.store.one("SELECT event_json FROM channel_inbox WHERE id='completed'").event_json,null);assert.ok(f.store.one("SELECT event_json FROM channel_inbox WHERE id='live'").event_json);assert.ok(f.store.one("SELECT event_json FROM channel_inbox WHERE id='protected'").event_json);f.advance(30*day);f.repo.cleanup(f.now());await f.repo.cleanupComplete();assert.equal(f.store.one("SELECT id FROM channel_inbox WHERE id='completed'"),undefined);assert.equal(f.repo.seenInbox('completed'),false);assert.ok(f.store.one("SELECT id FROM channel_inbox WHERE id='live'"));assert.ok(f.store.one("SELECT id FROM channel_inbox WHERE id='protected'"));assert.ok(f.repo.health('connection').storage.walBytes>=0);});

test('setImmediate wakes let IO/timers progress and no normal 100ms poll is scheduled',async t=>{const f=await fixture(t);let wakes=0;f.repo.onWork(()=>wakes++);for(let i=0;i<100;i++)f.repo.accept(inbox('wake-'+i,'chat-'+i));await new Promise(r=>setImmediate(r));assert.equal(wakes,1);await new Promise(r=>setTimeout(r,120));assert.equal(wakes,1);});

test('group reserve and prepared input share one transaction and crash rollback cannot leave an invisible reserved batch',async t=>{const f=await fixture(t);f.store.db.exec('CREATE TABLE synthetic_reserve(id TEXT PRIMARY KEY)');f.repo.accept(inbox('atomic'));claim(f);assert.throws(()=>f.repo.prepareInputAtomically('atomic','token',()=>{f.store.run("INSERT INTO synthetic_reserve VALUES('batch')");throw Error('crash window');}));assert.equal(f.store.one('SELECT id FROM synthetic_reserve'),undefined);assert.equal(f.store.one("SELECT input_text FROM channel_inbox WHERE id='atomic'").input_text,null);const built=f.repo.prepareInputAtomically('atomic','token',()=>{f.store.run("INSERT INTO synthetic_reserve VALUES('batch')");return{text:'fixed once',historyBatchId:'batch'};});assert.equal(built.text,'fixed once');const again=f.repo.prepareInputAtomically('atomic','token',()=>{throw Error('must not reserve twice');});assert.deepEqual(again,built);f.repo.close();const next=f.make().claimInbox(f.now(),f.now()+60000,'restarted');assert.equal(next.inputText,'fixed once');assert.equal(next.historyBatchId,'batch');assert.equal(f.store.one('SELECT count(*) n FROM synthetic_reserve').n,1);});

test('accepted send stays uncertain until its fixed confirmation budget; blocked pre-send work waits without spinning',async t=>{const f=await fixture(t);f.repo.enqueueDelivery(out('provider-accepted'),epoch);f.repo.enqueueDelivery(out('later'),epoch);f.repo.claimDelivery(f.now(),f.now()+60000,'first');f.repo.finishDelivery('provider-accepted','first','accepted');assert.equal(f.store.one("SELECT status FROM channel_deliveries WHERE id='provider-accepted'").status,'unknown');assert.equal(f.repo.claimDelivery(f.now(),f.now()+60000,'blocked'),undefined);f.advance(30001);assert.equal(f.repo.claimDelivery(f.now(),f.now()+60000,'later').id,'later');f.repo.finishDelivery('later','later','blocked','connection_paused');assert.equal(f.repo.claimDelivery(f.now(),f.now()+60000,'not-yet'),undefined);f.advance(30001);assert.equal(f.repo.claimDelivery(f.now(),f.now()+60000,'retry-after-pause').id,'later');});
test('retention batches continue beyond protected rows and dedup cleanup never refreshes closure clocks',async t=>{const f=await fixture(t);for(let i=0;i<220;i++){const id='closed-'+i;f.repo.accept(inbox(id,'lane-'+i));f.store.run("UPDATE channel_inbox SET status='committed',rt_terminal=1,closed_at=? WHERE id=?",epoch,id);}f.repo.setRetentionReferenceGuard((_kind,id)=>Number(id.split('-')[1])<110);f.advance(31*day);f.repo.cleanup(f.now());await f.repo.cleanupComplete();assert.equal(f.store.one('SELECT count(*) n FROM channel_inbox').n,110);assert.ok(f.store.one("SELECT event_json FROM channel_inbox WHERE id='closed-1'").event_json);assert.equal(f.store.one("SELECT id FROM channel_inbox WHERE id='closed-219'"),undefined);});

test('registered technical cleanup remains domain-owned, bounded and yields between batches without deleting user history',async t=>{const f=await fixture(t);f.store.db.exec('CREATE TABLE synthetic_technical(id INTEGER PRIMARY KEY,closed INTEGER);CREATE TABLE synthetic_user_history(text TEXT)');f.store.run("INSERT INTO synthetic_user_history VALUES('history must remain')");for(let i=0;i<250;i++)f.store.run('INSERT INTO synthetic_technical VALUES(?,1)',i);let calls=0;f.repo.registerRetentionSweep('fixture.closed',(_now,limit)=>{calls++;assert.equal(limit,100);const rows=f.store.all('SELECT id FROM synthetic_technical LIMIT ?',limit);for(const r of rows)f.store.run('DELETE FROM synthetic_technical WHERE id=?',r.id);return{deleted:rows.length,more:rows.length===limit};});f.repo.cleanup(f.now());await f.repo.cleanupComplete();assert.equal(calls,3);assert.equal(f.store.one('SELECT count(*) n FROM synthetic_technical').n,0);assert.equal(f.store.one('SELECT count(*) n FROM synthetic_user_history').n,1);});

test('upgrade never replays historical SQL payloads left behind by former memory receipts',async t=>{const f=await fixture(t);f.repo.accept(inbox('old-input'));f.store.run("UPDATE channel_message_receipts SET status='expired',error='memory_queue_lost_on_restart' WHERE id='old-input'");f.repo.enqueueDelivery(out('old-output'),epoch);f.store.run("UPDATE channel_message_receipts SET status='sent' WHERE id='old-output'");f.repo.close();const upgrade=f.make();upgrade.accept(inbox('fresh'));assert.equal(upgrade.claimInbox(f.now(),f.now()+60000,'new').id,'fresh');assert.equal(upgrade.claimDelivery(f.now(),f.now()+60000,'must-not-replay'),undefined);assert.equal(f.store.one("SELECT status FROM channel_inbox WHERE id='old-input'").status,'expired');assert.equal(f.store.one("SELECT status FROM channel_deliveries WHERE id='old-output'").status,'sent');});

test('stable source identity detects changed payload or trusted route and never overwrites the original input',async t=>{const f=await fixture(t);const first={...inbox('identity'),sourceKey:'source-key',payloadHash:'hash-one'};assert.equal(f.repo.accept(first),'created');assert.equal(f.repo.checkDuplicate('identity',{sourceKey:'source-key',payloadHash:'hash-one'}),true);assert.equal(f.repo.accept(first),'duplicate');assert.throws(()=>f.repo.accept({...first,eventJson:'modified',payloadHash:'hash-two'}),{code:'conflict'});assert.throws(()=>f.repo.accept({...first,id:'different-route-derived-id',lane:'other',sourceKey:'source-key',payloadHash:'different-trusted-route'}),{code:'conflict'});assert.equal(f.store.one('SELECT count(*) n FROM channel_inbox').n,1);assert.equal(f.store.one('SELECT event_json FROM channel_inbox').event_json,first.eventJson);});
test('rejected input is a durable dedup fact outside normal inbox, later rights do not replay the rejected event',async t=>{const f=await fixture(t);const route={workspaceId:'w',entityId:'e',connectionId:'connection',bindingVersion:'binding',appId:'app',conversation:{provider:'feishu',connectionId:'connection',tenantId:'tenant',kind:'conversation',externalId:'a',conversationKind:'private'},messageId:'source',eventId:'event',sourceKey:'rejected-source',payloadHash:'body-hash'};f.repo.enqueueDelivery({...out('reject'),scopeJson:JSON.stringify({kind:'channel_quick_reply',route,replyKind:'permission',source:{connectionId:'connection'}}),correlation:{traceId:'input',messageId:'reject',causationId:'input'}},epoch);assert.equal(f.repo.checkDuplicate('input',{sourceKey:'rejected-source',payloadHash:'body-hash'}),true);assert.throws(()=>f.repo.checkDuplicate('input',{sourceKey:'rejected-source',payloadHash:'changed'}),{code:'conflict'});assert.equal(f.store.one('SELECT count(*) n FROM channel_inbox').n,0);assert.equal(f.repo.claimInbox(epoch,epoch+60000,'none'),undefined);});

test('local paused connection checks cannot consume the network retry count or five minute retry budget',async t=>{const f=await fixture(t);f.repo.enqueueDelivery(out('paused'),f.now());for(let i=0;i<7;i++){const token='paused-'+i;assert.equal(f.repo.claimDelivery(f.now(),f.now()+60000,token).id,'paused');f.repo.finishDelivery('paused',token,'blocked','temporarily_unavailable');const r=f.store.one("SELECT attempts,first_attempt_at FROM channel_deliveries WHERE id='paused'");assert.equal(r.attempts,0);assert.equal(r.first_attempt_at,null);f.advance(60000);}assert.equal(f.repo.claimDelivery(f.now(),f.now()+60000,'network').id,'paused');f.repo.deferDelivery('paused','network',{safeToRetry:true,retryAfterMs:5000});const r=f.store.one("SELECT status,retry_at,attempts,first_attempt_at FROM channel_deliveries WHERE id='paused'");assert.equal(r.status,'pending');assert.equal(r.attempts,1);assert.equal(r.first_attempt_at,f.now());assert.equal(r.retry_at,f.now()+5000);});

function acceptQueryable(f,id='query',repo=f.repo){
 repo.enqueueDelivery(out(id),f.now());
 assert.equal(repo.claimDelivery(f.now(),f.now()+60000,'send-'+id).id,id);
 repo.finishDelivery(id,'send-'+id,'accepted',undefined,undefined,'process-'+id,true);
}
function queryFact(f,id='query'){return f.store.one('SELECT * FROM channel_deliveries WHERE id=?',id);}
function queryReceipt(f,id='query'){return f.store.one("SELECT * FROM channel_message_receipts WHERE id=? AND kind='outbox'",id);}

test('queryable acceptance atomically persists request key and schedule; sent query never fabricates a message id',async t=>{
 const f=await fixture(t);acceptQueryable(f);
 const accepted=queryFact(f);
 assert.equal(accepted.status,'unknown');assert.equal(accepted.provider_request_id,'process-query');
 assert.equal(accepted.message_id,null);assert.equal(accepted.receipt_query_state,'pending');
 assert.equal(accepted.receipt_query_at,epoch+2000);assert.equal(accepted.receipt_query_deadline,epoch+300000);
 assert.equal(queryReceipt(f).provider_request_id,'process-query');
 f.advance(1999);assert.equal(f.repo.claimDeliveryQuery(f.now(),'early'),undefined);
 f.advance(1);const row=f.repo.claimDeliveryQuery(f.now(),'query-token');
 assert.equal(row.id,'query');assert.equal(row.providerRequestId,'process-query');assert.equal(row.scopeJson,out('query').scopeJson);assert.equal(row.targetJson,out('query').targetJson);
 assert.equal(f.repo.ownsDeliveryQuery('query','query-token'),true);
 assert.equal(queryFact(f).receipt_query_attempts,1);
 f.repo.finishDeliveryQuery('query','query-token',{status:'sent'});
 for(const fact of [queryFact(f),queryReceipt(f)]){assert.equal(fact.status,'sent');assert.equal(fact.message_id,null);assert.equal(fact.provider_request_id,'process-query');assert.equal(fact.error,null);}
 assert.equal(queryFact(f).receipt_query_state,'done');assert.equal(f.repo.ownsDeliveryQuery('query','query-token'),false);
 assert.equal(f.repo.claimDelivery(f.now(),f.now()+60000,'must-not-resend'),undefined);
});

test('receipt queries use 2/5/10/20/30 second delays and exhaust five queries without another send',async t=>{
 const f=await fixture(t);acceptQueryable(f);
 for(const [index,delay] of [2000,5000,10000,20000,30000].entries()){
  f.advance(delay-1);assert.equal(f.repo.claimDeliveryQuery(f.now(),'early'),undefined);f.advance(1);
  const token='query-'+index;assert.equal(f.repo.claimDeliveryQuery(f.now(),token).id,'query');
  assert.equal(queryFact(f).receipt_query_attempts,index+1);
  f.repo.finishDeliveryQuery('query',token,{status:index%2?'unknown':'processing'});
  assert.equal(queryFact(f).attempts,1);assert.equal(f.repo.claimDelivery(f.now(),f.now()+60000,'never-send'),undefined);
 }
 assert.equal(queryFact(f).receipt_query_state,'done');
 for(const fact of [queryFact(f),queryReceipt(f)]){assert.equal(fact.status,'unknown');assert.equal(fact.error,'receipt_query_exhausted');}
 f.advance(day);assert.equal(f.repo.claimDeliveryQuery(f.now(),'sixth'),undefined);
 assert.equal(f.repo.claimDelivery(f.now(),f.now()+60000,'never-resend'),undefined);
});

test('pending receipt query survives reopen and an in-flight query waits for its lease before fencing a stale token',async t=>{
 const f=await fixture(t);acceptQueryable(f);f.repo.close();const reopened=f.make();
 assert.equal(reopened.claimDeliveryQuery(f.now(),'early'),undefined);f.advance(2000);
 assert.equal(reopened.claimDeliveryQuery(f.now(),'old-token').id,'query');
 assert.equal(queryFact(f).receipt_query_lease_until,f.now()+30000);
 reopened.close();const restarted=f.make();
 assert.equal(restarted.claimDeliveryQuery(f.now(),'too-soon'),undefined);f.advance(29999);
 assert.equal(restarted.claimDeliveryQuery(f.now(),'still-too-soon'),undefined);f.advance(1);
 assert.equal(restarted.ownsDeliveryQuery('query','old-token'),false);
 assert.equal(restarted.claimDeliveryQuery(f.now(),'new-token').id,'query');assert.equal(queryFact(f).receipt_query_attempts,2);
 const before=queryFact(f);restarted.finishDeliveryQuery('query','old-token',{status:'recalled'});assert.deepEqual(queryFact(f),before);
 restarted.finishDeliveryQuery('query','new-token',{status:'sent'});assert.equal(queryFact(f).status,'sent');
 assert.equal(restarted.claimDelivery(f.now(),f.now()+60000,'never-send'),undefined);
});

test('crashed fifth query exhausts at lease expiry and its late successful result cannot change unknown',async t=>{
 const f=await fixture(t);acceptQueryable(f);f.advance(2000);
 for(let attempt=1;attempt<=5;attempt++){
  assert.equal(f.repo.claimDeliveryQuery(f.now(),'crash-'+attempt).id,'query');
  assert.equal(queryFact(f).receipt_query_attempts,attempt);f.advance(29999);
  assert.equal(f.repo.claimDeliveryQuery(f.now(),'too-soon'),undefined);f.advance(1);
 }
 assert.equal(f.repo.claimDeliveryQuery(f.now(),'sixth'),undefined);
 assert.equal(queryFact(f).receipt_query_state,'done');assert.equal(queryFact(f).error,'receipt_query_exhausted');
 f.repo.finishDeliveryQuery('query','crash-5',{status:'sent'});
 assert.equal(queryFact(f).status,'unknown');assert.equal(queryReceipt(f).status,'unknown');assert.equal(queryFact(f).attempts,1);
});

for(const inflight of [false,true])test(`acceptance-based five-minute query deadline survives restart (inflight=${inflight})`,async t=>{
 const f=await fixture(t);f.repo.enqueueDelivery(out('query'),epoch);
 f.repo.claimDelivery(f.now(),f.now()+60000,'send-query');f.advance(10000);
 f.repo.finishDelivery('query','send-query','accepted',undefined,undefined,'process-query',true);
 assert.equal(queryFact(f).receipt_query_deadline,epoch+310000);
 f.advance(299000);if(inflight)assert.equal(f.repo.claimDeliveryQuery(f.now(),'last-token').id,'query');
 f.repo.close();const reopened=f.make();f.advance(1000);
 assert.equal(reopened.ownsDeliveryQuery('query','last-token'),false);
 assert.equal(reopened.claimDeliveryQuery(f.now(),'deadline'),undefined);
 reopened.finishDeliveryQuery('query','last-token',{status:'sent'});
 assert.equal(queryFact(f).status,'unknown');assert.equal(queryFact(f).error,'receipt_query_exhausted');assert.equal(queryReceipt(f).error,'receipt_query_exhausted');
 assert.equal(reopened.claimDelivery(f.now(),f.now()+60000,'never-send'),undefined);
});

test('receipt Retry-After extends query delay but never extends acceptance deadline',async t=>{
 const f=await fixture(t);acceptQueryable(f);f.advance(2000);f.repo.claimDeliveryQuery(f.now(),'first');
 f.repo.finishDeliveryQuery('query','first',{status:'unknown',error:'rate_limited',retryAfterMs:60000});
 assert.equal(queryFact(f).receipt_query_at,f.now()+60000);assert.equal(queryReceipt(f).error,'rate_limited');
 f.advance(59999);assert.equal(f.repo.claimDeliveryQuery(f.now(),'early'),undefined);f.advance(1);
 assert.equal(f.repo.claimDeliveryQuery(f.now(),'second').id,'query');
 f.repo.finishDeliveryQuery('query','second',{status:'processing',retryAfterMs:300000});
 assert.equal(queryFact(f).receipt_query_deadline,epoch+300000);assert.equal(queryFact(f).receipt_query_state,'done');
 assert.equal(queryFact(f).error,'receipt_query_exhausted');assert.equal(queryFact(f).attempts,1);
});

for(const result of [{status:'recalled'},{status:'unknown',error:'identity_changed',stop:true}])test(`terminal receipt query synchronizes receipt without resend (${result.status})`,async t=>{
 const f=await fixture(t);acceptQueryable(f);f.advance(2000);f.repo.claimDeliveryQuery(f.now(),'terminal');
 f.repo.finishDeliveryQuery('query','terminal',result);
 for(const fact of [queryFact(f),queryReceipt(f)]){
  assert.equal(fact.status,result.status==='recalled'?'failed':'unknown');
  assert.equal(fact.error,result.status==='recalled'?'provider_message_recalled':'identity_changed');assert.equal(fact.message_id,null);
 }
 assert.equal(queryFact(f).receipt_query_state,'done');assert.equal(queryFact(f).blocking,0);
 f.repo.enqueueDelivery(out('later-output'),f.now());assert.equal(f.repo.claimDelivery(f.now(),f.now()+60000,'later-output').id,'later-output');f.repo.finishDelivery('later-output','later-output','sent');f.advance(day);
 assert.equal(f.repo.claimDeliveryQuery(f.now(),'later'),undefined);assert.equal(f.repo.claimDelivery(f.now(),f.now()+60000,'resend'),undefined);
});

test('old unknown rows and non-queryable accepted sends are never adopted into receipt queries',async t=>{
 const f=await fixture(t);
 for(const [id,queryable,key] of [['legacy',false,'old-process'],['missing-key',true,undefined],['unsafe',false,undefined]]){
  f.repo.enqueueDelivery(out(id,id),epoch);f.repo.claimDelivery(f.now(),f.now()+60000,id);
  f.repo.finishDelivery(id,id,id==='unsafe'?'unknown':'accepted',undefined,undefined,key,queryable);
 }
 f.repo.close();const reopened=f.make();f.advance(day);
 assert.equal(reopened.claimDeliveryQuery(f.now(),'never-query-old'),undefined);
 assert.equal(reopened.claimDelivery(f.now(),f.now()+60000,'never-resend-old'),undefined);
 for(const id of ['legacy','missing-key','unsafe']){assert.equal(queryFact(f,id).receipt_query_state,null);assert.equal(queryFact(f,id).receipt_query_attempts,0);assert.equal(queryFact(f,id).status,'unknown');}
 acceptQueryable(f,'fresh',reopened);f.advance(2000);assert.equal(reopened.claimDeliveryQuery(f.now(),'fresh-query').id,'fresh');
});

test('receipt query scheduling and acceptance roll back together if persistence fails',async t=>{
 const f=await fixture(t);f.repo.enqueueDelivery(out('query'),epoch);
 f.repo.claimDelivery(f.now(),f.now()+60000,'send-query');
 const before=queryFact(f),receiptBefore=queryReceipt(f);
 f.store.db.exec("CREATE TRIGGER synthetic_query_persistence_failure BEFORE UPDATE OF receipt_query_state ON channel_deliveries WHEN NEW.receipt_query_state='pending' BEGIN SELECT RAISE(ABORT,'synthetic query persistence failure'); END");
 assert.throws(()=>f.repo.finishDelivery('query','send-query','accepted',undefined,undefined,'process-query',true),/synthetic query persistence failure/);
 assert.deepEqual(queryFact(f),before);assert.deepEqual(queryReceipt(f),receiptBefore);
 f.store.db.exec('DROP TRIGGER synthetic_query_persistence_failure');
 f.repo.finishDelivery('query','send-query','accepted',undefined,undefined,'process-query',true);
 assert.equal(queryFact(f).status,'unknown');assert.equal(queryFact(f).provider_request_id,'process-query');assert.equal(queryFact(f).receipt_query_state,'pending');
});
