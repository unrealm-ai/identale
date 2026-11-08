import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../dist/store.js';
import {TaskArtifacts} from '../dist/task-artifacts.js';
import {SqliteMessageLoopRepository} from '../dist/channel-loop/repository.js';

for(const provider of ['feishu','dingtalk','wecom'])test(`${provider} logical artifact/selection/target dedupes multiple outputs and covered inputs across restart without replaying unknown receipts`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'identity-artifact-identity-')),store=new Store(join(root,'isolated.sqlite'));let queue=new SqliteMessageLoopRepository(store,()=>1000);
 t.after(async()=>{queue.close();store.close();await rm(root,{recursive:true,force:true});});
 const candidate=(id,name)=>({content:{resourceId:'artifact:'+id.repeat(64),version:'b'.repeat(64)},availability:'available',name,mediaType:'text/plain',size:1,kind:'file'});
 const a=candidate('a','result.txt'),b=candidate('c','result.txt'),runtime={artifacts:()=>[a,b]};let artifacts=new TaskArtifacts(store,{},runtime);
 const select=(op,turn,refs)=>store.run('INSERT INTO task_artifact_selections VALUES(?,?,?,?,?,?)',op,'conversation',turn,'task','run',JSON.stringify(refs));select('selection','turn',[a.content.resourceId]);store.run('INSERT INTO task_artifact_selection_inputs VALUES(?,?)','selection','covered-turn');
 const scope={workspaceId:'w',entityId:'e',principal:{kind:'channel',channelType:provider,tenantId:'tenant',identityNamespace:'open_id',externalUserId:'person'},source:{channelType:provider,tenantId:'tenant',installationId:'app',applicationId:'app',connectionId:'connection',bindingVersion:'1',conversationId:'group',conversationKind:'group'}};
 const target={conversation:{provider,connectionId:'connection',tenantId:'tenant',kind:'conversation',externalId:'group',conversationKind:'group'}};
 const base={id:'output-one',scopeJson:JSON.stringify(scope),targetJson:JSON.stringify(target),text:'Reply',status:'queued',taskDeliveryId:null,leaseToken:null};
 const enqueue=(id,turn='turn',destination=target)=>artifacts.enqueue(queue,{...base,id,targetJson:JSON.stringify(destination)},'conversation',turn,1000);
 const rows=()=>store.all('SELECT * FROM channel_deliveries ORDER BY rowid');
 enqueue('output-one');enqueue('output-two');enqueue('event-replay');enqueue('covered-output','covered-turn');assert.equal(rows().length,1,'Same selected artifact is not sent once per visible output');enqueue('covered-another-reply','covered-turn',{...target,replyToMessageId:'another-message-in-same-chat'});assert.equal(rows().length,1,'A different reply anchor in the same destination is not a new selected attachment');const first=rows()[0];
 // A distinct explicitly selected candidate is distinct even with the same bytes/name.
 select('second-selection','turn',[b.content.resourceId]);enqueue('output-three');assert.equal(rows().length,2);
 const reordered={conversation:{conversationKind:'group',externalId:'group',kind:'conversation',tenantId:'tenant',connectionId:'connection',provider}};enqueue('reordered-target','turn',reordered);assert.equal(rows().length,2,'Object key order is not a new destination');
 enqueue('another-destination','turn',{conversation:{...target.conversation,externalId:'other-group'}});assert.equal(rows().length,4,'Actual destinations retain separate delivery identity');
 store.run("UPDATE channel_deliveries SET status='unknown' WHERE id=?",first.id);store.run("UPDATE channel_message_receipts SET status='unknown' WHERE id=? AND kind='outbox'",first.id);
 queue.close();queue=new SqliteMessageLoopRepository(store,()=>2000);artifacts=new TaskArtifacts(store,{},runtime);enqueue('after-restart');assert.equal(rows().length,4);assert.equal(store.one('SELECT status FROM channel_deliveries WHERE id=?',first.id).status,'unknown');
 // Technical cleanup may retain the durable receipt after removing the payload.
 store.run('DELETE FROM channel_deliveries WHERE id=?',first.id);enqueue('after-payload-cleanup');assert.equal(rows().length,3);assert.equal(store.one("SELECT status FROM channel_message_receipts WHERE id=? AND kind='outbox'",first.id).status,'unknown');
 select('new-explicit-turn','next-turn',[a.content.resourceId]);enqueue('new-request','next-turn');assert.equal(rows().length,4,'A later explicit selection remains a new logical request');
});
