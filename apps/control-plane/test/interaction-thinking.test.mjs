import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {JsonlJournal} from '@dentity/runtime-builtin';
import {createServer} from '../dist/server.js';
import {Store} from '../dist/store.js';
import {ModelProfileService} from '../dist/model-profiles.js';
test('profile-backed builtin fixes none and applies both controls and keeps stable private session across model revisions',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'dentity-thinking-')),path=join(dir,'test.sqlite');
 const app=createServer({databasePath:path,origin:'http://127.0.0.1:5173',pollIntervalMs:0,modelProfiles:{masterKey:Buffer.alloc(32,3)}});await app.ready();
 const db=new DatabaseSync(path);t.after(async()=>{await app.close();db.close();await rm(dir,{recursive:true,force:true});});
 const call=(method,url,payload,cookie)=>app.inject({method,url,...(payload===undefined?{}:{payload}),headers:{origin:'http://127.0.0.1:5173',...(cookie?{cookie}:{})}});
 const registered=await call('POST','/api/auth/register',{username:'thinking-user',password:'Synthetic thinking test password 2026!'});assert.equal(registered.statusCode,201,registered.body);
 const cookie=registered.headers['set-cookie'].split(';')[0],prefix=`/api/workspaces/${registered.json().workspace.id}`;
 const entity=await call('POST',prefix+'/entities',{name:'Thinking test',ownWebUse:true},cookie);assert.equal(entity.statusCode,200,entity.body);
 const base=prefix+`/entities/${entity.json().entity.id}`;
 const profile={provider:'openai-compatible',endpoint:'https://synthetic.invalid/v1',modelId:'untrusted-model-name',apiKey:'synthetic-not-a-provider-key'};
 const fixtureStore=new Store(path), profiles=new ModelProfileService(fixtureStore,{masterKey:Buffer.alloc(32,3)});
 t.after(()=>fixtureStore.close());
 const save=input=>profiles.save(registered.json().workspace.id,entity.json().entity.id,input);save(profile);
 const read=await call('GET',base+'/model-profile',undefined,cookie);assert.equal('interactionThinkingControl' in read.json().effectiveProfile,false);assert.equal('executionThinking' in read.json().effectiveProfile,false);
 const conversation=await call('POST',base+'/conversations',{mode:'real'},cookie);assert.equal(conversation.statusCode,201,conversation.body);const id=conversation.json().conversation.id;
 // Existing rows may contain any legacy declaration; they no longer select a wire policy.
 db.prepare("UPDATE model_catalog SET interaction_thinking_control='unconfigured',execution_thinking_control='unconfigured'").run();
 const requests=[];t.mock.method(globalThis,'fetch',async(url,options)=>{
  assert.equal(url,'https://synthetic.invalid/v1/chat/completions');assert.equal(options.redirect,'error');requests.push(JSON.parse(options.body));
  return Response.json({choices:[{finish_reason:'stop',message:{content:'Synthetic answer'}}],usage:{prompt_tokens:1,completion_tokens:1}});
 });
 const send=operationId=>call('POST',`${base}/conversations/${id}/turns`,{operationId,text:'hello'},cookie);
 const journal=new JsonlJournal({root:join(dir,'builtin-records'),ownerId:JSON.stringify([db.prepare('SELECT database_id FROM builtin_storage_metadata').get().database_id,fixtureStore.databasePath]),serialize:fn=>fn()});
 const sessions=[],profileRevisions=[];
 for(const index of [0,1]){
  const updated=save({...profile,apiKey:undefined,name:`Revision ${index}`});
  const started=await send(`turn-${index}`);assert.equal(started.statusCode,202,started.body);const turnId=started.json().turn.id;
  let terminal;for(let n=0;n<100;n++){const state=await call('GET',`${base}/conversations/${id}/turns/${turnId}`,undefined,cookie);assert.equal(state.statusCode,200,state.body);if(state.json().turn.status==='succeeded'){terminal=state.json().turn;break;}await new Promise(resolve=>setTimeout(resolve,2));}assert.ok(terminal);
  const requestRef=JSON.parse(db.prepare('SELECT request_ref FROM interaction_turns WHERE id=?').get(turnId).request_ref);
  const request=JSON.parse(journal.read({workspaceId:registered.json().workspace.id,entityId:entity.json().entity.id,conversationId:id},requestRef));
  const session=request.payload.session;
  assert.equal(session.scope.conversationId,id);
  assert.equal(session.configRevision,request.authorizationContext.configRevision,'Session and trusted invocation must bind the same effective model/prompt/persona configuration');
  assert.equal(session.sessionId,request.authorizationContext.sessionId);
  assert.equal(session.sessionId,request.payload.execution.sessionId);
  sessions.push(session);profileRevisions.push(updated.configRevision);
 }
 assert.notEqual(profileRevisions[0],profileRevisions[1]);
 assert.notEqual(sessions[0].configRevision,sessions[1].configRevision,'Model revision change must change effective configuration even when prompt/persona are unchanged');
 assert.equal(sessions[0].sessionId,id);assert.equal(sessions[0].sessionId,sessions[1].sessionId);assert.equal(sessions[0].opaqueHandle,sessions[1].opaqueHandle);
 assert.equal(requests.length,2);for(const body of requests){assert.equal(body.reasoning_effort,'none');assert.equal(body.enable_thinking,false);}
 assert.equal(requests[1].messages.some(m=>m.role==='assistant'),true,'Changed configuration preserves stable private model history');
});
