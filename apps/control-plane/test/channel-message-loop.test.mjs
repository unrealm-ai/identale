import {DingTalkBotConversationAdapter} from '../dist/adapters/channels/dingtalk.js';
import {TaskArtifacts} from '../dist/task-artifacts.js';
import {HumanConfirmation} from '../dist/human-confirmation.js';
import {EmployeeChannelRepository} from '../dist/employee-channels/repository.js';
import {HumanChannelNotifications} from '../dist/human-channel.js';
import {FeishuConversationAdapter,FeishuMinutesAdapter} from '../dist/adapters/channels/feishu.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteGroupContext} from '../dist/channel-loop/group-context.js';
import {Store} from '../dist/store.js';
import {SqliteConversationRepository} from '../dist/adapters/sqlite/conversation-repository.js';
import {SqliteTaskRepository} from '../dist/adapters/sqlite/task-repository.js';
import {MemoryMessageLoopRepository} from '../dist/channel-loop/memory-repository.js';
import {SqliteMessageLoopRepository} from '../dist/channel-loop/repository.js';
import {createBuiltinInteractionProvider} from '../dist/adapters/builtin-interaction-provider.js';
import {ChannelMessageLoop,ChannelError,DiagnosticError,TaskService,TaskError,createInteractionService,channelInvocationScope} from '@dentity/application';
import {JsonlJournal} from '@dentity/runtime-builtin';
import {OpenAICompatibleModelClient} from '../../../packages/runtime-builtin/dist/provider.js';
import {createServer as createRuleModelServer,closeServer as closeRuleModelServer,DEFAULT_TOKEN} from '../../mock-model/dist/server.js';
import {once} from 'node:events';
import {createHash,randomUUID} from 'node:crypto';
import {conversationOwnerKey} from '@dentity/application';
import {createServer as httpServer} from 'node:http';
import {FileDiagnostics} from '../dist/adapters/diagnostics.js';
import {diagnosticInteraction} from '../dist/adapters/diagnostic-interaction.js';
const yes={supported:true,availability:'available'};
async function diagnosticFixture(t){const root=mkdtempSync(join(tmpdir(),'identity-channel-trace-')),log=new FileDiagnostics(join(root,'diagnostics'));t.after(async()=>{await log.close();rmSync(root,{recursive:true,force:true});});const rows=async()=>{await log.flush();return readdirSync(log.root).filter(n=>n.endsWith('.jsonl')).flatMap(n=>readFileSync(join(log.root,n),'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)));};return{log,rows};}
async function fixture(t,{model,history=false,meeting=false,describeActor,diagnostics,memory=false,unconfigured=false,groupLive=false,humanEnabled=false,nativeArtifacts=false,channel='feishu',mediaAllowed=()=>true}={}){
 const dir=mkdtempSync(join(tmpdir(),'identity-channel-loop-'));let now=1800000000000;
 const store=new Store(join(dir,'app.sqlite'));
 store.run("INSERT INTO users VALUES('manager','manager','Manager','active')");store.run("INSERT INTO workspaces VALUES('w','WS','manager','active')");store.run("INSERT INTO members VALUES('manager-member','w','manager','owner','active')");store.run("INSERT INTO entities(id,workspace_id,name,owner_member_id,created_by_member_id,own_web_use,web_use_user_id,interaction_runtime) VALUES('e','w','Helper','manager-member','manager-member',1,'manager','builtin-interaction')");
 const journal=new JsonlJournal({root:join(dir,'records'),ownerId:'fixture',serialize:fn=>store.transaction(fn)}),conversations=new SqliteConversationRepository(store,journal,()=>now);conversations.initialize(0);
 const groups=groupLive?new SqliteGroupContext(store):undefined;
 const denied=new Set(),models=[],commands=[],sent=[],queries=[];let version='1',sendUnknown=false,available=true;
 const auth={authorizeEntity(s){if(denied.has(s.principal?.externalUserId))throw new TaskError(403,'revoked');},async refreshAuthorization(s){this.authorizeEntity(s);}};
 const runtime={idempotentDispatch:true,async dispatch(c){commands.push(c);return{status:'accepted'};},async input(){return{status:'received'};},async cancel(){return{status:'confirmed'};},async events(){return[];}};
 const tasks=new TaskService(new SqliteTaskRepository(store),()=>now,runtime,auth,undefined,conversations);
 if(humanEnabled)store.db.exec("CREATE TABLE IF NOT EXISTS message_asset_run_grants(asset_id TEXT,run_id TEXT,task_id TEXT,workspace_id TEXT,entity_id TEXT,created_at INTEGER,PRIMARY KEY(asset_id,run_id))");
 if(humanEnabled)new EmployeeChannelRepository(store);
 const human=humanEnabled?new HumanConfirmation(store,conversations,()=>now):undefined;if(human)tasks.setHumanCoordinator(human);
 const artifact={content:{resourceId:'artifact:'+'a'.repeat(64),version:'b'.repeat(64)},availability:'available',kind:'file',name:'report.pdf',mediaType:'application/pdf',size:7};
 const artifacts=nativeArtifacts?new TaskArtifacts(store,tasks,{artifacts:()=>[artifact],artifactContent:async()=>({kind:'file',name:'report.pdf',mediaType:'application/pdf',bytes:Buffer.from('fixture')})}):undefined;
 if(nativeArtifacts)store.db.exec('CREATE TABLE business_notification_jobs(id TEXT PRIMARY KEY,task_id TEXT,turn_id TEXT,target_json TEXT,conversation_id TEXT)');
 const provider=createBuiltinInteractionProvider(store,conversations,tasks,()=>now,{getRuntimeDefinition(){return{name:'Helper',description:'Fixture',interactionRuntime:'builtin-interaction'};}},{journal,...(artifacts?{artifacts,nativeMediaCapabilities:async(_scope,target)=>target.provider===channel&&mediaAllowed()?{image:yes,file:yes}:undefined,notificationContext:c=>{const row=store.one('SELECT * FROM business_notification_jobs WHERE id=?',c.trigger.eventId);const conv=row&&conversations.get(row.conversation_id);return conv?{scope:JSON.parse(conv.scope_json),conv}:undefined;},authorizeBusinessEvent:async event=>!!store.one('SELECT id FROM business_notification_jobs WHERE id=?',event.eventId)}:{}),...(human?{human}:{}),readAdmittedInput:id=>store.one('SELECT input_text FROM channel_inbox WHERE id=?',id)?.input_text??'',...(groups?{authorizeHistoryBatch:id=>groups.commitAllowed(id,binding)}:{}),...(diagnostics?{diagnostics}:{}),...(unconfigured?{}:{modelClient:{async complete(input){models.push(input);return model?model(input,models.length):{text:'回答完成',usage:{inputTokens:3,outputTokens:3}};}}})});
 const core=createInteractionService(conversations,tasks,provider,()=>now),interaction=diagnostics?diagnosticInteraction(core,diagnostics):core;
 const connection={workspaceId:'w',connectionId:'connection',provider:channel,tenantId:'tenant',identity:{kind:'bot',externalId:'bot'},credentialRef:'fixture-only'};
 const binding={connectionId:'connection',workspaceId:'w',entityId:'e',provider:channel,appId:'app',bindingVersion:version,enabled:true,identity:{tenantId:'tenant',tenantIdNamespace:'tenant_key'},connection,policy:{entityMentionId:'bot',ownSenderIds:['bot']},context:{historyEnabled:history,groupListenEnabled:groupLive,listenGeneration:1,meetingRefs:meeting?[{...ref('group'),kind:'minutes',externalId:'minutes'}]:[]},conversation:{connection,async inspectCapabilities(){return{mentionEvents:yes,privateMessageEvents:yes,ordinaryMessageEvents:yes,historyRead:yes,proactiveSend:yes,replyToMessage:yes,threadRead:yes};},async listMessages(ref,q){queries.push(q);return{items:[event('old','alice','group',true).message,event('old','alice','group',true).message],exhausted:true,coverage:'authorized_query',fetchedAt:now};},async sendMessage(r){sent.push(r);return{status:sendUnknown?'unknown':'sent',messageId:'out-'+sent.length,idempotent:false};}},webhook:{connection,async receiveWebhook(r){return{kind:'message',event:JSON.parse(r.rawBody)};}}};
 if(meeting)binding.meetingArtifacts={async listArtifacts(){return[{ref:{...ref('group'),kind:'summary',externalId:'summary'},sourceRef:{...ref('group'),kind:'minutes',externalId:'minutes'},kind:'summary',state:'ready',origin:'provider_summary'}];},async readSummary(artifact){return{artifact:{ref:artifact},text:'会议决定：保留关键约束',format:'text'};}};
 const connections={...(artifacts?{queueAttachments:(base,conversationId,turnId,at)=>artifacts.enqueue(repo,base,conversationId,turnId,at),readAttachment:row=>artifacts.readDelivery(row)}:{}),...(human?{allowHumanReply:(scope,text)=>human.canReply(scope,text)}:{}),...(describeActor?{describeActor}:{}),async resolveBinding(){return available?{...binding,bindingVersion:version}:undefined;},currentBindingVersion(){return available?version:undefined;},async authorizeInvocation(_binding,actor){if(denied.has(actor.externalId))throw new TaskError(403,'revoked');}};
 const repo=memory?new MemoryMessageLoopRepository(store,()=>now,300000,diagnostics):new SqliteMessageLoopRepository(store,()=>now),loop=new ChannelMessageLoop(repo,connections,interaction,tasks,()=>now,diagnostics,groups);
 // Legacy SQLite repository contracts are retained; production memory dispatcher is tested separately.
 const dispatch=loop.tick.bind(loop);loop.tick=async()=>{await dispatch();await loop.waitForWork();};
 const receive=e=>loop.acceptAuthenticatedEvent('connection',e);
 const drain=async()=>{for(let i=0;i<12;i++){if(groupLive)now+=100;await loop.tick();await new Promise(r=>setTimeout(r,3));}};
 t.after(async()=>{await loop.stop();await provider.shutdown();store.close();rmSync(dir,{recursive:true,force:true});});
 return{provider,human,store,journal,loop,repo,tasks,interaction,conversations,receive,drain,models,sent,commands,queries,denied,binding,artifacts,artifact,setAvailable:v=>available=v,setVersion:v=>version=v,setUnknown:v=>sendUnknown=v,advance:ms=>now+=ms};
}
function ref(chat='group',kind='group',user='alice'){return{provider:'feishu',connectionId:'connection',tenantId:'tenant',kind:'conversation',externalId:chat,conversationKind:kind,...(kind==='private'?{privateRecipientId:user}:{})};}
function event(id='message',user='alice',chat='group',mentioned=true,kind='group'){return{schemaVersion:1,eventId:'event-'+id,connectionId:'connection',tenantId:'tenant',receivedAt:1800000000000,origin:'live',message:{id,conversationKind:kind,conversation:ref(chat,kind,user),author:{externalId:user,idNamespace:'open_id',applicationId:'app',displayName:user,kind:'human',identityEvidence:'channel_verified'},occurredAt:1800000000000,text:'请帮我处理 '+id,mentions:mentioned?['bot']:[]}};}
test('authorized WeCom private interaction output replies to the originating message',async t=>{
 const f=await fixture(t,{channel:'wecom'}),incoming=event('wecom-private','alice','alice',false,'private');
 incoming.message.conversation.provider='wecom';incoming.message.author.idNamespace='user_id';
 await f.receive(incoming);await f.drain();
 assert.equal(f.models.length,1);assert.equal(f.sent.length,1);
 assert.equal(f.sent[0].text,'回答完成');assert.equal(f.sent[0].replyToMessageId,incoming.message.id);
 assert.equal(f.sent[0].conversation.privateRecipientId,'alice');assert.equal(f.sent[0].originatingTaskScope,undefined);
});
for(const denied of [false,true])test(`WeCom callback capability loss never falls back to proactive send (denied=${denied})`,async t=>{
 const f=await fixture(t,{channel:'wecom'}),incoming=event('wecom-no-callback','alice','alice',false,'private');
 incoming.message.conversation.provider='wecom';incoming.message.author.idNamespace='user_id';
 if(denied)f.denied.add('alice');
 const inspect=f.binding.conversation.inspectCapabilities;
 f.binding.conversation.inspectCapabilities=async()=>({...await inspect(),replyToMessage:{supported:false,availability:'unsupported'}});
 await f.receive(incoming);await f.drain();
 assert.equal(f.sent.length,0);assert.equal(f.models.length,denied?0:1);
 assert.equal(f.store.one("SELECT status FROM channel_message_receipts WHERE kind='outbox'").status,'failed');
});
test('diagnostics link generation and final delivery text without leaking model credentials',async t=>{
 const {log,rows}=await diagnosticFixture(t);const secret='SYNTHETIC_DIAGNOSTIC_PRIVATE_TOKEN',privateText='SYNTHETIC_DIAGNOSTIC_PRIVATE_BODY';
 const client=new OpenAICompatibleModelClient({endpoint:'https://example.invalid/v1',model:'fixture',secretRef:'fixture'},async()=>secret,async()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:privateText}}],usage:{prompt_tokens:1,completion_tokens:1}})),log);
 const f=await fixture(t,{diagnostics:log,model:input=>client.complete(input)}),incoming=event('diagnostic-chain','alice','dm',false,'private');incoming.message.text=privateText;
 await f.receive(incoming);await f.receive({...incoming,eventId:'different-envelope'});await f.drain();assert.equal(f.sent.length,1);
 const inbox=f.store.one('SELECT id,turn_id,conversation_id FROM channel_inbox'),outbox=f.store.one('SELECT id,correlation_json FROM channel_deliveries'),events=await rows(),correlation=JSON.parse(outbox.correlation_json);
 assert.equal(correlation.traceId,inbox.id);assert.equal(correlation.causationId,inbox.id);assert.equal(correlation.messageId,outbox.id);assert.equal(correlation.conversationId,inbox.conversation_id);
 for(const stage of ['ingress','inbox.queued','inbox.consume','interaction.submit','interaction.events','runtime','model.http','reply.persist','outbox.queued','outbox.send'])assert.ok(events.some(e=>e.stage===stage&&e.traceId===inbox.id),stage);
 assert.ok(events.some(e=>e.stage==='ingress'&&e.outcome==='duplicate'));assert.ok(events.filter(e=>e.stage==='outbox.send').every(e=>e.messageId===outbox.id&&e.causationId===inbox.id));assert.ok(events.filter(e=>e.stage==='runtime').every(e=>e.turnId===inbox.turn_id));
 assert.ok(!JSON.stringify(events).includes(secret)&&!JSON.stringify(events).includes(incoming.eventId));assert.ok(events.some(e=>e.stage==='reply.generated'&&e.text===privateText&&e.status==='generated'));assert.ok(events.some(e=>e.stage==='outbox.send'&&e.text===privateText&&e.status==='sent'));
});
test('outbound retries preserve IDs across repository recreation and separate attempts and multiple replies',async t=>{
 const {log,rows}=await diagnosticFixture(t),f=await fixture(t,{diagnostics:log});await f.receive(event('retry-parent','alice','dm',false,'private'));await f.drain();
 const inbox=f.store.one('SELECT id,scope_json,conversation_id FROM channel_inbox'),parent={traceId:inbox.id,messageId:inbox.id,conversationId:inbox.conversation_id};
 const ids=['1','2'].map(n=>'turn:'+n.repeat(64));for(const id of ids)f.repo.enqueueDelivery({id,scopeJson:inbox.scope_json,targetJson:JSON.stringify({conversation:ref('dm','private')}),text:'synthetic private reply',status:'queued',taskDeliveryId:null,leaseToken:null,correlation:{...parent,messageId:id,causationId:parent.messageId}},1800000000000);
 const first=f.repo.claimDelivery(1800000000000,1800000060000,'11111111-1111-4111-8111-111111111111');assert.equal(first.id,ids[0]);f.repo.finishDelivery(first.id,first.leaseToken,'blocked');f.advance(31000);
 const reopened=new SqliteMessageLoopRepository(f.store,()=>1800000031000),retry=reopened.claimDelivery(1800000031000,1800000091000,'22222222-2222-4222-8222-222222222222');assert.equal(retry.id,first.id);assert.deepEqual(retry.correlation,first.correlation);assert.notEqual(retry.leaseToken,first.leaseToken);reopened.finishDelivery(retry.id,retry.leaseToken,'blocked');reopened.close();f.advance(31000);await f.drain();
 assert.equal(f.store.one('SELECT status FROM channel_deliveries WHERE id=?',ids[0]).status,'sent');assert.equal(f.store.one('SELECT status FROM channel_deliveries WHERE id=?',ids[1]).status,'sent');const events=await rows();for(const id of ids)assert.ok(events.some(e=>e.stage==='outbox.send'&&e.messageId===id&&e.traceId===parent.traceId&&e.causationId===parent.messageId&&e.attemptId));
});
test('proactive task delivery uses its own trace and task/conversation without adopting the last speaker',async t=>{
 const {log,rows}=await diagnosticFixture(t),f=await fixture(t,{diagnostics:log});await f.receive(event('unrelated-speaker','alice','dm',false,'private'));await f.drain();const source=f.store.one('SELECT id,scope_json,conversation_id FROM channel_inbox'),id='33333333-3333-4333-8333-333333333333',taskId='44444444-4444-4444-8444-444444444444';
 f.repo.taskDeliveries=()=>[{id,taskId,conversationId:source.conversation_id,text:'synthetic task notice',sourceJson:source.scope_json,workspaceId:'w',entityId:'e',userId:null}];await f.loop.tick();const out=f.store.one('SELECT correlation_json FROM channel_deliveries WHERE id=?','task-delivery:'+id),correlation=JSON.parse(out.correlation_json);assert.notEqual(correlation.traceId,source.id);assert.equal(correlation.causationId,undefined);assert.equal(correlation.taskId,taskId);assert.equal(correlation.conversationId,source.conversation_id);const events=(await rows()).filter(e=>e.messageId==='task-delivery:'+id);assert.ok(events.length);assert.ok(events.every(e=>e.traceId===correlation.traceId&&!e.causationId&&e.taskId===taskId));
});
test('a blocked outbound worker retry keeps message and trace but creates a new attempt ID',async t=>{
 const {log,rows}=await diagnosticFixture(t),f=await fixture(t,{diagnostics:log});await f.receive(event('blocked-attempt','alice','dm',false,'private'));await f.drain();const original=f.store.one('SELECT id,scope_json,conversation_id FROM channel_inbox'),id='turn:'+'5'.repeat(64);f.repo.enqueueDelivery({id,scopeJson:original.scope_json,targetJson:JSON.stringify({conversation:ref('dm','private')}),text:'private fixture output',status:'queued',taskDeliveryId:null,leaseToken:null,correlation:{traceId:original.id,messageId:id,causationId:original.id,conversationId:original.conversation_id}},1800000000000);
 f.setAvailable(false);await f.loop.tick();assert.equal(f.store.one('SELECT status FROM channel_deliveries WHERE id=?',id).status,'blocked');assert.equal(f.store.one('SELECT attempts FROM channel_deliveries WHERE id=?',id).attempts,0);f.advance(31000);f.setAvailable(true);await f.loop.tick();assert.equal(f.store.one('SELECT status FROM channel_deliveries WHERE id=?',id).status,'sent');const attempts=(await rows()).filter(e=>e.stage==='outbox.send'&&e.phase==='start'&&e.messageId===id);assert.equal(attempts.length,2);assert.equal(new Set(attempts.map(e=>e.attemptId)).size,2);assert.ok(attempts.every(e=>e.traceId===original.id&&e.causationId===original.id));
});
test('explicit rate limiting retries the same durable output only after RetryAfter, without another model call',async t=>{
 const f=await fixture(t),attempts=[];f.binding.conversation.sendMessage=async request=>{attempts.push(request.operationId);if(attempts.length===1)throw new ChannelError('rate_limited','synthetic provider limit',5000);return{status:'sent',messageId:'provider-confirmed',idempotent:true};};
 await f.receive(event('limited-output','alice','dm',false,'private'));await f.drain();
 const row=f.store.one('SELECT id,status,retry_at FROM channel_deliveries');assert.equal(row.status,'pending');assert.equal(row.retry_at,1800000005000);assert.equal(attempts.length,1);
 f.advance(4999);await f.drain();assert.equal(attempts.length,1);f.advance(1);await f.drain();assert.equal(attempts.length,2);assert.equal(new Set(attempts).size,1);assert.equal(f.models.length,1);assert.equal(f.store.one('SELECT status,message_id FROM channel_deliveries WHERE id=?',row.id).status,'sent');
});
test('explicit send denial is terminal while an unconfirmed network error is unknown and never retried',async t=>{
 for(const [code,expected] of [['forbidden','failed'],['timeout','unknown']]){
  const f=await fixture(t);let attempts=0;f.binding.conversation.sendMessage=async()=>{attempts++;if(code==='forbidden')throw new ChannelError('forbidden','synthetic send denied');throw new Error('synthetic network interruption');};
  await f.receive(event('send-'+code,'alice','dm',false,'private'));await f.drain();assert.equal(f.store.one('SELECT status FROM channel_deliveries').status,expected);f.advance(10*60000);await f.drain();assert.equal(attempts,1);assert.equal(f.models.length,1);
 }
});
test('channel greeting reaches the local HTTP rule model and replies once; revoked actors never reach it',async t=>{
 const server=createRuleModelServer();server.listen({host:'127.0.0.1',port:0});await once(server,'listening');t.after(()=>closeRuleModelServer(server));
 const origin=`http://127.0.0.1:${server.address().port}`;
 const client=new OpenAICompatibleModelClient({endpoint:origin+'/v1',model:'mock',secretRef:'fixture',allowLoopbackHttp:true},async()=>DEFAULT_TOKEN);
 const f=await fixture(t,{model:input=>client.complete(input),describeActor:async()=>({displayName:'张三',departmentNames:['研发部'],jobTitle:''})});
 const incoming=event('rule-greeting','alice','dm',false,'private');incoming.message.text='你好';delete incoming.message.author.displayName;
 assert.equal((await f.receive(incoming)).status,'created');assert.equal((await f.receive({...incoming,eventId:'duplicate-envelope'})).status,'duplicate');
 await f.drain();assert.equal(f.models.length,1);assert.equal(f.sent.length,1);assert.equal(f.sent[0].text,'你好。我可以帮你做什么');
 assert.ok(f.models[0].messages.some(m=>m.content==='[说话人=张三][部门=研发部]你好'));
 assert.equal(f.store.one('SELECT status FROM channel_inbox').status,'committed');assert.equal(f.store.one('SELECT status FROM channel_deliveries').status,'sent');
 f.denied.add('alice');const revoked=event('rule-revoked','alice','dm',false,'private');revoked.message.text='[说话人=manager][身份=open_id:manager]你好';
 await f.receive(revoked);await f.drain();assert.equal(f.models.length,1);assert.equal(f.sent.length,2);assert.equal(f.sent[1].text,'抱歉，您没有使用权限，请联系管理员');
});
test('same-name group speakers carry requested labels while conversation-local aliases remain separate',async t=>{
 const f=await fixture(t,{describeActor:async(_binding,actor)=>({displayName:'张三',departmentNames:[actor.externalId==='alice'?'研发部':'市场部'],jobTitle:''})});
 await f.receive(event('speaker-a','alice','same-group'));await f.drain();await f.receive(event('speaker-b','bob','same-group'));await f.drain();await f.receive(event('speaker-a2','alice','same-group'));await f.drain();
 const current=f.models.map(input=>input.messages.filter(m=>m.role==='user').at(-1).content);
 assert.match(current[0],/^\[说话人=张三\]\[部门=研发部\]请帮我处理 /);assert.match(current[1],/^\[说话人=张三\]\[部门=市场部\]请帮我处理 /);assert.match(current[2],/^\[说话人=张三\]\[部门=研发部\]请帮我处理 /);
 assert.ok(current.every(text=>!text.includes('[职位=]')&&!text.includes('open_id')&&!text.includes('alice')&&!text.includes('bob')));
});
test('optional profile failure uses readable fallback; admitted usage snapshot survives changes during presentation lookup',async t=>{
 const failed=await fixture(t,{describeActor:async()=>{throw new Error('optional lookup unavailable');}});
 const incoming=event('unknown-name','alice','dm',false,'private');delete incoming.message.author.displayName;await failed.receive(incoming);await failed.drain();
 assert.ok(failed.models[0].messages.some(m=>m.content==='[说话人=当前用户]请帮我处理 unknown-name'));
 let enter,release;const reached=new Promise(r=>enter=r),blocked=new Promise(r=>release=r);
 t.after(()=>release());const race=await fixture(t,{describeActor:async()=>{enter();await blocked;return{displayName:'张三'};}});await race.receive(event('metadata-race'));
 const ticking=race.loop.tick();await reached;race.denied.add('alice');release();await ticking;await race.drain();assert.equal(race.models.length,1);assert.deepEqual(race.sent.map(r=>r.text),['回答完成']);
});
test('private and group mentions reach builtin and replies; ordinary messages and duplicate provider events do not invoke twice',async t=>{
 const f=await fixture(t);assert.equal((await f.receive(event('ignored','alice','g',false))).kind,'ignored');assert.equal(f.models.length,0);
 await f.receive(event('private','alice','dm',false,'private'));await f.drain();assert.equal(f.sent.length,1);assert.equal(f.sent[0].conversation.conversationKind,'private');
 const first=event('group','alice','g');assert.equal((await f.receive(first)).status,'created');assert.equal((await f.receive({...first,eventId:'different-envelope-event'})).status,'duplicate');await f.drain();assert.equal(f.models.length,2);assert.equal(f.sent.length,2);assert.equal(f.sent[1].replyToMessageId,'group');assert.equal(f.store.one('SELECT count(*) n FROM users').n,1);
});
test('same group shares history but each turn and created task keep actual actor; other groups/private/Web stay separate',async t=>{
 const f=await fixture(t,{model:async(input)=>({...(input.messages.at(-1).role==='tool'?{text:'已受理'}:{toolCalls:[{id:'create',name:'task_create',arguments:{input:'业务任务'}}]}),usage:{inputTokens:3,outputTokens:3}})});
 await f.receive(event('a','alice','g'));await f.drain();await f.receive(event('b','bob','g'));await f.drain();
 assert.equal(f.store.one('SELECT count(*) n FROM conversations').n,1);assert.equal(f.store.one('SELECT count(*) n FROM tasks').n,2);
 const rows=f.store.all('SELECT * FROM tasks ORDER BY rowid');assert.equal(JSON.parse(rows[0].source_json).principal.externalUserId,'alice');assert.equal(JSON.parse(rows[1].source_json).principal.externalUserId,'bob');
 assert.ok(f.models.some(m=>m.messages.some(x=>x.role==='user'&&x.content.includes('说话人=成员1'))&&m.messages.some(x=>x.role==='user'&&x.content.includes('说话人=成员2'))));
 const bob=channelInvocationScope(f.binding,event('b','bob','g'));assert.throws(()=>f.tasks.task({...bob,conversationId:rows[0].conversation_id},rows[0].id),/task_not_found/);
 const web={workspaceId:'w',entityId:'e',userId:'manager'};assert.deepEqual(f.interaction.list(web).conversations,[]);await assert.rejects(f.interaction.messages(web,rows[0].conversation_id),/conversation_not_found/);
 await f.receive(event('c','alice','g2'));await f.drain();await f.receive(event('d','alice','dm',false,'private'));await f.drain();assert.equal(f.store.one('SELECT count(*) n FROM conversations').n,3);
});
test('legacy static meetingRefs no longer fetch or inject body and no group history backfill is performed',async t=>{
 const f=await fixture(t,{history:true,meeting:true});let materialReads=0;f.binding.meetingArtifacts=new FeishuMinutesAdapter(f.binding.connection,{appId:'app',grants:{transcriptRead:true,officialSummaryRead:true},resolveCredential:async()=>{materialReads++;throw Error('implicit material credentials must not be read');},fetch:async()=>{materialReads++;throw Error('implicit material HTTP must not run');}});await f.receive(event('new'));await f.drain();assert.equal(f.queries.length,0);assert.equal(materialReads,0);assert.equal(f.store.one('SELECT count(*) n FROM interaction_turns').n,1);const input=f.models[0].messages.map(m=>m.content).join('\n');assert.doesNotMatch(input,/会议决定：保留关键约束|已明确共享的会后|请帮我处理 old/);
});
test('usage revocation after admission does not revoke the queued input while binding replacement still prevents model and output',async t=>{
 const f=await fixture(t);await f.receive(event('admitted-before-change'));f.denied.add('alice');await f.drain();assert.equal(f.models.length,1);assert.deepEqual(f.sent.map(r=>r.text),['回答完成']);
 const second=await fixture(t);await second.receive(event('replace'));second.setVersion('2');await second.drain();assert.equal(second.models.length,0);assert.equal(second.sent.length,0);assert.equal(second.store.one("SELECT count(*) n FROM channel_inbox WHERE status='failed'").n,1);
});
test('task progress and final result route to original channel; delivery unknown does not rerun task or blindly resend',async t=>{
 const f=await fixture(t,{model:async(input)=>({...(input.messages.at(-1).role==='tool'?{text:'已受理'}:{toolCalls:[{id:'create',name:'task_create',arguments:{input:'后台业务'}}]}),usage:{inputTokens:3,outputTokens:3}})});await f.receive(event('task','alice','g'));await f.drain();await f.tasks.tick();assert.equal(f.commands.length,1);
 const task=f.store.one('SELECT * FROM tasks');f.tasks.ingest(task.run_id,{runId:task.run_id,eventId:'progress',sequence:1,type:'progress',text:'完成第一阶段'});await f.loop.tick();assert.equal(f.sent.at(-1).text,'完成第一阶段');assert.equal(f.sent.at(-1).conversation.externalId,'g');
 f.setUnknown(true);f.tasks.ingest(task.run_id,{runId:task.run_id,eventId:'final',sequence:2,type:'final_result',text:'业务结果',inputRevision:1});await f.loop.tick();const n=f.sent.length;await f.drain();assert.equal(f.sent.length,n);assert.equal(f.commands.length,1);assert.equal(f.store.one("SELECT status FROM deliveries WHERE event_id='final'").status,'channel_unknown');
});
test('WeCom long-task result uses the authorized private recipient after callback capability expires',async t=>{
 const f=await fixture(t,{channel:'wecom',model:async input=>({...input.messages.at(-1).role==='tool'?{text:'已受理'}:{toolCalls:[{id:'create',name:'task_create',arguments:{input:'后台业务'}}]},usage:{inputTokens:3,outputTokens:3}})});
 const incoming=event('wecom-long-task','alice','alice',false,'private');incoming.message.conversation.provider='wecom';incoming.message.author.idNamespace='user_id';
 await f.receive(incoming);await f.drain();await f.tasks.tick();assert.equal(f.commands.length,1);
 assert.equal(f.sent[0].replyToMessageId,incoming.message.id);
 const inspect=f.binding.conversation.inspectCapabilities;
 f.binding.conversation.inspectCapabilities=async()=>({...await inspect(),replyToMessage:{supported:false,availability:'unsupported'}});
 const task=f.store.one('SELECT * FROM tasks');f.tasks.ingest(task.run_id,{runId:task.run_id,eventId:'final',sequence:1,type:'final_result',text:'业务结果',inputRevision:1});
 await f.loop.tick();await f.drain();
 const result=f.sent.find(r=>r.text==='业务结果');assert.ok(result);assert.equal(result.replyToMessageId,undefined);assert.equal(result.conversation.privateRecipientId,'alice');assert.equal(typeof result.originatingTaskScope,'function');assert.equal(f.sent[0].originatingTaskScope,undefined);assert.equal(f.commands.length,1);
});
test('durable inbox expired lease recovers; expired send lease becomes unknown, never resent',async t=>{
 const f=await fixture(t);await f.receive(event('persist'));const token='dead-worker';const row=f.repo.claimInbox(1800000000000,1800000000010,token);assert.ok(row);f.advance(20);await f.drain();assert.equal(f.sent.length,1);
 const scope=channelInvocationScope(f.binding,event('delivery'));
 f.repo.enqueueDelivery({id:'crashed-send',scopeJson:JSON.stringify(scope),targetJson:JSON.stringify({conversation:ref()}),text:'sensitive',status:'queued',taskDeliveryId:null,leaseToken:null},1800000000020);
 f.repo.claimDelivery(1800000000020,1800000000030,'sender-died');f.advance(30001);await f.drain();assert.equal(f.sent.length,1);assert.equal(f.store.one("SELECT status FROM channel_deliveries WHERE id='crashed-send'").status,'unknown');assert.doesNotMatch(JSON.stringify(f.repo.health('connection')),/sensitive|alice|请帮/);
});
test('pending credential verification blocks then resumes only the same logical binding',async t=>{
 const f=await fixture(t);await f.receive(event('rotation'));f.setAvailable(false);await f.drain();assert.equal(f.models.length,0);assert.equal(f.store.one('SELECT status FROM channel_inbox').status,'blocked');
 f.setAvailable(true);f.advance(31000);await f.drain();assert.equal(f.models.length,1);assert.equal(f.sent.length,1);
 const scope=channelInvocationScope(f.binding,event('later'));
 f.repo.enqueueDelivery({id:'queued-before-rotation',scopeJson:JSON.stringify(scope),targetJson:JSON.stringify({conversation:ref()}),text:'resume-safe',status:'queued',taskDeliveryId:null,leaseToken:null},1800000031000);
 f.setAvailable(false);await f.drain();assert.equal(f.sent.length,1);f.setAvailable(true);f.advance(31000);await f.drain();assert.equal(f.sent.length,2);
 f.repo.enqueueDelivery({id:'old-target',scopeJson:JSON.stringify(scope),targetJson:JSON.stringify({conversation:ref()}),text:'must-not-migrate',status:'queued',taskDeliveryId:null,leaseToken:null},1800000062000);f.setVersion('different-bot');await f.drain();assert.equal(f.sent.length,2);assert.equal(f.store.one("SELECT status FROM channel_deliveries WHERE id='old-target'").status,'failed');
});
test('normal queued input remains durable beyond the removed body TTL and resumes when its original connection returns',async t=>{
 const f=await fixture(t);await f.receive(event('long-wait'));f.setAvailable(false);await f.drain();assert.equal(f.models.length,0);f.advance(8*24*60*60*1000);assert.match(f.store.one('SELECT event_json FROM channel_inbox').event_json,/long-wait/);f.setAvailable(true);await f.drain();assert.equal(f.models.length,1);assert.equal(f.sent.length,1);assert.equal(f.store.one('SELECT status FROM channel_inbox').status,'committed');
});
test('unknown isolated input retains its fact but cannot permanently block a fresh input or replay itself',async t=>{
 const f=await fixture(t);await f.receive(event('uncertain'));const first=f.repo.claimInbox(1800000000000,1800000060000,'unknown-owner');f.repo.finishInbox(first.id,'unknown-owner','unknown','runtime_unknown');await f.receive(event('later-message'));await f.drain();assert.equal(f.models.length,1);assert.equal(f.sent.length,1);assert.ok(!JSON.stringify(f.models[0].messages).includes('请帮我处理 uncertain'));assert.equal(f.repo.health('connection').recovery.blockedConversationCount,0);assert.equal(f.repo.health('connection').recovery.unknownConversationCount,1);f.advance(8*24*60*60*1000);await f.drain();assert.equal(f.models.length,1);assert.equal(f.store.one('SELECT status FROM channel_inbox WHERE id=?',first.id).status,'unknown');
});

test('shared group todo tools keep original actor and logical session across list/start/cancel',async t=>{
 let command={name:'task_create_todo',arguments:{input:'Alice deferred work'}},results=[];
 const f=await fixture(t,{model:async input=>{if(input.messages.at(-1).role==='tool'){results.push(JSON.parse(input.messages.at(-1).content));return{text:'平台回执已记录',usage:{inputTokens:3,outputTokens:3}};}return{toolCalls:[{id:'task-tool',name:command.name,arguments:command.arguments}],usage:{inputTokens:3,outputTokens:3}};}});
 await f.receive(event('todo-alice','alice','g'));await f.drain();const todo=f.store.one('SELECT * FROM tasks');assert.equal(todo.status,'planned');assert.equal(todo.run_id,null);assert.equal(f.store.one('SELECT count(*) n FROM runs').n,0);
 command={name:'task_list',arguments:{status:'planned'}};await f.receive(event('list-bob','bob','g'));await f.drain();assert.deepEqual(results.at(-1).tasks,[]);
 command={name:'task_cancel_todo',arguments:{taskId:todo.id,expectedVersion:1}};await f.receive(event('cancel-bob','bob','g'));await f.drain();assert.equal(f.store.one('SELECT status FROM tasks').status,'planned');assert.equal(f.store.one('SELECT count(*) n FROM task_operations').n,0);
 command={name:'task_start',arguments:{taskId:todo.id,expectedVersion:1}};await f.receive(event('start-other-group','alice','g2'));await f.drain();assert.equal(f.store.one('SELECT status FROM tasks').status,'planned');
 await f.receive(event('start-alice','alice','g'));await f.drain();const current=f.store.one('SELECT * FROM tasks');assert.equal(current.id,todo.id);assert.equal(current.status,'queued');assert.equal(JSON.parse(current.source_json).principal.externalUserId,'alice');assert.equal(JSON.parse(current.source_json).source.replyToMessageId,'todo-alice');
 await f.tasks.tick();assert.equal(f.commands.length,1);assert.equal(f.commands[0].requester.externalUserId,'alice');
});

for(const memory of [false,true])test(`permission quick reply is fixed, deduplicated and never invokes model/tools (memory=${memory})`,async t=>{
 const f=await fixture(t,{memory});f.denied.add('alice');const e=event('quick-denied');
 await f.receive(e);await f.receive(e);await f.drain();
 assert.deepEqual(f.sent.map(r=>r.text),['抱歉，您没有使用权限，请联系管理员']);assert.equal(f.sent[0].conversation.externalId,'group');assert.equal(f.sent[0].replyToMessageId,e.message.id);
 assert.equal(f.models.length,0);assert.equal(f.commands.length,0);assert.equal(f.store.one('SELECT count(*) n FROM interaction_turns').n,0);
});
// Existing local fixture and synthetic provider transport only: no channel network calls.
for(const memory of [false,true])for(const conversationKind of ['group','private'])for(const replyKind of ['identity','permission','service'])test(`DingTalk ${conversationKind} ${replyKind} quick reply uses unchanged OpenAPI target once (memory=${memory})`,async t=>{
 const f=await fixture(t,{channel:'dingtalk',memory,unconfigured:replyKind==='service'}),posts=[],requests=[];
 const incoming=event('dingtalk-'+replyKind,'alice',conversationKind==='group'?'original-group':'original-dm',conversationKind==='group',conversationKind);
 incoming.message.conversation.provider='dingtalk';incoming.message.author.idNamespace='user_id';
 if(replyKind==='identity')incoming.message.author.identityEvidence='unknown';
 f.binding.policy.entityMentionId='fixture-robot';f.binding.policy.ownSenderIds=[];incoming.message.mentions=conversationKind==='group'?['fixture-robot']:[];
 if(replyKind==='permission')f.denied.add('alice');
 const adapter=new DingTalkBotConversationAdapter(f.binding.connection,{appId:'app',robotCode:'fixture-robot',streamIngress:true,mentionEventsGranted:true,privateMessageEventsGranted:true,proactiveSendGranted:true,resolveCredential:async()=> 'SYNTHETIC_CHANNEL_TOKEN',fetch:async(url,init={})=>{
  assert.equal(init.method,'POST');assert.equal(new URL(url).pathname,conversationKind==='group'?'/v1.0/robot/groupMessages/send':'/v1.0/robot/oToMessages/batchSend');
  posts.push(JSON.parse(init.body));return Response.json({processQueryKey:'synthetic-request'});
 }});
 const send=adapter.sendMessage.bind(adapter);adapter.sendMessage=async request=>{requests.push(request);return send(request);};f.binding.conversation=adapter;
 const receive=async()=>{if(replyKind==='identity')await f.loop.rejectAuthenticatedEvent({workspaceId:'w',entityId:'e',connectionId:'connection',bindingVersion:'1',appId:'app',conversation:incoming.message.conversation,messageId:incoming.message.id,eventId:incoming.eventId},'identity');else await f.receive(incoming);};
 await receive();await f.drain();
 incoming.eventId='replayed-envelope';await receive();await f.drain();
 assert.equal(posts.length,1);assert.equal(requests.length,1);
 assert.deepEqual(requests[0].conversation,incoming.message.conversation);assert.equal(requests[0].replyToMessageId,undefined);assert.equal(requests[0].threadId,undefined);
 assert.equal(JSON.parse(posts[0].msgParam).content,{identity:'抱歉，无法验证身份',permission:'抱歉，您没有使用权限，请联系管理员',service:'抱歉，我暂时无法提供服务'}[replyKind]);
 assert.equal(posts[0].robotCode,'fixture-robot');assert.equal(posts[0].openConversationId,conversationKind==='group'?'original-group':undefined);assert.deepEqual(posts[0].userIds,conversationKind==='private'?['alice']:undefined);
 assert.equal(f.models.length,0);assert.equal(f.commands.length,0);
 const receipt=f.store.one("SELECT status,provider_request_id FROM channel_message_receipts WHERE kind='outbox'");assert.equal(receipt.status,'unknown');assert.equal(receipt.provider_request_id,'synthetic-request');
});
for(const channel of ['dingtalk','feishu'])for(const conversationKind of ['group','private'])test(`${channel} quick reply never drops a real ${conversationKind} thread when quoting is unavailable`,async t=>{
 const f=await fixture(t,{channel,memory:true}),incoming=event('thread-quick','alice','unchanged-target',true,conversationKind);incoming.message.conversation.provider=channel;
 const inspect=f.binding.conversation.inspectCapabilities;f.binding.conversation.inspectCapabilities=async()=>({...await inspect(),replyToMessage:{supported:false,availability:'unsupported'}});
 await f.loop.rejectAuthenticatedEvent({workspaceId:'w',entityId:'e',connectionId:'connection',bindingVersion:'1',appId:'app',conversation:incoming.message.conversation,messageId:incoming.message.id,eventId:incoming.eventId,threadId:'real-thread'},'service');await f.drain();
 assert.equal(f.sent.length,0);assert.equal(f.store.one("SELECT status FROM channel_message_receipts WHERE kind='outbox'").status,'failed');
});
for(const revoked of ['send-capability','binding-version','connection'])test(`DingTalk quick reply honors ${revoked} revocation before dispatch`,async t=>{
 const f=await fixture(t,{channel:'dingtalk'}),incoming=event('revoked-quick');incoming.message.conversation.provider='dingtalk';
 const inspect=f.binding.conversation.inspectCapabilities;f.binding.conversation.inspectCapabilities=async()=>({...await inspect(),replyToMessage:{supported:false,availability:'unsupported'},proactiveSend:{supported:true,availability:revoked==='send-capability'?'authorization_required':'available'}});
 await f.loop.rejectAuthenticatedEvent({workspaceId:'w',entityId:'e',connectionId:'connection',bindingVersion:'1',appId:'app',conversation:incoming.message.conversation,messageId:incoming.message.id,eventId:incoming.eventId},'permission');
 if(revoked==='binding-version')f.setVersion('2');if(revoked==='connection')f.setAvailable(false);await f.drain();
 assert.equal(f.sent.length,0);assert.equal(f.store.one("SELECT status FROM channel_message_receipts WHERE kind='outbox'").status,'failed');
});
test('DingTalk binding replacement during credential resolution fences quick reply before provider POST',async t=>{
 const f=await fixture(t,{channel:'dingtalk',memory:true});let posts=0;
 f.binding.conversation=new DingTalkBotConversationAdapter(f.binding.connection,{appId:'app',robotCode:'fixture-robot',proactiveSendGranted:true,resolveCredential:async()=>{f.setVersion('2');return 'SYNTHETIC_CHANNEL_TOKEN';},fetch:async()=>{posts++;return Response.json({processQueryKey:'must-not-send'});}});
 const incoming=event('credential-fence');incoming.message.conversation.provider='dingtalk';
 await f.loop.rejectAuthenticatedEvent({workspaceId:'w',entityId:'e',connectionId:'connection',bindingVersion:'1',appId:'app',conversation:incoming.message.conversation,messageId:incoming.message.id,eventId:incoming.eventId},'identity');await f.drain();
 assert.equal(posts,0);assert.equal(f.store.one("SELECT status FROM channel_message_receipts WHERE kind='outbox'").status,'failed');
});
test('Feishu other robots, own, unmentioned and historical messages remain silent',async t=>{
 const f=await fixture(t,{memory:true});const bot=event('other-robot','other-bot');bot.message.author.kind='bot';
 await f.receive(bot);await f.receive(bot);await f.drain();assert.deepEqual(f.sent.map(r=>r.text),[]);assert.equal(f.models.length,0);
 for(const e of [event('self','bot'),event('unmentioned','other-bot','group',false),{...event('history','other-bot'),origin:'history'}]){e.message.author.kind='bot';assert.equal((await f.receive(e)).kind,'ignored');}
 await f.drain();assert.equal(f.sent.length,0);
});
test('model failure produces service quick reply with generation failure and final text logs',async t=>{
 const {log,rows}=await diagnosticFixture(t);const f=await fixture(t,{memory:true,diagnostics:log,model:async()=>{throw new DiagnosticError({category:'parameters',httpStatus:422,providerCode:'mock_rule_not_matched'});}});
 await f.receive(event('quick-model'));await f.drain();assert.deepEqual(f.sent.map(r=>r.text),['抱歉，我暂时无法提供服务']);assert.equal(f.models.length,1);
 const logs=await rows();assert.ok(logs.some(r=>r.stage==='reply.generated'&&r.status==='failed'&&r.providerCode==='mock_rule_not_matched'));assert.equal(logs.filter(r=>r.stage==='reply.generated'&&r.text==='抱歉，我暂时无法提供服务').length,1);assert.ok(logs.some(r=>r.stage==='outbox.send'&&r.status==='sent'&&r.text==='抱歉，我暂时无法提供服务'));
});
test('reply persistence failure retains generated diagnostic evidence but never sends unpersisted text',async t=>{
 const {log,rows}=await diagnosticFixture(t);const f=await fixture(t,{memory:true,diagnostics:log});
 f.store.db.exec("CREATE TRIGGER fail_assistant BEFORE INSERT ON conversation_message_index WHEN NEW.role='assistant' BEGIN SELECT RAISE(ABORT,'fixture_reply_storage_failure'); END");
 await f.receive(event('quick-storage'));await f.drain();assert.deepEqual(f.sent.map(r=>r.text),[]);assert.equal(f.models.length,1);
 const logs=await rows();assert.ok(logs.some(r=>r.stage==='reply.generated'&&r.text==='回答完成'));assert.ok(!logs.some(r=>r.stage==='outbox.send'&&r.text==='回答完成'));assert.equal(f.store.one("SELECT count(*) n FROM conversation_message_index WHERE role='assistant'").n,0);
});
test('conversation preparation failure replies without invoking model',async t=>{
 const f=await fixture(t,{memory:true,unconfigured:true});
 await f.receive(event('quick-config'));await f.drain();assert.deepEqual(f.sent.map(r=>r.text),['抱歉，我暂时无法提供服务']);assert.equal(f.models.length,0);
});
for(const unknown of [false,true])test(`quick reply send failure/unknown is logged once and does not recurse (unknown=${unknown})`,async t=>{
 const {log,rows}=await diagnosticFixture(t);const f=await fixture(t,{memory:true,diagnostics:log});f.denied.add('alice');let attempts=0;
 f.binding.conversation.sendMessage=async()=>{attempts++;if(unknown)return{status:'unknown',idempotent:false};throw new ChannelError('forbidden','fixture_send_denied');};
 await f.receive(event('quick-send'));await f.drain();await f.receive(event('quick-send'));await f.drain();assert.equal(attempts,1);assert.equal(f.models.length,0);
 const logs=await rows();assert.ok(logs.some(r=>r.stage==='outbox.send'&&r.status===(unknown?'unknown':'failed')&&r.text==='抱歉，您没有使用权限，请联系管理员'&&r.reason===(unknown?'delivery_unknown':'send_failed')));assert.equal(logs.filter(r=>r.stage==='reply.generated').length,1);
});
test('quick reply validates fixed text and current connection before every send',async t=>{
 const f=await fixture(t);const e=event('quick-fenced');const route={workspaceId:'w',entityId:'e',connectionId:'connection',bindingVersion:'1',appId:'app',conversation:e.message.conversation,messageId:e.message.id,eventId:e.eventId};
 await f.loop.rejectAuthenticatedEvent(route,'identity');f.setVersion('2');await f.drain();assert.equal(f.sent.length,0);
 f.setVersion('1');await f.loop.rejectAuthenticatedEvent({...route,messageId:'tamper'},'identity');f.store.run("UPDATE channel_deliveries SET text='must never bypass usage checks' WHERE status IN ('queued','pending')");await f.drain();assert.equal(f.sent.length,0);assert.equal(f.models.length,0);
});

for(const kind of ['identity','permission','service'])test(`fixed ${kind} reply crosses the actual Feishu adapter with original target and stable UUID`,async t=>{
 const f=await fixture(t,{memory:true}),posts=[],e=event('adapter-'+kind);
 f.binding.conversation=new FeishuConversationAdapter(f.binding.connection,{appId:'app',grants:{mentionEvents:true,privateMessageEvents:true,replyToMessage:true,proactiveSend:true},resolveCredential:async()=> 'SYNTHETIC_CHANNEL_TOKEN',fetch:async(url,init={})=>{
  const path=new URL(url).pathname;
  if(init.method==='POST'){assert.equal(path,`/open-apis/im/v1/messages/${e.message.id}/reply`);const body=JSON.parse(init.body);posts.push(body);return Response.json({code:0,data:{message_id:'synthetic-provider-reply'}});}
  assert.equal(path,`/open-apis/im/v1/messages/${e.message.id}`);return Response.json({code:0,data:{items:[{chat_id:'group'}]}});
 }});
 const route={workspaceId:'w',entityId:'e',connectionId:'connection',bindingVersion:'1',appId:'app',conversation:e.message.conversation,messageId:e.message.id,eventId:e.eventId};
 await f.loop.rejectAuthenticatedEvent(route,kind);await f.loop.rejectAuthenticatedEvent(route,kind);await f.drain();assert.equal(posts.length,1);assert.ok(posts[0].uuid.length<=50);assert.equal(JSON.parse(posts[0].content).text,{identity:'抱歉，无法验证身份',permission:'抱歉，您没有使用权限，请联系管理员',service:'抱歉，我暂时无法提供服务'}[kind]);assert.equal(f.models.length,0);assert.equal(f.store.one("SELECT status FROM channel_message_receipts WHERE kind='outbox'").status,'sent');
});
test('connection replacement during actual Feishu reply-target read prevents quick reply POST',async t=>{
 const f=await fixture(t,{memory:true});let entered,release,posts=0;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);t.after(()=>release());
 f.binding.conversation=new FeishuConversationAdapter(f.binding.connection,{appId:'app',grants:{replyToMessage:true,proactiveSend:true},resolveCredential:async()=> 'SYNTHETIC_CHANNEL_TOKEN',fetch:async(_url,init={})=>{if(init.method==='POST'){posts++;return Response.json({code:0,data:{message_id:'must-not-send'}});}entered();await gate;return Response.json({code:0,data:{items:[{chat_id:'group'}]}});}});
 const e=event('fenced-target');await f.loop.rejectAuthenticatedEvent({workspaceId:'w',entityId:'e',connectionId:'connection',bindingVersion:'1',appId:'app',conversation:e.message.conversation,messageId:e.message.id,eventId:e.eventId},'permission');
 const ticking=f.loop.tick();await started;f.setVersion('2');release();await ticking;await f.drain();assert.equal(posts,0);assert.equal(f.store.one("SELECT status FROM channel_message_receipts WHERE kind='outbox'").status,'failed');
});

test('corrupt outbound scope logs the original reply and failure without recursive fallback',async t=>{
 const {log,rows}=await diagnosticFixture(t),f=await fixture(t,{diagnostics:log}),e=event('corrupt');const scope=channelInvocationScope(f.binding,e);
 f.repo.enqueueDelivery({id:'f'.repeat(64),scopeJson:JSON.stringify(scope),targetJson:JSON.stringify({conversation:e.message.conversation}),text:'synthetic unsent reply',status:'queued',taskDeliveryId:null,leaseToken:null},1800000000000);f.store.run("UPDATE channel_deliveries SET scope_json='{' WHERE id=?",'f'.repeat(64));await f.drain();assert.equal(f.sent.length,0);assert.equal(f.store.one('SELECT count(*) n FROM channel_deliveries').n,1);assert.equal(f.store.one('SELECT status FROM channel_deliveries').status,'failed');assert.ok((await rows()).some(r=>r.stage==='outbox.send'&&r.status==='failed'&&r.reason==='platform_failure'&&r.text==='synthetic unsent reply'));
});

test('group named-mention input reaches the actual local rule model as greeting while original text and actor stay intact',async t=>{
 const server=createRuleModelServer();server.listen({host:'127.0.0.1',port:0});await once(server,'listening');t.after(()=>closeRuleModelServer(server));const origin=`http://127.0.0.1:${server.address().port}`;
 const client=new OpenAICompatibleModelClient({endpoint:origin+'/v1',model:'mock',secretRef:'fixture',allowLoopbackHttp:true},async()=>DEFAULT_TOKEN);
 const f=await fixture(t,{memory:true,model:input=>client.complete(input),describeActor:async()=>({displayName:'张三',departmentNames:['研发部']})}),e=event('named-group-greeting');e.message.text='@_user_1 @_user_2 你好';e.message.mentionDetails=[{key:'@_user_1',id:'bot',name:'机器人A'},{key:'@_user_2',id:'another-bot',name:'机器人B'}];
 await f.receive(e);await f.receive({...e,eventId:'duplicate-envelope'});await f.drain();assert.equal(f.models.length,1);assert.deepEqual(f.sent.map(r=>r.text),['你好。我可以帮你做什么']);assert.ok(f.models[0].messages.some(m=>m.content==='[说话人=张三][部门=研发部][被@人=机器人A,机器人B]你好'));assert.equal(e.message.text,'@_user_1 @_user_2 你好');assert.deepEqual(e.message.mentions,['bot']);const turn=f.store.one('SELECT scope_json FROM interaction_turns');assert.equal(JSON.parse(turn.scope_json).principal.externalUserId,'alice');assert.equal(f.store.one('SELECT count(*) n FROM tasks').n,0);
});

test('live Feishu ordinary texts are collected without model/task/send; next @ submits one unified input with local speakers',async t=>{
 const f=await fixture(t,{memory:true,groupLive:true,describeActor:async(_b,a)=>({displayName:a.externalId==='alice'?'Alice':'Bob'})});
 const ordinary=event('live-before','alice','live-group',false);ordinary.message.text='context-marker-before';await f.receive(ordinary);await f.drain();assert.equal(f.models.length,0);assert.equal(f.commands.length,0);assert.equal(f.sent.length,0);
 const at=event('live-at','bob','live-group');at.message.text='current-marker-at';await f.receive(at);await f.drain();assert.equal(f.models.length,1);const text=JSON.stringify(f.models[0].messages);assert.match(text,/context-marker-before/);assert.match(text,/current-marker-at/);assert.equal((text.match(/context-marker-before/g)??[]).length,1);assert.match(text,/说话人=Alice/);assert.match(text,/说话人=Bob/);assert.equal(f.queries.length,0);assert.equal(f.store.one("SELECT count(*) n FROM group_live_messages WHERE status='committed'").n,2);
});
test('near simultaneous @ waits for full prior generation and never duplicates or consumes next trigger',async t=>{
 let release,entered;const started=new Promise(r=>entered=r),hold=new Promise(r=>release=r);t.after(()=>release());
 const f=await fixture(t,{memory:true,groupLive:true,model:async(_input,n)=>{if(n===1){entered();await hold;}return{text:'done',usage:{inputTokens:3,outputTokens:3}};}});
 const ordinary=event('serial-before','alice','serial-group',false);ordinary.message.text='serial-context';await f.receive(ordinary);
 const one=event('serial-one','alice','serial-group');one.message.text='first-at-marker';await f.receive(one);await started;
 const two=event('serial-two','bob','serial-group');two.message.text='second-at-marker';await f.receive(two);await f.drain();assert.equal(f.models.length,1);assert.equal(JSON.stringify(f.models[0].messages).includes('second-at-marker'),false);release();for(let i=0;i<12&&f.models.length<2;i++)await f.drain();assert.equal(f.models.length,2);const text=JSON.stringify(f.models[1].messages);assert.equal((text.match(/serial-context/g)??[]).length,1);assert.equal((text.match(/first-at-marker/g)??[]).length,1);assert.equal((text.match(/second-at-marker/g)??[]).length,1);assert.equal(f.queries.length,0);
});

test('live group main timeline and real thread_id retain independent builtin history',async t=>{const f=await fixture(t,{memory:true,groupLive:true});const root=event('root-context','alice','topic-group',false);root.message.text='ROOT-ONLY';const topic=event('topic-context','bob','topic-group',false);topic.message.threadId='real-thread';topic.message.text='TOPIC-ONLY';await f.receive(root);await f.receive(topic);const at=event('topic-at','alice','topic-group');at.message.threadId='real-thread';await f.receive(at);await f.drain();assert.equal(f.models.length,1);assert.match(JSON.stringify(f.models[0].messages),/TOPIC-ONLY/);assert.equal(JSON.stringify(f.models[0].messages).includes('ROOT-ONLY'),false);await f.receive(event('root-at','bob','topic-group'));await f.drain();assert.equal(f.models.length,2);assert.match(JSON.stringify(f.models[1].messages),/ROOT-ONLY/);assert.equal(JSON.stringify(f.models[1].messages).includes('TOPIC-ONLY'),false);assert.equal(f.store.one('SELECT count(*) n FROM conversations').n,2);assert.equal(f.queries.length,0);});

test('topic root background crosses formal builtin HTTP model, durable JSONL and exact Feishu reply route once',async t=>{
 const requests=[],posts=[],reads=[];const server=httpServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;requests.push(JSON.parse(raw));res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:'topic reply'}}],usage:{prompt_tokens:3,completion_tokens:3}}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const origin=`http://127.0.0.1:${server.address().port}`,client=new OpenAICompatibleModelClient({endpoint:origin+'/v1',model:'mock',secretRef:'synthetic',allowLoopbackHttp:true},async()=> 'synthetic');
 const f=await fixture(t,{memory:true,groupLive:true,model:input=>client.complete(input)});
 f.binding.conversation=new FeishuConversationAdapter(f.binding.connection,{appId:'app',grants:{mentionEvents:true,ordinaryMessageEvents:true,replyToMessage:true,proactiveSend:true},resolveCredential:async()=> 'synthetic',fetch:async(url,init={})=>{const path=new URL(url).pathname;if(init.method==='POST'){posts.push({path,body:JSON.parse(init.body)});return Response.json({code:0,data:{message_id:'sent-'+posts.length,chat_id:'topic',thread_id:'omt_real'}});}reads.push(path);assert.match(path,/^\/open-apis\/im\/v1\/messages\/topic-at-/);return Response.json({code:0,data:{items:[{chat_id:'topic',thread_id:'omt_real'}]}});}});
 const root=event('local-root','alice','topic',false);root.message.text='LOCAL-ROOT-MARKER';await f.receive(root);await f.drain();assert.equal(requests.length,0);
 for(const n of [1,2]){const at=event('topic-at-'+n,'bob','topic');at.message.threadId='omt_real';at.message.rootMessageId='local-root';at.message.text='CURRENT-TOPIC-'+n;await f.receive(at);await f.drain();}
 assert.equal(requests.length,2);for(const req of requests){const text=JSON.stringify(req.messages);assert.equal((text.match(/LOCAL-ROOT-MARKER/g)||[]).length,1);assert.match(text,/话题起始背景/);assert.doesNotMatch(text,/\[[^\]\n]+=\s*\]/);}assert.equal(posts.length,2);assert.ok(posts.every((p,i)=>p.path===`/open-apis/im/v1/messages/topic-at-${i+1}/reply`&&p.body.reply_in_thread===true&&!('receive_id'in p.body)));
 const session=JSON.parse(f.store.one("SELECT json FROM builtin_records WHERE key LIKE 'builtin:session:%'").json);const history=f.journal.readMany({workspaceId:'w',entityId:'e',conversationId:session.handle.scope.conversationId},session.messageRefs);assert.equal((JSON.stringify(history).match(/LOCAL-ROOT-MARKER/g)||[]).length,1);assert.equal(f.store.one("SELECT status FROM group_live_messages WHERE message_id='local-root'").status,'pending');assert.equal(f.store.one("SELECT count(*) n FROM channel_message_receipts WHERE kind='outbox' AND status='sent'").n,2);assert.equal(f.queries.length,0);assert.equal(reads.length,2);assert.equal(f.store.one('SELECT count(*) n FROM tasks').n,0);
});
test('thread target remains trusted through outbox and unavailable reply capability cannot fall back to proactive main send',async t=>{const f=await fixture(t,{memory:true,groupLive:true});f.binding.conversation.inspectCapabilities=async()=>({mentionEvents:yes,ordinaryMessageEvents:yes,proactiveSend:yes,replyToMessage:{supported:false,availability:'unsupported'}});const at=event('no-fallback','alice','topic');at.message.threadId='omt_target';await f.receive(at);await f.drain();assert.equal(f.models.length,1);assert.equal(f.sent.length,0);assert.equal(f.store.one("SELECT status FROM channel_message_receipts WHERE kind='outbox'").status,'failed');});

for(const memory of [false,true])test(`live collection and triggers share stable speaker numbers without empty labels (memory=${memory})`,async t=>{
 const f=await fixture(t,{memory,groupLive:true,describeActor:async()=>{throw Error('profile unavailable');}});
 const a=event('alias-a','alice','alias-group',false),b=event('alias-b','bob','alias-group',false);
 await Promise.all([f.receive(a),f.receive(b)]);await f.receive(a);await f.drain();
 assert.equal(f.store.one('SELECT count(*) n FROM conversations').n,0);
 assert.equal(f.store.one('SELECT count(*) n FROM group_live_messages').n,2);
 assert.equal(f.models.length,0);assert.equal(f.sent.length,0);assert.equal(f.commands.length,0);
 const cached=f.store.all('SELECT message_id,formatted FROM group_live_messages');
 const alice=cached.find(r=>r.message_id==='alias-a').formatted.match(/^\[说话人=(成员\d+)\]/)[1];
 const bob=cached.find(r=>r.message_id==='alias-b').formatted.match(/^\[说话人=(成员\d+)\]/)[1];assert.notEqual(alice,bob);
 await f.receive(event('alias-current','alice','alias-group'));await f.drain();
 const input=f.models[0].messages.filter(m=>m.role==='user').at(-1).content;
 assert.ok(input.includes(`[说话人=${alice}]请帮我处理 alias-a`));assert.ok(input.includes(`[说话人=${bob}]请帮我处理 alias-b`));
 assert.ok(input.endsWith(`[说话人=${alice}]请帮我处理 alias-current`));assert.doesNotMatch(input,/\[[^\]\n]+=\s*\]|未知成员/);
 const persisted=JSON.parse(f.store.one("SELECT json FROM builtin_records WHERE key LIKE 'builtin:session:%'").json);
 const history=f.journal.readMany({workspaceId:'w',entityId:'e',conversationId:persisted.handle.scope.conversationId},persisted.messageRefs);
 assert.ok(history.some(m=>m.role==='user'&&m.content===input));assert.equal(f.queries.length,0);
});

test('channel numbering adopts all old conversation aliases before allocating an ordinary speaker',async t=>{
 const f=await fixture(t,{memory:true,groupLive:true}),incoming=event('legacy-alias-at','alice','legacy-alias-group');
 const scope=channelInvocationScope(f.binding,incoming),hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
 const operationId='channel:'+hash([scope.workspaceId,scope.entityId,conversationOwnerKey(scope)]);
 const conversation=f.interaction.create(scope,{operationId}).conversation;
 const actorKey=user=>hash(['feishu','tenant','app','open_id',user,'human']);
 assert.equal(f.repo.speakerAlias(conversation.id,actorKey('bob')),'成员1');assert.equal(f.repo.speakerAlias(conversation.id,actorKey('alice')),'成员2');
 await f.receive(event('legacy-ordinary','charlie','legacy-alias-group',false));
 assert.match(f.store.one("SELECT formatted FROM group_live_messages WHERE message_id='legacy-ordinary'").formatted,/^\[说话人=成员3\]/);
 await f.receive(incoming);await f.drain();assert.ok(f.models[0].messages.some(m=>m.content.endsWith('[说话人=成员2]请帮我处理 legacy-alias-at')));
 assert.equal(f.repo.speakerAlias(scope,actorKey('bob')),'成员1');
 assert.equal(f.store.one('SELECT count(*) n FROM channel_speaker_aliases WHERE conversation_id=?',conversation.id).n,2);
 const other=event('other-topic','bob','legacy-alias-group',false);other.message.threadId='separate-topic';await f.receive(other);
 assert.match(f.store.one("SELECT formatted FROM group_live_messages WHERE message_id='other-topic'").formatted,/^\[说话人=成员1\]/);
});

test('normal WAIT during a slow complete model response has no five-second synthetic reply',async t=>{let enter,release;const started=new Promise(r=>enter=r),hold=new Promise(r=>release=r);t.after(()=>release());const f=await fixture(t,{memory:true,model:async()=>{enter();await hold;return{text:'Only complete response',usage:{inputTokens:1,outputTokens:1}};}});await f.receive(event('slow-wait','alice','dm',false,'private'));await started;f.advance(6000);await f.drain();assert.equal(f.sent.length,0);assert.equal(f.store.one('SELECT status FROM channel_inbox').status,'committed');release();for(let i=0;i<4&&!f.sent.length;i++)await f.drain();assert.deepEqual(f.sent.map(r=>r.text),['Only complete response']);});

test('incomplete model JSON never becomes a visible reply or durable output fragment',async t=>{const {log,rows}=await diagnosticFixture(t);const partial='SYNTHETIC_PARTIAL_DO_NOT_SEND';const client=new OpenAICompatibleModelClient({endpoint:'https://example.invalid/v1',model:'fixture',secretRef:'synthetic'},async()=> 'synthetic',async()=>new Response('{"choices":[{"message":{"content":"'+partial),log);const f=await fixture(t,{memory:true,diagnostics:log,model:input=>client.complete(input)});await f.receive(event('parse-failure','alice','dm',false,'private'));await f.drain();assert.equal(f.models.length,1);assert.ok(f.sent.every(r=>!r.text.includes(partial)));assert.equal(f.store.one('SELECT count(*) n FROM channel_deliveries WHERE text LIKE ?',`%${partial}%`).n,0);assert.equal(f.store.one("SELECT count(*) n FROM conversation_message_index WHERE role='assistant'").n,0);assert.ok((await rows()).some(r=>r.stage==='model.http'&&r.category==='parse'));});
test('normal tool-round content is delivered; final acceptance follows the actual receipt once',async t=>{let enter,release;const entered=new Promise(r=>enter=r),hold=new Promise(r=>release=r);t.after(()=>release());const f=await fixture(t,{memory:true,model:async(input,n)=>n===1?{text:'已准备处理，但工具尚未完成',toolCalls:[{id:'create',name:'task_create',arguments:{input:'本地隔离工作'}}],usage:{inputTokens:1,outputTokens:1}}:{text:'工具已受理',usage:{inputTokens:1,outputTokens:1}}});const create=f.tasks.create.bind(f.tasks);f.tasks.create=async(...args)=>{enter();await hold;return create(...args);};await f.receive(event('response-before-tool','alice','dm',false,'private'));await entered;for(let i=0;i<4&&!f.sent.length;i++)await f.drain();assert.deepEqual(f.sent.map(r=>r.text),['已准备处理，但工具尚未完成']);assert.equal(f.sent.filter(r=>r.text==='工具已受理').length,0);assert.equal(f.store.one('SELECT count(*) n FROM tasks').n,0);release();for(let i=0;i<5&&f.models.length<2;i++)await f.drain();await f.drain();assert.equal(f.models.length,2);assert.equal(f.sent.filter(r=>r.text==='已准备处理，但工具尚未完成').length,1);assert.ok(f.models[1].messages.some(m=>m.role==='assistant'&&m.content==='已准备处理，但工具尚未完成'&&m.toolCalls?.length===1),'Real tool-call history remains intact');assert.equal(f.sent.filter(r=>r.text==='工具已受理').length,1);assert.equal(f.store.one('SELECT count(*) n FROM tasks').n,1);});

test('ordinary group background needs no usage grant while denied live @ gets a fixed reply without normal inbox admission',async t=>{const f=await fixture(t,{memory:true,groupLive:true});f.denied.add('alice');const ordinary=event('ordinary-ungranted','alice','group',false);ordinary.message.text='UNGRANTED-SHARED-BACKGROUND';await f.receive(ordinary);await f.drain();assert.equal(f.models.length,0);assert.equal(f.store.one('SELECT count(*) n FROM channel_inbox').n,0);const denied=event('denied-at','alice','group');await f.receive(denied);await f.drain();assert.equal(f.models.length,0);assert.equal(f.store.one('SELECT count(*) n FROM channel_inbox').n,0);assert.deepEqual(f.sent.map(r=>r.text),['抱歉，您没有使用权限，请联系管理员']);await f.receive(event('authorized-at','bob','group'));await f.drain();assert.equal(f.models.length,1);assert.match(JSON.stringify(f.models[0].messages),/UNGRANTED-SHARED-BACKGROUND/);});


test('a configured private confirmer may answer without general employee use, but cannot delegate another task in the same answer turn',async t=>{
 const model=input=>{const last=input.messages.at(-1),toolName=last.role==='tool'?input.messages.flatMap(m=>m.toolCalls??[]).find(c=>c.id===last.toolCallId)?.name:undefined;if(last.role!=='tool')return{toolCalls:[{id:'h-list',name:'human_list',arguments:{}}]};if(toolName==='human_list'){const data=JSON.parse(last.content),r=data.requests[0];return{toolCalls:[{id:'h-answer',name:'human_propose_response',arguments:{requestId:r.requestId,contentVersion:r.contentVersion,questionDigest:r.questionDigest,decision:'approve',answers:[{questionId:'answer',value:'approve current local scope'}],evidenceMessageIds:[data.currentMessage.id]}}]};}if(toolName==='human_propose_response')return{toolCalls:[{id:'forbidden-new-task',name:'task_create',arguments:{input:'Must not grant employee use from confirmation'}}]};return{text:'已记录确认。'};};
 const f=await fixture(t,{humanEnabled:true,model:input=>({...model(input),usage:{inputTokens:5,outputTokens:5}})});f.denied.add('alice');const web={workspaceId:'w',entityId:'e',userId:'manager'};f.conversations.create('human-source',web,'human-source',1800000000000,'real',0);const context={...web,conversationId:'human-source'},todo=f.tasks.createTodo(context,{operationId:'human-source-task',input:'Local QA question'}),started=await f.tasks.startTodo(context,todo.id,{operationId:'human-start',expectedVersion:1});const row=f.store.one('SELECT * FROM tasks WHERE id=?',todo.id),q={questionScope:'qa',background:'Local test',goal:'Local result',knownFacts:[],questions:[{id:'answer',text:'Approve?',required:true,answerType:'text'}],completionCriteria:['Explicit approval'],proposedAction:'Local output only',impactScope:'Private fixture',ifNotConfirmed:'wait'},requestId='a8718d2d-aee5-4f35-a159-31b3fe3343d1';f.human.onEvent(row,{eventId:'safe',runId:started.run.id,sequence:1,type:'human_safe',human:{requestId,contentVersion:1,question:q,questionDigest:createHash('sha256').update(JSON.stringify(q)).digest('hex'),taskId:row.id,runId:started.run.id,sessionId:f.store.one('SELECT session_id FROM runs WHERE id=?',started.run.id).session_id,configurationId:'fixed',inputRevision:row.input_revision,safe:true,checkpointRef:'checkpoint'}});f.store.run("UPDATE human_requests SET target_json=?,notification_status='delivered' WHERE request_id=?",JSON.stringify({kind:'channel',connectionId:'connection',userId:'alice',identityNamespace:'open_id',provider:'feishu',appId:'app',tenantId:'tenant'}),requestId);
 const incoming=event('answer-human','alice','dm-alice',false,'private');incoming.message.text='同意 '+requestId;assert.equal((await f.receive(incoming)).kind,'accepted');await f.drain();assert.equal(f.store.one('SELECT count(*) n FROM tasks').n,1);assert.equal(f.store.one('SELECT count(*) n FROM runs').n,2);assert.equal(f.store.one('SELECT status FROM human_requests').status,'continued');assert.equal(f.commands.length,0);
 // An ordinary accepted message can wait in the inbox while a new question appears.
 // Its trusted admission time, not the later turn-start time, must fence approval.
 f.denied.delete('alice');const early=event('queued-old-approval','alice','dm-alice',false,'private');early.message.text='同意';await f.receive(early);f.advance(1000);const active=f.store.one('SELECT * FROM tasks WHERE id=?',todo.id),secondId='cf1b5823-5076-44d6-8a5c-d893e790e452';f.human.onEvent(active,{eventId:'safe-two',runId:active.run_id,sequence:1,type:'human_safe',human:{requestId:secondId,contentVersion:1,question:q,questionDigest:createHash('sha256').update(JSON.stringify(q)).digest('hex'),taskId:active.id,runId:active.run_id,sessionId:f.store.one('SELECT session_id FROM runs WHERE id=?',active.run_id).session_id,configurationId:'fixed',inputRevision:active.input_revision,safe:true,checkpointRef:'second-checkpoint'}});f.store.run("UPDATE human_requests SET target_json=?,notification_status='delivered' WHERE request_id=?",JSON.stringify({kind:'channel',connectionId:'connection',userId:'alice',identityNamespace:'open_id',provider:'feishu',appId:'app',tenantId:'tenant'}),secondId);f.denied.add('alice');await f.drain();assert.equal(f.store.one('SELECT response_digest FROM human_requests WHERE request_id=?',secondId).response_digest,null);assert.equal(f.store.one('SELECT count(*) n FROM runs').n,2);
 const outsider=event('wrong-human','bob','dm-bob',false,'private');f.denied.add('bob');assert.equal((await f.receive(outsider)).kind,'accepted');await f.drain();assert.equal(f.store.one('SELECT count(*) n FROM runs').n,2);
});


test('real private reply sequence rephrase then approve binds current inbox evidence and returns specific validation feedback',async t=>{
 let prior,latestReceipt;const model=input=>{const last=input.messages.at(-1),toolName=last.role==='tool'?input.messages.flatMap(m=>m.toolCalls??[]).find(c=>c.id===last.toolCallId)?.name:undefined;
  if(last.role!=='tool')return{toolCalls:[{id:'current-list',name:'human_list',arguments:{}}]};
  if(toolName==='human_list'){const data=JSON.parse(last.content),r=data.requests[0];if(!r)return{text:'没有待确认的问题。'};const isClarification=data.currentMessage.text.includes('重新梳理');if(isClarification)prior=data.currentMessage.id;
   return{toolCalls:[{id:'current-answer',name:'human_propose_response',arguments:{requestId:r.requestId,contentVersion:r.contentVersion+(data.currentMessage.text.includes('版本不匹配测试')?1:0),questionDigest:r.questionDigest,decision:isClarification?'needs_more':'approve',answers:isClarification?[]:[{questionId:'answer',value:'approved'}],evidenceMessageIds:[prior]}}]};}
  if(toolName==='human_propose_response'){latestReceipt=JSON.parse(last.content);return{text:latestReceipt.status==='not_recorded'?latestReceipt.message:latestReceipt.status==='needs_more'?'请明确确认当前问题。':'已记录当前确认。'};}return{text:'普通对话。'};};
 const f=await fixture(t,{humanEnabled:true,model:input=>({...model(input),usage:{inputTokens:5,outputTokens:5}})}),web={workspaceId:'w',entityId:'e',userId:'manager'};
 f.conversations.create('sequence-source',web,'sequence-source',1800000000000,'real',0);const context={...web,conversationId:'sequence-source'},todo=f.tasks.createTodo(context,{operationId:'sequence-task',input:'Local test'}),started=await f.tasks.startTodo(context,todo.id,{operationId:'sequence-start',expectedVersion:1}),row=f.store.one('SELECT * FROM tasks WHERE id=?',todo.id),q={questionScope:'qa',background:'Synthetic test',goal:'Local result',knownFacts:[],questions:[{id:'answer',text:'Approve?',required:true,answerType:'text'}],completionCriteria:['Explicit'],proposedAction:'Local output',impactScope:'Private test',ifNotConfirmed:'wait'},requestId='713ed851-0252-4b26-8f34-a68b9221b0cd';
 f.human.onEvent(row,{eventId:'sequence-safe',runId:started.run.id,sequence:1,type:'human_safe',human:{requestId,contentVersion:1,question:q,questionDigest:createHash('sha256').update(JSON.stringify(q)).digest('hex'),taskId:row.id,runId:started.run.id,sessionId:f.store.one('SELECT session_id FROM runs WHERE id=?',started.run.id).session_id,configurationId:'fixed',inputRevision:row.input_revision,safe:true,checkpointRef:'sequence-checkpoint'}});
 f.store.run("UPDATE human_requests SET target_json=?,notification_status='delivered' WHERE request_id=?",JSON.stringify({kind:'channel',connectionId:'connection',userId:'alice',identityNamespace:'open_id',provider:'feishu',appId:'app',tenantId:'tenant'}),requestId);
 const clarification=event('rephrase-current','alice','sequence-dm',false,'private');clarification.message.text='不确定，你重新梳理给我我再看看';await f.receive(clarification);await f.drain();assert.equal(latestReceipt.status,'needs_more');assert.equal(f.store.one('SELECT count(*) n FROM runs').n,1);
 const staleVersion=event('version-current','alice','sequence-dm',false,'private');staleVersion.message.text='版本不匹配测试';await f.receive(staleVersion);await f.drain();assert.equal(latestReceipt.status,'not_recorded');assert.equal(latestReceipt.reason,'human_question_changed');assert.ok(f.sent.some(x=>x.text===latestReceipt.message));assert.equal(f.store.one('SELECT count(*) n FROM runs').n,1);
 const approval=event('approve-current','alice','sequence-dm',false,'private');approval.message.text='批准';await f.receive(approval);await f.drain();assert.equal(latestReceipt.status,'continued');
 const current=f.store.one("SELECT turn_id FROM channel_inbox WHERE json_extract(event_json,'$.message.id')=?",'approve-current').turn_id,saved=f.store.one('SELECT candidate_json FROM human_response_messages WHERE message_id=?',current);assert.notEqual(current,prior);assert.deepEqual(JSON.parse(saved.candidate_json).evidenceMessageIds,[current]);assert.equal(f.store.one('SELECT count(*) n FROM runs').n,2);
 await f.receive(approval);await f.drain();assert.equal(f.store.one('SELECT count(*) n FROM runs').n,2);
 const ordinary=event('after-current','alice','sequence-dm',false,'private');ordinary.message.text='新的普通问题';await f.receive(ordinary);await f.drain();assert.equal(f.store.one('SELECT count(*) n FROM runs').n,2);assert.ok(f.sent.every(x=>!x.text.includes('暂时无法提供服务')));
});


async function notifyHumanFixture(f,suffix='one'){
 const source={workspaceId:'w',entityId:'e',userId:'manager'},conversationId='human-origin-'+suffix;f.conversations.create(conversationId,source,conversationId,1800000000000,'real',0);
 const context={...source,conversationId},todo=f.tasks.createTodo(context,{operationId:'origin-'+suffix,input:'Original synthetic confirmation task '+suffix}),started=await f.tasks.startTodo(context,todo.id,{operationId:'start-'+suffix,expectedVersion:1}),row=f.store.one('SELECT * FROM tasks WHERE id=?',todo.id),q={questionScope:'qa',background:'SYNTHETIC-HUMAN-'+suffix,goal:'Private local result',knownFacts:[],questions:[{id:'answer',text:'Allow only this private result?',required:true,answerType:'text'}],completionCriteria:['Explicit approval'],proposedAction:'Write private fixture output',impactScope:'Original local task only',ifNotConfirmed:'wait'},requestId=createHash('sha256').update(suffix).digest('hex').slice(0,8)+'-1500-4000-a000-123456789abc';
 f.store.run('INSERT INTO employee_human_rules VALUES(?,?,?,?) ON CONFLICT(workspace_id,entity_id) DO UPDATE SET rules_json=excluded.rules_json','w','e',1,JSON.stringify([{questionScope:'qa',target:{kind:'channel',connectionId:'connection',userId:'alice',identityNamespace:'open_id',provider:'feishu',appId:'app',tenantId:'tenant'}}]));
 const notices=new HumanChannelNotifications(f.store,{async resolveBinding(){return f.binding;}},f.repo,()=>1800000000000);f.human.setChannels(notices);
 f.human.onEvent(row,{eventId:'safe-'+suffix,runId:started.run.id,sequence:1,type:'human_safe',human:{requestId,contentVersion:1,question:q,questionDigest:createHash('sha256').update(JSON.stringify(q)).digest('hex'),taskId:row.id,runId:started.run.id,sessionId:f.store.one('SELECT session_id FROM runs WHERE id=?',started.run.id).session_id,configurationId:'fixed',inputRevision:row.input_revision,safe:true,checkpointRef:'checkpoint-'+suffix}});
 await f.human.tick();await f.drain();await f.human.tick();assert.equal(f.store.one('SELECT status FROM channel_message_receipts WHERE id=?','human-question:'+requestId).status,'sent');return{taskId:row.id,requestId};
}
function semanticHumanModel(input){
 const current=input.messages.findLast(m=>m.contextSource?.kind==='user_input')?.content??'',last=input.messages.at(-1),name=last.role==='tool'?input.messages.flatMap(m=>m.toolCalls??[]).find(c=>c.id===last.toolCallId)?.name:undefined;
 if(last.role!=='tool'){
  if(current.includes('NEW-ONLY'))return{toolCalls:[{id:'ordinary-create',name:'task_create',arguments:{input:'SEPARATE-NEW-DEMAND'}}]};
  if(current.includes('APPROVE')||current.includes('REJECT')||current.includes('UNCLEAR')||current.includes('MIXED'))return{toolCalls:[{id:'question-list',name:'human_list',arguments:{}}]};
  return{text:'普通对话，继续等待原确认。'};
 }
 if(name==='human_list'){const data=JSON.parse(last.content),r=data.referencedRequests?.find(r=>current.includes(r.requestId)||current.includes(r.displayCode))??data.requests[0];if(!r)return{text:'该确认已经结束；不会按这条旧批准继续。'};return{toolCalls:[{id:'question-answer',name:'human_propose_response',arguments:{requestId:r.requestId,contentVersion:r.contentVersion,questionDigest:r.questionDigest,decision:current.includes('REJECT')?'reject':current.includes('UNCLEAR')?'needs_more':'approve',answers:current.includes('UNCLEAR')?[]:[{questionId:'answer',value:current.includes('REJECT')?'stop original scope':'approve original scope only'}]}}]};}
 if(name==='human_propose_response'){const receipt=JSON.parse(last.content);if(current.includes('MIXED')&&receipt.status==='continued')return{toolCalls:[{id:'mixed-new',name:'task_create',arguments:{input:'SEPARATE-MIXED-DEMAND'}}]};return{text:receipt.status==='not_recorded'?receipt.message:'已按工具回执处理；没有扩大原批准范围。'};}
 return{text:'独立任务已安排。'};
}
test('pending confirmation preserves ordinary chat and new Task tools; sent assistant notice is projected once before the real reply',async t=>{
 const f=await fixture(t,{humanEnabled:true,model:input=>({...semanticHumanModel(input),usage:{inputTokens:5,outputTokens:5}})}),r=await notifyHumanFixture(f);assert.equal(f.models.length,0,'template delivery must not invoke interaction LLM');f.advance(1000);
 const hello=event('pending-hello','alice','ongoing-private',false,'private');hello.message.text='你好 HELLO';await f.receive(hello);await f.drain();assert.equal(f.store.one('SELECT status FROM human_requests').status,'waiting');assert.equal(f.store.one('SELECT count(*) n FROM tasks').n,1);
 const first=f.models[0].messages,noticeIndex=first.findIndex(m=>m.contextSource?.kind==='human_notice'),userIndex=first.findIndex(m=>m.contextSource?.kind==='user_input');assert.ok(noticeIndex>=0&&noticeIndex<userIndex);assert.equal(first[noticeIndex].role,'assistant');assert.match(first[noticeIndex].content,/SYNTHETIC-HUMAN-one/);assert.equal(first.filter(m=>m.contextSource?.kind==='human_pending').length,1);
 const next=event('pending-new','alice','ongoing-private',false,'private');next.message.text='请执行独立需求 NEW-ONLY';await f.receive(next);await f.drain();assert.equal(f.store.one('SELECT count(*) n FROM tasks').n,2);assert.equal(f.store.one('SELECT status FROM human_requests WHERE request_id=?',r.requestId).status,'waiting');
 const last=f.models.at(-1).messages;assert.equal(last.filter(m=>m.contextSource?.kind==='human_notice').length,1);assert.equal(last.filter(m=>m.contextSource?.kind==='human_pending').length,1);assert.equal(last.filter(m=>m.contextSource?.kind==='user_input'&&m.content.includes('你好 HELLO')).length,1);assert.equal(new Set(f.store.all('SELECT conversation_id FROM channel_inbox').map(x=>x.conversation_id)).size,1);
 const grant=f.store.all('SELECT employee_use_admitted,turn_id FROM channel_inbox');assert.ok(grant.every(x=>x.employee_use_admitted===1));for(const x of grant){assert.equal(JSON.parse(f.conversations.turn(x.turn_id).request_json).employeeUseAdmitted,true);}
});
test('mixed reply uses confirmation and independent Task tools separately; duplicate real input cannot create another continuation',async t=>{
 const f=await fixture(t,{humanEnabled:true,model:input=>({...semanticHumanModel(input),usage:{inputTokens:5,outputTokens:5}})}),r=await notifyHumanFixture(f,'mixed');f.advance(1000);const m=event('mixed-current','alice','mixed-private',false,'private');m.message.text='批准原范围，另外请处理独立需求 MIXED';await f.receive(m);await f.drain();
 assert.equal(f.store.one('SELECT count(*) n FROM tasks').n,2);assert.equal(f.store.one('SELECT count(*) n FROM runs').n,3);const human=f.store.one('SELECT response_json,continuation_run_id FROM human_requests WHERE request_id=?',r.requestId);assert.ok(human.continuation_run_id);assert.ok(!human.response_json.includes('SEPARATE-MIXED-DEMAND'));assert.ok(!human.response_json.includes('另外'));const other=f.store.one('SELECT input FROM tasks WHERE id!=?',r.taskId);assert.equal(other.input,'SEPARATE-MIXED-DEMAND');await f.receive(m);await f.drain();assert.equal(f.store.one('SELECT count(*) n FROM runs').n,3);
});
test('multiple pending questions require disambiguation; explicit rejection followed by old approval never resumes rejected scope',async t=>{
 const f=await fixture(t,{humanEnabled:true,model:input=>({...semanticHumanModel(input),usage:{inputTokens:5,outputTokens:5}})}),one=await notifyHumanFixture(f,'first'),two=await notifyHumanFixture(f,'second');f.advance(1000);
 const ambiguous=event('ambiguous-now','alice','decisions-private',false,'private');ambiguous.message.text='批准 APPROVE';await f.receive(ambiguous);await f.drain();assert.equal(f.store.one('SELECT count(*) n FROM runs').n,2);assert.ok(f.sent.some(m=>m.text.includes('多个待确认问题')));
 const uncertain=event('uncertain-now','alice','decisions-private',false,'private');uncertain.message.text='需要进一步说明 UNCLEAR '+one.requestId;await f.receive(uncertain);await f.drain();assert.equal(f.store.one('SELECT count(*) n FROM runs').n,2);
 const reject=event('reject-now','alice','decisions-private',false,'private');reject.message.text='拒绝，停止原任务 REJECT '+one.requestId;await f.receive(reject);await f.drain();assert.equal(f.store.one('SELECT status FROM tasks WHERE id=?',one.taskId).status,'canceled');
 // Explicit request association prevents a later changed mind from consuming another pending question.
 const changed=event('approve-rejected','alice','decisions-private',false,'private');changed.message.text='批准 APPROVE '+one.requestId;await f.receive(changed);await f.drain();assert.equal(f.store.one('SELECT count(*) n FROM runs').n,2);assert.equal(f.store.one('SELECT status FROM tasks WHERE id=?',one.taskId).status,'canceled');assert.equal(f.store.one('SELECT status FROM human_requests WHERE request_id=?',two.requestId).status,'waiting');
});
test('limited confirmer cannot gain ordinary Task tools; other private users cannot see sent human notice or pending question',async t=>{
 const f=await fixture(t,{humanEnabled:true,model:input=>({...semanticHumanModel(input),usage:{inputTokens:5,outputTokens:5}})}),r=await notifyHumanFixture(f,'limited');f.advance(1000);f.denied.add('alice');
 const newDemand=event('limited-new','alice','limited-private',false,'private');newDemand.message.text='独立新任务 NEW-ONLY';await f.receive(newDemand);await f.drain();assert.equal(f.store.one('SELECT employee_use_admitted FROM channel_inbox').employee_use_admitted,0);assert.equal(f.store.one('SELECT count(*) n FROM tasks').n,1);assert.equal(f.store.one('SELECT status FROM human_requests').status,'waiting');
 const before=f.models.length,other=event('other-hello','bob','other-private',false,'private');other.message.text='你好 HELLO';await f.receive(other);await f.drain();assert.ok(f.models.length>before);assert.ok(!JSON.stringify(f.models.at(-1).messages).includes('SYNTHETIC-HUMAN-limited'));assert.equal(f.store.one('SELECT count(*) n FROM tasks').n,1);
});


test('Web replies queued during a live model request bind the human tool to the last actually consumed turn, never an unseen latest row',async t=>{
 let enter,release,first=true,currentEvidence;const entered=new Promise(r=>enter=r),hold=new Promise(r=>release=r);
 const f=await fixture(t,{humanEnabled:true,model:async input=>{const last=input.messages.at(-1),name=last.role==='tool'?input.messages.flatMap(m=>m.toolCalls??[]).find(c=>c.id===last.toolCallId)?.name:undefined;if(first){first=false;enter();await hold;return{text:'先继续说明，尚未批准。',usage:{inputTokens:1,outputTokens:1}};}if(name==='human_list'){const data=JSON.parse(last.content),r=data.requests[0];currentEvidence=data.currentMessage.id;return{toolCalls:[{id:'batch-approve',name:'human_propose_response',arguments:{requestId:r.requestId,contentVersion:r.contentVersion,questionDigest:r.questionDigest,decision:'approve',answers:[{questionId:'answer',value:'approve original scope'}]}}],usage:{inputTokens:1,outputTokens:1}};}return name==='human_propose_response'?{text:'仅已消费的真实批准被记录。',usage:{inputTokens:1,outputTokens:1}}:{toolCalls:[{id:'batch-list',name:'human_list',arguments:{}}],usage:{inputTokens:1,outputTokens:1}};}});
 const web={workspaceId:'w',entityId:'e',userId:'manager'},conv=f.interaction.create(web,{operationId:'batch-web'}).conversation,ctx={...web,conversationId:conv.id},todo=f.tasks.createTodo(ctx,{operationId:'batch-origin',input:'Original approval scope'}),start=await f.tasks.startTodo(ctx,todo.id,{operationId:'batch-start',expectedVersion:1}),row=f.store.one('SELECT * FROM tasks WHERE id=?',todo.id),q={questionScope:'qa',background:'Synthetic batch',goal:'Local result',knownFacts:[],questions:[{id:'answer',text:'Approve?',required:true,answerType:'text'}],completionCriteria:['Explicit'],proposedAction:'Local-only result',impactScope:'Original scope',ifNotConfirmed:'wait'},requestId='923507b2-1d5c-4b68-9900-b61ca6111882';
 f.human.onEvent(row,{eventId:'batch-safe',runId:start.run.id,sequence:1,type:'human_safe',human:{requestId,contentVersion:1,question:q,questionDigest:createHash('sha256').update(JSON.stringify(q)).digest('hex'),taskId:row.id,runId:start.run.id,sessionId:f.store.one('SELECT session_id FROM runs WHERE id=?',start.run.id).session_id,configurationId:'fixed',inputRevision:1,safe:true,checkpointRef:'batch-checkpoint'}});await f.human.tick();const assigned=f.store.one('SELECT target_json,target_conversation_id,notification_status,notification_error FROM human_requests');assert.equal(assigned.notification_status,'delivered',JSON.stringify(assigned));assert.equal(assigned.target_conversation_id,conv.id,JSON.stringify(assigned));assert.ok(f.human.canReply({...web,conversationId:conv.id}),JSON.stringify(assigned));
 const a=await f.interaction.createTurn(web,conv.id,{operationId:'batch-a',text:'先别，说明一下'});await entered;const b=await f.interaction.createTurn(web,conv.id,{operationId:'batch-b',text:'再想一想'}),c=await f.interaction.createTurn(web,conv.id,{operationId:'batch-c',text:'批准 '+requestId});assert.ok(!JSON.stringify(f.models[0].messages).includes('批准 '+requestId));release();
 for(let i=0;i<2000&&!f.store.one('SELECT response_digest FROM human_requests').response_digest;i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(currentEvidence,c.turn.id);assert.ok(f.store.one('SELECT response_digest FROM human_requests').response_digest,JSON.stringify({turns:f.store.all('SELECT id,status,error FROM interaction_turns'),lastTool:f.models.at(-1)?.messages.at(-1)}));const response=f.store.one('SELECT message_id,candidate_json FROM human_response_messages');assert.equal(response.message_id,c.turn.id);assert.deepEqual(JSON.parse(response.candidate_json).evidenceMessageIds,[c.turn.id]);assert.equal(f.store.one('SELECT count(*) n FROM runs').n,2);assert.equal(f.store.one('SELECT count(*) n FROM conversations').n,1);
});


test('ordinary tool schemas stay stable before, during and after human waiting and survive a private history restart',async t=>{
 const runModel=input=>({...semanticHumanModel(input),usage:{inputTokens:5,outputTokens:5}}),f=await fixture(t,{humanEnabled:true,model:runModel});
 const before=event('stable-before','alice','stable-private',false,'private');before.message.text='你好 HELLO';await f.receive(before);await f.drain();const expected=JSON.stringify(f.models[0].tools);assert.ok(f.models[0].tools.some(t=>t.name==='human_list'));assert.ok(f.models[0].tools.some(t=>t.name==='human_propose_response'));for(const name of ['task_create','task_query','task_cancel','task_supplement'])assert.ok(f.models[0].tools.some(t=>t.name===name),name);
 const pending=await notifyHumanFixture(f,'stable-schema');f.advance(1000);
 for(const [id,text]of [['stable-clarify','再说明 UNCLEAR '+pending.requestId],['stable-approve','批准 APPROVE '+pending.requestId],['stable-after','独立任务 NEW-ONLY']]){const message=event(id,'alice','stable-private',false,'private');message.message.text=text;await f.receive(message);await f.drain();}
 assert.equal(f.store.one('SELECT status FROM human_requests').status,'continued');assert.ok(f.models.every(m=>JSON.stringify(m.tools)===expected),'pending transitions cannot alter tool declarations');
 const convId=f.store.one("SELECT conversation_id FROM channel_inbox WHERE json_extract(event_json,'$.message.id')='stable-after'").conversation_id,conv=f.conversations.get(convId),scope=JSON.parse(f.store.one("SELECT scope_json FROM channel_inbox WHERE json_extract(event_json,'$.message.id')='stable-after'").scope_json);
 await f.provider.shutdown();const restoredModels=[],restored=createBuiltinInteractionProvider(f.store,f.conversations,f.tasks,()=>1800000002000,{getRuntimeDefinition(){return{name:'Helper',description:'Fixture',interactionRuntime:'builtin-interaction'};}},{journal:f.journal,human:f.human,readAdmittedInput:id=>f.store.one('SELECT input_text FROM channel_inbox WHERE id=?',id)?.input_text??'',modelClient:{async complete(input){restoredModels.push(input);return runModel(input);}}});t.after(()=>restored.shutdown());
 const interaction=createInteractionService(f.conversations,f.tasks,restored,()=>1800000002000),loop=new ChannelMessageLoop(f.repo,{async resolveBinding(){return f.binding;},currentBindingVersion(){return'1';},async authorizeInvocation(){}},interaction,f.tasks,()=>1800000002000),incoming=event('stable-restored','alice','stable-private',false,'private');incoming.message.text='已结束问题后普通对话 HELLO';incoming.receivedAt=1800000002000;await loop.acceptAuthenticatedEvent('connection',incoming);for(let n=0;n<30&&!restoredModels.length;n++){await loop.tick();await loop.waitForWork();await new Promise(r=>setTimeout(r,10));}const stored=f.store.one("SELECT turn_id,status FROM channel_inbox WHERE json_extract(event_json,'$.message.id')='stable-restored'");for(let n=0;n<30&&stored?.turn_id&&f.conversations.turn(stored.turn_id).status!=='succeeded';n++){await interaction.getTurn(scope,conv.id,stored.turn_id);await new Promise(r=>setTimeout(r,10));}await loop.stop();assert.equal(f.conversations.turn(stored.turn_id).status,'succeeded');assert.equal(JSON.stringify(restoredModels[0].tools),expected);assert.ok(restoredModels[0].messages.some(m=>m.role==='assistant'&&m.toolCalls?.some(c=>c.name==='human_propose_response')),'persisted human call must remain readable');assert.ok(restoredModels[0].messages.some(m=>m.role==='assistant'&&m.toolCalls?.some(c=>c.name==='task_create')),'persisted ordinary Task call must remain readable');
});

test('private p2p threads reply to trusted inbound message and retain isolated history; plain private stays proactive',async t=>{
 const f=await fixture(t,{memory:true});
 for(const [id,thread]of[['p2p-first','omt_A'],['p2p-other','omt_B'],['p2p-plain',undefined]]){const e=event(id,'alice','p2p-chat',false,'private');if(thread)e.message.threadId=thread;e.message.text=id;await f.receive(e);await f.drain();}
 assert.equal(f.sent.length,3);assert.equal(f.sent[0].replyToMessageId,'p2p-first');assert.equal(f.sent[0].threadId,'omt_A');assert.equal(f.sent[1].replyToMessageId,'p2p-other');assert.equal(f.sent[1].threadId,'omt_B');assert.equal(f.sent[2].replyToMessageId,undefined);assert.equal(f.sent[2].threadId,undefined);assert.equal(f.store.one('SELECT count(*) n FROM conversations').n,3);assert.ok(!JSON.stringify(f.models[1].messages).includes('p2p-first'));assert.ok(!JSON.stringify(f.models[2].messages).includes('p2p-other'));
});
test('private p2p thread deterministic model-error reply preserves thread and never falls back to main chat',async t=>{
 const f=await fixture(t,{memory:true,unconfigured:true});const e=event('p2p-failed','alice','p2p-chat',false,'private');e.message.threadId='omt_error';await f.receive(e);await f.drain();assert.equal(f.sent.length,1);assert.equal(f.sent[0].replyToMessageId,e.message.id);assert.equal(f.sent[0].threadId,'omt_error');
});

test('private p2p thread Task completion keeps verified reply target in legacy and unified notification routes',async t=>{
 const f=await fixture(t,{model:async(input)=>({...((input.messages.at(-1).role==='tool')?{text:'Synthetic task accepted'}:{toolCalls:[{id:'create',name:'task_create',arguments:{input:'Synthetic scoped task'}}]}),usage:{inputTokens:3,outputTokens:3}})}),e=event('p2p-task','alice','p2p-chat',false,'private');e.message.threadId='omt_task';await f.receive(e);await f.drain();await f.tasks.tick();const task=f.store.one('SELECT * FROM tasks');assert.ok(task);f.tasks.ingest(task.run_id,{runId:task.run_id,eventId:'p2p-final',sequence:1,type:'final_result',text:'Synthetic result',inputRevision:1});f.tasks.ingest(task.run_id,{runId:task.run_id,eventId:'p2p-success',sequence:2,type:'status',status:'succeeded'});
 const {SqliteTaskCompletionNotifications}=await import('../dist/adapters/sqlite/task-completion-notifications.js'),repository=new SqliteTaskCompletionNotifications(f.store,f.conversations,f.repo),jobs=[];repository.setSink(job=>jobs.push(job));repository.discover(1800000000000);repository.discoverUnified(1800000000000);assert.equal(jobs.length,1);const target=JSON.parse(jobs[0].targetJson);assert.equal(target.threadId,'omt_task');assert.equal(target.replyToMessageId,e.message.id);assert.equal(target.conversation.privateRecipientNamespace,undefined);assert.equal(target.conversation.externalId,'p2p-chat');
 await f.drain();assert.ok(f.sent.some(r=>r.text==='Synthetic result'&&r.threadId==='omt_task'&&r.replyToMessageId===e.message.id));
});

test('denied Task creation preserves model content and still sends an explicit failure',async t=>{
 const f=await fixture(t,{memory:true,model:async()=>({text:'任务已经安排并完成',toolCalls:[{id:'deny-create',name:'task_create',arguments:{input:'Synthetic denied task'}}],usage:{inputTokens:1,outputTokens:1}})});f.tasks.create=async()=>{throw new TaskError(403,'synthetic_task_denied');};await f.receive(event('denied-preface','alice','private-qa',false,'private'));await f.drain();assert.equal(f.store.one('SELECT count(*) n FROM tasks').n,0);assert.equal(f.sent.filter(r=>r.text==='任务已经安排并完成').length,1);assert.ok(f.sent.some(r=>r.text!=='任务已经安排并完成'),'A separate explicit failure must follow the rejected tool');assert.ok(f.sent.every(r=>r.text.trim().length>0));assert.equal(f.store.one('SELECT status FROM interaction_turns').status,'failed');
});

test('human tool declarations are stable by primary-private conversation type, never by pending state',async t=>{
 const f=await fixture(t,{memory:true,humanEnabled:true});for(const[kind,thread,id]of[['group',undefined,'scope-group'],['group','omt_group','scope-group-topic'],['private',undefined,'scope-main'],['private','omt_private','scope-private-topic']]){const e=event(id,'alice',kind==='group'?'scope-group-chat':'scope-dm',kind==='group',kind);if(thread)e.message.threadId=thread;await f.receive(e);await f.drain();}assert.equal(f.models.length,4);for(const[i,m]of f.models.entries()){assert.ok(m.tools.some(t=>t.name==='task_create'));assert.equal(m.tools.some(t=>t.name==='human_list'),i===2);assert.equal(m.tools.some(t=>t.name==='human_propose_response'),i===2);}const main=event('scope-main-again','alice','scope-dm',false,'private');await f.receive(main);await f.drain();assert.deepEqual(f.models[4].tools,f.models[2].tools);
});

test('runtime resolves a real inbound quote from the sent receipt; models cannot choose a different request or project it into topics',async t=>{
 let chosen,receipt;const f=await fixture(t,{humanEnabled:true,model(input){const last=input.messages.at(-1),name=last.role==='tool'?input.messages.flatMap(m=>m.toolCalls??[]).find(c=>c.id===last.toolCallId)?.name:undefined;if(name==='human_list'){const data=JSON.parse(last.content);chosen=data.currentMessage.quotedRequest?.requestId;const r=data.referencedRequests.find(x=>x.requestId===chosen);assert.ok(r,'trusted provider parent resolves beyond page/order');return{toolCalls:[{id:'quote-submit',name:'human_propose_response',arguments:{requestId:r.requestId,contentVersion:r.contentVersion,questionDigest:r.questionDigest,decision:'approve',answers:[{questionId:'answer',value:'approved current quoted scope'}],evidenceMessageIds:['invented-old-message']}}],usage:{inputTokens:1,outputTokens:1}};}if(name==='human_propose_response'){receipt=JSON.parse(last.content);return{text:'已记录引用问题的答复。',usage:{inputTokens:1,outputTokens:1}};}return{toolCalls:[{id:'quote-list',name:'human_list',arguments:{pageSize:1}}],usage:{inputTokens:1,outputTokens:1}};}});
 const one=await notifyHumanFixture(f,'quote-one'),two=await notifyHumanFixture(f,'quote-two');f.advance(1000);const providerId=f.store.one("SELECT message_id FROM channel_message_receipts WHERE id=? AND kind='outbox'",'human-question:'+one.requestId).message_id;assert.ok(providerId);
 const m=event('quoted-human-answer','alice','quote-main',false,'private');m.message.text='批准';m.message.replyToMessageId=providerId;await f.receive(m);await f.drain();assert.equal(chosen,one.requestId);assert.equal(receipt.status,'continued');assert.equal(f.store.one('SELECT status FROM human_requests WHERE request_id=?',two.requestId).status,'waiting');assert.equal(f.store.one('SELECT count(*) n FROM runs').n,3);
 const input=f.store.one("SELECT turn_id FROM channel_inbox WHERE json_extract(event_json,'$.message.id')=?",m.message.id);assert.deepEqual(JSON.parse(f.store.one('SELECT candidate_json FROM human_response_messages WHERE request_id=?',one.requestId).candidate_json).evidenceMessageIds,[input.turn_id]);await f.receive(m);await f.drain();assert.equal(f.store.one('SELECT count(*) n FROM runs').n,3);
});

for(const [kind,thread] of [['group',undefined],['group','omt_group_source'],['private',undefined],['private','omt_private_source']])test(`source routing contract ${kind}/${thread??'main'} asks only in main private and returns the continued result to the unchanged origin`,async t=>{
 const f=await fixture(t,{humanEnabled:true,model:async input=>({...(input.messages.at(-1).role==='tool'||input.messages.some(m=>m.role==='user'&&m.content==='ACTUAL APPROVE')?{text:'工具回执已记录'}:{toolCalls:[{id:'origin-create',name:'task_create',arguments:{input:'Synthetic origin-bound task'}}]}),usage:{inputTokens:1,outputTokens:1}})}),origin=event('source-'+kind+'-'+(thread??'main'),'alice','source-'+kind,kind==='group',kind);if(thread)origin.message.threadId=thread;await f.receive(origin);await f.drain();const task=f.store.one('SELECT * FROM tasks'),original=task.source_json,session=f.store.one('SELECT session_id FROM runs WHERE id=?',task.run_id).session_id,question={questionScope:'qa',background:'Source routing contract only',goal:'Local result',knownFacts:[],questions:[{id:'answer',text:'Approve?',required:true,answerType:'text'}],completionCriteria:['Explicit'],proposedAction:'Local output',impactScope:'Test only',ifNotConfirmed:'wait'},requestId=randomUUID();
 const notifications=new HumanChannelNotifications(f.store,{async resolveBinding(){return f.binding;}},f.repo,()=>1800000001000);f.human.setChannels(notifications);f.store.run('INSERT INTO employee_human_rules VALUES(?,?,?,?)','w','e',1,JSON.stringify([{questionScope:'*',target:{kind:'channel',connectionId:'connection',userId:'alice',identityNamespace:'open_id',provider:'feishu',appId:'app',tenantId:'tenant'}}]));f.human.onEvent(task,{eventId:'matrix-safe',runId:task.run_id,sequence:1,type:'human_safe',human:{requestId,contentVersion:1,question,questionDigest:createHash('sha256').update(JSON.stringify(question)).digest('hex'),taskId:task.id,runId:task.run_id,sessionId:session,configurationId:'fixed',inputRevision:1,safe:true,checkpointRef:'safe-matrix'}});await f.human.tick();await f.drain();const notice=JSON.parse(f.store.one('SELECT target_json FROM human_channel_notices').target_json);assert.equal(notice.conversation.conversationKind,'private');assert.equal(notice.threadId,undefined);assert.equal(notice.conversation.privateRecipientId,'alice');assert.equal(f.store.one('SELECT source_json FROM tasks').source_json,original);
 const reply=event('matrix-approval-'+kind+'-'+(thread??'main'),'alice','human-main-private',false,'private');reply.message.text='ACTUAL APPROVE';f.advance(2000);await f.receive(reply);await f.drain();const incoming=f.store.one("SELECT turn_id,conversation_id,scope_json FROM channel_inbox WHERE json_extract(event_json,'$.message.id')=?",reply.message.id),current=f.conversations.turn(incoming.turn_id),actor={scope:JSON.parse(incoming.scope_json),conversationId:incoming.conversation_id,messageId:incoming.turn_id,messageText:current.text,createdAt:current.created_at};const outcome=f.human.proposeResponse(actor,{requestId,contentVersion:1,questionDigest:createHash('sha256').update(JSON.stringify(question)).digest('hex'),decision:'approve',answers:[{questionId:'answer',value:'approve'}]});assert.equal(outcome.status,'continued');const next=f.store.one('SELECT * FROM tasks');assert.notEqual(next.run_id,task.run_id);assert.equal(f.store.one('SELECT session_id FROM runs WHERE id=?',next.run_id).session_id,session);assert.equal(next.source_json,original);f.tasks.ingest(next.run_id,{runId:next.run_id,eventId:'matrix-final',sequence:1,type:'final_result',text:'Synthetic continued result',inputRevision:next.input_revision});f.tasks.ingest(next.run_id,{runId:next.run_id,eventId:'matrix-terminal',sequence:2,type:'status',status:'succeeded'});assert.equal(f.store.one('SELECT status FROM tasks WHERE id=?',task.id).status,'succeeded');const{SqliteTaskCompletionNotifications}=await import('../dist/adapters/sqlite/task-completion-notifications.js'),jobs=[],repo=new SqliteTaskCompletionNotifications(f.store,f.conversations,f.repo);repo.setSink(job=>jobs.push(job));repo.discover(1800000005000);repo.discoverUnified(1800000005000);assert.equal(jobs.length,1);const back=JSON.parse(jobs[0].targetJson);assert.equal(back.conversation.conversationKind,kind);assert.equal(back.conversation.externalId,origin.message.conversation.externalId);assert.equal(back.threadId,thread);if(thread)assert.equal(back.replyToMessageId,origin.message.id);
});


test('current human evidence uses the immutable raw inbox body, never display labels as a semantic question reference',async t=>{
 let receipt,body;const f=await fixture(t,{humanEnabled:true,model(input){const last=input.messages.at(-1),name=last.role==='tool'?input.messages.flatMap(m=>m.toolCalls??[]).find(c=>c.id===last.toolCallId)?.name:undefined;if(name==='human_list'){const data=JSON.parse(last.content);body=data.currentMessage.text;const r=data.requests[0];return{toolCalls:[{id:'raw-submit',name:'human_propose_response',arguments:{requestId:r.requestId,contentVersion:r.contentVersion,questionDigest:r.questionDigest,decision:'approve',answers:[{questionId:'answer',value:'yes'}],evidenceSegmentIds:[data.currentMessage.segments[0].id]}}],usage:{inputTokens:1,outputTokens:1}};}if(name==='human_propose_response'){receipt=JSON.parse(last.content);return{text:'请明确要确认哪个问题。',usage:{inputTokens:1,outputTokens:1}};}return{toolCalls:[{id:'raw-list',name:'human_list',arguments:{}}],usage:{inputTokens:1,outputTokens:1}};}});await notifyHumanFixture(f,'raw-first');await notifyHumanFixture(f,'raw-second');f.advance(1000);const incoming=event('raw-bare-approval','alice','raw-private',false,'private');incoming.message.text='同意';incoming.message.author.displayName='预算方案同意';await f.receive(incoming);await f.drain();assert.equal(body,'同意');assert.equal(receipt.reason,'human_request_ambiguous');assert.equal(f.store.one('SELECT count(*) n FROM runs').n,2);assert.ok(f.models[0].messages.some(m=>m.role==='user'&&m.content.includes('说话人')),'the model still receives legitimate presentation metadata separately from evidence');
});

for(const channel of ['feishu','dingtalk','wecom'])for(const entry of ['ordinary','business'])test(`${channel} ${entry} model can select artifacts only for declared native target capabilities`,async t=>{
 let taskId,selected=false,allowed=true;
 const f=await fixture(t,{channel,nativeArtifacts:true,mediaAllowed:()=>allowed,model:async input=>{
   if(!taskId)return{text:'Initial fixture reply',usage:{inputTokens:1,outputTokens:1}};
   assert.ok(input.tools.some(t=>t.name==='artifact_select'));
   if(entry==='business')assert.deepEqual(input.tools.map(t=>t.name),['artifact_select']);
   if(input.messages.at(-1).role==='tool'){selected=true;return{text:'Artifact selected',usage:{inputTokens:1,outputTokens:1}};}
   return{toolCalls:[{id:'select-native-file',name:'artifact_select',arguments:{taskId,artifactIds:[f.artifact.content.resourceId]}}],usage:{inputTokens:1,outputTokens:1}};
 }});
 const incoming=id=>{const e=event(id,'alice','dm',false,'private');e.message.conversation.provider=channel;e.message.author.idNamespace=channel==='feishu'?'open_id':'user_id';return e;};
 await f.receive(incoming('initial'));await f.drain();
 const conv=f.store.one('SELECT * FROM conversations LIMIT 1'),scope=JSON.parse(conv.scope_json),task=await f.tasks.create({...scope,conversationId:conv.id},{operationId:'native-task',conversationId:conv.id,input:'Synthetic report',contextMode:'new'}),raw=f.tasks.getRuntimeTask(task.id);taskId=task.id;
 f.tasks.ingest(raw.run_id,{eventId:'result',runId:raw.run_id,sequence:1,type:'final_result',text:'Report ready',inputRevision:1});f.tasks.ingest(raw.run_id,{eventId:'done',runId:raw.run_id,sequence:2,type:'status',status:'succeeded'});
 if(entry==='ordinary'){await f.receive(incoming('select'));await f.drain();}
 else {const target={conversation:{...incoming('notice').message.conversation}},eventId='business-native',turnId='business-native-turn';f.store.run('INSERT INTO business_notification_jobs VALUES(?,?,?,?,?)',eventId,taskId,turnId,JSON.stringify(target),conv.id);const event={schemaVersion:1,source:'platform',eventId,type:'business_result',taskId,runId:raw.run_id,status:'succeeded',conversationId:conv.id,data:{sourceKind:'task',facts:{artifacts:[f.artifact]},refs:[]}};let result;for(let i=0;i<100;i++){result=await f.provider.acceptBusinessEvent(scope,conv.id,turnId,event);if(['processed','failed','unknown'].includes(result.receipt.status))break;await new Promise(r=>setTimeout(r,10));}assert.equal(result.receipt.status,'processed',JSON.stringify(result));}
 assert.equal(selected,true);assert.equal(f.store.one('SELECT count(*) n FROM task_artifact_selections').n,1);if(entry==='ordinary'){assert.equal(f.sent.filter(r=>r.attachment).length,1,'Normal reply queues and sends selected native file independently');assert.equal(f.sent.find(r=>r.attachment).attachment.name,'report.pdf');}
 allowed=false;taskId=undefined;const count=f.models.length;await f.receive(incoming('unavailable'));await f.drain();assert.ok(f.models.length>count);assert.equal(f.models.at(-1).tools.some(t=>t.name==='artifact_select'),false,'Revoked/undeclared media must not remain offered');
});
