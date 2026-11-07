import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../dist/store.js';
import {SqliteConversationRepository} from '../dist/adapters/sqlite/conversation-repository.js';
import {SqliteTaskRepository} from '../dist/adapters/sqlite/task-repository.js';
import {SqliteScheduleRepository} from '../dist/adapters/sqlite/schedule-repository.js';
import {createBuiltinInteractionProvider} from '../dist/adapters/builtin-interaction-provider.js';
import {ContextMaintenanceService} from '../dist/context-maintenance.js';
import {TaskService,TaskError,createInteractionService,scopeFromJson} from '@dentity/application';
import {JsonlJournal} from '@dentity/runtime-builtin';
async function setup(t,{serviceEnabled=true,disableDuringSummary=false}={}){
 const dir=mkdtempSync(join(tmpdir(),'channel-maintenance-fixture-')),store=new Store(join(dir,'db.sqlite'));let provider;
 t.after(async()=>{await provider?.shutdown();store.close();rmSync(dir,{recursive:true,force:true});});
 store.db.exec("INSERT INTO users VALUES('u','user','User','active');INSERT INTO workspaces VALUES('w','Workspace','u','active');INSERT INTO members VALUES('member','w','u','owner','active');INSERT INTO entities(id,workspace_id,name,owner_member_id,created_by_member_id,own_web_use,web_use_user_id,interaction_runtime) VALUES('e','w','Employee','member','member',1,'u','builtin-interaction');");
 let now=1800000000000,humanAllowed=true,serviceAllowed=serviceEnabled,bindingVersion='v1',humanChecks=0,serviceChecks=0,summaryCalls=0,maintenance;
 const journal=new JsonlJournal({root:join(dir,'journal'),ownerId:'fixture',serialize:fn=>store.transaction(fn)}),conversations=new SqliteConversationRepository(store,journal,()=>now);conversations.initialize(0);
 const tasks=new TaskService(new SqliteTaskRepository(store),()=>now,undefined,{authorizeEntity(){humanChecks++;if(!humanAllowed)throw new TaskError(403,'speaker_revoked');}},undefined,conversations);
 const entities={getRuntimeDefinition:(w,e)=>store.one('SELECT name,description,interaction_runtime AS interactionRuntime FROM entities WHERE workspace_id=? AND id=?',w,e)};
 provider=createBuiltinInteractionProvider(store,conversations,tasks,()=>now,entities,{journal,modelClient:{async complete(request){if(!request.tools.length){summaryCalls++;assert.deepEqual(request.tools,[]);if(disableDuringSummary)serviceAllowed=false;return{text:'Summary of earlier shared conversation.',usage:{inputTokens:20,outputTokens:10}};}return{text:'Conversation answer.',usage:{inputTokens:10,outputTokens:5}};}},authorizeMaintenance:request=>maintenance?.authorize(request)??false,authorizeConversationMaintenance:conv=>{serviceChecks++;const scope=scopeFromJson(conv.scope_json);return serviceAllowed&&scope.source?.bindingVersion===bindingVersion&&!!store.one("SELECT id FROM workspaces WHERE id=? AND status='active'",conv.workspace_id);}});
 const interaction=createInteractionService(conversations,tasks,provider,()=>now),scope={workspaceId:'w',entityId:'e',principal:{kind:'channel',channelType:'feishu',tenantId:'tenant',identityNamespace:'open_id',externalUserId:'first-speaker'},source:{channelType:'feishu',tenantId:'tenant',installationId:'install',applicationId:'app',connectionId:'connection',bindingVersion:'v1',conversationId:'shared-group',conversationKind:'group'}};
 const conv=interaction.create(scope,{operationId:'conversation',mode:'real'}).conversation;
 for(let i=0;i<12;i++){const speaker={...scope,principal:{...scope.principal,externalUserId:i%2?'latest-speaker':'first-speaker'}};const {turn}=await interaction.createTurn(speaker,conv.id,{operationId:`turn-${i}`,text:`Group discussion ${i}`});for(let retry=0;retry<100;retry++){const result=await interaction.getTurn(speaker,conv.id,turn.id);if(result.turn.status==='succeeded')break;assert.notEqual(result.turn.status,'failed');await new Promise(r=>setTimeout(r,1));}}
 maintenance=new ContextMaintenanceService(store,new SqliteScheduleRepository(store,'context.compact'),conversations,provider,()=>now,{policy:{contextTokenThreshold:1,retainMessages:20}});
 return{store,provider,maintenance,conv:conversations.get(conv.id),setHumanAllowed:v=>humanAllowed=v,setServiceAllowed:v=>serviceAllowed=v,setBinding:v=>bindingVersion=v,advance:ms=>now+=ms,get humanChecks(){return humanChecks;},get serviceChecks(){return serviceChecks;},get summaryCalls(){return summaryCalls;}};
}
test('shared group session compacts with service authority after all speakers are revoked, with no tools or fake users',async t=>{
 const s=await setup(t);s.setHumanAllowed(false);const checks=s.humanChecks,maintenance=await s.provider.resolveMaintenance(s.conv);assert.deepEqual(Object.keys(maintenance.runtime).sort(),['getMaintenanceStatus','inspectContext','requestMaintenance']);assert.equal(maintenance.runtime.submit,undefined);await s.maintenance.tick();assert.equal(s.humanChecks,checks,'Maintenance must not borrow first/latest speaker authorization');assert.ok(s.serviceChecks>0);assert.equal(s.summaryCalls,1);const jobs=s.store.all('SELECT status,error FROM scheduled_jobs');assert.ok(jobs.some(j=>j.status==='succeeded'),JSON.stringify(jobs));const session=JSON.parse(s.store.one("SELECT json FROM builtin_records WHERE key LIKE 'builtin:session:%'").json);assert.ok(session.summaryRef);assert.equal(s.store.one('SELECT count(*) n FROM users').n,1);assert.equal(s.store.one('SELECT count(*) n FROM tasks').n,0);
});
for(const revoke of ['binding','workspace','service'])test(`group maintenance rejects revoked ${revoke} authority before summary`,async t=>{
 const s=await setup(t);s.setHumanAllowed(false);if(revoke==='binding')s.setBinding('v2');if(revoke==='workspace')s.store.run("UPDATE workspaces SET status='disabled'");if(revoke==='service')s.setServiceAllowed(false);const checks=s.humanChecks;await s.maintenance.tick();assert.equal(s.summaryCalls,0);assert.equal(s.humanChecks,checks);assert.equal(s.store.one('SELECT status FROM scheduled_jobs').status,'skipped');
});
test('group service revocation during summary prevents atomic summary publication',async t=>{
 const s=await setup(t,{disableDuringSummary:true});s.setHumanAllowed(false);const checks=s.humanChecks;await s.maintenance.tick();assert.equal(s.summaryCalls,1);assert.equal(s.humanChecks,checks);const session=JSON.parse(s.store.one("SELECT json FROM builtin_records WHERE key LIKE 'builtin:session:%'").json);assert.equal(session.summaryRef,undefined);assert.notEqual(s.store.one('SELECT status FROM scheduled_jobs').status,'succeeded');
});
