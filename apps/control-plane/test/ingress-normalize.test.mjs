import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeChannelIngressEvent as normalize,ingressReplyTarget,ingressMessageText} from '../dist/adapters/channels/ingress/normalize.js';
const session = provider => ({provider,connectionId:'conn',appId:'app',generation:'gen',revision:1,authRevision:1});
const fsHints = {botId:'bot',tenantId:'tenant',tenantNamespace:'tenant_key'};
function feishu() { return {schema:'2.0',header:{event_type:'im.message.receive_v1',event_id:'event',app_id:'app',tenant_key:'tenant'},event:{sender:{sender_type:'user',sender_id:{open_id:'person'},tenant_key:'tenant'},message:{message_id:'message',chat_id:'chat',chat_type:'group',message_type:'text',create_time:'123',content:JSON.stringify({text:'@_user_1 nonce'}),mentions:[{key:'@_user_1',id:{open_id:'bot'}}]}}}; }
function ding(change={}) { return {type:'CALLBACK',headers:{topic:'/v1.0/im/bot/messages/get',messageId:'frame'},data:JSON.stringify({msgId:'message',chatbotCorpId:'corp',chatbotUserId:'bot',robotCode:'not-app-key',senderCorpId:'corp',senderStaffId:'staff',senderId:'encrypted-staff',conversationType:'2',conversationId:'chat',msgtype:'text',text:{content:' nonce '},createAt:123,isInAtList:true,...change})}; }
test('Feishu preserves raw business text, sender scope and genuine bot mention verification',()=>{
 const result=normalize(session('feishu'),feishu(),fsHints,1000);
 assert.equal(result.kind,'message'); assert.equal(result.verificationText,'nonce');
 assert.equal(result.event.message.text,'@_user_1 nonce'); assert.deepEqual(result.event.message.mentions,['bot']);
 assert.equal(result.event.message.author.applicationId,'app'); assert.equal(result.candidate.tenantNamespace,'tenant_key');
});
test('Feishu private needs no mention, other bots and ambiguous placeholders cannot verify',()=>{
 const raw=feishu(); raw.event.message.chat_type='p2p'; delete raw.event.message.mentions;
 assert.equal(normalize(session('feishu'),raw,fsHints).event.message.conversationKind,'private');
 raw.event.message.chat_type='group'; raw.event.message.mentions=[{key:'@_user_1',id:{open_id:'other'}}];
 const other=normalize(session('feishu'),raw,fsHints); assert.deepEqual(other.event.message.mentions,[]); assert.equal(other.verificationText,'@_user_1 nonce');
 raw.event.message.mentions.push({key:'@_user_1',id:{open_id:'bot'}});
 assert.equal(normalize(session('feishu'),raw,fsHints).verificationText,'@_user_1 nonce');
});
test('Feishu checks original envelope header, rejects malicious header override and mismatch',()=>{
 for (const [field,value] of [['app_id','other'],['tenant_key','other'],['event_id','other'],['event_type','unknown']]) {
  const raw=feishu(); raw.event[field]=value; assert.throws(()=>normalize(session('feishu'),raw,fsHints));
 }
 for (const field of ['app_id','tenant_key']) {const raw=feishu(); raw.header[field]='other'; assert.throws(()=>normalize(session('feishu'),raw,fsHints));}
 const raw=feishu(); raw.event.sender.tenant_key='other'; assert.throws(()=>normalize(session('feishu'),raw,fsHints));
});
test('Feishu display_id is not tenant_key, and missing bot is never fabricated',()=>{
 const result=normalize(session('feishu'),feishu(),{botId:'bot',tenantId:'display',tenantNamespace:'display_id'});
 assert.equal(result.candidate.tenantId,'tenant');
 assert.deepEqual(normalize(session('feishu'),feishu()),{kind:'ignored',reason:'bot_identity_unavailable'});
});
test('unknown sender and bot events never assert human channel identity',()=>{
 const raw=feishu(); raw.event.sender.sender_type='app'; assert.equal(normalize(session('feishu'),raw,fsHints).event.message.author.kind,'bot');
 raw.event.sender.sender_type='unexpected'; assert.throws(()=>normalize(session('feishu'),raw,fsHints),{code:'unauthenticated'});
 raw.event.sender.sender_type='user'; delete raw.event.sender.sender_id.open_id; assert.throws(()=>normalize(session('feishu'),raw,fsHints),{code:'unauthenticated'});
 assert.throws(()=>normalize(session('dingtalk'),ding({senderStaffId:undefined})),{code:'unauthenticated'});
 assert.equal(normalize(session('dingtalk'),ding({senderId:'bot'})).kind,'ignored');
});
test('Ding CALLBACK retains distinct event and message IDs, actual bot/corp/robot candidate',()=>{
 const result=normalize(session('dingtalk'),ding(),{},1000);
 assert.equal(result.event.eventId,'frame'); assert.equal(result.event.message.id,'message');
 assert.equal(result.candidate.robotCode,'not-app-key'); assert.equal(result.candidate.appId,'app');
 assert.equal(result.event.message.author.externalId,'staff'); assert.equal(result.event.message.author.idNamespace,'user_id');
 assert.equal(result.event.message.text,' nonce '); assert.equal(result.verificationText,'nonce');
 assert.deepEqual(result.event.message.mentions,['bot']);
});
test('Ding private targets staffId; non-mention group stays non-triggering',()=>{
 const direct=normalize(session('dingtalk'),ding({conversationType:'1',isInAtList:false}));
 assert.equal(direct.event.message.conversation.privateRecipientId,'staff'); assert.deepEqual(direct.event.message.mentions,[]);
 const group=normalize(session('dingtalk'),ding({isInAtList:false})); assert.equal(group.event.message.conversation.privateRecipientId,undefined); assert.deepEqual(group.event.message.mentions,[]);
});
test('Ding rejects wrong installation, foreign staff scope, spoofed app and EVENT frames',()=>{
 for (const hints of [{botId:'other'},{robotCode:'other'},{tenantId:'other',tenantNamespace:'corp_id'}]) assert.throws(()=>normalize(session('dingtalk'),ding(),hints));
 for (const change of [{senderCorpId:'foreign'},{appId:'other'},{appKey:'other'},{conversationType:'3'}]) assert.throws(()=>normalize(session('dingtalk'),ding(change)));
 const raw=ding(); raw.type='EVENT'; assert.throws(()=>normalize(session('dingtalk'),raw));
 raw.type='CALLBACK'; raw.headers.topic='*'; assert.throws(()=>normalize(session('dingtalk'),raw));
});
test('bounded payload, identity, schema and timestamp validation fail closed',()=>{
 const raw=feishu(); raw.schema='1.0'; assert.throws(()=>normalize(session('feishu'),raw,fsHints));
 raw.schema='2.0'; raw.header.event_id='x'.repeat(257); assert.throws(()=>normalize(session('feishu'),raw,fsHints));
 assert.throws(()=>normalize(session('dingtalk'),ding({text:{content:'x'.repeat(1024*1024)}})));
 assert.throws(()=>normalize(session('dingtalk'),ding({createAt:'NaN'})));
 assert.throws(()=>normalize(session('dingtalk'),ding({msgId:'bad\nidentifier'})));
});
test('unsupported nontext is not an interaction; directed Ding image is metadata-only',()=>{
 const raw=feishu(); raw.event.message.message_type='audio'; assert.deepEqual(normalize(session('feishu'),raw,fsHints),{kind:'ignored',reason:'unsupported_message_type'});
 const image=normalize(session('dingtalk'),ding({msgtype:'image'}));assert.equal(image.kind,'group_record');assert.equal(image.event.message.text,'[图片]');assert.equal(image.verificationText,undefined);assert.equal(normalize(session('dingtalk'),ding({msgtype:'image',isInAtList:false})).kind,'ignored');
});

test('identity fallback recovers original target without inventing a sender, and rejects unsafe routes',()=>{
 const raw=feishu();delete raw.event.sender.sender_id.open_id;
 assert.throws(()=>normalize(session('feishu'),raw,fsHints));const route=ingressReplyTarget(session('feishu'),raw,fsHints);assert.equal(route.conversation.externalId,'chat');assert.equal(route.messageId,'message');assert.equal(ingressMessageText('feishu',raw),'@_user_1 nonce');
 for(const change of ['foreign-app','foreign-tenant','missing-chat','self','unmentioned','nontext']){const v=feishu();if(change==='foreign-app')v.header.app_id='foreign';if(change==='foreign-tenant')v.header.tenant_key='foreign';if(change==='missing-chat')delete v.event.message.chat_id;if(change==='self')v.event.sender.sender_id.open_id='bot';if(change==='unmentioned')v.event.message.mentions=[];if(change==='nontext')v.event.message.message_type='audio';assert.equal(ingressReplyTarget(session('feishu'),v,fsHints),undefined,change);}
 raw.event.message.content='malformed message content';assert.equal(ingressMessageText('feishu',raw),'malformed message content');assert.equal(ingressReplyTarget(session('feishu'),raw,fsHints).messageId,'message');
});


test('Feishu keeps all mention names and key mappings without changing bot trigger IDs or raw text',()=>{
 const raw=feishu();raw.event.message.content=JSON.stringify({text:'@_user_1 @_user_2 你好'});raw.event.message.mentions=[{key:'@_user_1',id:{open_id:'bot'},name:'机器人A'},{key:'@_user_2',id:{open_id:'another'},name:'机器人B'}];
 const result=normalize(session('feishu'),raw,fsHints);assert.deepEqual(result.event.message.mentions,['bot']);assert.deepEqual(result.event.message.mentionDetails,[{key:'@_user_1',id:'bot',name:'机器人A'},{key:'@_user_2',id:'another',name:'机器人B'}]);assert.equal(result.event.message.text,'@_user_1 @_user_2 你好');
});

test('Feishu bot-only membership events use authenticated app/tenant and chat, never operator as bot',()=>{
 for(const [event_type,present]of [['im.chat.member.bot.added_v1',true],['im.chat.member.bot.deleted_v1',false]]){const raw={schema:'2.0',header:{event_type,event_id:'membership-event',app_id:'app',tenant_key:'tenant',create_time:'1800000000000000'},event:{chat_id:'chat',operator_id:{open_id:'human-operator'}}};assert.deepEqual(normalize(session('feishu'),raw,fsHints),{kind:'membership',chatId:'chat',present,occurredAt:1800000000000,eventId:'membership-event'});raw.header.app_id='other';assert.throws(()=>normalize(session('feishu'),raw,fsHints));}
 const ordinary={schema:'2.0',header:{event_type:'im.chat.member.user.deleted_v1'},event:{chat_id:'chat'}};assert.equal(normalize(session('feishu'),ordinary,fsHints).kind,'ignored');
});

test('plain root/parent reply is not a thread and supported rich events preserve thread identity',()=>{const raw=feishu();raw.event.message.root_id='root-message';raw.event.message.parent_id='parent-message';const result=normalize(session('feishu'),raw,fsHints);assert.equal(result.kind,'message');assert.equal(result.event.message.threadId,undefined);assert.equal(result.event.message.replyToMessageId,'parent-message');assert.equal(result.event.message.rootMessageId,'root-message');raw.event.message.thread_id='true-thread';assert.equal(normalize(session('feishu'),raw,fsHints).event.message.threadId,'true-thread');for(const[kind,content]of[['image',{image_key:'key'}],['file',{file_key:'key',file_name:'file.md'}],['post',{title:'',content:[[{tag:'text',text:'bold',style:['bold']}]]}]]){raw.event.message.message_type=kind;raw.event.message.content=JSON.stringify(content);const parsed=normalize(session('feishu'),raw,fsHints);assert.equal(parsed.kind,'message');assert.equal(parsed.event.message.threadId,'true-thread');}});

test('five Feishu message types share parser across private/group/thread and trusted mentions remain independent from body',()=>{for(const chat of ['p2p','group'])for(const thread of [undefined,'real-thread'])for(const[type,content]of[['text',{text:'@机器人 [微笑]'}],['post',{title:'',content_v2:[[{tag:'text',text:'**heading**'},{tag:'img',image_key:'key'}]]}],['image',{image_key:'key'}],['file',{file_key:'key',file_name:'资料.md'}],['video_chat',{topic:'会议',meet_number:'123',start_time:'100',end_time:'200'}]]){const raw=feishu();raw.event.message.chat_type=chat;raw.event.message.message_type=type;raw.event.message.content=JSON.stringify(content);raw.event.message.mentions=[];if(thread)raw.event.message.thread_id=thread;const result=normalize(session('feishu'),raw,fsHints);assert.equal(result.kind,'message');assert.equal(result.event.message.content.kind,type);assert.deepEqual(result.event.message.mentions,[]);assert.equal(result.event.message.author.externalId,'person');assert.equal(result.event.message.threadId,thread);}});

test('Feishu disband event retains trusted event identity and optional name',()=>{const raw={schema:'2.0',header:{event_type:'im.chat.disbanded_v1',event_id:'disband',app_id:'app',tenant_key:'tenant',create_time:'1800000000000'},event:{chat_id:'chat',name:'Synthetic group'}};assert.deepEqual(normalize(session('feishu'),raw,fsHints),{kind:'membership',chatId:'chat',present:false,occurredAt:1800000000000,eventId:'disband',name:'Synthetic group',disbanded:true});raw.header.tenant_key='other';assert.throws(()=>normalize(session('feishu'),raw,fsHints));});
