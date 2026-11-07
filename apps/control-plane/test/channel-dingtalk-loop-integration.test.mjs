import {normalizeChannelIngressEvent} from '../dist/adapters/channels/ingress/normalize.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {createHmac} from 'node:crypto';
import {Store} from '../dist/store.js';
import {SqliteConversationRepository} from '../dist/adapters/sqlite/conversation-repository.js';
import {SqliteTaskRepository} from '../dist/adapters/sqlite/task-repository.js';
import {SqliteMessageLoopRepository} from '../dist/channel-loop/repository.js';
import {createBuiltinInteractionProvider} from '../dist/adapters/builtin-interaction-provider.js';
import {DingTalkBotConversationAdapter} from '../dist/adapters/channels/dingtalk.js';
import {ChannelMessageLoop,TaskService,createInteractionService} from '@dentity/application';
import {JsonlJournal} from '@dentity/runtime-builtin';

// Only the provider HTTP endpoint and model output are local fixtures. The callback
// authentication, real DingTalk adapter, message loop, runtime and SQLite are exercised.
async function fixture(t){
 let now=1800000000000;const requests=[],models=[];
 const http=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;requests.push({url:req.url,headers:req.headers,body:JSON.parse(raw)});res.setHeader('content-type','application/json');res.end(JSON.stringify({processQueryKey:`accepted-${requests.length}`}));});
 await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
 const local=`http://127.0.0.1:${http.address().port}`;
 const dir=mkdtempSync(join(tmpdir(),'identity-ding-loop-')),store=new Store(join(dir,'app.sqlite'));
 store.run("INSERT INTO users VALUES('manager','manager','Manager','active')");store.run("INSERT INTO workspaces VALUES('w','WS','manager','active')");store.run("INSERT INTO members VALUES('manager-member','w','manager','owner','active')");store.run("INSERT INTO entities(id,workspace_id,name,owner_member_id,created_by_member_id,own_web_use,web_use_user_id,interaction_runtime) VALUES('e','w','Helper','manager-member','manager-member',1,'manager','builtin-interaction')");
 const journal=new JsonlJournal({root:join(dir,'records'),ownerId:'fixture',serialize:fn=>store.transaction(fn)}),conversations=new SqliteConversationRepository(store,journal,()=>now);conversations.initialize(0);
 const auth={authorizeEntity(){},async refreshAuthorization(){}};
 const taskRuntime={idempotentDispatch:true,async dispatch(){throw new Error('no task expected');},async input(){throw new Error('no task expected');},async cancel(){throw new Error('no task expected');},async events(){return[];}};
 const tasks=new TaskService(new SqliteTaskRepository(store),()=>now,taskRuntime,auth,undefined,conversations);
 const provider=createBuiltinInteractionProvider(store,conversations,tasks,()=>now,{getRuntimeDefinition(){return{name:'Helper',description:'Local fixture',interactionRuntime:'builtin-interaction'};}},{journal,readAdmittedInput:id=>store.one('SELECT input_text FROM channel_inbox WHERE id=?',id)?.input_text??(()=>{throw Error('missing admitted fixture input');})(),modelClient:{async complete(input){models.push(input);return{text:'fixture reply',usage:{inputTokens:3,outputTokens:3}};}}});
 const interaction=createInteractionService(conversations,tasks,provider,()=>now);
 const connection={workspaceId:'w',connectionId:'ding-connection',provider:'dingtalk',tenantId:'corp',identity:{kind:'bot',externalId:'bot-id'},credentialRef:'fixture-only'};
 const adapter=new DingTalkBotConversationAdapter(connection,{appId:'app-key',robotCode:'distinct-robot-code',trustedHttpsBoundary:true,mentionEventsGranted:true,privateMessageEventsGranted:true,proactiveSendGranted:true,now:()=>now,resolveCredential:async(_c,p)=>p==='webhook_app_secret'?'fixture-secret':'fixture-token',fetch:async(url,init)=>{const actual=new URL(url);assert.equal(actual.origin,'https://api.dingtalk.com');return fetch(local+actual.pathname+actual.search,init);}});
 const binding={connectionId:connection.connectionId,workspaceId:'w',entityId:'e',provider:'dingtalk',appId:'app-key',bindingVersion:'1',enabled:true,identity:{tenantId:'corp',tenantIdNamespace:'corp_id'},connection,policy:{entityMentionId:'bot-id',ownSenderIds:['bot-id']},conversation:adapter,webhook:adapter};
 const connections={async resolveBinding(){return binding;},currentBindingVersion(){return'1';},async authorizeInvocation(_binding,actor){assert.equal(actor.applicationId,'app-key');assert.equal(actor.idNamespace,'user_id');assert.equal(actor.identityEvidence,'channel_verified');}};
 const repo=new SqliteMessageLoopRepository(store),loop=new ChannelMessageLoop(repo,connections,interaction,tasks,()=>now);
 const receive=(id,type='1',at=false)=>{const body={msgId:id,chatbotCorpId:'corp',chatbotUserId:'bot-id',robotCode:'distinct-robot-code',conversationType:type,isInAtList:at,senderCorpId:'corp',senderStaffId:'staff-alice',senderId:'opaque-alice',conversationId:type==='1'?'private-conversation':'group-conversation',createAt:now,msgtype:'text',text:{content:'hello '+id},sessionWebhook:'https://attacker.invalid/not-used'};const normalized=normalizeChannelIngressEvent({connectionId:connection.connectionId,provider:'dingtalk',appId:'app-key',revision:1,authRevision:1,generation:'test'},{type:'CALLBACK',headers:{topic:'/v1.0/im/bot/messages/get',messageId:id},data:JSON.stringify(body)},{botId:'bot-id',tenantId:'corp',tenantNamespace:'corp_id',robotCode:'distinct-robot-code'},now);return normalized.kind==='ignored'?Promise.resolve({kind:'ignored'}):loop.acceptAuthenticatedEvent(connection.connectionId,normalized.event);};
 const drain=async()=>{for(let n=0;n<15;n++){await loop.tick();await new Promise(resolve=>setTimeout(resolve,3));}};
 t.after(async()=>{await loop.stop();await provider.shutdown();store.close();await new Promise(resolve=>http.close(resolve));rmSync(dir,{recursive:true,force:true});});
 return{receive,drain,store,requests,models,advance:ms=>now+=ms};
}

test('Stream-normalized DingTalk private and group mentions run the loop and preserve accepted request IDs',async t=>{
 const f=await fixture(t);
 assert.equal((await f.receive('ordinary','2',false)).kind,'ignored');await f.drain();assert.equal(f.models.length,0);assert.equal(f.requests.length,0);
 assert.equal((await f.receive('private')).status,'created');await f.drain();
 assert.equal(f.requests.length,1);assert.equal(f.requests[0].url,'/v1.0/robot/oToMessages/batchSend');
 assert.deepEqual(f.requests[0].body,{robotCode:'distinct-robot-code',userIds:['staff-alice'],msgKey:'sampleText',msgParam:'{"content":"fixture reply"}'});
 assert.equal(f.requests[0].headers['x-acs-dingtalk-access-token'],'fixture-token');
 assert.equal((await f.receive('private')).status,'duplicate');await f.drain();assert.equal(f.requests.length,1);
 assert.equal((await f.receive('group','2',true)).status,'created');await f.drain();
 assert.equal(f.requests.length,2);assert.equal(f.requests[1].url,'/v1.0/robot/groupMessages/send');
 assert.deepEqual(f.requests[1].body,{robotCode:'distinct-robot-code',openConversationId:'group-conversation',msgKey:'sampleText',msgParam:'{"content":"fixture reply"}'});
 assert.equal(f.models.length,2);
 assert.deepEqual(f.store.all('SELECT status,message_id,provider_request_id FROM channel_deliveries ORDER BY rowid').map(r=>({...r})),[{status:'unknown',message_id:null,provider_request_id:'accepted-1'},{status:'unknown',message_id:null,provider_request_id:'accepted-2'}]);
 assert.equal(f.store.one('SELECT count(*) n FROM users').n,1);
 f.advance(30001);await f.drain();assert.equal(f.requests.length,2,'accepted-but-unconfirmed sends are never replayed after their lane unblocks');
});
