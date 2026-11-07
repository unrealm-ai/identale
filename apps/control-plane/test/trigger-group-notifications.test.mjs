import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHmac,createHash} from 'node:crypto';
import Fastify from 'fastify';
import {ChannelError} from '@dentity/application';
import {Store} from '../dist/store.js';
import {createServer} from '../dist/server.js';
import {DiscoveredGroups} from '../dist/channel-loop/discovered-groups.js';
import {NotificationTargetCodec,messagePreview} from '../dist/notifications/targets.js';
import {registerNotificationCatalog} from '../dist/notifications/catalog.js';
import {TriggerResultNotifications,resultNotice} from '../dist/notifications/trigger-results.js';
import {SqliteMessageLoopRepository} from '../dist/channel-loop/repository.js';
import {normalizeChannelIngressEvent} from '../dist/adapters/channels/ingress/normalize.js';
import {FeishuConversationAdapter} from '../dist/adapters/channels/feishu.js';
import {DingTalkBotConversationAdapter} from '../dist/adapters/channels/dingtalk.js';
import {WeComConversationAdapter} from '../dist/adapters/channels/wecom.js';
import {ingressFixture} from './helpers/ingress-fixture.mjs';
const codec=new NotificationTargetCodec('synthetic-test-signing-key');
const binding=(provider='dingtalk',extra={})=>({workspaceId:'w',entityId:'e',connectionId:'c',appId:'app',provider,bindingVersion:'v1',enabled:true,connection:{workspaceId:'w',provider,connectionId:'c',tenantId:'tenant',identity:{kind:'bot',externalId:'bot'},credentialRef:'server-only'},policy:{entityMentionId:'bot',ownSenderIds:['bot']},...extra});
function event(b,extra={}){const message={id:'msg1',conversation:{provider:b.provider,connectionId:b.connectionId,tenantId:b.connection.tenantId,kind:'conversation',externalId:'group',conversationKind:'group'},conversationKind:'group',author:{externalId:'person',kind:'human',identityEvidence:'channel_verified'},mentions:['bot'],text:'Hello',occurredAt:100,...extra};return{connectionId:b.connectionId,tenantId:b.connection.tenantId,eventId:'ev-'+message.id,origin:'live',message};}
async function storage(t){const root=await mkdtemp(join(tmpdir(),'id-notify-')),store=new Store(join(root,'test.sqlite'));t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});return store;}
test('mention catalog records only live verified @this bot groups; duplicate, order, rename and scopes',async t=>{
 const store=await storage(t),g=new DiscoveredGroups(store),b=binding();
 for(const e of [event(b,{conversationKind:'private'}),event(b,{mentions:['other']}),{...event(b),origin:'history'},event(b,{author:{kind:'bot',externalId:'other'}})])g.record(b,e);
 assert.equal(g.list(b,{}).items.length,0);
 g.record(b,event(b,{conversationTitle:'研发群',text:'a\n b'}));g.record(b,event(b,{text:'replay',occurredAt:999}));
 assert.equal(g.list(b,{}).items[0].preview,'a b');
 g.record(b,event(b,{id:'msg2',occurredAt:200,text:'new',conversationTitle:'新群名'}));g.record(b,event(b,{id:'old',occurredAt:1,text:'old'}));
 const row=g.list(b,{}).items[0];assert.equal(row.preview,'new');assert.equal(row.name,'新群名');
 for(const changed of [{workspaceId:'other'},{entityId:'other'},{appId:'other'},{bindingVersion:'v2'},{connection:{...b.connection,tenantId:'other'}}])assert.equal(g.list({...b,...changed},{}).items.length,0);
 g.membership('c','group',false,300);assert.equal(g.list(b,{}).items[0].available,false);g.record(b,event(b,{id:'earlier',occurredAt:250}));assert.equal(g.list(b,{}).items[0].available,false);g.record(b,event(b,{id:'returned',occurredAt:400}));assert.equal(g.list(b,{}).items[0].available,true);
});
test('missing names retained, Feishu never looks up names, WeCom provider-directed group; 80 graphemes',async t=>{
 const store=await storage(t),groups=new DiscoveredGroups(store),b=binding('feishu');groups.record(b,event(b,{text:'@_user_1\n'+('👩🏽‍💻'.repeat(81)),mentionDetails:[{id:'bot',key:'@_user_1'}],conversationTitle:'untrusted'}));
 const r=groups.list(b,{}).items[0];assert.equal(r.name,null);assert.equal(r.preview,'👩🏽‍💻'.repeat(80)+'…');
 assert.equal(messagePreview('\n  '),'@了数字员工');assert.equal(messagePreview('api_key=synthetic'),'[已隐藏]');
 const wc=binding('wecom');groups.record(wc,event(wc,{id:'wc',mentions:[],providerDirectedBot:true}));assert.equal(groups.list(wc,{}).items[0].preview,'Hello');
});
test('Feishu asset previews never include internal asset IDs, raw payload or paths',async t=>{
 const store=await storage(t),groups=new DiscoveredGroups(store),b=binding('feishu');
 groups.record(b,event(b,{text:'[分享图片 asset_id=internal-id]',content:{kind:'image',blocks:[[{type:'asset',asset:{kind:'image',resourceKey:'secret-resource',assetId:'internal-id'}}]]}}));assert.equal(groups.list(b,{}).items[0].preview,'[图片]');
 groups.record(b,event(b,{id:'file',occurredAt:200,content:{kind:'file',blocks:[[{type:'asset',asset:{kind:'file',resourceKey:'secret-resource',name:'/Users/private/report.pdf'}}]]}}));assert.equal(groups.list(b,{}).items[0].preview,'[文件] report.pdf');
});
test('group discovery pagination keyset is workspace/application/filter-bound',async t=>{
 const store=await storage(t),g=new DiscoveredGroups(store),b=binding();for(let i=0;i<35;i++){const e=event(b,{id:'m'+i,occurredAt:i+1});e.message.conversation.externalId='g'+i;g.record(b,e);}
 const a=g.list(b,{}),z=g.list(b,{cursor:a.nextCursor});assert.equal(a.items.length,30);assert.equal(z.items.length,5);assert.equal(new Set([...a.items,...z.items].map(x=>x.id)).size,35);
 for(const other of [binding('dingtalk',{workspaceId:'other'}),binding('dingtalk',{bindingVersion:'v2'})])assert.throws(()=>g.list(other,{cursor:a.nextCursor}),{code:'invalid_group_cursor'});
 assert.throws(()=>g.list(b,{cursor:a.nextCursor,q:'x'}),{code:'invalid_group_cursor'});
});
test('signed selection never trusts client ID/label, tamper/cross-employee/cursor fail closed',()=>{
 const raw={kind:'group',provider:'feishu',connectionId:'c',appId:'a',tenantId:'t',bindingVersion:'v',id:'g',label:'Group'},s=codec.issue('w','e',raw);
 assert.equal(codec.read('w','e',{...s,id:'evil'}).id,'g');assert.equal(codec.list('w','e',[s,s]).length,1);
 assert.throws(()=>codec.read('w','other',s));assert.throws(()=>codec.read('w','e',{proof:s.proof+'x'}));assert.throws(()=>codec.read('w','e',raw));
 const c=codec.cursor('scope','provider-page-token');assert.equal(codec.readCursor('scope',c),'provider-page-token');assert.throws(()=>codec.readCursor('other',c));
});
test('unsupported media stays discovery-only; supported WeCom images carry opaque content and transient download capabilities',()=>{
 const session={provider:'dingtalk',connectionId:'c',appId:'app',generation:'g',revision:1,authRevision:1};
 const row={msgId:'m',chatbotCorpId:'corp',chatbotUserId:'bot',robotCode:'robot',senderCorpId:'corp',senderStaffId:'staff',senderId:'staff',conversationType:'2',conversationId:'group',conversationTitle:'研发',msgtype:'picture',createAt:100,isInAtList:true};
 const normalize=r=>normalizeChannelIngressEvent(session,{type:'CALLBACK',headers:{topic:'/v1.0/im/bot/messages/get',messageId:'ev'},data:JSON.stringify(r)});
 assert.equal(normalize(row).kind,'group_record');assert.equal(normalize(row).event.message.text,'[图片]');assert.equal(normalize({...row,isInAtList:false}).kind,'ignored');assert.equal(normalize({...row,conversationType:'1'}).kind,'ignored');
 const w=normalizeChannelIngressEvent({...session,provider:'wecom'},{cmd:'aibot_msg_callback',headers:{req_id:'r'},body:{msgid:'m',aibotid:'app',from:{userid:'u',corpid:'corp'},chattype:'group',chatid:'g',msgtype:'image',image:{url:'not-retained'}}},{botId:'app',tenantId:'corp',tenantNamespace:'corp_id'},100);
 assert.equal(w.kind,'message');assert.equal(w.event.message.content.kind,'image');assert.equal(w.media.length,1);assert.equal(JSON.stringify(w.event).includes('not-retained'),false);
});
test('platform Feishu catalog calls platform adapter, runtime other-provider relay, no alternate Feishu runtime path',async t=>{
 let calls=0,relays=0,fail=false,relayFail=false;const b=binding('feishu',{conversation:{async listJoinedGroups(q){calls++;if(fail==='permission')throw new ChannelError('forbidden');if(fail)throw Error('provider unavailable');return{items:[{id:'g',name:'研发群'}],...(q.cursor?{}:{nextCursor:'opaque-provider'})};}}});
 const records=[{id:'c',provider:'feishu',appId:'app',status:'verified',enabled:true},{id:'d',provider:'dingtalk',appId:'ding',status:'verified',enabled:true}];
 const channels={repository:{list:()=>records},resolveBinding:async id=>id==='c'?b:{...binding(),connectionId:'d'},currentBindingVersion:()=>b.bindingVersion};
 const app=Fastify();registerNotificationCatalog(app,{channels,codec,role:'platform',manager:r=>{if(r.headers['x-test']!=='manager')throw Object.assign(Error('forbidden'),{statusCode:403});return'actor';},relay:async(actor,path)=>{assert.equal(actor,'actor');assert.match(path,/connectionId=d/);relays++;if(relayFail)throw Error('runtime offline');return{items:[],coverage:'mentions_only'};}});t.after(()=>app.close());
 const url='/api/workspaces/w/entities/e/notification-groups';assert.equal((await app.inject({url:url+'?connectionId=c'})).statusCode,403);
 const get=u=>app.inject({url:u,headers:{'x-test':'manager'}});let r=await get(url+'?connectionId=c');assert.equal(r.statusCode,200,r.body);assert.equal(r.json().items[0].name,'研发群');const cursor=r.json().nextCursor;assert.equal((await get(url+'?connectionId=c&cursor='+encodeURIComponent(cursor))).statusCode,200);assert.equal(calls,2);assert.equal(relays,0);
 await get(url+'?connectionId=d');assert.equal(relays,1);fail=true;assert.equal((await get(url+'?connectionId=c')).statusCode,503);fail='permission';assert.equal((await get(url+'?connectionId=c')).statusCode,409);relayFail=true;assert.equal((await get(url+'?connectionId=d')).statusCode,503);
 const runtime=Fastify();registerNotificationCatalog(runtime,{channels,codec,role:'runtime',manager:()=> 'actor'});t.after(()=>runtime.close());assert.equal((await runtime.inject({url:url+'?connectionId=c'})).statusCode,400);
});
test('three actual adapters send proactive group targets, Feishu pagination, no private API fallback',async()=>{
 const sent=[];const ref=p=>({provider:p,connectionId:'c',tenantId:'tenant',kind:'conversation',conversationKind:'group',externalId:'group'});
 const response=x=>new Response(JSON.stringify(x),{headers:{'content-type':'application/json'}});
 const fs=new FeishuConversationAdapter(binding('feishu').connection,{appId:'app',grants:{proactiveSend:true},resolveCredential:async()=> 'synthetic-token',fetch:async(url,init)=>{const u=new URL(url);sent.push([u.pathname,init?.body]);if(u.pathname.endsWith('/chats'))return response({code:0,data:{items:[{chat_id:'g',name:'Name'}],has_more:false}});return response({code:0,data:{message_id:'sent'}});}});
 assert.equal((await fs.listJoinedGroups({})).items[0].name,'Name');await fs.sendMessage({conversation:ref('feishu'),text:'Notice',operationId:'id'});assert.equal(JSON.parse(sent.at(-1)[1]).receive_id,'group');
 const ding=new DingTalkBotConversationAdapter(binding().connection,{appId:'app',robotCode:'robot',proactiveSendGranted:true,resolveCredential:async()=> 'synthetic-token',fetch:async(url,init)=>{sent.push([new URL(url).pathname,init?.body]);return response({processQueryKey:'receipt'});}});await ding.sendMessage({conversation:ref('dingtalk'),text:'Notice',operationId:'id'});assert.equal(sent.at(-1)[0],'/v1.0/robot/groupMessages/send');assert.equal(JSON.parse(sent.at(-1)[1]).openConversationId,'group');
 const wc=new WeComConversationAdapter(binding('wecom').connection,{send:async request=>{assert.equal(request.conversation.externalId,'group');assert.equal(request.replyToMessageId,undefined);return{status:'accepted',providerRequestId:'req',idempotent:false};}});assert.equal((await wc.sendMessage({conversation:ref('wecom'),text:'Notice',operationId:'id'})).status,'accepted');
});
test('public final notice excludes raw thinking, local paths and common credential syntax',()=>{const s=resultNotice('Job','succeeded','<think>private</think>done /Users/test/file api_key=synthetic');assert.equal(s.includes('private'),false);assert.equal(s.includes('/Users'),false);assert.equal(s.includes('synthetic'),false);assert.match(s,/done/);});

// Full production HTTP -> trusted signed Trigger -> Task/Run -> durable outbox ->
// actual Feishu adapter. Only external HTTP/SDK/runtime are synthetic fixtures.
test('signed Hook and schedule create null-Conversation tasks; multi-group delivery survives restart and independent failure/retry',async t=>{
 const root=await mkdtemp(join(tmpdir(),'id-notify-e2e-')),databasePath=join(root,'app.sqlite'),origin='http://127.0.0.1:5173',masterKey=Buffer.alloc(32,17),secret='Synthetic-notification-webhook-secret-32bytes';let now=Date.now(),loop,tasks,triggers;const ingress=ingressFixture(),sent=[],attempts=new Map();
 const providerFetch=async(url,init={})=>{const u=new URL(url),body=init.body?JSON.parse(init.body):null;assert.equal(u.origin,'https://open.feishu.cn');const res=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json'}});if(u.pathname.includes('tenant_access_token'))return res({code:0,tenant_access_token:'fixture-access',expire:7200});if(u.pathname.endsWith('/chats'))return res({code:0,data:{items:[{chat_id:'good',name:'研发群'},{chat_id:'bad',name:'不可达群'},{chat_id:'retry',name:'暂时限流群'},{chat_id:'unknown',name:'发送待核对群'}],has_more:false}});if(u.pathname.endsWith('/messages')){assert.equal(u.searchParams.get('receive_id_type'),'chat_id');const n=(attempts.get(body.receive_id)??0)+1;attempts.set(body.receive_id,n);if(body.receive_id==='bad')return res({code:99991672,msg:'forbidden'},403);if(body.receive_id==='retry'&&n===1)return res({code:99991400,msg:'rate limited'},429);sent.push(body);return res({code:0,data:body.receive_id==='unknown'?{}:{message_id:'out'+sent.length}});}assert.fail('Unexpected provider request '+u.pathname);};
 const app=createServer({databasePath,origin,now:()=>now,pollIntervalMs:0,triggers:{automatic:false,allowLoopbackHttp:true},modelProfiles:{masterKey},channelIngressFactory:ingress.factory,onService:s=>tasks=s,onTriggerService:s=>triggers=s,onChannelMessageLoop:s=>loop=s,modelClient:{async complete(){throw Error('No model call allowed in result notification');}},runtime:{idempotentDispatch:true,async dispatch(){return{status:'accepted'};},async input(){return{status:'received'};},async cancel(){return{status:'confirmed'};},async events(){return[];}},employeeChannels:{masterKey,fetch:providerFetch,verifyApplication:async()=>({identity:{appId:'app',tenantId:'tenant',tenantIdNamespace:'tenant_key'},botId:'bot',eventTenantId:'tenant',directoryStatus:'available'})}});await app.ready();
 const store=new Store(databasePath),outbox=new SqliteMessageLoopRepository(store,()=>now),publisher=new TriggerResultNotifications(store,outbox,new NotificationTargetCodec(masterKey.toString('base64')),()=>{});t.after(async()=>{outbox.close();store.close();await app.close();await rm(root,{recursive:true,force:true});});
 const call=(method,url,payload,cookie)=>app.inject({method,url,headers:{origin,...(cookie?{cookie}:{})},...(payload===undefined?{}:{payload})});const reg=await call('POST','/api/auth/register',{username:'notify-owner',password:'Synthetic-password-2026!'});assert.equal(reg.statusCode,201,reg.body);const cookie=reg.headers['set-cookie'].split(';')[0],w=reg.json().workspace.id;const e=(await call('POST','/api/workspaces/'+w+'/entities',{name:'Notification employee',ownWebUse:true},cookie)).json().entity.id,base=`/api/workspaces/${w}/entities/${e}`;
 const connected=await call('PUT',base+'/channels/feishu',{appId:'app',appSecret:'Synthetic-secret',expectedRevision:0},cookie);assert.equal(connected.statusCode,200,connected.body);const c=connected.json();
 const catalog=await call('GET',base+'/notification-groups?connectionId='+c.id,undefined,cookie);assert.equal(catalog.statusCode,200,catalog.body);const targets=catalog.json().items;
 const config={name:'Hook report',type:'webhook',enabled:true,allowedActions:['create_task'],config:{adapter:'generic',notificationTargets:[...targets,targets[0]]},credential:{keyId:'test',secret}};
 const saved=await call('POST',base+'/triggers',config,cookie);assert.equal(saved.statusCode,200,saved.body);const b=saved.json();assert.equal(b.config.notificationTargets.length,4);
 const body=JSON.stringify({version:1,eventId:'event',action:'create_task',description:'Release checks'}),path='/api/triggers/webhook/'+b.id,stamp=String(now),signature=createHmac('sha256',secret).update(['v1','POST',path,stamp,createHash('sha256').update(body).digest('hex')].join('\n')).digest('hex');
 const send=()=>app.inject({method:'POST',url:path,payload:body,headers:{'content-type':'application/json','x-key-id':'test','x-timestamp':stamp,'x-signature':signature}});const accepted=await send();assert.equal(accepted.statusCode,202,accepted.body);assert.equal((await send()).statusCode,200);const task=store.one('SELECT * FROM tasks WHERE id=?',accepted.json().taskId);assert.equal(task.conversation_id,null);assert.equal(store.one('SELECT count(*) n FROM trigger_notification_targets').n,1);
 await tasks.tick();tasks.ingest(task.run_id,{runId:task.run_id,eventId:'final',sequence:1,type:'final_result',text:'Checks passed',inputRevision:task.input_revision});publisher.discover(now);assert.equal(store.one('SELECT count(*) n FROM trigger_result_notifications').n,0,'final reply without confirmed terminal state is not published');tasks.ingest(task.run_id,{runId:task.run_id,eventId:'success',sequence:2,type:'status',status:'succeeded'});
 publisher.discover(now);publisher.discover(now);assert.equal(store.one('SELECT count(*) n FROM trigger_result_notifications').n,4);
 const restarted=new TriggerResultNotifications(store,outbox,new NotificationTargetCodec(masterKey.toString('base64')),()=>{});restarted.discover(now);assert.equal(store.one('SELECT count(*) n FROM channel_deliveries').n,4);
 await loop.tick();await loop.waitForWork();now+=5000;await loop.tick();await loop.waitForWork();
 const statuses=store.all("SELECT json_extract(n.target_json,'$.conversation.externalId') id,r.status FROM trigger_result_notifications n JOIN channel_message_receipts r ON r.id=n.id AND r.kind='outbox'");assert.deepEqual(Object.fromEntries(statuses.map(x=>[x.id,x.status])),{good:'sent',bad:'failed',retry:'sent',unknown:'unknown'});assert.equal(attempts.get('good'),1);assert.equal(attempts.get('retry'),2);now+=40000;await loop.tick();await loop.waitForWork();assert.equal(attempts.get('unknown'),1,'unknown sends never automatically repeat');assert.equal(store.one('SELECT status FROM tasks WHERE id=?',task.id).status,'succeeded');assert.equal(store.one('SELECT count(*) n FROM tasks').n,1);
 const events=(await call('GET',base+'/triggers/'+b.id+'/events',undefined,cookie)).json().events;assert.equal(events[0].notifications.length,4);
 const old=await call('PUT',base+'/triggers/'+b.id,{name:b.name,type:b.type,enabled:false,allowedActions:b.allowedActions,config:{adapter:'generic'},expectedVersion:b.version},cookie);assert.equal(old.statusCode,200,old.body);assert.equal(old.json().config.notificationTargets.length,4,'old clients preserve targets');
 const schedule=await call('POST',base+'/triggers',{name:'Schedule report',type:'schedule',enabled:true,config:{cron:'0 9 * * *',timezone:'Asia/Shanghai',description:'Daily checks',notificationTargets:[targets[0]]}},cookie);assert.equal(schedule.statusCode,200,schedule.body);const s=schedule.json();const occurrence=await triggers.occurrence({triggerId:s.id,bindingVersion:s.version,scheduledAt:now,receivedAt:now});assert.ok(occurrence.taskId);assert.equal(store.one('SELECT count(*) n FROM trigger_notification_targets').n,2);
 const st=store.one('SELECT * FROM tasks WHERE id=?',occurrence.taskId);await tasks.tick();tasks.ingest(st.run_id,{runId:st.run_id,eventId:'schedule-failure',sequence:1,type:'status',status:'failed'});publisher.discover(now);await loop.tick();await loop.waitForWork();assert.equal(store.one('SELECT count(*) n FROM trigger_result_notifications').n,5);assert.equal(attempts.get('good'),2);assert.match(JSON.parse(sent.at(-1).content).text,/执行失败/);
 now+=60000;const fenced=await triggers.occurrence({triggerId:s.id,bindingVersion:s.version,scheduledAt:now,receivedAt:now});await tasks.tick();const ft=store.one('SELECT * FROM tasks WHERE id=?',fenced.taskId);tasks.ingest(ft.run_id,{runId:ft.run_id,eventId:'fenced-terminal',sequence:1,type:'status',status:'failed'});publisher.discover(now);
 const disabled=await call('PUT',base+'/channels/feishu/settings',{enabled:false,expectedRevision:c.revision},cookie);assert.equal(disabled.statusCode,200,disabled.body);await loop.tick();await loop.waitForWork();assert.equal(attempts.get('good'),2,'channel revocation fences queued notifications before provider dispatch');
 const revoked=await call('POST',base+'/triggers',config,cookie);assert.equal(revoked.statusCode,409,revoked.body);
 const tampered=await call('POST',base+'/triggers',{...config,config:{adapter:'generic',notificationTargets:[{...targets[0],proof:'forged'}]}},cookie);assert.equal(tampered.statusCode,400,tampered.body);
 now+=31*86400000;await outbox.cleanupComplete();outbox.cleanup(now);await outbox.cleanupComplete();assert.equal(store.one("SELECT count(*) n FROM channel_message_receipts WHERE kind='outbox'").n,0,'technical receipts really expired');assert.equal(store.one('SELECT count(*) n FROM channel_deliveries').n,0);const login=await call('POST','/api/auth/login',{username:'notify-owner',password:'Synthetic-password-2026!'});assert.equal(login.statusCode,200,login.body);const renewed=login.headers['set-cookie'].split(';')[0];const retainedResponse=await call('GET',base+'/triggers/'+b.id+'/events',undefined,renewed);assert.equal(retainedResponse.statusCode,200,retainedResponse.body);const retained=retainedResponse.json().events[0].notifications;assert.deepEqual(Object.fromEntries(retained.map(n=>[n.groupId,n.status])),{good:'sent',bad:'failed',retry:'sent',unknown:'unknown'},'technical outbox retention must not erase business notification status');publisher.discover(now);assert.equal(store.one('SELECT count(*) n FROM channel_deliveries').n,0,'expired technical rows do not make old notifications pending again');assert.equal(attempts.get('good'),2,'retention never republishes old notifications');

});
