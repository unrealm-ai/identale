import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Window} from 'happy-dom';
import {build} from 'esbuild';
import {parse,compileScript} from '@vue/compiler-sfc';
import {createServer} from '../../control-plane/dist/server.js';
import {Store} from '../../control-plane/dist/store.js';
import {ModelProfileService} from '../../control-plane/dist/model-profiles.js';
const window=new Window({url:'http://127.0.0.1:15258/'});
for(const name of ['window','document','navigator','location','history','localStorage','Node','ShadowRoot','Document','Element','HTMLElement','SVGElement','Event','MouseEvent','KeyboardEvent','PointerEvent','FocusEvent','InputEvent','Image','HTMLInputElement','HTMLTextAreaElement','getComputedStyle','MutationObserver','ResizeObserver','requestAnimationFrame','cancelAnimationFrame'])Object.defineProperty(globalThis,name,{value:name==='window'?window:window[name],configurable:true});
const {createApp,nextTick}=await import('vue');
const dir=await mkdtemp(resolve('apps/web/.ui58-navigation-'));
await build({entryPoints:['apps/web/src/App.vue'],outfile:join(dir,'App.mjs'),bundle:true,platform:'node',format:'esm',external:['vue','naive-ui'],plugins:[{name:'vue',setup(b){b.onLoad({filter:/\.vue$/},async({path})=>{const{descriptor}=parse(await readFile(path,'utf8'),{filename:path});return{contents:compileScript(descriptor,{id:path,inlineTemplate:true,fs:{fileExists:existsSync,readFile:p=>readFileSync(p,'utf8')}}).content,loader:'ts',resolveDir:resolve(path,'..')};});}}]});
const App=(await import(pathToFileURL(join(dir,'App.mjs')).href)).default;
const originalFetch=globalThis.fetch;
test.after(async()=>{globalThis.fetch=originalFetch;await rm(dir,{recursive:true,force:true});await window.happyDOM.close();});
async function flush(){await new Promise(r=>setTimeout(r,12));await nextTick();}
async function until(f){for(let i=0;i<120;i++){await flush();if(f())return;}assert.fail('UI did not settle: '+document.body.textContent);}
function visible(el){for(let p=el;p;p=p.parentElement)if(p.hidden||p.style?.display==='none'||p.getAttribute?.('aria-hidden')==='true')return false;return!!el;}
function button(label){const el=[...document.querySelectorAll('button,[role=tab],[role=menuitem]')].filter(visible).find(e=>e.textContent.trim()===label||e.getAttribute('aria-label')===label);assert.ok(el,label);return el;}
async function setup(t,member=false,empty=false){
 const faults=new Set();
 const data=await mkdtemp(join(tmpdir(),'identity-ui58-navigation-')),server=createServer({databasePath:join(data,'test.sqlite'),origin:'http://127.0.0.1:15258',modelProfiles:{masterKey:Buffer.alloc(32,58)}});server.addHook('onRequest',async(request,reply)=>{if([...faults].some(path=>request.url.endsWith(path)))return reply.code(503).send({error:'isolated_home_read_failure'});});await server.ready();let cookie='';
 const call=async(method,url,body)=>{const r=await server.inject({method,url,...(body===undefined?{}:{payload:body}),headers:{origin:'http://127.0.0.1:15258',...(cookie?{cookie}:{})}});if(r.headers['set-cookie'])cookie=String(r.headers['set-cookie']).split(';')[0];return r;};
 const owner=(await call('POST','/api/auth/register',{username:'ui58-nav-owner',password:'isolated-password'})).json();
 const entity=empty?undefined:(await call('POST',`/api/workspaces/${owner.workspace.id}/entities`,{name:'导航测试员工',ownWebUse:true})).json().entity;
 if(member){const invite=(await call('POST',`/api/workspaces/${owner.workspace.id}/invitations`,{})).json();await call('POST','/api/auth/logout',{});assert.equal((await call('POST','/api/auth/register',{username:'ui58-nav-member',password:'isolated-password',invitationToken:invite.token})).statusCode,201);}
 let responseHook;const onResponse=hook=>{responseHook=hook;};
 const requests=[],requestDetails=[];globalThis.fetch=async(url,options={})=>{assert.ok(String(url).startsWith('/api/'));if(options.signal?.aborted)throw new DOMException('Aborted','AbortError');requests.push(String(url));requestDetails.push({url:String(url),method:options.method??'GET'});const r=await call(options.method??'GET',String(url),options.body?JSON.parse(options.body):undefined);if(responseHook)await responseHook(String(url),r);if(options.signal?.aborted)throw new DOMException('Aborted','AbortError');return new Response(r.body,{status:r.statusCode,headers:{'content-type':'application/json'}});};
 let app;async function mount(query){app?.unmount();document.body.innerHTML='<div id="app"></div>';history.replaceState(null,'',`/?${query.includes('ws=')?'':`ws=${owner.workspace.id}&`}${query}`);app=createApp(App);app.mount('#app');await until(()=>!!document.querySelector('.app-nav'));}
 t.after(async()=>{app?.unmount();globalThis.fetch=originalFetch;document.body.innerHTML='';localStorage.clear();await server.close();await rm(data,{recursive:true,force:true});});
 return{data,owner,entity,requests,requestDetails,mount,call,faults,onResponse};
}
test('primary destinations and one account footer preserve theme and legacy navigation',async t=>{
 const env=await setup(t);await env.mount('view=employees');
 const links=[...document.querySelectorAll('.app-nav .nav-link')];assert.deepEqual(links.map(e=>e.textContent.trim()),['首页','数字员工','任务','事项看板','资源库','设置']);
 assert.equal(document.querySelector('.app-nav .account-trigger').getAttribute('aria-label'),'我的账号');assert.equal(document.querySelectorAll('.app-nav .account-trigger').length,1);
 button('我的账号').click();await until(()=>document.body.textContent.includes('切换深色主题'));button('切换深色主题').click();await until(()=>document.documentElement.dataset.theme==='dark');assert.equal(localStorage.getItem('identity:theme'),'dark');
 await env.mount(`view=settings&entity=${env.entity.id}&section=model`);await until(()=>document.querySelector('.employee-settings [aria-label="模型与思考强度"]'));assert.equal(new URLSearchParams(location.search).get('section'),'model');
 assert.equal(document.querySelector('.brand-logo').getAttribute('aria-label'),'identale');
});
test('legacy employee identity opens editing while seven tabs retain separate model and task surfaces',async t=>{
 const env=await setup(t);await env.mount(`view=settings&entity=${env.entity.id}&section=identity`);await until(()=>[...document.querySelectorAll('.n-drawer')].some(visible));
 assert.ok(document.querySelector('input[aria-label="员工名称"]'));assert.deepEqual([...document.querySelectorAll('.employee-settings .n-tabs-nav [role=tab]')].map(e=>e.textContent.trim()),['概览','对话','任务','能力包','渠道','触发器','模型']);
 button('取消员工信息修改').click();await until(()=>![...document.querySelectorAll('.n-drawer')].some(visible));
 button('模型').click();await until(()=>document.querySelector('[aria-label="模型与思考强度"]'));assert.equal(new URLSearchParams(location.search).get('section'),'model');
});
test('legacy chat resolves to the employee conversation tab without inventing a second conversation',async t=>{
 const env=await setup(t);await env.mount(`view=chat&entity=${env.entity.id}`);await until(()=>document.querySelector('.entity-workspace'));
 const q=new URLSearchParams(location.search);assert.equal(q.get('view'),'settings');assert.equal(q.get('section'),'chat');assert.equal(q.get('entity'),env.entity.id);
 const result=await env.call('GET',`/api/workspaces/${env.owner.workspace.id}/entities/${env.entity.id}/conversations`);assert.equal(result.statusCode,200);assert.equal(result.json().conversations.length,0,'no model means no fabricated conversation');
 button('返回对话列表').click();await until(()=>document.querySelector('.conversations-page'));assert.equal(new URLSearchParams(location.search).get('view'),'conversations');
});
test('ordinary member workbench does not call administrator tasks or service monitoring',async t=>{
 const env=await setup(t,true);await env.mount(`view=workbench&section=tasks&entity=${env.entity.id}`);await until(()=>document.querySelector('.employee-tasks'));
 assert.equal(document.querySelector('.platform-tasks'),null);assert.ok(!env.requests.some(p=>p.includes('/task-management/')));
 button('运行监控').click();await until(()=>document.querySelector('.connections-grid')||document.body.textContent.includes('这里还没有记录'));
 assert.ok(!env.requests.some(p=>p.endsWith('/runtime-monitor')));assert.ok(env.requests.some(p=>p.includes('/connections?')));
});
test('legacy administrator task route stays read-only and monitor errors do not become healthy',async t=>{
 const env=await setup(t);await env.mount('view=tasks');await until(()=>document.querySelector('.platform-tasks'));assert.equal(new URLSearchParams(location.search).get('view'),'tasks');
 button('设置').click();await until(()=>[...document.querySelectorAll('[role=tab]')].some(el=>el.textContent.trim()==='运行监控'));
 button('运行监控').click();await until(()=>document.body.textContent.includes('暂时无法获取服务状态'));
 assert.ok(env.requests.some(p=>p.endsWith('/runtime-monitor')));assert.ok(!document.body.textContent.includes('进程可达'));
});

test('complete task detail uses the existing authorized read API and returns to its retained list',async t=>{
 const env=await setup(t),base=`/api/workspaces/${env.owner.workspace.id}/entities/${env.entity.id}`;
 const store=new Store(join(env.data,'test.sqlite'));try{new ModelProfileService(store,{masterKey:Buffer.alloc(32,58)}).save(env.owner.workspace.id,env.entity.id,{provider:'openai-compatible',endpoint:'https://synthetic.invalid/v1',modelId:'synthetic-no-call',apiKey:'synthetic-fixture-only'});}finally{store.close();}
 const c=await env.call('POST',base+'/conversations',{operationId:'detail-fixture-conversation'});assert.equal(c.statusCode,201,c.body);
 const r=await env.call('POST',base+'/todos',{operationId:'detail-fixture-task',conversationId:c.json().conversation.id,input:'持久待办 · 完整详情回归',contextMode:'new'});assert.equal(r.statusCode,201,r.body);const id=r.json().task.id;
 await env.mount(`view=workbench&section=tasks&task=${id}`);await until(()=>document.querySelector('.full-task-page .task-detail-content')?.textContent.includes('持久待办'));
 assert.ok(env.requests.some(url=>url===`/api/workspaces/${env.owner.workspace.id}/task-management/task-list/${id}`));
 assert.ok(!env.requests.some(url=>url.includes('raw-jsonl')||url.includes('/rerun')));
 button('← 返回任务列表').click();await until(()=>!document.querySelector('.full-task-page')&&document.querySelector('.task-records .task-title'));
 assert.equal(new URLSearchParams(location.search).has('task'),false);
 document.querySelector('.task-records .task-title').click();await until(()=>[...document.querySelectorAll('button')].some(e=>e.textContent==='打开完整详情'));
 button('打开完整详情').click();await until(()=>new URLSearchParams(location.search).get('task')===id&&!!document.querySelector('.full-task-page'));
});

test('frontend-v1 home uses real summaries and keeps members out of administrator APIs',async t=>{
 const env=await setup(t,true);await env.mount('view=home');await until(()=>document.querySelector('.home-page')&&!document.querySelector('.home-page .n-skeleton'));
 assert.ok(env.requests.some(p=>p.includes('/recent-conversations')));
 assert.ok(!env.requests.some(p=>p.includes('/task-management/')));
 assert.ok(!env.requests.some(p=>p.endsWith('/runtime-monitor')));
 button('待你处理').click();await until(()=>document.querySelector('.human-requests'));
 assert.equal(new URLSearchParams(location.search).get('view'),'tasks');
 assert.equal(new URLSearchParams(location.search).get('section'),'human');
 assert.ok(!env.requests.some(p=>p.includes('/task-management/')));
});
test('frontend-v1 monitor shortcut retains monitor section and can restore on reload',async t=>{
 const env=await setup(t);await env.mount('view=home');await until(()=>document.querySelector('.home-runtime'));
 button('查看状态 →').click();await until(()=>document.querySelector('.workspace-management'));
 assert.equal(new URLSearchParams(location.search).get('view'),'workspace-settings');
 assert.equal(new URLSearchParams(location.search).get('section'),'monitor');
 await env.mount('view=workspace-settings&section=monitor');await until(()=>env.requests.some(p=>p.endsWith('/runtime-monitor')));
 assert.ok(document.body.textContent.includes('运行监控'));
});

test('conversation matches main: no extra sidebars and tasks expand only on request',async t=>{
 const env=await setup(t),ws=env.owner.workspace.id;
 const store=new Store(join(env.data,'test.sqlite'));
 try{new ModelProfileService(store,{masterKey:Buffer.alloc(32,58)}).save(ws,env.entity.id,{provider:'openai-compatible',endpoint:'https://synthetic.invalid/v1',modelId:'synthetic-no-call',apiKey:'synthetic-fixture-only'});}finally{store.close();}
 await env.mount(`view=chat&entity=${env.entity.id}`);await until(()=>document.querySelector('.chat-task-grid'));
 assert.equal(document.querySelector('.app-nav [data-key="conversations"]'),null);
 assert.equal(document.querySelector('.chat-peers'),null);
 assert.equal(document.querySelector('.chat-profile'),null);
 assert.equal(document.querySelector('.session-tasks'),null);
 button('查看本会话任务').click();await until(()=>document.querySelector('.session-tasks'));
 assert.equal(document.querySelector('.session-tasks').getAttribute('aria-label'),'本会话任务');
 button('收起任务').click();await until(()=>!document.querySelector('.session-tasks'));
 button('返回对话列表').click();await until(()=>document.querySelector('.conversations-page'));
 const r=await env.call('GET',`/api/workspaces/${ws}/entities/${env.entity.id}/conversations`);assert.equal(r.json().conversations.length,1);
 assert.ok(!env.requestDetails.some(r=>r.method!=='GET'&&(r.url.endsWith('/messages')||r.url.endsWith('/tasks'))));
});


test('navigation places optional work items after tasks on desktop and mobile',async t=>{
 const env=await setup(t),base=`/api/workspaces/${env.owner.workspace.id}`;
 const disabled=await env.call('PUT',base+'/work-items/settings',{expectedRevision:1,enabled:false});assert.equal(disabled.statusCode,200,disabled.body);
 await env.mount('view=home');
 const labels=selector=>[...document.querySelectorAll(selector)].map(e=>e.textContent.trim());
 assert.deepEqual(labels('.app-nav .nav-link'),['首页','数字员工','任务','资源库','设置']);
 const enabled=await env.call('PUT',base+'/work-items/settings',{expectedRevision:2,enabled:true});assert.equal(enabled.statusCode,200,enabled.body);
 window.dispatchEvent(new Event('identity:work-items-beta-changed'));
 await until(()=>labels('.app-nav .nav-link').includes('事项看板'));
 const expected=['首页','数字员工','任务','事项看板','资源库','设置'];
 assert.deepEqual(labels('.app-nav .nav-link'),expected);
 button('打开工作台导航').click();await until(()=>document.querySelector('.rail-nav--drawer'));
 assert.deepEqual(labels('.rail-nav--drawer .nav-link'),expected);
});

test('home employee preview is independent of directory search and renders true empty state',async t=>{
 const env=await setup(t);await env.mount('view=employees');
 const input=document.querySelector('input[aria-label="搜索数字员工"]');input.value='does-not-exist';input.dispatchEvent(new Event('input',{bubbles:true}));
 await until(()=>document.body.textContent.includes('没有符合条件的数字员工'));
 button('首页').click();await until(()=>document.querySelector('.home-employee'));
 assert.match(document.querySelector('.home-employees').textContent,/导航测试员工/);
 assert.ok(env.requests.some(p=>p.endsWith('/employee-summaries?limit=4')));
 assert.ok(!env.requests.filter(p=>p.includes('/employee-summaries?limit=4')).some(p=>p.includes('q=')));
 // A new isolated workspace has a genuine empty employee list.
 const empty=await env.call('POST','/api/workspaces',{name:'首页空态工作区'});assert.equal(empty.statusCode,200,empty.body);
 await env.mount(`view=home&ws=${empty.json().workspace.id}`);
 await until(()=>document.querySelector('.employee-wizard'));button('取消').click();
 await until(()=>document.querySelector('.home-page')&&!document.querySelector('.home-page .n-skeleton'));
 assert.match(document.querySelector('.home-page').textContent,/工作区还没有数字员工/);
});

test('home separates initial loading and read failure from empty employees and retries actual API',async t=>{
 const env=await setup(t);let release;const held=new Promise(r=>release=r);t.after(()=>release());
 env.onResponse(async url=>{if(url.endsWith('/employee-summaries?limit=4'))await held;});
 await env.mount('view=home');await until(()=>document.querySelector('.home-page'));
 assert.match(document.querySelector('.home-page').textContent,/正在读取数字员工/);
 assert.doesNotMatch(document.querySelector('.home-page').textContent,/工作区还没有数字员工/);
 release();await until(()=>document.querySelector('.home-employee'));
 env.onResponse(undefined);env.faults.add('/employee-summaries?limit=4');
 await env.mount('view=home');await until(()=>document.querySelector('.home-error'));
 assert.match(document.querySelector('.home-page').textContent,/数字员工暂不可用/);
 assert.doesNotMatch(document.querySelector('.home-page').textContent,/工作区还没有数字员工/);
 env.faults.clear();button('重试').click();await until(()=>document.querySelector('.home-employee')&&!document.querySelector('.home-error'));
 env.faults.add('/employee-summaries?limit=4');button('刷新首页').click();await until(()=>document.querySelector('.home-error'));
 assert.match(document.querySelector('.home-employees').textContent,/导航测试员工/,'transient failure preserves successful data with error notice');
});

test('home refreshes visible pages and focus without overlapping reads, and cleans up on leave',async t=>{
 const env=await setup(t);t.mock.timers.enable({apis:['setInterval']});
 const ownHidden=Object.getOwnPropertyDescriptor(document,'hidden');Object.defineProperty(document,'hidden',{configurable:true,value:false});
 t.after(()=>{if(ownHidden)Object.defineProperty(document,'hidden',ownHidden);else delete document.hidden;});
 await env.mount('view=home');await until(()=>document.querySelector('.home-employee')&&!button('刷新首页').disabled);
 const count=()=>env.requests.filter(p=>p.endsWith('/employee-summaries?limit=4')).length;
 const first=count();Object.defineProperty(document,'hidden',{configurable:true,value:true});
 t.mock.timers.tick(30_000);await flush();assert.equal(count(),first);
 Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));
 await until(()=>count()===first+1&&!button('刷新首页').disabled);
 const base=`/api/workspaces/${env.owner.workspace.id}`;await env.call('POST',base+'/entities',{name:'聚焦刷新员工',ownWebUse:true});
 window.dispatchEvent(new Event('focus'));await until(()=>document.querySelector('.home-employees')?.textContent.includes('聚焦刷新员工')&&!button('刷新首页').disabled);
 assert.match(document.querySelector('.task-overview').textContent,/数字员工2/);
 let release;const held=new Promise(r=>release=r);t.after(()=>release());
 env.onResponse(async url=>{if(url.endsWith('/employee-summaries?limit=4'))await held;});
 button('刷新首页').click();await until(()=>button('刷新首页').disabled);const inFlight=count();
 window.dispatchEvent(new Event('focus'));t.mock.timers.tick(30_000);await flush();assert.equal(count(),inFlight);
 assert.ok(document.querySelector('.home-employees'),'refresh keeps existing content');
 release();env.onResponse(undefined);await until(()=>!button('刷新首页').disabled);
 const beforeTick=count();t.mock.timers.tick(30_000);await until(()=>count()===beforeTick+1&&!button('刷新首页').disabled);
 button('数字员工').click();await until(()=>document.querySelector('.employee-directory'));const left=count();
 window.dispatchEvent(new Event('focus'));t.mock.timers.tick(30_000);await flush();assert.equal(count(),left);
});

test('home ignores an old workspace response after switching to another workspace',async t=>{
 const env=await setup(t);const second=(await env.call('POST','/api/workspaces',{name:'第二工作区'})).json().workspace;
 await env.call('POST',`/api/workspaces/${second.id}/entities`,{name:'第二工作区员工',ownWebUse:true});
 let release;const held=new Promise(r=>release=r);t.after(()=>release());
 env.onResponse(async url=>{if(url.includes(env.owner.workspace.id)&&url.endsWith('/employee-summaries?limit=4'))await held;});
 await env.mount('view=home');await until(()=>document.querySelector('.home-page'));
 history.pushState(null,'',`/?ws=${second.id}&view=home`);window.dispatchEvent(new Event('popstate'));
 await until(()=>document.querySelector('.home-employees')?.textContent.includes('第二工作区员工'));
 release();await flush();
 assert.doesNotMatch(document.querySelector('.home-employees').textContent,/导航测试员工/);
 assert.match(location.search,new RegExp(second.id));
});


test('home labels actual confirmation recipients and refreshes changed or completed requests',async t=>{
 const env=await setup(t),ws=env.owner.workspace.id,base=`/api/workspaces/${ws}/entities/${env.entity.id}`;
 const invite=(await env.call('POST',`/api/workspaces/${ws}/invitations`,{})).json();
 await env.call('POST','/api/auth/logout',{});
 const other=(await env.call('POST','/api/auth/register',{username:'home-confirmer',displayName:'另一位确认人',password:'isolated-password',invitationToken:invite.token})).json();
 await env.call('POST','/api/auth/logout',{});await env.call('POST','/api/auth/login',{username:'ui58-nav-owner',password:'isolated-password'});
 const store=new Store(join(env.data,'test.sqlite'));t.after(()=>store.close());
 new ModelProfileService(store,{masterKey:Buffer.alloc(32,58)}).save(ws,env.entity.id,{provider:'openai-compatible',endpoint:'https://synthetic.invalid/v1',modelId:'synthetic-no-call',apiKey:'synthetic-fixture-only'});
 const conversation=(await env.call('POST',base+'/conversations',{operationId:'home-human-conversation'})).json().conversation;
 for(const [id,userId,status] of [['home-mine',env.owner.user.id,'waiting'],['home-other',other.user.id,'confirmed']]){
  const result=await env.call('POST',base+'/todos',{operationId:id,conversationId:conversation.id,input:'Isolated homepage pending confirmation fixture',contextMode:'new'});assert.equal(result.statusCode,201,result.body);
  const task=result.json().task,run=id+'-run',session=id+'-session',at=Date.now();
  store.run("INSERT INTO runs(id,task_id,session_id,status,created_at) VALUES(?,?,?,'needs_human',?)",run,task.id,session,at);
  store.run("UPDATE tasks SET status='waiting_human',run_id=? WHERE id=?",run,task.id);
  store.run("INSERT INTO human_requests(request_id,workspace_id,entity_id,task_id,source_run_id,session_id,question_json,question_digest,content_version,status,target_json,target_conversation_id,notification_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'synthetic-home-question',1,?,?,?,'delivered',?,?)",id,ws,env.entity.id,task.id,run,session,JSON.stringify({questions:[],goal:'Synthetic homepage fixture'}),status,JSON.stringify({kind:'web',userId}),conversation.id,at,at);
 }
 await env.mount('view=home');await until(()=>document.querySelectorAll('.home-request').length===2&&!button('刷新首页').disabled);
 const panel=document.querySelector('.home-request').closest('section');
 assert.match(panel.querySelector('h2').textContent,/待人工确认.*2 项/);
 assert.match(panel.textContent,/确认人：另一位确认人/);
 assert.match(panel.textContent,/已确认，等待继续/);
 assert.doesNotMatch(panel.textContent,/需要你处理/);
 store.run("UPDATE human_requests SET status='continued' WHERE request_id='home-other'");
 store.run("UPDATE human_requests SET status='confirmed' WHERE request_id='home-mine'");
 button('刷新首页').click();await until(()=>document.querySelectorAll('.home-request').length===1&&!button('刷新首页').disabled);
 assert.match(panel.textContent,/1 项/);assert.match(panel.textContent,/已确认，等待继续/);assert.doesNotMatch(panel.textContent,/另一位确认人/);
 assert.ok(!env.requestDetails.some(r=>r.method!=='GET'&&/\/(turns|messages)$/.test(r.url)));
});

function railLink(label){const el=[...document.querySelectorAll('.app-nav .nav-link')].find(el=>el.textContent.trim()===label);assert.ok(el,label);return el;}
function employeeName(value){const field=document.querySelector('input[aria-label="员工名称"]');assert.ok(field);field.value=value;field.dispatchEvent(new Event('input',{bubbles:true}));}

test('empty workspace creation allows every primary destination without returning first',async t=>{
 const env=await setup(t,false,true);
 for(const [label,view] of [['首页','home'],['数字员工','employees'],['任务','tasks'],['事项看板','work-items'],['资源库','resources'],['设置','workspace-settings']]){
  await env.mount('view=employees');await until(()=>!!document.querySelector('input[aria-label="员工名称"]'));
  const link=railLink(label);assert.equal(link.tagName,'A');assert.notEqual(link.getAttribute('aria-disabled'),'true');link.click();
  await until(()=>!document.querySelector('.employee-wizard')&&new URLSearchParams(location.search).get('view')===view);
 }
 assert.ok(!env.requestDetails.some(r=>r.method!=='GET'),'leaving an empty form never creates or saves data');
});

test('creation navigation preserves a declined draft and follows the confirmed destination',async t=>{
 const env=await setup(t,false,true);await env.mount('view=employees');await until(()=>!!document.querySelector('input[aria-label="员工名称"]'));
 employeeName('尚未保存的员工');await flush();railLink('任务').click();await until(()=>document.body.textContent.includes('丢弃草稿并退出'));
 assert.equal(new URLSearchParams(location.search).get('view'),'employees');button('继续填写').click();await flush();
 assert.equal(document.querySelector('input[aria-label="员工名称"]').value,'尚未保存的员工');
 // Explicit back must override a pending destination, including after continuing a draft.
 railLink('任务').click();await until(()=>document.body.textContent.includes('丢弃草稿并退出'));
 button('返回数字员工').click();await until(()=>document.body.textContent.includes('丢弃草稿并退出'));button('丢弃草稿并退出').click();await until(()=>!document.querySelector('.employee-wizard'));
 assert.equal(new URLSearchParams(location.search).get('view'),'employees');
 await until(()=>!button('创建数字员工').disabled);button('创建数字员工').click();await until(()=>!!document.querySelector('input[aria-label="员工名称"]'));employeeName('另一份员工草稿');await flush();
 railLink('任务').click();await until(()=>document.body.textContent.includes('丢弃草稿并退出'));railLink('资源库').click();await flush();button('丢弃草稿并退出').click();
 await until(()=>!document.querySelector('.employee-wizard')&&new URLSearchParams(location.search).get('view')==='resources');
 assert.ok(!env.requestDetails.some(r=>r.method!=='GET'),'discarding a draft never submits it');
});

test('creation keeps primary navigation locked until the submitted operation finishes',async t=>{
 const env=await setup(t,false,true);await env.mount('view=employees');await until(()=>!!document.querySelector('input[aria-label="员工名称"]'));employeeName('创建中的员工');await flush();
 let release;const gate=new Promise(resolve=>{release=resolve;});t.after(()=>release());let received=false;
 env.onResponse(async url=>{if(url.endsWith('/employee-creations')){received=true;await gate;}});
 button('确认创建数字员工').click();await until(()=>received);
 const link=railLink('任务');assert.equal(link.tagName,'SPAN');assert.equal(link.getAttribute('aria-disabled'),'true');link.click();await flush();
 assert.ok(document.querySelector('.employee-wizard'));assert.equal(new URLSearchParams(location.search).get('view'),'employees');
 release();await until(()=>!document.querySelector('.employee-wizard')&&!!document.querySelector('.employee-settings'));
 assert.equal(env.requestDetails.filter(r=>r.method==='POST'&&r.url.endsWith('/employee-creations')).length,1);
 assert.equal(railLink('任务').tagName,'A');
});
