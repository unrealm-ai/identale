import test from 'node:test';
import {Store} from '../dist/store.js';
import {ModelProfileService} from '../dist/model-profiles.js';
import assert from 'node:assert/strict';
import {createServer as createHttpServer} from 'node:http';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer as createPlatform} from '../dist/server.js';
import {createServer as createHost} from '../../runtime-host-pi/dist/server.js';
import {PiRuntimeAdapter} from '../../runtime-host-pi/dist/adapter.js';
import {WorkerPiDriver} from '../../runtime-host-pi/dist/driver.js';
import {httpResolver} from '../../runtime-host-pi/dist/resolver.js';
const chunk=(delta,finish=null)=>`data: ${JSON.stringify({id:'synthetic-completion',object:'chat.completion.chunk',created:1,model:'synthetic-model',choices:[{index:0,delta,finish_reason:finish}]})}\n\n`;
const origin='http://127.0.0.1:5173';
async function until(predicate){const deadline=Date.now()+15000;while(Date.now()<deadline){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,15));}assert.fail('Synthetic E2E did not reach expected state within 15 seconds');}
test('offline phase2 E2E: real HTTP platform/host/resolver, worker+SDK, fake provider progress, final and durable restart',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'dentity-phase2-e2e-')),databasePath=join(dir,'platform.sqlite'),hostDirectory=join(dir,'host');
 const hostToken='synthetic-e2e-host-token-00000000000000',resolverToken='synthetic-e2e-resolver-token-000000000',fakeKey='synthetic-e2e-not-a-provider-credential';let providerCalls=0,secondRequested=false,releaseSecond;const held=new Promise(resolve=>releaseSecond=resolve);
 const provider=createHttpServer(async(request,response)=>{
  let raw='';for await(const part of request)raw+=part;const body=JSON.parse(raw);assert.equal(request.url,'/v1/chat/completions');assert.equal(request.headers.authorization,`Bearer ${fakeKey}`);assert.equal(body.model,'synthetic-model');assert.equal(body.reasoning_effort,'medium');assert.equal('enable_thinking' in body,false);providerCalls++;
  response.writeHead(200,{'content-type':'text/event-stream'});
  if(providerCalls===1){assert.ok(body.tools.some(tool=>tool.function.name==='progress_report'));response.end(chunk({tool_calls:[{index:0,id:'stage-call',type:'function',function:{name:'progress_report',arguments:JSON.stringify({text:'Stage one durably reported'})}}]})+chunk({},'tool_calls')+'data: [DONE]\n\n');}
  else{secondRequested=true;await held;response.end(chunk({content:'Offline synthetic final answer'})+chunk({},'stop')+'data: [DONE]\n\n');}
 });
 await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));const providerBase=`http://127.0.0.1:${provider.address().port}`;
 const hostOptions={token:hostToken};let host=createHost(hostOptions);await host.listen({host:'127.0.0.1',port:0});const hostPort=host.server.address().port,hostBase=`http://127.0.0.1:${hostPort}`;let service;
 const config={databasePath,origin,pollIntervalMs:0,onService:s=>service=s,runtimeHost:{url:hostBase,token:hostToken,resolverToken},modelProfiles:{masterKey:Buffer.alloc(32,5),allowLoopbackHttp:true}};
 let platform=createPlatform(config);await platform.listen({host:'127.0.0.1',port:0});const platformPort=platform.server.address().port,platformBase=`http://127.0.0.1:${platformPort}`;
 const resolver=httpResolver(platformBase+'/internal/runtime',resolverToken);hostOptions.adapter=new PiRuntimeAdapter(hostDirectory,resolver,new WorkerPiDriver());
 t.after(async()=>{releaseSecond();await platform.close();await host.close();await new Promise(resolve=>{provider.close(resolve);provider.closeAllConnections();});await rm(dir,{recursive:true,force:true});});
 const call=async(method,path,body,cookie)=>{const response=await fetch(platformBase+path,{method,headers:{origin,...(body===undefined?{}:{'content-type':'application/json'}),...(cookie?{cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,cookie:response.headers.get('set-cookie')?.split(';')[0],data:await response.json()};};
 const user=await call('POST','/api/auth/register',{username:'e2e-user',password:'Synthetic E2E password without real service!'});assert.equal(user.status,201);const cookie=user.cookie,prefix=`/api/workspaces/${user.data.workspace.id}`;
 const entity=await call('POST',prefix+'/entities',{name:'Offline E2E employee',ownWebUse:true},cookie);const base=prefix+`/entities/${entity.data.entity.id}`;
 const fixtureStore=new Store(databasePath);
 try{const profiles=new ModelProfileService(fixtureStore,config.modelProfiles);profiles.save(user.data.workspace.id,entity.data.entity.id,{provider:'openai-compatible',endpoint:providerBase+'/v1',modelId:'synthetic-model',apiKey:fakeKey});}finally{fixtureStore.close();}
 const conversation=await call('POST',base+'/conversations',{mode:'real',operationId:'e2e-conversation'},cookie);
 const taskBase=`${base}/conversations/${conversation.data.conversation.id}/tasks`;
 const input={operationId:'e2e-task',conversationId:conversation.data.conversation.id,input:'Use the synthetic progress tool then provide a synthetic final answer.'};const created=await call('POST',taskBase,input,cookie);assert.equal(created.status,202);const taskId=created.data.task.id;assert.equal(created.data.task.status,'queued');assert.equal(providerCalls,0);
 await service.tick();await until(()=>secondRequested);await service.tick();const inProgress=await call('GET',taskBase+`/${taskId}`,undefined,cookie);assert.equal(inProgress.data.task.status,'running');assert.equal(inProgress.data.task.run.result,null);
 const stage=await call('GET',taskBase+`/${taskId}/updates`,undefined,cookie);assert.ok(stage.data.updates.some(update=>update.type==='progress'&&update.text==='Stage one durably reported'));assert.ok(stage.data.deliveries.some(delivery=>delivery.text==='Stage one durably reported'));
 const badHost=await fetch(hostBase+'/v1/events',{method:'POST',headers:{authorization:'Bearer wrong','content-type':'application/json'},body:'{}'});assert.equal(badHost.status,401);
 const badResolver=await fetch(platformBase+'/internal/runtime/output',{method:'POST',headers:{authorization:'Bearer wrong','content-type':'application/json'},body:JSON.stringify({text:'forged success',context:{}})});assert.equal(badResolver.status,401);
 assert.equal((await call('GET',taskBase+`/${taskId}/updates`,undefined,cookie)).data.updates.length,stage.data.updates.length);
 releaseSecond();await until(async()=>{await service.tick();return(await call('GET',taskBase+`/${taskId}`,undefined,cookie)).data.task.status==='succeeded';});
 const finished=(await call('GET',taskBase+`/${taskId}`,undefined,cookie)).data.task;assert.equal(finished.run.result,'Offline synthetic final answer');assert.equal(finished.run.resultInputRevision,1);assert.equal(providerCalls,2);
 assert.equal((await readFile(join(hostDirectory,'journal.json'),'utf8')).includes(fakeKey),false);
 await platform.close();await host.close();host=createHost({token:hostToken,adapter:new PiRuntimeAdapter(hostDirectory,resolver,new WorkerPiDriver())});await host.listen({host:'127.0.0.1',port:hostPort});platform=createPlatform(config);await platform.listen({host:'127.0.0.1',port:platformPort});
 const restored=(await call('GET',taskBase+`/${taskId}`,undefined,cookie)).data.task;assert.equal(restored.status,'succeeded');assert.equal(restored.run.result,finished.run.result);assert.equal((await call('POST',taskBase,input,cookie)).data.task.id,taskId);await service.tick();assert.equal(providerCalls,2,'Restart and duplicate operation must not execute again');
});
