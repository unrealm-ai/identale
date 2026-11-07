import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
import {createServer} from '../dist/server.js';import {Store} from '../dist/store.js';import {SqliteConversationRepository} from '../dist/adapters/sqlite/conversation-repository.js';import {JsonlJournal} from '../../../packages/runtime-builtin/dist/index.js';import {ModelProfileService} from '../dist/model-profiles.js';
async function setup(t){const root=await mkdtemp(join(tmpdir(),'recent-web-contract-')),db=join(root,'data.sqlite');let clock=100000;const server=createServer({databasePath:db,origin:'http://127.0.0.1:5173',now:()=>clock,modelProfiles:{masterKey:Buffer.alloc(32,31)},directorySync:{automatic:false},triggers:{automatic:false}});await server.ready();const store=new Store(db),journal=new JsonlJournal({root:join(root,'builtin-records'),ownerId:JSON.stringify([store.databaseId,store.databasePath]),serialize:f=>store.transaction(f)}),repository=new SqliteConversationRepository(store,journal,()=>clock);
 const call=(method,url,payload,cookie)=>server.inject({method,url,headers:{origin:'http://127.0.0.1:5173',...(cookie?{cookie}:{})},...(payload?{payload}:{})});
 async function register(name){const r=await call('POST','/api/auth/register',{username:name,password:'Synthetic QA 2026!'});assert.equal(r.statusCode,201,r.body);return{...r.json(),cookie:r.headers['set-cookie'].split(';')[0]};}
 async function employee(owner,name,preset){clock++;const r=await call('POST',`/api/workspaces/${owner.workspace.id}/entities`,{name,ownWebUse:true,...(preset?{avatarPreset:preset}:{})},owner.cookie);assert.equal(r.statusCode,200,r.body);const entity=r.json().entity;new ModelProfileService(store,{masterKey:Buffer.alloc(32,31)}).save(owner.workspace.id,entity.id,{name:'Synthetic model',provider:'openai-compatible',endpoint:'https://synthetic.invalid/v1',modelId:'synthetic',apiKey:'synthetic-key'});return entity;}
 async function open(owner,entity){clock++;const r=await call('POST',`/api/workspaces/${owner.workspace.id}/entities/${entity.id}/conversations`,{mode:'real'},owner.cookie);assert.ok([200,201].includes(r.statusCode),r.body);return r.json().conversation;}
 const message=(c,text)=>{clock++;repository.addMessage(randomUUID(),repository.get(c.id),'user',text,clock,false);};
 t.after(async()=>{store.close();await server.close();await rm(root,{recursive:true,force:true});});return{call,register,employee,open,message,store,repository,journal,tick:()=>clock++};}

test('recent Web contacts are actor/workspace isolated, canonical per employee, and repeated initiation keeps one conversation',async t=>{
 const f=await setup(t),a=await f.register('recent-owner'),b=await f.register('recent-other'),e=await f.employee(a,'Owner employee','thumbs-03'),c=await f.open(a,e);f.message(c,'OWNER_PRIVATE_SENTINEL');
 for(let i=0;i<3;i++)assert.equal((await f.open(a,e)).id,c.id);assert.equal(f.store.one('SELECT count(*) n FROM conversations WHERE entity_id=?',e.id).n,1);
 const url=`/api/workspaces/${a.workspace.id}/recent-conversations`,list=await f.call('GET',url,undefined,a.cookie);assert.equal(list.statusCode,200,list.body);assert.equal(list.json().records.length,1);assert.equal(list.json().records[0].preview,'OWNER_PRIVATE_SENTINEL');assert.equal(list.json().records[0].entity.avatarPreset,'thumbs-03');
 assert.equal((await f.call('GET',url,undefined,b.cookie)).statusCode,403);assert.doesNotMatch((await f.call('GET',`/api/workspaces/${b.workspace.id}/recent-conversations`,undefined,b.cookie)).body,/OWNER_PRIVATE_SENTINEL/);
 const invite=(await f.call('POST',`/api/workspaces/${a.workspace.id}/invitations`,{},a.cookie)).json();assert.equal((await f.call('POST','/api/invitations/accept',{token:invite.token},b.cookie)).statusCode,200);
 assert.equal((await f.call('GET',url,undefined,b.cookie)).json().records.length,0,'membership and management cannot read another actor history');
 const detail=await f.call('GET',`/api/workspaces/${a.workspace.id}/entities/${e.id}/conversations/${c.id}`,undefined,b.cookie);assert.equal(detail.statusCode,404);
 const legacyId=randomUUID();f.repository.create(legacyId,{workspaceId:a.workspace.id,entityId:e.id,userId:a.user.id},'legacy:'+legacyId,f.tick(),'real',0);f.message({id:legacyId},'LEGACY_OWN_SEPARATE');const recent=(await f.call('GET',url,undefined,a.cookie)).json().records;assert.equal(recent.length,1);assert.equal(recent[0].conversation.id,c.id);assert.doesNotMatch(JSON.stringify(recent),/LEGACY_OWN_SEPARATE/);const legacy=await f.call('GET',`/api/workspaces/${a.workspace.id}/entities/${e.id}/conversations/${legacyId}`,undefined,a.cookie);assert.equal(legacy.json().canSend,false);assert.equal(legacy.json().reason,'historical_conversation_read_only');
});

test('recent pagination binds actor/workspace and freezes message/conversation watermarks during concurrent activity',async t=>{
 const f=await setup(t),a=await f.register('recent-paging'),items=[];for(let i=0;i<4;i++){const e=await f.employee(a,'Employee '+i),c=await f.open(a,e);f.message(c,'message '+i);items.push({e,c});}
 const root=`/api/workspaces/${a.workspace.id}/recent-conversations`,first=(await f.call('GET',root+'?limit=2',undefined,a.cookie)).json();assert.equal(first.records.length,2);assert.ok(first.nextCursor);assert.deepEqual(first.records.map(r=>r.preview),['message 3','message 2']);
 f.message(items[0].c,'later mutation after first page');const e=await f.employee(a,'New later employee');await f.open(a,e);
 const second=(await f.call('GET',root+'?limit=2&cursor='+encodeURIComponent(first.nextCursor),undefined,a.cookie)).json();assert.deepEqual(second.records.map(r=>r.entity.id),[items[1].e.id,items[0].e.id]);assert.equal(second.nextCursor,null);
 const fresh=(await f.call('GET',root,undefined,a.cookie)).json();assert.equal(fresh.records.length,5);assert.ok(fresh.records.find(r=>r.preview==='later mutation after first page'));
 const other=await f.register('paging-other');const bad=await f.call('GET',`/api/workspaces/${other.workspace.id}/recent-conversations?cursor=`+encodeURIComponent(first.nextCursor),undefined,other.cookie);assert.equal(bad.statusCode,400);assert.equal((await f.call('GET',root+'?cursor=bad',undefined,a.cookie)).statusCode,400);
 const plan=f.store.all('EXPLAIN QUERY PLAN SELECT id FROM conversation_message_index WHERE conversation_id=? ORDER BY created_at DESC LIMIT 1',items[0].c.id);assert.match(JSON.stringify(plan),/recent_web_messages/);
});

test('own readable history remains distinct from send permission for revocation, disabled employees and missing models',async t=>{
 const f=await setup(t),a=await f.register('recent-readonly'),e=await f.employee(a,'Read-only contact'),c=await f.open(a,e);f.message(c,'Readable own history');const base=`/api/workspaces/${a.workspace.id}/entities/${e.id}`;
 assert.equal((await f.call('PUT',base+'/web-access',{allowMemberIds:[],denyMemberIds:[]},a.cookie)).statusCode,200);
 let row=(await f.call('GET',`/api/workspaces/${a.workspace.id}/recent-conversations`,undefined,a.cookie)).json().records[0];assert.equal(row.canSend,false);assert.equal(row.reason,'entity_use_forbidden');assert.equal(row.preview,'Readable own history');assert.equal((await f.call('GET',base+`/conversations/${c.id}/messages`,undefined,a.cookie)).statusCode,200);
 assert.equal((await f.call('POST',base+`/conversations/${c.id}/turns`,{operationId:randomUUID(),text:'must not send'},a.cookie)).statusCode,403);
 await f.call('PUT',base+'/web-access',{allowMemberIds:[a.workspace.memberId],denyMemberIds:[]},a.cookie);await f.call('PUT',base+'/status',{enabled:false,expectedRevision:1},a.cookie);
 row=(await f.call('GET',`/api/workspaces/${a.workspace.id}/recent-conversations`,undefined,a.cookie)).json().records[0];assert.equal(row.reason,'employee_disabled');assert.equal(row.canSend,false);assert.equal((await f.call('GET',base+`/conversations/${c.id}`,undefined,a.cookie)).json().canSend,false);
 await f.call('PUT',base+'/status',{enabled:true,expectedRevision:2},a.cookie);f.store.run('UPDATE model_catalog SET enabled=0 WHERE workspace_id=?',a.workspace.id);
 row=(await f.call('GET',`/api/workspaces/${a.workspace.id}/recent-conversations`,undefined,a.cookie)).json().records[0];assert.equal(row.canSend,false);assert.ok(row.reason);assert.equal(f.store.one('SELECT count(*) n FROM interaction_turns').n,0);
});

test('avatar presets validate whitelist, preserve older APIs, save with basic identity, and participate in creation idempotency/rollback',async t=>{
 const f=await setup(t),a=await f.register('avatar-contract'),base=`/api/workspaces/${a.workspace.id}`,e=await f.employee(a,'Legacy caller');assert.equal(e.avatarPreset,null);
 assert.equal((await f.call('PATCH',base+'/entities/'+e.id,{avatarPreset:'https://attacker.invalid/avatar.svg'},a.cookie)).statusCode,400);
 const saved=await f.call('PATCH',base+'/entities/'+e.id,{name:'Named avatar',avatarPreset:'thumbs-12'},a.cookie);assert.equal(saved.statusCode,200);assert.equal(saved.json().entity.avatarPreset,'thumbs-12');
 const body={operationId:randomUUID(),name:'Preset creation',ownWebUse:true,avatarPreset:'thumbs-06',packages:[]};const created=await f.call('POST',base+'/employee-creations',body,a.cookie);assert.ok([200,201].includes(created.statusCode),created.body);const replay=await f.call('POST',base+'/employee-creations',body,a.cookie);assert.equal(replay.json().entity.id,created.json().entity.id);assert.equal(replay.json().entity.avatarPreset,'thumbs-06');
 assert.equal((await f.call('POST',base+'/employee-creations',{...body,avatarPreset:'thumbs-07'},a.cookie)).statusCode,409);
 const before=f.store.one('SELECT count(*) n FROM entities').n;const bad=await f.call('POST',base+'/employee-creations',{...body,operationId:randomUUID(),avatarPreset:'thumbs-01',model:{kind:'existing',profileId:'missing-profile'}},a.cookie);assert.ok(bad.statusCode>=400);assert.equal(f.store.one('SELECT count(*) n FROM entities').n,before);
 assert.equal((await f.call('POST',base+'/entities',{name:'Invalid',ownWebUse:true,avatarPreset:'thumbs-99'},a.cookie)).statusCode,400);
});

test('recent preview reads bounded SQLite excerpts without any Journal history reads, including large history and legacy cache gaps',async t=>{
 const f=await setup(t),a=await f.register('recent-bounded-preview'),e=await f.employee(a,'Large history'),c=await f.open(a,e);
 const large='HISTORY_SENTINEL_'+('历史资料'.repeat(12000));for(let i=0;i<40;i++)f.message(c,large+i);
 const original=JsonlJournal.prototype.read;let reads=0;JsonlJournal.prototype.read=function(...args){reads++;return original.apply(this,args);};
 try{const r=await f.call('GET',`/api/workspaces/${a.workspace.id}/recent-conversations`,undefined,a.cookie);assert.equal(r.statusCode,200,r.body);const row=r.json().records[0];assert.ok(row.preview.startsWith('HISTORY_SENTINEL_'));assert.equal(Array.from(row.preview).length,160);assert.equal(reads,0,'list must not read or validate full JSONL');
 assert.equal(f.store.one('SELECT count(*) n FROM web_conversation_previews WHERE conversation_id=?',c.id).n,1);assert.equal(f.store.all('PRAGMA table_info(conversation_message_index)').some(col=>col.name==='preview_excerpt'),false);f.store.run('DELETE FROM web_conversation_previews WHERE conversation_id=?',c.id);const legacy=(await f.call('GET',`/api/workspaces/${a.workspace.id}/recent-conversations`,undefined,a.cookie)).json().records[0];assert.equal(legacy.preview,null);assert.equal(legacy.previewUnavailable,true);assert.equal(reads,0,'no synchronous legacy backfill');
 }finally{JsonlJournal.prototype.read=original;}
 assert.equal(f.store.one('SELECT MAX(length(excerpt)) n FROM web_conversation_previews').n,null);
});

test('latest Web preview is one replaceable record, never a second transcript, skips demo and IM, and follows expiry',async t=>{
 const f=await setup(t),a=await f.register('latest-preview-only'),e=await f.employee(a,'Latest preview'),c=await f.open(a,e);f.message(c,'OLD_PREVIEW_MUST_BE_REPLACED');f.message(c,'LATEST_PREVIEW_ONLY');
 let rows=f.store.all('SELECT * FROM web_conversation_previews WHERE conversation_id=?',c.id);assert.equal(rows.length,1);assert.equal(rows[0].excerpt,'LATEST_PREVIEW_ONLY');assert.doesNotMatch(JSON.stringify(rows),/OLD_PREVIEW_MUST_BE_REPLACED/);assert.doesNotMatch(JSON.stringify(f.store.all('SELECT * FROM conversation_message_index')),/LATEST_PREVIEW_ONLY|OLD_PREVIEW_MUST_BE_REPLACED/);assert.deepEqual(f.repository.messages(c.id,Number.MAX_SAFE_INTEGER-1).map(m=>m.text),['OLD_PREVIEW_MUST_BE_REPLACED','LATEST_PREVIEW_ONLY']);
 const scope={workspaceId:a.workspace.id,entityId:e.id,userId:a.user.id},demo=randomUUID(),im=randomUUID();f.repository.create(demo,scope,'demo:'+demo,f.tick(),'demo',0);f.message({id:demo},'DEMO_NOT_IN_PREVIEW');f.repository.create(im,scope,'im:'+im,f.tick(),'real',0);f.store.run("UPDATE conversations SET channel='feishu' WHERE id=?",im);f.message({id:im},'IM_NOT_IN_WEB_PREVIEW');assert.equal(f.store.one('SELECT count(*) n FROM web_conversation_previews').n,1);
 const expiring=randomUUID(),at=f.tick();f.repository.create(expiring,scope,'expires:'+expiring,at,'real',at+100);f.message({id:expiring},'EXPIRES_WITH_SOURCE');assert.ok(f.store.one('SELECT conversation_id FROM web_conversation_previews WHERE conversation_id=?',expiring));f.repository.purgeExpired(at+100);assert.equal(f.store.one('SELECT conversation_id FROM web_conversation_previews WHERE conversation_id=?',expiring),undefined);
});

test('recent preview is the last public user or assistant message, never internal tool or thinking journal records',async t=>{const f=await setup(t),a=await f.register('recent-visible-only'),e=await f.employee(a,'Visible only'),c=await f.open(a,e);f.message(c,'公开用户输入');f.repository.addMessage(randomUUID(),f.repository.get(c.id),'assistant','公开回复 **完整内容**',f.tick(),false);const scope={workspaceId:a.workspace.id,entityId:e.id,conversationId:c.id};f.journal.put(scope,'event',{role:'tool',content:'INTERNAL_TOOL_SENTINEL'});f.journal.put(scope,'event',{role:'assistant',thinking:'INTERNAL_THINKING_SENTINEL'});const url=`/api/workspaces/${a.workspace.id}/recent-conversations`;let row=(await f.call('GET',url,undefined,a.cookie)).json().records[0];assert.equal(row.preview,'公开回复 **完整内容**');assert.doesNotMatch(JSON.stringify(row),/INTERNAL_TOOL|INTERNAL_THINKING/);f.message(c,'更新的用户可见消息');row=(await f.call('GET',url,undefined,a.cookie)).json().records[0];assert.equal(row.preview,'更新的用户可见消息');});

test('cn-v2 local portraits are additive stable presets and retain old identity and creation replay',async t=>{
 const f=await setup(t),a=await f.register('portrait-contract'),base=`/api/workspaces/${a.workspace.id}`,legacy=await f.employee(a,'Existing preset');
 const old=await f.call('PATCH',`${base}/entities/${legacy.id}`,{avatarPreset:'thumbs-12'},a.cookie);assert.equal(old.statusCode,200);assert.equal(old.json().entity.avatarPreset,'thumbs-12');
 const fresh=await f.employee(a,'Portrait choices');
 for(let n=1;n<=27;n++){const id=`cn-v2-${String(n).padStart(2,'0')}`,r=await f.call('PATCH',`${base}/entities/${fresh.id}`,{avatarPreset:id},a.cookie);assert.equal(r.statusCode,200,r.body);assert.equal(r.json().entity.avatarPreset,id);}
 const records=(await f.call('GET',base+'/employee-summaries',undefined,a.cookie)).json().records;assert.equal(records.find(e=>e.id===legacy.id).avatarPreset,'thumbs-12');
 const body={operationId:randomUUID(),name:'New portrait',ownWebUse:true,avatarPreset:'cn-v2-01',packages:[]};
 const first=await f.call('POST',base+'/employee-creations',body,a.cookie);assert.ok([200,201].includes(first.statusCode),first.body);
 const replay=await f.call('POST',base+'/employee-creations',body,a.cookie);assert.equal(replay.json().entity.id,first.json().entity.id);assert.equal(replay.json().entity.avatarPreset,'cn-v2-01');
 assert.equal((await f.call('POST',base+'/employee-creations',{...body,avatarPreset:'cn-v2-02'},a.cookie)).statusCode,409);
 for(const id of ['cn-v2-00','cn-v2-28','cn-v2-01.webp','../cn-v2-01','https://example.invalid/avatar.webp'])assert.equal((await f.call('PATCH',`${base}/entities/${fresh.id}`,{avatarPreset:id},a.cookie)).statusCode,400);
});
