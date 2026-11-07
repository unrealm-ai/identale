import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import { build } from 'esbuild';
import { parse, compileScript } from '@vue/compiler-sfc';
import { taskActivityFixture } from '../../control-plane/test/helpers/task-activity-fixture.mjs';
import { taskRecordsFixture } from '../../control-plane/test/helpers/task-records-fixture.mjs';
const window = new Window({ url: 'http://127.0.0.1:5173/' });
for (const name of ['window','document','navigator','location','history','localStorage','Node','ShadowRoot','Document','Element','HTMLElement','SVGElement','HTMLDialogElement','Event','MouseEvent','KeyboardEvent','PointerEvent','FocusEvent','InputEvent','Image','HTMLInputElement','HTMLTextAreaElement','getComputedStyle','MutationObserver','ResizeObserver','requestAnimationFrame','cancelAnimationFrame']) Object.defineProperty(globalThis, name, { value: name === 'window' ? window : window[name], configurable: true });
const { createApp, nextTick } = await import('vue');
const dir = await mkdtemp(resolve('apps/web/.task-test-'));
await build({ entryPoints: { Detail: 'apps/web/src/features/tasks/TaskDetailContent.vue', Conversation: 'apps/web/src/features/tasks/ConversationTaskList.vue', Panel: 'apps/web/src/features/tasks/TaskPanel.vue', Admin: 'apps/web/src/features/tasks/PlatformTasks.vue' }, outdir: dir, outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', external: ['vue','naive-ui'], plugins: [{ name: 'vue-sfc', setup(builder) { builder.onLoad({ filter: /\.vue$/ }, async ({ path }) => { const { descriptor } = parse(await readFile(path, 'utf8'), { filename: path }); return { contents: compileScript(descriptor, { id: path, inlineTemplate: true, fs: { fileExists: existsSync, readFile: p => readFileSync(p, 'utf8') } }).content, loader: 'ts', resolveDir: resolve(path, '..') }; }); } }] });
const Detail = (await import(pathToFileURL(join(dir,'Detail.mjs')).href)).default;
const Conversation = (await import(pathToFileURL(join(dir,'Conversation.mjs')).href)).default;
const Panel = (await import(pathToFileURL(join(dir,'Panel.mjs')).href)).default;
const Admin = (await import(pathToFileURL(join(dir,'Admin.mjs')).href)).default;
test.after(async () => { await rm(dir,{recursive:true,force:true}); await window.happyDOM.close(); });
const flush = async () => { await new Promise(resolve => setTimeout(resolve,15)); await nextTick(); };
async function until(predicate, label = 'UI settled') { for (let n = 0; n < 150; n++) { await flush(); if (predicate()) return; } assert.fail(label + '\n' + document.body.textContent); }
function click(label) { const element = [...document.querySelectorAll('button')].find(element => element.textContent.trim() === label); assert.ok(element,label); element.click(); return flush(); }
async function environment(t, records = false) {
  const f = records ? await taskRecordsFixture(t) : await taskActivityFixture(t); let app, beforeRequest, afterJson; const requests = [];
  // Existing real Fastify/SQLite DOM transport pattern; no model or Runtime mock.
  globalThis.fetch = async (url, options = {}) => {
    if (options.signal?.aborted) throw new DOMException('Aborted','AbortError');
    if(String(url).startsWith('http') && f.transport) return f.transport(url,options);
    assert.ok(String(url).startsWith('/api/')); requests.push(String(url)); await beforeRequest?.(String(url));
    const response = await f.call(options.method ?? 'GET',String(url),options.body ? JSON.parse(options.body) : undefined,f.owner.cookie);
    if (options.signal?.aborted) throw new DOMException('Aborted','AbortError');
    const result=new Response(response.body,{status:response.statusCode,headers:{'content-type':'application/json'}});const json=result.json.bind(result);result.json=async()=>{const data=await json();await afterJson?.(String(url),data);return data;};return result;
  };
  const taskDto = task => ({ id:task.id,input:`任务 ${task.id}`,status:'succeeded',createdAt:1000,inputRevision:1 });
  function mount(component, props) { app?.unmount(); document.body.innerHTML = '<div id="app"></div>'; app=createApp(component,props); app.mount('#app'); }
  t.after(() => { app?.unmount(); document.body.innerHTML=''; });
  return { ...f, mount, requests, taskDto, onRequest: hook => { beforeRequest = hook; }, onJson: hook => { afterJson = hook; } };
}
test('shared detail defaults only replies open, preserves manual expansion and scroll across refresh, and loads long text on demand', async t => {
  const f = await environment(t), task = f.seedTask('detail');
  const progress = f.event(task,'progress',{text:'公开进展'}), reply = f.event(task,'output_delta',{text:'回复文本'}), final = f.event(task,'final_result',{text:'长回复'.repeat(4000),inputRevision:1});
  f.mount(Detail,{task:f.taskDto(task),endpoint:task.root.slice(4)});
  await until(() => document.querySelectorAll('.activity-timeline li').length === 3);
  const entry = id => document.querySelector(`[data-entry-id="${id}"] details`);
  assert.equal(entry(progress.id).open,false); assert.equal(entry(reply.id).open,true); assert.equal(entry(final.id).open,true);
  assert.equal(document.querySelector('[aria-label="选择执行记录"]'),null);
  assert.equal(f.requests.some(url=>url.includes('entryId=')),false);
  entry(progress.id).open=true; entry(progress.id).dispatchEvent(new Event('toggle')); entry(reply.id).open=false; entry(reply.id).dispatchEvent(new Event('toggle'));
  const viewport=document.querySelector('.task-detail-content'); viewport.scrollTop=137;
  await click('刷新详情'); await until(()=>!document.querySelector('.detail-toolbar .n-button--loading'));
  assert.equal(entry(progress.id).open,true); assert.equal(entry(reply.id).open,false); assert.equal(viewport.scrollTop,137);
  f.event(task,'input_receipt',{inputRevision:2,inputStatus:'received'}); await click('刷新详情'); await until(()=>document.querySelectorAll('.activity-timeline li').length===4);
  assert.equal(entry(progress.id).open,true); assert.equal(entry(reply.id).open,false);
  const fullContent=entry(final.id).querySelector('.full-content');fullContent.open=true;fullContent.dispatchEvent(new Event('toggle'));await until(()=>f.requests.some(url=>url.includes('entryId=')) && fullContent.querySelector('.activity-text')?.textContent.length===8000);
  const body=fullContent.querySelector('.record-body');body.scrollTop=1000;body.dispatchEvent(new Event('scroll'));await until(()=>fullContent.querySelector('.activity-text').textContent.length===12000);assert.equal([...entry(final.id).querySelectorAll('button')].length,0);
  assert.equal(document.querySelector('form,input,textarea'),null); assert.ok(f.requests.every(url=>!url.includes('/task-management/')));
});
test('conversation switches in place, keeps paginated list position, restores focus, and never reads management scope', async t => {
  const f = await environment(t);
  for(let n=0;n<30;n++)f.seedTask(`list-${String(n).padStart(2,'0')}`,f.own,'planned',`列表任务 ${n}`,1000+n);
  const task=f.seedTask('with-context',f.own,'succeeded','打开后查看完整回复',2000);f.event(task,'final_result',{text:'本会话最终回复',inputRevision:1});
  f.mount(Conversation,{base:f.entityBase.slice(4),conversationId:f.own.id}); await until(()=>document.querySelectorAll('.task-list-item').length===25);
  assert.doesNotMatch(document.querySelector('.task-list-view').textContent,/本会话最终回复|查看任务详情|执行记录/);
  document.querySelector('.task-list-view').dispatchEvent(new Event('scroll'));await until(()=>document.querySelectorAll('.task-list-item').length===31);
  const list=document.querySelector('.task-list-view');list.scrollTop=222;
  document.querySelector(`[data-task-id="${task.id}"] button`).click(); await until(()=>document.querySelector('.activity-text')?.textContent.includes('本会话最终回复'));
  assert.equal(list.style.display,'none');assert.equal(document.querySelectorAll('.n-drawer').length,0);
  await click('← 返回任务列表'); assert.equal(list.style.display,'');assert.equal(list.scrollTop,222);assert.equal(document.activeElement.closest('[data-task-id]').dataset.taskId,task.id);
  await click('刷新状态'); await until(()=>!document.querySelector('.task-list-toolbar .n-button--loading'));assert.equal(document.querySelectorAll('.task-list-item').length,31);assert.equal(list.scrollTop,222);
  assert.ok(f.requests.every(url=>!url.includes('/task-management/')));assert.equal(document.querySelector('form,input,textarea'),null);
});
test('multiple existing Runs select newest and keep expansion per Run without creating execution actions',async t=>{
 const f=await environment(t),task=f.seedTask('runs');const old=f.event(task,'progress',{text:'旧执行进展'});f.repo.insertRun('latest-run',task.id,'latest-session',3000);f.event({...task,runId:'latest-run'},'final_result',{text:'最新执行结果',inputRevision:1});
 f.mount(Detail,{task:f.taskDto(task),endpoint:task.root.slice(4)});await until(()=>document.querySelector('[aria-label="选择执行记录"]'));
 assert.match(document.querySelector('.activity-timeline').textContent,/最新执行结果/);assert.doesNotMatch(document.querySelector('.activity-timeline').textContent,/旧执行进展/);
 {const trigger=document.querySelector('.run-picker .n-base-selection');trigger.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));trigger.click();await flush();}
 const option=[...document.querySelectorAll('.n-base-select-option')].find(element=>element.textContent.includes('第 1 段'));assert.ok(option);option.click();await until(()=>document.querySelector(`[data-entry-id="${old.id}"]`));
 const oldDetails=document.querySelector(`[data-entry-id="${old.id}"] details`);assert.equal(oldDetails.open,false);oldDetails.open=true;oldDetails.dispatchEvent(new Event('toggle'));
 {const trigger=document.querySelector('.run-picker .n-base-selection');trigger.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));trigger.click();await flush();}[...document.querySelectorAll('.n-base-select-option')].find(element=>element.textContent.includes('第 2 段')).click();await until(()=>document.querySelector('.activity-timeline')?.textContent.includes('最新执行结果'));
 {const trigger=document.querySelector('.run-picker .n-base-selection');trigger.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));trigger.click();await flush();}[...document.querySelectorAll('.n-base-select-option')].find(element=>element.textContent.includes('第 1 段')).click();await until(()=>document.querySelector(`[data-entry-id="${old.id}"] details`));assert.equal(document.querySelector(`[data-entry-id="${old.id}"] details`).open,true);assert.equal(f.requests.some(url=>/\/start|\/cancel|\/input/.test(url)),false);
});
test('a background detail refresh does not disable the loaded Run selector or discard its open menu',async t=>{
 const f=await environment(t),task=f.seedTask('refresh-picker');f.repo.insertRun('refresh-new-run',task.id,'refresh-new-session',3000);f.event(task,'progress',{text:'older segment'});f.event({...task,runId:'refresh-new-run'},'final_result',{text:'new segment',inputRevision:1});
 f.mount(Detail,{task:f.taskDto(task),endpoint:task.root.slice(4)});await until(()=>document.querySelector('[aria-label="选择执行记录"]'));
 let release,entered=false;const paused=new Promise(r=>release=r);f.onRequest(async url=>{if(url.includes('/activity?')){entered=true;await paused;}});t.after(()=>release());
 const refresh=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='刷新详情');refresh.click();await until(()=>entered);
 const trigger=document.querySelector('.run-picker .n-base-selection');assert.equal(trigger.classList.contains('n-base-selection--disabled'),false,'loaded selector remains usable while saved records refresh');trigger.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));trigger.click();await flush();assert.ok(document.querySelector('.n-base-select-option'),'Run menu opens during refresh');release();await until(()=>!document.querySelector('.detail-toolbar .n-button--loading'));
});
test('management uses the same content with original admin endpoints; read permission loss clears retained task data',async t=>{
 const f=await environment(t),task=f.seedTask('admin');f.event(task,'final_result',{text:'管理员任务结果',inputRevision:1});
 f.mount(Admin,{workspace:f.owner.workspace,entities:[f.entity]});await until(()=>document.querySelector('.task-records .task-list-item'));
 document.querySelector('.task-records button').click();await until(()=>document.querySelector('.n-drawer .activity-text')?.textContent.includes('管理员任务结果'));
 assert.equal(document.querySelectorAll('.task-detail-content').length,1);assert.ok(f.requests.every(url=>url.includes('/task-management/')));assert.equal(document.querySelector('.n-drawer form, .n-drawer textarea'),null);
 f.store.run("UPDATE members SET status='inactive' WHERE id=?",f.owner.workspace.memberId);await click('刷新详情');await until(()=>!document.querySelector('.task-detail-content'));
 assert.doesNotMatch(document.body.textContent,/管理员任务结果/);
});
test('not-started and missing record states stay readable and do not create empty thinking/tool disclosures',async t=>{
 const f=await environment(t),task=f.seedTask('unstarted',f.own,'planned');f.mount(Detail,{task:f.taskDto(task),endpoint:task.root.slice(4)});
 await until(()=>document.body.textContent.includes('尚未启动，无执行记录'));assert.equal(document.querySelector('.activity-timeline'),null);assert.equal(document.querySelector('select,[aria-label="选择执行记录"]'),null);
 assert.equal([...document.querySelectorAll('summary')].some(element=>/工具|思考/.test(element.textContent)),false);
});
test('real storage read failure keeps a readable retry state and recovery preserves expanded records',async t=>{
 const f=await environment(t),task=f.seedTask('failure');const progress=f.event(task,'progress',{text:'故障前已保存进展'});
 f.mount(Detail,{task:f.taskDto(task),endpoint:task.root.slice(4)});await until(()=>document.querySelector(`[data-entry-id="${progress.id}"]`));
 const details=document.querySelector(`[data-entry-id="${progress.id}"] details`);details.open=true;details.dispatchEvent(new Event('toggle'));
 f.store.db.exec('ALTER TABLE task_updates RENAME TO task_updates_unavailable');await click('刷新详情');await until(()=>document.querySelector('.task-detail-content .n-alert'));
 assert.ok(document.body.textContent.includes('故障前已保存进展'));assert.equal(details.open,true);
 f.store.db.exec('ALTER TABLE task_updates_unavailable RENAME TO task_updates');await click('重新读取');await until(()=>!document.querySelector('.task-detail-content .n-alert'));
 assert.equal(document.querySelector(`[data-entry-id="${progress.id}"] details`).open,true);
});
test('a delayed context rejection from the previous task cannot clear a newly selected authorized detail', async t => {
  const f = await environment(t), old = f.seedTask('old-context'), current = f.seedTask('current-context');
  f.event(old, 'final_result', { text: '前一任务结果', inputRevision: 1 }); f.event(current, 'final_result', { text: '当前授权任务结果', inputRevision: 1 });
  let release, entered = false; const gate = new Promise(resolve => { release = resolve; }); t.after(() => release());
  f.onRequest(async url => { if (url.endsWith('/old-context/context')) { entered = true; await gate; } });
  f.mount(Conversation, { base: f.entityBase.slice(4), conversationId: f.own.id }); await until(() => document.querySelectorAll('.task-list-item').length === 2);
  document.querySelector('[data-task-id="old-context"] button').click(); await until(() => entered);
  await click('← 返回任务列表'); document.querySelector('[data-task-id="current-context"] button').click();
  await until(() => document.querySelector('.activity-text')?.textContent.includes('当前授权任务结果'));
  f.store.run('UPDATE tasks SET conversation_id=? WHERE id=?', f.other.id, old.id); release(); await flush(); await flush();
  assert.ok(document.querySelector('.task-detail-content')); assert.match(document.querySelector('.activity-timeline').textContent, /当前授权任务结果/); assert.equal(document.querySelector('.conversation-task-list>.n-card__content>.n-alert'), null);
});
test('native tool records start collapsed, read only on expansion, scroll pages once and preserve expansion across incremental refresh',async t=>{
 const f=await environment(t,true);
 for(let n=0;n<75;n++)f.manager.appendMessage({role:'assistant',content:[{type:'toolCall',id:'scroll-call-'+n,name:'read',arguments:{path:'fixture-'+n+'.txt'}}],timestamp:1793062800100+n});
 f.mount(Detail,{task:f.taskDto(f.task),endpoint:f.task.root.slice(4)});
 await until(()=>document.querySelectorAll('.activity-timeline li').length===40);
 assert.equal(f.requests.some(url=>url.includes('entryId=')),false);
 const tool=[...document.querySelectorAll('.activity-timeline li')].find(el=>el.querySelector('summary span').textContent.includes('工具调用'));
 const id=tool.dataset.entryId,details=tool.querySelector('details');assert.equal(details.open,false);details.open=true;details.dispatchEvent(new Event('toggle'));
 await until(()=>tool.querySelector('.record-body .activity-text')?.textContent.includes('fixture.txt'));assert.doesNotMatch(tool.textContent,/SYNTHETIC_TOOL_SECRET/);
 const viewport=document.querySelector('.task-detail-content');viewport.scrollTop=400;viewport.dispatchEvent(new Event('scroll'));viewport.dispatchEvent(new Event('scroll'));await until(()=>document.querySelectorAll('.activity-timeline li').length===78);
 assert.equal(f.requests.filter(url=>url.includes('/records?')&&url.includes('cursor=')).length,1,'edge events deduplicate the same pending page');assert.equal(document.querySelector(`[data-entry-id="${id}"] details`).open,true);
 assert.equal([...document.querySelectorAll('button')].some(button=>/上一页|下一页|加载更多记录/.test(button.textContent)),false);
 f.manager.appendMessage({role:'toolResult',toolCallId:'late-append',toolName:'read',content:[{type:'text',text:'刷新后追加结果'}],isError:false,timestamp:1793062801000});await click('刷新详情');await until(()=>document.querySelectorAll('.activity-timeline li').length===79);assert.equal(document.querySelector(`[data-entry-id="${id}"] details`).open,true);
 assert.doesNotMatch(document.body.textContent,/RAW_NATIVE_THINKING|PRIVATE_NATIVE_INPUT/);
});
test('activity pages load at the scroll edge and runtime read failure retries in place without paging buttons',async t=>{
 const f=await environment(t,true);for(let n=0;n<60;n++)f.event(f.task,'progress',{text:'持久进展 '+n});
 let failed=true;f.onRequest(url=>{if(url.includes('/records?')&&failed)throw Error('isolated transport interruption');});
 f.mount(Detail,{task:f.taskDto(f.task),endpoint:f.task.root.slice(4)});await until(()=>document.querySelectorAll('.activity-timeline li').length===50 && document.body.textContent.includes('重试读取记录'));
 const viewport=document.querySelector('.task-detail-content');viewport.scrollTop=500;viewport.dispatchEvent(new Event('scroll'));await until(()=>document.querySelectorAll('.activity-timeline li').length===60);assert.equal(viewport.scrollTop,500);
 failed=false;await click('重试读取记录');await until(()=>document.querySelectorAll('.activity-timeline li').length===63);
 assert.equal([...document.querySelectorAll('button')].some(button=>/上一页|下一页|加载更多记录/.test(button.textContent)),false);
});
test('an old native page cannot append into a newly selected Run after a delayed response',async t=>{
 const f=await environment(t,true);let entered=false,release;const gate=new Promise(resolve=>{release=resolve;});t.after(()=>release());
 f.repo.insertRun('new-ui-run',f.task.id,'new-ui-session',5000);
 f.onRequest(async url=>{if(url.includes('/records?')&&url.includes(encodeURIComponent(f.task.runId))){entered=true;await gate;}});
 f.mount(Detail,{task:f.taskDto(f.task),endpoint:f.task.root.slice(4)});await until(()=>document.querySelector('.run-picker'));
 async function choose(number){const trigger=document.querySelector('.run-picker .n-base-selection');trigger.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));trigger.click();await flush();[...document.querySelectorAll('.n-base-select-option')].find(e=>e.textContent.includes('第 '+number+' 段')).click();await flush();}
 await choose(1);await until(()=>entered);await choose(2);
 await until(()=>document.querySelector('.run-status').textContent.includes('准备中')||document.querySelector('.run-status').textContent.includes('preparing'));release();await flush();await flush();
 assert.equal(document.querySelectorAll('.activity-timeline li').length,0);assert.doesNotMatch(document.body.textContent,/原生执行公开回复|fixture.txt/);
});

test('a changed native body requires explicit record reset and never silently continues an obsolete reference',async t=>{
 const f=await environment(t,true);f.mount(Detail,{task:f.taskDto(f.task),endpoint:f.task.root.slice(4)});await until(()=>document.querySelectorAll('.activity-timeline li').length===3);
 const file=f.manager.getSessionFile(),original=await readFile(file,'utf8');await writeFile(file,original.replace('原生工具结果','变更工具结果'));
 const result=[...document.querySelectorAll('.activity-timeline li')].find(e=>e.querySelector('summary span').textContent.includes('工具结果'));result.querySelector('details').open=true;result.querySelector('details').dispatchEvent(new Event('toggle'));
 await until(()=>document.body.textContent.includes('重新读取记录'));assert.equal(document.querySelectorAll('.activity-timeline li').length,0);assert.doesNotMatch(document.body.textContent,/原生工具结果/);
 await click('重新读取记录');await until(()=>document.querySelectorAll('.activity-timeline li').length===3);
 const fresh=[...document.querySelectorAll('.activity-timeline li')].find(e=>e.querySelector('summary span').textContent.includes('工具结果'));fresh.querySelector('details').open=true;fresh.querySelector('details').dispatchEvent(new Event('toggle'));await until(()=>fresh.textContent.includes('变更工具结果'));
});

for(const state of ['changed','unavailable'])test(`a late old-Run native body ${state} response cannot invalidate the new Run`,async t=>{
 const f=await environment(t,true);f.repo.insertRun('body-new-run',f.task.id,'body-new-session',5000);
 f.mount(Detail,{task:f.taskDto(f.task),endpoint:f.task.root.slice(4)});await until(()=>document.querySelector('.run-picker'));
 async function choose(number){const trigger=document.querySelector('.run-picker .n-base-selection');trigger.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));trigger.click();await flush();[...document.querySelectorAll('.n-base-select-option')].find(e=>e.textContent.includes('第 '+number+' 段')).click();await flush();}
 await choose(1);await until(()=>document.querySelectorAll('.activity-timeline li').length===3);
 const file=f.manager.getSessionFile();if(state==='changed')await writeFile(file,(await readFile(file,'utf8')).replace('原生工具结果','变更工具结果'));else await rm(file);
 let entered=false,release;const gate=new Promise(resolve=>{release=resolve;});t.after(()=>release());
 f.onJson(async(url,data)=>{if(url.includes('/records?')&&url.includes('entryId=')){assert.equal(data.status,state);entered=true;await gate;}});
 const result=[...document.querySelectorAll('.activity-timeline li')].find(e=>e.querySelector('summary span').textContent.includes('工具结果'));result.querySelector('details').open=true;result.querySelector('details').dispatchEvent(new Event('toggle'));await until(()=>entered);
 await choose(2);await until(()=>document.querySelector('.run-status').textContent.includes('preparing'));release();await flush();await flush();
 assert.equal(document.querySelectorAll('.activity-timeline li').length,0);assert.equal([...document.querySelectorAll('button')].some(e=>e.textContent.includes('重新读取记录')),false);assert.doesNotMatch(document.body.textContent,/执行记录已变化|变更工具结果|原生工具结果/);
});
test('restricted platform context results explain the boundary without issuing a lazy body request',async t=>{
 const f=await environment(t,true);f.manager.appendMessage({role:'toolResult',toolCallId:'private-context',toolName:'context_read',content:[{type:'text',text:'PRIVATE_CONTEXT_MUST_NOT_LEAK'}],isError:false,timestamp:1793062801000});
 f.mount(Detail,{task:f.taskDto(f.task),endpoint:f.task.root.slice(4)});await until(()=>document.querySelectorAll('.activity-timeline li').length===4);
 const entry=[...document.querySelectorAll('.activity-timeline li')].find(e=>e.querySelector('summary span').textContent.includes('context_read'));entry.querySelector('details').open=true;entry.querySelector('details').dispatchEvent(new Event('toggle'));await flush();
 assert.match(entry.textContent,/受限上下文/);assert.equal(f.requests.some(url=>url.includes('entryId=')),false);assert.doesNotMatch(document.body.textContent,/PRIVATE_CONTEXT_MUST_NOT_LEAK/);
});

test('result views separate generation, delivery uncertainty and execution success without granting new actions',async t=>{const f=await environment(t),task=f.seedTask('notice-states');const sql="INSERT INTO business_notification_jobs(id,source_kind,source_id,task_id,run_id,workspace_id,entity_id,scope_json,target_json,data_ref,state,turn_id,created_at,delivery_state) VALUES(?,?,?,?,?,?,?,'{}','{}','{}',?,?,?,?)";for(const[id,state,delivery]of[['render','generating','not_started'],['uncertain','published','unknown'],['generation-unknown','unknown','not_started'],['sent','published','sent']])f.store.run(sql,id,'task',id,task.id,task.runId,f.owner.workspace.id,f.entity.id,state,'turn-'+id,1000,delivery);f.mount(Detail,{task:f.taskDto(task),endpoint:task.root.slice(4)});await until(()=>document.querySelector('[aria-label="结果回告"]')?.textContent.includes('已发送'));const content=document.querySelector('[aria-label="结果回告"]').textContent;assert.match(content,/正在整理回告/);assert.match(content,/送达待核对/);assert.match(content,/生成结果待核对/);assert.match(content,/请勿重复发起/);assert.equal(f.store.one('SELECT status FROM tasks WHERE id=?',task.id).status,'succeeded');assert.equal(document.querySelector('[aria-label="结果回告"] button'),null);assert.equal(f.modelCalls,0);});


test('all task surfaces show short titles and keep full instructions in an accessible disclosure',async t=>{
 const f=await environment(t),input='完整原始要求：\n'+'保持所有业务约束'.repeat(200),task=f.seedTask('titled-surfaces',f.own,'planned',input);
 f.repo.setTaskTitle(task.id,'核对客户退款材料');
 f.mount(Conversation,{base:f.entityBase.slice(4),conversationId:f.own.id});await until(()=>document.querySelector('.task-title'));
 assert.equal(document.querySelector('.task-title').textContent.trim(),'核对客户退款材料');assert.equal(document.querySelector('.task-list').textContent.includes('完整原始要求'),false);
 document.querySelector('.task-title').click();await until(()=>document.querySelector('.task-description'));
 assert.equal(document.querySelector('h2').textContent,'核对客户退款材料');const disclosure=document.querySelector('.task-description');assert.equal(disclosure.open,false);assert.equal(disclosure.querySelector('p').textContent,input);
 disclosure.open=true;await click('刷新详情');await until(()=>document.querySelector('.task-description')?.open);assert.equal(document.querySelector('h2').textContent,'核对客户退款材料');
 await click('← 返回任务列表');assert.equal(document.activeElement.textContent.trim(),'核对客户退款材料');
 f.mount(Admin,{workspace:f.owner.workspace,entities:[f.entity]});await until(()=>document.querySelector('.task-title'));
 assert.equal(document.querySelector('.task-title').textContent.trim(),'核对客户退款材料');
 f.mount(Panel,{base:f.entityBase.slice(4),conversationId:f.own.id,history:[]});await until(()=>document.querySelector('.task-summary'));
 assert.equal(document.querySelector('.task-summary').textContent,'核对客户退款材料');await click('详情');await until(()=>document.querySelector('.task-detail .task-description'));
 assert.equal(document.querySelector('.task-detail h4').textContent,'核对客户退款材料');assert.equal(document.querySelector('.task-detail .prewrap').textContent,input);
 assert.equal(f.modelCalls,0);
});

test('manual title validation preserves the draft and saves independent full instructions after correction',async t=>{
 const f=await environment(t);f.mount(Panel,{base:f.entityBase.slice(4),conversationId:f.own.id,history:[]});
 await until(()=>document.querySelector('.create-task .n-collapse-item__header-main'));document.querySelector('.create-task .n-collapse-item__header-main').click();
 await until(()=>document.querySelector('input[aria-label="任务标题（可选）"]'));
 const title=document.querySelector('input[aria-label="任务标题（可选）"]'),input=document.querySelector('textarea[aria-label="任务说明"]');
 const change=async(el,value)=>{el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));await flush();};
 await change(title,'长'.repeat(61));await change(input,'保留完整业务要求，禁止实际执行。');await click('保存为待办');
 await until(()=>[...document.querySelectorAll('[role="alert"]')].some(el=>el.textContent.includes('任务标题最多60')));
 assert.equal(title.value,'长'.repeat(61));assert.equal(input.value,'保留完整业务要求，禁止实际执行。');assert.equal(f.store.one('SELECT count(*) n FROM tasks').n,0);
 await change(title,'核对材料');await click('保存为待办');await until(()=>document.querySelector('.task-detail h4')?.textContent==='核对材料');
 const task=f.store.one('SELECT title,input,status FROM tasks');assert.equal(task.title,'核对材料');assert.equal(task.input,'保留完整业务要求，禁止实际执行。');assert.equal(task.status,'planned');assert.equal(f.store.one('SELECT count(*) n FROM runs').n,0);assert.equal(f.modelCalls,0);
});
