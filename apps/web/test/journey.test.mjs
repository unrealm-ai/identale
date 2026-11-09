import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Window } from 'happy-dom';
import { build } from 'esbuild';
import { parse, compileScript } from '@vue/compiler-sfc';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from '../../control-plane/dist/server.js';
import { Store } from '../../control-plane/dist/store.js';
import { createJournalIndex } from '../../control-plane/dist/adapters/sqlite/journal-index.js';
import { ModelProfileService } from '../../control-plane/dist/model-profiles.js';
import { SqliteConversationRepository } from '../../control-plane/dist/adapters/sqlite/conversation-repository.js';
import { SqliteTaskRepository } from '../../control-plane/dist/adapters/sqlite/task-repository.js';
import { JsonlJournal } from '../../../packages/runtime-builtin/dist/index.js';
import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
const nativeFetch = globalThis.fetch;

// DOM simulation, not browser QA. Transport goes directly to the real Fastify app,
// with isolated SQLite and no real model provider, runtime or business side effect.
// Approved probe cases use an ephemeral loopback HTTP service with synthetic credentials.
const window = new Window({ url: 'http://127.0.0.1:5173/' });
for (const name of ['window', 'document', 'navigator', 'location', 'history', 'localStorage', 'Node', 'ShadowRoot', 'Document', 'Element', 'HTMLElement', 'SVGElement', 'HTMLDialogElement', 'Event', 'MouseEvent', 'KeyboardEvent', 'PointerEvent', 'FocusEvent', 'InputEvent', 'Image', 'HTMLInputElement', 'HTMLTextAreaElement', 'getComputedStyle', 'MutationObserver', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(globalThis, name, { value: name === 'window' ? window : window[name], configurable: true });
}
const { createApp, nextTick, h } = await import('vue');
const bundleDir = await mkdtemp(resolve('apps/web/.ui-test-'));
await build({ entryPoints: {App:'apps/web/src/App.vue',TaskPanel:'apps/web/src/features/tasks/TaskPanel.vue',EmployeeAvatar:'apps/web/src/shared/ui/EmployeeAvatar.vue',PageHeader:'apps/web/src/shared/ui/PageHeader.vue'}, outdir:bundleDir, outExtension:{'.js':'.mjs'}, bundle: true, platform: 'node', format: 'esm', external: ['vue', 'naive-ui'], plugins: [{ name: 'vue-sfc', setup(build) {
  build.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
    const { descriptor } = parse(await readFile(path, 'utf8'), { filename: path });
    return { contents: compileScript(descriptor, { id: path, inlineTemplate: true, fs: { fileExists: existsSync, readFile: file => readFileSync(file, 'utf8') } }).content, loader: 'ts', resolveDir: resolve(path, '..') };
  });
} }] });
const App = (await import(pathToFileURL(join(bundleDir, 'App.mjs')).href)).default;
const EmployeeAvatar=(await import(pathToFileURL(join(bundleDir,'EmployeeAvatar.mjs')).href)).default;
const PageHeader=(await import(pathToFileURL(join(bundleDir,'PageHeader.mjs')).href)).default;
const TaskPanel=(await import(pathToFileURL(join(bundleDir,'TaskPanel.mjs')).href)).default;
test.after(async () => { await rm(bundleDir, { recursive: true, force: true }); await window.happyDOM.close(); });
const password = 'n8V!q2';
async function flush() { await new Promise(resolve => setTimeout(resolve, 15)); await nextTick(); }
async function until(predicate, description = 'UI settled') { for (let i = 0; i < 100; i++) { await flush(); if (predicate()) return; } assert.fail(description + '\n' + document.body.textContent); }
const text = () => document.body.textContent;
function visible(el) { if (!el) return false; for (let node = el; node instanceof HTMLElement; node = node.parentElement) { if (node.style.display === 'none' || node.hidden || node.getAttribute('aria-hidden') === 'true') return false; } return true; }
const migratedLabels={'＋ 创建数字员工':'创建数字员工','暂时退出':'取消','渠道接入':'渠道','工作能力':'能力包','自动运行':'触发器','使用范围':'概览','员工设置':'模型','导入并发布':'导入','取消，返回列表':'取消','保存 MCP':'保存','保存模型配置':'保存','查看员工':'管理','查看使用范围':'概览'};
function button(label) { const navLink=[...document.querySelectorAll('.app-nav a')].find(a=>visible(a)&&a.textContent.trim()===label);if(navLink)return navLink;const candidates=[...document.querySelectorAll('button,[role=tab],[role=menuitem]')].filter(visible);const original=candidates.find(item=>item.textContent.trim()===label||item.getAttribute('aria-label')===label);if(original)return original;label=migratedLabels[label]??label; const found = [...document.querySelectorAll('button, [role=tab], [role=menuitem]')].filter(visible).find(item => item.textContent.trim() === label || item.getAttribute('aria-label') === label); assert.ok(found, `button ${label}: ${document.body.textContent}`); return found; }
async function click(label) {await nextTick();await until(()=>{try{return !!button(label);}catch{return false;}},'button ready: '+label);button(label).click();await flush();if(label==='渠道接入'||label==='渠道'){const b=[...document.querySelectorAll('button')].find(b=>visible(b)&&['查看此连接','添加渠道连接'].includes(b.textContent.trim()));if(b){b.click();await flush();}const d=document.querySelector('.channel-guide-toggle');if(d)d.open=true;}}
function input(selector, value) { if(selector==='.employee-settings form input')selector='.n-drawer input[aria-label="员工名称"]';const el = document.querySelector(selector); assert.ok(el, selector); el.value = value; el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value })); }
async function submit(selector) { await nextTick();if(selector==='.employee-settings form'&&!document.querySelector(selector))selector='.n-drawer form'; document.querySelector(selector).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flush(); }
async function setup(t, provider, approvedResources, runtime) {
  const dir = await mkdtemp(join(tmpdir(), 'dentity-ui-'));
  const path = join(dir, 'test.sqlite');
  let taskService;
  const server = createServer({ ...(runtime ? { runtime, pollIntervalMs: 0, modelProfiles: { masterKey: Buffer.alloc(32, 31) } } : {}), onService: service => { taskService = service; }, databasePath: path, origin: 'http://127.0.0.1:5173', ...(approvedResources ? { approvedResources } : {}), ...(provider ? { modelProfiles: { masterKey: Buffer.alloc(32, 31), allowLoopbackHttp: true } } : {}) });
  await server.ready();
  const db = new DatabaseSync(path);
  let cookie = '', app, responseHook;
  function onResponse(hook) { responseHook = hook; }
  const requests = [];
  async function call(method, url, body, suppliedCookie = cookie) {
    return server.inject({ method, url, ...(body === undefined ? {} : { payload: body }), headers: { origin: 'http://127.0.0.1:5173', ...(suppliedCookie ? { cookie: suppliedCookie } : {}) } });
  }
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).startsWith('http')) {
      assert.ok(provider && new URL(String(url)).origin === provider.origin, 'Only approved local provider requests are allowed');
      return nativeFetch(url, options);
    }
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    requests.push({ method: options.method, url: String(url), ...(options.body ? { body: JSON.parse(options.body) } : {}) });
    const result = await call(options.method ?? 'GET', String(url), options.body ? JSON.parse(options.body) : undefined);
    if (responseHook) await responseHook({ url: String(url), method: options.method, result });
    const setCookie = result.headers['set-cookie']; if (setCookie) cookie = String(setCookie).split(';')[0];
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    return new Response(result.body, { status: result.statusCode, headers: { 'content-type': 'application/json' } });
  };
  async function register(username, extra = {}) { const response = await call('POST', '/api/auth/register', { username, password, ...extra }); assert.equal(response.statusCode, 201, response.body); cookie = response.headers['set-cookie'].split(';')[0]; return { ...response.json(), cookie }; }
  async function mount(url = '/', {expandWizard=true,openTasks=true}={}) { app?.unmount(); document.body.innerHTML = '<div id="app"></div>'; history.replaceState(null, '', url); const q=new URL(url,'http://127.0.0.1').searchParams;app=q.get('view')==='task-fixture'?createApp(TaskPanel,{base:`/workspaces/${q.get('ws')}/entities/${q.get('entity')}`,conversationId:q.get('conversation'),history:[]}):createApp(App); app.mount('#app'); await until(() => !text().includes('正在连接工作台'), 'app initialized');const expand=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='展开渠道、工作能力与自动运行配置');if(expand&&expandWizard){expand.click();await flush();}if(q.get('view')==='settings'&&q.get('section')==='identity')await until(()=>!!document.querySelector('input[aria-label="员工名称"]'),'identity drawer initialized');if(q.get('view')==='settings'&&q.get('section')==='model')await until(()=>!!document.querySelector('.model-settings'),'model section initialized');if(q.get('view')==='chat'&&openTasks){await until(()=>!!document.querySelector('.chat-panel')||text().includes('模型尚未配置'));const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='查看本会话任务');if(b){b.click();await flush();}} }
  t.after(async () => { app?.unmount(); document.body.innerHTML = ''; localStorage.clear(); history.replaceState(null, '', '/'); db.close(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  function historicalDemo(owner, entity) {
    // Seed historical state through the real repository/journal; the public API can no longer create demo.
    const store = new Store(path);
    try {
      const journal = new JsonlJournal({ root: join(dir, 'builtin-records'), ownerId: JSON.stringify([store.databaseId, store.databasePath]), serialize: fn => store.transaction(fn), index:createJournalIndex(store) });
      const repository = new SqliteConversationRepository(store, journal);
      const scope = { workspaceId: owner.workspace.id, entityId: entity.id, userId: owner.user.id }, id = randomUUID(), at = Date.now();
      repository.create(id, scope, `historical:${id}`, at, 'demo', 0);
      const record = repository.get(id);
      repository.addMessage(`historical-user:${id}`, record, 'user', '旧的模拟输入', at, true);
      repository.addMessage(`historical-assistant:${id}`, record, 'assistant', '旧的模拟回复，不是业务完成证据', at + 1, true);
      return { id, mode: 'demo', simulated: true };
    } finally { store.close(); }
  }
  function taskModelFixture(owner, entity) {
    const store = new Store(path);
    try {
      // Trusted fixture import only, never a simulated connection-test result.
      new ModelProfileService(store, { masterKey: Buffer.alloc(32, 31) }).save(owner.workspace.id, entity.id, {
        name: 'Isolated task configuration', provider: 'openai-compatible', endpoint: 'https://synthetic.invalid/v1', modelId: 'synthetic-task-model', apiKey: 'synthetic-task-fixture-key',
      });
    } finally { store.close(); }
  }
  function realConversation(owner, entity) {
    // Persist isolated authorized conversation metadata, without calling any model.
    const store = new Store(path);
    try {
      const journal = new JsonlJournal({ root: join(dir, 'builtin-records'), ownerId: JSON.stringify([store.databaseId, store.databasePath]), serialize: fn => store.transaction(fn), index:createJournalIndex(store) });
      const repository = new SqliteConversationRepository(store, journal);
      const id = randomUUID(); repository.create(id, { workspaceId: owner.workspace.id, entityId: entity.id, userId: owner.user.id }, `fixture:${id}`, Date.now(), 'real', 0);
      return { id };
    } finally { store.close(); }
  }
  function persistedProgress(owner, entity, conversationId) {
    // A read-projection UI fixture, not evidence of Runtime execution or task completion.
    const store = new Store(path);
    try {
      const repository = new SqliteTaskRepository(store), at = Date.now(), id = randomUUID(), runId = randomUUID();
      const scope = { workspaceId: owner.workspace.id, entityId: entity.id, userId: owner.user.id };
      repository.transaction(() => {
        repository.insertTask(id, scope, conversationId, `fixture:${id}`, 'synthetic-fixture', '合成持久反馈测试', 'new', randomUUID(), '{}', JSON.stringify(scope), runId, at, at);
        repository.insertRun(runId, id, randomUUID(), at);
        repository.setRunStatus('running', runId); repository.setTaskStatus('running', at, id);
        repository.insertDelivery(randomUUID(), id, conversationId, randomUUID(), '合成已持久化进度：正在处理文章', at);
      });
      return id;
    } finally { store.close(); }
  }
  function retainedMessage(id, text, role = 'user') {
    const store=new Store(path);
    try {const journal=new JsonlJournal({root:join(dir,'builtin-records'),ownerId:JSON.stringify([store.databaseId,store.databasePath]),serialize:fn=>store.transaction(fn),index:createJournalIndex(store)}),repository=new SqliteConversationRepository(store,journal);repository.addMessage(randomUUID(),repository.get(id),role,text,Date.now(),false);}finally{store.close();}
  }
  return { db, call, register, mount, requests, onResponse, historicalDemo, realConversation, taskModelFixture, persistedProgress, retainedMessage, get taskService() { return taskService; }, setCookie(value) { cookie = value; } };
}
async function wizardBasics(name = '流程助手') { input('input[aria-label="员工名称"]', name); await until(()=>!button('确认创建数字员工').disabled); }

test('management owner route opens shared models in empty workspace without forcing employee creation',async t=>{
  const env=await setup(t),owner=await env.register('management-empty-owner');
  await env.mount(`/?ws=${owner.workspace.id}&view=management&section=models`);
  await until(()=>!!document.querySelector('.workspace-management .model-settings'));
  assert.equal(document.querySelector('.employee-wizard'),null);assert.ok([...document.querySelectorAll('.app-nav a')].some(a=>a.textContent==='资源库'));
  assert.equal(new URLSearchParams(location.search).get('section'),'models');
  assert.ok(document.querySelector('.model-settings input[aria-label="配置名称"]'));
  assert.equal(env.db.prepare('SELECT count(*) n FROM entities').get().n,0);
});
test('legacy workspace model route restores the management models tab',async t=>{
  const env=await setup(t),owner=await env.register('management-legacy-owner');
  await env.mount(`/?ws=${owner.workspace.id}&view=workspace-models`);
  await until(()=>!!document.querySelector('.workspace-management .model-settings'));
  assert.equal(new URLSearchParams(location.search).get('view'),'management');assert.equal(new URLSearchParams(location.search).get('section'),'models');
});
test('management routes allow ordinary member resources but never expose member administration',async t=>{
 const env=await setup(t),owner=await env.register('management-role-owner'),invite=(await env.call('POST',`/api/workspaces/${owner.workspace.id}/invitations`,{})).json(),member=await env.register('management-ordinary-member',{invitationToken:invite.token});
 for(const view of ['management','workspace-models']){await env.mount(`/?ws=${member.workspace.id}&view=${view}&section=models`);await until(()=>!!document.querySelector('.workspace-management .model-settings'));assert.ok([...document.querySelectorAll('.app-nav a')].some(a=>a.textContent==='资源库'));assert.equal([...document.querySelectorAll('[role=tab]')].some(t=>t.textContent.trim()==='成员'),false);assert.equal(new URLSearchParams(location.search).get('view'),'management');}
});

test('registration creates one default workspace, wizard skips optional steps, double-click creates once, cards separate chat/settings', async t => {
  const env = await setup(t); await env.mount(); await click('注册账号');
  assert.equal(document.querySelector('input[name=password]').minLength, 6);
  assert.equal(document.querySelector('.auth-brand .brand-logo').textContent.trim(), 'identale');
  assert.equal(document.querySelector('.auth-brand .brand-logo img').getAttribute('src'), '/brand/lockup-horizontal.svg');
  input('input[name=username]', 'journey-owner'); input('input[name=password]', password); await submit('.auth-panel form');
  await until(() => !!document.querySelector('.employee-wizard'));
  assert.equal(env.db.prepare('SELECT count(*) n FROM workspaces').get().n, 1);
  input('.employee-wizard input', '流程助手');
  assert.ok(document.querySelector('.employee-access-draft [aria-label="创建员工可用范围"]'));assert.equal(document.querySelector('[aria-label="员工允许成员"]'),null);
  await until(()=>!button('确认创建数字员工').disabled);
  const create = button('确认创建数字员工'); create.click(); create.click();
  await until(()=>!document.querySelector('.employee-wizard')&&!!document.querySelector('.employee-settings'));await click('返回员工列表');
  assert.equal(env.db.prepare('SELECT count(*) n FROM entities').get().n, 1);
  assert.equal(env.requests.filter(r => r.method === 'POST' && /\/employee-creations$/.test(r.url)).length, 1);
  const selfGrant = env.db.prepare('SELECT own_web_use, web_use_user_id FROM entities').get();
  assert.equal(selfGrant.own_web_use, 1);
  assert.equal(selfGrant.web_use_user_id, env.db.prepare('SELECT id FROM users').get().id);
  await click('查看员工'); assert.ok(document.querySelector('.employee-settings')); assert.equal(document.querySelector('.chat-panel'), null);
  await click('返回员工列表');assert.equal([...document.querySelectorAll('.employee-card button')].some(b=>b.textContent.trim()==='开始对话'),false);await until(()=>document.querySelector('.employee-card')?.textContent.includes('尚无可用模型'));await click('查看员工');await until(()=>!!document.querySelector('.employee-next-step'));await click('选择模型');await until(()=>!!document.querySelector('.model-settings'));assert.match(text(),/暂无共享模型/);
  assert.equal(env.db.prepare('SELECT count(*) n FROM conversations').get().n, 0);
  assert.equal(document.querySelector('.mode-picker'), null);
  assert.equal(env.db.prepare('SELECT count(*) n FROM tasks').get().n, 0);
});

test('capability configuration follows employee creation and keeps its own save boundary', async t => {
  const env = await setup(t); const owner=await env.register('advanced-owner'); await env.mount();await wizardBasics('高级助手');
  assert.equal(document.querySelector('.package-editor'),null);assert.equal(env.db.prepare('SELECT count(*) n FROM entities').get().n,0);await click('确认创建数字员工');await until(()=>!!document.querySelector('.employee-settings'));
  assert.equal(env.db.prepare('SELECT count(*) n FROM capability_packages').get().n,0);await click('工作能力');await click('新建能力包');input('input[aria-label="能力包名称"]','创建后保存的能力包');
  assert.equal(env.db.prepare('SELECT count(*) n FROM capability_packages').get().n,0);await click('保存能力包');await until(()=>!document.querySelector('.package-editor'));
  const entity=env.db.prepare('SELECT id,own_web_use FROM entities').get();assert.equal(entity.own_web_use,1);assert.equal(env.db.prepare('SELECT count(*) n FROM capability_packages').get().n,1);
  assert.equal((await env.call('GET',`/api/workspaces/${owner.workspace.id}/entities/${entity.id}/capability-packages`)).json()[0].name,'创建后保存的能力包');
});

test('invitation registration joins target without default workspace and member empty state is not creation wizard', async t => {
  const env = await setup(t); const owner = await env.register('invite-owner');
  const invite = (await env.call('POST', `/api/workspaces/${owner.workspace.id}/invitations`, {})).json(); env.setCookie('');
  await env.mount('/#invite=' + encodeURIComponent(invite.token));
  assert.doesNotMatch(document.querySelector('.invite-context').textContent, /仅限一次/);
  assert.equal(location.hash, ''); await click('注册账号'); input('input[name=username]', 'invited-member'); input('input[name=password]', password); await submit('.auth-panel form');
  await until(() => !!document.querySelector('.app-nav'));
  assert.equal(env.db.prepare('SELECT count(*) n FROM workspaces').get().n, 1);
  assert.ok(document.querySelector('.employee-wizard'));assert.ok(document.querySelector('input[aria-label="员工名称"]'));
});

test('invitation dialog uses whole days and generates a reusable link at the 180-day limit', async t => {
  const env = await setup(t); const owner = await env.register('invite-dialog-owner');
  await env.mount(); await click('暂时退出');
  await click('设置'); await click('成员'); await click('邀请成员');
  const selector = 'input[aria-label="有效期（天）"]';
  const expiry = document.querySelector(selector);
  assert.equal(expiry.value, '2');
  assert.ok(button('生成邀请链接'));
  assert.equal(document.querySelectorAll('.workspace-dialog form .n-form-item').length, 2);
  expiry.focus();
  input(selector, '180');
  expiry.blur();
  await flush();
  await submit('.workspace-dialog form');
  await until(() => !!document.querySelector('input[aria-label="邀请链接"]'));
  const created = env.requests.find(r => r.method === 'POST' && r.url === `/api/workspaces/${owner.workspace.id}/invitations`);
  assert.deepEqual(created.body, { role: 'member', expiresInHours: 180 * 24 });
  assert.match(document.querySelector('.invite-result').textContent, /有效期内可供多人加入/);
});

test('accept invitation after auth expires preserves invitation through login and registration choice', async t => {
  const env = await setup(t); const owner = await env.register('target-owner');
  const invite = (await env.call('POST', `/api/workspaces/${owner.workspace.id}/invitations`, {})).json(); await env.register('existing-user');
  await env.mount('/#invite=' + encodeURIComponent(invite.token));
  await until(() => [...document.querySelectorAll('button')].some(el => el.textContent === '确认接受邀请'));
  env.db.exec('UPDATE sessions SET revoked=1'); await click('确认接受邀请');
  await until(() => !!document.querySelector('.auth-panel'));
  assert.ok(document.querySelector('.invite-context')); assert.match(text(), /新账号注册后直接加入/);
  await click('注册账号'); assert.ok(button('注册并加入受邀工作区'));
});

test('cancel draft creates nothing; workspace menu creates/selects isolated scope and URL restores current workspace', async t => {
  const env = await setup(t); const owner = await env.register('switch-owner'); await env.mount();
  input('.employee-wizard input', '未保存草稿');
  await flush();
  await click('暂时退出'); await click('丢弃草稿并退出');
  assert.equal(env.db.prepare('SELECT count(*) n FROM entities').get().n, 0);
  document.querySelector('.workspace-trigger').click(); await flush(); await click('＋ 创建工作区');
  await until(() => !!document.querySelector('#new-workspace'), 'workspace form opened'); input('#new-workspace', '第二工作区'); await submit('.workspace-dialog form'); await until(() => !!document.querySelector('.employee-wizard'));
  assert.equal(env.db.prepare('SELECT count(*) n FROM workspaces').get().n, 2);
  const ws = new URLSearchParams(location.search).get('ws'); assert.notEqual(ws, owner.workspace.id);
  await click('暂时退出'); await env.mount(location.pathname + location.search); assert.match(document.querySelector('.workspace-trigger').textContent, /第二工作区/);
  assert.equal(document.querySelector('.employee-wizard textarea').value, '');
  input('.employee-wizard input', '新草稿');
  assert.ok(document.querySelector('.employee-access-draft'), 'fresh wizard has its independent employee scope draft');
});

test('conversation employee list excludes forbidden employees and preserves historical demo without reopening it as IM', async t => {
  const env = await setup(t); const owner = await env.register('history-owner');
  const base = `/api/workspaces/${owner.workspace.id}/entities`;
  await env.call('POST', base, { name: '未授权员工', ownWebUse: false });
  const entity = (await env.call('POST', base, { name: '演示员工', ownWebUse: true })).json().entity;
  const historical = env.historicalDemo(owner, entity),before=env.db.prepare('SELECT * FROM conversations WHERE id=?').get(historical.id);
  await env.mount(`/?ws=${owner.workspace.id}&view=conversations`);
  await until(() => !!document.querySelector('.conversation-row'));
  assert.doesNotMatch(document.querySelector('.conversation-list').textContent,/未授权员工/);
  document.querySelector('.conversation-row').click();await until(()=>!!document.querySelector('.chat-messages'));assert.match(text(),/历史演示记录 · 只读/);
  assert.equal(document.querySelector('.composer'),null);assert.equal(document.querySelector('.task-panel'),null);
  assert.match(document.querySelector('.entity-workspace').textContent,/旧的模拟输入/);assert.match(document.querySelector('.entity-workspace').textContent,/旧的模拟回复/);
  const messages=await env.call('GET',`${base}/${entity.id}/conversations/${historical.id}/messages`);
  assert.equal(messages.statusCode,200,messages.body);assert.match(messages.body,/旧的模拟输入/);
  assert.deepEqual(env.db.prepare('SELECT * FROM conversations WHERE id=?').get(historical.id),before);
  assert.equal(env.db.prepare('SELECT count(*) n FROM conversations').get().n,1);
  assert.equal(env.requests.filter(r=>r.method==='POST'&&/\/(turns|interrupt)$/.test(r.url)).length,0);
});

test('lost final create response replays the frozen full draft without duplicate employee', async t => {
  const env = await setup(t); await env.register('retry-owner'); await env.mount(); await wizardBasics('幂等员工');
  let dropped = false;
  env.onResponse(({ method, url }) => { if (!dropped && method === 'POST' && /\/employee-creations$/.test(url)) { dropped = true; throw new TypeError('Synthetic lost response after real server commit'); } });
  await click('确认创建数字员工'); await until(() => text().includes('安全重试'));
  assert.equal(env.db.prepare('SELECT count(*) n FROM entities').get().n, 1);
  await click('安全重试'); await until(()=>!document.querySelector('.employee-wizard')&&!!document.querySelector('.employee-settings'));await click('返回员工列表');
  const attempts = env.requests.filter(r => r.method === 'POST' && /\/employee-creations$/.test(r.url)); assert.equal(attempts.length, 2); assert.deepEqual(attempts[0].body, attempts[1].body);
  assert.equal(env.db.prepare('SELECT count(*) n FROM entities').get().n, 1);
});

test('workspace disclosure Escape, dialog cancel and browser Back preserve current scope', async t => {
  const env = await setup(t); const owner = await env.register('dialog-owner'); await env.mount(); await click('暂时退出');
  const trigger = document.querySelector('.workspace-trigger'); trigger.click(); await flush(); assert.ok([...document.querySelectorAll('[role=menu][aria-label=工作区选择与管理]')].find(visible));
  (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })); await until(() => ![...document.querySelectorAll('[role=menu][aria-label=工作区选择与管理]')].some(visible), 'workspace menu closes after Escape');
  await click('设置');await click('成员');await click('邀请成员'); await until(() => !!document.querySelector('.workspace-dialog')); assert.ok(visible(document.querySelector('.workspace-dialog')));
  history.pushState(null, '', '/?ws=unverified&view=tasks'); window.dispatchEvent(new Event('popstate')); await flush();
  assert.equal(new URLSearchParams(location.search).get('ws'), owner.workspace.id); assert.ok(visible(document.querySelector('.workspace-dialog')));
  (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })); await until(() => !document.querySelector('.workspace-dialog') || !visible(document.querySelector('.workspace-dialog')));
});

test('wizard final save locks navigation and cannot repeat creation while response is pending', async t => {
  const env = await setup(t); await env.register('busy-wizard'); await env.mount(); await wizardBasics('配置保存员工');
  let release; const held = new Promise(resolve => { release = resolve; }); t.after(() => release());
  env.onResponse(async ({ method, url }) => { if (method === 'POST' && url.endsWith('/employee-creations')) await held; });
  await click('确认创建数字员工');
  assert.equal(button('确认创建数字员工').disabled, true); assert.equal(button('返回数字员工').disabled, true); assert.equal(button('暂时退出').disabled, true);
  const before = location.search; history.pushState(null, '', '/?view=tasks'); window.dispatchEvent(new Event('popstate')); await flush(); assert.equal(location.search, before);
  release(); await until(()=>!document.querySelector('.employee-wizard')&&!!document.querySelector('.employee-settings'));await click('返回员工列表'); assert.equal(env.db.prepare('SELECT count(*) n FROM entities').get().n, 1);
});

test('standalone settings mutation locks header, navigation and return until saved', async t => {
  const env = await setup(t); const owner = await env.register('busy-settings');
  const entity = (await env.call('POST', `/api/workspaces/${owner.workspace.id}/entities`, { name: '保存前名称', ownWebUse: true })).json().entity;
  await env.mount(`/?ws=${owner.workspace.id}&view=settings&entity=${entity.id}`);
  let release; const held = new Promise(resolve => { release = resolve; }); t.after(() => release());
  env.onResponse(async ({ method }) => { if (method === 'PATCH') await held; });
  await click('编辑资料');await until(()=>!!document.querySelector('input[aria-label="员工名称"]'));input('input[aria-label="员工名称"]', '保存后名称'); await submit('form:has(input[aria-label="员工名称"])');
  assert.equal(button('返回员工列表').disabled, true); assert.equal(document.querySelector('.workspace-trigger').disabled, true); await click('我的账号');assert.equal(button('退出登录').getAttribute('aria-disabled'),'true');button('退出登录').click();await flush();assert.equal(env.requests.filter(r=>r.method==='POST'&&r.url==='/api/auth/logout').length,0);document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  assert.ok([...document.querySelectorAll('.app-nav .nav-link')].every(el => el.getAttribute('aria-disabled')==='true'));
  const lockedRoute = location.search; document.querySelector('.app-nav [role=menuitem]:last-child').click(); await flush(); assert.equal(location.search, lockedRoute);
  release(); await until(() => !button('返回员工列表').disabled); await click('返回员工列表'); assert.match(document.querySelector('.employee-card').textContent, /保存后名称/);
});

test('library auth tabs support keyboard and labelled panels; invalid form never sends credentials', async t => {
  const env = await setup(t); await env.mount();
  const login = document.querySelector('[role=tab][data-name=login]');
  assert.ok(login); login.focus();
  input('input[name=password]', 'private-draft');
  login.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true })); await flush();
  const selectedTab = document.querySelector('[role=tab][aria-selected=true]');
  assert.equal(selectedTab.textContent.trim(), '注册账号');
  assert.equal(document.activeElement, selectedTab);
  const panel = document.getElementById(selectedTab.getAttribute('aria-controls'));
  assert.equal(panel.getAttribute('aria-labelledby'), selectedTab.id);
  assert.equal(document.querySelector('input[name=password]').value, '');
  input('input[name=username]', 'valid-user'); input('input[name=password]', '12345'); await submit('.auth-panel form');
  assert.equal(env.requests.filter(request => request.url.endsWith('/auth/register')).length, 0);
  assert.match(text(), /密码至少 6 个字符/);
});

test('workspace modal cannot dismiss or duplicate a pending create mutation', async t => {
  const env = await setup(t); await env.register('modal-lock'); await env.mount(); await click('暂时退出');
  document.querySelector('.workspace-trigger').click(); await flush(); await click('＋ 创建工作区');
  await until(() => !!document.querySelector('#new-workspace')); input('#new-workspace', '事务工作区');
  let release; const held = new Promise(resolve => { release = resolve; }); t.after(() => release());
  env.onResponse(async ({ method, url }) => { if (method === 'POST' && url === '/api/workspaces') await held; });
  await submit('.workspace-dialog form');
  assert.equal(button('创建工作区').disabled, true); assert.equal(button('关闭').disabled, true);
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
  document.querySelector('.n-modal-mask').click(); await flush();
  assert.ok(document.querySelector('.workspace-dialog'));
  await submit('.workspace-dialog form');
  assert.equal(env.requests.filter(request => request.method === 'POST' && request.url === '/api/workspaces').length, 1);
  release(); await until(() => !!document.querySelector('.employee-wizard'));
  assert.equal(env.db.prepare('SELECT count(*) n FROM workspaces').get().n, 2);
});

// Approved shared-catalog selection cases. Seed only isolated SQLite configuration;
// these cases never probe a provider, persist a credential, or simulate probe success.
function seedSharedModel(env, workspaceId, id, name) {
  env.db.prepare(`INSERT INTO model_catalog(id,name,workspace_id,provider,endpoint,model_id,revision,enabled,interaction_thinking_control,execution_thinking_control)
    VALUES(?,?,?,'openai-compatible','https://synthetic.invalid/v1','synthetic-model',1,1,'openai_reasoning_effort_none','openai_reasoning_effort_medium')`).run(id, name, workspaceId);
}
async function chooseSharedModel(label, option, form = '.selection-form') {
  if(label==='员工使用的模型'&&document.querySelector('.creation-model-choice'))form='.creation-model-choice';
  const control = document.querySelector(`${form} [aria-label="${label}"]`);
  assert.ok(control, label);
  const group=control.closest('.n-radio-group');
  if(group){const item=[...group.querySelectorAll('.n-radio')].find(el=>el.textContent.includes(option));assert.ok(item,option);item.click();await flush();return;}
  const trigger = control.closest('.n-select').querySelector('.n-base-selection');
  const findOption = () => [...document.querySelectorAll('.n-base-select-option')].filter(visible).find(el => el.textContent.includes(option));
  if(!findOption()){trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); trigger.click(); await flush();}
  await until(() => !!findOption(), `select option ${option}`);
  findOption().click(); await flush();
}
test('workspace catalog default and employee selection share records and restore inheritance', async t => {
  const env = await setup(t); const owner = await env.register('catalog-owner');
  const base = `/api/workspaces/${owner.workspace.id}`;
  const entity = (await env.call('POST', `${base}/entities`, { name: '共享模型员工', ownWebUse: true })).json().entity;
  seedSharedModel(env, owner.workspace.id, 'synthetic-catalog-a', '模型甲');
  seedSharedModel(env, owner.workspace.id, 'synthetic-catalog-b', '模型乙');
  await env.mount(`/?ws=${owner.workspace.id}&view=workspace-models`);
  await until(() => !!document.querySelector('.selection-form'));
  assert.match(text(), /模型甲/); assert.match(text(), /模型乙/);assert.equal([...document.querySelectorAll('.model-choice small')].filter(el=>el.textContent.includes('直接引用：0处')).length,2);
  await chooseSharedModel('工作区默认模型', '模型甲'); await click('保存默认模型');
  await until(() => text().includes('工作区默认模型已更新'));
  assert.equal((await env.call('GET', `${base}/model-profiles`)).json().defaultProfileId, 'synthetic-catalog-a');assert.match(text(),/直接引用：1处（含工作区默认项）/);
  await env.mount(`/?ws=${owner.workspace.id}&view=settings&entity=${entity.id}`);
  await until(() => !button('返回员工列表').disabled); await click('员工设置');
  assert.match(text(), /继承工作区默认模型/);
  await chooseSharedModel('员工使用的模型', '模型乙'); await click('保存模型与思考强度');
  await until(() => text().includes('员工选择的共享模型'));
  assert.equal((await env.call('GET', `${base}/entities/${entity.id}/model-profile`)).json().selectedProfileId, 'synthetic-catalog-b');
  await chooseSharedModel('员工使用的模型','继承工作区默认模型');await click('保存模型与思考强度');
  await until(() => text().includes('继承工作区默认模型'));
  const current = (await env.call('GET', `${base}/entities/${entity.id}/model-profile`)).json();
  assert.equal(current.selectedProfileId, null); assert.equal(current.effectiveProfile.id, 'synthetic-catalog-a');
  assert.equal(env.db.prepare('SELECT count(*) n FROM model_catalog').get().n, 2);
});

test('ordinary member edits employees and selects existing models without receiving use rights',async t=>{
 const env=await setup(t),owner=await env.register('catalog-permissions-owner'),base=`/api/workspaces/${owner.workspace.id}`,entity=(await env.call('POST',base+'/entities',{name:'成员负责员工',ownWebUse:false})).json().entity,invite=(await env.call('POST',base+'/invitations',{})).json(),member=await env.register('catalog-employee-manager',{invitationToken:invite.token});seedSharedModel(env,owner.workspace.id,'synthetic-member-model','团队共享模型');env.setCookie(member.cookie);await env.mount(`/?ws=${owner.workspace.id}&view=settings&entity=${entity.id}`);await until(()=>!!document.querySelector('.employee-settings'));assert.ok(button('编辑资料'));await click('模型');await until(()=>!!document.querySelector('.selection-form'));assert.equal(document.querySelector('button[aria-label="新增共享模型"]'),null);assert.equal((await env.call('PUT',`${base}/entities/${entity.id}/model-profile`,{profileId:'synthetic-member-model'})).statusCode,200);assert.equal((await env.call('POST',`${base}/entities/${entity.id}/conversations`,{operationId:'still-no-use'})).statusCode,403);assert.equal((await env.call('POST',base+'/invitations',{})).statusCode,403);
});

test('new conversation without a model fails clearly and never creates demo or task controls', async t => {
  const env = await setup(t); const owner = await env.register('required-model-ui');
  const entity = (await env.call('POST', `/api/workspaces/${owner.workspace.id}/entities`, { name: '待配置模型员工', ownWebUse: true })).json().entity;
  await env.mount(`/?ws=${owner.workspace.id}&view=chat&entity=${entity.id}`);
  await until(() => !!document.querySelector('.conversation-toolbar'));
  assert.equal(document.querySelector('.mode-picker'), null);
  assert.equal([...document.querySelectorAll('button')].some(el => el.textContent.includes('演示')), false);
  await until(() => text().includes('模型尚未配置'));
  assert.equal(env.db.prepare('SELECT count(*) n FROM conversations').get().n, 0);
  assert.equal(document.querySelector('.composer'), null);
  assert.equal(document.querySelector('.task-panel'), null);
  assert.equal(env.db.prepare('SELECT count(*) n FROM tasks').get().n, 0);
  await click('员工设置'); await until(() => !!document.querySelector('.employee-settings'));
  assert.equal(document.querySelector('.chat-panel'), null);
});

async function localProbeProvider(t) {
  const requests = []; let status = 200, completionHandler;
  const server = createHttpServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const imageProbe=body.messages?.some(message=>Array.isArray(message.content)&&message.content.some(part=>part.type==='image_url'))??false;
    requests.push({ imageProbe, model: body.model, reasoningEffort: body.reasoning_effort, enableThinking: body.enable_thinking, keyMatched: request.headers.authorization === 'Bearer synthetic-dom-probe-key', path: request.url });
    const good = status === 200 && request.url === '/v1/chat/completions' && request.headers.authorization === 'Bearer synthetic-dom-probe-key' && body.model === 'synthetic-probe-model' && body.reasoning_effort === 'none' && body.enable_thinking === false;
    const completionText=good&&completionHandler?await completionHandler(body):'OK';
    response.writeHead(good ? 200 : status === 200 ? 400 : status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(good ? { choices: [{ message: { role: 'assistant', content: completionText }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } } : { error: 'Synthetic rejection' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { origin: `http://127.0.0.1:${server.address().port}`, requests, setStatus(value) { status = value; }, setCompletionHandler(value) { completionHandler=value; } };
}
async function openProbeEditor(t, username, employee = false) {
  const provider = await localProbeProvider(t), env = await setup(t, provider), owner = await env.register(username);
  const base = `/api/workspaces/${owner.workspace.id}`;
  const entity = (await env.call('POST', `${base}/entities`, { name: '联通测试员工', ownWebUse: true })).json().entity;
  await env.mount(`/?ws=${owner.workspace.id}&view=workspace-models`);
  await until(() => !!document.querySelector('.selection-form, .config-form'));
  if(employee){const check=[...document.querySelectorAll('.n-checkbox')].find(x=>x.textContent.includes('同时设为工作区默认模型'));assert.ok(check);check.click();await flush();}
  if(!document.querySelector('.config-form'))await click('新增共享模型');
  input('input[aria-label="配置名称"]', '联通验证配置');
  input('input[aria-label="模型地址"]', `${provider.origin}/v1`);
  input('input[aria-label="模型名称"]', 'synthetic-probe-model');
  input('input[aria-label="API Key · 只写，不回显"]', 'synthetic-dom-probe-key');

  return { env, provider, owner, base, entity };
}
async function probeSuccess() { await click('联通测试'); await until(() => !button('保存模型配置').disabled, 'successful local probe enables save'); }

test('probe DOM successful exact candidate gates save, duplicate pending requests are blocked, employee create binds atomically', async t => {
  const { env, provider, base, entity } = await openProbeEditor(t, 'probe-dom-success', true);
  const keyInput=document.querySelector('input[aria-label="API Key · 只写，不回显"]'),eye=keyInput.closest('.n-input').querySelector('.n-input__eye'),typedKey=keyInput.value;assert.equal(keyInput.type,'password');assert.ok(eye);eye.click();await flush();assert.equal(keyInput.type,'text');assert.equal(keyInput.value,typedKey);eye.click();await flush();assert.equal(keyInput.type,'password');assert.equal(keyInput.value,typedKey);
  assert.equal(button('保存模型配置').disabled, true);
  await submit('.model-settings .config-form');
  assert.equal(env.requests.filter(r => r.method === 'POST' && r.url.endsWith('/model-profiles')).length, 0);
  let release; const held = new Promise(resolve => { release = resolve; }); t.after(() => release());
  env.onResponse(async ({ url }) => { if (url.endsWith('/test-connection')) await held; });
  const testButton = button('联通测试'); testButton.click(); testButton.click();
  await until(() => provider.requests.filter(request=>!request.imageProbe).length === 1);
  assert.equal(button('保存模型配置').disabled, true); assert.equal(button('联通测试').disabled, true);
  assert.equal(document.querySelector('input[aria-label="模型名称"]').disabled, true);
  assert.equal(env.requests.filter(r => r.url.endsWith('/test-connection')).length, 1);
  release(); await until(() => !button('保存模型配置').disabled);
  assert.deepEqual(provider.requests.filter(r=>!r.imageProbe).map(r => r.reasoningEffort), ['none']); assert.equal(provider.requests[0].enableThinking,false); assert.equal(provider.requests.filter(r=>r.imageProbe).length,1,'One separate synthetic image observation follows the text probe'); assert.match(text(),/文字连接通过；图片输入尚未确认/); assert.ok(provider.requests.every(r => r.keyMatched && r.model === 'synthetic-probe-model'));
  const saveButton = button('保存模型配置'); saveButton.click(); saveButton.click();
  await until(() => !document.querySelector('.model-settings .config-form'));
  assert.equal(env.requests.filter(r => r.method === 'POST' && r.url.endsWith('/model-profiles')).length, 1);
  const selected = (await env.call('GET', `${base}/entities/${entity.id}/model-profile`)).json();
  assert.equal(selected.source,'workspace_default'); assert.equal(selected.effectiveProfile.name, '联通验证配置');
  assert.equal(env.db.prepare('SELECT count(*) n FROM model_catalog').get().n, 1);
  assert.equal(text().includes('synthetic-dom-probe-key'), false);
});

test('probe DOM changing candidate fields invalidates success and requires a new test', async t => {
  const { provider } = await openProbeEditor(t, 'probe-dom-edit');
  await probeSuccess(); input('input[aria-label="配置名称"]', '已修改名称'); await flush();
  assert.equal(button('保存模型配置').disabled, true);
  await probeSuccess(); input('input[aria-label="API Key · 只写，不回显"]', 'synthetic-edited-key'); await flush();
  assert.equal(button('保存模型配置').disabled, true);
  input('input[aria-label="API Key · 只写，不回显"]', 'synthetic-dom-probe-key'); await flush(); await probeSuccess();
  assert.equal(document.querySelector('[aria-label="交互思考关闭方式"]'),null);assert.equal(document.querySelector('[aria-label="执行中等思考方式"]'),null);
  input('input[aria-label="模型名称"]', 'other-model'); await flush();
  assert.equal(button('保存模型配置').disabled, true);
  assert.equal(provider.requests.filter(request=>!request.imageProbe).length,3); assert.equal(provider.requests.filter(request=>request.imageProbe).length,3,'Each fresh candidate also observes image input once');
});

test('probe DOM expired receipt cannot save and failure preserves persisted configuration', async t => {
  const { env, provider, base } = await openProbeEditor(t, 'probe-dom-expiry');
  await probeSuccess();
  const now = Date.now.bind(Date); const clock = t.mock.method(Date, 'now', () => now() + 6 * 60_000);
  await submit('.model-settings .config-form'); assert.equal(button('保存模型配置').disabled, true); assert.match(text(), /请先通过联通测试/);
  assert.equal(env.db.prepare('SELECT count(*) n FROM model_catalog').get().n, 0); clock.mock.restore();
  await probeSuccess(); await click('保存模型配置'); await until(() => !document.querySelector('.model-settings .config-form'));
  const before = (await env.call('GET', `${base}/model-profiles`)).json().profiles[0];
  await click('编辑 联通验证配置'); input('input[aria-label="配置名称"]', '失败不得覆盖');
  provider.setStatus(401); await click('联通测试'); await until(() => text().includes('联通测试未通过'));
  assert.equal(button('保存模型配置').disabled, true);
  assert.deepEqual((await env.call('GET', `${base}/model-profiles`)).json().profiles[0], before);
  assert.equal(document.querySelector('input[aria-label="API Key · 只写，不回显"]').value, '');
});

test('probe DOM bad endpoint, credential or model never enable save', async t => {
  const { env, provider } = await openProbeEditor(t, 'probe-dom-reject');
  input('input[aria-label="模型地址"]', 'not-a-url'); await flush(); await click('联通测试');
  assert.equal(env.requests.filter(r => r.url.endsWith('/test-connection')).length, 0);
  input('input[aria-label="模型地址"]', `${provider.origin}/v1`);
  input('input[aria-label="API Key · 只写，不回显"]', 'synthetic-invalid-key'); await flush(); await click('联通测试'); await until(() => text().includes('模型接口拒绝'));
  assert.equal(button('保存模型配置').disabled, true);
  input('input[aria-label="API Key · 只写，不回显"]', 'synthetic-dom-probe-key'); input('input[aria-label="模型名称"]', 'invalid-model'); await flush();
  await click('联通测试'); await until(() => !button('联通测试').disabled); assert.equal(button('保存模型配置').disabled, true);
  input('input[aria-label="模型名称"]', 'synthetic-probe-model');
  await flush();provider.setStatus(422);const before = provider.requests.length; await click('联通测试'); await until(() => text().includes('模型接口拒绝'));
  assert.equal(provider.requests.length, before+1); assert.equal(button('保存模型配置').disabled, true);
  assert.equal(env.db.prepare('SELECT count(*) n FROM model_catalog').get().n, 0);
});

test('probe DOM response from discarded workspace cannot enable save in another workspace', async t => {
  const { env, provider, owner } = await openProbeEditor(t, 'probe-dom-scope');
  const second = (await env.call('POST', '/api/workspaces', { name: '另一模型空间' })).json().workspace;
  await env.call('POST', `/api/workspaces/${second.id}/entities`, { name: '另一员工', ownWebUse: true });
  let release; const held = new Promise(resolve => { release = resolve; }); t.after(() => release());
  env.onResponse(async ({ url }) => { if (url.endsWith('/test-connection')) await held; });
  await click('联通测试'); await until(() => provider.requests.filter(request=>!request.imageProbe).length === 1);
  assert.equal(document.querySelector('.workspace-trigger').disabled, true);
  await env.mount(`/?ws=${second.id}&view=workspace-models`); await until(() => !!document.querySelector('.config-form'));
  release(); await flush(); await flush();
  assert.equal(button('保存模型配置').disabled, true); assert.equal(document.querySelector('input[aria-label="API Key · 只写，不回显"]').value, '');
  assert.equal(text().includes('文字连接通过'), false);
  assert.equal(new URLSearchParams(location.search).get('ws'), second.id); assert.notEqual(second.id, owner.workspace.id);
  assert.equal(env.db.prepare('SELECT count(*) n FROM model_catalog').get().n, 0);
});

test('retired channel guide route returns to employees without a dead sidebar entry or writes', async t => {
  const env = await setup(t); const owner = await env.register('guide-retired');
  await env.mount(`/?ws=${owner.workspace.id}&view=channel-guides`);
  await until(() => new URLSearchParams(location.search).get('view') === 'employees');
  assert.equal(document.querySelector('.channel-setup-guide'), null);
  assert.equal([...document.querySelectorAll('[role=menuitem]')].some(el => el.textContent.includes('接入指南')), false);
  assert.equal(env.db.prepare('SELECT count(*) n FROM entities').get().n, 0);
});

test('saved local model opens an independent real conversation and renders a provider response', async t => {
  const { env, provider, owner, entity } = await openProbeEditor(t, 'real-model-chat-ui', true);
  await probeSuccess(); await click('保存模型配置'); await until(() => !document.querySelector('.model-settings .config-form'));
  const historical = env.historicalDemo(owner, entity);
  await env.mount(`/?ws=${owner.workspace.id}&view=chat&entity=${entity.id}&conversation=${historical.id}`);
  await until(()=>!!document.querySelector('.chat-messages'));assert.equal(document.querySelector('.composer'),null);assert.match(text(),/历史演示记录/);
  await env.mount(`/?ws=${owner.workspace.id}&view=chat&entity=${entity.id}`);await until(()=>!!document.querySelector('textarea[aria-label="消息"]'));
  assert.equal(document.querySelector('input[aria-label="历史会话"]'), null);
  assert.equal([...document.querySelectorAll('button')].some(el=>el.textContent.trim()==='新建会话'), false);
  const records = env.db.prepare('SELECT id,mode FROM conversations ORDER BY created_at').all();
  assert.equal(records.length, 2); assert.equal(records.find(row => row.id === historical.id).mode, 'demo');
  const activeId = new URLSearchParams(location.search).get('conversation');
  assert.notEqual(activeId, historical.id);
  assert.equal(records.find(row => row.id === activeId).mode, 'real');
  assert.doesNotMatch(document.querySelector('.chat-messages').textContent, /旧的模拟/);
  input('textarea[aria-label="消息"]', '你好'); await submit('.composer form');
  await until(() => [...document.querySelectorAll('.chat-message')].some(el => el.textContent.includes('OK')), 'provider response returned to real conversation');
  assert.equal(provider.requests.filter(request=>!request.imageProbe).length,2,'one fixed-none text probe and one real builtin request'); assert.equal(provider.requests.filter(request=>request.imageProbe).length,1,'Separate image observation must not count as a task or conversation turn');
  assert.equal(env.db.prepare('SELECT count(*) n FROM tasks').get().n, 0);
  assert.equal(env.requests.filter(r => r.method === 'POST' && /\/conversations$/.test(r.url)).length, 1);
  env.persistedProgress(owner, entity, activeId);
  await click('刷新状态');
  await until(() => document.querySelector('.chat-messages').textContent.includes('合成已持久化进度'));
  assert.equal(provider.requests.length,3,'task refresh reads delivery facts without generating another model reply or image observation');
  assert.equal(document.querySelector('.create-task'),null);
  assert.equal(document.querySelector('.history-picker'),null);
  assert.ok(document.querySelector('.conversation-task-list'));
  assert.equal([...document.querySelectorAll('.conversation-task-list button')].some(el=>/保存|立即执行|补充|取消|启动/.test(el.textContent)),false);

});


test('approved execution resources render exact tools and Bash grants are explicit broad permission', async t => {
  const env = await setup(t, undefined, [
    { id: 'synthetic-reader', kind: 'execution', resourceId: 'synthetic-read-resource', version: '1', tools: ['read'], shared: true },
    { id: 'synthetic-shell', kind: 'execution', resourceId: 'synthetic-shell-resource', version: '2', tools: ['read', 'write', 'edit', 'bash'], shared: true },
  ]);
  const owner = await env.register('execution-package-ui'), base = `/api/workspaces/${owner.workspace.id}`;
  const entity = (await env.call('POST', `${base}/entities`, { name: '执行工具配置员工', ownWebUse: true })).json().entity;
  await env.mount(`/?ws=${owner.workspace.id}&view=settings&entity=${entity.id}`);
  await until(() => !button('返回员工列表').disabled); await click('工作能力');
  await until(() => !!document.querySelector('.capability-package-list') && [...document.querySelectorAll('[role=tab]')].some(el => el.textContent.trim() === '能力包' && el.getAttribute('aria-selected') === 'true'));
  const catalog = (await env.call('GET', `${base}/entities/${entity.id}/resource-catalog`)).json();
  assert.equal(catalog.length, 2);
  assert.equal(document.querySelector('input[aria-label="能力包名称"]'),null);await click('新建能力包');input('input[aria-label="能力包名称"]', '显式执行工具包');document.querySelector('.package-editor .n-collapse-item__header-main').click();await flush();
  async function selectResource(id) {
    const option=id==='synthetic-reader'?'synthetic-read-resource':'synthetic-shell-resource';
    await chooseSharedModel('能力包执行工具',option,'.package-editor');
  }
  await selectResource('synthetic-reader');
  assert.equal(document.querySelector('.bash-permission-note'), null);
  await selectResource('synthetic-shell');
  assert.match(document.querySelector('.bash-permission-note').textContent, /包含 Bash.*并非只读/);
  assert.doesNotMatch(document.querySelector('.access-settings').textContent, /undefined/);
  assert.equal(document.querySelector('input[aria-label="执行根目录"]'), null);
  await click('保存能力包'); await until(() => text().includes('已保存。')&&!document.querySelector('.package-editor'));
  const packages = (await env.call('GET', `${base}/entities/${entity.id}/capability-packages`)).json();
  const saved = Array.isArray(packages) ? packages[0] : packages.packages[0];
  assert.deepEqual(saved.resourceIds, ['synthetic-reader', 'synthetic-shell']);
  assert.equal(env.db.prepare('SELECT count(*) n FROM tasks').get().n, 0);
});

// Approved same-table task/session UI coverage. These use the actual HTTP routes
// and isolated persistence; seeded execution facts are only read-projection fixtures.
async function taskJourney(t, username, runtime) {
  const env = await setup(t, undefined, undefined, runtime), owner = await env.register(username);
  const entity = (await env.call('POST', `/api/workspaces/${owner.workspace.id}/entities`, { name: '会话任务员工', ownWebUse: true })).json().entity;
  const first = env.realConversation(owner, entity), second = env.realConversation(owner, entity);
  env.db.prepare('UPDATE conversations SET created_at=? WHERE id=?').run(1000,first.id);
  env.db.prepare('UPDATE conversations SET created_at=? WHERE id=?').run(2000,second.id);
  const root = id => `/api/workspaces/${owner.workspace.id}/entities/${entity.id}/conversations/${id}`;
  async function todo(id, input) { const result = await env.call('POST', `${root(id)}/todos`, { operationId: randomUUID(), input }); assert.equal(result.statusCode, 201, result.body); return result.json().task; }
  const route = (view, id) => `/?ws=${owner.workspace.id}&view=${view === 'tasks' ? 'task-fixture' : view}&entity=${entity.id}${id ? `&conversation=${id}` : ''}`;
  return { env, owner, entity, first, second, root, todo, route };
}
async function chooseTaskOption(label, option) {
  const selector = `input[aria-label="${label}"]`, field = document.querySelector(selector);
  assert.ok(field); field.focus(); input(selector, option); await flush();
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); await flush();
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await flush();
}
async function openTaskCreate() { document.querySelector('.create-task .n-collapse-item__header-main').click(); await until(() => !!document.querySelector('textarea[aria-label="任务说明"]')); }
async function taskRow(inputText) { await until(() => [...document.querySelectorAll('.task-panel tbody tr, .conversation-task-list li')].some(row => row.textContent.includes(inputText))); return [...document.querySelectorAll('.task-panel tbody tr, .conversation-task-list li')].find(row => row.textContent.includes(inputText)); }
async function selectTask(inputText) { const row = await taskRow(inputText); row.querySelector('button').click(); await until(() => document.querySelector('.task-detail .prewrap')?.textContent.includes(inputText)); await until(() => !document.querySelector('.task-detail .n-skeleton')); }

test('normal chat restores one persistent conversation and explicit legacy URLs stay read-only and separate', async t => {
  const f = await taskJourney(t, 'persistent-chat-route');
  await f.todo(f.first.id, 'CURRENT_PRIVATE_TASK'); await f.todo(f.second.id, 'LEGACY_OTHER_TASK');
  await f.env.mount(f.route('chat')); await taskRow('CURRENT_PRIVATE_TASK');
  assert.equal(new URLSearchParams(location.search).get('conversation'), f.first.id);
  assert.equal(document.querySelector('input[aria-label="历史会话"]'), null);
  assert.equal([...document.querySelectorAll('button')].some(el=>el.textContent.trim()==='新建会话'),false);
  await f.env.mount(f.route('chat', f.second.id)); await taskRow('LEGACY_OTHER_TASK');
  assert.equal(new URLSearchParams(location.search).get('conversation'), f.second.id);assert.equal(document.querySelector('.composer'),null);assert.match(text(),/历史会话，仅供查看/);
  assert.doesNotMatch(document.querySelector('.conversation-task-list').textContent, /CURRENT_PRIVATE_TASK/);
  assert.equal(f.env.db.prepare('SELECT count(*) n FROM conversations').get().n,2);
  await until(()=>[...document.querySelectorAll('.app-nav .nav-link')].some(el=>el.textContent.trim()==='任务'&&el.getAttribute('aria-disabled')!=='true'));
  [...document.querySelectorAll('.app-nav .nav-link')].find(el=>el.textContent.trim()==='任务').click();
  await until(()=>document.querySelectorAll('.task-records .task-list-item').length===2);
  assert.equal(new URLSearchParams(location.search).get('conversation'),null,'sidebar management defaults to all employee conversations');
  assert.equal(document.querySelector('input[aria-label="会话 ID 筛选"]')?.value??'','');
});

test('session tasks planned null-run save supplement retry start failure and cancel use versioned actions', async t => {
  const f = await taskJourney(t, 'session-task-planned'); await f.env.mount(f.route('tasks', f.first.id));
  await until(() => !!document.querySelector('.task-panel')); await openTaskCreate();
  await until(() => !text().includes('正在核对可用能力包'));
  input('textarea[aria-label="任务说明"]', 'NO_RUN_TODO'); await flush();
  const save = button('保存为待办'); save.click(); save.click();
  await until(() => text().includes('待办已保存，尚未启动执行')); await until(() => !!document.querySelector('.task-detail'));
  assert.match(document.querySelector('.task-detail').textContent, /尚未创建执行记录/);
  assert.equal(f.env.db.prepare('SELECT count(*) n FROM runs').get().n, 0);
  assert.equal(f.env.requests.filter(r => r.method === 'POST' && /\/todos$/.test(r.url)).length, 1);
  input('textarea[aria-label="补充 / 修改说明"]', 'LATEST_TODO_REQUIREMENT'); await flush();
  let dropped = false;
  f.env.onResponse(({ method, url }) => { if (!dropped && method === 'POST' && url.endsWith('/input')) { dropped = true; throw new TypeError('Synthetic lost supplement response'); } });
  await click('提交补充并查询回执'); await until(() => text().includes('无法连接服务或响应格式异常'));
  await click('提交补充并查询回执'); await until(() => text().includes('补充已保存到待办'));
  const supplements = f.env.requests.filter(r => r.method === 'POST' && r.url.endsWith('/input'));
  assert.equal(supplements.length, 2); assert.deepEqual(supplements[0].body, supplements[1].body);
  assert.equal(f.env.db.prepare('SELECT version FROM tasks').get().version, 2);
  assert.equal(f.env.db.prepare('SELECT count(*) n FROM runs').get().n, 0);
  const start = button('启动待办'); start.click(); start.click(); await until(() => text().includes('模型尚未配置'));
  const starts = f.env.requests.filter(r => r.url.endsWith('/start')); assert.equal(starts.length, 1); assert.equal(starts[0].body.expectedVersion, 2);
  assert.match(document.querySelector('.task-detail').textContent, /LATEST_TODO_REQUIREMENT/);
  await click('取消待办'); await until(() => text().includes('待办已取消，未启动执行'));
  assert.equal(f.env.db.prepare('SELECT status FROM tasks').get().status, 'canceled');
  assert.equal(f.env.db.prepare('SELECT count(*) n FROM runs').get().n, 0);
  assert.equal(button('申请取消此任务').disabled, true); assert.equal(button('提交补充并查询回执').disabled, true);
});

test('session tasks render all statuses paginate and request status filters inside current conversation', async t => {
  const f = await taskJourney(t, 'session-task-states');
  for (let n = 0; n < 26; n++) await f.todo(f.first.id, `PAGE_TODO_${n}`);
  for (const state of ['queued', 'running', 'waiting_input', 'waiting_approval', 'cancel_requested', 'unknown', 'succeeded', 'failed', 'canceled']) {
    const id = f.env.persistedProgress(f.owner, f.entity, f.first.id);
    f.env.db.prepare('UPDATE tasks SET input=?,status=? WHERE id=?').run(`STATE_${state}`, state, id);
    f.env.db.prepare('UPDATE runs SET status=? WHERE task_id=?').run(state === 'queued' ? 'preparing' : state, id);
  }
  await f.todo(f.second.id, 'OTHER_SESSION_HIDDEN'); await f.env.mount(f.route('tasks', f.first.id));
  await until(() => !!document.querySelector('.task-panel tbody'));
  assert.equal(document.querySelectorAll('.task-panel tbody tr, .conversation-task-list li').length, 25);
  await click('加载更多任务'); await until(() => document.querySelectorAll('.task-panel tbody tr, .conversation-task-list li').length === 35);
  for (const state of ['queued', 'running', 'waiting_input', 'waiting_approval', 'cancel_requested', 'unknown', 'succeeded', 'failed', 'canceled']) await taskRow(`STATE_${state}`);
  assert.doesNotMatch(document.querySelector('.task-panel').textContent, /OTHER_SESSION_HIDDEN/);
  await selectTask('STATE_unknown'); assert.match(document.querySelector('.task-detail').textContent, /执行结果未知/);
  await chooseTaskOption('筛选任务状态', '已失败');
  await until(() => document.querySelectorAll('.task-panel tbody tr, .conversation-task-list li').length === 1);
  assert.match(document.querySelector('.task-panel tbody').textContent, /STATE_failed/);
  assert.ok(f.env.requests.some(r => r.url.includes('/tasks?') && r.url.includes('status=failed')));
  assert.ok(f.env.requests.some(r => r.url.includes('cursor=')));
});

test('session tasks ignore stale detail/list responses and refresh after a version conflict', async t => {
  const f = await taskJourney(t, 'session-task-stale');
  const a = await f.todo(f.first.id, 'STALE_DETAIL_A'), b = await f.todo(f.first.id, 'CURRENT_DETAIL_B');
  await f.env.mount(f.route('tasks', f.first.id)); await taskRow('STALE_DETAIL_A');
  let release, entered = false; const held = new Promise(resolve => release = resolve); t.after(() => release());
  f.env.onResponse(async ({ url }) => { if (url.endsWith(`/tasks/${a.id}`)) { entered = true; await held; } });
  (await taskRow('STALE_DETAIL_A')).querySelector('button').click(); await until(() => entered);
  await selectTask('CURRENT_DETAIL_B'); release(); await flush();
  assert.equal(document.querySelector('.task-detail .selectable').textContent, b.id);
  f.env.onResponse(undefined);
  const updated = await f.env.call('POST', `${f.root(f.first.id)}/tasks/${b.id}/input`, { operationId: randomUUID(), expectedVersion: 1, input: 'CONCURRENT_CHANGE' }); assert.equal(updated.statusCode, 200, updated.body);
  input('textarea[aria-label="补充 / 修改说明"]', 'LOCAL_PENDING_REQUIREMENT'); await flush(); await click('提交补充并查询回执');
  await until(() => text().includes('任务已更新，请刷新详情')); await until(() => document.querySelector('.task-detail .prewrap').textContent.includes('CONCURRENT_CHANGE'));
  assert.equal(document.querySelector('textarea[aria-label="补充 / 修改说明"]').value, 'LOCAL_PENDING_REQUIREMENT');
  await click('提交补充并查询回执'); await until(() => text().includes('补充已保存到待办'));
  const mutations = f.env.requests.filter(r => r.method === 'POST' && r.url.endsWith(`/tasks/${b.id}/input`));
  assert.deepEqual(mutations.map(r => r.body.expectedVersion), [1, 2]); assert.notEqual(mutations[0].body.operationId, mutations[1].body.operationId);
});

test('session tasks running supplements distinguish platform saved received applied and cancel capability', async t => {
  const f = await taskJourney(t, 'session-task-receipts');
  const id = f.env.persistedProgress(f.owner, f.entity, f.first.id);
  await f.env.mount(f.route('tasks', f.first.id)); await selectTask('合成持久反馈测试');
  assert.equal(button('申请取消此任务').disabled, true, 'no Runtime cancellation capability');
  input('textarea[aria-label="补充 / 修改说明"]', 'RECORD_ONLY_REQUIREMENT'); await flush(); await click('提交补充并查询回执');
  await until(() => text().includes('补充仅记录在平台'));
  document.querySelector('.task-detail [name=inputs]')?.click();
  const heading = [...document.querySelectorAll('.task-detail .n-collapse-item__header-main')].find(el => el.textContent.includes('输入回执')); heading.click(); await flush();
  assert.match(document.querySelector('.task-detail').textContent, /r2：已保存到平台/);
  f.env.db.prepare("UPDATE task_inputs SET status='received' WHERE task_id=? AND revision=2").run(id);
  await click('刷新状态'); await until(() => document.querySelector('.task-detail').textContent.includes('r2：执行器已接收'));
  assert.doesNotMatch(document.querySelector('.task-detail').textContent, /r2：已应用/);
  f.env.db.prepare("UPDATE task_inputs SET status='applied' WHERE task_id=? AND revision=2").run(id);
  await click('刷新状态'); await until(() => document.querySelector('.task-detail').textContent.includes('r2：已应用'));
});

test('existing task projection survives employee policy change, new admission is denied, expired login clears task data', async t => {
  const f=await taskJourney(t,'session-task-access');await f.todo(f.first.id,'CURRENT_SESSION_RESPONSE');
  await f.env.mount(f.route('chat'));await taskRow('CURRENT_SESSION_RESPONSE');
  f.env.db.prepare('UPDATE entities SET own_web_use=0 WHERE id=?').run(f.entity.id);
  await click('刷新状态');await taskRow('CURRENT_SESSION_RESPONSE');
  const rail=document.querySelector('.conversation-task-list');assert.match(rail.textContent,/CURRENT_SESSION_RESPONSE/);assert.equal(rail.querySelector('form,input,textarea'),null);
  const denied=await f.env.call('POST',f.root(f.first.id)+'/todos',{operationId:randomUUID(),input:'NEW_REQUEST_MUST_BE_DENIED'});
  assert.equal(denied.statusCode,403,denied.body);assert.equal(f.env.db.prepare('SELECT count(*) n FROM tasks').get().n,1);
  f.env.db.exec('UPDATE sessions SET revoked=1');await click('刷新状态');await until(()=>!!document.querySelector('.auth-panel'));
  assert.equal(document.querySelector('.conversation-task-list'),null);assert.doesNotMatch(text(),/CURRENT_SESSION_RESPONSE/);
});

test('session tasks start latest supplemented todo once and running cancel waits for Runtime confirmation', async t => {
  // Existing approved MockRuntime contract, never a model or real execution host.
  const runtime = {
    commands: [], idempotentDispatch: true,
    capabilities(runId) { return { runId, runtimeId: 'fixture', runtimeVersion: '1', bindingVersion: '1', observedAt: Date.now(), expiresAt: Date.now() + 60000, appendInput: 'supported', cancel: 'supported' }; },
    async dispatch(command) { this.commands.push(command); return { status: 'accepted' }; },
    async input() { return { status: 'received' }; }, async cancel() { return { status: 'unknown' }; }, async events() { return []; },
  };
  const f = await taskJourney(t, 'session-task-start', runtime); f.env.taskModelFixture(f.owner, f.entity);
  const todo = await f.todo(f.first.id, 'LATEST_START_BASE'); await f.env.mount(f.route('tasks', f.first.id)); await selectTask('LATEST_START_BASE');
  input('textarea[aria-label="补充 / 修改说明"]', 'LATEST_START_ADDITION'); await flush(); await click('提交补充并查询回执'); await until(() => text().includes('补充已保存到待办'));
  const start = button('启动待办'); start.click(); start.click(); await until(() => text().includes('启动已受理'));
  assert.equal(f.env.requests.filter(r => r.url.endsWith('/start')).length, 1);
  assert.equal(f.env.db.prepare('SELECT count(*) n FROM runs').get().n, 1);
  await f.env.taskService.tick(); assert.equal(runtime.commands.length, 1); assert.match(runtime.commands[0].input, /LATEST_START_ADDITION/);
  await click('刷新状态'); await until(() => !button('申请取消此任务').disabled);
  await click('申请取消此任务'); await until(() => text().includes('取消请求已提交'));
  assert.equal(f.env.db.prepare('SELECT status FROM tasks WHERE id=?').get(todo.id).status, 'cancel_requested');
  assert.match(document.querySelector('.task-detail').textContent, /取消仅已申请，执行仍可能继续/);
  assert.equal(button('正在等待取消确认').disabled, true);
});

test('session tasks reject task moved outside current conversation with 404 and clear stale actions', async t => {
  const f = await taskJourney(t, 'session-task-notfound'), todo = await f.todo(f.first.id, 'MOVED_TASK_CONTENT');
  await f.env.mount(f.route('tasks', f.first.id)); const row = await taskRow('MOVED_TASK_CONTENT');
  // Change fixture ownership only after the authorized list snapshot has loaded.
  f.env.db.prepare('UPDATE tasks SET conversation_id=? WHERE id=?').run(f.second.id, todo.id);
  row.querySelector('button').click(); await until(() => text().includes('任务不存在或当前会话无权访问'));
  assert.equal(document.querySelector('.task-detail'), null); assert.equal(document.querySelector('.create-task'), null);
  assert.doesNotMatch(document.querySelector('.task-panel').textContent, /MOVED_TASK_CONTENT/);
});

test('session tasks stale same-conversation list cannot overwrite an accepted supplement', async t => {
  const f = await taskJourney(t, 'session-task-list-race'); await f.todo(f.first.id, 'LIST_RACE_BASE');
  await f.env.mount(f.route('tasks', f.first.id)); await selectTask('LIST_RACE_BASE');
  let release, entered = false; const held = new Promise(resolve => release = resolve); t.after(() => release());
  f.env.onResponse(async ({ url }) => { if (!entered && url.includes(`/conversations/${f.first.id}/tasks?`)) { entered = true; await held; } });
  await click('刷新状态'); await until(() => entered);
  input('textarea[aria-label="补充 / 修改说明"]', 'LATEST_LIST_REQUIREMENT'); await flush(); await click('提交补充并查询回执');
  await until(() => text().includes('补充已保存到待办')); assert.equal((await taskRow('LIST_RACE_BASE')).querySelector('.task-summary').textContent,'LIST_RACE_BASE');
  release(); await flush(); assert.equal((await taskRow('LIST_RACE_BASE')).querySelector('.task-summary').textContent,'LIST_RACE_BASE');
  assert.match(document.querySelector('.task-detail .prewrap').textContent, /LATEST_LIST_REQUIREMENT/);
  assert.equal(f.env.db.prepare('SELECT version FROM tasks').get().version, 2);
});


test('private IM switches employees and refreshes back into the same authorized history', async t => {
  const f=await taskJourney(t,'private-switch-ui');
  const e2=(await f.env.call('POST',`/api/workspaces/${f.owner.workspace.id}/entities`,{name:'另一位私聊员工',ownWebUse:true})).json().entity,c2=f.env.realConversation(f.owner,e2);
  f.env.retainedMessage(f.first.id,'FIRST_PERSON_HISTORY');f.env.retainedMessage(c2.id,'SECOND_PERSON_HISTORY');
  await f.env.mount(f.route('chat'));await until(()=>document.querySelector('.chat-messages')?.textContent.includes('FIRST_PERSON_HISTORY'));
  await click('返回对话列表');await until(()=>!!document.querySelector('.conversation-list'));
  [...document.querySelectorAll('.conversation-row')].find(el=>el.textContent.includes('另一位私聊员工')).click();
  await until(()=>document.querySelector('.chat-messages')?.textContent.includes('SECOND_PERSON_HISTORY'));
  assert.doesNotMatch(document.querySelector('.chat-messages').textContent,/FIRST_PERSON_HISTORY/);
  await click('返回对话列表');await until(()=>!!document.querySelector('.conversation-list'));
  [...document.querySelectorAll('.conversation-row')].find(el=>el.textContent.includes('会话任务员工')).click();
  await until(()=>document.querySelector('.chat-messages')?.textContent.includes('FIRST_PERSON_HISTORY'));
  assert.equal(new URLSearchParams(location.search).get('conversation'),f.first.id);
  await f.env.mount(location.pathname+location.search);await until(()=>document.querySelector('.chat-messages')?.textContent.includes('FIRST_PERSON_HISTORY'));
  assert.equal(new URLSearchParams(location.search).get('conversation'),f.first.id);assert.equal(f.env.db.prepare('SELECT count(*) n FROM conversations').get().n,3);
});

test('administrator direct task list filters employees/status/conversation and opens read-only Task Run Delivery detail',async t=>{
 const f=await taskJourney(t,'admin-overview-ui'),e2=(await f.env.call('POST',`/api/workspaces/${f.owner.workspace.id}/entities`,{name:'第二位管理数字员工',ownWebUse:true})).json().entity,c2=f.env.realConversation(f.owner,e2);
 const a=await f.todo(f.first.id,'FIRST_EMPLOYEE_TODO'),result=f.env.persistedProgress(f.owner,f.entity,f.first.id);
 f.env.db.prepare("UPDATE tasks SET status='succeeded' WHERE id=?").run(result);f.env.db.prepare("UPDATE runs SET status='succeeded',result='ADMIN_TASK_RESULT',result_revision=1 WHERE task_id=?").run(result);
 await f.env.call('POST',`/api/workspaces/${f.owner.workspace.id}/entities/${e2.id}/conversations/${c2.id}/todos`,{operationId:randomUUID(),input:'SECOND_EMPLOYEE_TODO'});
 await f.env.mount(`/?ws=${f.owner.workspace.id}&view=tasks`);await until(()=>document.querySelectorAll('.task-records .task-list-item').length===3);assert.equal(document.querySelector('.global-stats'),null);
 const row=[...document.querySelectorAll('.task-records .task-list-item')].find(r=>r.textContent.includes('合成持久反馈测试'));row.querySelector('button').click();await until(()=>text().includes('ADMIN_TASK_RESULT'));const drawer=document.querySelector('.n-drawer');assert.equal(drawer.querySelector('form,textarea,input'),null);for(const label of ['任务（Task）','执行（Run）','投递（Delivery）'])assert.ok(drawer.textContent.includes(label));drawer.querySelector('.n-base-close').click();await flush();
 await chooseSharedModel('任务状态','已成功结束','.platform-tasks');await until(()=>document.querySelectorAll('.task-records .task-list-item').length===1);assert.doesNotMatch(document.querySelector('.task-records').textContent,/FIRST_EMPLOYEE_TODO/);
 await chooseSharedModel('任务状态','全部状态','.platform-tasks');await chooseSharedModel('筛选数字员工','第二位管理数字员工','.platform-tasks');await until(()=>document.querySelectorAll('.task-records .task-list-item').length===1&&document.querySelector('.task-records').textContent.includes('SECOND_EMPLOYEE_TODO'));
 document.querySelector('.platform-tasks .n-collapse-item__header-main').click();await until(()=>!!document.querySelector('input[aria-label="会话 ID 筛选"]'));input('input[aria-label="会话 ID 筛选"]',f.first.id);await click('应用会话筛选');await until(()=>text().includes('没有符合筛选条件的记录'));assert.ok(f.env.requests.filter(r=>r.url.includes('/task-management/')).every(r=>r.method==='GET'));assert.equal(f.env.db.prepare('SELECT status FROM tasks WHERE id=?').get(a.id).status,'planned');
});

test('ordinary member can choose authorized employees while administrator task navigation and APIs stay forbidden', async t => {
  const env=await setup(t),owner=await env.register('admin-route-owner');
  const e=(await env.call('POST',`/api/workspaces/${owner.workspace.id}/entities`,{name:'可用私聊员工',ownWebUse:true})).json().entity;
  const denied=(await env.call('POST',`/api/workspaces/${owner.workspace.id}/entities`,{name:'无使用权员工',ownWebUse:false})).json().entity;
  const invited=(await env.call('POST',`/api/workspaces/${owner.workspace.id}/invitations`,{role:'member'})).json();
  const registration=await env.call('POST','/api/auth/register',{username:'admin-route-member',password},'');assert.equal(registration.statusCode,201,registration.body);const member=registration.json(),memberCookie=registration.headers['set-cookie'].split(';')[0];await env.call('POST','/api/invitations/accept',{token:invited.token},memberCookie);
  const memberId=env.db.prepare('SELECT id FROM members WHERE workspace_id=? AND user_id=?').get(owner.workspace.id,member.user.id).id;
  const grant=await env.call('PUT',`/api/workspaces/${owner.workspace.id}/entities/${e.id}/web-access`,{allowMemberIds:[owner.workspace.memberId,memberId],denyMemberIds:[]},owner.cookie);assert.equal(grant.statusCode,200,grant.body);
  env.setCookie(memberCookie);await env.mount(`/?ws=${owner.workspace.id}&view=tasks`);await until(()=>!!document.querySelector('.conversations-page')&&!text().includes('正在读取'));
  await until(()=>text().includes('还没有最近对话'));await click('发起对话');await until(()=>document.querySelector('.conversation-picker')?.textContent.includes('可用私聊员工'));
  assert.doesNotMatch(document.querySelector('.conversation-picker').textContent,/无使用权员工/);
  assert.equal([...document.querySelectorAll('.app-nav [role=menuitem]')].some(el=>el.textContent.trim()==='首页'),true);
  assert.equal([...document.querySelectorAll('.app-nav [role=menuitem]')].some(el=>el.textContent.trim()==='任务'),false);
  assert.equal(document.querySelector('.platform-tasks'),null);
  const forbidden=await env.call('GET',`/api/workspaces/${owner.workspace.id}/task-management/overview`);assert.equal(forbidden.statusCode,403);
  assert.equal(env.requests.some(r=>r.url.includes('/task-management/')),false);
  assert.ok(denied.id);
});

test('composer accepts another input during generation and keeps queued receipts and replies separate',async t=>{
  const {env,provider,owner,entity}=await openProbeEditor(t,'queued-input-ui',true);
  await probeSuccess();await click('保存模型配置');await until(()=>!document.querySelector('.model-settings .config-form'));
  await env.mount(`/?ws=${owner.workspace.id}&view=chat&entity=${entity.id}`);
  await until(()=>!!document.querySelector('textarea[aria-label="消息"]'));
  let release;const gate=new Promise(resolve=>release=resolve),seen=[];t.after(()=>release());
  provider.setCompletionHandler(async body=>{seen.push(body);if(seen.length===1)await gate;return seen.length===1?'FIRST_REPLY_UI':'SECOND_REPLY_UI';});
  input('textarea[aria-label="消息"]','FIRST_UI');await submit('.composer form');
  await until(()=>seen.length===1&&!document.querySelector('textarea[aria-label="消息"]').disabled);
  input('textarea[aria-label="消息"]','SECOND_UI');await submit('.composer form');
  await until(()=>document.body.textContent.includes('消息已排队'));
  assert.equal(seen.length,1);release();
  await until(()=>seen.length===2);
  assert.equal(seen[1].messages.at(-1).role,'user');assert.equal(seen[1].messages.at(-1).content,'SECOND_UI');
  // Poll each independent HTTP receipt; a queued 202 is not a reply.
  const turns=env.db.prepare('SELECT id,conversation_id FROM interaction_turns ORDER BY created_at,id').all();
  for(const turn of turns)await env.call('GET',`/api/workspaces/${owner.workspace.id}/entities/${entity.id}/conversations/${turn.conversation_id}/turns/${turn.id}`);
  await click('刷新消息');await until(()=>document.querySelector('.chat-messages').textContent.includes('SECOND_REPLY_UI'));
  assert.equal([...document.querySelectorAll('.chat-message')].filter(el=>el.textContent.includes('FIRST_REPLY_UI')).length,1);
  assert.equal([...document.querySelectorAll('.chat-message')].filter(el=>el.textContent.includes('SECOND_REPLY_UI')).length,1);
});

test('wizard three sections auto-expand empty model form and cancellation writes nothing',async t=>{
 const env=await setup(t);await env.register('wizard-three-final');await env.mount();assert.deepEqual([...document.querySelectorAll('.wizard-basics>.wizard-section>h2')].map(el=>el.textContent.trim()),['1基本信息','2模型','3使用范围']);input('input[aria-label="员工名称"]','内存草稿员工');await until(()=>!!document.querySelector('#creation-model-form'));assert.equal(document.querySelectorAll('[data-wizard-step]').length,3);assert.equal(document.querySelector('[data-wizard-step=channels]'),null);await click('暂时退出');await click('继续填写');assert.equal(document.querySelector('input[aria-label="员工名称"]').value,'内存草稿员工');assert.equal(env.db.prepare('SELECT count(*) n FROM entities').get().n,0);assert.equal(env.db.prepare('SELECT count(*) n FROM model_catalog').get().n,0);
});

test('wizard existing model selection is memory only until final bind and preserves other employee grants', async t => {
  const env = await setup(t); const owner = await env.register('wizard-reuse-final'), base = `/api/workspaces/${owner.workspace.id}`;
  const old=(await env.call('POST',base+'/entities',{name:'已有员工',ownWebUse:false})).json().entity;
  seedSharedModel(env,owner.workspace.id,'wizard-shared-final','可复用模型'); await env.mount(`/?ws=${owner.workspace.id}&view=employees`); await click('＋ 创建数字员工');
  input('input[aria-label="员工名称"]','复用模型员工'); await until(() => visible(document.querySelector('[data-wizard-step=model]'))); await until(()=>!!document.querySelector('.creation-model-choice'));
  await chooseSharedModel('员工使用的模型','可复用模型'); assert.equal(env.db.prepare('SELECT count(*) n FROM entities').get().n,1);
  assert.equal(env.requests.some(r=>r.method==='PUT'&&r.url.endsWith('/model-profile')),false);
  await until(()=>!button('确认创建数字员工').disabled);
  assert.equal(env.db.prepare('SELECT count(*) n FROM entities').get().n,1); await click('确认创建数字员工'); await until(()=>!document.querySelector('.employee-wizard'));
  const created=env.db.prepare('SELECT id FROM entities WHERE name=?').get('复用模型员工');assert.ok(created);
  assert.equal((await env.call('GET',`${base}/entities/${created.id}/model-profile`)).json().selectedProfileId,'wizard-shared-final');
  assert.equal(env.db.prepare('SELECT count(*) n FROM model_catalog').get().n,1);assert.equal(env.db.prepare('SELECT own_web_use FROM entities WHERE id=?').get(old.id).own_web_use,0);
});

test('wizard existing shared model selection stays in memory and final lost response replays employee once',async t=>{
 const env=await setup(t),owner=await env.register('wizard-probe-final');seedSharedModel(env,owner.workspace.id,'existing-verified','已配置模型');await env.mount();input('input[aria-label="员工名称"]','资源关联员工');await until(()=>!!document.querySelector('.creation-model-choice'));await chooseSharedModel('员工使用的模型','已配置模型');assert.equal(env.db.prepare('SELECT count(*) n FROM entities').get().n,0);await until(()=>!button('确认创建数字员工').disabled);let dropped=false;env.onResponse(({method,url})=>{if(!dropped&&method==='POST'&&url.endsWith('/employee-creations')){dropped=true;throw new TypeError('Synthetic final response lost');}});await click('确认创建数字员工');await until(()=>text().includes('无法连接服务或响应格式异常'));assert.equal(env.db.prepare('SELECT count(*) n FROM entities').get().n,1);const retry=[...document.querySelectorAll('button')].find(el=>el.textContent.includes('重试'));assert.ok(retry);retry.click();await until(()=>!document.querySelector('.employee-wizard'));assert.equal(env.db.prepare('SELECT count(*) n FROM entities').get().n,1);assert.equal(env.db.prepare('SELECT count(*) n FROM model_catalog').get().n,1);assert.equal(env.db.prepare('SELECT count(*) n FROM entity_model_bindings').get().n,1);assert.equal(env.requests.some(r=>r.method==='POST'&&r.url.endsWith('/model-profiles')),false);
});

test('employee thinking level is in the model area, defaults medium and persists all four choices',async t=>{
 const env=await setup(t),owner=await env.register('thinking-dom-owner'),base=`/api/workspaces/${owner.workspace.id}`;
 const entity=(await env.call('POST',base+'/entities',{name:'思考测试员工',ownWebUse:false})).json().entity;
 await env.mount(`/?ws=${owner.workspace.id}&view=settings&entity=${entity.id}`);await until(()=>!!document.querySelector('.employee-settings'));
 await click('员工设置');assert.equal(document.querySelector('[aria-label="模型与思考强度"] [aria-label="思考强度"]').closest('.n-select').textContent.includes('中'),true);
 for(const [level,label] of [['none','无'],['low','低'],['medium','中'],['high','高']]){
  await chooseSharedModel('思考强度',label,'.employee-settings');await click('保存模型与思考强度');await until(()=>env.db.prepare('SELECT execution_thinking_level v FROM entities WHERE id=?').get(entity.id).v===level);
  assert.equal((await env.call('GET',base+'/entities/'+entity.id+'/configuration')).json().entity.executionThinkingLevel,level);
 }
 await click('员工设置');await until(()=>!!document.querySelector('[aria-label="模型与思考强度"] [aria-label="思考强度"]'));
 assert.equal(document.querySelector('[aria-label="交互思考关闭方式"]'),null);assert.equal(document.querySelector('[aria-label="执行中等思考方式"]'),null);
 assert.ok(document.querySelector('[aria-label="模型与思考强度"] [aria-label="思考强度"]'));
});

test('employee empty model chooser links to management and keeps loading/error distinct from empty',async t=>{
 const env=await setup(t),owner=await env.register('chooser-empty-owner'),base=`/api/workspaces/${owner.workspace.id}`;
 const entity=(await env.call('POST',base+'/entities',{name:'空库员工',ownWebUse:false})).json().entity;
 let entered=false,release;const hold=new Promise(resolve=>{release=resolve;});t.after(()=>release());
 env.onResponse(async({url})=>{if(url===base+'/model-profiles'){entered=true;await hold;}});
 await env.mount(`/?ws=${owner.workspace.id}&view=settings&entity=${entity.id}&section=model`);await until(()=>entered);
 assert.equal(document.querySelector('.model-settings .config-form'),null);assert.equal(document.querySelector('.model-list-header'),null);assert.ok(text().includes('正在读取模型配置'));
 release();await click('员工设置');await until(()=>!!document.querySelector('[aria-label="模型与思考强度"] [aria-label="思考强度"]'));
 assert.equal(document.querySelector('.model-settings .selection-form'),null);assert.match(text(),/请到资源库配置/);assert.equal(document.querySelector('input[aria-label="配置名称"]'),null);
 assert.equal(env.db.prepare('SELECT count(*) n FROM model_catalog').get().n,0);
 env.onResponse(({url})=>{if(url===base+'/model-profiles')throw new TypeError('Synthetic catalog read failure');});
 await env.mount(`/?ws=${owner.workspace.id}&view=workspace-models`);await until(()=>text().includes('无法连接服务'));
 assert.equal(document.querySelector('.config-form'),null);assert.equal(document.querySelector('.model-list-header'),null);assert.equal(text().includes('尚无共享模型配置'),false);
 env.onResponse(undefined);await click('重新读取');await until(()=>!!document.querySelector('.config-form'));
 assert.equal(env.db.prepare('SELECT count(*) n FROM model_catalog').get().n,0);
});

test('model chooser single-select list plus and cancel preserve selection without an early save',async t=>{
 const env=await setup(t),owner=await env.register('chooser-list-owner'),base=`/api/workspaces/${owner.workspace.id}`;
 const entity=(await env.call('POST',base+'/entities',{name:'列表员工',ownWebUse:false})).json().entity;
 seedSharedModel(env,owner.workspace.id,'chooser-a','连接甲');seedSharedModel(env,owner.workspace.id,'chooser-b','连接乙');
 await env.mount(`/?ws=${owner.workspace.id}&view=settings&entity=${entity.id}&section=model`);await until(()=>!!document.querySelector('.selection-form'));await click('员工设置');
 assert.equal(!!document.querySelector('.model-settings .config-form'),false);assert.equal(document.querySelector('.model-list-header button[aria-label="新增共享模型"]'),null);
 await chooseSharedModel('员工使用的模型','连接乙');assert.equal(document.querySelector('.config-form'),null);
 const checked=[...document.querySelectorAll('.selection-form .n-radio')].filter(el=>el.querySelector('input')?.checked);assert.equal(checked.length,1);assert.match(checked[0].textContent,/连接乙/);
 assert.equal(env.requests.some(r=>r.method==='POST'&&r.url.endsWith('/model-profiles')),false);assert.equal(env.requests.some(r=>r.method==='PUT'&&r.url.endsWith('/model-profile')),false);
 await click('保存模型与思考强度');await until(()=>document.querySelector('.model-settings')?.textContent.includes('已保存。'));
 assert.equal((await env.call('GET',`${base}/entities/${entity.id}/model-profile`)).json().selectedProfileId,'chooser-b');
 assert.equal(env.db.prepare('SELECT count(*) n FROM model_catalog').get().n,2);
 const second=(await env.call('POST','/api/workspaces',{name:'隔离模型工作区'})).json().workspace;
 seedSharedModel(env,second.id,'chooser-other','另一空间连接');await env.mount(`/?ws=${second.id}&view=workspace-models`);await until(()=>!!document.querySelector('.selection-form'));
 const list=document.querySelector('.selection-form').textContent;assert.match(list,/另一空间连接/);assert.doesNotMatch(list,/连接甲|连接乙/);
 assert.equal((await env.call('GET',`${base}/entities/${entity.id}/model-profile`)).json().selectedProfileId,'chooser-b');
});

test('composer Enter sends once, Option+Enter inserts at caret and IME confirmation never sends',async t=>{
 const {env,owner,entity}=await openProbeEditor(t,'keyboard-qa',true);await probeSuccess();await click('保存模型配置');await until(()=>!document.querySelector('.model-settings .config-form'));await env.mount(`/?ws=${owner.workspace.id}&view=chat&entity=${entity.id}`);await until(()=>!!document.querySelector('textarea[aria-label="消息"]'));
 const area=document.querySelector('textarea[aria-label="消息"]'),turns=()=>env.requests.filter(r=>r.method==='POST'&&r.url.endsWith('/turns'));
 input('textarea[aria-label="消息"]','中文');area.dispatchEvent(new Event('compositionstart',{bubbles:true}));area.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await flush();assert.equal(turns().length,0);
 area.dispatchEvent(new Event('compositionend',{bubbles:true}));area.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,keyCode:229,bubbles:true,cancelable:true}));await flush();assert.equal(turns().length,0);
 input('textarea[aria-label="消息"]','AB');area.setSelectionRange(1,1);area.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',altKey:true,bubbles:true,cancelable:true}));await flush();assert.equal(area.value,'A\nB');assert.equal(area.selectionStart,2);assert.equal(turns().length,0);
 area.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));area.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',repeat:true,bubbles:true,cancelable:true}));await until(()=>turns().length===1);assert.equal(turns()[0].body.text,'A\nB');
});

test('private task rail is GET-only and shows only its authorized saved context',async t=>{
 const f=await taskJourney(t,'readonly-rail'),id=f.env.persistedProgress(f.owner,f.entity,f.first.id);
 f.env.db.prepare('UPDATE tasks SET snapshot_json=?,context_mode=? WHERE id=?').run(JSON.stringify([{id:'ctx',role:'user',text:'FROZEN_AUTHORIZED_CONTEXT',privateField:'not-public'}]),'fork',id);
 await f.env.mount(f.route('chat'));await until(()=>!!document.querySelector('.conversation-task-list li'));const start=f.env.requests.length;document.querySelector('.conversation-task-list li button').click();await until(()=>document.querySelector('.conversation-task-list').textContent.includes('FROZEN_AUTHORIZED_CONTEXT'));
 const rail=document.querySelector('.conversation-task-list');assert.equal(rail.querySelector('form,input,textarea'),null);assert.equal([...rail.querySelectorAll('button')].some(b=>/创建|删除|取消|补充|启动/.test(b.textContent)),false);assert.ok(!rail.textContent.includes('privateField'));assert.ok(f.env.requests.slice(start).every(r=>!r.method||r.method==='GET'));
 f.env.db.prepare('UPDATE tasks SET snapshot_expires_at=1 WHERE id=?').run(id);await click('刷新详情');await until(()=>rail.textContent.includes('上下文已过期'));assert.ok(!rail.textContent.includes('FROZEN_AUTHORIZED_CONTEXT'));
});

test('employee self scope stays independent of capability selections configured after creation',async t=>{
 const env=await setup(t),owner=await env.register('separate-scope-owner'),invite=(await env.call('POST',`/api/workspaces/${owner.workspace.id}/invitations`,{})).json();env.setCookie('');const guest=await env.register('package-only-member',{invitationToken:invite.token});env.setCookie(owner.cookie);await env.mount(`/?ws=${owner.workspace.id}&view=employees`);if(!document.querySelector('.employee-wizard'))await click('＋ 创建数字员工');await wizardBasics('独立授权员工');
 assert.equal(env.db.prepare('SELECT count(*) n FROM entities').get().n,0);await click('确认创建数字员工');await until(()=>!!document.querySelector('.employee-settings'));await click('工作能力');await click('新建能力包');input('input[aria-label="能力包名称"]','不能扩权的包');[...document.querySelectorAll('.package-editor .n-radio')].find(r=>r.textContent.includes('允许名单')).click();await flush();await chooseSharedModel('包内允许成员',guest.user.displayName,'.package-editor');await click('保存能力包');await until(()=>!document.querySelector('.package-editor'));
 const entity=env.db.prepare('SELECT id FROM entities').get(),policy=env.db.prepare('SELECT allow_json FROM entity_web_policies WHERE entity_id=?').get(entity.id),pack=env.db.prepare('SELECT config_json FROM capability_packages').get();
 assert.deepEqual(JSON.parse(policy.allow_json),[owner.workspace.memberId]);assert.deepEqual(JSON.parse(pack.config_json).allowMemberIds,[guest.workspace.memberId]);assert.equal((await env.call('POST',`/api/workspaces/${owner.workspace.id}/entities/${entity.id}/conversations`,{},guest.cookie)).statusCode,403);
});

test('employee restore and package status controls preserve configuration and surface conflicts',async t=>{
 const env=await setup(t),owner=await env.register('status-controls-owner'),base=`/api/workspaces/${owner.workspace.id}`;const entity=(await env.call('POST',base+'/entities',{name:'状态控件员工',ownWebUse:true})).json().entity,employeeBase=base+'/entities/'+entity.id;
 const pack=(await env.call('POST',employeeBase+'/capability-packages',{name:'保留内容的包',enabled:true,mode:'inherit',allowMemberIds:[],denyMemberIds:[],resourceIds:[]})).json();await env.mount(`/?ws=${owner.workspace.id}&view=settings&entity=${entity.id}`);await until(()=>!!document.querySelector('.employee-settings'));
 await click('更多员工操作');await click('停用员工');await click('确认员工状态变更');await until(()=>text().includes('员工已停用'));assert.equal(env.db.prepare('SELECT lifecycle_enabled FROM entities WHERE id=?').get(entity.id).lifecycle_enabled,0);await click('更多员工操作');await click('恢复员工');await click('确认员工状态变更');await until(()=>text().includes('员工已恢复'));assert.equal(env.db.prepare('SELECT lifecycle_revision FROM entities WHERE id=?').get(entity.id).lifecycle_revision,3);
 await click('工作能力');await until(()=>!!document.querySelector('.capability-package-card'));await click('停用');await until(()=>text().includes('已停用；正在执行的任务不受影响')); assert.equal(JSON.parse(env.db.prepare('SELECT config_json FROM capability_packages WHERE id=?').get(pack.id).config_json).enabled,false);await click('启用');await until(()=>text().includes('已启用。'));
 const latest=(await env.call('GET',employeeBase+'/capability-packages')).json()[0];await env.call('PUT',employeeBase+'/capability-packages/'+pack.id+'/status',{enabled:false,expectedVersion:latest.version});await click('停用');await until(()=>text().includes('能力包已被更新')); assert.equal(JSON.parse(env.db.prepare('SELECT config_json FROM capability_packages WHERE id=?').get(pack.id).config_json).enabled,false);assert.equal(env.db.prepare('SELECT count(*) n FROM capability_packages').get().n,1);
});

test('multiple package editors persist resource groups, preserve complex legacy policy and empty chat kinds through real API',async t=>{
 const approved=[
  {id:'skill-article',kind:'skill',resourceId:'article-skill',version:'1',digest:'a'.repeat(64),shared:true},
  {id:'skill-summary',kind:'skill',resourceId:'summary-skill',version:'2',digest:'b'.repeat(64),shared:true},
  {id:'mcp-alpha',kind:'mcp',serverRef:'alpha-server',allowedTools:['alpha'],shared:true},
  {id:'mcp-beta',kind:'mcp',serverRef:'beta-server',allowedTools:['beta'],shared:true},
  {id:'existing-reader',kind:'execution',resourceId:'reader',version:'1',tools:['read'],shared:true},
 ];
 const env=await setup(t,undefined,approved),owner=await env.register('multiple-package-owner'),base=`/api/workspaces/${owner.workspace.id}`;
 const entity=(await env.call('POST',base+'/entities',{name:'多包配置员工',ownWebUse:true})).json().entity,employeeBase=base+'/entities/'+entity.id;
 const initial=(await env.call('POST',employeeBase+'/capability-packages',{name:'历史组合包',enabled:true,mode:'restrict',allowMemberIds:[owner.workspace.memberId],denyMemberIds:[owner.workspace.memberId],resourceIds:['existing-reader'],conversationKinds:['meeting']})).json();
 await env.mount(`/?ws=${owner.workspace.id}&view=settings&entity=${entity.id}`);await until(()=>!button('返回员工列表').disabled);await click('工作能力');await until(()=>!!document.querySelector('.capability-package-card'));
 assert.equal(document.querySelector('input[aria-label="能力包名称"]'),null);await click('编辑 历史组合包');await until(()=>!!document.querySelector('.package-editor'));
 await chooseSharedModel('能力包Skill','article-skill','.package-editor');await chooseSharedModel('能力包Skill','summary-skill','.package-editor');await chooseSharedModel('能力包MCP','alpha-server','.package-editor');await chooseSharedModel('能力包MCP','beta-server','.package-editor');await click('保存能力包');await until(()=>!document.querySelector('.package-editor'));
 let saved=(await env.call('GET',employeeBase+'/capability-packages')).json().find(p=>p.id===initial.id);
 assert.deepEqual(saved.allowMemberIds,[owner.workspace.memberId]);assert.deepEqual(saved.denyMemberIds,[owner.workspace.memberId]);assert.deepEqual(saved.conversationKinds,['meeting']);assert.deepEqual(new Set(saved.resourceIds),new Set(approved.map(r=>r.id)));assert.equal(saved.version,2);
 const first=document.querySelector('.capability-package-card');assert.match(first.textContent,/Skill · 2/);assert.match(first.textContent,/MCP · 2/);assert.match(first.textContent,/历史组合策略/);assert.match(first.textContent,/会议（历史兼容）/);
 await click('编辑 历史组合包');await until(()=>!!document.querySelector('.package-editor'));[...document.querySelectorAll('.package-editor .n-checkbox')].find(c=>c.textContent.includes('会议（历史兼容）')).click();await click('保存能力包');await until(()=>!document.querySelector('.package-editor'));
 saved=(await env.call('GET',employeeBase+'/capability-packages')).json().find(p=>p.id===initial.id);assert.deepEqual(saved.conversationKinds,[]);assert.match(document.querySelector('.capability-package-card').textContent,/无人可用/);
 await click('新建能力包');input('input[aria-label="能力包名称"]','空允许新包');[...document.querySelectorAll('.package-editor .n-radio')].find(r=>r.textContent.includes('允许名单')).click();await flush();const start=env.requests.length;const save=button('保存能力包');save.click();save.click();await until(()=>!document.querySelector('.package-editor'));
 const packages=(await env.call('GET',employeeBase+'/capability-packages')).json();assert.equal(packages.length,2);assert.deepEqual(packages.find(p=>p.name==='空允许新包').conversationKinds,['private','group']);assert.equal(packages.find(p=>p.name==='空允许新包').mode,'restrict');assert.deepEqual(packages.find(p=>p.name==='空允许新包').allowMemberIds,[]);
 assert.equal(env.requests.slice(start).filter(r=>r.method==='POST'&&r.url.endsWith('/capability-packages')).length,1);assert.deepEqual((await env.call('GET',employeeBase+'/usable-capabilities')).json().packages,[]);
 assert.ok(env.requests.filter(r=>r.method==='POST'||r.method==='PUT').every(r=>!r.body||!Object.hasOwn(r.body,'description')||(r.url.includes('/capability-packages')&&r.body.description==='')),'Only the existing empty capability description metadata may be submitted; unrelated writes stay unchanged');
});

test('wizard Escape closes a field popup without discarding and explicit exit still confirms',async t=>{
 const env=await setup(t);await env.register('wizard-popup-escape');await env.mount();await until(()=>!!document.querySelector('.employee-wizard input'));input('.employee-wizard input','保留字段草稿');await until(()=>!!document.querySelector('.employee-thinking .n-base-selection'));
 const selection=document.querySelector('.employee-thinking .n-base-selection');selection.click();await until(()=>[...document.querySelectorAll('.n-base-select-menu')].some(visible));selection.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await until(()=>![...document.querySelectorAll('.n-base-select-menu')].some(visible),'Escape closes the field popup');assert.equal([...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='丢弃草稿并退出'),false);assert.equal(document.querySelector('.employee-wizard input[aria-label="员工名称"]').value,'保留字段草稿');
 const nameField=document.querySelector('.employee-thinking .n-base-selection');nameField.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await flush();assert.equal([...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='丢弃草稿并退出'),false);
 button('暂时退出').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await until(()=>!![...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='丢弃草稿并退出'));await click('继续填写');assert.equal(document.querySelector('.employee-wizard input').value,'保留字段草稿');assert.equal(env.db.prepare('SELECT count(*) n FROM entities').get().n,0);
});
for(const mode of ['conflict','unknown','timeout-unknown'])test(`chat ${mode} distinguishes definitive rejection from uncertain send and retains input`,async t=>{
 const {env,owner,entity}=await openProbeEditor(t,`send-${mode}`,true);await probeSuccess();await click('保存模型配置');await until(()=>!document.querySelector('.model-settings .config-form'));await env.mount(`/?ws=${owner.workspace.id}&view=chat&entity=${entity.id}`);await until(()=>!!document.querySelector('textarea[aria-label="消息"]')&&!document.querySelector('textarea[aria-label="消息"]').disabled);
 const prior=globalThis.fetch,calls=[];t.mock.method(globalThis,'fetch',async(url,options)=>{if(String(url).endsWith('/turns')){calls.push(JSON.parse(options.body));if(mode==='conflict')return Response.json({error:'CONFLICT'},{status:409});if(mode==='timeout-unknown')return Response.json({error:'TIMEOUT_UNKNOWN'},{status:409});throw new TypeError('synthetic response loss');}return prior(url,options);});
 input('textarea[aria-label="消息"]','retain synthetic text');await flush();await click('发送消息');await until(()=>text().includes(mode==='conflict'?'本次发送已被明确拒绝':'发送未确认'));assert.equal(document.querySelector('textarea[aria-label="消息"]').value,'retain synthetic text');assert.equal(calls.length,1);
 if(mode==='conflict'){assert.ok(!text().includes('发送未确认'));assert.ok(!text().includes('稍后重试'));}else{await click('发送消息');await until(()=>calls.length===2);assert.equal(calls[0].operationId,calls[1].operationId);}
});

test('editing identity and models shares wizard fields and preserves independent saved configuration', async t => {
 const env=await setup(t),owner=await env.register('identity-alignment-owner'),base=`/api/workspaces/${owner.workspace.id}`;
 seedSharedModel(env,owner.workspace.id,'alignment-model-a','对齐模型甲');seedSharedModel(env,owner.workspace.id,'alignment-model-b','对齐模型乙');
 const entity=(await env.call('POST',base+'/entities',{name:'保留原身份',description:'原职责',executionThinkingLevel:'high',ownWebUse:true})).json().entity,employeeBase=base+'/entities/'+entity.id;
 await env.call('PUT',employeeBase+'/model-profile',{profileId:'alignment-model-a'});const originalAccess=(await env.call('GET',employeeBase+'/web-access')).json();
 await env.mount(`/?ws=${owner.workspace.id}&view=employees`);await click('＋ 创建数字员工');
 const wizardFields=[...document.querySelectorAll('.employee-wizard .n-form-item-label')].slice(0,2).map(el=>el.textContent.trim()),placeholder=document.querySelector('textarea[aria-label="职责与表达风格"]').placeholder;await click('暂时退出');
 await env.mount(`/?ws=${owner.workspace.id}&view=settings&entity=${entity.id}&section=model`);await until(()=>!!document.querySelector('.selection-form'));await chooseSharedModel('员工使用的模型','对齐模型乙');
 assert.equal(button('工作区选择与管理').disabled,true);await click('返回员工列表');assert.match(text(),/有未保存的修改/);assert.ok(document.querySelector('.employee-settings'));await click('继续编辑员工');await click('渠道接入');await click('员工设置');assert.ok(document.querySelector('.n-radio--checked').textContent.includes('对齐模型乙'));
 await click('编辑资料');await until(()=>!!document.querySelector('input[aria-label="员工名称"]'));assert.deepEqual(wizardFields.map(v=>v.replace(/\s*\*/g,'')),['名称','职责']);assert.deepEqual([...document.querySelectorAll('.n-drawer .n-form-item-label')].slice(0,2).map(el=>el.textContent.trim().replace(/\s*\*/g,'')),['员工名称','职责与表达风格']);assert.equal(document.querySelector('textarea[aria-label="职责与表达风格"]').placeholder,placeholder);
 input('input[aria-label="员工名称"]','未保存身份');const before=env.requests.length;await click('取消员工信息修改');await until(()=>!document.querySelector('.n-drawer'));await click('取消模型修改');assert.equal(env.requests.slice(before).some(r=>['PATCH','PUT','POST'].includes(r.method)),false);assert.ok(document.querySelector('.n-radio--checked').textContent.includes('对齐模型甲'));assert.equal(button('工作区选择与管理').disabled,false);
 await click('编辑资料');await until(()=>!!document.querySelector('input[aria-label="员工名称"]'));assert.equal(document.querySelector('input[aria-label="员工名称"]').value,'保留原身份');input('input[aria-label="员工名称"]','');await submit('.n-drawer form');assert.match(text(),/请输入员工名称/);assert.equal(env.requests.some(r=>r.method==='PATCH'&&r.url===employeeBase),false);await click('取消员工信息修改');
 await click('编辑资料');await until(()=>!!document.querySelector('input[aria-label="员工名称"]'));input('input[aria-label="员工名称"]','已保存身份');const form=document.querySelector('.n-drawer form');form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await until(()=>[...document.querySelectorAll('.employee-settings .n-alert')].some(el=>el.textContent.trim()==='已保存。'));
 const writes=env.requests.filter(r=>r.method==='PATCH'&&r.url===employeeBase);assert.equal(writes.length,1);assert.deepEqual(writes[0].body,{name:'已保存身份',description:'原职责'});assert.equal((await env.call('GET',employeeBase+'/model-profile')).json().selectedProfileId,'alignment-model-a');assert.deepEqual((await env.call('GET',employeeBase+'/web-access')).json(),originalAccess);assert.equal((await env.call('GET',employeeBase+'/configuration')).json().entity.executionThinkingLevel,'high');assert.equal(env.requests.some(r=>r.method==='PUT'&&r.url.includes('/channels/')),false);
});

test('creation keeps channels and automation out of the form and offers them after creation',async t=>{
 const env=await setup(t),owner=await env.register('automation-entry-create');await env.mount();await wizardBasics('自动化入口员工');
 assert.equal(document.querySelector('.trigger-settings'),null);assert.equal(document.querySelector('input[aria-label="渠道应用 ID"]'),null);assert.equal(document.querySelector('[data-wizard-step=channels]'),null);assert.equal(env.db.prepare('SELECT count(*) n FROM trigger_bindings').get().n,0);
 await click('确认创建数字员工');await until(()=>!!document.querySelector('.employee-settings'));assert.equal(new URLSearchParams(location.search).get('section'),'chat');await click('触发器');await until(()=>!!document.querySelector('.trigger-settings'));await click('新增自动化任务');
 await chooseSharedModel('何时执行','按时间执行','.n-drawer');input('input[aria-label="自动化任务标题"]','创建后的定时任务');input('textarea[aria-label="自动化任务执行内容"]','隔离验收，不启用执行');
 assert.equal(env.db.prepare('SELECT count(*) n FROM trigger_bindings').get().n,0);await click('保存自动化任务');await until(()=>!document.querySelector('.n-drawer'));
 const entity=env.db.prepare('SELECT id FROM entities').get();assert.equal((await env.call('GET',`/api/workspaces/${owner.workspace.id}/entities/${entity.id}/triggers`)).json().triggers[0].enabled,false);assert.equal(env.db.prepare('SELECT count(*) n FROM tasks').get().n,0);
});

test('work entry editing preserves channel fields, handles version conflicts and saves automation independently',async t=>{
 const env=await setup(t),owner=await env.register('automation-entry-edit'),base=`/api/workspaces/${owner.workspace.id}`;
 const entity=(await env.call('POST',base+'/entities',{name:'自动化编辑员工',ownWebUse:true})).json().entity,employeeBase=base+'/entities/'+entity.id;
 const created=await env.call('POST',employeeBase+'/triggers',{name:'自动化原任务',type:'schedule',enabled:false,allowedActions:['create_task'],config:{cron:'0 9 * * *',timezone:'Asia/Shanghai',description:'Synthetic isolated task',businessKey:{mode:'empty'}}});assert.equal(created.statusCode,200,created.body);const row=created.json();
 await env.mount(`/?ws=${owner.workspace.id}&view=settings&entity=${entity.id}`);await until(()=>!button('返回员工列表').disabled);await click('渠道接入');
 const tabs=[...document.querySelectorAll('[role=tablist][aria-label="渠道供应商"] [role=tab]')];assert.equal(tabs.some(t=>t.textContent.includes('自动化任务')),false);assert.equal(visible(document.querySelector('.trigger-settings')),false);
 input('input[aria-label="渠道应用 ID"]','synthetic-edit-app');input('input[aria-label="渠道应用密钥"]','synthetic-edit-secret');
 const before=env.requests.length;await click('自动运行');assert.equal(document.querySelector('.employee-section-tabs [role=tab][aria-selected=true]').textContent.trim(),'触发器');
 assert.match(document.querySelector('.trigger-settings').textContent,/自动化原任务/);await click('编辑 自动化原任务');
 assert.ok([...document.querySelectorAll('.employee-section-tabs [role=tab]')].filter(t=>['渠道','模型'].includes(t.textContent.trim())).every(t=>t.getAttribute('aria-disabled')==='true'));assert.equal(button('返回员工列表').disabled,true);
 // Advance the real API version while the drawer holds its original version.
 const conflict=await env.call('PUT',employeeBase+'/triggers/'+row.id,{name:'并发保存的任务',type:row.type,enabled:false,allowedActions:row.allowedActions,config:row.config,expectedVersion:row.version});assert.equal(conflict.statusCode,200,conflict.body);
 input('input[aria-label="自动化任务标题"]','过期编辑');await click('保存自动化任务');await until(()=>document.querySelector('.n-drawer')?.textContent.includes('trigger_version_conflict'));
 assert.equal(document.querySelector('input[aria-label="自动化任务标题"]').value,'过期编辑');assert.ok([...document.querySelectorAll('.employee-section-tabs [role=tab]')].filter(t=>['渠道','模型'].includes(t.textContent.trim())).every(t=>t.getAttribute('aria-disabled')==='true'));
 await click('返回自动化任务列表');await click('丢弃并返回');await until(()=>!document.querySelector('.n-drawer'));await click('刷新自动化任务');await until(()=>document.querySelector('.trigger-settings').textContent.includes('并发保存的任务'));
 await click('编辑 并发保存的任务');input('input[aria-label="自动化任务标题"]','自动化已更新');await click('保存自动化任务');await until(()=>!document.querySelector('.n-drawer'));
 await click('渠道接入');assert.equal(document.querySelector('input[aria-label="渠道应用 ID"]').value,'synthetic-edit-app');assert.equal(document.querySelector('input[aria-label="渠道应用密钥"]').value,'synthetic-edit-secret');
 await click('自动运行');assert.match(document.querySelector('.trigger-settings').textContent,/自动化已更新/);
 const saved=(await env.call('GET',employeeBase+'/triggers')).json().triggers;assert.equal(saved.length,1);assert.equal(saved[0].name,'自动化已更新');assert.equal(saved[0].enabled,false);
 assert.equal(env.requests.slice(before).some(r=>['POST','PUT','PATCH','DELETE'].includes(r.method)&&!r.url.includes('/triggers')),false);
 assert.equal(env.db.prepare('SELECT count(*) n FROM tasks').get().n,0);
});


test('compact creation keeps explicit Web scope and selected model in memory until one final create',async t=>{
 const env=await setup(t),owner=await env.register('compact-return-draft');seedSharedModel(env,owner.workspace.id,'compact-a','模型 A');seedSharedModel(env,owner.workspace.id,'compact-b','模型 B');await env.mount('/',{expandWizard:false});
 assert.equal(document.querySelectorAll('.wizard-basics>.wizard-section').length,3);input('input[aria-label="员工名称"]','保留的员工草稿');input('textarea[aria-label="职责与表达风格"]','Synthetic responsibilities');await until(()=>!!document.querySelector('.creation-model-choice .n-select'));document.querySelector('.creation-model-choice .n-base-selection').click();await until(()=>text().includes('模型 A'));const option=[...document.querySelectorAll('.n-base-select-option')].find(o=>o.textContent.includes('模型 A'));assert.ok(option);option.click();await flush();
 assert.equal(document.querySelector('input[aria-label="员工名称"]').value,'保留的员工草稿');assert.equal(document.querySelector('textarea[aria-label="职责与表达风格"]').value,'Synthetic responsibilities');assert.equal(env.db.prepare('SELECT count(*) n FROM entities').get().n,0);assert.equal(env.requests.some(r=>r.method==='POST'&&r.url.endsWith('/employee-creations')),false);
 assert.ok(visible(document.querySelector('.employee-access-draft')));assert.equal(document.querySelector('[aria-label="创建员工可用范围"] input[value=self]').checked,true);await click('确认创建数字员工');await until(()=>!!document.querySelector('.employee-settings')&&!document.querySelector('.employee-wizard'));assert.equal(new URLSearchParams(location.search).get('section'),'chat');assert.equal(env.db.prepare('SELECT profile_id FROM entity_model_bindings').get().profile_id,'compact-a');assert.equal(env.db.prepare('SELECT count(*) n FROM entities').get().n,1);assert.equal(env.requests.filter(r=>r.method==='POST'&&r.url.endsWith('/employee-creations')).length,1);
});

test('independent Web usage edits protect return and browser Back, cancellation makes no write',async t=>{
 const env=await setup(t),owner=await env.register('scope-leave-guard'),base=`/api/workspaces/${owner.workspace.id}`,entity=(await env.call('POST',base+'/entities',{name:'Scope employee',ownWebUse:true})).json().entity;await env.mount(`/?ws=${owner.workspace.id}&view=settings&entity=${entity.id}&section=access`);await until(()=>!!document.querySelector('[aria-label="允许成员"] .n-base-close'));
 const start=env.requests.length;document.querySelector('[aria-label="允许成员"] .n-base-close').click();await flush();assert.equal(button('工作区选择与管理').disabled,true);await click('返回员工列表');assert.match(text(),/有未保存的修改/);assert.ok(document.querySelector('.employee-settings'));await click('继续编辑员工');const route=location.search;history.back();await flush();assert.ok(document.querySelector('.employee-settings'));assert.equal(location.search,route);await click('取消 Web 范围修改');await until(()=>!button('工作区选择与管理').disabled);await click('返回员工列表');assert.ok(document.querySelector('.employee-card'));assert.equal(env.requests.slice(start).some(r=>['POST','PUT','PATCH','DELETE'].includes(r.method)),false);
});

test('atomic model save reports an unknown response then verifies the server without repeating its write',async t=>{
 const env=await setup(t),owner=await env.register('atomic-unknown-ui'),base=`/api/workspaces/${owner.workspace.id}`,entity=(await env.call('POST',base+'/entities',{name:'Atomic unknown',ownWebUse:false})).json().entity;seedSharedModel(env,owner.workspace.id,'atomic-ui','Atomic choice');await env.mount(`/?ws=${owner.workspace.id}&view=settings&entity=${entity.id}&section=model`);await until(()=>!!document.querySelector('.model-settings .n-radio'));
 await chooseSharedModel('员工使用的模型','Atomic choice');let dropped=false;env.onResponse(({method,url})=>{if(!dropped&&method==='PUT'&&url.endsWith('/model-settings')){dropped=true;throw new TypeError('Synthetic response lost');}});await click('保存模型与思考强度');await until(()=>text().includes('无法连接服务'));assert.equal(button('保存模型与思考强度').disabled,true);await click('读取服务器配置并核对');await until(()=>text().includes('当前设置与你的选择一致'));assert.equal(env.requests.filter(r=>r.method==='PUT'&&r.url.endsWith('/model-settings')).length,1);assert.equal(env.db.prepare('SELECT profile_id FROM entity_model_bindings WHERE entity_id=?').get(entity.id).profile_id,'atomic-ui');
});

test('basic information unknown response is verified before another write and retains typed fields',async t=>{const env=await setup(t),owner=await env.register('basics-unknown-ui'),base=`/api/workspaces/${owner.workspace.id}`,entity=(await env.call('POST',base+'/entities',{name:'Before',ownWebUse:false})).json().entity;await env.mount(`/?ws=${owner.workspace.id}&view=settings&entity=${entity.id}&section=identity`);input('input[aria-label="员工名称"]','After');let dropped=false;env.onResponse(({method,url})=>{if(!dropped&&method==='PATCH'&&url.endsWith('/entities/'+entity.id)){dropped=true;throw new TypeError('Synthetic response lost');}});await click('保存基本信息');await until(()=>text().includes('保存结果暂未确认'));assert.equal(button('保存基本信息').disabled,true);assert.equal(document.querySelector('input[aria-label="员工名称"]').value,'After');await click('核对基本信息保存结果');await until(()=>text().includes('已核对：基本信息已经保存'));assert.equal(env.requests.filter(r=>r.method==='PATCH'&&r.url.endsWith('/entities/'+entity.id)).length,1);assert.equal(env.db.prepare('SELECT name FROM entities WHERE id=?').get(entity.id).name,'After');});

test('employee server search cancels stale reads and keeps URL/results/cursor on the latest filter',async t=>{const env=await setup(t),owner=await env.register('employee-search-ui'),base=`/api/workspaces/${owner.workspace.id}`;for(const name of ['Alpha employee','Beta employee'])await env.call('POST',base+'/entities',{name,ownWebUse:false});await env.mount(`/?ws=${owner.workspace.id}&view=employees`);let entered=false,release;const held=new Promise(r=>release=r);t.after(()=>release());env.onResponse(async({url})=>{if(url.includes('/employee-summaries?')&&url.includes('q=Alpha')){entered=true;await held;}});input('input[aria-label="搜索数字员工"]','Alpha');await until(()=>entered);input('input[aria-label="搜索数字员工"]','Beta');await until(()=>document.querySelector('.employee-grid')?.textContent.includes('Beta employee')&&!document.querySelector('.employee-grid')?.textContent.includes('Alpha employee'));release();await flush();assert.equal(new URLSearchParams(location.search).get('q'),'Beta');assert.doesNotMatch(document.querySelector('.employee-grid').textContent,/Alpha employee/);});

test('identity validation focuses and associates the first error while preserving the responsibility draft',async t=>{const env=await setup(t),owner=await env.register('identity-error-focus'),base=`/api/workspaces/${owner.workspace.id}`,entity=(await env.call('POST',base+'/entities',{name:'Before',ownWebUse:false})).json().entity;await env.mount(`/?ws=${owner.workspace.id}&view=settings&entity=${entity.id}&section=identity`);input('input[aria-label="员工名称"]','');input('textarea[aria-label="职责与表达风格"]','Preserve this synthetic draft');await submit('form:has(input[aria-label="员工名称"])');const field=document.querySelector('input[aria-label="员工名称"]');assert.equal(document.activeElement,field);assert.equal(field.getAttribute('aria-invalid'),'true');assert.match(document.getElementById(field.getAttribute('aria-describedby')).textContent,/请输入员工名称/);assert.equal(document.querySelector('textarea[aria-label="职责与表达风格"]').value,'Preserve this synthetic draft');assert.equal(env.requests.some(r=>r.method==='PATCH'),false);});


test('workbench navigation has real scoped links, preserves native modified clicks and guards unsaved edits',async t=>{const env=await setup(t),owner=await env.register('navigation-links'),base=`/api/workspaces/${owner.workspace.id}`,entity=(await env.call('POST',base+'/entities',{name:'Navigation employee',ownWebUse:false})).json().entity;await env.mount(`/?ws=${owner.workspace.id}&view=employees`);const links=[...document.querySelectorAll('.app-nav a')];assert.deepEqual([...document.querySelectorAll('.app-nav .nav-link')].map(a=>a.textContent.trim()),['首页','数字员工','任务','资源库','设置']);for(const link of links)assert.equal(new URL(link.href).searchParams.get('ws'),owner.workspace.id);const resources=links.find(a=>a.textContent==='资源库');assert.equal(new URL(resources.href).searchParams.get('view'),'resources');let browserDefaultPrevented;resources.addEventListener('click',event=>{browserDefaultPrevented=event.defaultPrevented;event.preventDefault();},{once:true});resources.dispatchEvent(new MouseEvent('click',{button:0,ctrlKey:true,bubbles:true,cancelable:true}));await flush();assert.equal(browserDefaultPrevented,false,'modified click retains the native new-tab action');assert.equal(new URLSearchParams(location.search).get('view'),'employees');const ordinary=new MouseEvent('click',{button:0,bubbles:true,cancelable:true});resources.dispatchEvent(ordinary);await until(()=>!!document.querySelector('.workspace-management'));assert.equal(ordinary.defaultPrevented,true);assert.equal(new URLSearchParams(location.search).get('view'),'resources');await env.mount(`/?ws=${owner.workspace.id}&view=settings&entity=${entity.id}&section=identity`);input('input[aria-label="员工名称"]','Unsaved navigation draft');await flush();assert.equal(document.querySelectorAll('.app-nav a').length,0,'dirty navigation exposes no bypassing URL');const route=location.search;await click('资源库');assert.equal(location.search,route);assert.equal(document.querySelector('input[aria-label="员工名称"]').value,'Unsaved navigation draft');assert.equal(env.requests.some(r=>r.method==='PATCH'),false);});


test('mobile navigation retains logout and protects unsaved edits when the compact header hides account actions',async t=>{
 const env=await setup(t),owner=await env.register('mobile-nav-logout'),base=`/api/workspaces/${owner.workspace.id}`,entity=(await env.call('POST',base+'/entities',{name:'Mobile employee',ownWebUse:true})).json().entity;
 await env.mount(`/?ws=${owner.workspace.id}&view=settings&entity=${entity.id}&section=access`);await until(()=>!!document.querySelector('[aria-label="允许成员"] .n-base-close'));document.querySelector('[aria-label="允许成员"] .n-base-close').click();await flush();await click('打开工作台导航');await until(()=>!!document.querySelector('.n-drawer .account-trigger'));document.querySelector('.n-drawer .account-trigger').click();await flush();assert.equal(button('退出登录').getAttribute('aria-disabled'),'true');button('退出登录').click();await flush();assert.equal(env.requests.filter(r=>r.method==='POST'&&r.url==='/api/auth/logout').length,0);document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await flush();assert.match(document.querySelector('.n-drawer').textContent,/请先保存或取消当前修改/);document.querySelector('.n-drawer .n-base-close').click();await flush();await click('取消 Web 范围修改');await click('打开工作台导航');assert.equal(document.querySelector('.n-drawer .account-trigger').disabled,false);document.querySelector('.n-drawer .account-trigger').click();await flush();await click('退出登录');await until(()=>!!document.querySelector('.auth-panel'));assert.equal(env.requests.filter(r=>r.method==='POST'&&r.url==='/api/auth/logout').length,1);assert.equal((await env.call('GET','/api/auth/me')).statusCode,401);assert.equal(document.querySelector('.app-nav'),null);assert.equal(env.requests.some(r=>r.method==='PATCH'),false);
});

const implementationCopy=/原子保存|事务中落库|配置前提|独立 pi Runtime Host|真实租户收发需单独验收|模型 API/;
test('creation and settings explain user choices, preserve no-model blocker, and keep concise save confirmation',async t=>{
 const env=await setup(t),owner=await env.register('copy-user-journey');await env.mount('/',{expandWizard:false});
 assert.doesNotMatch([...document.querySelectorAll('.page-heading,.wizard-footer,.model-choice-note')].map(el=>el.textContent).join(' '),implementationCopy);assert.equal(document.querySelectorAll('main h1').length,1);assert.match(text(),/未配置可用模型|没有可用模型/);
 input('input[aria-label="员工名称"]','使用者视角员工');await until(()=>!button('确认创建数字员工').disabled);assert.doesNotMatch([...document.querySelectorAll('.page-heading,.wizard-footer,.model-choice-note')].map(el=>el.textContent).join(' '),implementationCopy);
 await click('确认创建数字员工');await until(()=>!!document.querySelector('.entity-workspace'));assert.equal(new URLSearchParams(location.search).get('section'),'chat');assert.equal(env.requests.some(r=>r.method==='POST'&&r.url.endsWith('/turns')),false);await click('概览');await until(()=>!!document.querySelector('.employee-next-step'));
 assert.match(document.querySelector('.employee-next-step').textContent,/尚无可用模型|未配置可用模型|没有可用模型/);assert.equal(document.querySelector('.employee-next-step button').textContent.trim(),'选择模型');
 await click('选择模型');await until(()=>!!document.querySelector('.model-settings'));await click('编辑资料');await until(()=>!!document.querySelector('input[aria-label="员工名称"]'));input('input[aria-label="员工名称"]','职责清晰的员工');await click('保存基本信息');await until(()=>[...document.querySelectorAll('.employee-settings .n-alert')].some(el=>el.textContent.trim()==='已保存。'));
 assert.equal(env.requests.filter(r=>r.method==='PATCH').length,1);assert.equal(env.db.prepare('SELECT name FROM entities').get().name,'职责清晰的员工');assert.doesNotMatch([...document.querySelectorAll('.page-heading,.wizard-footer,.model-choice-note')].map(el=>el.textContent).join(' '),implementationCopy);assert.equal(document.querySelectorAll('main h1').length,1);
});

test('overview recommends the current blocker, Web-only start, and optional extensions with real permission facts',async t=>{
 const env=await setup(t,{origin:'https://synthetic.invalid'}),owner=await env.register('recommendation-ui'),base=`/api/workspaces/${owner.workspace.id}`;
 const entity=(await env.call('POST',base+'/entities',{name:'仅网页协作员工',ownWebUse:true})).json().entity,eb=base+'/entities/'+entity.id;
 env.taskModelFixture(owner,entity);
 const mount=()=>env.mount(`/?ws=${owner.workspace.id}&view=settings&entity=${entity.id}&section=overview`);
 await mount();await until(()=>!!document.querySelector('.employee-next-step'));
 assert.equal(button('开始对话').closest('.employee-next-step')!==null,true);assert.match(text(),/扩展使用方式（可选）/);assert.doesNotMatch(text(),/配置前提|真实渠道或执行器已验证|实时运行状态/);
 await click('开始对话');await until(()=>!!document.querySelector('textarea[aria-label="消息"]'));assert.equal(document.querySelectorAll('main h1').length,1);assert.ok(document.querySelector('.employee-avatar--chat'));assert.doesNotMatch(document.querySelector('.entity-workspace').textContent,/模型对话|模型 API/);assert.equal(env.requests.some(r=>r.method==='POST'&&r.url.endsWith('/turns')),false);
 assert.equal((await env.call('PUT',eb+'/web-access',{allowMemberIds:[],denyMemberIds:[]})).statusCode,200);await mount();await until(()=>!!document.querySelector('.employee-next-step'));assert.match(document.querySelector('.employee-next-step').textContent,/尚未获得对话使用权/);await click('查看使用范围');await until(()=>!!document.querySelector('.web-chat-access'));
 await env.call('PUT',eb+'/status',{enabled:false,expectedRevision:1});await mount();await until(()=>!!document.querySelector('.employee-next-step'));assert.match(document.querySelector('.employee-next-step').textContent,/员工已停用/);assert.match(document.querySelector('.employee-next-step').textContent,/尚未获得对话使用权/);await click('恢复员工');await until(()=>!!document.querySelector('.n-dialog'));assert.match(document.querySelector('.n-dialog').textContent,/恢复「仅网页协作员工」/);assert.equal(env.db.prepare('SELECT lifecycle_enabled v FROM entities WHERE id=?').get(entity.id).v,0);await click('保留当前状态');
});

test('partial channel read failure remains explicit while Web facts and retry stay usable',async t=>{
 const env=await setup(t,{origin:'https://synthetic.invalid'}),owner=await env.register('overview-partial-ui'),base=`/api/workspaces/${owner.workspace.id}`;
 const entity=(await env.call('POST',base+'/entities',{name:'渠道读取部分失败员工',ownWebUse:true})).json().entity;env.taskModelFixture(owner,entity);
 env.db.prepare('INSERT INTO employee_channel_connections(id,workspace_id,entity_id,provider,app_id,revision,state_version,record_json) VALUES(?,?,?,?,?,1,1,?)').run('partial-channel',owner.workspace.id,entity.id,'feishu','synthetic-partial-app','malformed-json');
 await env.mount(`/?ws=${owner.workspace.id}&view=settings&entity=${entity.id}&section=overview`);await until(()=>text().includes('渠道信息暂时读取失败'));
 assert.ok(button('开始对话'));assert.ok(button('重试渠道摘要'));assert.doesNotMatch(text(),/全部正常|已连接|在线/);
 env.db.prepare('DELETE FROM employee_channel_connections WHERE id=?').run('partial-channel');await click('重试渠道摘要');await until(()=>!text().includes('渠道信息暂时读取失败'));assert.ok(button('开始对话'));
});

test('shared page headers and employee avatars preserve heading semantics, decorative labels, image fit hook and fallback',async t=>{
 document.body.innerHTML='<div id="presentation"></div>';
 const app=createApp({render:()=>h('section',[
 h(PageHeader,{title:'很长的员工名称'.repeat(8)},()=>h('button','页面动作')),
 h(PageHeader,{title:'嵌入分区标题',level:2}),
 ...['directory','conversation','chat'].map(size=>h(EmployeeAvatar,{name:'😀员工',size})),
 h(EmployeeAvatar,{name:'图片员工',src:'data:image/png;base64,synthetic',decorative:false}),
 h(EmployeeAvatar,{name:' '})])});app.mount('#presentation');t.after(()=>{app.unmount();document.body.innerHTML='';});await flush();
 assert.equal(document.querySelectorAll('h1').length,1);assert.equal(document.querySelectorAll('h2').length,1);assert.equal(document.querySelector('.page-actions button').textContent,'页面动作');
 for(const size of ['directory','conversation','chat']){const avatar=document.querySelector('.employee-avatar--'+size);assert.equal(avatar.getAttribute('aria-hidden'),'true');assert.match(avatar.querySelector('img').getAttribute('src'),/employee-avatars\/thumbs-\d{2}\.svg/);avatar.querySelector('img').dispatchEvent(new Event('error'));await flush();assert.equal(avatar.textContent,'😀');}
 const named=document.querySelector('[role="img"]');assert.equal(named.getAttribute('aria-label'),'图片员工的头像');assert.equal(named.querySelector('img').getAttribute('alt'),'');named.querySelector('img').dispatchEvent(new Event('error'));await flush();assert.equal(named.textContent,'图');const empty=document.querySelectorAll('.employee-avatar')[4];empty.querySelector('img').dispatchEvent(new Event('error'));await flush();assert.equal(empty.textContent,'员');
});

test('overview status refresh follows successful and conflicting changes without reversing the next action',async t=>{
 const env=await setup(t,{origin:'https://synthetic.invalid'}),owner=await env.register('overview-refresh'),base=`/api/workspaces/${owner.workspace.id}`,entity=(await env.call('POST',base+'/entities',{name:'状态刷新员工',ownWebUse:true})).json().entity,eb=base+'/entities/'+entity.id;env.taskModelFixture(owner,entity);
 await env.call('PUT',eb+'/status',{enabled:false,expectedRevision:1});await env.mount(`/?ws=${owner.workspace.id}&view=settings&entity=${entity.id}&section=overview`);await until(()=>document.querySelector('.employee-next-step')?.textContent.includes('恢复员工'));
 await env.call('PUT',eb+'/status',{enabled:true,expectedRevision:2});await click('恢复员工');await click('确认员工状态变更');await until(()=>[...document.querySelectorAll('.employee-settings [role="alert"]')].some(e=>e.textContent.includes('员工状态已变化')));await until(()=>document.querySelector('.employee-next-step')?.textContent.includes('开始对话'));
 await click('更多员工操作');await click('停用员工');await click('确认员工状态变更');await until(()=>document.querySelector('.employee-next-step')?.textContent.includes('恢复员工'));assert.equal(env.db.prepare('SELECT lifecycle_enabled v FROM entities WHERE id=?').get(entity.id).v,0);
 await click('恢复员工');await click('确认员工状态变更');await until(()=>document.querySelector('.employee-next-step')?.textContent.includes('开始对话'));assert.equal(env.db.prepare('SELECT lifecycle_revision v FROM entities WHERE id=?').get(entity.id).v,5);assert.equal(document.querySelector('.employee-next-step').textContent.includes('恢复员工'),false);
});

test('recent contacts initiate the same conversation, cancel without writes, and return with a memory-only input draft',async t=>{
 const env=await setup(t,{origin:'https://synthetic.invalid'}),owner=await env.register('recent-contacts-ui'),base=`/api/workspaces/${owner.workspace.id}`,a=(await env.call('POST',base+'/entities',{name:'联系员工甲',ownWebUse:true,avatarPreset:'thumbs-04'})).json().entity,b=(await env.call('POST',base+'/entities',{name:'联系员工乙',ownWebUse:true,avatarPreset:'thumbs-09'})).json().entity;env.taskModelFixture(owner,a);env.taskModelFixture(owner,b);
 const ca=env.realConversation(owner,a),cb=env.realConversation(owner,b);env.retainedMessage(ca.id,'甲的最近消息');env.retainedMessage(cb.id,'乙的最近消息');const before=env.db.prepare('SELECT count(*) n FROM conversations').get().n;
 await env.mount(`/?ws=${owner.workspace.id}&view=conversations`);await until(()=>document.querySelectorAll('.conversation-list .conversation-row').length===2);assert.match(document.querySelector('.conversation-list').textContent,/最近消息/);assert.ok(document.querySelector('.employee-avatar img').getAttribute('src').includes('thumbs-'));
 await click('发起对话');await until(()=>!!document.querySelector('.conversation-picker .conversation-row'));await click('取消');assert.equal(env.db.prepare('SELECT count(*) n FROM conversations').get().n,before);
 await click('发起对话');await until(()=>!!document.querySelector('.conversation-picker .conversation-row'));[...document.querySelectorAll('.conversation-picker .conversation-row')].find(r=>r.textContent.includes(a.name)).click();await until(()=>!!document.querySelector('textarea[aria-label="消息"]'));assert.equal(new URLSearchParams(location.search).get('conversation'),ca.id);input('textarea[aria-label="消息"]','未发送的内存草稿');await click('返回对话列表');await until(()=>!!document.querySelector('.conversation-list'));assert.equal(new URLSearchParams(location.search).get('view'),'conversations');
 [...document.querySelectorAll('.conversation-list .conversation-row')].find(r=>r.textContent.includes(a.name)).click();await until(()=>!!document.querySelector('textarea[aria-label="消息"]'));assert.equal(document.querySelector('textarea[aria-label="消息"]').value,'未发送的内存草稿');assert.equal(env.db.prepare('SELECT count(*) n FROM conversations').get().n,before);assert.equal(env.requests.some(r=>r.method==='POST'&&r.url.endsWith('/turns')),false);assert.equal(JSON.stringify({...localStorage,...window.sessionStorage}).includes('未发送的内存草稿'),false);
});

test('recent contacts empty state keeps management separate from use and revoked own history stays read-only',async t=>{
 const env=await setup(t,{origin:'https://synthetic.invalid'}),owner=await env.register('recent-empty-ui'),base=`/api/workspaces/${owner.workspace.id}`,entity=(await env.call('POST',base+'/entities',{name:'有管理无使用的员工',ownWebUse:false})).json().entity;
 await env.mount(`/?ws=${owner.workspace.id}&view=conversations`);await until(()=>text().includes('还没有最近对话'));await click('发起对话');await until(()=>text().includes('暂无获准使用的员工'));assert.match(document.querySelector('.conversation-picker').textContent,/管理.*不等于/);await click('取消');assert.equal(env.db.prepare('SELECT count(*) n FROM conversations').get().n,0);
 await env.call('PUT',base+'/entities/'+entity.id+'/web-access',{allowMemberIds:[owner.workspace.memberId],denyMemberIds:[]});env.taskModelFixture(owner,entity);const c=env.realConversation(owner,entity);env.retainedMessage(c.id,'本人可读的历史');await env.call('PUT',base+'/entities/'+entity.id+'/web-access',{allowMemberIds:[],denyMemberIds:[]});
 await env.mount(`/?ws=${owner.workspace.id}&view=conversations`);await until(()=>!!document.querySelector('.conversation-row'));document.querySelector('.conversation-row').click();await until(()=>document.querySelector('.chat-messages')?.textContent.includes('本人可读的历史'));assert.equal(document.querySelector('.composer'),null);assert.match(text(),/尚未获得/);assert.equal(env.requests.some(r=>r.method==='POST'&&r.url.endsWith('/turns')),false);
});

test('recent contacts preserve the second page and list position on return, then clear cached pages on workspace change',async t=>{
 const env=await setup(t),owner=await env.register('recent-pages-ui'),base=`/api/workspaces/${owner.workspace.id}`;
 for(let i=0;i<27;i++){const entity=(await env.call('POST',base+'/entities',{name:'分页联系员工 '+i,ownWebUse:true})).json().entity;const c=env.realConversation(owner,entity);env.retainedMessage(c.id,'分页消息 '+i);}
 await env.mount(`/?ws=${owner.workspace.id}&view=conversations`);await until(()=>document.querySelectorAll('.conversations-page>.n-card .conversation-row').length===25);await click('加载更多对话');await until(()=>document.querySelectorAll('.conversations-page>.n-card .conversation-row').length===27);
 const last=[...document.querySelectorAll('.conversation-row')].at(-1),name=last.querySelector('strong').textContent;window.scrollTo({top:640});last.click();await until(()=>!!document.querySelector('.chat-messages'));await click('返回对话列表');await until(()=>document.querySelectorAll('.conversations-page>.n-card .conversation-row').length===27);assert.ok([...document.querySelectorAll('.conversation-row strong')].some(e=>e.textContent===name));assert.equal(window.scrollY,640);assert.equal(env.db.prepare('SELECT count(*) n FROM conversations').get().n,27);
 const other=(await env.call('POST','/api/workspaces',{name:'空的隔离工作区'})).json().workspace;await env.mount(`/?ws=${other.id}&view=conversations`);await until(()=>text().includes('还没有最近对话'));assert.equal(document.querySelector('.conversation-row'),null);assert.equal(text().includes('分页消息'),false);
});

test('current conversation task drawer keeps all statuses in creation-time order without changing scope or sending writes',async t=>{
 const f=await taskJourney(t,'task-order-ui'),statuses=['planned','running','succeeded','failed','canceled','unknown'];
 const ids=statuses.map((status,index)=>{const id=f.env.persistedProgress(f.owner,f.entity,f.first.id);f.env.db.prepare('UPDATE tasks SET status=?,created_at=? WHERE id=?').run(status,1000+index,id);return id;});
 f.env.persistedProgress(f.owner,f.entity,f.second.id);await f.env.mount(f.route('chat',f.first.id));await until(()=>document.querySelectorAll('.conversation-task-list .task-list li').length===6);
 assert.deepEqual([...document.querySelectorAll('.conversation-task-list .task-list li')].map(e=>e.dataset.taskId),[...ids].reverse());assert.match(document.querySelector('.conversation-task-list').textContent,/尚未启动|待办/);assert.match(document.querySelector('.conversation-task-list').textContent,/失败/);assert.match(document.querySelector('.conversation-task-list').textContent,/未知|核对/);assert.equal(f.env.requests.filter(r=>r.url.includes('/tasks')&&r.method!=='GET').length,0);
 await click('收起任务');assert.equal(document.querySelector('.conversation-task-list'),null);assert.ok(document.querySelector('.chat-messages'));
});

test('legacy avatar random choice always changes the displayed fallback and cancellation keeps the persisted identity unchanged',async t=>{
 const env=await setup(t),owner=await env.register('legacy-avatar-random'),base=`/api/workspaces/${owner.workspace.id}`,entity=(await env.call('POST',base+'/entities',{name:'旧员工头像',ownWebUse:false})).json().entity;
 await env.mount(`/?ws=${owner.workspace.id}&view=settings&entity=${entity.id}&section=identity`);await until(()=>!!document.querySelector('.avatar-picker button[aria-pressed="true"]')&&!button('取消员工信息修改').disabled);
 const selected=()=>document.querySelector('.avatar-picker button[aria-pressed="true"]').getAttribute('aria-label'),before=selected(),index=Number(before.match(/\d+/)[0])-1;
 const random=t.mock.method(Math,'random',()=>((index+.5)/12));await click('换一个');random.mock.restore();assert.notEqual(selected(),before);assert.equal(button('工作区选择与管理').disabled,true);await click('取消员工信息修改');assert.equal(selected(),before);assert.equal(env.db.prepare('SELECT avatar_preset v FROM entities WHERE id=?').get(entity.id).v,null);assert.equal(env.requests.some(r=>r.method==='PATCH'),false);
});

test('recent preview presents plain text while opening keeps the complete visible Markdown message',async t=>{
 const env=await setup(t),owner=await env.register('recent-preview-text'),base=`/api/workspaces/${owner.workspace.id}`,entity=(await env.call('POST',base+'/entities',{name:'摘要显示员工',ownWebUse:true})).json().entity;env.taskModelFixture(owner,entity);const c=env.realConversation(owner,entity),original='## 今日进展\n- **已整理** [需求清单](https://example.invalid)\n下一步确认';env.retainedMessage(c.id,original);
 await env.mount(`/?ws=${owner.workspace.id}&view=conversations`);await until(()=>!!document.querySelector('.conversation-preview'));const preview=document.querySelector('.conversation-preview');assert.equal(preview.textContent,'今日进展 已整理 需求清单 下一步确认');assert.equal(preview.children.length,0);document.querySelector('.conversation-row').click();await until(()=>document.querySelector('.chat-messages')?.textContent.includes(original));assert.equal(env.requests.some(r=>r.method==='POST'&&r.url.endsWith('/turns')),false);
});


async function idleMessageFixture(t,name){
 const env=await setup(t),owner=await env.register(name),entity=(await env.call('POST',`/api/workspaces/${owner.workspace.id}/entities`,{name:'消息刷新验收',ownWebUse:true})).json().entity;
 env.taskModelFixture(owner,entity);const a=env.realConversation(owner,entity),b=env.realConversation(owner,entity);
 const url=c=>`/?ws=${owner.workspace.id}&view=chat&entity=${entity.id}&conversation=${c.id}`;
 await env.mount(url(a),{openTasks:false});await until(()=>!!document.querySelector('.chat-messages'));
 return{env,a,b,url};
}
async function untilBackgroundMessage(predicate,description){for(let n=0;n<800;n++){await flush();if(predicate())return;}assert.fail(description);}
test('idle real conversation automatically renders a durable background completion without another input or refresh',async t=>{
 const{env,a}=await idleMessageFixture(t,'idle-result-ui');
 assert.equal(env.db.prepare('SELECT count(*) n FROM interaction_turns').get().n,0);
 env.retainedMessage(a.id,'BACKGROUND_IDLE_RESULT','assistant');
 await untilBackgroundMessage(()=>document.querySelector('.chat-messages').textContent.includes('BACKGROUND_IDLE_RESULT'),'Idle message polling did not resume');
 assert.equal([...document.querySelectorAll('.chat-message')].filter(x=>x.textContent.includes('BACKGROUND_IDLE_RESULT')).length,1);
 assert.equal(env.requests.some(r=>r.method==='POST'&&r.url.endsWith('/turns')),false,'Read refresh must not call model/create input');
});
test('switching conversations fences a delayed old response and leaves only the new conversation polling',async t=>{
 const{env,a,b,url}=await idleMessageFixture(t,'switch-idle-result-ui');let release,held=false;
 const gate=new Promise(r=>release=r);t.after(()=>release());
 env.retainedMessage(a.id,'OLD_CONVERSATION_ONLY','assistant');env.retainedMessage(b.id,'NEW_CONVERSATION_ONLY','assistant');
 env.onResponse(async r=>{if(r.url.endsWith(`/conversations/${a.id}/messages`)&&!held){held=true;await gate;}});
 window.dispatchEvent(new Event('online'));await until(()=>held,'Old request in flight');
 history.pushState(null,'',url(b));window.dispatchEvent(new Event('popstate'));
 await until(()=>document.querySelector('.chat-messages')?.textContent.includes('NEW_CONVERSATION_ONLY'),'New conversation loaded');release();await flush();
 assert.equal(document.querySelector('.chat-messages').textContent.includes('OLD_CONVERSATION_ONLY'),false);
 const oldReads=env.requests.filter(r=>r.url.endsWith(`/conversations/${a.id}/messages`)).length;
 env.retainedMessage(b.id,'NEW_BACKGROUND_AFTER_SWITCH','assistant');
 await untilBackgroundMessage(()=>document.querySelector('.chat-messages').textContent.includes('NEW_BACKGROUND_AFTER_SWITCH'),'New conversation timer canceled by old response');
 assert.equal(env.requests.filter(r=>r.url.endsWith(`/conversations/${a.id}/messages`)).length,oldReads);
});
test('connection recovery and repeated refresh replace the durable message snapshot without duplicates',async t=>{
 const{env,a}=await idleMessageFixture(t,'online-idle-result-ui');let fail=true;
 env.onResponse(async r=>{if(r.url.endsWith(`/conversations/${a.id}/messages`)&&fail){fail=false;throw new TypeError('Synthetic isolated offline');}});
 window.dispatchEvent(new Event('online'));await flush();await flush();
 env.retainedMessage(a.id,'RECOVERED_BACKGROUND_RESULT','assistant');window.dispatchEvent(new Event('online'));
 await untilBackgroundMessage(()=>document.querySelector('.chat-messages').textContent.includes('RECOVERED_BACKGROUND_RESULT'),'Reconnected messages missing');
 for(let n=0;n<3;n++){window.dispatchEvent(new Event('online'));document.dispatchEvent(new Event('visibilitychange'));await flush();await click('刷新消息');}
 assert.equal([...document.querySelectorAll('.chat-message')].filter(x=>x.textContent.includes('RECOVERED_BACKGROUND_RESULT')).length,1);
 assert.equal(env.requests.some(r=>r.method==='POST'&&r.url.endsWith('/turns')),false);
});

test('a slower manual message refresh cannot overwrite a newer idle refresh in the same conversation',async t=>{
 const{env,a}=await idleMessageFixture(t,'ordered-idle-result-ui');let release,held=false;
 const gate=new Promise(r=>release=r);t.after(()=>release());
 env.onResponse(async r=>{if(r.url.endsWith(`/conversations/${a.id}/messages`)&&!held){held=true;await gate;}});
 button('刷新消息').click();await until(()=>held,'Manual refresh held with old snapshot');
 env.retainedMessage(a.id,'LATEST_MESSAGE_MUST_REMAIN','assistant');window.dispatchEvent(new Event('online'));
 await until(()=>document.querySelector('.chat-messages').textContent.includes('LATEST_MESSAGE_MUST_REMAIN'),'New snapshot applied');
 release();await flush();await flush();
 assert.equal([...document.querySelectorAll('.chat-message')].filter(x=>x.textContent.includes('LATEST_MESSAGE_MUST_REMAIN')).length,1);
});


for(const state of ['failed','canceled','unknown'])test(`chat terminal ${state} preserves safe API detail and distinct outcome without replay`,async t=>{
 const {env,owner,entity}=await openProbeEditor(t,'terminal-'+state,true);await probeSuccess();await click('保存模型配置');await until(()=>!document.querySelector('.model-settings .config-form'));await env.mount(`/?ws=${owner.workspace.id}&view=chat&entity=${entity.id}`);await until(()=>!!document.querySelector('textarea[aria-label="消息"]')&&!document.querySelector('textarea[aria-label="消息"]').disabled);const prior=globalThis.fetch,seen=[];const safe='Synthetic safe terminal detail: '+state;
 t.mock.method(globalThis,'fetch',async(url,options={})=>{
  if(String(url).endsWith('/turns')&&options.method==='POST'){seen.push(JSON.parse(options.body));return Response.json({turn:{id:'safe-terminal-ui',status:'running',mode:'real',simulated:false}},{status:202});}
  if(String(url).endsWith('/turns/safe-terminal-ui'))return Response.json({turn:{id:'safe-terminal-ui',status:state,error:safe,mode:'real',simulated:false}});
  return prior(url,options);
 });
 input('textarea[aria-label="消息"]','Synthetic terminal projection input');await click('发送消息');await until(()=>text().includes(safe));
 assert.equal(seen.length,1);assert.equal([...document.querySelectorAll('button')].some(b=>visible(b)&&b.textContent.trim()==='申请中断回复'),false);
 const composer=document.querySelector('.composer').textContent;
 if(state==='failed')assert.match(composer,/本轮回复失败/);
 if(state==='canceled')assert.match(composer,/本轮回复已中断，不代表业务任务取消/);
 if(state==='unknown'){assert.match(text(),/结果未知/);assert.equal(composer.includes('本轮回复失败'),false);}
 await flush();assert.equal(seen.length,1,'Reading a terminal outcome never automatically resubmits the message');assert.equal(env.db.prepare('SELECT count(*) n FROM tasks').get().n,0);
});
