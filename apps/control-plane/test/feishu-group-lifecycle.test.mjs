import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../dist/store.js';
import {SqliteGroupContext} from '../dist/channel-loop/group-context.js';
import {DiscoveredGroups} from '../dist/channel-loop/discovered-groups.js';
import {FeishuGroupLifecycle} from '../dist/channel-loop/feishu-group-lifecycle.js';

function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'feishu-group-state-')),store=new Store(join(root,'isolated.sqlite'));
 const window=new SqliteGroupContext(store),groups=new DiscoveredGroups(store);let now=1000,answer=true,queries=0,applied=0;
 const loop={membership:(...args)=>window.membership(...args)};
 let coordinator=new FeishuGroupLifecycle(store,groups,loop,()=>now);
 const b={workspaceId:'w',entityId:'e',provider:'feishu',connectionId:'c',appId:'app',bindingVersion:'v1',connection:{provider:'feishu',id:'c',tenantId:'tenant'},policy:{entityMentionId:'bot',ownSenderIds:['bot']},context:{groupListenEnabled:true,listenGeneration:0},conversation:{isBotInGroup:async ref=>{assert.equal(ref.externalId,'chat');queries++;if(answer instanceof Error)throw answer;return answer;}}};
 const msg=(id='m',at=200,mention=true)=>({kind:'message',verificationText:'fixture',candidate:{},event:{schemaVersion:1,eventId:id,connectionId:'c',tenantId:'tenant',origin:'live',receivedAt:at,message:{id,occurredAt:at,text:'Synthetic input',mentions:mention?['bot']:[],author:{externalId:'alice',kind:'human',identityEvidence:'channel_verified'},conversationKind:'group',conversation:{provider:'feishu',connectionId:'c',tenantId:'tenant',kind:'conversation',externalId:'chat',conversationKind:'group'}}}});
 const member=(id,present,at,extra={})=>({kind:'membership',chatId:'chat',present,occurredAt:at,eventId:id,...extra});
 const apply=n=>async()=>{applied++;if(n.kind==='message'){groups.record(b,n.event);if(b.context.groupListenEnabled)window.collect(b,n.event,'synthetic');}return'accepted';};
 const handle=(n,callback=apply(n),commit=fn=>store.transaction(fn))=>coordinator.handle(b,n,commit,callback);
 const present=()=>store.one('SELECT present FROM group_live_membership WHERE connection_id=? AND chat_id=?','c','chat')?.present;
 const reset=()=>{coordinator=new FeishuGroupLifecycle(store,groups,loop,()=>now);};
 const leave=()=>{window.membership('c','chat',false,100);groups.membership('c','chat',false,100);};
 t.after(()=>{window.close();store.close();rmSync(root,{recursive:true,force:true});});
 return{store,window,groups,b,msg,member,handle,present,leave,reset,get coordinator(){return coordinator;},get queries(){return queries;},get applied(){return applied;},setAnswer:v=>answer=v,advance:v=>now+=v};
}
test('normal group messages keep the original no-query chain; only listening discovers ordinary groups',async t=>{
 const f=fixture(t);await f.handle(f.msg('ordinary',200,false));assert.equal(f.queries,0);assert.equal(f.groups.list(f.b,{}).items.length,1);assert.equal(f.store.one('SELECT count(*) n FROM group_live_messages').n,1);
 f.b.context.groupListenEnabled=false;const n=f.msg('not-listened',300,false);n.event.message.conversation.externalId='other';await f.handle(n);assert.equal(f.queries,0);assert.equal(f.groups.list(f.b,{}).items.length,1);
});
for(const kind of ['mention','ordinary','join'])test(`left group recovers only after current bot verification: ${kind}`,async t=>{
 const f=fixture(t);f.leave();const n=kind==='join'?f.member('join',true,200):f.msg(kind,200,kind==='mention');assert.equal(await f.handle(n),'accepted');assert.equal(f.queries,1);assert.equal(f.present(),1);assert.equal(f.groups.list(f.b,{}).items[0].available,true);assert.equal(f.applied,kind==='join'?0:1);assert.equal(f.window.canSend('c','chat'),true);
 if(kind!=='join')assert.equal(f.store.one('SELECT count(*) n FROM group_live_messages').n,1);
 assert.equal(await f.handle(n),'duplicate');assert.equal(f.queries,1);
});
test('old messages and non-listening ordinary messages cannot reactivate a left group',async t=>{
 const f=fixture(t);f.leave();assert.equal(await f.handle(f.msg('old',99)),'ignored');assert.equal(f.queries,0);f.b.context.groupListenEnabled=false;
 await f.handle(f.msg('ordinary',200,false));assert.equal(f.queries,0);assert.equal(f.present(),0);assert.equal(f.groups.list(f.b,{}).items.length,0);
});
test('false verification preserves unavailable state and refuses current message',async t=>{
 const f=fixture(t);f.leave();f.setAnswer(false);assert.equal(await f.handle(f.msg()),'ignored');assert.equal(f.present(),0);assert.equal(f.applied,0);assert.equal(f.groups.list(f.b,{}).items[0].available,false);
});
test('verification failure is durable across recreation and current message is processed after recovery',async t=>{
 const f=fixture(t);f.leave();f.setAnswer(new Error('synthetic network failure'));const n=f.msg();await f.handle(n);assert.equal(f.present(),0);assert.equal(f.applied,0);assert.equal(f.coordinator.pending().length,0);f.advance(30000);f.reset();const pending=f.coordinator.pending();assert.equal(pending.length,1);assert.equal(f.store.one('SELECT reason FROM feishu_group_evidence').reason,'membership_verification_pending');f.setAnswer(true);await f.handle(JSON.parse(pending[0].payload));assert.equal(f.applied,1);assert.equal(f.present(),1);assert.equal(f.coordinator.pending().length,0);
});
test('late lifecycle events use current membership and cannot roll current state backwards',async t=>{
 const f=fixture(t);f.leave();await f.handle(f.msg('new',300));await f.handle(f.member('late-leave',false,150));assert.equal(f.present(),1);assert.equal(f.window.canSend('c','chat'),true);f.setAnswer(false);await f.handle(f.member('new-leave',false,400));assert.equal(f.present(),0);await f.handle(f.member('late-join',true,200));assert.equal(f.present(),0);
});
test('disband is durable and never resurrected by old joins or later messages',async t=>{
 const f=fixture(t);await f.handle(f.member('disband',false,300,{disbanded:true}));assert.equal(f.present(),0);f.reset();await f.handle(f.member('join',true,400));await f.handle(f.msg('later',500));assert.equal(f.queries,0);assert.equal(f.applied,0);assert.equal(f.groups.list(f.b,{}).items[0].available,false);
});
test('binding loss during verification cannot commit activation',async t=>{
 const f=fixture(t);f.leave();let lost=false;f.b.conversation.isBotInGroup=async()=>{lost=true;return true;};await assert.rejects(f.handle(f.msg(),undefined,fn=>{if(lost)throw Error('binding changed');return f.store.transaction(fn);}),/binding changed/);assert.equal(f.present(),0);assert.equal(f.applied,0);
});
test('persisted event after activation but before message admission is resumed once without another query',async t=>{
 const f=fixture(t);f.leave();const n=f.msg();await assert.rejects(f.handle(n,async()=>{throw Error('crash before admission');}),/crash before admission/);assert.equal(f.present(),1);assert.equal(f.applied,0);f.advance(30000);f.reset();await f.handle(n);assert.equal(f.applied,1);assert.equal(f.queries,1);
});
test('DingTalk and WeCom bypass the Feishu lifecycle completely',async t=>{
 const f=fixture(t);for(const provider of ['dingtalk','wecom']){f.b.provider=provider;await f.handle(f.msg(provider));}assert.equal(f.queries,0);assert.equal(f.applied,2);assert.equal(f.store.one('SELECT count(*) n FROM feishu_group_evidence').n,0);
});

test('duplicate pending delivery respects persisted backoff and never pretends admission occurred',async t=>{
 const f=fixture(t);f.leave();f.setAnswer(Error('synthetic limit'));const n=f.msg();await f.handle(n);await f.handle(n);assert.equal(f.queries,1);assert.equal(f.applied,0);assert.equal(f.present(),0);f.advance(30000);await f.handle(n);assert.equal(f.queries,2);assert.equal(f.applied,0);
});
test('concurrent messages serialize recovery and retain both original inputs without repeated verification',async t=>{
 const f=fixture(t);f.leave();await Promise.all([f.handle(f.msg('one',200)),f.handle(f.msg('two',201))]);assert.equal(f.queries,1);assert.equal(f.applied,2);assert.equal(f.store.one('SELECT count(*) n FROM group_live_messages').n,2);assert.equal(f.present(),1);
});
test('an unavailable membership capability never restores a legacy left group',async t=>{
 const f=fixture(t);f.leave();delete f.b.conversation.isBotInGroup;await f.handle(f.msg());assert.equal(f.present(),0);assert.equal(f.applied,0);f.advance(30000);assert.equal(f.coordinator.pending().length,1);
});

test('authenticated leave fences sending before its asynchronous current-state verification settles',async t=>{
 const f=fixture(t);f.window.membership('c','chat',true,100);let release,entered;const started=new Promise(r=>entered=r);f.b.conversation.isBotInGroup=async()=>{entered();return new Promise(r=>release=r);};const pending=f.handle(f.member('leave',false,200));await started;assert.equal(f.window.canSend('c','chat'),false);release(false);await pending;assert.equal(f.present(),0);
});
