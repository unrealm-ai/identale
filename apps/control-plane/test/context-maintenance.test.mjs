import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from '../dist/server.js';
import {Store} from '../dist/store.js';
import {SqliteScheduleRepository} from '../dist/adapters/sqlite/schedule-repository.js';
import {ContextMaintenanceService,defaultMaintenancePolicy} from '../dist/context-maintenance.js';

test('default summary generation and injection budgets are separate from history retention',()=>{
 assert.equal(defaultMaintenancePolicy.maxDailySummaryTokens,2048);assert.equal(defaultMaintenancePolicy.maxSummaryTokens,8192);
 assert.equal(defaultMaintenancePolicy.retainMessages,60);assert.equal(defaultMaintenancePolicy.recentDays,30);assert.equal(defaultMaintenancePolicy.contextTokenThreshold,12000);
});
const origin='http://127.0.0.1:5173';
const sessionRecord=s=>s.db.prepare("SELECT key,version,json FROM builtin_records WHERE key LIKE 'builtin:session:%'").get();
const maintenanceJobs=s=>s.db.prepare("SELECT id,status,error,job_key FROM scheduled_jobs WHERE handler='context.compact'").all();
// Keep small-history integration scenarios explicit; the production default is asserted above.
async function setup(t,{threshold=999999,interval=1000,summaryFailure=false}={}){
 const dir=await mkdtemp(join(tmpdir(),'identity-maintenance-')),databasePath=join(dir,'db.sqlite');let now=1800000000000,maintenance,summaryCalls=0,chatCalls=0;const histories=[];
 const config={databasePath,origin,pollIntervalMs:0,sessionTtlMs:48*60*60*1000,now:()=>now,maintenance:{intervalMs:interval,policy:{contextTokenThreshold:threshold,retainMessages:20}},onMaintenanceService:s=>maintenance=s,modelClient:{async complete(input){if(!input.tools.length){summaryCalls++;if(summaryFailure)throw Error('Synthetic summary failure');return{text:'Synthetic summary: preserve goal, constraints, decisions and pending task.',finishReason:'stop',usage:{inputTokens:20,outputTokens:10}};}chatCalls++;histories.push(input.messages);return{text:`reply-${chatCalls}`,usage:{inputTokens:10,outputTokens:5}};}}};
 let app=createServer(config);await app.ready();const db=new DatabaseSync(databasePath);t.after(async()=>{await app.close();db.close();await rm(dir,{recursive:true,force:true});});
 const call=(method,url,payload,cookie)=>app.inject({method,url,...(payload===undefined?{}:{payload}),headers:{origin,...(cookie?{cookie}:{})}});
 const reg=await call('POST','/api/auth/register',{username:'maintenance-user',password:'Synthetic test password'});assert.equal(reg.statusCode,201,reg.body);const account=reg.json(),cookie=reg.headers['set-cookie'].split(';')[0];const entityResult=await call('POST',`/api/workspaces/${account.workspace.id}/entities`,{name:'Maintained employee',ownWebUse:true},cookie);assert.equal(entityResult.statusCode,200,entityResult.body);const entity=entityResult.json().entity,base=`/api/workspaces/${account.workspace.id}/entities/${entity.id}`;
 const convResult=await call('POST',base+'/conversations',{mode:'real'},cookie);assert.equal(convResult.statusCode,201,convResult.body);const conv=convResult.json().conversation;
 async function turn(n){const result=await call('POST',`${base}/conversations/${conv.id}/turns`,{operationId:`op-${n}`,text:`ORIGINAL-${n}`},cookie);assert.equal(result.statusCode,202,result.body);for(let i=0;i<100;i++){const r=await call('GET',`${base}/conversations/${conv.id}/turns/${result.json().turn.id}`,undefined,cookie);assert.equal(r.statusCode,200,r.body);if(r.json().turn.status==='succeeded')return;r.json().turn.status==='failed'&&assert.fail(r.body);await new Promise(r=>setTimeout(r,2));}assert.fail('Turn not finished');}
 return{dir,db,conv,base,cookie,call,turn,histories,get now(){return now;},advance:ms=>now+=ms,get maintenance(){return maintenance;},get summaryCalls(){return summaryCalls;},setSummaryFailure:value=>summaryFailure=value,async restart(){await app.close();app=createServer(config);await app.ready();}};
}
test('default conversation continues after 24h with finite invocation authorization',async t=>{
 const s=await setup(t);assert.equal(s.conv.expiresAt,null);await s.turn(1);s.advance(25*60*60*1000);await s.turn(2);assert.equal(s.histories[1].some(m=>m.content==='ORIGINAL-1'),true);assert.equal(s.db.prepare('SELECT expires_at FROM conversations').get().expires_at,0);
 const rows=s.db.prepare('SELECT json FROM builtin_records WHERE key LIKE ?').all('builtin:execution:%');for(const row of rows){const c=JSON.parse(row.json).request.authorizationContext;assert.equal(Date.parse(c.expiresAt)-Date.parse(JSON.parse(row.json).request.deadlineAt),0);assert.ok(Date.parse(c.expiresAt)<s.now+61_000);}
 await s.restart();const messages=await s.call('GET',`${s.base}/conversations/${s.conv.id}/messages`,undefined,s.cookie);assert.equal(messages.statusCode,200,messages.body);assert.equal(messages.json().messages.length,4);
});
for(const mode of ['schedule','context_threshold'])test(`${mode} maintenance compacts through provider, preserves searchable originals, injects summary, survives restart`,async t=>{
 const s=await setup(t,{threshold:mode==='schedule'?999999:1});for(let i=0;i<12;i++)await s.turn(i);
 await s.maintenance.tick();if(mode==='schedule'){assert.equal(s.summaryCalls,0);s.advance(1001);await s.maintenance.tick();}
 const jobs=s.db.prepare('SELECT status,error,payload_json FROM scheduled_jobs').all();assert.ok(jobs.some(j=>j.status==='succeeded'),JSON.stringify(jobs));assert.ok(s.summaryCalls>=1);
 const files=await readdir(join(s.dir,'builtin-records'),{recursive:true});assert.ok(files.some(f=>f.endsWith('current.jsonl')));assert.ok(files.some(f=>f.endsWith('summary.jsonl')));assert.ok(files.some(f=>f.endsWith('.jsonl')&&!f.endsWith('current.jsonl')&&!f.endsWith('summary.jsonl')));
 const messages=await s.call('GET',`${s.base}/conversations/${s.conv.id}/messages`,undefined,s.cookie);assert.equal(messages.statusCode,200,messages.body);for(let i=0;i<12;i++)assert.ok(messages.json().messages.some(m=>m.text===`ORIGINAL-${i}`));
 await s.restart();await s.turn(12);assert.ok(JSON.stringify(s.histories.at(-1)).includes('Synthetic summary'));const read=await s.call('GET',`${s.base}/conversations/${s.conv.id}/messages`,undefined,s.cookie);assert.equal(read.json().messages.length,26);
 const sql=s.db.prepare('SELECT payload_json FROM scheduled_jobs').all().map(x=>x.payload_json).join('');assert.equal(sql.includes('ORIGINAL-'),false);assert.equal(sql.includes('Synthetic summary'),false);
});
test('maintenance authorization rejects stale leases, wrong scope, and altered policy',async t=>{
 const s=await setup(t);await s.turn(0);await s.maintenance.tick();s.advance(1001);
 // Enqueue via the real scheduler discovery, but examine a later explicit deterministic job lease.
 const raw=s.db.prepare('SELECT payload_json FROM scheduled_jobs LIMIT 1').get();const p=JSON.parse(raw.payload_json);const job=s.maintenance.scheduler.enqueue('authorization-check','context.compact',p),claimed=s.maintenance.repository.claim(s.now,1000);assert.equal(claimed.id,job.id);
 const a={workspaceId:p.session.runtime.workspaceId,entityId:p.session.runtime.entityId,conversationId:s.conv.id,sessionId:p.session.sessionId,configRevision:p.session.configRevision,policyRevision:p.policyRevision,jobRunId:job.id,leaseToken:claimed.leaseToken,expiresAt:new Date(s.now+1000).toISOString()};const request={operationId:job.id,deadlineAt:a.expiresAt,authorization:a,session:p.session,reason:p.reason,policy:p.policy,idempotencyKey:job.key};assert.equal(s.maintenance.authorize(request),true);assert.equal(s.maintenance.authorize({...request,authorization:{...a,conversationId:'other'}}),false);assert.equal(s.maintenance.authorize({...request,policy:{...p.policy,retainMessages:1}}),false);s.advance(1001);assert.equal(s.maintenance.authorize(request),false);
});
test('changed external runtime binding skips maintenance without silently falling back to builtin',async t=>{
 const s=await setup(t,{threshold:1});await s.turn(0);s.db.prepare("UPDATE entities SET interaction_runtime='local-pi'").run();await s.maintenance.tick();assert.equal(s.summaryCalls,0);const job=s.db.prepare('SELECT status,error FROM scheduled_jobs').get();assert.equal(job.status,'skipped');assert.equal(job.error,'runtime_unavailable');
});
test('atomic SQLite maintenance publication rejects a reclaimed lease and reconciles with the new worker',async t=>{
 const s=await setup(t,{threshold:1});for(let i=0;i<12;i++)await s.turn(i);
 const conv=s.db.prepare('SELECT * FROM conversations WHERE id=?').get(s.conv.id);
 const {runtime}=await s.maintenance.provider.resolve({workspaceId:conv.workspace_id,entityId:conv.entity_id,userId:conv.user_id},conv);
 const publish=runtime.options.publishMaintenance;assert.equal(typeof publish,'function');let intercepted=false;
 const before=JSON.parse(s.db.prepare("SELECT json FROM builtin_records WHERE key LIKE 'builtin:session:%'").get().json);
 // Fault boundary only: preserve the real provider callback, transactions and SQLite stores.
 runtime.options.publishMaintenance=async(request,changes)=>{
   if(!intercepted){intercepted=true;s.advance(121_000);const replacement=s.maintenance.repository.claim(s.now,120_000);assert.equal(replacement.id,request.authorization.jobRunId);assert.notEqual(replacement.leaseToken,request.authorization.leaseToken);const result=await publish(request,changes);assert.equal(result,false);assert.equal(s.maintenance.repository.settle(replacement.id,replacement.leaseToken,'queued',0,null,s.now),true);return result;}
   return publish(request,changes);
 };
 await s.maintenance.tick();assert.equal(intercepted,true);const blocked=JSON.parse(s.db.prepare("SELECT json FROM builtin_records WHERE key LIKE 'builtin:session:%'").get().json);assert.deepEqual(blocked.messageRefs,before.messageRefs);assert.equal(blocked.summaryRef,undefined);
 const calls=s.summaryCalls;await s.maintenance.tick();const done=s.db.prepare("SELECT status FROM scheduled_jobs WHERE job_key LIKE 'context:%' ORDER BY created_at LIMIT 1").get();assert.equal(done.status,'succeeded');assert.equal(s.summaryCalls,calls,'Recovery must not rerun the model');
 const messages=await s.call('GET',`${s.base}/conversations/${s.conv.id}/messages`,undefined,s.cookie);assert.equal(messages.statusCode,200,messages.body);assert.equal(messages.json().messages.length,24);
});

test('bounded discovery reaches session 501 and resumes its scan after process recreation',async t=>{
 const s=await setup(t);await s.turn(1);
 const row=s.db.prepare("SELECT key,json FROM builtin_records WHERE key LIKE 'builtin:session:%'").get();const value=JSON.parse(row.json);value.closed=true;
 const insert=s.db.prepare('INSERT INTO builtin_records(key,version,json) VALUES(?,1,?)');for(let i=0;i<500;i++)insert.run(`builtin:session:!${String(i).padStart(4,'0')}`,JSON.stringify(value));
 await s.maintenance.tick();assert.equal(s.db.prepare('SELECT count(*) AS n FROM scheduled_jobs').get().n,0);
 await s.restart();await s.maintenance.tick();assert.equal(s.db.prepare('SELECT count(*) AS n FROM scheduled_jobs').get().n,0);
 await s.maintenance.tick();assert.equal(s.db.prepare('SELECT count(*) AS n FROM scheduled_jobs').get().n,1);assert.equal(s.db.prepare('SELECT status FROM scheduled_jobs').get().status,'skipped');
 await s.maintenance.tick();await s.maintenance.tick();assert.equal(s.db.prepare('SELECT count(*) AS n FROM scheduled_jobs').get().n,1);
});

test('maintenance replacement checks authoritative renewed lease and terminal status',async t=>{
 const s=await setup(t);await s.turn(1);await s.maintenance.tick();
 const payload=JSON.parse(s.db.prepare('SELECT payload_json FROM scheduled_jobs LIMIT 1').get().payload_json);
 const conv=s.db.prepare('SELECT * FROM conversations WHERE id=?').get(s.conv.id);const {runtime}=await s.maintenance.provider.resolve({workspaceId:conv.workspace_id,entityId:conv.entity_id,userId:conv.user_id},conv);
 const make=(job,lease)=>({operationId:job.id,idempotencyKey:job.key,session:payload.session,policy:payload.policy,reason:payload.reason,deadlineAt:new Date(lease.leaseUntil).toISOString(),authorization:{workspaceId:conv.workspace_id,entityId:conv.entity_id,conversationId:conv.id,sessionId:payload.session.sessionId,configRevision:payload.session.configRevision,policyRevision:payload.policyRevision,jobRunId:job.id,leaseToken:lease.leaseToken,expiresAt:new Date(lease.leaseUntil).toISOString()}});
 const old=s.maintenance.scheduler.enqueue('old-replacement','context.compact',payload),lease=s.maintenance.repository.claim(s.now,1000),previous=make(old,lease);s.advance(1001);
 const renewed=s.maintenance.repository.claim(s.now,120000);assert.equal(renewed.id,old.id);assert.notEqual(renewed.leaseToken,lease.leaseToken);
 const current=s.maintenance.scheduler.enqueue('new-replacement','context.compact',payload),currentLease=s.maintenance.repository.claim(s.now,120000),request=make(current,currentLease);
 assert.equal(s.maintenance.authorize(request),true);assert.equal(await runtime.options.authorizeMaintenanceReplacement(request,previous),false,'Stored expired lease does not imply the old job is terminal');
 assert.equal(s.maintenance.repository.settle(old.id,renewed.leaseToken,'failed',0,'synthetic failure',s.now),true);assert.equal(await runtime.options.authorizeMaintenanceReplacement(request,previous),true);
 assert.equal(await runtime.options.authorizeMaintenanceReplacement({...request,authorization:{...request.authorization,leaseToken:'stale'}},previous),false);
 assert.equal(await runtime.options.authorizeMaintenanceReplacement(request,{...previous,authorization:{...previous.authorization,conversationId:'other'}}),false);
});

test('durable maintenance publication reconciles beyond retry budget without replaying summary',async t=>{
 const s=await setup(t,{threshold:1});for(let i=0;i<12;i++)await s.turn(i);
 const conv=s.db.prepare('SELECT * FROM conversations WHERE id=?').get(s.conv.id);const {runtime}=await s.maintenance.provider.resolve({workspaceId:conv.workspace_id,entityId:conv.entity_id,userId:conv.user_id},conv);const publish=runtime.options.publishMaintenance;
 let failures=7;runtime.options.publishMaintenance=async(request,changes)=>{if(failures-->0)throw Error('Synthetic recoverable publication failure');return publish(request,changes);};
 let calls;for(let i=0;i<7;i++){await s.maintenance.tick();const job=s.db.prepare('SELECT * FROM scheduled_jobs').get();assert.equal(job.status,'queued');assert.equal(job.error,'MAINTENANCE_RECONCILIATION_REQUIRED');if(calls===undefined)calls=s.summaryCalls;else assert.equal(s.summaryCalls,calls);s.advance(60_001);}
 await s.maintenance.tick();const jobs=s.db.prepare('SELECT * FROM scheduled_jobs').all();assert.equal(jobs.length,1);assert.equal(jobs[0].status,'succeeded');assert.equal(jobs[0].attempt,8);assert.equal(s.summaryCalls,calls);
 const messages=(await s.call('GET',`${s.base}/conversations/${s.conv.id}/messages`,undefined,s.cookie)).json().messages;assert.equal(messages.length,24);
});

test('summary failure changes session bookkeeping but cannot schedule a new job for unchanged history',async t=>{
 const s=await setup(t,{threshold:1,interval:3_600_000,summaryFailure:true});for(let i=0;i<12;i++)await s.turn(i);
 const before=sessionRecord(s),history=JSON.parse(before.json).messageRefs;await s.maintenance.tick();
 assert.equal(s.summaryCalls,1);assert.equal(maintenanceJobs(s).length,1);assert.equal(maintenanceJobs(s)[0].status,'failed');assert.equal(maintenanceJobs(s)[0].error,'summary_unavailable_or_invalid');
 const after=sessionRecord(s);assert.ok(after.version>=before.version+2,'setting and clearing pending maintenance are real CAS writes');assert.deepEqual(JSON.parse(after.json).messageRefs,history);assert.equal(JSON.parse(after.json).pendingMaintenance,undefined);
 for(let i=0;i<15;i++){s.advance(100);await s.maintenance.tick();}
 assert.equal(s.summaryCalls,1);assert.equal(maintenanceJobs(s).length,1);assert.match(s.db.prepare('SELECT last_context_fingerprint FROM context_maintenance_schedules').get().last_context_fingerprint,/^[a-f0-9]{64}$/);
});

test('new real input allows a fresh summary after failure; observer-only CAS writes do not',async t=>{
 const s=await setup(t,{threshold:1,interval:3_600_000,summaryFailure:true});for(let i=0;i<12;i++)await s.turn(i);await s.maintenance.tick();
 const row=sessionRecord(s),value=JSON.parse(row.json);value.observationOnly={synthetic:true};s.db.prepare('UPDATE builtin_records SET version=version+1,json=? WHERE key=?').run(JSON.stringify(value),row.key);
 s.setSummaryFailure(false);await s.maintenance.tick();assert.equal(s.summaryCalls,1,'changing only administrative state does not implicitly retry a failed model call');
 await s.turn(12);await s.maintenance.tick();assert.equal(s.summaryCalls,2);assert.ok(maintenanceJobs(s).some(j=>j.status==='succeeded'));assert.ok(JSON.parse(sessionRecord(s).json).summaryRef);
});

test('failed history fingerprint survives service restart and remains idempotent until new input',async t=>{
 const s=await setup(t,{threshold:1,interval:3_600_000,summaryFailure:true});for(let i=0;i<12;i++)await s.turn(i);await s.maintenance.tick();
 const fingerprint=s.db.prepare('SELECT last_context_fingerprint FROM context_maintenance_schedules').get().last_context_fingerprint;await s.restart();
 for(let i=0;i<4;i++)await s.maintenance.tick();assert.equal(s.summaryCalls,1);assert.equal(maintenanceJobs(s).length,1);assert.equal(s.db.prepare('SELECT last_context_fingerprint FROM context_maintenance_schedules').get().last_context_fingerprint,fingerprint);
 await s.turn(12);await s.maintenance.tick();assert.equal(s.summaryCalls,2);assert.equal(maintenanceJobs(s).length,2);
});

test('overlapping discovery and two scheduler instances create only one failed intent per content fingerprint',async t=>{
 const s=await setup(t,{threshold:1,interval:3_600_000,summaryFailure:true});for(let i=0;i<12;i++)await s.turn(i);
 const first=s.maintenance,second=new ContextMaintenanceService(first.store,new SqliteScheduleRepository(first.store),first.conversations,first.provider,first.now,first.options);t.after(()=>second.stop());
 await Promise.all([first.tick(),second.tick(),first.tick(),second.tick()]);assert.equal(s.summaryCalls,1);assert.equal(maintenanceJobs(s).length,1);
 await Promise.all([second.tick(),first.tick()]);assert.equal(s.summaryCalls,1);assert.equal(maintenanceJobs(s).length,1);
});

test('scheduled interval still permits a later attempt without creating a failure hot loop',async t=>{
 const s=await setup(t,{threshold:1,interval:10_000,summaryFailure:true});for(let i=0;i<12;i++)await s.turn(i);await s.maintenance.tick();assert.equal(s.summaryCalls,1);
 s.advance(10_001);await s.maintenance.tick();assert.equal(s.summaryCalls,2);assert.equal(maintenanceJobs(s).length,2);assert.ok(maintenanceJobs(s).some(j=>j.job_key.includes(':due:')));
 await s.maintenance.tick();await s.maintenance.tick();assert.equal(s.summaryCalls,2);assert.equal(maintenanceJobs(s).length,2);
});

test('reference key ordering and lease-like changes preserve fingerprint, while stored model generation change does not',async t=>{
 const s=await setup(t,{threshold:999999,interval:3_600_000});await s.turn(0);await s.maintenance.tick();assert.equal(maintenanceJobs(s).length,1);
 const row=sessionRecord(s),value=JSON.parse(row.json);value.messageRefs=value.messageRefs.map(ref=>({recordId:ref.recordId,location:Object.fromEntries(Object.entries(ref.location).reverse())}));
 s.db.prepare('UPDATE builtin_records SET version=version+1,json=? WHERE key=?').run(JSON.stringify(value),row.key);await s.maintenance.tick();assert.equal(maintenanceJobs(s).length,1);
 value.handle.configRevision+='-synthetic-generation';s.db.prepare('UPDATE builtin_records SET version=version+1,json=? WHERE key=?').run(JSON.stringify(value),row.key);await s.maintenance.tick();assert.equal(maintenanceJobs(s).length,2,'discovery recognizes changed generation even if runtime later rejects an invalid synthetic generation');
});

test('legacy schedule migration preserves jobs/deadlines and persists the new content fingerprint across reopen',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'identity-maintenance-migration-')),path=join(dir,'db.sqlite');let store=new Store(path);t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
 store.db.exec("DROP TABLE combined_schema_migrations; ALTER TABLE context_maintenance_schedules DROP COLUMN last_context_fingerprint; INSERT INTO context_maintenance_schedules(session_id,policy_revision,next_due_at,last_history_version) VALUES('session','policy',10000,7)");store.close();store=new Store(path);
 let repo=new SqliteScheduleRepository(store);const job=repo.enqueue('existing-job','context.compact',{synthetic:true},0);let schedule=repo.ensureSchedule('session','policy',100,500);
 assert.deepEqual({...schedule},{next_due_at:10000,last_history_version:7,last_context_fingerprint:null});repo.observe('session',9,10000,'a'.repeat(64));store.close();store=new Store(path);repo=new SqliteScheduleRepository(store);
 assert.equal(repo.get(job.id).status,'queued');assert.equal(repo.ensureSchedule('session','policy',200,500).last_context_fingerprint,'a'.repeat(64));new SqliteScheduleRepository(store);
 schedule=repo.ensureSchedule('session','changed-policy',300,500);assert.equal(schedule.last_context_fingerprint,null);assert.equal(schedule.last_history_version,0);assert.equal(schedule.next_due_at,800);
});
