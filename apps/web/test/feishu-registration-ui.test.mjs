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
const paths = { registration: 'apps/web/src/features/employees/FeishuRegistration.vue' };
const components = {};
for (const [name, path] of Object.entries(paths)) {
  const outfile = join(bundle, `${name}.mjs`);
  await build({ entryPoints: [path], outfile, bundle: true, platform: 'node', format: 'esm', external: ['vue', 'naive-ui'], plugins: [{ name: 'vue-sfc', setup(builder) { builder.onLoad({ filter: /\.vue$/ }, async ({ path }) => { const { descriptor } = parse(await readFile(path, 'utf8'), { filename: path }); return { contents: compileScript(descriptor, { id: path, inlineTemplate: true, fs: { fileExists: existsSync, readFile: file => readFileSync(file, 'utf8') } }).content, loader: 'ts', resolveDir: resolve(path, '..') }; }); } }] });
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
