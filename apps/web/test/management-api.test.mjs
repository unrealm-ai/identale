import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Window} from 'happy-dom';
import {build} from 'esbuild';
import Fastify from 'fastify';
import {Store} from '../../control-plane/dist/store.js';
import {DirectorySnapshots} from '../../control-plane/dist/directory-sync/service.js';
import {registerDirectorySyncRoutes} from '../../control-plane/dist/directory-sync/routes.js';
import {DirectoryError} from '../../../packages/application/dist/index.js';
const window=new Window({url:'http://127.0.0.1:5173/'});
for(const name of ['window','document','navigator','Element','HTMLElement','SVGElement','Node'])Object.defineProperty(globalThis,name,{value:name==='window'?window:window[name],configurable:true});
const {createApp,h,reactive,nextTick}=await import('vue');
const bundle=await mkdtemp(resolve('apps/web/.management-api-test-'));
await build({entryPoints:['apps/web/src/features/management/useDirectorySync.ts'],outfile:join(bundle,'controller.mjs'),bundle:true,platform:'node',format:'esm',external:['vue']});
const {useDirectorySync}=await import(pathToFileURL(join(bundle,'controller.mjs')));
test.after(async()=>{await rm(bundle,{recursive:true,force:true});await window.happyDOM.close();});
const workspace=(id='ws-a',role='owner')=>({id,name:id,memberId:`member-${id}`,role});
const flush=async()=>{await new Promise(r=>setTimeout(r,5));await nextTick();};
async function until(predicate){for(let n=0;n<150;n++){if(predicate())return;await flush();}assert.fail('controller did not settle');}
function latch(){let release;const promise=new Promise(r=>{release=r;});return{promise,release};}

// Real Fastify routes + snapshot service + isolated SQLite. Directory is a
// synthetic fixture: no enterprise credentials, requests, or message sends.
async function setup(t){
  const dir=await mkdtemp(join(tmpdir(),'identity-management-api-')),store=new Store(join(dir,'fixture.sqlite'));
  let failure=false,hold=null,role='owner',hook=null,now=1792800000000;
  const port={provider:'feishu',capabilities:{scopedQueries:true,incrementalEvents:false,directManager:false,dottedLineManagers:false,departmentLeaders:false},
    async getUser(id){if(failure)throw new DirectoryError('authorization_denied');return{id,aliases:[],displayName:'Synthetic member',departmentIds:[]};},
    async getAuthorizedScope(){if(hold)await hold.promise;if(failure)throw new DirectoryError('authorization_denied');return{departmentIds:[],userIds:[],entireOrganization:false,revision:'synthetic-scope'};}};
  const sources=['a','b'].map(letter=>({workspaceId:`ws-${letter}`,entityId:`employee-${letter}`,entityName:`合成助手${letter}`,connectionId:`connection-${letter}`,provider:'feishu',appId:`app-${letter}`,sourceVersion:'synthetic-v1',sourceId:`source-${letter}`,port:()=>port,rules:()=>[{sourceId:`source-${letter}`,kind:'channel_user',subjectId:JSON.stringify(['feishu','open_id',`app-${letter}`,'synthetic-person']),conversationKinds:['private']}]}));
  const service=new DirectorySnapshots(store,()=>sources,()=>now);
  const server=Fastify({logger:false});server.setErrorHandler((error,_r,reply)=>reply.code(error.statusCode??500).send({error:error.message}));
  registerDirectorySyncRoutes(server,service,(request,w)=>{const current=request.headers['x-synthetic-role'];if(current==='none')throw Object.assign(new Error('unauthenticated'),{statusCode:401});if(!['owner','admin','member'].includes(current)||!['ws-a','ws-b'].includes(w))throw Object.assign(new Error('role_forbidden'),{statusCode:403});});
  await server.ready();const requests=[],events=[],props=reactive({workspace:workspace()});let state;
  globalThis.fetch=async(url,options={})=>{
    assert.ok(String(url).startsWith('/api/workspaces/'),'No external test requests');
    if(options.signal?.aborted)throw new DOMException('Aborted','AbortError');
    const request={method:options.method??'GET',url:String(url),body:options.body?JSON.parse(options.body):undefined};requests.push(request);
    const result=await server.inject({method:request.method,url:request.url,...(request.body===undefined?{}:{payload:request.body}),headers:{'x-synthetic-role':role}});
    if(hook)await hook(request,result);
    if(options.signal?.aborted)throw new DOMException('Aborted','AbortError');
    return new Response(result.body,{status:result.statusCode,headers:{'content-type':'application/json'}});
  };
  document.body.innerHTML='<div id="app"></div>';
  const app=createApp({setup(){state=useDirectorySync(props,(...args)=>events.push(args));return()=>h('div');}});app.mount('#app');
  await until(()=>state.loadState.value==='ready');
  t.after(async()=>{app.unmount();hold?.release();await service.waitForIdle();await service.stop();store.close();await server.close();document.body.innerHTML='';await rm(dir,{recursive:true,force:true});});
  return{state,props,store,service,sources,requests,events,setRole:value=>{role=value;},setFailure:value=>{failure=value;},setHold:value=>{hold=value;},setHook:value=>{hook=value;},advance:ms=>{now+=ms;},get now(){return now;}};
}

test('management API maps actual millisecond contract and CAS schedule updates without touching robot bindings',async t=>{
  const e=await setup(t),id=e.state.taskRows.value[0].id;
  assert.equal(e.state.taskRows.value[0].intervalMinutes,60);assert.equal(e.state.taskRows.value[0].snapshotState,'none');
  await e.state.interval(id,1.5);
  assert.deepEqual(e.requests.find(r=>r.method==='PATCH').body,{expectedVersion:1,periodMs:90000});assert.equal(e.state.taskRows.value[0].intervalMinutes,1.5);
  await e.state.toggle(id,false);const latest=e.service.list('ws-a').tasks[0];assert.equal(latest.version,3);assert.equal(latest.enabled,false);assert.equal(latest.nextScheduledAt,null);assert.equal(e.state.taskRows.value[0].canRun,true);
  assert.ok(e.requests.every(r=>!r.url.includes('/channels/')));assert.ok(e.events.some(v=>v[0]==='busyChanged'&&v[1]===true));
});
test('stale version is read back after 409 and the patch is never automatically replayed',async t=>{
  const e=await setup(t),task=e.service.list('ws-a').tasks[0];e.service.patch('ws-a',task.id,{expectedVersion:task.version,periodMs:7200000});
  await e.state.interval(task.id,90);await until(()=>e.state.loadState.value==='ready'&&e.state.taskRows.value[0].intervalMinutes===120);
  assert.equal(e.requests.filter(r=>r.method==='PATCH').length,1);assert.match(e.state.notice.value,/未自动重试保存/);assert.equal(e.service.list('ws-a').tasks[0].periodMs,7200000);
});
test('one in-flight write blocks duplicate clicks and exposes pending state until actual response',async t=>{
  const e=await setup(t),id=e.state.taskRows.value[0].id,gate=latch();e.setHook(async r=>{if(r.method==='PATCH')await gate.promise;});
  const first=e.state.toggle(id,false);await until(()=>e.state.pendingTaskId.value===id);await e.state.toggle(id,false);await e.state.sync(id);
  assert.equal(e.requests.filter(r=>r.method!=='GET').length,1);gate.release();await first;assert.equal(e.state.pendingTaskId.value,null);
});
test('manual 202 is acceptance, existing server run returns accepted=false without another queued run',async t=>{
  const e=await setup(t),id=e.state.taskRows.value[0].id,gate=latch();e.setHold(gate);e.service.manual('ws-a',id);
  await e.state.sync(id);assert.match(e.state.notice.value,/未重复排队/);assert.equal(e.state.taskRows.value[0].running,true);assert.equal(e.service.history('ws-a',id).items.length,1);
  gate.release();await e.service.waitForIdle();await e.state.refresh();assert.equal(e.state.taskRows.value[0].lastStatus,'succeeded');
});
test('failed sync keeps last successful snapshot, does not post a retry, and history records actual failure',async t=>{
  const e=await setup(t),id=e.state.taskRows.value[0].id;e.service.manual('ws-a',id);await e.service.waitForIdle();e.advance(1000);e.setFailure(true);
  await e.state.sync(id);await e.service.waitForIdle();await e.state.refresh();await e.state.loadHistory(id);
  assert.equal(e.state.taskRows.value[0].snapshotState,'stale');assert.ok(e.state.taskRows.value[0].lastSuccessAt);assert.match(e.state.taskRows.value[0].latestError,/权限不足/);
  assert.equal(e.state.historyRows.value[0].status,'failed');assert.equal(e.requests.filter(r=>r.method==='POST').length,1);
});
test('lost mutation response only reads status and never repeats a committed manual request',async t=>{
  const e=await setup(t),id=e.state.taskRows.value[0].id;e.setHook(async r=>{if(r.method==='POST')throw new TypeError('synthetic response loss');});
  await e.state.sync(id);await e.service.waitForIdle();await until(()=>e.state.loadState.value==='ready');assert.match(e.state.notice.value,/未自动重复/);
  assert.equal(e.requests.filter(r=>r.method==='POST').length,1);assert.equal(e.service.history('ws-a',id).items.length,1);
});
test('late response from old workspace cannot repopulate current tasks and history',async t=>{
  const e=await setup(t),old=e.state.taskRows.value[0].id,gate=latch();let delayed=false;e.setHook(async r=>{if(r.method==='GET'&&r.url.endsWith('/ws-a/directory-sync/tasks')){delayed=true;await gate.promise;}});
  const read=e.state.refresh();await until(()=>delayed);e.props.workspace=workspace('ws-b');await until(()=>e.state.loadState.value==='ready'&&e.state.taskRows.value[0]?.employeeId==='employee-b');gate.release();await read;
  assert.equal(e.state.taskRows.value.length,1);assert.notEqual(e.state.taskRows.value[0].id,old);assert.equal(e.state.selectedTaskId.value,null);
});
test('ordinary member can manage sync while revoked membership clears data',async t=>{
 const e=await setup(t);e.setRole('member');e.props.workspace=workspace('ws-a','member');await flush();await until(()=>e.state.loadState.value==='ready'&&e.state.taskRows.value.length===1);assert.equal(e.state.taskRows.value.length,1);await e.state.toggle(e.state.taskRows.value[0].id,false);assert.equal(e.service.list('ws-a').tasks[0].enabled,false);
 e.setRole('revoked');await e.state.refresh();assert.equal(e.state.loadState.value,'denied');assert.equal(e.state.taskRows.value.length,0);
});
test('history uses opaque returned pagination cursor and preserves abandoned/configuration facts',async t=>{
  const e=await setup(t),id=e.state.taskRows.value[0].id;
  for(let n=0;n<26;n++)e.store.run('INSERT INTO directory_sync_history(id,task_id,trigger_kind,started_at,finished_at,status,snapshot_version,user_count,department_count,error_json) VALUES(?,?,?,?,?,?,?,?,?,?)',`run-${n}`,id,'configuration',e.now+n,e.now+n+1,n===25?'abandoned':'success',n===25?null:n,2,1,null);
  await e.state.loadHistory(id);assert.equal(e.state.historyRows.value.length,25);assert.equal(e.state.historyRows.value[0].status,'abandoned');assert.equal(e.state.historyRows.value[0].trigger,'configuration');const cursor=e.state.nextCursor.value;assert.ok(cursor);
  await e.state.loadHistory(id,true);assert.equal(e.state.historyRows.value.length,26);assert.equal(e.state.nextCursor.value,null);assert.equal(new URL(e.requests.at(-1).url,'http://fixture').searchParams.get('cursor'),cursor);
});
test('period bounds are rejected before a request and an unbound task is removed on refresh',async t=>{
  const e=await setup(t),id=e.state.taskRows.value[0].id;await e.state.interval(id,0.5);await e.state.interval(id,43201);assert.equal(e.requests.filter(r=>r.method==='PATCH').length,0);assert.match(e.state.error.value,/1分钟至30天/);
  e.sources.splice(0,1);await e.state.refresh();assert.equal(e.state.taskRows.value.length,0);assert.equal(e.state.historyRows.value.length,0);
});
test('DingTalk and WeCom sources expose scoped operational controls without accepting nonexistent task IDs',async t=>{const e=await setup(t);e.sources.push({...e.sources[0],connectionId:'connection-dingtalk',provider:'dingtalk',appId:'synthetic-dingtalk',rules:()=>[]},{...e.sources[0],connectionId:'connection-wecom',provider:'wecom',appId:'synthetic-wecom',rules:()=>[]});await e.state.refresh();const list=e.service.list('ws-a');assert.deepEqual(new Set(list.tasks.map(t=>t.provider)),new Set(['feishu','dingtalk','wecom']));assert.ok(list.capabilities.every(c=>c.status==='supported'));assert.equal(e.state.taskRows.value.length,3);const task=list.tasks.find(t=>t.provider==='dingtalk');await e.state.toggle(task.id,false);assert.equal(e.service.list('ws-a').tasks.find(t=>t.id===task.id).enabled,false);const count=e.requests.length;await e.state.sync('nonexistent-task');await e.state.toggle('nonexistent-task',true);assert.equal(e.requests.length,count);});
