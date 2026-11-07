import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {existsSync, readFileSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Window} from 'happy-dom';
import {build} from 'esbuild';
import {parse, compileScript} from '@vue/compiler-sfc';

// Isolated transport fixtures for the approved platform-to-runtime status UI.
const window = new Window({url: 'http://127.0.0.1:5173/'});
for (const name of ['window', 'document', 'navigator', 'location', 'history', 'Node', 'ShadowRoot', 'Document', 'Element', 'HTMLElement', 'SVGElement', 'Event', 'MouseEvent', 'KeyboardEvent', 'InputEvent', 'FocusEvent', 'PointerEvent', 'Image', 'HTMLInputElement', 'HTMLTextAreaElement', 'getComputedStyle', 'MutationObserver', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame']) Object.defineProperty(globalThis, name, {value: name === 'window' ? window : window[name], configurable: true});
const {createApp, h, reactive, nextTick} = await import('vue');
const bundle = await mkdtemp(resolve('apps/web/.employee-runtime-status-test-'));
const components = {};
for (const name of ['EmployeeRuntimeStatus', 'EmployeeOverview','HumanConfirmationSettings']) {
  const outfile = join(bundle, `${name}.mjs`);
  await build({entryPoints: [`apps/web/src/features/employees/${name}.vue`], outfile, bundle: true, platform: 'node', format: 'esm', external: ['vue', 'naive-ui'], plugins: [{name: 'vue-sfc', setup(builder) {builder.onLoad({filter: /\.vue$/}, async ({path}) => {const {descriptor} = parse(await readFile(path, 'utf8'), {filename: path}); return {contents: compileScript(descriptor, {id: path, inlineTemplate: true, fs: {fileExists: existsSync, readFile: file => readFileSync(file, 'utf8')}}).content, loader: 'ts', resolveDir: resolve(path, '..')};});}}]});
  components[name] = (await import(pathToFileURL(outfile).href)).default;
}
const originalFetch = globalThis.fetch;
test.after(async () => {globalThis.fetch = originalFetch; await rm(bundle, {recursive: true, force: true}); await window.happyDOM.close();});
const base = '/workspaces/workspace-a/entities/employee-a';
const facts = (overrides = {}) => ({status: 'available', observedAt: 1793318400000, configuration: {ready: true, modules: [{name: 'models', revision: '7', observedAt: 1793318400000, error: null}]}, employee: {interaction: {configured: true, available: true, reason: null}, channels: []}, error: null, ...overrides});
const body = () => document.body.textContent;
async function flush() {await new Promise(resolve => setTimeout(resolve, 10)); await nextTick();}
async function until(predicate) {for (let i = 0; i < 100; i++) {if (predicate()) return; await flush();} assert.fail('UI did not reach expected state');}
function button() {const result = [...document.querySelectorAll('button')].find(element => element.textContent.trim() === '刷新状态'); assert.ok(result); return result;}
function deferred() {let resolve;const promise = new Promise(done => {resolve = done;}); return {promise, resolve};}
async function mount(t, handler, initial = {}, component = 'EmployeeRuntimeStatus') {
  const requests = [], props = reactive({base, ...(component === 'EmployeeRuntimeStatus' ? {modelReady: true, channelCount: 0} : {}), ...initial});
  globalThis.fetch = async (url, options) => {const request = {url: String(url), ...options}; requests.push(request); const result = await handler(request); return {ok: (result?.statusCode ?? 200) < 400, status: result?.statusCode ?? 200, json: async () => result?.data ?? result};};
  document.body.innerHTML = '<div id="runtime-status-test"></div>';
  const app = createApp({render: () => h(components[component], {...props})}); app.mount('#runtime-status-test'); await flush();
  t.after(() => {app.unmount(); document.body.innerHTML = '';}); return {props, requests, app};
}

test('Web-ready employee with no channel keeps optional configuration separate from runtime observations', async t => {
  const env = await mount(t, async () => facts()); await until(() => body().includes('可接收对话'));
  assert.match(document.querySelector('[aria-label="平台配置情况"]').textContent, /尚未接入渠道/);
  assert.match(document.querySelector('[aria-label="运行侧观测"]').textContent, /可接收对话/);
  assert.match(body(), /已选择模型/); assert.match(body(), /暂无渠道运行记录/);
  assert.ok(!body().includes('全部在线'));
  const detail=document.querySelector('.runtime-details');assert.ok(detail);assert.equal(detail.open,false);assert.match(detail.textContent,/配置不代表模型或渠道已验证连通/);
  assert.equal(env.requests[0].url, `/api${base}/runtime-status`); assert.equal(env.requests[0].credentials, 'same-origin');
});
test('missing local model and runtime configuration not ready are distinct facts', async t => {
  await mount(t, async () => facts({status: 'not_ready', configuration: {ready: false, modules: []}, employee: null}), {modelReady: false});
  await until(() => body().includes('尚未就绪'));
  assert.match(body(), /尚未选择模型，请先配置/); assert.match(body(), /暂时无法获取这位员工的运行情况/);
  assert.ok(!body().includes('可接收对话'));
});
test('failed status read preserves local configuration and retry genuinely fetches again', async t => {
  let fail = true; const env = await mount(t, async () => fail ? {statusCode: 503, data: {error: 'runtime_service_unavailable'}} : facts());
  await until(() => body().includes('暂时无法获取运行状态'));
  assert.match(body(), /已选择模型/); assert.ok(!body().includes('尚未选择模型')); assert.ok(!body().includes('可接收对话'));
  fail = false; button().click(); await until(() => body().includes('可接收对话')); assert.equal(env.requests.length, 2);
});
test('partial configuration and unknown interaction never imply ready, detail reports applied revision', async t => {
  await mount(t, async () => facts({configuration: {ready: false, modules: [{name: 'channels', revision: '4', observedAt: null, error: 'poll_failed'}]}, employee: {interaction: {configured: true, available: null, reason: null}, channels: []}}));
  await until(() => body().includes('尚未确认是否可接收对话'));
  assert.match(body(), /部分配置尚未同步/);assert.ok(!body().includes('对话：可接收对话'));
  const detail=document.querySelector('.runtime-details');assert.ok(detail);assert.equal(detail.open,false);
  detail.querySelector('summary').click();await flush();assert.equal(detail.open,true);
  assert.match(detail.textContent, /已应用版本 4/);assert.match(detail.textContent, /最近读取失败/);
});
test('per-channel states stay independent and do not turn configured into connected', async t => {
  await mount(t, async () => facts({employee: {interaction: {configured: true, available: false, reason: 'employee_disabled'}, channels: [{provider: 'feishu', configured: true, state: 'disconnected', reason: null}, {provider: 'dingtalk', configured: false, state: 'connected', reason: null}]}}), {channelCount: 2});
  await until(() => body().includes('飞书：未连接'));
  assert.match(body(), /已配置 2 个渠道连接/); assert.match(body(), /钉钉：渠道配置尚未同步/); assert.match(body(), /员工已停用/);
  assert.ok(!body().includes('钉钉：已连接'));
});
test('refresh disables duplicate requests while pending and replaces previous observations', async t => {
  const pending = deferred(); let calls = 0;
  await mount(t, async () => ++calls === 1 ? facts() : pending.promise); await until(() => body().includes('可接收对话'));
  button().click(); await flush(); assert.equal(button().disabled, true); button().click(); assert.equal(calls, 2); assert.ok(!body().includes('可接收对话'));
  pending.resolve(facts({status: 'unavailable', employee: null, error: 'runtime_service_unavailable'})); await until(() => body().includes('运行服务暂不可用'));
  assert.equal(button().disabled, false); assert.ok(!body().includes('可接收对话'));
});
test('employee switch aborts stale request and a late response cannot leak another employee state', async t => {
  const old = deferred(); const env = await mount(t, async request => request.url.includes('employee-a') ? old.promise : facts({employee: {interaction: {configured: false, available: null, reason: null}, channels: []}}));
  env.props.base = '/workspaces/workspace-b/entities/employee-b'; await until(() => body().includes('对话配置尚未同步'));
  assert.equal(env.requests[0].signal.aborted, true); old.resolve(facts()); await flush(); assert.ok(!body().includes('可接收对话'));
  assert.equal(env.requests[1].url, '/api/workspaces/workspace-b/entities/employee-b/runtime-status');
});
test('configuration refresh rechecks runtime and unmount aborts the outstanding read', async t => {
  const pending = deferred(); const env = await mount(t, async () => pending.promise, {refreshKey: 1});
  env.props.refreshKey = 2; await until(() => env.requests.length === 2); assert.equal(env.requests[0].signal.aborted, true);
  env.app.unmount(); assert.equal(env.requests[1].signal.aborted, true); pending.resolve(facts()); await flush(); assert.ok(!body().includes('可接收对话'));
});
test('runtime observation loads independently when the platform overview read fails', async t => {
  await mount(t, async request => request.url.endsWith('/overview') ? {statusCode: 503, data: {error: 'overview_unavailable'}} : facts(), {}, 'EmployeeOverview');
  await until(() => body().includes('可接收对话'));
  assert.match(body(), /overview_unavailable/); assert.match(body(), /模型配置尚未确认/);
});

test('actual model selection and ingress states expose concrete next steps without pretending connectivity',async t=>{
 await mount(t,async()=>facts({employee:{interaction:{configured:false,available:false,reason:'model_selection_required'},channels:[{provider:'feishu',configured:true,state:'reconnecting',reason:null},{provider:'wecom',configured:true,state:'stopped',reason:null}]}}),{modelReady:false,channelCount:2});
 await until(()=>body().includes('请在员工设置中选择模型'));
 assert.match(body(),/飞书：正在重新连接/);assert.match(body(),/企业微信：未启动/);assert.ok(!body().includes('暂时无法确认具体原因'));
});

test('execution material preparation distinguishes missing model from prepared resources without claiming provider readiness',async t=>{
 const f=facts();f.employee.execution={desired:'model-v1',fetched:'model-v1',prepared:'sha256-fixture',reason:null,observedAt:1};
 await mount(t,async()=>f);await until(()=>body().includes('执行材料：已准备'));assert.equal(body().includes('模型连通成功'),false);
});
test('execution preparation unavailable remains explicit instead of showing ready',async t=>{
 const f=facts();f.employee.execution={desired:'model-v1',fetched:null,prepared:null,reason:'runtime_preparation_unavailable',observedAt:1};
 await mount(t,async()=>f);await until(()=>body().includes('执行资源暂时无法准备'));assert.equal(body().includes('执行材料：已准备'),false);
});


test('human confirmation settings save a concrete recipient with CAS and prevent unchanged duplicate saves',async t=>{
 let saved=false;const target={kind:'web',userId:'fixture-user'};const env=await mount(t,async request=>{if(request.method==='PUT'){const body=JSON.parse(request.body);assert.equal(body.expectedVersion,0);assert.deepEqual(body.rules,[{questionScope:'*',target}]);if(saved)return{statusCode:409,data:{error:'human_rules_changed'}};saved=true;return{version:1,rules:body.rules};}return{version:0,rules:[],subjects:{sources:[],users:[],departments:[]},candidates:[{label:'QA Web',target}]};},{},'HumanConfirmationSettings');await until(()=>body().includes('尚未设置专门接收人'));const btn=text=>[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===text);btn('添加确认规则').click();await flush();assert.equal(document.querySelector('input[aria-label="确认问题范围"]').value,'*');btn('保存确认设置').click();await until(()=>body().includes('人工确认接收人已保存'));assert.equal(env.requests.filter(x=>x.method==='PUT').length,1);assert.equal(btn('保存确认设置').disabled,true);
});

test('human recipient usage rejection is visible and keeps the unsaved rule for correction',async t=>{
 const target={kind:'web',userId:'ungranted-user'};await mount(t,async r=>r.method==='PUT'?{statusCode:403,data:{error:'human_recipient_use_forbidden'}}:{version:0,rules:[],subjects:{sources:[],users:[],departments:[]},candidates:[{label:'Synthetic member',target}]},{},'HumanConfirmationSettings');await until(()=>body().includes('尚未设置专门接收人'));const btn=text=>[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===text);btn('添加确认规则').click();await flush();btn('保存确认设置').click();await until(()=>body().includes('确认人须具备此员工的使用权'));assert.equal(body().includes('人工确认接收人已保存'),false);assert.equal(document.querySelector('input[aria-label="确认问题范围"]').value,'*');assert.equal(body().includes('有未保存的确认设置'),true);assert.equal(btn('保存确认设置').disabled,false);
});
