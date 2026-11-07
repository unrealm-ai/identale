import test from'node:test';
import assert from'node:assert/strict';
import{mkdtemp,rm}from'node:fs/promises';
import{tmpdir}from'node:os';
import{join}from'node:path';
import{createHash}from'node:crypto';
import{Store}from'../dist/store.js';
import{JsonlJournal}from'@dentity/runtime-builtin';
import{SqliteTaskRepository}from'../dist/adapters/sqlite/task-repository.js';
import{GroupSharingConfiguration}from'../dist/group-sharing/configuration.js';
import{GroupHistoryService}from'../dist/group-sharing/history.js';
import{sharingSources,sharingAllows,sharingTargetKey,ChannelError}from'@dentity/application';
import{FeishuConversationAdapter}from'../dist/adapters/channels/feishu.js';
import{groupHistoryPermission}from'../dist/employee-channels/service.js';
const group=(id,extra={})=>({provider:'feishu',connectionId:'connection',appId:'app',tenantId:'tenant',bindingVersion:'binding',kind:'group',id,label:id,...extra});
const person=(id,extra={})=>({...group(id,extra),kind:'person',namespace:'open_id'});
const rule=(sources,targets=[],extra={})=>({id:'r',revision:1,name:'Explicit rule',enabled:true,type:targets.length?'directed':'mutual',sources:sources.map(x=>group(x)),targets:targets.map(x=>typeof x==='string'?group(x):x),...extra});
const snapshot=(destination,rules=[],extra={})=>({version:1,revision:1,workspaceId:'workspace',entityId:'employee',destination:typeof destination==='string'?group(destination):destination,sources:sharingSources(rules,typeof destination==='string'?group(destination):destination),...extra});
test('default isolation, mutual sets, direct edges, union and independent disable; no closure',()=>{
 assert.equal(sharingAllows(snapshot('B'),group('A')),false);assert.equal(sharingAllows(snapshot('B'),group('B')),true);
 const mutual=rule(['A','B','C']);for(const d of['A','B','C']){const s=snapshot(d,[mutual]);for(const src of['A','B','C'])assert.equal(sharingAllows(s,group(src)),true);assert.equal(sharingAllows(s,group('D')),false);}
 const ab=rule(['A'],['B']),bc=rule(['B'],['C'],{id:'r2'});assert.equal(sharingAllows(snapshot('C',[ab,bc]),group('A')),false);assert.equal(sharingAllows(snapshot('A',[ab]),group('B')),false);
 const duplicate={...ab,id:'duplicate'};assert.equal(snapshot('B',[ab,duplicate]).sources[0].rules.length,2);const s=snapshot('B',[{...ab,enabled:false},duplicate]);assert.deepEqual(s.sources[0].rules,[{id:'duplicate',revision:1}]);
 const p=person('U'),direct=rule(['A'],[p]);assert.equal(sharingAllows(snapshot(p,[direct]),group('A')),true);assert.equal(sharingAllows(snapshot('U',[direct]),group('A')),false);
 for(const change of[{appId:'other'},{tenantId:'other'},{connectionId:'other'},{bindingVersion:'other'}])assert.equal(sharingAllows(snapshot('B',[ab]),group('A',change)),false);
});
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'identity-group-sharing-')),store=new Store(join(root,'isolated.sqlite'));t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
 store.run("INSERT INTO users(id,username,display_name) VALUES('synthetic-user','synthetic-user','Synthetic')");
 store.run("INSERT INTO workspaces(id,name,created_by) VALUES('workspace','Isolated','synthetic-user')");
 store.run("INSERT INTO members(id,workspace_id,user_id,role) VALUES('member','workspace','synthetic-user','member')");
 store.run("INSERT INTO entities(id,workspace_id,name,owner_member_id,created_by_member_id,own_web_use,web_use_user_id,interaction_runtime) VALUES('employee','workspace','Synthetic employee','member','member',1,'synthetic-user','builtin-interaction')");
 const repository=new SqliteTaskRepository(store);repository.insertTask('task',{workspaceId:'workspace',entityId:'employee',userId:'synthetic-user'},null,'operation','hash','read','new','snapshot','[]','{}','run',1,1);repository.insertRun('run','task','session',1);
 const record={id:'connection',workspaceId:'workspace',entityId:'employee',provider:'feishu',enabled:true,status:'verified',appId:'app',eventTenantId:'tenant',revision:1,authRevision:1,stateVersion:1};
 let current=true,calls=0,handler=async()=>({items:[],exhausted:true,coverage:'authorized_query',fetchedAt:1000000000});
 const binding={provider:'feishu',connectionId:'connection',appId:'app',workspaceId:'workspace',entityId:'employee',bindingVersion:'binding',connection:{provider:'feishu',workspaceId:'workspace',connectionId:'connection',tenantId:'tenant',identity:{kind:'bot',externalId:'bot'},credentialRef:'private-fixture'},conversation:{async listMessages(ref,q){calls++;return handler(ref,q);},async listJoinedGroups(){return{items:[{id:'A',name:'Group A'},{id:'B',name:'Group B'}]};}}};
 const channels={repository:{byId:id=>id==='connection'?record:undefined,list:()=>[record]},currentBindingVersion:()=>current?'binding':undefined,resolveBinding:async()=>binding,resolveHistoryBinding:async()=>binding};
 const journal=new JsonlJournal({root:join(root,'journal'),ownerId:store.databaseId,serialize:fn=>store.transaction(fn)});
 const configuration=new GroupSharingConfiguration(store,channels,'synthetic-selection-secret',()=>1000000000),service=new GroupHistoryService(store,configuration,()=>1000000000,journal);
 return{store,journal,configuration,service,channels,record,get calls(){return calls;},handler(fn){handler=fn;},invalidate(){current=false;},auth(destination,rules=[],extra={}){return{task:{id:'task',workspace_id:'workspace',entity_id:'employee'},runId:'run',snapshot:snapshot(destination,rules,extra)};},activate(auth){return auth;}};
}
test('configuration proofs, CAS, cross-employee scope and audit; forged ref fields ignored',async t=>{
 const f=await fixture(t),a=f.configuration.issue('workspace','employee',group('A')),b=f.configuration.issue('workspace','employee',group('B'));
 const input={expectedRevision:0,rules:[{name:'A and B',enabled:true,type:'mutual',sources:[a,{...b,ref:group('EVIL')}],targets:[]}]};const saved=f.configuration.save('workspace','employee','synthetic-user',input);assert.equal(saved.rules[0].sources[1].id,'B');assert.equal(saved.revision,1);assert.equal(f.store.one('SELECT count(*) n FROM audit').n,1);
 assert.throws(()=>f.configuration.save('workspace','employee','synthetic-user',input),{code:'sharing_rules_changed'});assert.throws(()=>f.configuration.selection('workspace','other',a),{code:'invalid_sharing_selection'});assert.throws(()=>f.configuration.selection('workspace','employee',{...a,proof:a.proof+'x'}));
 const cross=f.configuration.issue('workspace','employee',group('C',{appId:'other'}));assert.throws(()=>f.configuration.save('workspace','employee','synthetic-user',{expectedRevision:1,rules:[{name:'Invalid',enabled:true,type:'directed',sources:[a],targets:[cross]}]}));
 const view=f.configuration.view('workspace','employee');f.invalidate();assert.equal(f.configuration.view('workspace','employee').rules[0].available,false);
 const r=view.rules[0];assert.equal(f.configuration.save('workspace','employee','synthetic-user',{expectedRevision:1,rules:[{id:r.id,name:r.name,enabled:false,type:r.type,sources:r.sources,targets:r.targets}]}).rules[0].enabled,false,'stale rules can be disabled');
});
const message=(id,text='message',at=999999000)=>({id,conversation:{provider:'feishu',connectionId:'connection',tenantId:'tenant',kind:'conversation',externalId:'A'},author:{kind:'human',identityEvidence:'source_label',externalId:'user'},occurredAt:at,text,mentions:[]});
const ref=g=>createHash('sha256').update(sharingTargetKey(group(g))).digest('hex');
test('bounded pages bind run/source/query, deduplicate and carry accurate exclusive time boundaries',async t=>{
 const f=await fixture(t),auth=f.activate(f.auth('B',[rule(['A'],['B'])]));let n=0;f.handler(async(_r,q)=>{n++;return n===1?{items:[message('1'),message('2','end',1000000000)],nextCursor:'provider-private',exhausted:false,coverage:'authorized_query',fetchedAt:1000000000}:{items:[message('1'),message('3')],exhausted:true,coverage:'partial',warnings:['non-text omitted'],fetchedAt:1000000000};});
 const a=await f.service.read(auth,{groupRef:ref('A'),startAt:999990000,endAt:1000000000,limit:5});assert.equal(a.messages.length,1);assert.equal(a.exhausted,false);assert.ok(a.nextCursor);assert.equal(JSON.stringify(a).includes('provider-private'),false);
 await assert.rejects(f.service.read({...auth,runId:'other'},{groupRef:ref('A'),cursor:a.nextCursor}),{code:'history_run_inactive'});
 await assert.rejects(f.service.read(auth,{groupRef:ref('A'),cursor:a.nextCursor,limit:6}),{code:'history_cursor_invalid'});
 await assert.rejects(f.service.read(auth,{groupRef:ref('B'),cursor:a.nextCursor}),{code:'history_cursor_invalid'});
 const b=await f.service.read(auth,{groupRef:ref('A'),cursor:a.nextCursor});assert.deepEqual(b.messages.map(m=>m.id),['3']);assert.equal(b.exhausted,true);assert.equal(b.coverage,'partial');assert.deepEqual(await f.service.read(auth,{groupRef:ref('A'),cursor:a.nextCursor}),b);assert.equal(f.calls,2,'repeated continuation replays stored page');
 assert.equal(f.store.one('SELECT count(*) n FROM group_history_reads').n,2);assert.equal(f.store.one('SELECT pages FROM group_history_run_budget').pages,2);
 for(const q of[{groupRef:ref('A'),startAt:1234},{groupRef:ref('A'),url:'https://evil'},{groupRef:ref('A'),limit:51},{groupRef:ref('A'),principal:'admin'}])await assert.rejects(f.service.read(auth,q),{code:'invalid_history_query'});
});
test('source lineage prevents A→B→C laundering, survives restart, employee changes and rebindings',async t=>{
 const f=await fixture(t),ab=f.activate(f.auth('B',[rule(['A'],['B'])]));f.handler(async()=>({items:[message('a')],exhausted:true,coverage:'authorized_query',fetchedAt:1000000000}));await f.service.read(ab,{groupRef:ref('A')});
 const second=new GroupHistoryService(f.store,f.configuration,()=>1000000000,f.journal);
 await assert.rejects(second.read(f.auth('C',[rule(['B'],['C'])]),{groupRef:ref('B')}),{code:'history_derived_source_forbidden'});
 await assert.rejects(second.read(f.auth('C',[rule(['B'],['C'])],{entityId:'other-employee'}),{groupRef:ref('B')}),{code:'history_derived_source_forbidden'});
 const both=f.auth('C',[rule(['A','B'],['C'])]);assert.equal((await second.read(both,{groupRef:ref('B')})).messages.length,1);
 assert.equal(second.list(f.auth('C',[rule(['B'],['C'])])).items.some(g=>g.groupRef===ref('B')),false);
});
test('budgets, denial, binding changes, in-flight serialization, and provider failures are explicit',async t=>{
 const f=await fixture(t),auth=f.activate(f.auth('B',[rule(['A'],['B'])]));await assert.rejects(f.service.read(f.auth('C'),{groupRef:ref('A')}),{code:'history_source_forbidden'});
 let release;f.handler(()=>new Promise(resolve=>{release=resolve;}));const first=f.service.read(auth,{groupRef:ref('A')});await new Promise(r=>setImmediate(r));await assert.rejects(f.service.read(auth,{groupRef:ref('A')}),{code:'history_read_in_progress'});release({items:[message('1','x'.repeat(65000))],exhausted:false,nextCursor:'more',coverage:'authorized_query',fetchedAt:1000000000});const clipped=await first;assert.equal(clipped.truncated,true);assert.equal(clipped.exhausted,false);assert.equal(clipped.coverage,'partial');assert.equal(clipped.messages.length,0);
 f.handler(async()=>{throw new ChannelError('rate_limited');});await assert.rejects(f.service.read(auth,{groupRef:ref('A')}),{status:429,code:'rate_limited'});
 f.invalidate();await assert.rejects(f.service.read(auth,{groupRef:ref('A')}),{code:'sharing_binding_changed'});
});
test('history capability requires tenant evidence for both group and one base scope',()=>{
 const entry=(scope,identity='tenant',status='granted')=>({scope,identity,status}),record=rows=>({validation:{checks:[{id:'scope_inventory',scopeInventory:rows}]}});
 assert.equal(groupHistoryPermission(record([entry('im:message.group_msg'),entry('im:message:readonly')])),true);
 for(const rows of[[],[entry('im:message.group_msg')],[entry('im:message.group_msg'),entry('im:message:readonly','user')],[entry('im:message.group_msg'),entry('im:message:readonly'),entry('im:message:readonly','tenant','denied')]])assert.equal(groupHistoryPermission(record(rows)),false);
});
test('late cancellation and newly inherited source restrictions fence data before publication',async t=>{
 const f=await fixture(t),auth=f.auth('C',[rule(['B'],['C'])]);let release;f.handler(()=>new Promise(r=>{release=r;}));const pending=f.service.read(auth,{groupRef:ref('B')});await new Promise(r=>setImmediate(r));
 // Another task has just read A into B while this provider request was in flight.
 const scopeKey=JSON.stringify(['workspace','feishu','tenant','group','','B']);f.store.run('INSERT INTO group_sharing_lineage VALUES(?,?)',scopeKey,JSON.stringify([group('A')]));release({items:[message('m','must not escape')],exhausted:true,coverage:'authorized_query',fetchedAt:1000000000});await assert.rejects(pending,{code:'history_derived_source_forbidden'});assert.equal(f.store.one('SELECT count(*) n FROM group_history_reads').n,0);
 const other=f.auth('B',[rule(['A'],['B'])]);f.handler(()=>new Promise(r=>{release=r;}));const canceled=f.service.read(other,{groupRef:ref('A')});await new Promise(r=>setImmediate(r));f.store.run("UPDATE tasks SET status='canceled' WHERE id='task'");release({items:[message('m')],exhausted:true,coverage:'authorized_query',fetchedAt:1000000000});await assert.rejects(canceled,{code:'history_run_inactive'});assert.equal(f.store.one('SELECT count(*) n FROM group_history_reads').n,0);
});

test('a topic task does not gain the entire originating chat; explicit external group sources remain available',async t=>{
 const f=await fixture(t),auth=f.auth('B',[rule(['A'],['B'])],{destinationThreadId:'trusted-topic'}),list=f.service.list(auth);assert.equal(sharingAllows(auth.snapshot,group('B')),false);assert.deepEqual(list.items.map(g=>g.groupRef),[ref('A')]);await assert.rejects(f.service.read(auth,{groupRef:ref('B')}),{code:'history_source_forbidden'});
});

test('new verified topic grant lists its thread, parent group and direct sources without expanding legacy scopes',async t=>{
 const f=await fixture(t),proof={threadId:'trusted-topic',chatId:'B',messageId:'trusted-input'},auth=f.auth('B',[rule(['A'],['B'])],{destinationThreadId:'trusted-topic',topicRead:proof});
 const contexts=f.service.list(auth).items;assert.equal(sharingAllows(auth.snapshot,group('B')),true);assert.deepEqual(contexts.map(x=>x.type),['thread','group','group']);assert.ok(contexts.find(x=>x.type==='group'&&x.groupRef===ref('B')));assert.ok(contexts.find(x=>x.groupRef===ref('A')));
 const thread=contexts.find(x=>x.type==='thread');assert.notEqual(thread.groupRef,ref('B'));let seen;f.handler(async(r,q)=>{seen={r,q};return{items:[{...message('thread-message'),threadId:'trusted-topic'}],exhausted:true,coverage:'authorized_query',fetchedAt:1000000000};});
 assert.equal((await f.service.read(auth,{groupRef:thread.groupRef})).messages.length,1);assert.equal(seen.r.externalId,'B');assert.equal(seen.q.threadId,'trusted-topic');
 const wrong=f.auth('B',[],{destinationThreadId:'trusted-topic',topicRead:{...proof,chatId:'other'}});assert.equal(sharingAllows(wrong.snapshot,group('B')),false);assert.equal(f.service.list(wrong).items.length,0);
});
