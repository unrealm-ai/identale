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
import {createHash} from 'node:crypto';
import {conversationOwnerKey} from '@dentity/application';
import {createServer as httpServer} from 'node:http';
import {FileDiagnostics} from '../dist/adapters/diagnostics.js';
import {diagnosticInteraction} from '../dist/adapters/diagnostic-interaction.js';
const yes={supported:true,availability:'available'};
async function diagnosticFixture(t){const root=mkdtempSync(join(tmpdir(),'identity-channel-trace-')),log=new FileDiagnostics(join(root,'diagnostics'));t.after(async()=>{await log.close();rmSync(root,{recursive:true,force:true});});const rows=async()=>{await log.flush();return readdirSync(log.root).filter(n=>n.endsWith('.jsonl')).flatMap(n=>readFileSync(join(log.root,n),'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)));};return{log,rows};}
async function fixture(t,{model,history=false,meeting=false,describeActor,diagnostics,memory=false,unconfigured=false,groupLive=false}={}){
 const dir=mkdtempSync(join(tmpdir(),'identity-channel-loop-'));let now=1800000000000;
 const store=new Store(join(dir,'app.sqlite'));
 store.run("INSERT INTO users VALUES('manager','manager','Manager','active')");store.run("INSERT INTO workspaces VALUES('w','WS','manager','active')");store.run("INSERT INTO members(id,workspace_id,user_id,role,status) VALUES('manager-member','w','manager','owner','active')");store.run("INSERT INTO entities(id,workspace_id,name,owner_member_id,created_by_member_id,own_web_use,web_use_user_id,interaction_runtime) VALUES('e','w','Helper','manager-member','manager-member',1,'manager','builtin-interaction')");
 const journal=new JsonlJournal({root:join(dir,'records'),ownerId:'fixture',serialize:fn=>store.transaction(fn)}),conversations=new SqliteConversationRepository(store,journal,()=>now);conversations.initialize(0);
 const groups=groupLive?new SqliteGroupContext(store):undefined;
 const denied=new Set(),models=[],commands=[],sent=[],queries=[];let version='1',sendUnknown=false,available=true;
 const auth={authorizeEntity(s){if(denied.has(s.principal?.externalUserId))throw new TaskError(403,'revoked');},async refreshAuthorization(s){this.authorizeEntity(s);}};
 const runtime={idempotentDispatch:true,async dispatch(c){commands.push(c);return{status:'accepted'};},async input(){return{status:'received'};},async cancel(){return{status:'confirmed'};},async events(){return[];}};
 const tasks=new TaskService(new SqliteTaskRepository(store),()=>now,runtime,auth,undefined,conversations);
 const provider=createBuiltinInteractionProvider(store,conversations,tasks,()=>now,{getRuntimeDefinition(){return{name:'Helper',description:'Fixture',interactionRuntime:'builtin-interaction'};}},{journal,readAdmittedInput:id=>store.one('SELECT input_text FROM channel_inbox WHERE id=?',id)?.input_text??'',...(groups?{authorizeHistoryBatch:id=>groups.commitAllowed(id,binding)}:{}),...(diagnostics?{diagnostics}:{}),...(unconfigured?{}:{modelClient:{async complete(input){models.push(input);return model?model(input,models.length):{text:'回答完成',usage:{inputTokens:3,outputTokens:3}};}}})});
 const core=createInteractionService(conversations,tasks,provider,()=>now),interaction=diagnostics?diagnosticInteraction(core,diagnostics):core;
 const connection={workspaceId:'w',connectionId:'connection',provider:'feishu',tenantId:'tenant',identity:{kind:'bot',externalId:'bot'},credentialRef:'fixture-only'};
 const binding={connectionId:'connection',workspaceId:'w',entityId:'e',provider:'feishu',appId:'app',bindingVersion:version,enabled:true,identity:{tenantId:'tenant',tenantIdNamespace:'tenant_key'},connection,policy:{entityMentionId:'bot',ownSenderIds:['bot']},context:{historyEnabled:history,groupListenEnabled:groupLive,listenGeneration:1,meetingRefs:meeting?[{...ref('group'),kind:'minutes',externalId:'minutes'}]:[]},conversation:{connection,async inspectCapabilities(){return{mentionEvents:yes,privateMessageEvents:yes,ordinaryMessageEvents:yes,historyRead:yes,proactiveSend:yes,replyToMessage:yes,threadRead:yes};},async listMessages(ref,q){queries.push(q);return{items:[event('old','alice','group',true).message,event('old','alice','group',true).message],exhausted:true,coverage:'authorized_query',fetchedAt:now};},async sendMessage(r){sent.push(r);return{status:sendUnknown?'unknown':'sent',messageId:'out-'+sent.length,idempotent:false};}},webhook:{connection,async receiveWebhook(r){return{kind:'message',event:JSON.parse(r.rawBody)};}}};
 if(meeting)binding.meetingArtifacts={async listArtifacts(){return[{ref:{...ref('group'),kind:'summary',externalId:'summary'},sourceRef:{...ref('group'),kind:'minutes',externalId:'minutes'},kind:'summary',state:'ready',origin:'provider_summary'}];},async readSummary(artifact){return{artifact:{ref:artifact},text:'会议决定：保留关键约束',format:'text'};}};
 const connections={...(describeActor?{describeActor}:{}),async resolveBinding(){return available?{...binding,bindingVersion:version}:undefined;},currentBindingVersion(){return available?version:undefined;},async authorizeInvocation(_binding,actor){if(denied.has(actor.externalId))throw new TaskError(403,'revoked');}};
 const repo=memory?new MemoryMessageLoopRepository(store,()=>now,300000,diagnostics):new SqliteMessageLoopRepository(store,()=>now),loop=new ChannelMessageLoop(repo,connections,interaction,tasks,()=>now,diagnostics,groups);
 // Legacy SQLite repository contracts are retained; production memory dispatcher is tested separately.
 const dispatch=loop.tick.bind(loop);loop.tick=async()=>{await dispatch();await loop.waitForWork();};
 const receive=e=>loop.acceptAuthenticatedEvent('connection',e);
 const drain=async()=>{for(let i=0;i<12;i++){if(groupLive)now+=100;await loop.tick();await new Promise(r=>setTimeout(r,3));}};
 t.after(async()=>{await loop.stop();await provider.shutdown();store.close();rmSync(dir,{recursive:true,force:true});});
 return{store,journal,loop,repo,tasks,interaction,conversations,receive,drain,models,sent,commands,queries,denied,binding,setAvailable:v=>available=v,setVersion:v=>version=v,setUnknown:v=>sendUnknown=v,advance:ms=>now+=ms};
}
function ref(chat='group',kind='group',user='alice'){return{provider:'feishu',connectionId:'connection',tenantId:'tenant',kind:'conversation',externalId:chat,conversationKind:kind,...(kind==='private'?{privateRecipientId:user}:{})};}
function event(id='message',user='alice',chat='group',mentioned=true,kind='group'){return{schemaVersion:1,eventId:'event-'+id,connectionId:'connection',tenantId:'tenant',receivedAt:1800000000000,origin:'live',message:{id,conversationKind:kind,conversation:ref(chat,kind,user),author:{externalId:user,idNamespace:'open_id',applicationId:'app',displayName:user,kind:'human',identityEvidence:'channel_verified'},occurredAt:1800000000000,text:'请帮我处理 '+id,mentions:mentioned?['bot']:[]}};}

import {ChannelInteractionController,matchesGroupKeyword} from '@dentity/application';
function keywordEvent(id='keyword',mentioned=false){const e=event(id,'alice','group',mentioned);e.message.text='请 HELP 一下';return e;}
test('literal body matching is case-insensitive, any keyword, no regex or metadata/history/self loops',()=>{
 const e=keywordEvent(),controller=new ChannelInteractionController(),policy={entityMentionId:'bot',ownSenderIds:['bot'],groupTriggerKeywords:['help','需求']},caps={mentionEvents:yes,ordinaryMessageEvents:yes};
 assert.equal(controller.decide(e,policy,caps).reason,'keyword');assert.equal(matchesGroupKeyword(e,[]),false);assert.equal(matchesGroupKeyword(e,['H.*P']),false);
 for(const change of [{origin:'history'},{message:{...e.message,author:{...e.message.author,kind:'bot'}}},{message:{...e.message,text:'nothing',author:{...e.message.author,displayName:'help'}}}])assert.notEqual(controller.decide({...e,...change},policy,caps).action,'invoke');
 assert.equal(controller.decide({...e,message:{...e.message,author:{...e.message.author,externalId:'bot'}}},policy,caps).action,'ignore');
 e.message.text='help';e.message.content={kind:'post',title:'help',coverage:'complete',warnings:[],blocks:[[{type:'mention',id:'other',text:'help'},{type:'asset',asset:{kind:'file',name:'help'}}]]};assert.equal(matchesGroupKeyword(e,['help']),false);
 e.message.content.blocks.push([{type:'text',text:'HELP',styles:[]}]);assert.equal(matchesGroupKeyword(e,['help']),true);
});
for(const listen of [false,true])test('keyword enters once with listening '+listen+' and repeated @+keyword deduplicates',async t=>{
 const f=await fixture(t,{groupLive:listen});f.binding.policy.groupTriggerKeywords=['help'];
 assert.equal((await f.receive(keywordEvent('plain'))).kind,'accepted');
 const both=keywordEvent('both',true);assert.equal((await f.receive(both)).status,'created');assert.equal((await f.receive({...both,eventId:'redelivery'})).status,'duplicate');
 assert.equal(f.store.one('SELECT count(*) n FROM channel_inbox').n,2);
 const scopes=f.store.all('SELECT scope_json FROM channel_inbox').map(r=>JSON.parse(r.scope_json));assert.ok(scopes.every(s=>s.source.conversationId==='group'&&s.source.conversationKind==='group'));
});
test('unauthorized keyword stays silent; @+keyword retains fixed permission feedback',async t=>{
 const f=await fixture(t);f.binding.policy.groupTriggerKeywords=['help'];f.denied.add('alice');
 assert.equal((await f.receive(keywordEvent('silent'))).kind,'ignored');assert.equal(f.store.one('SELECT count(*) n FROM channel_inbox').n,0);assert.equal(f.store.one('SELECT count(*) n FROM channel_deliveries').n,0);
 await f.receive(keywordEvent('explicit',true));assert.equal(f.store.one('SELECT count(*) n FROM channel_deliveries').n,1);assert.equal(f.store.one('SELECT count(*) n FROM channel_inbox').n,0);
});
test('unverified ordinary capability prevents keyword invocation without success or quick reply',async t=>{
 const f=await fixture(t);f.binding.policy.groupTriggerKeywords=['help'];const inspect=f.binding.conversation.inspectCapabilities;
 f.binding.conversation.inspectCapabilities=async()=>({...await inspect(),ordinaryMessageEvents:{supported:true,availability:'authorization_required'}});
 assert.equal((await f.receive(keywordEvent())).kind,'ignored');assert.equal(f.store.one('SELECT count(*) n FROM channel_inbox').n,0);assert.equal(f.store.one('SELECT count(*) n FROM channel_deliveries').n,0);
});

test('non-body image/mention/emotion nodes preserve keyword boundaries; adjacent styled text remains continuous',()=>{
 const e=keywordEvent();for(const gap of [{type:'asset',asset:{kind:'image',resourceKey:'synthetic-image'}},{type:'mention',id:'synthetic',text:'unrelated'},{type:'emotion',emotionType:'smile'}]){e.message.content={kind:'post',coverage:'complete',warnings:[],blocks:[[{type:'text',text:'he',styles:[]},gap,{type:'text',text:'lp',styles:['bold']}]]};assert.equal(matchesGroupKeyword(e,['help']),false,gap.type);}
 e.message.content.blocks=[[{type:'text',text:'he',styles:[]},{type:'text',text:'lp',styles:['bold']}]];assert.equal(matchesGroupKeyword(e,['help']),true);
 e.message.content.blocks=[[{type:'text',text:'he',styles:[]}],[{type:'text',text:'lp',styles:[]}]];assert.equal(matchesGroupKeyword(e,['help']),false,'separate lines are not one word');
});
