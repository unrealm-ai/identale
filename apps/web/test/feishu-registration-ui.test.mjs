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
const bundle = await mkdtemp(resolve('apps/web/.channel-validation-ui-test-'));
const paths = { registration: 'apps/web/src/features/employees/FeishuRegistration.vue', qrFailure: 'apps/web/src/features/employees/FeishuRegistrationQr.vue' };
const components = {};
for (const [name, path] of Object.entries(paths)) {
  const outfile = join(bundle, `${name}.mjs`);
  await build({ entryPoints: [path], outfile, bundle: true, platform: 'node', format: 'esm', external: ['vue', 'naive-ui'], plugins: [{ name: 'vue-sfc', setup(builder) { builder.onLoad({ filter: /\.vue$/ }, async ({ path }) => { let source = await readFile(path, 'utf8'); if (name === 'qrFailure') source = source.replace("import { NQrCode } from 'naive-ui';", "const NQrCode = { render() { throw new Error('Synthetic QR encoding failure'); } };"); const { descriptor } = parse(source, { filename: path }); return { contents: compileScript(descriptor, { id: path, inlineTemplate: true, fs: { fileExists: existsSync, readFile: file => readFileSync(file, 'utf8') } }).content, loader: 'ts', resolveDir: resolve(path, '..') }; }); } }] });
  components[name] = (await import(pathToFileURL(outfile).href)).default;
}
test.after(async () => { await rm(bundle, { recursive: true, force: true }); await window.happyDOM.close(); });
const text = () => document.body.textContent;
async function flush() { await new Promise(resolve => setTimeout(resolve, 10)); await nextTick(); }
async function until(predicate, description = 'UI settled') { for (let index = 0; index < 100; index++) { await flush(); if (predicate()) return; } assert.fail(`${description}\n${text()}`); }
function visible(el) { for (let node = el; node instanceof HTMLElement; node = node.parentElement) if (node.hidden || node.style.display === 'none' || node.style.visibility === 'hidden' || node.getAttribute('aria-hidden') === 'true') return false; return true; }
function button(label) { const alias={'验证渠道凭据':'检查并继续','验证并保存渠道连接':'保存机器人配置','重新验证已存凭据':'重新连接并检查'};if(alias[label]&&[...document.querySelectorAll('button')].some(b=>visible(b)&&b.textContent.trim()===alias[label]))label=alias[label]; const result = [...document.querySelectorAll('button')].find(item => visible(item) && item.textContent.trim() === label); assert.ok(result, `button ${label}`); return result; }
function input(label, value) { const field = document.querySelector(`input[aria-label="${label}"]`); assert.ok(field, label); field.value = value; field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value })); }
async function click(label) { await nextTick(); button(label).click(); await flush(); }
async function channelCard(id) { const dot=document.querySelector(`.channel-guide-dots button[data-step="${id}"]`); assert.ok(dot); dot.click(); await flush(); }
async function mount(t, name, initial, handler = async () => { throw new Error('Unexpected request'); }) {
  const props = reactive(initial), requests = [];
  globalThis.fetch = async (url, options = {}) => {
    assert.ok(String(url).startsWith('/api/'), 'Only relative local fixture API routes are permitted');
    const request = { url: String(url), method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : undefined };
    requests.push(request); const result = name==='settings'&&request.url.endsWith('/group-sharing')?{revision:0,rules:[]}:name==='settings'&&request.url.endsWith('/group-sharing/status')?{appliedRevision:0}:await handler(request);
    return new Response(JSON.stringify(result?.data ?? result), { status: typeof result?.status === 'number' ? result.status : 200, headers: { 'content-type': 'application/json' } });
  };
  document.body.innerHTML = '<div id="app"></div>';
  const app = createApp({ render: () => h(components[name], props) }); app.mount('#app'); await flush();if(name==='settings'){await until(()=>!!document.querySelector('.connection-list'));const b=[...document.querySelectorAll('.connection-list button')].find(b=>b.textContent.trim()==='查看此连接')??[...document.querySelectorAll('.connection-list button')].find(b=>b.textContent.trim()==='添加渠道连接');if(b){b.click();await flush();}const details=document.querySelector('.channel-guide-toggle');if(details)details.open=true;}if(name==='wizard'){const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='展开渠道、工作能力与自动运行配置');if(b){b.click();await flush();}}
  t.after(() => { app.unmount(); document.body.innerHTML = ''; });
  return { props, requests, app };
}
const base = '/workspaces/synthetic-workspace/entities/synthetic-employee';
const registration = (state, extra = {}) => ({ id: 'synthetic-registration', state, credentialSaved: false, updatedAt: 1, ...extra });
const envelope = (state = null, extra = {}) => ({ registration: state ? registration(state, extra) : null, preset: { name: '合成员工', description: '合成职责预览' }, permissions: { version: 'v1', scopes: ['im:message', 'contact:user.base:readonly'], events: ['im.message.receive_v1'] } });

test('preview is read-only; explicit create shows official confirmation and connected result without exposing secrets', async t => {
  let state = envelope(); const changes = [];
  const env = await mount(t, 'registration', { base, active: true, onChanged: () => changes.push(true) }, async req => {
    if (req.method === 'POST') state = envelope('awaiting_confirmation', { verificationUrl: 'https://open.feishu.cn/app/confirm?code=synthetic', expiresAt: Date.now() + 60000 });
    return state;
  });
  assert.match(text(), /合成员工.*合成职责预览/s); assert.equal(env.requests.filter(r => r.method === 'POST').length, 0);
  await click('创建飞书应用'); assert.match(text(), /等待在飞书确认创建/); assert.ok(document.querySelector('a[href^="https://open.feishu.cn/app/confirm"]'));
  assert.deepEqual(Object.keys(env.requests.find(r => r.method === 'POST').body), ['operationId']);
  state = envelope('connected', { credentialSaved: true, appId: 'cli_synthetic' }); await click('刷新创建状态');
  assert.match(text(), /检查通过，已启用渠道/); assert.equal(changes.length, 1); assert.equal(document.querySelector('input[type="password"]'), null);
  assert.equal(localStorage.length, 0); assert.equal(document.querySelector('a[href*="code=synthetic"]'), null);
});

test('missing permissions persist across reopening and retry uses saved registration only', async t => {
  let state = envelope('needs_attention', { credentialSaved: true, appId: 'cli_synthetic', missingScopes: ['im:message.group_msg'] });
  const env = await mount(t, 'registration', { base, active: true, boundAppId: 'cli_synthetic' }, async req => {
    if (req.method === 'POST') { assert.equal(req.url, `/api${base}/channels/feishu/registration/retry`); assert.deepEqual(req.body, { id: 'synthetic-registration' }); state = envelope('checking', { credentialSaved: true, appId: 'cli_synthetic' }); }
    return state;
  });
  assert.match(text(), /im:message.group_msg/); assert.equal([...document.querySelectorAll('button')].some(x => x.textContent === '创建飞书应用'), false);
  env.props.active = false; await flush(); env.props.active = true; await flush(); assert.match(text(), /im:message.group_msg/);
  await click('重新检查已保存的应用'); assert.match(text(), /正在检查已保存的应用/);
});

test('cancel and expiry clear confirmation links; untrusted URLs are never linked or encoded', async t => {
  let state = envelope('awaiting_confirmation', { verificationUrl: 'https://evil.example/secret' });
  const env = await mount(t, 'registration', { base, active: true }, async req => { if (req.url.endsWith('/cancel')) state = envelope('cancelled'); return state; });
  assert.equal(document.querySelector('a[href*="evil"]'), null); await click('取消等待'); assert.match(text(), /已取消本次等待/);
  state = envelope('expired', { verificationUrl: 'https://open.feishu.cn/app/confirm' }); await click('刷新创建状态'); assert.match(text(), /二维码已过期/); assert.equal(document.querySelector('a[href*="confirm"]'), null);
  assert.ok(env.requests.some(r => r.url.endsWith('/cancel')));
});

test('uncertain starts reuse operationId and duplicate clicks do not issue extra creates', async t => {
  let release; const held = new Promise(resolve => { release = resolve; }); t.after(() => release()); let posts = 0;
  const env = await mount(t, 'registration', { base, active: true }, async req => {
    if (req.method === 'GET') return envelope();
    posts++; if (posts === 1) { await held; throw new Error('Synthetic lost response'); } return envelope('starting');
  });
  button('创建飞书应用').click(); button('创建飞书应用').click(); await flush(); assert.equal(posts, 1);
  release(); await until(() => text().includes('重试同一次创建请求')); await click('重试同一次创建请求');
  const mutations = env.requests.filter(r => r.method === 'POST'); assert.equal(mutations.length, 2); assert.equal(mutations[0].body.operationId, mutations[1].body.operationId);
});

test('late employee responses do not overwrite new preview and hiding preserves server registration', async t => {
  let release; const held = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const nextBase = '/workspaces/synthetic-workspace/entities/next-employee';
  const env = await mount(t, 'registration', { base, active: true }, async req => {
    if (req.url.includes('/next-employee/')) { const result = envelope('awaiting_confirmation', { verificationUrl: 'https://open.feishu.cn/app/confirm' }); result.preset.name = '新员工'; return result; }
    await held; return envelope('connected', { credentialSaved: true });
  });
  env.props.base = nextBase; await until(() => text().includes('新员工')); release(); await flush(); assert.match(text(), /新员工/); assert.doesNotMatch(text(), /检查通过，已启用渠道/);
  env.props.active = false; await flush(); assert.ok(env.requests.every(r => !r.url.endsWith('/cancel')));
  env.props.active = true; await flush(); assert.match(text(), /新员工/); assert.ok(env.requests.filter(r => r.url.includes('/next-employee/')).length >= 2);
});

test('an existing unrelated app cannot create or retry a registration', async t => {
  const env = await mount(t, 'registration', { base, active: true, boundAppId: 'cli_existing' }, async () => envelope('needs_attention', { credentialSaved: true, appId: 'cli_other' }));
  assert.match(text(), /不会创建新应用覆盖现有连接/); assert.equal(document.querySelectorAll('button').length, 0); assert.equal(env.requests.length, 1);
});

test('active pending registration polls state without starting or enabling anything from the browser', async t => {
  let reads = 0;
  const env = await mount(t, 'registration', { base, active: true }, async () => {
    reads++; return envelope(reads === 1 ? 'checking' : 'needs_attention', { credentialSaved: true, appId: 'cli_synthetic', missingScopes: reads > 1 ? ['im:message'] : [] });
  });
  assert.match(text(), /正在检查已保存的应用/); await new Promise(resolve => setTimeout(resolve, 1900)); await until(() => text().includes('检查未通过'));
  assert.ok(env.requests.length >= 2); assert.ok(env.requests.every(r => r.method === 'GET'));
});

test('QR links allow only official account/app HTTPS hosts and standard HTTPS port', async t => {
  let state = envelope('awaiting_confirmation');
  const env = await mount(t, 'registration', { base, active: true }, async () => state);
  for (const [url, accepted] of [
    ['https://accounts.feishu.cn/oauth/confirm?code=synthetic', true],
    ['https://accounts.feishu.cn:443/oauth/confirm?code=synthetic', true],
    ['https://open.feishu.cn/app/confirm', true],
    ['https://accounts.feishu.cn:8443/oauth/confirm', false],
    ['https://user:password@accounts.feishu.cn/oauth/confirm', false],
    ['http://accounts.feishu.cn/oauth/confirm', false],
    ['https://accounts.feishu.cn.evil.example/oauth/confirm', false],
    ['https://unlisted.feishu.cn/oauth/confirm', false],
  ]) {
    state = envelope('awaiting_confirmation', { verificationUrl: url }); await click('刷新创建状态');
    const link = [...document.querySelectorAll('a')].find(a => a.textContent.includes('打开飞书确认页'));
    assert.equal(!!link, accepted, url); if (accepted) assert.equal(link.href, new URL(url).href);
  }
  assert.ok(env.requests.every(r => r.method === 'GET'));
});

test('opening official confirmation and hiding or unmounting never cancels server work', async t => {
  const env = await mount(t, 'registration', { base, active: true }, async () => envelope('awaiting_confirmation', { verificationUrl: 'https://accounts.feishu.cn/oauth/confirm?code=synthetic' }));
  const link = [...document.querySelectorAll('a')].find(a => a.textContent.includes('打开飞书确认页'));
  assert.equal(link.target, '_blank');
  // Avoid navigation in the synthetic DOM, but exercise the actual link click.
  link.addEventListener('click', event => event.preventDefault()); link.click(); await flush();
  t.after(() => { delete document.hidden; });
  Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  document.dispatchEvent(new Event('visibilitychange')); await flush();
  assert.ok(env.requests.every(r => r.method === 'GET'));
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  document.dispatchEvent(new Event('visibilitychange')); await flush();
  assert.equal(env.requests.length, 2);
  env.app.unmount(); await flush(); assert.ok(env.requests.every(r => r.method === 'GET'));
});

test('stopped registrations warn about provider-side creation before offering another create', async t => {
  let state = envelope('cancelled');
  const env = await mount(t, 'registration', { base, active: true }, async () => state);
  for (const status of ['cancelled', 'expired', 'failed', 'interrupted']) {
    state = envelope(status); await click('刷新创建状态');
    assert.match(text(), /停止等待不代表撤销飞书侧操作/); assert.match(text(), /避免重复创建应用/);
  }
  assert.ok(env.requests.every(r => r.method === 'GET'));
});

const autoState = (state = 'needs_attention', extra = {}) => envelope(state, { credentialSaved: true, appId: 'cli_synthetic', autoCheck: { eligible: true, inProgress: false, nextCheckAt: Date.now() }, ...extra });
const groupResult = (id, required, identity, status) => ({ id, label: `服务端权限组 ${id}`, required, identity, scopes: [`synthetic:${id}`], note: '服务端说明', status, missingScopes: status === 'missing' ? [`synthetic:${id}`] : [], scopeStates: [{ scope: `synthetic:${id}`, status }] });

test('approval pending automatically retries saved credentials when due and becomes connected', async t => {
  const env = await mount(t, 'registration', { base, active: true }, async req => req.method === 'GET' ? autoState() : autoState('connected', { autoCheck: { eligible: false, inProgress: false, nextCheckAt: null } }));
  await until(() => text().includes('基础检查通过，已启用渠道'));
  const mutation = env.requests.find(r => r.method === 'POST'); assert.equal(mutation.url, `/api${base}/channels/feishu/registration/retry`);
  assert.deepEqual(mutation.body, { id: 'synthetic-registration', automatic: true });
  assert.equal(env.requests.filter(r => r.method === 'POST').length, 1);
});

test('basic completion and incomplete extension groups have independent authorization status including personal OAuth', async t => {
  await mount(t, 'registration', { base, active: true }, async () => autoState('connected', { permissionGroups: [groupResult('basic', true, 'tenant', 'granted'), groupResult('extension', false, 'tenant', 'missing'), groupResult('personal', false, 'user', 'unknown')], autoCheck: { eligible: false, inProgress: false, nextCheckAt: null } }));
  assert.match(text(), /基础检查通过，已启用渠道/);
  const groups = [...document.querySelectorAll('.registration-permission-group')]; assert.equal(groups.length, 3);
  assert.match(groups[0].textContent, /基础 · 必需.*授权已生效/); assert.match(groups[1].textContent, /扩展 · 独立授权.*授权未齐/);
  assert.match(groups[2].textContent, /个人 OAuth 授权/); assert.match(text(), /授权生效不代表相关业务功能已实现/);
  assert.ok(button('重新检查已保存的应用'));
});

test('inactive and disabled pages issue no automatic requests, resume with GET, and fence late old-employee checks', async t => {
  let release; const held = new Promise(resolve => { release = resolve; }); t.after(() => release()); let hold = false;
  const env = await mount(t, 'registration', { base, active: true }, async req => { if (hold && req.method === 'POST') { await held; return autoState('connected'); } return autoState(); });
  env.props.disabled = true; await flush(); const stopped = env.requests.length;
  await new Promise(resolve => setTimeout(resolve, 650)); assert.equal(env.requests.length, stopped);
  env.props.disabled = false; await flush(); assert.equal(env.requests.at(-1).method, 'GET');
  env.props.active = false; await flush(); const exited = env.requests.length;
  await new Promise(resolve => setTimeout(resolve, 650)); assert.equal(env.requests.length, exited);
  hold = true; env.props.active = true; await until(() => env.requests.some(r => r.method === 'POST'));
  env.props.base = '/workspaces/synthetic-workspace/entities/other'; env.props.disabled = true; await flush(); release(); await flush();
  assert.doesNotMatch(text(), /基础检查通过，已启用渠道/); assert.ok(env.requests.every(r => !r.url.endsWith('/cancel')));
});

test('hidden tabs stop scheduled checks and visible tabs fetch before continuing', async t => {
  t.after(() => { delete document.hidden; });
  const env = await mount(t, 'registration', { base, active: true }, async () => autoState());
  Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange'));
  await new Promise(resolve => setTimeout(resolve, 650)); assert.equal(env.requests.length, 1);
  Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); await flush();
  assert.equal(env.requests[1].method, 'GET'); env.props.active = false; await flush();
  assert.ok(env.requests.every(r => r.method === 'GET'));
});

test('transient read errors recover by GET but forbidden/not-found/session failures halt automatic work', async t => {
  for (const status of [401, 403, 404]) {
    const env = await mount(t, 'registration', { base, active: true }, async () => ({ status, data: { error: 'synthetic_denied' } }));
    await new Promise(resolve => setTimeout(resolve, 2100)); assert.equal(env.requests.length, 1); env.app.unmount();
  }
  let calls = 0;
  const env = await mount(t, 'registration', { base, active: true }, async () => { if (++calls === 1) throw new Error('Synthetic transient failure'); return envelope(); });
  await new Promise(resolve => setTimeout(resolve, 2100)); assert.equal(env.requests.length, 2); assert.ok(env.requests.every(r => r.method === 'GET'));
});

test('two page instances honor server in-progress state without duplicate automatic checks or app creation', async t => {
  let state = autoState('connected', { autoCheck: { eligible: true, inProgress: true, nextCheckAt: null } });
  const env = await mount(t, 'registration', { base, active: true }, async () => state);
  const other = document.createElement('div'); document.body.append(other); const app = createApp({ render: () => h(components.registration, { base, active: true }) }); app.mount(other); t.after(() => app.unmount());
  await new Promise(resolve => setTimeout(resolve, 1900)); assert.ok(env.requests.length >= 4); assert.ok(env.requests.every(r => r.method === 'GET'));
  state = autoState('connected', { autoCheck: { eligible: false, inProgress: false, nextCheckAt: null } });
});

test('branded QR card identifies identale, uses existing logo and 192px QR, and expires reactively', async t => {
  await mount(t, 'registration', { base, active: true }, async () => envelope('awaiting_confirmation', { verificationUrl: 'https://accounts.feishu.cn/confirm', expiresAt: Date.now() + 700 }));
  const card = document.querySelector('[aria-label="identale 发起的飞书应用授权卡片"]'); assert.ok(card);
  assert.match(card.textContent, /identale 发起.*飞书扫码创建应用/s); assert.match(card.textContent, /不是飞书官方页面/);
  assert.equal(card.querySelector('img').getAttribute('src'), '/channel-logos/feishu.png'); assert.ok(card.querySelector('.scan-qr-frame'));
  assert.match(card.querySelector('.n-qr-code').getAttribute('style'), /192px/); assert.ok(card.querySelector('[role="timer"]'));
  await new Promise(resolve => setTimeout(resolve, 1100)); assert.equal(card.querySelector('a'), null); assert.match(card.textContent, /二维码已过期/); assert.ok(card.querySelector('.scan-qr-placeholder'));
});

test('long official URLs keep full data and a usable official link while degrading safely without dense QR', async t => {
  const official = `https://accounts.feishu.cn/confirm?description=${'synthetic'.repeat(400)}`;
  await mount(t, 'registration', { base, active: true }, async () => envelope('awaiting_confirmation', { verificationUrl: official }));
  assert.match(text(), /确认链接较长/); assert.equal(document.querySelector('.n-qr-code'), null);
  assert.equal([...document.querySelectorAll('a')].find(a => a.textContent.includes('打开飞书确认页')).href, official);
  assert.ok(button('取消等待'));
});

test('QR encoder exception is contained and offers fallback instead of breaking the page', async t => {
  await mount(t, 'qrFailure', { value: 'https://accounts.feishu.cn/confirm?synthetic=true' });
  await until(() => text().includes('二维码生成失败')); assert.match(text(), /官方确认链接继续/);
});

test('existing registration displays its requested manifest snapshot instead of the newer creation default', async t => {
  const oldManifest = { version: 'synthetic-v1', scopes: ['synthetic:old'], events: ['synthetic.old_event'], userScopes: [], groups: [{ id: 'old', label: '旧申请组', required: true, identity: 'tenant', scopes: ['synthetic:old'] }] };
  let state = envelope('needs_attention', { credentialSaved: true, requestedPermissions: oldManifest, profileVersion: oldManifest.version });
  state.permissions = { version: 'synthetic-v2', scopes: ['synthetic:new'], events: ['synthetic.new_event'], groups: [{ id: 'new', label: '新版新建组', required: true, identity: 'tenant', scopes: ['synthetic:new'] }] };
  const env = await mount(t, 'registration', { base, active: true }, async () => state);
  assert.match(document.querySelector('.registration-manifest').textContent, /本次申请权限与事件（synthetic-v1）/);
  assert.match(text(), /synthetic:old/); assert.doesNotMatch(text(), /synthetic:new|新版新建组/);
  state = { ...state, registration: registration('cancelled', { requestedPermissions: oldManifest, permissionGroups: [groupResult('old', true, 'tenant', 'missing')] }) };
  await click('刷新创建状态'); assert.match(document.querySelector('.registration-manifest').textContent, /新建时申请权限与事件（synthetic-v2）/);
  assert.match(text(), /synthetic:new/); assert.doesNotMatch(document.querySelector('.registration-permission-groups').textContent, /旧申请组|synthetic:old/);
  assert.ok(env.requests.every(r => r.method === 'GET'));
});

test('missing historical manifest is disclosed without substituting current default scopes', async t => {
  const value = envelope('needs_attention', { credentialSaved: true, permissionGroups: [groupResult('old', true, 'tenant', 'missing')] });
  value.permissions = { version: 'new-default', scopes: ['synthetic:new_default'], events: [] };
  await mount(t, 'registration', { base, active: true }, async () => value);
  assert.match(text(), /本次申请清单暂不可用/); assert.match(text(), /synthetic:old/);
  assert.doesNotMatch(text(), /synthetic:new_default|new-default/); assert.equal(document.querySelector('.registration-manifest'), null);
});

test('medium-length official confirmation URLs keep a larger 320px QR and unchanged fallback link', async t => {
  const official = `https://accounts.feishu.cn/confirm?description=${'synthetic'.repeat(180)}`;
  await mount(t, 'registration', { base, active: true }, async () => envelope('awaiting_confirmation', { verificationUrl: official }));
  const qr = document.querySelector('.n-qr-code'); assert.ok(qr); assert.match(qr.getAttribute('style'), /320px/);
  assert.equal(document.querySelector('.qr-fallback'), null);
  assert.equal([...document.querySelectorAll('a')].find(a => a.textContent.includes('打开飞书确认页')).href, official);
});

test('server approval impact and unverified scope notes are visible without implying personal OAuth or granted access', async t => {
  const group = { ...groupResult('approval_fixture', false, 'tenant', 'unknown'), label: '合成审批扩展', note: '高影响：应用身份可访问企业审批范围；当前相关功能尚未实现。', scopeNotes: { 'synthetic:approval_fixture': '官方 CLI 已声明，本租户与独立接口证据尚未补齐。' } };
  const manifest = { version: 'synthetic-profile', scopes: group.scopes, userScopes: [], events: [], groups: [group] };
  await mount(t, 'registration', { base, active: true }, async () => ({ ...envelope('needs_attention', { credentialSaved: true, requestedPermissions: manifest, permissionGroups: [group] }), permissions: manifest }));
  const details = document.querySelector('.registration-permission-group'); assert.match(details.textContent, /高影响.*企业审批范围.*尚未实现/);
  assert.match(details.querySelector('.scope-evidence-note').textContent, /官方 CLI 已声明.*本租户与独立接口证据尚未补齐/);
  assert.match(details.textContent, /授权待确认/); assert.doesNotMatch(details.textContent, /授权已生效|个人 OAuth/);
  assert.match(text(), /飞书可能忽略未识别权限.*未返回或未知不计为已授权/);
});

test('new all-contact setup discloses its effect and renders outcomes independently of permission grants', async t => {
  const state = envelope('connected', {credentialSaved: true, appId: 'cli_synthetic', contactRange: {status: 'waiting_permission', updatedAt: 1}});
  state.registration.requestedPermissions = {...state.permissions, version: 'conversation-business-v3', contactRange: 'all'};
  const env = await mount(t, 'registration', {base, active: true, boundAppId: 'cli_synthetic'}, async () => state);
  assert.match(text(), /通讯录范围管理权限获批后，系统自动设为全部员工，线上立即生效/);
  assert.match(text(), /等待通讯录范围管理权限获批/);
  for (const [status, pattern] of [
    ['applying', /正在将本次新应用的通讯录范围设为全员/],
    ['applied', /飞书已确认本次新应用的全员通讯录范围设置/],
    ['failed', /全员通讯录范围设置未完成，请检查授权后复查/],
    ['uncertain', /更新结果未确认.*不会自动重复写入/],
    ['skipped', /不再自动修改通讯录范围/],
  ]) {
    state.registration.contactRange.status = status; await click('刷新创建状态');
    assert.match(document.querySelector('[aria-label="通讯录范围设置状态"]').textContent, pattern);
  }
  assert.equal(env.requests.filter(req => req.method === 'POST').length, 0);
});

test('old registration does not inherit the newest profile contact-range promise', async t => {
  const state = envelope('connected', {credentialSaved: true, appId: 'cli_synthetic', requestedPermissions: {version: 'conversation-business-v2', scopes: [], events: []}});
  state.permissions.contactRange = 'all';
  await mount(t, 'registration', {base, active: true, boundAppId: 'cli_synthetic'}, async () => state);
  assert.equal(document.querySelector('[aria-label="通讯录范围设置状态"]'), null);
  assert.doesNotMatch(text(), /系统自动设为全部员工/);
});


test('first view keeps permission groups collapsed and the create action before details', async t => {
  const state = envelope();
  state.permissions = { version: 'synthetic-v3', contactRange: 'all', scopes: ['approval:instance'], events: ['synthetic.event'], groups: [{ id: 'approval', label: '合成审批权限组', required: false, identity: 'tenant', scopes: ['approval:instance'] }] };
  const env = await mount(t, 'registration', { base, active: true, showManualSwitch: true }, async () => state);
  const details = document.querySelector('.registration-details');
  assert.equal(details.open, false);
  assert.ok(document.querySelector('.registration-permission-groups').closest('.registration-details'));
  assert.ok(document.querySelector('.registration-actions').compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING);
  assert.match(document.querySelector('.registration-impact').textContent, /业务资料读写和企业审批操作/);
  assert.equal(button('绑定已有应用').disabled, false);
  assert.equal([...document.querySelectorAll('button')].some(b => b.textContent.trim() === '刷新创建状态'), false);
  assert.ok(env.requests.every(r => r.method === 'GET'));
});

test('manual switch remains locked during requests, uncertain starts, cancellation failure and returned credentials', async t => {
  let state = envelope(), failCancel = true, failStart = false, release;
  const held = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const switches = [];
  const env = await mount(t, 'registration', { base, active: true, showManualSwitch: true, onManualRequested: () => switches.push(true) }, async req => {
    if (req.method === 'POST' && req.url.endsWith('/cancel')) {
      if (failCancel) throw new Error('Synthetic cancellation response lost');
      return state = envelope('cancelled');
    }
    if (req.method === 'POST') {
      await held;
      if (failStart) throw new Error('Synthetic creation response lost');
      return state = envelope('awaiting_confirmation', { verificationUrl: 'https://accounts.feishu.cn/confirm' });
    }
    return state;
  });
  button('创建飞书应用').click(); await flush();
  assert.equal(button('绑定已有应用').disabled, true); button('绑定已有应用').click(); assert.equal(switches.length, 0);
  release(); await until(() => text().includes('等待在飞书确认创建'));
  assert.equal(button('绑定已有应用').disabled, true);
  await click('取消等待'); assert.equal(button('绑定已有应用').disabled, true); assert.match(text(), /无法连接服务或响应格式异常/);
  failCancel = false; await click('取消等待'); assert.equal(button('绑定已有应用').disabled, false);
  assert.match(text(), /停止等待不代表撤销飞书侧操作/);
  failStart = true; await click('创建飞书应用'); assert.equal(button('绑定已有应用').disabled, true);
  await click('刷新创建状态'); assert.equal(button('绑定已有应用').disabled, true, 'an unresolved operation must not unlock the manual path');
  state = envelope('needs_attention', { credentialSaved: true, appId: 'cli_synthetic' });
  await click('刷新创建状态'); assert.equal(button('绑定已有应用').disabled, true);
  assert.equal([...document.querySelectorAll('button')].some(b => b.textContent.trim() === '取消等待'), false);
  assert.equal(switches.length, 0);
});

test('a cancellation racing with saved credentials does not enable manual entry', async t => {
  let state = envelope('awaiting_confirmation', { verificationUrl: 'https://accounts.feishu.cn/confirm' });
  await mount(t, 'registration', { base, active: true, showManualSwitch: true }, async req => req.url.endsWith('/cancel') ? state = envelope('checking', { credentialSaved: true, appId: 'cli_synthetic' }) : state);
  await click('取消等待'); assert.equal(button('绑定已有应用').disabled, true); assert.match(text(), /应用已创建，请继续完成当前连接检查/);
});
