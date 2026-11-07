import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import { build } from 'esbuild';
import { parse, compileScript } from '@vue/compiler-sfc';
import { createServer } from '../../control-plane/dist/server.js';

const window = new Window({ url: 'http://127.0.0.1:15173/' });
for (const name of ['window', 'document', 'navigator', 'location', 'history', 'localStorage', 'Node', 'ShadowRoot', 'Document', 'Element', 'HTMLElement', 'SVGElement', 'HTMLDialogElement', 'Event', 'MouseEvent', 'KeyboardEvent', 'PointerEvent', 'FocusEvent', 'InputEvent', 'Image', 'HTMLInputElement', 'HTMLTextAreaElement', 'getComputedStyle', 'MutationObserver', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame']) Object.defineProperty(globalThis, name, { value: name === 'window' ? window : window[name], configurable: true });
const { createApp, nextTick } = await import('vue');
const bundleDir = await mkdtemp(resolve('apps/web/.ui-test-'));
await build({ entryPoints: ['apps/web/src/App.vue'], outfile: join(bundleDir, 'App.mjs'), bundle: true, platform: 'node', format: 'esm', external: ['vue', 'naive-ui'], plugins: [{ name: 'vue-sfc', setup(builder) {
  builder.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
    const { descriptor } = parse(await readFile(path, 'utf8'), { filename: path });
    return { contents: compileScript(descriptor, { id: path, inlineTemplate: true, fs: { fileExists: existsSync, readFile: file => readFileSync(file, 'utf8') } }).content, loader: 'ts', resolveDir: resolve(path, '..') };
  });
} }] });
const App = (await import(pathToFileURL(join(bundleDir, 'App.mjs')).href)).default;
test.after(async () => { await rm(bundleDir, { recursive: true, force: true }); await window.happyDOM.close(); });
async function flush() { await new Promise(resolve => setTimeout(resolve, 20)); await nextTick(); }
async function until(predicate) { for (let i = 0; i < 100; i++) { await flush(); if (predicate()) return; } assert.fail('UI did not settle'); }
async function settings(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dentity-settings-qa-'));
  const server = createServer({ databasePath: join(dir, 'qa.sqlite'), origin: 'http://127.0.0.1:15173' }); await server.ready();
  const register = await server.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'settings-qa-owner', password: 'qa-only-password' }, headers: { origin: 'http://127.0.0.1:15173' } });
  assert.equal(register.statusCode, 201);
  const cookie = register.headers['set-cookie'].split(';')[0], workspace = register.json().workspace;
  const call = (method, url, payload) => server.inject({ method, url, ...(payload === undefined ? {} : { payload }), headers: { cookie, origin: 'http://127.0.0.1:15173' } });
  const entity = (await call('POST', `/api/workspaces/${workspace.id}/entities`, { name: '设置键盘验证', ownWebUse: true })).json().entity;
  const previousFetch = globalThis.fetch;
  // Real Fastify/SQLite transport, following the existing approved DOM test harness.
  globalThis.fetch = async (url, options = {}) => {
    assert.ok(String(url).startsWith('/api/'), 'No external request in this fixture');
    const response = await call(options.method ?? 'GET', String(url), options.body ? JSON.parse(options.body) : undefined);
    return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
  };
  document.body.innerHTML = '<div id="app"></div>';
  history.replaceState(null, '', `/?ws=${workspace.id}&view=settings&entity=${entity.id}`);
  const app = createApp(App); app.mount('#app');
  t.after(async () => { app.unmount(); globalThis.fetch = previousFetch; document.body.innerHTML = ''; localStorage.clear(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  await until(() => !!document.querySelector('.employee-settings [role=tab]'));
  return { server };
}
const tabs = () => [...document.querySelectorAll('.employee-settings [role=tablist][aria-label="员工设置分类"] [role=tab]')];
async function key(value) { document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true })); await flush(); }
test('settings keyboard order follows all seven visible tabs in both directions and Home/End', async t => {
  await settings(t);
  const labels=['概览','对话','任务','能力包','渠道','触发器','模型'];
  assert.deepEqual(tabs().map(tab => tab.textContent.trim()),labels);
  tabs()[0].focus();
  async function selected(index){await until(()=>tabs()[index].getAttribute('aria-selected')==='true');assert.equal(document.activeElement,tabs()[index]);const panel=document.getElementById(tabs()[index].getAttribute('aria-controls'));assert.ok(panel,'selected tab has an actual panel');assert.equal(panel.getAttribute('aria-labelledby'),tabs()[index].id);}
  for (const index of [1,2,3,4,5,6,0]) { await until(()=>tabs()[0].getAttribute('aria-disabled')!=='true');await key('ArrowRight');await selected(index); }
  for (const index of [6,5,4,3,2,1,0]) { await until(()=>tabs()[0].getAttribute('aria-disabled')!=='true');await key('ArrowLeft');await selected(index); }
  await key('End');await selected(6);
  await key('Home');await selected(0);
});
test('identale brand and consistent account footer keep real employee editing reachable', async t => {
  await settings(t);
  const footer=document.querySelector('footer[aria-label="项目来源与许可"]');assert.ok(footer);
  assert.deepEqual([...footer.querySelectorAll('.source-attribution__line a')].map(link=>[link.textContent.trim(),link.getAttribute('href')]),[
    ['identale','https://github.com/unrealm-ai/identale'],
    ['Apache-2.0','https://www.apache.org/licenses/LICENSE-2.0'],
  ]);
  const disclosure=footer.querySelector('details');assert.ok(disclosure);assert.equal(disclosure.open,false);
  assert.equal(disclosure.querySelector('summary').textContent.trim(),'许可说明');
  assert.match(disclosure.textContent,/NOTICE 和 THIRD_PARTY_NOTICES\.md/);
  assert.ok(document.querySelector('.brand [role="img"][aria-label="identale"]'));
  const account=document.querySelector('.app-nav-footer [aria-label="我的账号"]');assert.ok(account);assert.ok(account.querySelector('.n-avatar'));
  assert.ok(document.querySelector('.employee-settings .page-heading h1'));
  assert.ok(tabs().some(tab=>tab.textContent.trim()==='模型'));
  const edit=[...document.querySelectorAll('.employee-object-header button')].find(button=>button.textContent.trim()==='编辑资料');assert.ok(edit);edit.click();
  await until(()=>!!document.querySelector('input[aria-label="员工名称"]'));
  assert.doesNotMatch(document.body.textContent,/原子保存|事务落库|独立 pi Runtime Host|真实租户收发需单独验收/);
});
// Actual geometry, ResizeObserver and page-scroll behavior are verified in a local
// browser; happy-dom has no layout, so this file does not fake size measurements.


test('collapsed confirmation draft keeps application navigation and beforeunload protected until discard',async t=>{
  await settings(t);
  function button(label){const el=[...document.querySelectorAll('button')].find(el=>el.textContent.trim()===label||el.getAttribute('aria-label')===label);assert.ok(el,label);return el;}
  await until(()=>[...document.querySelectorAll('button')].some(el=>el.textContent.trim()==='人工确认'));
  button('人工确认').click();await until(()=>!button('添加确认规则').disabled);
  button('添加确认规则').click();await until(()=>!!document.querySelector('input[aria-label="确认问题范围"]'));
  const field=document.querySelector('input[aria-label="确认问题范围"]');field.value='折叠中的草稿';field.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:field.value}));await flush();
  button('人工确认').click();await flush();
  assert.equal(document.querySelector('.human-settings').style.display,'none');
  assert.equal(button('工作区选择与管理').disabled,true);
  assert.equal(document.querySelector('.app-nav .rail-brand').tagName,'SPAN');
  assert.ok(document.querySelector('.employee-dirty-banner'));
  const before=new Event('beforeunload',{cancelable:true});window.dispatchEvent(before);assert.equal(before.defaultPrevented,true);
  button('人工确认').click();await flush();assert.equal(document.querySelector('input[aria-label="确认问题范围"]').value,'折叠中的草稿');
  button('放弃更改').click();await until(()=>!button('工作区选择与管理').disabled);
  assert.equal(document.querySelector('input[aria-label="确认问题范围"]'),null);
  assert.equal(document.querySelector('.app-nav .rail-brand').tagName,'A');
  const after=new Event('beforeunload',{cancelable:true});window.dispatchEvent(after);assert.equal(after.defaultPrevented,false);
});
