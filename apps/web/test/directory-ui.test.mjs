import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import { build } from 'esbuild';
import { parse, compileScript } from '@vue/compiler-sfc';

// User-approved directory UI cases use in-process transport fixtures only.
// No provider, credentials, production database or external side effect is used.
const window = new Window({ url: 'http://127.0.0.1:5173/' });
for (const name of ['window', 'document', 'navigator', 'location', 'history', 'localStorage', 'Node', 'ShadowRoot', 'Document', 'Element', 'HTMLElement', 'SVGElement', 'HTMLDialogElement', 'Event', 'MouseEvent', 'KeyboardEvent', 'PointerEvent', 'FocusEvent', 'InputEvent', 'Image', 'HTMLInputElement', 'HTMLTextAreaElement', 'getComputedStyle', 'MutationObserver', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame']) Object.defineProperty(globalThis, name, { value: name === 'window' ? window : window[name], configurable: true });
const { createApp, h, reactive, nextTick } = await import('vue');
const bundle = await mkdtemp(resolve('apps/web/.directory-ui-test-'));
const paths = { draft: 'apps/web/src/features/employees/WizardChannelDraft.vue', wecom: 'apps/web/src/features/employees/WecomDirectoryBinding.vue', wizard: 'apps/web/src/features/employees/EntityWizard.vue', guide: 'apps/web/src/features/directory/DirectorySetupGuide.vue', settings: 'apps/web/src/features/employees/ChannelConnections.vue', picker: 'apps/web/src/features/directory/DirectoryRulePicker.vue', access: 'apps/web/src/features/employees/AccessSettings.vue' };
const components = {};
for (const [name, path] of Object.entries(paths)) {
  const outfile = join(bundle, `${name}.mjs`);
  await build({ entryPoints: [path], outfile, bundle: true, platform: 'node', format: 'esm', external: ['vue', 'naive-ui'], plugins: [{ name: 'vue-sfc', setup(builder) { builder.onLoad({ filter: /\.vue$/ }, async ({ path }) => { const { descriptor } = parse(await readFile(path, 'utf8'), { filename: path }); return { contents: compileScript(descriptor, { id: path, inlineTemplate: true, fs: { fileExists: existsSync, readFile: file => readFileSync(file, 'utf8') } }).content, loader: 'ts', resolveDir: resolve(path, '..') }; }); } }] });
  components[name] = (await import(pathToFileURL(outfile).href)).default;
}
test.after(async () => { await rm(bundle, { recursive: true, force: true }); await window.happyDOM.close(); });
async function providerTab(name){const tab=[...document.querySelectorAll('[role=tablist][aria-label="员工渠道"] [role=tab]')].find(t=>t.textContent.trim()===name);assert.ok(tab,name);tab.click();await flush();}
const text = () => document.body.textContent;
async function flush() { await new Promise(resolve => setTimeout(resolve, 10)); await nextTick(); }
async function until(predicate, description = 'UI settled') { for (let index = 0; index < 100; index++) { await flush(); if (predicate()) return; } assert.fail(`${description}\n${text()}`); }
function visible(el) { for (let node = el; node instanceof HTMLElement; node = node.parentElement) if (node.hidden || node.style.display === 'none' || node.style.visibility === 'hidden' || node.getAttribute('aria-hidden') === 'true') return false; return true; }
function button(label) { const result = [...document.querySelectorAll('button')].find(item => visible(item) && (item.textContent.trim() === label || item.getAttribute('aria-label') === label)); assert.ok(result, `button ${label}`); return result; }
function input(label, value) { const field = document.querySelector(`input[aria-label="${label}"]`); assert.ok(field, label); field.value = value; field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value })); }
async function click(label) { await nextTick(); if(['验证并保存渠道连接','重新验证已存凭据','停用此渠道','启用此渠道','解除渠道绑定','验证渠道并读取通讯录'].includes(label)&&document.querySelector('.channel-guide-dots button[data-step=validate]'))await channelCard('validate'); button(label).click(); await flush(); }
async function channelCard(id) { id=id==='create'?'credentials':id==='optional'?'validate':id; const dot=document.querySelector(`.channel-guide-dots button[data-step="${id}"]`); assert.ok(dot); dot.click(); await flush(); }
async function mount(t, name, initial, handler = async () => { throw new Error('Unexpected request'); }, runtimeHandler) {
  const props = reactive(initial), requests = [], events={ready:[],change:[],busy:[]};
  if(name==='draft')Object.assign(props,{onReadyChanged:v=>events.ready.push(v),onChange:v=>events.change.push(v),onBusyChanged:v=>events.busy.push(v)});
  let latestConnections = [];
  globalThis.fetch = async (url, options = {}) => {
    assert.ok(String(url).startsWith('/api/'), 'Only relative local fixture API routes are permitted');
    const request = { url: String(url), method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : undefined };
    requests.push(request);
    const result = name === 'settings' && request.method==='GET' && request.url.endsWith('/directory-access')
      ? {allow:[],deny:[],allowGroupMembers:false,revision:0}
      : name === 'settings' && request.url.endsWith('/runtime-status')
      ? await (runtimeHandler ? runtimeHandler(request) : { observedAt: 1792756800000, employee: { channels: latestConnections } })
      : await handler(request);
    if (name === 'settings' && request.method === 'GET' && request.url.endsWith('/channels')) latestConnections = result?.data ?? result;
    return new Response(JSON.stringify(result?.data ?? result), { status: typeof result?.status === 'number' ? result.status : 200, headers: { 'content-type': 'application/json' } });
  };
  document.body.innerHTML = '<div id="app"></div>';
  const app = createApp({ render: () => h(components[name], props) }); app.mount('#app'); await flush();if(name==='settings'&&initial.canManage){await until(()=>!!document.querySelector('.connection-list'));const b=[...document.querySelectorAll('.connection-list button')].find(b=>b.textContent.trim()==='查看此连接')??[...document.querySelectorAll('.connection-list button')].find(b=>b.textContent.trim()==='添加渠道连接');if(b){b.click();await flush();}const details=document.querySelector('.channel-guide-toggle');if(details)details.open=true;}if(name==='wizard'){const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='展开渠道、工作能力与自动运行配置');if(b){b.click();await flush();}} if(name==='settings'&&document.querySelector('.channel-guide-dots button[data-step=validate]'))await channelCard('validate');
  t.after(() => { app.unmount(); document.body.innerHTML = ''; });
  return { props, requests, app, events };
}
const base = '/workspaces/workspace-a/entities/employee-a';
const connection = (overrides = {}) => ({ validation:{version:1,provider:overrides.provider??'feishu',checkedAt:Date.now(),canContinue:true,checks:[{id:'credentials',required:true,supported:true,status:'pass'},{id:'directory_identity',required:true,supported:true,status:'pass'},{id:'directory_scope',required:true,supported:true,status:'pass'},{id:'user_name',required:true,supported:true,status:'pass'}]},transport: { state: 'connected', changedAt: 1792756800000 }, id: 'connection-1', sourceId: 'source-1', entityId: 'employee-a', provider: 'feishu', appId: 'fixture-app', tenantId: 'fixture-tenant', tenantIdNamespace: 'tenant_key', revision: 1, authRevision: 1, status: 'verified', identityEvidence: 'provider_api', inboundVerified: false, directoryStatus: 'available', enabled: true, ...overrides });
const subjects = source => ({ sources: [source ?? connection()], users: [], departments: [] });
const department = { externalId: 'department-7', subjectId: JSON.stringify({ id: 'department-7', namespace: 'department_id', applicationId: 'fixture-app' }), displayName: '研发部', kind: 'department' };
const page = (items, overrides = {}) => ({ sourceId: 'source-1', provider: 'feishu', appId: 'fixture-app', items, exhausted: true, ...overrides });

test('employee connection submits manual parameters, clears secrets, blocks duplicates and displays pending honestly', async t => {
  let connections = [], release; const pending = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const env = await mount(t, 'settings', { base, canManage: true }, async request => {
    assert.ok(request.url.startsWith(`/api${base}/channels`));
    if (request.method === 'GET') return connections;
    await pending; connections = [connection({ status: 'pending_verification', tenantIdNamespace: 'app_scoped' })]; return connections[0];
  });
  await until(() => !!document.querySelector('.channel-connection-form'));
  input('渠道应用 ID', 'fixture-app'); input('渠道应用密钥', 'synthetic-fixture-secret');
  await click('验证并保存渠道连接');
  assert.equal(document.querySelector('input[aria-label="渠道应用密钥"]').value, '');
  assert.equal(button('验证并保存渠道连接').disabled, true); button('验证并保存渠道连接').click();
  assert.equal(env.requests.filter(item => item.method === 'PUT').length, 1);
  assert.deepEqual(env.requests.find(item => item.method === 'PUT').body, { appId: 'fixture-app', appSecret: 'synthetic-fixture-secret', expectedRevision: 0, replaceSource: false });
  assert.equal(document.querySelector('input[aria-label="botId"]'), null);
  release(); await until(() => text().includes('等待机器人身份验证'));
  assert.ok(text().includes('不代表企业 corpId 已验证')); assert.equal(document.body.innerHTML.includes('synthetic-fixture-secret'), false);
});

test('member sees both provider statuses without credential forms or mutation actions', async t => {
  const env = await mount(t, 'settings', { base, canManage: false }, async () => [connection(), connection({ id: 'connection-2', sourceId: 'source-2', provider: 'dingtalk', status: 'invalid', directoryStatus: 'unavailable' })]);
  await until(()=>document.querySelectorAll('.connection-list .n-card').length===2);assert.ok(text().includes('不可用'));document.querySelector('.connection-list .n-card button').click();await flush();assert.ok(text().includes('机器人已验证'));assert.ok(text().includes('测试入站：尚未确认'));assert.equal(document.querySelector('.connection-diagnostics').open,false);assert.ok(text().includes('厂商 API 身份证据'));await click('返回连接列表');
  assert.ok(text().includes('飞书')); assert.ok(text().includes('钉钉')); assert.equal(document.querySelector('input'), null);
  assert.equal(document.querySelector('[data-testid="callback-path"]'), null); assert.equal(text().includes('/api/channel-callbacks/connection-1'), false);
  assert.equal(document.querySelector('.channel-connection-form'), null); assert.ok(env.requests.every(item => item.method === 'GET'));
});

test('revalidation and disabling use current CAS revision, failures reread authoritative state', async t => {
  let current = connection();
  const env = await mount(t, 'settings', { base, canManage: true }, async request => {
    if (request.method === 'GET') return [current];
    if (request.url.endsWith('/revalidate')) { current = connection({ revision: 2, status: 'invalid' }); return { status: 502, data: { error: 'fixture_verification_failed' } }; }
    current = connection({ revision: 3, status: 'disabled', enabled: false }); return current;
  });
  await until(() => text().includes('机器人已验证')); await click('重新验证已存凭据');
  await until(() => text().includes('连接失效')); assert.ok(text().includes('fixture_verification_failed'));
  await click('停用此渠道'); await until(() => text().includes('已停用'));
  assert.deepEqual(env.requests.find(item => item.url.endsWith('/revalidate')).body, { expectedRevision: 1 });
  assert.deepEqual(env.requests.find(item => item.url.endsWith('/settings')).body, { expectedRevision: 2, enabled: false });
});

test('picker reads only on demand, paginates, preserves opaque references and defaults descendants false', async t => {
  let selected = [];
  const env = await mount(t, 'picker', { base, label: '允许', subjects: subjects(), rules: selected, 'onUpdate:rules': value => { selected = value; env.props.rules = value; } }, async request => {
    const url = new URL(request.url, 'http://localhost');
    assert.equal(url.pathname, `/api${base}/channels/feishu/directory`);
    if (url.searchParams.has('parentId')) { assert.equal(url.searchParams.get('parentId'), department.externalId); return page([]); }
    return url.searchParams.has('cursor') ? page([{ ...department, subjectId: 'opaque-second', displayName: '第二部门' }]) : page([department], { exhausted: false, nextCursor: 'page-2' });
  });
  assert.equal(env.requests.length, 0); await click('查询当前目录'); await until(() => text().includes('研发部'));
  await click('选择部门'); assert.deepEqual(selected, [{ sourceId: 'source-1', kind: 'department', subjectId: department.subjectId, includeDescendants: false, conversationKinds: ['private'] }]);
  await click('加载下一页'); await until(() => text().includes('第二部门')); assert.ok(env.requests[1].url.includes('cursor=page-2'));
  await click('进入部门'); await until(() => env.requests.length === 3); assert.ok(text().includes('返回上级部门'));
  await click('移除此规则'); assert.deepEqual(selected, []);
});

test('picker rejects changed application scope and leaves old rules removable', async t => {
  const rule = { sourceId: 'retired-source', kind: 'department', subjectId: 'old-opaque-reference', conversationKinds: ['private'], includeDescendants: false };
  let selected = [rule];
  const env = await mount(t, 'picker', { base, label: '拒绝', subjects: subjects(), rules: selected, 'onUpdate:rules': value => { selected = value; env.props.rules = value; } }, async () => page([department], { sourceId: 'changed-source' }));
  assert.ok(text().includes('来源不可用')); await click('查询当前目录'); await until(() => text().includes('连接来源已改变'));
  assert.equal(document.querySelector('.directory-option'), null); await click('移除此规则'); assert.deepEqual(selected, []);
});

test('picker fails closed on transport failure and repeated pagination cursor', async t => {
  const env = await mount(t, 'picker', { base, label: '允许', subjects: subjects(), rules: [] }, async () => page([department], { exhausted: false, nextCursor: 'loop' }));
  await click('查询当前目录'); await until(() => text().includes('研发部')); await click('加载下一页');
  await until(() => text().includes('目录分页游标无效')); assert.equal(document.querySelector('.directory-option'), null);
  env.props.subjects = subjects(connection({ status: 'invalid' })); await flush(); assert.ok(text().includes('没有可用的员工渠道目录')); assert.equal(button('查询当前目录').disabled, true);
});

test('guide is local read-only, uses official attribution and explains employee scoped setup', async t => {
  const env = await mount(t, 'guide', { provider: 'feishu' });
  assert.ok(text().includes('飞书员工应用连接指南')); assert.ok(text().includes('每位员工每个渠道最多连接一个机器人')); assert.ok(text().includes('display_id 不是 tenant_key'));
  env.props.provider = 'dingtalk'; await flush(); assert.ok(text().includes('corpId')); assert.ok(text().includes('待验证'));
  const image = document.querySelector('.guide-figure img'); assert.ok(image); assert.match(image.getAttribute('src'), /^\/directory-guides\//);
  assert.deepEqual(await readFile(`apps/web/public${image.getAttribute('src')}`), await readFile('apps/web/public/channel-guides/dingtalk-create-app.jpg'));
  assert.equal(env.requests.length, 0); assert.equal(document.querySelector('input'), null);
});

test('access settings use employee metadata endpoint and keep Web and channel grants separate', async t => {
  const env = await mount(t, 'access', { base }, async request => {
    if (request.url.endsWith('/web-access')) return { allowMemberIds: ['platform-member'], denyMemberIds: [], revision: 1 };
    if (request.url.endsWith('/directory-access')) return { allow: [], deny: [], revision: 1 };
    if (request.url.endsWith('/channels/subjects')) return subjects();
    return [];
  });
  await until(() => text().includes('保存渠道使用策略'));
  assert.ok(env.requests.some(item => item.url === `/api${base}/channels/subjects`));
  assert.equal(env.requests.some(item => /\/directory\?/.test(item.url)), false);
  await click('保存渠道使用策略'); await until(() => env.requests.some(item => item.method === 'PUT'));
  assert.deepEqual(env.requests.find(item => item.method === 'PUT').body, { allow: [], deny: [], allowGroupMembers:false, expectedRevision:1 });
});

test('pending connection responses cannot replace another employee configuration', async t => {
  let release; const pending = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const other = '/workspaces/workspace-a/entities/employee-b';
  const env = await mount(t, 'settings', { base, canManage: true }, async request => {
    if (request.url === `/api${base}/channels`) { await pending; return [connection({ appId: 'old-employee-app' })]; }
    return [connection({ entityId: 'employee-b', appId: 'new-employee-app' })];
  });
  env.props.base = other; await until(() => text().includes('new-employee-app'));
  release(); await flush(); assert.equal(text().includes('old-employee-app'), false);
  assert.equal(document.querySelector('input[aria-label="渠道应用密钥"]').value, '');
});

test('provider switch clears unsubmitted credentials even when neither provider is connected', async t => {
  await mount(t, 'settings', { base, canManage: true }, async () => []);
  await until(() => !!document.querySelector('.channel-connection-form'));
  input('渠道应用 ID', 'unsaved-app'); input('渠道应用密钥', 'unsaved-fixture-secret');
  await providerTab('钉钉');
  await until(() => !!document.querySelector('.setup-requirements')&&text().includes('Client ID（AppKey）'));
  assert.equal(document.querySelector('input[aria-label="渠道应用密钥"]').value, '');
  assert.equal(document.querySelector('input[aria-label="回调校验 Token"]'), null);
  assert.equal(document.querySelector('input[aria-label="渠道应用 ID"]').value, '');
});

test('explicit unbind asks confirmation and releases the current CAS binding before replacement', async t => {
  let current = connection();
  const env = await mount(t, 'settings', { base, canManage: true }, async request => {
    if (request.method === 'GET') return current ? [current] : [];
    if (request.method === 'DELETE') { current = undefined; return { ok: true }; }
    current = connection({ id: 'replacement-connection', appId: request.body.appId }); return current;
  });
  await until(() => text().includes('机器人已验证')); await click('解除渠道绑定'); await click('保留绑定');
  assert.equal(env.requests.some(r => r.method === 'DELETE'), false);
  await click('解除渠道绑定'); await click('确认解除绑定'); await until(() => text().includes('渠道绑定已解除'));
  assert.deepEqual(env.requests.find(r => r.method === 'DELETE').body, { expectedRevision: 1 });
  input('渠道应用 ID', 'replacement-app'); input('渠道应用密钥', 'replacement-fixture-secret'); await click('验证并保存渠道连接');
  await until(() => env.requests.some(r => r.method === 'PUT')); assert.equal(env.requests.find(r => r.method === 'PUT').body.expectedRevision, 0);
});

test('single-page channel form keeps official requirements and clears unsubmitted credentials on provider switch', async t => {
 const env=await mount(t,'settings',{base,canManage:true},async r=>{if(r.method==='GET'&&r.url.endsWith('/channels'))return [];if(r.method==='GET'&&r.url.endsWith('/directory-credentials'))return {credentials:[]};throw new Error('Unexpected request '+r.url);});
 const tabs=[...document.querySelectorAll('[role=tablist][aria-label="员工渠道"] [role=tab]')];assert.deepEqual(tabs.map(t=>t.textContent.trim()),['飞书','钉钉','企业微信']);
 for(const tab of tabs){const image=tab.querySelector('img');assert.ok(image);assert.ok((await readFile('apps/web/public'+image.getAttribute('src'))).length>100);}
 assert.equal(document.querySelector('.wizard-channel-guide'),null);assert.ok(document.querySelector('.channel-setup a[href="https://open.feishu.cn/app"]'));assert.match(document.querySelector('.setup-requirements').textContent,/im:message:send_as_bot/);input('渠道应用 ID','synthetic-app');input('渠道应用密钥','synthetic-secret');
 const feishu=document.querySelector('[role=tab][data-name="feishu"]');feishu.focus();feishu.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));await until(()=>document.querySelector('[role=tab][data-name="dingtalk"]').getAttribute('aria-selected')==='true');
 assert.equal(document.querySelector('input[aria-label="渠道应用 ID"]').value,'');assert.equal(document.querySelector('input[aria-label="渠道应用密钥"]').value,'');assert.match(document.querySelector('.setup-requirements').textContent,/Stream/);
 assert.equal(env.requests.some(r=>r.method!=='GET'),false,'browsing and editing credentials must not save or create employees');assert.equal(JSON.stringify({...localStorage,...window.sessionStorage}).includes('synthetic-secret'),false);
});

test('pending robot verification requires explicit start, checking signed candidate and separate confirmation', async t => {
  let current = connection({ status: 'pending_verification' });
  const env = await mount(t, 'settings', { base, canManage: true }, async request => {
    if (request.url.endsWith('/verification/start')) return { challengeId: 'fixture-challenge', challengeText: 'verify fixture-code', revision: 2, expiresAt: Date.now() + 60000 };
    if (request.url.endsWith('/verification/confirm')) { current = connection({ revision: 2, botId: 'verified-fixture-bot', identityEvidence: 'authenticated_event_confirmed', inboundVerified: true }); return current; }
    if (request.url.endsWith('/verification')) return { status: 'observed', revision: 2, candidateId: 'fixture-candidate', botId: 'verified-fixture-bot', expiresAt: Date.now() + 60000 };
    return [current];
  });
  await until(() => text().includes('开始机器人身份验证'));
  assert.deepEqual(env.requests.map(r=>r.url).sort(),[`/api${base}/channels`,`/api${base}/runtime-status`,`/api${base}/directory-access`].sort());assert.ok(env.requests.every(r=>r.method==='GET')); await click('开始机器人身份验证');
  await until(() => text().includes('检查测试消息候选')); assert.equal(env.requests.some(item => item.url.endsWith('/verification/confirm')), false);
  await click('检查测试消息候选'); await until(() => text().includes('身份核对无误，确认绑定此候选'));
  assert.equal(env.requests.some(item => item.url.endsWith('/verification/confirm')), false);
  await click('身份核对无误，确认绑定此候选'); await until(() => text().includes('机器人已验证'));
  assert.ok(text().includes('测试入站：已确认'));
  assert.ok(text().includes('管理员确认的已认证事件'));
  assert.deepEqual(env.requests.find(item => item.url.endsWith('/verification/confirm')).body, { candidateId: 'fixture-candidate', expectedRevision: 2 });
});

test('waiting or expired robot verification cannot expose a confirmation action', async t => {
  let expired = false;
  const env = await mount(t, 'settings', { base, canManage: true }, async request => {
    if (request.url.endsWith('/verification/start')) return { challengeId: 'fixture-challenge', challengeText: 'verify fixture-code', revision: 2, expiresAt: Date.now() + 60000 };
    if (request.url.endsWith('/verification')) return expired ? { status: 'not_started' } : { status: 'waiting', expiresAt: Date.now() + 60000 };
    return [connection({ status: 'pending_verification' })];
  });
  await until(() => text().includes('开始机器人身份验证')); await click('开始机器人身份验证'); await click('检查测试消息候选');
  await until(() => text().includes('尚未收到可确认的测试消息'));
  expired = true; await click('检查测试消息候选'); await until(() => text().includes('验证尚未开始或已过期'));
  assert.equal(text().includes('身份核对无误，确认绑定此候选'), false);
  assert.equal(env.requests.some(item => item.url.endsWith('/verification/confirm')), false);
});

test('Feishu context settings preserve enabled status with CAS and remove static meeting material configuration', async t => {
  let current = connection({ context: { historyEnabled: false, meetingRefs: [{kind:'minutes',externalId:'old-material'}] } });
  const env = await mount(t, 'settings', { base, canManage: true }, async request => {
    if (request.method === 'GET') return [current];
    current = connection({ revision: 2, context: { historyEnabled: false, groupListenEnabled:request.body.groupListenEnabled, meetingRefs: [] } }); return current;
  });
  await until(() => !!document.querySelector('.channel-context-form'));
  assert.deepEqual(new Set(env.requests.map(r=>r.url)),new Set([`/api${base}/channels`,`/api${base}/runtime-status`,`/api${base}/directory-access`])); await click('群上下文范围');assert.ok(text().includes('资料引用'));await click('群上下文范围');assert.ok(document.querySelector('.channel-context-form textarea[aria-label="群聊触发关键词"]'));assert.ok(text().includes('普通群消息接收权限尚未验证'));
  document.querySelector('.channel-context-form .n-checkbox').click();
  await click('保存'); await until(() => env.requests.some(item => item.method === 'PUT'));
  assert.deepEqual(env.requests.find(item => item.method === 'PUT').body, { enabled: true, expectedRevision: 1, groupListenEnabled: true, groupTriggerKeywords:[] });
  await until(() => text().includes('已保存。')); assert.ok(text().includes('机器人已验证'));assert.ok(!text().includes('每行一个妙记'));
});

test('DingTalk context has no unsupported history or meeting controls', async t => {
  await mount(t, 'settings', { base, canManage: true }, async () => [connection({ provider: 'dingtalk' })]);
  await until(()=>!!document.querySelector('[role=tablist][aria-label=员工渠道]'));
  const selection = [...document.querySelectorAll('[role=tablist][aria-label=员工渠道] [role=tab]')].find(t=>t.textContent.includes('钉钉')); selection.click(); await flush();
  await until(() => text().includes('群历史和会议材料不在当前接入能力内'));
  assert.equal(document.querySelector('.channel-context-form'), null); assert.equal(document.querySelector('textarea[aria-label="明确的 Minutes token"]'), null);
});

test('runtime channel status displays real connection and observation times instead of platform stopped fallback', async t => {
  const stored = connection({ transport: { state: 'stopped', changedAt: 1 } });
  const live = { ...stored, transport: { state: 'connected', changedAt: 1792756700000, lastConnectedAt: 1792756700000 } };
  await mount(t, 'settings', { base, canManage: true }, async () => [stored], async () => ({ observedAt: 1792756800000, employee: { channels: [live] } }));
  await until(() => text().includes('长连接：已连接'));
  assert.ok(!text().includes('长连接：已停止'));
  assert.ok(text().includes('状态更新时间：' + new Date(live.transport.changedAt).toLocaleString('zh-CN')));
  assert.ok(text().includes('运行状态观测时间：' + new Date(1792756800000).toLocaleString('zh-CN')));
  assert.equal(document.querySelector('[data-testid=transport-status]').textContent.trim(),'长连接：已连接');assert.equal(document.querySelector('.connection-diagnostics').open,false);
});

test('runtime channel status becomes unknown on unavailable service and refresh restores connection', async t => {
  const stored = connection(); let unavailable = false;
  await mount(t, 'settings', { base, canManage: false }, async () => [stored], async () => {
    if (unavailable) return { status: 503, data: { error: 'runtime_service_unavailable' } };
    return { observedAt: 1792756800000, employee: { channels: [stored] } };
  });
  await until(() => !!document.querySelector('.connection-list button'));
  await click('查看此连接'); await until(() => text().includes('长连接：已连接'));
  unavailable = true; await click('刷新渠道状态');
  await until(() => text().includes('长连接：状态未知') && !button('刷新渠道状态').disabled);
  assert.ok(text().includes('机器人已验证')); assert.ok(!text().includes('长连接：已停止'));
  assert.ok(!text().includes('运行状态观测时间：')); assert.ok(!text().includes('状态更新时间：'));
  unavailable = false; await click('刷新渠道状态'); await until(() => text().includes('长连接：已连接'));
});

test('runtime channel status rejects another connection or outdated configuration instead of showing online', async t => {
  const stored = connection(); let live = { ...stored, revision: 0 };
  await mount(t, 'settings', { base, canManage: true }, async () => [stored], async () => ({ observedAt: 1792756800000, employee: { channels: [live] } }));
  await until(() => text().includes('长连接：状态未知') && !button('刷新渠道状态').disabled);
  for (const mismatch of [{ id: 'another-connection' }, { appId: 'another-app' }, { provider: 'dingtalk' }, { authRevision: 0 }]) {
    live = { ...stored, ...mismatch }; await click('刷新渠道状态');
    await until(() => !button('刷新渠道状态').disabled);
    assert.ok(text().includes('长连接：状态未知')); assert.ok(!text().includes('长连接：已连接'));
  }
  live = stored; await click('刷新渠道状态'); await until(() => text().includes('长连接：已连接'));
});

test('transport lifecycle is distinct from identity and exposes safe health timestamps without callback UI', async t => {
  let current = connection({ status: 'pending_verification', transport: { state: 'connecting', changedAt: 1792756800000 } });
  await mount(t, 'settings', { base, canManage: true }, async () => [current]);
  await until(() => text().includes('长连接：正在连接'));
  assert.ok(text().includes('等待机器人身份验证'));
  for (const [state, label] of [['connected', '已连接'], ['reconnecting', '正在重连'], ['failed', '连接失败'], ['stopped', '已停止']]) {
    current = connection({ status: 'pending_verification', transport: { state, changedAt: 1792756800000, lastConnectedAt: 1792756700000, lastDisconnectedAt: 1792756750000, ...(state === 'failed' ? { error: 'transport_connect_failed' } : {}) } });
    await click('刷新渠道状态');
    assert.ok(text().includes(`长连接：${label}`)); assert.ok(text().includes('等待机器人身份验证'));
    assert.ok(text().includes('最近连接：')); assert.ok(text().includes('最近断线：'));
    if (state === 'failed') assert.ok(text().includes('transport_connect_failed'));
  }
  await click('连接状态说明');assert.ok(text().includes('连接状态与身份、目录和使用权限分别核验'));await click('连接状态说明');
  assert.ok(text().includes('服务器负责建立长连接')||text().includes('WebSocket')||text().includes('长连接'));
  assert.equal(document.querySelector('[data-testid="callback-path"]'), null);
  for (const obsolete of ['HTTP 回调配置', '复制回调路径', 'Encrypt Key', 'Verification Token', '/api/channel-callbacks/']) assert.equal(text().includes(obsolete), false);
});
test('Feishu needs only app ID and secret; save failure clears write-only secret', async t => {
  const env = await mount(t, 'settings', { base, canManage: true }, async request => request.method === 'GET' ? [] : { status: 400, data: { error: 'fixture_save_failed' } });
  input('渠道应用 ID', 'fixture-app'); await flush(); assert.equal(button('验证并保存渠道连接').disabled, true);
  input('渠道应用密钥', 'fixture-secret'); await flush(); assert.equal(button('验证并保存渠道连接').disabled, false);
  await click('验证并保存渠道连接'); await until(() => text().includes('fixture_save_failed'));
  assert.equal(document.querySelector('input[aria-label="渠道应用密钥"]').value, '');
  assert.equal(env.requests.filter(item => item.method === 'PUT').length, 1);
  assert.deepEqual(env.requests.find(item => item.method === 'PUT').body, { appId: 'fixture-app', appSecret: 'fixture-secret', expectedRevision: 0, replaceSource: false });
});
test('DingTalk submits only supported credentials and switching back clears secrets', async t => {
  const env = await mount(t, 'settings', { base, canManage: true }, async request => request.method === 'GET' ? [] : {});
  input('渠道应用密钥', 'unsent-fixture-secret');
  await providerTab('钉钉');
  assert.equal(document.querySelector('input[aria-label="渠道应用密钥"]').value, '');
  input('渠道应用 ID', 'ding-fixture'); input('渠道应用密钥', 'ding-fixture-secret'); await click('验证并保存渠道连接');
  const saved = env.requests.find(item => item.method === 'PUT'); assert.ok(saved.url.endsWith('/dingtalk')); assert.deepEqual(saved.body, { appId: 'ding-fixture', appSecret: 'ding-fixture-secret', expectedRevision: 0, replaceSource: false });
  input('渠道应用密钥', 'unsent-ding-secret');
  await providerTab('飞书');
  assert.equal(document.querySelector('input[aria-label="渠道应用密钥"]').value, '');
  assert.equal(document.querySelector('input[aria-label="回调加密密钥"]'), null); assert.equal(document.querySelector('input[aria-label="回调校验 Token"]'), null);
});
test('both local guides explain long-connection setup order without HTTP fallback configuration', async () => {
  for (const path of ['apps/web/src/features/channels/setup-guides.ts', 'apps/web/src/features/directory/directory-setup-guide.ts']) {
    const source = await readFile(path, 'utf8');
    for (const required of ['长连接', 'Stream', '已连接后', '控制台保存', '连接上线不等于使用授权已齐全', '不需要平台公网域名']) assert.ok(source.includes(required), `${path}: ${required}`);
    for (const obsolete of ['Encrypt Key', 'Verification Token', '回调路径', 'DENTITY_DINGTALK_TRUSTED_HTTPS_BOUNDARY', '不支持飞书长连接', '不支持钉钉 Stream', '仅支持 HTTP']) assert.equal(source.includes(obsolete), false, `${path}: ${obsolete}`);
  }
});

test('reenabling a disabled channel requires revalidation and does not claim to be connected', async t => {
  let current = connection({ status: 'disabled', enabled: false, transport: { state: 'stopped', changedAt: 1792756800000 } });
  const env = await mount(t, 'settings', { base, canManage: true }, async request => {
    if (request.method === 'GET') return [current];
    current = connection({ revision: 2, status: 'invalid', enabled: true, transport: { state: 'stopped', changedAt: 1792756800000 } }); return current;
  });
  await until(() => text().includes('渠道已停用。启用后请重新验证凭据'));
  await click('启用此渠道'); await until(() => text().includes('已提交启用，请重新验证凭据'));
  assert.ok(text().includes('连接失效')); assert.ok(text().includes('长连接：已停止'));
  assert.deepEqual(env.requests.find(item => item.method === 'PUT').body, { expectedRevision: 1, enabled: true });
});

test('standby transport does not misreport global disconnection or channel disablement', async t => {
  await mount(t, 'settings', { base, canManage: true }, async () => [connection({ transport: { state: 'stopped', changedAt: 1792756800000, error: 'channel_ingress_standby' } })]);
  await until(() => text().includes('长连接：由另一平台进程维护连接'));
  assert.ok(text().includes('此处不推断另一进程的在线状态'));
  assert.equal(text().includes('长连接：已停止'), false);
  assert.equal(text().includes('渠道已停用。启用后'), false);
  assert.equal(text().includes('连接错误：channel_ingress_standby'), false);
  assert.ok(text().includes('机器人已验证')); assert.ok(button('停用此渠道'));
});

const directoryCredential = (overrides = {}) => ({ id: 'directory-fixture', label: '企业目录', corpId: 'fixture-corp', agentId: '10001', revision: 3, credentialRevision: 2, scopeRevision: 'scope-fixture', status: 'verified', lastError: null, lastVerifiedAt: 1792756800000, referenceCount: 1, ...overrides });
async function check(label) { const checkbox = document.querySelector(`[role="checkbox"][aria-label="${label}"]`); assert.ok(checkbox, label); checkbox.click(); await flush(); }
function fillDirectory() { input('目录应用名称', '企业目录'); input('目录 CorpID', 'fixture-corp'); input('目录 AgentId', '10001'); input('目录 AppSecret', 'synthetic-directory-secret'); }

test('WeCom first employee creates separate directory credential and requires explicit same-corp assertion', async t => {
  let credentials = []; const env = await mount(t, 'wecom', { base, disabled: false, connection: connection({ provider: 'wecom', appId: 'fixture-bot', revision: 8 }) }, async request => {
    if (request.method === 'GET') return credentials;
    if (request.method === 'POST') { credentials = [directoryCredential()]; return credentials[0]; }
    return {};
  });
  await until(() => text().includes('尚无可复用目录应用'));
  fillDirectory(); await click('验证并保存目录应用');
  await until(() => !!document.querySelector('[aria-label="确认机器人与目录同企业"]'));
  const created = env.requests.find(item => item.method === 'POST');
  assert.deepEqual(created.body, { label: '企业目录', corpId: 'fixture-corp', agentId: '10001', appSecret: 'synthetic-directory-secret' });
  assert.equal(document.body.innerHTML.includes('synthetic-directory-secret'), false);
  assert.equal(button('确认企业关系并关联本员工').disabled, true);
  await check('确认机器人与目录同企业'); await click('确认企业关系并关联本员工');
  assert.deepEqual(env.requests.find(item => item.method === 'PUT').body, { credentialId: 'directory-fixture', expectedRevision: 8, confirmSameCorp: true });
  await click('同企业确认依据');assert.ok(text().includes('平台无法通过厂商接口证明'));await click('同企业确认依据'); assert.ok(text().includes('本员工使用范围'));
});

test('WeCom reuse cannot bind before saving independent robot and resets assertion when revision changes', async t => {
  const env = await mount(t, 'wecom', { base, disabled: false }, async () => [directoryCredential({ referenceCount: 2 })]);
  await until(() => text().includes('目录可先独立验证并保存'));
  assert.equal(button('确认企业关系并关联本员工').disabled, true);
  assert.equal(env.requests.some(item => item.method !== 'GET'), false);
  env.props.connection = connection({ provider: 'wecom', revision: 2 }); await flush();
  await check('确认机器人与目录同企业'); assert.equal(button('确认企业关系并关联本员工').disabled, false);
  env.props.connection = connection({ provider: 'wecom', revision: 3 }); await flush();
  assert.equal(button('确认企业关系并关联本员工').disabled, true);
});

test('WeCom shared changes require impact preview and explicit approval, reject stale confirmation, clear secrets', async t => {
  const env = await mount(t, 'wecom', { base, disabled: false, connection: connection({ provider: 'wecom' }) }, async request => {
    if (request.url.endsWith('/impact')) return { credentialId: 'directory-fixture', revision: 3, impactRevision: 'impact-v3', employees: [{ entityId: 'employee-a', connectionId: 'connection-a', name: '员工甲' }, { entityId: 'employee-b', connectionId: 'connection-b', name: '员工乙' }] };
    if (request.method === 'PUT') return { status: 409, data: { error: 'directory_impact_changed' } };
    return [directoryCredential({ referenceCount: 2 })];
  });
  await until(() => text().includes('引用员工 2 位'));
  await click('修改共享目录应用 / 轮换密钥'); input('目录 AppSecret', 'synthetic-rotated-secret'); await flush();
  assert.equal(button('确认更新共享目录应用').disabled, true);
  await click('预览受影响员工'); assert.ok(text().includes('员工甲')); assert.ok(text().includes('员工乙'));
  assert.equal(button('确认更新共享目录应用').disabled, true);
  await check('确认共享修改影响'); await click('确认更新共享目录应用');
  await until(() => text().includes('未按旧确认继续修改'));
  const write = env.requests.find(item => item.method === 'PUT'); assert.equal(write.body.expectedRevision, 3); assert.equal(write.body.impactRevision, 'impact-v3');
  assert.equal(document.querySelector('input[aria-label="目录 AppSecret"]').value, '');
  assert.equal(button('确认更新共享目录应用').disabled, true);
});

test('WeCom unlink targets current employee only with current revision', async t => {
  const binding = { credentialId: 'directory-fixture', corpId: 'fixture-corp', agentId: '10001', status: 'confirmed', assertion: { evidence: 'admin_asserted', confirmedAt: 1792756800000 } };
  const env = await mount(t, 'wecom', { base, disabled: false, connection: connection({ provider: 'wecom', revision: 9, directoryBinding: binding }) }, async request => request.method === 'GET' ? [directoryCredential()] : {});
  await until(() => text().includes('当前关联：'));
  await click('仅解除本员工目录关联');
  const deletion = env.requests.find(item => item.method === 'DELETE'); assert.equal(deletion.url, `/api${base}/channels/wecom/directory-binding`); assert.deepEqual(deletion.body, { expectedRevision: 9 });
  assert.ok(text().includes('共享应用及其他员工不受影响'));
});

test('WeCom employee selection keeps unsupported contexts absent and blocks challenge until directory binding', async t => {
  const env = await mount(t, 'settings', { base, canManage: true }, async request => request.url.endsWith('directory-credentials') ? [] : [connection({ provider: 'wecom', appId: 'fixture-bot', status: 'pending_verification', directoryStatus: 'unavailable', identityEvidence: 'app_credentials_only' })]);
  await providerTab('企业微信');
  await until(() => !!document.querySelector('.wecom-directory-binding'));
  assert.ok(text().includes('智能机器人 BotID')); assert.ok(text().includes('启用智能机器人 API 长连接'));
  assert.equal(button('开始机器人身份验证').disabled, true);
  assert.equal(document.querySelector('[aria-label="读取当前群历史"]'), null);
  assert.equal(document.querySelector('[aria-label="明确的 Minutes token"]'), null);
  const allowedReads = new Set([`/api${base}/channels`, `/api${base}/runtime-status`, `/api${base}/channels/wecom/directory-credentials`, `/api${base}/directory-access`]);
  assert.ok(env.requests.every(item => item.method === 'GET' && allowedReads.has(item.url)), 'Only this employee’s channel configuration, runtime observation and WeCom directory choices may be read');
  assert.equal(env.requests.filter(item => item.url === `/api${base}/runtime-status`).length, 1, 'Connection status must be read from the runtime observation endpoint');
});

test('WeCom member reads separate statuses without directory-management endpoints', async t => {
  const env = await mount(t, 'settings', { base, canManage: false }, async () => [connection({ provider: 'wecom', identityEvidence: 'admin_asserted', directoryStatus: 'unavailable' })]);
  await until(()=>!!document.querySelector('.connection-list .n-card button'));document.querySelector('.connection-list .n-card button').click();await flush();await until(() => text().includes('管理员同企业声明（非厂商证明）'));
  assert.ok(text().includes('未关联目录应用'));
  assert.equal(document.querySelector('.wecom-directory-binding'), null);
  const allowedReads = new Set([`/api${base}/channels`, `/api${base}/runtime-status`]);
  assert.ok(env.requests.every(item => item.method === 'GET' && allowedReads.has(item.url)), 'A read-only member must not access directory-management or mutation endpoints');
  assert.equal(env.requests.filter(item => item.url === `/api${base}/runtime-status`).length, 1, 'A member may read the same employee’s runtime observation');
});

test('WeCom directory load resumes after parent refresh and rejects nonnumeric AgentId', async t => {
  const env = await mount(t, 'wecom', { base, disabled: true }, async () => []);
  assert.equal(env.requests.length, 0);
  env.props.disabled = false; await until(() => text().includes('尚无可复用目录应用'));
  fillDirectory(); input('目录 AgentId', 'not-an-agent-id'); await flush();
  assert.equal(button('验证并保存目录应用').disabled, true);
  assert.ok(env.requests.every(item => item.method === 'GET'));
});

test('WeCom saves BotID and robot Secret independently of directory secrets', async t => {
  const env = await mount(t, 'settings', { base, canManage: true }, async request => request.method === 'GET' ? [] : {});
  await providerTab('企业微信');
  await until(() => !!document.querySelector('.wecom-directory-binding'));
  input('渠道应用 ID', 'fixture-independent-bot'); input('渠道应用密钥', 'synthetic-bot-secret'); await click('验证并保存渠道连接');
  const write = env.requests.find(item => item.method === 'PUT');
  assert.equal(write.url, `/api${base}/channels/wecom`);
  assert.deepEqual(write.body, { appId: 'fixture-independent-bot', appSecret: 'synthetic-bot-secret', expectedRevision: 0, replaceSource: false });
  assert.equal(document.querySelector('input[aria-label="渠道应用密钥"]').value, '');
  assert.ok(!('corpId' in write.body) && !('agentId' in write.body));
});

test('WeCom dynamic picker reads only requested directory and disables unsupported meeting rule', async t => {
  const source = connection({ provider: 'wecom' }); let rules = [];
  const env = await mount(t, 'picker', { base, label: '允许', subjects: subjects(source), rules, 'onUpdate:rules': value => { rules = value; env.props.rules = value; } }, async request => {
    assert.equal(request.url, `/api${base}/channels/wecom/directory?kind=departments`);
    return page([department], { provider: 'wecom', appId: source.appId });
  });
  assert.equal(env.requests.length, 0);
  await click('查询当前目录'); await click('选择部门');
  const meeting = [...document.querySelectorAll('[role="checkbox"]')].find(item => item.textContent.includes('企微暂不支持'));
  assert.ok(meeting); assert.ok(meeting.classList.contains('n-checkbox--disabled')); meeting.click(); await flush();
  assert.deepEqual(rules[0].conversationKinds, ['private']);
});

test('wizard embedded instructions preserve official figures, accessible provider tabs and WeCom dual credential fields', async t => {
  const env = await mount(t, 'draft', { base: '/workspaces/workspace-a', disabled: false }, async r => r.url.endsWith('/model-profiles') ? { profiles: [], defaultProfileId: null } : { members: [], resources: [], directoryCredentials: [] });

  for (const provider of ['feishu','dingtalk','wecom']) {
    const tab = document.querySelector(`[role=tab][data-name="${provider}"]`); tab.click(); await flush();
    const current = document.querySelector('.wizard-channel-guide'); assert.ok(current);
    assert.match(current.textContent, /目录|通讯录/); assert.match(current.textContent, /2026-10-24/); assert.match(document.body.textContent, /最后确认创建|最终保存|最终创建/); assert.ok(current.querySelector('.channel-guide-dots button[aria-selected="true"]')); assert.equal(current.querySelectorAll('.slide.is-current').length, 1);
    const consoleLink = current.querySelector('a[aria-label*="官方控制台"]'); assert.ok(consoleLink); assert.equal(new URL(consoleLink.href).protocol, 'https:'); assert.match(consoleLink.rel, /noopener/);
    for (const image of current.querySelectorAll('img')) { assert.match(image.getAttribute('src'), /^\/channel-guides\//); assert.ok(image.alt.length > 15); assert.equal(image.loading, 'lazy'); assert.ok((await readFile('apps/web/public' + image.getAttribute('src'))).length > 100); }
    if (provider === 'feishu') { assert.equal(current.querySelectorAll('.channel-guide-dots button').length, 2); assert.match(current.textContent, /成员姓名/); assert.match(current.textContent, /minutes:minutes.transcript:export/); assert.ok(current.querySelector('details:not([open])')); assert.match(current.textContent, /当前平台不生成/); }
    if (provider === 'dingtalk') { assert.equal(current.querySelectorAll('.channel-guide-dots button').length, 2); assert.match(current.textContent, /发布、审批/); assert.match(current.textContent, /Stream/); }
    if (provider === 'dingtalk') assert.ok([...current.querySelectorAll('img')].some(i => i.getAttribute('src').endsWith('dingtalk-agent-create.svg')));
    if (provider === 'wecom') {
      await channelCard('credentials'); assert.ok(document.querySelector('input[aria-label="Corp ID"]')); assert.ok(document.querySelector('input[aria-label="Agent ID"]')); assert.ok(document.querySelector('input[aria-label="通讯录应用 Secret"]')); assert.match(current.textContent, /管理员声明/);
      await channelCard('optional'); assert.match(current.querySelector('.slide.is-current').textContent, /不支持群历史/);
    }
  }
  const selected = document.querySelector('[role=tab][data-name="wecom"]'); selected.focus(); selected.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  await until(() => document.querySelector('[role=tab][data-name="feishu"]').getAttribute('aria-selected') === 'true');
  assert.equal(env.requests.some(r => r.method !== 'GET'), false, 'reading guide never probes or sends messages');
});

test('wizard expired temporary channel loses readiness and blocks advance without any formal create', async t => {
  const env = await mount(t, 'draft', { base: '/workspaces/workspace-a', disabled: false }, async r => {
    if (r.url.endsWith('/model-profiles')) return { profiles: [], defaultProfileId: null };
    if (r.url.endsWith('/employee-creation-options')) return { members: [], resources: [], directoryCredentials: [] };
    if (r.method === 'DELETE') return { ok: true };
    if (r.url.endsWith('/employee-channel-drafts')) return { draftId: 'expiring-fixture', source: connection(), expiresAt: Date.now() + 200, scope: { departmentCount: 1, userCount: 0, entireOrganization: false } };
    throw new Error('Unexpected fixture request');
  });
   await channelCard('credentials'); input('渠道应用 ID', 'fixture-app'); input('渠道应用 Secret', 'synthetic-fixture-secret');
  await click('验证渠道并读取通讯录'); await until(() => text().includes('渠道草稿已过期'));
  assert.equal(env.events.ready.at(-1), false); assert.equal(env.events.change.at(-1), null); assert.equal(env.requests.some(r => r.url.endsWith('/employee-creations')), false);
});

test('carousel dots and swipes browse freely, preserve fields and keep pending failure success feedback in the validation card', async t => {
  let release, mode = 'held'; const held = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const env = await mount(t, 'draft', { base: '/workspaces/workspace-a', disabled: false }, async r => {
    if (r.url.endsWith('/model-profiles')) return { profiles: [], defaultProfileId: null };
    if (r.url.endsWith('/employee-creation-options')) return { members: [], resources: [], directoryCredentials: [] };
    if (r.method === 'DELETE') return { ok: true };
    if (r.url.endsWith('/employee-channel-drafts')) { if (mode === 'held') await held; if (mode === 'failure') return { status: 400, data: { error: 'channel_directory_unavailable' } }; return { draftId: 'feedback-fixture', source: connection(), expiresAt: Date.now() + 60000, scope: { departmentCount: 1, userCount: 0, entireOrganization: false } }; }
    throw new Error('Unexpected fixture request');
  });
   await channelCard('credentials');
  input('渠道应用 ID', 'fixture-app'); input('渠道应用 Secret', 'synthetic-feedback-secret');
  await channelCard('create'); await channelCard('credentials'); assert.equal(document.querySelector('input[aria-label="渠道应用 ID"]').value, 'fixture-app');
  await click('验证渠道并读取通讯录');
  let feedback = document.querySelector('.channel-verification-feedback'); assert.match(feedback.textContent, /正在分层验证/); assert.ok(feedback.closest('.slide').classList.contains('is-current')); assert.equal(button('验证渠道并读取通讯录').disabled,true);assert.equal(env.events.busy.at(-1),true);
  mode = 'failure'; release(); await until(() => feedback.textContent.includes('没有可用的通讯录读取权限'));
  assert.ok(feedback.querySelector('[role=alert]')); assert.ok(feedback.closest('.slide').classList.contains('is-current'));
  mode = 'success'; await click('验证渠道并读取通讯录'); await until(() => feedback.textContent.includes('渠道草稿已准备'));
  assert.match(feedback.textContent, /实际收发仍待后续验证/); assert.match(feedback.textContent, /最后确认创建才保存/);
  const viewport = document.querySelector('.step-viewport'); viewport.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 300, clientY: 100 })); viewport.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 30, clientY: 105 })); await flush();
  assert.equal(document.querySelector('.channel-guide-dots button[aria-selected=true]').dataset.step, 'validate');
  const dot = document.querySelector('.channel-guide-dots button[aria-selected=true]'); dot.focus(); dot.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })); await flush();
  assert.equal(document.querySelector('.channel-guide-dots button[aria-selected=true]').dataset.step, 'credentials'); assert.equal(document.activeElement.getAttribute('role'), 'tab');
  await channelCard('credentials'); assert.equal(document.querySelector('input[aria-label="渠道应用 Secret"]').value, 'synthetic-feedback-secret');
  assert.equal(env.requests.some(r => r.url.endsWith('/employee-creations')), false);
});

test('editing presents credentials and permissions together without tutorials or carousel', async t => {
  const env = await mount(t, 'settings', { base, canManage: true }, async r => { assert.equal(r.method,'GET'); return []; });
  assert.ok(document.querySelector('.channel-setup .channel-connection-form'));
  assert.equal(document.querySelector('.wizard-channel-guide'),null);
  assert.equal(document.querySelector('.channel-guide-dots'),null);
  assert.equal(document.querySelector('img[src^="/channel-guides/"]'),null);
  assert.ok(document.querySelector('.channel-setup a[href="https://open.feishu.cn/app"]'));
  assert.match(document.querySelector('.setup-requirements').textContent,/通讯录|人员姓名/);
  assert.equal(env.requests.some(r=>r.method!=='GET'),false);
});
