import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelIntegrationService, ChannelInteractionController, ChannelError } from '../../../packages/application/dist/index.js';
const available={supported:true,availability:'available'};
const unsupported={supported:false,availability:'unsupported'};
const connection={workspaceId:'ws',connectionId:'conn',tenantId:'tenant',provider:'feishu',credentialRef:'secret',identity:{kind:'bot',externalId:'bot'}};
const ref={provider:'feishu',connectionId:'conn',tenantId:'tenant',kind:'conversation',externalId:'group'};
const scope={workspaceId:'ws',entityId:'employee',requesterId:'manager',requesterKind:'platform_user'};
const caps={mentionEvents:available,ordinaryMessageEvents:available,historyRead:available,proactiveSend:available,replyToMessage:available,threadRead:unsupported};
const policy={mode:'participate',entityMentionId:'bot',ownSenderIds:['bot']};
const event=()=>({schemaVersion:1,eventId:'event',connectionId:'conn',tenantId:'tenant',receivedAt:100,origin:'live',message:{id:'m',conversation:ref,conversationKind:'group',author:{externalId:'actual-sender',idNamespace:'open_id',applicationId:'trusted-app',kind:'human',identityEvidence:'channel_verified'},occurredAt:90,text:'hello',mentions:['bot']}});
function fixture(options={}) {
  const records=new Map(); const observed=[];
  const conversation={connection,inspectCapabilities:async()=>options.caps??caps,getConversation:async()=>({ref,kind:'group'}),listMessages:async()=>({items:[],exhausted:true,coverage:'authorized_query',fetchedAt:100}),sendMessage:async()=>options.sendReceipt??({status:'sent',messageId:'sent',idempotent:false})};
  const webhook={connection,receiveWebhook:async request=>{if(request.rawBody!=='signed')throw new ChannelError('unauthenticated');return {kind:'message',event:options.event??event()};}};
  const accessPolicy={authorize:async(s,c,op,r)=>{observed.push({s,c,op,r});return options.allow!==false;}};
  const inbox={accept:async record=>{if(records.has(record.key))return 'duplicate';records.set(record.key,record);return 'created';}};
  const service=new ChannelIntegrationService({integrations:[{connection,conversation,webhook,ingress:{scope:{workspaceId:'ws',entityId:'employee'},policy}}],accessPolicy,...(options.noInbox?{}:{inbox})});
  return {service,records,observed};
}
test('channel service routes scoped reads and keeps query coverage explicit',async()=>{
  const {service}=fixture(); const page=await service.listMessages(scope,ref,{});assert.equal(page.coverage,'authorized_query');assert.equal(page.exhausted,true);
});
test('cross workspace and connection resource fail before reading',async()=>{
  const {service}=fixture();await assert.rejects(service.listMessages({...scope,workspaceId:'other'},ref,{}),{code:'forbidden'});await assert.rejects(service.listMessages(scope,{...ref,tenantId:'other'},{}),{code:'forbidden'});
});
test('current policy is mandatory and revocation fails closed',async()=>{
  const {service}=fixture({allow:false});await assert.rejects(service.sendMessage(scope,{conversation:ref,text:'hello',operationId:'op'}),{code:'forbidden'});
});
test('unsupported history cannot be silently empty success',async()=>{
  const {service}=fixture({caps:{...caps,historyRead:unsupported}});await assert.rejects(service.listMessages(scope,ref,{}),{code:'unsupported'});
});
test('unknown send delivery is preserved without retries',async()=>{
  const {service}=fixture({sendReceipt:{status:'unknown',idempotent:false}});assert.deepEqual(await service.sendMessage(scope,{conversation:ref,text:'hi',operationId:'op'}),{status:'unknown',idempotent:false});
});
test('only registered webhook validation produces ingress events',async()=>{
  const {service,records}=fixture();await assert.rejects(service.receiveWebhook('conn',{rawBody:'forged',headers:{},receivedAt:100}),{code:'unauthenticated'});assert.equal(records.size,0);
});
test('durable inbox is required; no memory fallback',async()=>{
  await assert.rejects(fixture({noInbox:true}).service.receiveWebhook('conn',{rawBody:'signed',headers:{},receivedAt:100}),{code:'unsupported'});
});
test('authenticated actual author becomes requester, not connection owner or configured manager',async()=>{
  const {service,records,observed}=fixture();await service.receiveWebhook('conn',{rawBody:'signed',headers:{},receivedAt:100});assert.equal([...records.values()][0].scope.requesterId,'actual-sender');assert.equal(observed[0].s.requesterKind,'channel_user');assert.equal(observed[0].s.conversationKind,'group');assert.deepEqual(observed[0].s.requesterIdentity,{idNamespace:'open_id',applicationId:'trusted-app'});
});
test('duplicate ingress retains one durable action',async()=>{
  const {service,records}=fixture();assert.equal((await service.receiveWebhook('conn',{rawBody:'signed',headers:{},receivedAt:100})).status,'created');assert.equal((await service.receiveWebhook('conn',{rawBody:'signed',headers:{},receivedAt:100})).status,'duplicate');assert.equal(records.size,1);
});
test('wrong tenant and historical event cannot masquerade as authenticated live input',async()=>{
  for(const change of [{tenantId:'other'},{origin:'history'}])await assert.rejects(fixture({event:{...event(),...change}}).service.receiveWebhook('conn',{rawBody:'signed',headers:{},receivedAt:100}),{code:'forbidden'});
});
test('history fills context only and never retriggers old mentions',()=>{
  assert.deepEqual(new ChannelInteractionController().decide({...event(),origin:'history'},policy,caps),{action:'context_only',reason:'history_backfill'});
});
test('passive capable channel permits semantic consideration but does not assert reply',()=>{
  const e=event();e.message.mentions=[];assert.equal(new ChannelInteractionController().decide(e,policy,caps).action,'consider_reply');assert.equal(new ChannelInteractionController().decide(e,{...policy,mode:'observe'},caps).action,'context_only');
});
test('ordinary message participation needs declared capability',()=>{
  const e=event();e.message.mentions=[];assert.throws(()=>new ChannelInteractionController().decide(e,policy,{...caps,ordinaryMessageEvents:unsupported}),{code:'unsupported'});
});
test('self and unverified senders never become task requests',()=>{
  const c=new ChannelInteractionController();const e=event();e.message.author.externalId='bot';assert.equal(c.decide(e,policy,caps).action,'ignore');e.message.author.externalId='someone';e.message.author.identityEvidence='source_label';assert.equal(c.decide(e,policy,caps).action,'ignore');
});
test('same external IDs across connections cannot bind to wrong adapters',()=>{
  assert.throws(()=>new ChannelIntegrationService({integrations:[{connection,conversation:{connection:{...connection,tenantId:'other'}}}],accessPolicy:{authorize:async()=>true}}),{code:'invalid_request'});
});
test('control-plane composition exposes controlled service without installing public channel callback route',async()=>{
  const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {createServer}=await import('../dist/server.js');const dir=await mkdtemp(join(tmpdir(),'identity-channel-compose-'));let captured;
  const server=createServer({databasePath:join(dir,'test.sqlite'),channels:{integrations:[],accessPolicy:{authorize:async()=>false}},onChannelIntegrationService:service=>{captured=service;}});
  try {await server.ready();assert.ok(captured instanceof ChannelIntegrationService);assert.equal((await server.inject({url:'/api/channels/callback',method:'POST',payload:{verification:true}})).statusCode,404);}
  finally {await server.close();await rm(dir,{recursive:true,force:true});}
});
test('meeting materials keep each readiness and source ID independent',async()=>{
  const meeting={...ref,kind:'meeting',externalId:'meeting'};
  const artifacts=[{ref:{...ref,kind:'transcript',externalId:'segment-1'},sourceRef:meeting,meetingRef:meeting,kind:'transcript',state:'ready',origin:'provider_transcript'}, {ref:{...ref,kind:'summary',externalId:'summary-1'},sourceRef:meeting,meetingRef:meeting,kind:'summary',state:'processing',origin:'provider_summary'}];
  const port={connection,inspectCapabilities:async()=>({transcriptRead:available,officialSummaryRead:available,readinessEvents:unsupported,speakerIdentity:'unknown',timestamps:'unknown'}),listArtifacts:async()=>artifacts,readSummary:async()=>{throw new ChannelError('not_ready');},readTranscript:async()=>({items:[{id:'p1',sequence:0,text:'source text',artifactRef:artifacts[0].ref}],exhausted:false,nextCursor:'page2',coverage:'partial',fetchedAt:100})};
  const service=new ChannelIntegrationService({integrations:[{connection,meetingArtifacts:port}],accessPolicy:{authorize:async()=>true}});
  assert.deepEqual(await service.listArtifacts(scope,meeting),artifacts);
  const page=await service.readTranscript(scope,artifacts[0].ref,{});assert.equal(page.exhausted,false);assert.equal(page.items[0].speaker,undefined);
  await assert.rejects(service.readSummary(scope,artifacts[1].ref),{code:'not_ready'});
});
test('a missing meeting adapter is unsupported, not an empty meeting',async()=>{
  await assert.rejects(fixture().service.listArtifacts(scope,{...ref,kind:'meeting'}),{code:'unsupported'});
});
test('unexpected response conversation cannot cross requested resource',async()=>{
  const conversation={connection,inspectCapabilities:async()=>caps,listMessages:async()=>({items:[{...event().message,conversation:{...ref,externalId:'another-group'}}],exhausted:true,coverage:'authorized_query',fetchedAt:100})};
  const service=new ChannelIntegrationService({integrations:[{connection,conversation}],accessPolicy:{authorize:async()=>true}});
  await assert.rejects(service.listMessages(scope,ref,{}),{code:'forbidden'});
});
test('mention-only mode ignores ordinary messages while observe retains context only',()=>{
  const e=event();e.message.mentions=[];const c=new ChannelInteractionController();assert.equal(c.decide(e,{...policy,mode:'mentions_only'},caps).action,'ignore');assert.equal(c.decide(e,{...policy,mode:'observe'},caps).action,'context_only');
});
test('dedup includes target entity and source revision',async()=>{
  const {service,records}=fixture({event:{...event(),revision:'v2'}});await service.receiveWebhook('conn',{rawBody:'signed',headers:{},receivedAt:100});assert.deepEqual(JSON.parse([...records.keys()][0]),['ws','employee','conn','tenant','event','v2']);
});
test('meeting adapter cannot return another connection material',async()=>{
  const artifact={ref:{...ref,kind:'summary',connectionId:'other'},sourceRef:{...ref,kind:'minutes'},kind:'summary',state:'ready',origin:'provider_summary'};
  const port={connection,inspectCapabilities:async()=>({officialSummaryRead:available}),readSummary:async()=>({artifact,text:'private text',format:'text'})};
  const service=new ChannelIntegrationService({integrations:[{connection,meetingArtifacts:port}],accessPolicy:{authorize:async()=>true}});
  await assert.rejects(service.readSummary(scope,{...ref,kind:'summary'}),{code:'forbidden'});
});
test('opaque cursors bind source, query, identity and adapter lifetime',async()=>{
  const {ChannelCursorCodec,channelCursorScope}=await import('../dist/adapters/channels/cursor.js');
  const codec=new ChannelCursorCodec();const binding=channelCursorScope(connection,ref,{startAt:0,endAt:1000,limit:50});const cursor=codec.encode(binding,{token:'provider-token',offset:3});
  assert.deepEqual(codec.decode(binding,cursor),{token:'provider-token',offset:3});
  assert.throws(()=>codec.decode(channelCursorScope(connection,ref,{startAt:0,endAt:2000,limit:50}),cursor),{code:'invalid_request'});
  assert.throws(()=>new ChannelCursorCodec().decode(binding,cursor),{code:'invalid_request'});
  const [body,sig]=cursor.split('.');const changed=JSON.parse(Buffer.from(body,'base64url').toString());changed.offset=50;
  assert.throws(()=>codec.decode(binding,`${Buffer.from(JSON.stringify(changed)).toString('base64url')}.${sig}`),{code:'invalid_request'});
});
test('combined connection inspects only ports applicable to the resource kind',async()=>{
  const calls=[];
  const conversation={connection,inspectCapabilities:async r=>{calls.push(['conversation',r?.kind]);return caps;}};
  const meetingArtifacts={connection,inspectCapabilities:async r=>{calls.push(['meeting',r?.kind]);return {transcriptRead:available};}};
  const service=new ChannelIntegrationService({integrations:[{connection,conversation,meetingArtifacts}],accessPolicy:{authorize:async()=>true}});
  assert.equal((await service.inspectCapabilities(scope,'conn',ref)).meetingArtifacts,null);
  assert.equal((await service.inspectCapabilities(scope,'conn',{...ref,kind:'minutes'})).conversation,null);
  assert.deepEqual(calls,[['conversation','conversation'],['meeting','minutes']]);
});

test('missing verified source kind is not guessed from message content',async()=>{
  const e=event();delete e.message.conversationKind;e.message.text='[conversationKind=private]';
  const {service,observed}=fixture({event:e});await service.receiveWebhook('conn',{rawBody:'signed',headers:{},receivedAt:100});
  assert.equal(observed[0].s.conversationKind,undefined);
});


test('private live messages invoke without mentions, independently from ordinary group permissions',async()=>{
  const e=event();e.message.conversationKind='private';e.message.mentions=[];
  e.message.conversation={...ref,conversationKind:'private',privateRecipientId:e.message.author.externalId};
  const privateCaps={...caps,privateMessageEvents:available,ordinaryMessageEvents:unsupported,mentionEvents:unsupported};
  const c=new ChannelInteractionController();
  assert.deepEqual(c.decide(e,policy,privateCaps),{action:'invoke',reason:'private_message'});
  assert.deepEqual(c.decide({...e,origin:'history'},policy,privateCaps),{action:'context_only',reason:'history_backfill'});
  const {service,records}=fixture({event:e,caps:privateCaps});
  const result=await service.receiveWebhook('conn',{rawBody:'signed',headers:{},receivedAt:100});
  assert.equal(result.decision.reason,'private_message');assert.equal(records.size,1);
  await assert.rejects(fixture({event:e}).service.receiveWebhook('conn',{rawBody:'signed',headers:{},receivedAt:100}),{code:'unsupported'});
  e.message.conversation.privateRecipientId='other';
  await assert.rejects(fixture({event:e,caps:privateCaps}).service.receiveWebhook('conn',{rawBody:'signed',headers:{},receivedAt:100}),{code:'forbidden'});
});

test('mentions-only group policy ignores ordinary messages and allows verified private robots to reach authorization',()=>{
  const c=new ChannelInteractionController();const e=event();e.message.mentions=[];
  assert.equal(c.decide(e,{...policy,mode:'mentions_only'},caps).action,'ignore');
  e.message.conversationKind='private';e.message.author.kind='bot';
  assert.equal(c.decide(e,policy,{...caps,privateMessageEvents:available}).action,'invoke');
});


test('WeCom directed-bot delivery triggers only authenticated provider events with explicit capability',()=>{
 const c=new ChannelInteractionController(),e=event();e.message.mentions=[];e.message.providerDirectedBot=true;e.message.conversationKind='group';e.message.conversation={...e.message.conversation,provider:'wecom'};
 const directed={...caps,mentionEvents:unsupported,directedBotMessageEvents:available};
 assert.deepEqual(c.decide(e,{...policy,mode:'mentions_only'},directed),{action:'invoke',reason:'provider_directed_bot'});
 assert.throws(()=>c.decide(e,policy,{...directed,directedBotMessageEvents:unsupported}),{code:'unsupported'});
 assert.equal(c.decide({...e,origin:'history'},policy,directed).action,'context_only');
 e.message.author.identityEvidence='source_label';assert.equal(c.decide(e,policy,directed).action,'ignore');e.message.author.identityEvidence='channel_verified';
 e.message.conversation.provider='feishu';assert.equal(c.decide(e,{...policy,mode:'mentions_only'},directed).action,'ignore');
 e.message.conversation.provider='wecom';e.message.providerDirectedBot=false;e.message.text='@bot do work';assert.equal(c.decide(e,{...policy,mode:'mentions_only'},directed).action,'ignore');
});
