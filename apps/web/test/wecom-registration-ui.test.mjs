import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import { build } from 'esbuild';
import { parse, compileScript } from '@vue/compiler-sfc';

// User-approved popup onboarding UI cases use in-process transport fixtures only.
// No provider, credentials, production database or external side effect is used.
const window = new Window({ url: 'http://127.0.0.1:5173/' });
for (const name of ['window', 'document', 'navigator', 'location', 'history', 'localStorage', 'Node', 'ShadowRoot', 'Document', 'Element', 'HTMLElement', 'SVGElement', 'HTMLDialogElement', 'Event', 'MouseEvent', 'KeyboardEvent', 'PointerEvent', 'FocusEvent', 'InputEvent', 'Image', 'HTMLInputElement', 'HTMLTextAreaElement', 'getComputedStyle', 'MutationObserver', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame']) Object.defineProperty(globalThis, name, { value: name === 'window' ? window : window[name], configurable: true });
const { createApp, h, reactive, nextTick } = await import('vue');
const bundle = await mkdtemp(resolve('apps/web/.wecom-registration-ui-test-'));
const paths = { registration: 'apps/web/src/features/employees/WeComRegistration.vue', settings: 'apps/web/src/features/employees/ChannelConnections.vue' };
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
function button(label) { const result = [...document.querySelectorAll('button')].find(item => visible(item) && item.textContent.trim() === label); assert.ok(result, `button ${label}`); return result; }
function input(label, value) { const field = document.querySelector(`input[aria-label="${label}"]`); assert.ok(field, label); field.value = value; field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value })); }
async function click(label) { await nextTick(); button(label).click(); await flush(); }
async function mount(t, name, initial, handler = async () => { throw new Error('Unexpected request'); }) {
  const props = reactive(initial), requests = [];
  globalThis.fetch = async (url, options = {}) => {
    assert.ok(String(url).startsWith('/api/'), 'Only relative local fixture API routes are permitted');
    const request = { url: String(url), method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : undefined };
    requests.push(request); const result = name==='settings'&&request.url.endsWith('/channels/feishu/registration')?{preset:{name:'Synthetic',description:'Synthetic'},permissions:{version:'synthetic',scopes:[],events:[],groups:[]},registration:null}:name==='settings'&&request.url.endsWith('/group-sharing')?{revision:0,rules:[]}:name==='settings'&&request.url.endsWith('/group-sharing/status')?{appliedRevision:0}:await handler(request);
    return new Response(JSON.stringify(result?.data ?? result), { status: typeof result?.status === 'number' ? result.status : 200, headers: { 'content-type': 'application/json' } });
  };
  document.body.innerHTML = '<div id="app"></div>';
  const app = createApp({ render: () => h(components[name], props) });
  app.mount('#app'); await flush();
  if (name === 'settings') {
    await until(() => !!document.querySelector('.connection-list'));
    const buttons = [...document.querySelectorAll('.connection-list button')];
    const open = buttons.find(button => button.textContent.trim() === '查看此连接') ?? buttons.find(button => button.textContent.trim() === '添加渠道连接');
    if (open) { open.click(); await flush(); }
  }
  t.after(() => { app.unmount(); document.body.innerHTML = ''; });
  return { props, requests, app };
}
const base = '/workspaces/synthetic-workspace/entities/synthetic-employee';
function popupFixture(t, mode) {
  const popups = [], urls = [];
  t.mock.method(window, 'open', url => {
    urls.push(url); if (mode === 'blocked') return null;
    if (mode === 'throw') throw Error('synthetic-hidden-secret');
    const popup = { closed: false, close() { this.closed = true; } }; popups.push(popup); return popup;
  });
  return { popups, urls, receive(popup = popups.at(-1), data = { type: 'AUTH_SUCCESS', payload: { botid: 'synthetic-new-bot', secret: 'synthetic-new-secret' } }) {
    const event = new Event('message'); Object.defineProperties(event, { origin: { value: 'https://work.weixin.qq.com' }, source: { value: popup }, data: { value: data } }); window.dispatchEvent(event);
  } };
}
async function choose(provider) { const tab = [...document.querySelectorAll('[role=tab]')].find(el => el.querySelector('.provider-label') && el.textContent.trim() === provider); assert.ok(tab); tab.click(); await flush(); }
const writes = env => env.requests.filter(r => r.method !== 'GET');
const field = label => document.querySelector(`input[aria-label="${label}"]`);
const existing = { id: 'synthetic-connection', provider: 'wecom', appId: 'synthetic-old-bot', tenantId: 'synthetic-tenant', tenantIdNamespace: 'app_scoped', enabled: true, status: 'pending_verification', revision: 3, directoryStatus: 'unavailable', context: {}, transport: { state: 'stopped', changedAt: 1 } };

test('unbound scan saves once automatically and never reports transport connected from callback', async t => {
  const popup = popupFixture(t); let saved = false;
  const env = await mount(t, 'settings', { base, employeeName: '合成员工', canManage: true, active: true }, async r => {
    if(r.method === 'PUT') { saved = true; return {...existing, appId:'synthetic-new-bot'}; }
    return r.url.endsWith('/channels') ? (saved ? [{...existing, appId:'synthetic-new-bot'}] : []) : {};
  });
  await choose('企业微信'); assert.equal(field('渠道应用 ID'),null); assert.match(text(), /合成员工/);
  await click('扫码创建机器人'); assert.equal(button('绑定已有应用').disabled,true);
  popup.receive(); await until(()=>writes(env).length === 1); popup.receive(); await flush();
  assert.equal(writes(env).length,1); assert.equal(text().includes('synthetic-new-secret'),false);
  assert.deepEqual(writes(env)[0].body,{appId:'synthetic-new-bot', appSecret:'synthetic-new-secret', expectedRevision:0, replaceSource:false});
  assert.match(text(), /长连接：状态未知/);
});

test('failed automatic save retries retained credentials without creating another robot', async t => {
  const popup=popupFixture(t); let count=0;
  const env=await mount(t,'settings',{base,canManage:true},async r=>r.method==='PUT' ? (++count===1 ? {status:503,data:{error:'synthetic_failure'}} : {}) : []);
  await choose('企业微信'); await click('扫码创建机器人'); popup.receive();
  await until(()=>count===1 && !![...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='重试保存机器人配置'));
  await click('重试保存机器人配置'); await until(()=>count===2);
  assert.equal(popup.urls.length,1); assert.deepEqual(writes(env)[0].body,writes(env)[1].body);
});

test('existing connection requires replacement acknowledgment before explicit save', async t => {
  const popup = popupFixture(t), env = await mount(t, 'settings', { base, canManage: true, active: true }, async request => request.method === 'GET' ? [existing] : {});
  await click('扫码创建机器人'); popup.receive(); await flush();
  assert.equal(writes(env).length, 0); assert.equal(button('保存换绑').disabled, true);
  assert.match(text(), /未保存前原绑定继续有效/);
  const checkbox = document.querySelector('[aria-label="确认换绑并重置当前渠道配置"]'); assert.ok(checkbox); checkbox.click(); await flush();
  assert.equal(button('保存换绑').disabled, false); await click('保存换绑'); await until(() => writes(env).length === 1);
  assert.deepEqual(writes(env)[0].body, { appId: 'synthetic-new-bot', appSecret: 'synthetic-new-secret', expectedRevision: 3, replaceSource: true });
});

test('all providers retain manual inputs; unsaved manual credentials prevent popup overwrite', async t => {
  const popup = popupFixture(t), env = await mount(t, 'settings', { base, canManage: true, active: true }, async () => []);
  for (const provider of ['飞书', '钉钉', '企业微信']) {
    await choose(provider);
    if (provider !== '钉钉') { assert.equal(field('渠道应用 ID'), null); await until(() => !button('绑定已有应用').disabled, 'Feishu setup loaded before manual switch'); await click('绑定已有应用'); }
    assert.ok(field('渠道应用 ID')); assert.ok(field('渠道应用密钥'));
    assert.equal(!!document.querySelector('.wecom-registration'), false);
  }
  input('渠道应用 ID', 'synthetic-manual-bot'); input('渠道应用密钥', 'synthetic-manual-secret'); await flush();
  assert.equal(popup.urls.length, 0);
  popup.receive({}); await flush(); assert.equal(field('渠道应用 ID').value, 'synthetic-manual-bot'); assert.equal(field('渠道应用密钥').value, 'synthetic-manual-secret'); assert.equal(writes(env).length, 0);
});

test('component cancels context, permission and unmount changes and does not accept old results', async t => {
  for (const change of ['context', 'disabled', 'unmount']) await t.test(change, async t => {
    const popup = popupFixture(t), received = [], busy = [];
    const env = await mount(t, 'registration', { context: 'synthetic-first', disabled: false, onCredentials: value => received.push(value), onBusyChanged: value => busy.push(value) });
    await click('扫码创建机器人'); const old = popup.popups[0]; assert.equal(busy.at(-1), true);
    if (change === 'unmount') env.app.unmount(); else env.props[change] = change === 'context' ? 'synthetic-second' : true;
    await flush(); popup.receive(old); await flush(); assert.equal(old.closed, true); assert.deepEqual(received, []); assert.equal(busy.at(-1), false);
    if (change === 'context') { await click('扫码创建机器人'); popup.receive(old); assert.equal(received.length, 0); popup.receive(); await flush(); assert.equal(received.length, 1); }
  });
});

test('integrated permission removal, employee switch or hidden pane invalidates pending popup without saving', async t => {
  for (const change of ['canManage', 'base', 'active']) await t.test(change, async t => {
    const popup = popupFixture(t), env = await mount(t, 'settings', { base, canManage: true, active: true }, async () => []);
    await choose('企业微信'); await click('扫码创建机器人'); const old = popup.popups[0];
    env.props[change] = change === 'base' ? `${base}-next` : false; await flush(); popup.receive(old); await flush();
    assert.equal(old.closed, true); assert.equal(writes(env).length, 0); assert.notEqual(field('渠道应用 ID')?.value, 'synthetic-new-bot');
  });
});

test('cancel, blocked and thrown popup errors retain manual fallback without secrets or requests', async t => {
  for (const mode of ['cancel', 'blocked', 'throw']) await t.test(mode, async t => {
    const popup = popupFixture(t, mode), env = await mount(t, 'settings', { base, canManage: true, active: true }, async () => []);
    await choose('企业微信'); await click('扫码创建机器人');
    if (mode === 'cancel') { await click('取消扫码'); popup.receive(); await flush(); }
    await click('绑定已有应用'); assert.equal(field('渠道应用 ID').disabled, false); assert.equal(field('渠道应用 ID').value, ''); assert.equal(writes(env).length, 0);
    assert.equal(text().includes('synthetic-hidden-secret'), false); assert.ok(field('渠道应用密钥'));
  });
});


test('omitted active defaults to enabled and EmployeeSettings binds actual channels tab activity', async t => {
  const source = await readFile('apps/web/src/features/employees/EmployeeSettings.vue', 'utf8');
  assert.match(source, /<ChannelConnections[^>]*:active="tab==='channels'"/);
  const popup = popupFixture(t), env = await mount(t, 'settings', { base, canManage: true }, async () => []);
  await choose('企业微信'); assert.equal(button('扫码创建机器人').disabled, false);
  await click('扫码创建机器人'); assert.equal(popup.popups.length, 1);
  await click('取消扫码'); assert.equal(popup.popups[0].closed, true); assert.equal(writes(env).length, 0);
});
