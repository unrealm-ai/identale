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
const bundle = await mkdtemp(resolve('apps/web/.dingtalk-registration-ui-test-'));
const paths = { settings: 'apps/web/src/features/employees/ChannelConnections.vue' };
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
    requests.push(request); const result = name==='settings'&&request.url.endsWith('/group-sharing')?{revision:0,rules:[]}:name==='settings'&&request.url.endsWith('/group-sharing/status')?{appliedRevision:0}:await handler(request, options);
    return new Response(JSON.stringify(result?.data ?? result), { status: typeof result?.status === 'number' ? result.status : 200, headers: { 'content-type': 'application/json' } });
  };
  document.body.innerHTML = '<div id="app"></div>';
  const app = createApp({ render: () => h(components[name], props) }); app.mount('#app'); await flush();if(name==='settings'){await until(()=>!!document.querySelector('.connection-list'));const b=[...document.querySelectorAll('.connection-list button')].find(b=>b.textContent.trim()==='查看此连接')??[...document.querySelectorAll('.connection-list button')].find(b=>b.textContent.trim()==='添加渠道连接');if(b){b.click();await flush();}const details=document.querySelector('.channel-guide-toggle');if(details)details.open=true;}if(name==='wizard'){const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='展开渠道、工作能力与自动运行配置');if(b){b.click();await flush();}}
  t.after(() => { app.unmount(); document.body.innerHTML = ''; });
  return { props, requests, app };
}
const base = '/workspaces/synthetic-workspace/employees/synthetic-employee';
const registrationPath = `/api${base}/channels/dingtalk/registration`;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const session = (id, status='waiting', more={}) => ({sessionId:id,status,expiresAt:Date.now()+60000,pollAfterMs:1000,...(status==='waiting'?{verificationUrl:'https://open-dev.dingtalk.com/synthetic-verification'}:{}),...(status==='ready'?{clientId:'synthetic-new-app'}:{}),...more});
const connection = (revision=1, appId='synthetic-old-app') => ({id:'synthetic-connection',sourceId:'synthetic-source',provider:'dingtalk',appId,revision,authRevision:1,enabled:true,status:'pending_verification',tenantIdNamespace:'app_scoped',tenantId:appId,identityEvidence:'app_credentials_only',directoryStatus:'unavailable',transport:{state:'stopped',changedAt:1}});
async function choose(label) { const tab=[...document.querySelectorAll('[role=tab]')].find(el=>el.querySelector('.provider-label')&&el.textContent.trim()===label);assert.ok(tab,label);tab.click();await flush(); }
async function setup(t, handler, extra={}) {
  const env=await mount(t,'settings',{base,canManage:true,...extra}, async (request, options)=> {
    if(request.url.endsWith('/runtime-status'))return {observedAt:null,employee:null};
    if(request.url.endsWith('/channels') && request.method==='GET')return [];
    return handler(request,options);
  });
  await choose('钉钉'); return env;
}
async function openStart(){await click('扫码创建新机器人');await click('开始扫码创建');}

test('scan is opt-in, unavailable source explains fallback and all manual channel inputs remain',async t=>{
 const env=await setup(t,async request=>{assert.equal(request.method,'GET');return {available:false,reason:'source_unconfigured'};});
 assert.equal(env.requests.some(r=>r.url.includes('/registration')),false);
 await click('扫码创建新机器人');assert.ok(text().includes('尚未配置已登记'));assert.equal(document.querySelectorAll('.dingtalk-registration .n-qr-code svg').length,0);
 for(const label of ['飞书','钉钉','企业微信']) {await choose(label);assert.ok(document.querySelector('input[aria-label="渠道应用 ID"]'));assert.ok(document.querySelector('input[aria-label="渠道应用密钥"]'));}
 assert.equal(env.requests.filter(r=>r.method==='POST').length,0);
});

test('waiting locally renders QR; ready does not bind until explicit confirmation, no browser secret',async t=>{
 let id;const changes=[];
 const env=await setup(t,async request=>{
  if(request.method==='GET')return {available:true};
  if(request.url.endsWith('/start')){id=request.body.sessionId;assert.equal(request.body.expectedRevision,0);return session(id);}
  if(request.url.endsWith('/poll'))return session(id,'ready');
  if(request.url.endsWith('/bind')){assert.deepEqual(request.body,{replaceSource:false});return connection(1,'synthetic-new-app');}
  if(request.method==='DELETE')return {status:'cancelled'};
  throw Error(request.url);
 },{onChanged:()=>changes.push(true)});
 await openStart(); assert.ok(document.querySelector('.dingtalk-registration .n-qr-code svg'));assert.equal(document.querySelector('.dingtalk-registration a').rel,'noopener noreferrer');
 await until(()=>text().includes('尚未绑定'),'poll ready');assert.equal(env.requests.filter(r=>r.url.endsWith('/bind')).length,0);
 assert.equal(document.querySelector('input[aria-label="渠道应用密钥"]').value,'');
 await click('确认绑定到当前员工');await until(()=>changes.length===1);
 assert.equal(env.requests.filter(r=>r.url.endsWith('/bind')).length,1);
 assert.ok(!JSON.stringify(env.requests).includes('appSecret'));assert.ok(!text().includes('device_code'));
});

test('double start click is single flight and close fences a pending start; late response cannot revive UI',async t=>{
 const pending=deferred();let signal;const env=await setup(t,async (request,options)=>{
  if(request.method==='GET')return {available:true};
  if(request.url.endsWith('/start')){signal=options.signal;return pending.promise;}
  if(request.method==='DELETE')return {status:'cancelled'};
 });
 await click('扫码创建新机器人');button('开始扫码创建').click();button('开始扫码创建').click();await flush();
 assert.equal(env.requests.filter(r=>r.url.endsWith('/start')).length,1);
 const id=env.requests.find(r=>r.url.endsWith('/start')).body.sessionId;
 await click('关闭扫码');assert.equal(signal.aborted,true);assert.ok(env.requests.some(r=>r.method==='DELETE'&&r.url.endsWith(id)));
 pending.resolve(session(id,'ready'));await flush();assert.ok(!text().includes('尚未绑定'));assert.equal(button('扫码创建新机器人').disabled,false);
});

for(const change of ['close','provider','base','unmount'])test(`pending poll is cancelled on ${change} and late ready cannot bind`,async t=>{
 const pending=deferred();let pollSignal;let id;
 const env=await setup(t,async(request,options)=>{
  if(request.method==='GET')return {available:true};
  if(request.url.endsWith('/start')){id=request.body.sessionId;return session(id);}
  if(request.url.endsWith('/poll')){pollSignal=options.signal;return pending.promise;}
  if(request.method==='DELETE')return {status:'cancelled'};
 });
 await openStart();await until(()=>pollSignal,'poll begun');
 if(change==='close')await click('关闭扫码');
 if(change==='provider')await choose('企业微信');
 if(change==='base'){env.props.base='/workspaces/synthetic-workspace/employees/other';await flush();}
 if(change==='unmount')env.app.unmount();
 assert.equal(pollSignal.aborted,true);assert.ok(env.requests.some(r=>r.method==='DELETE'&&r.url===`${registrationPath}/${id}`));
 pending.resolve(session(id,'ready'));await flush();assert.equal(env.requests.filter(r=>r.url.endsWith('/bind')).length,0);assert.ok(!text().includes('尚未绑定'));
});

test('expiry clears QR and failure displays safe fixed fallback, never provider message',async t=>{
 let id;let attempt=0;
 const env=await setup(t,async request=>{
  if(request.method==='GET')return {available:true};
  if(request.url.endsWith('/start')){id=request.body.sessionId;return ++attempt===1?session(id,'waiting',{expiresAt:Date.now()+80}):session(id,'failed',{error:'synthetic-private-sentinel'});}
  if(request.method==='DELETE')return {status:'cancelled'};
 });
 await openStart();await until(()=>text().includes('扫码会话已过期'));assert.equal(document.querySelector('.dingtalk-registration .n-qr-code svg'),null);
 await click('重新检查扫码配置');await click('开始扫码创建');assert.ok(text().includes('扫码注册未完成'));assert.ok(!text().includes('synthetic-private-sentinel'));
 assert.equal(env.requests.filter(r=>r.url.endsWith('/bind')).length,0);
});

test('a refreshed binding revision invalidates a ready registration without overwriting manual draft',async t=>{
 let channels=[];let id;
 const env=await mount(t,'settings',{base,canManage:true},async request=>{
  if(request.url.endsWith('/channels'))return channels;
  if(request.url.endsWith('/runtime-status'))return {employee:null};
  if(request.url.endsWith('/registration'))return {available:true};
  if(request.url.endsWith('/start')){id=request.body.sessionId;return session(id,'ready');}
  if(request.method==='DELETE')return {status:'cancelled'};
 });
 await choose('钉钉');await openStart();channels=[connection(2)];await click('刷新渠道状态');
 assert.ok(!text().includes('尚未绑定'));assert.ok(env.requests.some(r=>r.method==='DELETE'));
 assert.equal(document.querySelector('input[aria-label="渠道应用 ID"]').value,'synthetic-old-app');
});

test('ready replacement requires explicit reset checkbox',async t=>{
 let id;
 const env=await mount(t,'settings',{base,canManage:true},async request=>{
  if(request.url.endsWith('/channels'))return [connection(3)];
  if(request.url.endsWith('/runtime-status'))return {employee:null};
  if(request.url.endsWith('/registration'))return {available:true};
  if(request.url.endsWith('/access'))return {};
  if(request.url.endsWith('/start')){id=request.body.sessionId;assert.equal(request.body.expectedRevision,3);return session(id,'ready');}
  if(request.url.endsWith('/bind')){assert.deepEqual(request.body,{replaceSource:true});return connection(4,'synthetic-new-app');}
  if(request.method==='DELETE')return {status:'cancelled'};
  return {};
 });
 await openStart();assert.equal(button('确认绑定到当前员工').disabled,true);assert.ok(text().includes('可能扩大授权'));
 const checkbox=document.querySelector('[aria-label="确认扫码换绑并重置当前渠道配置"]');assert.ok(checkbox);checkbox.click();await flush();
 assert.equal(button('确认绑定到当前员工').disabled,false);await click('确认绑定到当前员工');assert.equal(env.requests.filter(r=>r.url.endsWith('/bind')).length,1);
});

test('hidden document pauses polling and visible document resumes it',async t=>{
 let id;const env=await setup(t,async request=>{
  if(request.method==='GET')return {available:true};
  if(request.url.endsWith('/start')){id=request.body.sessionId;return session(id);}
  if(request.url.endsWith('/poll'))return session(id,'ready');
  if(request.method==='DELETE')return {status:'cancelled'};
 });
 Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});
 t.after(()=>{delete document.visibilityState;});
 await openStart();await new Promise(r=>setTimeout(r,1100));assert.equal(env.requests.filter(r=>r.url.endsWith('/poll')).length,0);
 Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});document.dispatchEvent(new Event('visibilitychange'));
 await until(()=>text().includes('尚未绑定'));assert.equal(env.requests.filter(r=>r.url.endsWith('/poll')).length,1);
});

test('late bind after employee switch cannot emit changed or clear the new manual secret',async t=>{
 const pending=deferred();let id;let bindSignal;const changes=[];
 const env=await setup(t,async (request,options)=>{
  if(request.method==='GET')return {available:true};
  if(request.url.endsWith('/start')){id=request.body.sessionId;return session(id,'ready');}
  if(request.url.endsWith('/bind')){bindSignal=options.signal;return pending.promise;}
  if(request.method==='DELETE')return {status:'cancelled'};
 },{onChanged:()=>changes.push(true)});
 await openStart();await click('确认绑定到当前员工');
 env.props.base='/workspaces/synthetic-workspace/employees/next';await flush();
 input('渠道应用 ID','synthetic-next-app');input('渠道应用密钥','synthetic-next-secret');await flush();
 pending.resolve(connection());await flush();assert.equal(bindSignal.aborted,true);assert.equal(changes.length,0);
 assert.equal(document.querySelector('input[aria-label="渠道应用密钥"]').value,'synthetic-next-secret');
});

test('manual credential draft remains editable and intact while a scan waits and closes',async t=>{
 let id;const env=await setup(t,async request=>{
  if(request.method==='GET')return {available:true};
  if(request.url.endsWith('/start')){id=request.body.sessionId;return session(id);}
  if(request.method==='DELETE')return {status:'cancelled'};
 });
 await openStart();input('渠道应用 ID','synthetic-manual-app');input('渠道应用密钥','synthetic-manual-secret');await flush();
 assert.equal(button('验证并保存渠道连接').disabled,false);
 await click('关闭扫码');assert.equal(document.querySelector('input[aria-label="渠道应用密钥"]').value,'synthetic-manual-secret');
 assert.equal(env.requests.filter(r=>r.url.endsWith('/bind')).length,0);
});

test('poll HTTP failure removes the QR, hides raw errors and requires an explicit restart',async t=>{
 let id;const env=await setup(t,async request=>{
  if(request.method==='GET')return {available:true};
  if(request.url.endsWith('/start')){id=request.body.sessionId;return session(id);}
  if(request.url.endsWith('/poll'))return {status:502,data:{error:'synthetic-private-provider-response'}};
  if(request.method==='DELETE')return {status:'cancelled'};
 });
 await openStart();await until(()=>text().includes('扫码注册未完成'));
 assert.equal(document.querySelector('.dingtalk-registration .n-qr-code svg'),null);
 assert.ok(!text().includes('synthetic-private-provider-response'));
 await new Promise(r=>setTimeout(r,1100));assert.equal(env.requests.filter(r=>r.url.endsWith('/poll')).length,1);
});

for (const restoredStatus of ['waiting','ready']) test(`capability restores same-scope ${restoredStatus} without a new start and requires explicit bind`,async t=>{
 const id=crypto.randomUUID();
 const env=await setup(t,async request=>{
  if(request.method==='GET')return {available:true,session:session(id,restoredStatus)};
  if(request.url.endsWith('/poll')){assert.equal(request.url,`${registrationPath}/${id}/poll`);return session(id,'ready');}
  if(request.url.endsWith('/bind')){assert.equal(request.url,`${registrationPath}/${id}/bind`);return connection(1,'synthetic-new-app');}
  if(request.method==='DELETE')return {status:'cancelled'};
  throw Error(`Unexpected request ${request.url}`);
 });
 await click('扫码创建新机器人');
 if(restoredStatus==='waiting') assert.ok(document.querySelector('.dingtalk-registration .n-qr-code svg'));
 await until(()=>text().includes('尚未绑定'));
 assert.equal(env.requests.filter(r=>r.url.endsWith('/start')).length,0);
 assert.equal(env.requests.filter(r=>r.url.endsWith('/bind')).length,0);
 await click('确认绑定到当前员工');
 assert.equal(env.requests.filter(r=>r.url.endsWith('/bind')).length,1);
});

for (const phase of ['start','poll']) test(`pagehide sends same-origin keepalive DELETE and ignores late ${phase}`,async t=>{
 const pending=deferred();let id;let signal;let cleanupOptions;
 const env=await setup(t,async (request,options)=>{
  if(request.method==='GET')return {available:true};
  if(request.url.endsWith('/start')){id=request.body.sessionId;if(phase==='start'){signal=options.signal;return pending.promise;}return session(id);}
  if(request.url.endsWith('/poll')){signal=options.signal;return pending.promise;}
  if(request.method==='DELETE'){cleanupOptions=options;return {status:'cancelled'};}
 });
 await openStart();await until(()=>signal);
 window.dispatchEvent(new Event('pagehide'));await flush();
 assert.equal(signal.aborted,true);assert.equal(cleanupOptions.keepalive,true);assert.equal(cleanupOptions.credentials,'same-origin');
 assert.equal(cleanupOptions.headers['Content-Type'],'application/json');assert.equal(cleanupOptions.body,'{}');assert.equal(cleanupOptions.signal,undefined);
 assert.equal(env.requests.find(r=>r.method==='DELETE').url,`${registrationPath}/${id}`);
 pending.resolve(session(id,'ready'));await flush();assert.ok(!text().includes('尚未绑定'));
 assert.equal(env.requests.filter(r=>r.url.endsWith('/bind')).length,0);
});

for (const verificationUrl of ['https://dingtalk.com.attacker.example/verify','http://open-dev.dingtalk.com/verify','https://user:pass@open-dev.dingtalk.com/verify']) test(`unsafe restored verification link is rejected: ${verificationUrl}`,async t=>{
 const env=await setup(t,async request=>request.method==='GET'?{available:true,session:session(crypto.randomUUID(),'waiting',{verificationUrl})}:{status:'cancelled'});
 await click('扫码创建新机器人');assert.ok(text().includes('扫码注册未完成'));
 assert.equal(document.querySelector('.dingtalk-registration a'),null);
 assert.equal(document.querySelector('.dingtalk-registration .n-qr-code svg'),null);
 assert.equal(env.requests.filter(r=>r.method==='POST').length,0);
});
