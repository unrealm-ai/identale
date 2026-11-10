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
const paths = { report: 'apps/web/src/features/employees/ChannelValidationReport.vue', permissions: 'apps/web/src/features/employees/ChannelPermissionBlocks.vue', draft: 'apps/web/src/features/employees/WizardChannelDraft.vue', guide: 'apps/web/src/features/employees/WizardChannelGuide.vue', settings: 'apps/web/src/features/employees/ChannelConnections.vue' };
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
const report = (provider='feishu', canContinue=true) => ({version:1,provider,checkedAt:Date.now(),canContinue,checks:[
  {id:'credentials',required:true,supported:true,status:'pass'},
  {id:'directory_identity',required:true,supported:true,status:'pass'},
  {id:'directory_scope',required:true,supported:true,status:'pass'},
  {id:'user_name',required:true,supported:true,status:canContinue?'pass':'unverified',...(canContinue?{}:{reason:'parse'})},
  {id:'scope_inventory',required:false,supported:provider==='feishu',status:provider==='feishu'?'pass':'unverified',...(provider==='feishu'?{}:{reason:'inventory_unavailable'})},
  {id:'group_history',required:false,supported:provider==='feishu',status:provider==='feishu'?'missing':'unsupported',reason:provider==='feishu'?'denied':'adapter_unsupported',...(provider==='feishu'?{missingScopes:['im:message.group_msg']}:{})},
]});
const result=(provider='feishu')=>({draftId:'synthetic-channel-draft',expiresAt:Date.now()+60_000,source:{provider,botId:'synthetic-bot-open-id',status:'pending_verification',validation:report(provider)},scope:{departmentCount:1,userCount:1,entireOrganization:false}});
const base='/workspaces/synthetic-workspace';
async function choose(provider){const tab=[...document.querySelectorAll('[role=tab]')].find(el=>el.querySelector('.provider-label')&&el.textContent.trim()===provider);assert.ok(tab);tab.click();await flush();}

test('guide uses two static cards per channel, real console actions and no bottom documentation list',async t=>{
  const env=await mount(t,'guide',{provider:'feishu',ready:false,busy:false,skipped:false,locked:false});
  for(const provider of ['feishu','dingtalk','wecom']){env.props.provider=provider;await flush();assert.equal(document.querySelectorAll('.channel-guide-dots button').length,2);assert.equal(document.querySelector('.guide-sources'),null);assert.equal(document.querySelector('.official-sources'),null);assert.ok([...document.querySelectorAll('.guide-figure img')].every(el=>el.getAttribute('src').startsWith('/channel-guides/')));assert.ok(document.querySelector('.slide a[href^="https://"]'));}
  assert.equal(env.requests.length,0);
});

test('credentials stay in first card; last card owns pending/result and optional warning permits ready',async t=>{
  const changes=[],ready=[];let release;const pending=new Promise(resolve=>{release=resolve;});t.after(()=>release());
  const env=await mount(t,'draft',{base,disabled:false,onChange:value=>changes.push(value),onReadyChanged:value=>ready.push(value)},async request=>request.method==='GET'?{directoryCredentials:[]}:request.method==='DELETE'?{}:(await pending,result()));
  input('渠道应用 ID','synthetic-app');input('渠道应用 Secret','synthetic-form-secret');
  assert.equal(document.querySelector('input[aria-label="渠道应用 ID"]').closest('.slide').getAttribute('aria-hidden'),'false');
  await channelCard('validate');await click('验证渠道凭据');
  assert.ok(text().includes('正在分层验证'));assert.equal(button('验证渠道凭据').disabled,true);
  release();await until(()=>text().includes('必要读取已通过'));
  assert.ok(text().includes('im:message.group_msg'));assert.equal(ready.at(-1),true);assert.equal(changes.at(-1).draftId,'synthetic-channel-draft');
  await channelCard('credentials');assert.equal(document.querySelector('input[aria-label="渠道应用 Secret"]').value,'synthetic-form-secret');
  assert.equal(env.requests.filter(r=>r.method==='POST').length,1);
});

test('necessary failure stays on validation card, never emits a usable channel draft, and edits invalidate results',async t=>{
  const ready=[];const env=await mount(t,'draft',{base,disabled:false,onReadyChanged:value=>ready.push(value)},async request=>request.method==='GET'?{directoryCredentials:[]}:{status:400,data:{error:'channel_validation_failed',validation:report('feishu',false)}});
  input('渠道应用 ID','synthetic-app');input('渠道应用 Secret','synthetic-form-secret');await channelCard('validate');await click('验证渠道凭据');
  await until(()=>text().includes('必要检查尚未全部通过'));assert.ok(text().includes('响应缺少必要字段'));assert.equal(ready.at(-1),false);
  await channelCard('credentials');input('渠道应用 Secret','synthetic-changed-secret');await flush();assert.equal(document.querySelector('.channel-validation-report'),null);assert.equal(env.requests.filter(r=>r.method==='POST').length,1);
});

test('WeCom wizard accepts the real top-level validation contract without any directory flow',async t=>{
  const ready=[];const env=await mount(t,'draft',{base,disabled:false,onReadyChanged:v=>ready.push(v)},async request=>{
    if(request.method==='DELETE')return{};
    const response=result('wecom');response.validation=response.source.validation;delete response.source.validation;return response;
  });
  await choose('企业微信');
  assert.ok(text().includes('检查并继续'));assert.ok(text().includes('创建后才进行长连接认证'));assert.ok(text().includes('创建后可在渠道使用范围'));
  for(const forbidden of ['Corp ID','Agent ID','通讯录应用 Secret'])assert.equal(document.querySelector(`input[aria-label="${forbidden}"]`),null);
  assert.ok(!text().includes('按部门授权'));assert.ok(!text().includes('同企业'));
  input('渠道应用 ID','synthetic-bot');input('渠道应用 Secret','synthetic-bot-secret');
  await channelCard('validate');await click('验证渠道凭据');await until(()=>text().includes('渠道草稿已准备'));
  assert.equal(ready.at(-1),true);assert.ok(text().includes('新建数字员工首次接入默认全员 + 空黑名单'));assert.ok(text().includes('长连接结果为准'));
  assert.deepEqual(env.requests.find(r=>r.method==='POST').body,{provider:'wecom',appId:'synthetic-bot',appSecret:'synthetic-bot-secret'});
  await click('验证渠道凭据');await until(()=>env.requests.filter(r=>r.method==='POST').length===2);
  assert.equal(env.requests.filter(r=>r.method==='DELETE').length,1);
  await click('跳过渠道连接');assert.equal(ready.at(-1),true);assert.equal(env.requests.filter(r=>r.method==='DELETE').length,2);
  await choose('飞书');assert.equal(document.querySelector('input[aria-label="渠道应用 Secret"]').value,'');assert.equal(ready.at(-1),false);
});

test('editing displays necessary validation failures inline without a tutorial card',async t=>{
  const env=await mount(t,'settings',{base:`${base}/entities/synthetic-employee`,canManage:true},async request=>request.url.endsWith('/registration')?{registration:null,preset:{name:'合成员工',description:''},permissions:{version:'v1',scopes:[],events:[]}}:request.method==='GET'?[]:{status:400,data:{error:'channel_validation_failed',validation:report('feishu',false)}});
  await click('绑定已有应用'); input('渠道应用 ID','synthetic-app');input('渠道应用密钥','synthetic-edit-secret');await click('验证并保存渠道连接');
  await until(()=>text().includes('必要检查尚未全部通过'));assert.equal(document.querySelectorAll('.channel-guide-dots button').length,0);assert.ok(document.querySelector('.channel-validation-report .validation-issues'));assert.equal(document.querySelector('.validation-diagnostics').open,false);assert.equal(env.requests.filter(r=>r.method==='PUT').length,1);
});

test('permission blocks explain purpose, retain OR semantics and use only matching application evidence',async t=>{
 const validation=report();validation.checks.find(check=>check.id==='scope_inventory').scopeInventory=[{scope:'im:message:readonly',identity:'tenant',status:'granted'},{scope:'im:message',identity:'user',status:'granted'},{scope:'unrelated:permission',identity:'tenant',status:'granted'}];
 const env=await mount(t,'permissions',{provider:'feishu',report:validation});
 assert.equal(document.querySelectorAll('.permission-block').length,3);
 const directory=document.querySelector('[data-capability="directory"]'),group=document.querySelector('[data-capability="group"]'),meeting=document.querySelector('[data-capability="meeting"]');
 assert.match(directory.textContent,/必需.*真实姓名/);assert.match(group.textContent,/可选.*历史讨论/);assert.match(meeting.textContent,/可选.*逐字稿/);assert.match(group.textContent,/满足任一（OR）/);
 assert.equal(document.querySelector('[data-scope="im:message:readonly"]').textContent,'已授权');assert.equal(document.querySelector('[data-scope="im:message"]').textContent,'未核验');assert.equal(document.querySelector('[data-scope="im:message.group_msg"]').textContent,'未授权');assert.equal(text().includes('unrelated:permission'),false);
 for(const provider of ['dingtalk','wecom']){env.props.provider=provider;await flush();assert.equal(document.querySelectorAll('.permission-block code').length,0);assert.match(text(),/不套用其他平台/);assert.match(text(),/无需申请额外权限/);}
});

test('safe parsing diagnostics display field paths and types without exposing values',async t=>{
  const validation=report('feishu',false),scope=validation.checks.find(c=>c.id==='directory_scope');Object.assign(scope,{status:'unverified',reason:'parse',httpStatus:200,providerCode:0,field:{path:'data.user_ids',expected:'array<string>',actualType:'object'}});
  await mount(t,'draft',{base,disabled:false},async request=>request.method==='GET'?{directoryCredentials:[]}:{status:400,data:{error:'channel_validation_failed',validation}});
  input('渠道应用 ID','synthetic-app');input('渠道应用 Secret','synthetic-hidden-secret');await channelCard('validate');await click('验证渠道凭据');
  await until(()=>text().includes('data.user_ids'));assert.ok(text().includes('array<string>'));assert.ok(text().includes('object'));assert.ok(text().includes('code 0'));assert.ok(!text().includes('synthetic-hidden-secret'));
});

test('an undisclosed user entry list is never shown as zero users after successful department/name reads',async t=>{
  const response=result();response.scope.userCount=null;response.source.validation.checks.find(c=>c.id==='directory_scope').scopeDisclosure={departments:true,users:false};
  await mount(t,'draft',{base,disabled:false},async request=>request.method==='GET'?{directoryCredentials:[]}:request.method==='DELETE'?{}:response);
  input('渠道应用 ID','synthetic-app');input('渠道应用 Secret','synthetic-hidden-secret');await channelCard('validate');await click('验证渠道凭据');
  await until(()=>text().includes('渠道草稿已准备'));assert.ok(text().includes('直接用户入口未披露'));assert.ok(!text().includes('0 个直接用户入口'));assert.ok(text().includes('明确授权的部门'));
});

test('required optional and reference results share matching full-block and tag colors',async t=>{
  const style=document.createElement('style');style.textContent=':root{--surface:#ffffff;--border:#82948b;--success:#176346;--danger:#b12f37;--warning:#895000;--successTint:#edf6ef;--dangerTint:#fff0f1;--warningTint:#fff5df}'+await readFile('apps/web/src/features/employees/channel-validation-state.css','utf8');document.head.append(style);t.after(()=>style.remove());
  const validation=report();validation.checks.push({id:'department_read',required:false,supported:true,status:'unverified',reason:'no_sample'});
  const env=await mount(t,'report',{report:validation});const backgrounds=new Set();
  for(const [id,required,status,reason,tone] of [['user_name',true,'pass',undefined,'success'],['user_name',true,'unverified','timeout','error'],['department_read',false,'pass',undefined,'success'],['department_read',false,'unverified','no_sample','warning'],['scope_inventory',false,'pass',undefined,'success'],['scope_inventory',false,'unverified','parse','warning']]){
    const next=structuredClone(validation),item=next.checks.find(c=>c.id===id);Object.assign(item,{required,status,reason});next.canContinue=next.checks.filter(c=>c.required).every(c=>c.status==='pass');env.props.report=next;await flush();
    const block=document.querySelector(`.validation-check[data-check="${id}"]`);assert.equal(block.dataset.tone,tone);assert.equal(block.querySelector('.n-tag').dataset.tone,tone);assert.ok(block.classList.contains('channel-status-block'));backgrounds.add(getComputedStyle(block).backgroundColor);
    if(id==='scope_inventory'&&status==='pass')assert.match(block.textContent,/不表示列表内所有权限都已授予/);
  }
  assert.equal(backgrounds.size,3,'green red and yellow blocks have distinct painted backgrounds');assert.equal(env.requests.length,0);
});

test('permission groups are gray before checking; OR permission success is green while resource reads stay yellow',async t=>{
  // The guide uses this same permission component before a validation report exists.
  const blank=await mount(t,'permissions',{provider:'feishu',report:null});for(const block of document.querySelectorAll('.permission-block')){assert.equal(block.dataset.tone,'idle');assert.equal(block.querySelector('.n-tag').dataset.tone,'idle');assert.match(block.textContent,/待校验/);}
  const validation=report(),inventory=validation.checks.find(c=>c.id==='scope_inventory');inventory.status='unverified';inventory.reason='parse';inventory.inventoryDiagnostics={totalRows:6,issueCount:1};inventory.field={path:'data.scopes[5].scope_name',expected:'valid scope name',actualType:'string'};
  inventory.scopeInventory=[{scope:'im:message:readonly',identity:'tenant',status:'denied'},{scope:'im:message',identity:'tenant',status:'granted'},{scope:'im:message.group_msg',identity:'tenant',status:'granted'},{scope:'minutes:minutes.transcript:export',identity:'tenant',status:'granted'},{scope:'minutes:minutes.artifacts:read',identity:'tenant',status:'granted'}];
  const resource=validation.checks.find(c=>c.id==='group_history');Object.assign(resource,{status:'unverified',reason:'resource_required'});delete resource.missingScopes;
  blank.props.report=validation;await flush();
  for(const id of ['directory','group','meeting']){const block=document.querySelector(`[data-capability="${id}"]`);assert.equal(block.dataset.tone,'success');assert.equal(block.querySelector('.n-tag').dataset.tone,'success');}
  assert.match(document.querySelector('[data-capability="group"]').textContent,/权限已授权.*读取尚未验证/);
  assert.equal(document.querySelector('[data-scope="im:message:readonly"]').dataset.tone,'warning');assert.equal(document.querySelector('[data-scope="im:message"]').dataset.tone,'success');assert.equal(blank.requests.length,0);
});

test('scope success never paints the optional resource result green without resource-read evidence',async t=>{
  const validation=report(),resource=validation.checks.find(c=>c.id==='group_history');Object.assign(resource,{status:'unverified',reason:'resource_required'});delete resource.missingScopes;
  validation.checks.find(c=>c.id==='scope_inventory').scopeInventory=[{scope:'im:message:readonly',identity:'tenant',status:'granted'},{scope:'im:message.group_msg',identity:'tenant',status:'granted'}];
  const env=await mount(t,'report',{report:validation});assert.equal(document.querySelector('[data-capability="group"]').dataset.tone,'success');
  const block=()=>document.querySelector('.validation-check[data-check="group_history"]');assert.equal(block().dataset.tone,'warning');assert.match(block().textContent,/尚未验证具体资源权限/);
  const passed=structuredClone(validation);passed.checks.find(c=>c.id==='group_history').status='pass';env.props.report=passed;await flush();assert.equal(block().dataset.tone,'success');assert.match(block().textContent,/读取已验证/);
});

test('unsupported optional and failed reference stay yellow without invalidating confirmed necessary reads',async t=>{
  const validation=report('dingtalk');validation.checks.push({id:'department_read',required:false,supported:true,status:'unverified',reason:'no_sample'});
  await mount(t,'report',{report:validation});assert.equal(document.querySelector('[data-capability="directory"]').dataset.tone,'success');assert.equal(document.querySelector('.validation-check[data-check="user_name"]').dataset.tone,'success');
  for(const id of ['department_read','scope_inventory','group_history'])assert.equal(document.querySelector(`.validation-check[data-check="${id}"]`).dataset.tone,'warning');
  assert.equal(document.querySelector('[data-capability="group"]').dataset.tone,'warning');assert.match(text(),/当前不支持/);assert.match(text(),/必要读取已通过/);
});

test('create and edit channel selectors share ordered 24px brand assets and provider switching',async t=>{
 let expected;
 for(const component of ['draft','settings']){
  const env=await mount(t,component,{base,disabled:false,canManage:true},async()=>component==='draft'?{directoryCredentials:[]}:[]);
  await until(()=>!!document.querySelector('[role=tablist][aria-label="员工渠道"]'));
  const tabs=[...document.querySelectorAll('[role=tablist][aria-label="员工渠道"] [role=tab]')],brands=tabs.map(tab=>({name:tab.textContent.trim(),src:tab.querySelector('img').getAttribute('src'),width:tab.querySelector('img').getAttribute('width'),height:tab.querySelector('img').getAttribute('height')}));
  assert.deepEqual(brands.map(x=>x.name),['飞书','钉钉','企业微信']);assert.ok(brands.every(x=>x.width==='24'&&x.height==='24'));
  if(expected)assert.deepEqual(brands,expected);else expected=brands;
  tabs[1].click();await flush();assert.equal(tabs[1].getAttribute('aria-selected'),'true');
  env.app.unmount();document.body.innerHTML='';
 }
});

test('retired static Minutes stays absent while declared group capabilities save keywords and retained context with the current CAS',async t=>{
 const available={supported:true,availability:'available'},business={supported:true,availability:'authorization_required'};
 const capabilities={privateMessages:available,groupMentions:available,ordinaryGroupMessages:available,keywordTriggers:available,recentGroupContext:available,directoryRead:available,meetingRead:business,documentRead:business};
 const connection={capabilities,groupListeningStatus:{enabled:true,permission:'granted',cachedMessages:0},id:'synthetic-connection',provider:'feishu',appId:'synthetic-app',tenantId:'synthetic-tenant',tenantIdNamespace:'tenant_key',enabled:true,status:'verified',revision:3,directoryStatus:'available',context:{historyEnabled:false,groupListenEnabled:true,meetingRefs:[{kind:'minutes',externalId:'syntheticminute'}]},transport:{state:'stopped',changedAt:1}};
 const env=await mount(t,'settings',{base,canManage:true},async request=>request.url==='/api/business-resources/configuration'?{configured:false,reason:'business_oauth_not_configured'}:request.method==='GET'?[connection]:{});
 assert.equal(document.querySelector('textarea[aria-label="允许读取的飞书妙记"]'),null);document.querySelector('button[aria-label="群上下文范围"]').click();await flush();assert.ok(text().includes('资料引用'));document.querySelector('button[aria-label="群上下文范围"]').click();await flush();const keywords=document.querySelector('textarea[aria-label="群聊触发关键词"]');assert.ok(keywords);assert.ok(document.querySelector('[aria-label="保留近期群消息作为上下文"]'));assert.equal(button('保存').disabled,true);keywords.value='合成关键词';keywords.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'合成关键词'}));await flush();await click('保存');await until(()=>env.requests.some(r=>r.method==='PUT'));assert.deepEqual(env.requests.find(r=>r.method==='PUT').body,{enabled:true,expectedRevision:3,groupListenEnabled:true,groupTriggerKeywords:['合成关键词']});assert.equal('meetingRefs'in env.requests.find(r=>r.method==='PUT').body,false);
});


test('Feishu wizard distinguishes API-complete identity from tenant pending without authorizing the sender', async t => {
  for (const status of ['verified', 'pending_verification']) await t.test(status, async t => {
    const ready = [], response = result(); response.source.status = status;
    const env = await mount(t, 'draft', { base, disabled: false, onReadyChanged: value => ready.push(value) }, async request => request.method === 'DELETE' ? {} : response);
    assert.match(text(), /App ID 标识应用，不是机器人 open_id/);
    assert.equal(document.querySelector('input[aria-label="botId"]'), null);
    input('渠道应用 ID', 'synthetic-app'); input('渠道应用 Secret', 'synthetic-secret');
    await channelCard('validate'); await click('验证渠道凭据'); await until(() => text().includes('渠道草稿已准备'));
    const feedback = document.querySelector('.channel-verification-feedback').textContent;
    assert.match(feedback, status === 'verified' ? /open_id 与租户 tenant_key 已由官方 API 验证，无需首条消息/ : /普通真人私聊或真实群 @.*按使用范围鉴权.*首发者不会自动获得使用权/);
    assert.equal(ready.at(-1), true);
    await click('跳过渠道连接'); assert.equal(document.querySelector('.channel-validation-report'), null);
    await choose('钉钉'); assert.equal(document.querySelector('input[aria-label="渠道应用 Secret"]').value, '');
    assert.ok(env.requests.every(request => /employee-channel-drafts/.test(request.url)));
    assert.equal(env.requests.filter(request => request.method === 'POST').length, 1);
  });
});

test('Feishu missing trusted bot open_id blocks readiness and explains App ID cannot replace it', async t => {
  const ready = [], validation = report(); validation.canContinue = false;
  validation.checks.push({ id: 'bot_identity', required: true, supported: true, status: 'unverified', reason: 'parse' });
  let inconsistent = false;
  const env = await mount(t, 'draft', { base, disabled: false, onReadyChanged: value => ready.push(value) }, async request => {
    if (request.method === 'DELETE') return {};
    if (!inconsistent) return { status: 400, data: { error: 'channel_validation_failed', validation } };
    const response = result(); delete response.source.botId; return response;
  });
  input('渠道应用 ID', 'synthetic-app'); input('渠道应用 Secret', 'synthetic-secret');
  await channelCard('validate'); await click('验证渠道凭据'); await until(() => text().includes('必要检查尚未全部通过'));
  assert.match(document.querySelector('.validation-issues').textContent, /未取得可信的机器人 open_id.*App ID 不能替代机器人 open_id.*不能靠首条消息补齐/);
  assert.equal(ready.at(-1), false);
  inconsistent = true; await click('验证渠道凭据'); await until(() => text().includes('App ID 不能代替机器人身份'));
  assert.equal(ready.at(-1), false); assert.equal(text().includes('渠道草稿已准备'), false);
  assert.equal(env.requests.filter(request => request.method === 'DELETE').length, 1);
});

test('Feishu wizard ignores late workspace results, deletes them at their origin and blocks duplicate clicks', async t => {
  let release; const held = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const ready = [], changes = [], oldResponse = result(); oldResponse.draftId = 'old-workspace-draft';
  const nextBase = '/workspaces/synthetic-next-workspace';
  const env = await mount(t, 'draft', { base, disabled: false, onReadyChanged: value => ready.push(value), onChange: value => changes.push(value) }, async request => {
    if (request.method === 'DELETE') return {};
    if (request.url === `/api${base}/employee-channel-drafts`) { await held; return oldResponse; }
    const response = result(); response.draftId = 'new-workspace-draft'; response.source.status = 'verified'; return response;
  });
  input('渠道应用 ID', 'synthetic-old-app'); input('渠道应用 Secret', 'synthetic-old-secret');
  await channelCard('validate'); await click('验证渠道凭据'); button('验证渠道凭据').click();
  assert.equal(env.requests.filter(request => request.method === 'POST').length, 1);
  assert.equal(button('跳过渠道连接').disabled, true);
  env.props.base = nextBase; await flush();
  assert.equal(document.querySelector('input[aria-label="渠道应用 Secret"]').value, ''); assert.equal(ready.at(-1), false);
  input('渠道应用 ID', 'synthetic-new-app'); input('渠道应用 Secret', 'synthetic-new-secret');
  await channelCard('validate'); await click('验证渠道凭据'); await until(() => changes.at(-1)?.draftId === 'new-workspace-draft');
  release(); await until(() => env.requests.some(request => request.method === 'DELETE' && request.url === `/api${base}/employee-channel-drafts/old-workspace-draft`));
  assert.equal(changes.at(-1).draftId, 'new-workspace-draft'); assert.equal(ready.at(-1), true);
  assert.match(document.querySelector('.channel-verification-feedback').textContent, /无需首条消息完成身份确认/);
  await click('跳过渠道连接'); assert.equal(changes.at(-1), null);
  assert.ok(env.requests.some(request => request.method === 'DELETE' && request.url === `/api${nextBase}/employee-channel-drafts/new-workspace-draft`));
  assert.ok(env.requests.every(request => request.url.includes('/employee-channel-drafts')));
});


test('create and edit use one robot credentials heading with each provider official field names', async t => {
  for (const component of ['draft', 'settings']) await t.test(component, async t => {
    const env = await mount(t, component, { base, disabled: false, canManage: true }, async request => request.url.endsWith('/registration')?{registration:null,preset:{name:'合成员工',description:''},permissions:{version:'v1',scopes:[],events:[]}}:[]);
    for (const [provider, labels] of [['飞书', ['App ID', 'App Secret']], ['钉钉', ['Client ID（AppKey）', 'Client Secret（AppSecret）']], ['企业微信', ['BotID', 'Secret']]]) {
      await choose(provider);
      if (component === 'draft') await channelCard('credentials');
      else await click('绑定已有应用');
      const section = component === 'draft' ? document.querySelector('.slide.is-current') : document.querySelector('.channel-setup');
      assert.match(section.textContent, /机器人连接凭据/);
      assert.deepEqual([...section.querySelectorAll('.n-form-item-label')].map(label => label.textContent.trim()), labels);
    }
    assert.ok(env.requests.every(request => request.method === 'GET'));
  });
});

test('unbound Feishu defaults to automatic onboarding and manual credentials require an explicit switch', async t => {
  const env = await mount(t, 'settings', { base, canManage: true }, async request => request.url.endsWith('/registration') ? { registration: null, preset: { name: '合成员工', description: '合成职责' }, permissions: { version: 'v1', scopes: ['im:message'], events: ['im.message.receive_v1'] } } : []);
  assert.ok(document.querySelector('[aria-label="飞书自动创建应用"]'));
  assert.match(text(), /创建飞书应用/);
  assert.equal(document.querySelector('.channel-setup'), null);
  assert.ok(button('绑定已有应用').closest('.registration-heading'));
  for (const provider of ['飞书', '钉钉', '企业微信']) {
    await choose(provider);
    { await click('绑定已有应用'); if(provider==='飞书') assert.equal(visible(document.querySelector('.feishu-registration')), false); }
    const manual = document.querySelector('.channel-setup'); assert.ok(manual);
    assert.ok(manual.querySelector('input[aria-label="渠道应用 ID"]'));
    assert.ok(manual.querySelector('input[aria-label="渠道应用密钥"]'));
    assert.equal(manual.querySelector('input[aria-label="渠道应用 ID"]').disabled, false);
    assert.equal(manual.querySelector('input[aria-label="渠道应用密钥"]').disabled, false);
    assert.ok(button('验证并保存渠道连接'));
    assert.equal(!!document.querySelector('[aria-label="飞书自动创建应用"]'), provider === '飞书');
  }
  assert.ok(env.requests.every(request => request.method === 'GET'));
});

test('switching setup views preserves a manual draft without starting automatic creation', async t => {
  const env = await mount(t, 'settings', { base, canManage: true }, async request => request.url.endsWith('/registration') ? {
    registration: null, preset: { name: '合成员工', description: '合成职责' }, permissions: { version: 'v1', scopes: [], events: [] }
  } : []);
  await click('绑定已有应用'); input('渠道应用 ID', 'cli_manual_unsaved'); input('渠道应用密钥', 'synthetic-unsaved-secret'); await flush();
  await click('返回自动创建'); assert.equal(document.querySelector('.channel-setup'), null);
  assert.match(text(), /手动凭据草稿已保留/); assert.equal(button('创建飞书应用').disabled, true);
  await click('绑定已有应用'); assert.equal(document.querySelector('input[aria-label="渠道应用 ID"]').value, 'cli_manual_unsaved');
  assert.equal(document.querySelector('input[aria-label="渠道应用密钥"]').value, 'synthetic-unsaved-secret');
  assert.ok(env.requests.every(r => r.method === 'GET'));
});

test('unsaved manual credentials pause automatic Feishu permission retry without disabling three-provider manual entry', async t => {
  const env = await mount(t, 'settings', { base, canManage: true }, async request => request.url.endsWith('/registration') ? {
    registration: null,
    preset: { name: '合成员工', description: '合成职责' }, permissions: { version: 'v1', scopes: [], events: [], groups: [] }
  } : []);
  await click('绑定已有应用'); input('渠道应用 ID', 'cli_manual_unsaved'); input('渠道应用密钥', 'synthetic-unsaved-secret'); await flush();
  const reads = env.requests.length; await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal(env.requests.length, reads); assert.ok(env.requests.every(r => r.method === 'GET'));
  assert.equal(document.querySelector('input[aria-label="渠道应用密钥"]').value, 'synthetic-unsaved-secret');
  assert.equal(document.querySelector('input[aria-label="渠道应用 ID"]').disabled, false); assert.equal(visible(document.querySelector('.feishu-registration')), false);
});


test('pending Feishu setup cannot switch until local cancellation succeeds and can resume after reopening', async t => {
  let state = { id: 'synthetic-registration', state: 'awaiting_confirmation', credentialSaved: false, updatedAt: 1, verificationUrl: 'https://accounts.feishu.cn/confirm' };
  const env = await mount(t, 'settings', { base, canManage: true }, async request => {
    if (!request.url.includes('/registration')) return [];
    if (request.url.endsWith('/cancel')) state = { ...state, state: 'cancelled' };
    return { registration: state, preset: { name: '合成员工', description: '合成职责' }, permissions: { version: 'v1', scopes: [], events: [] } };
  });
  assert.equal(button('绑定已有应用').disabled, true); button('绑定已有应用').click(); await flush(); assert.equal(document.querySelector('.channel-setup'), null);
  await click('返回连接列表'); await click('添加渠道连接'); assert.equal(button('绑定已有应用').disabled, true);
  assert.ok(document.querySelector('.registration-scan a'));
  assert.equal(env.requests.filter(r => r.method === 'POST').length, 0);
  await click('取消等待'); assert.equal(button('绑定已有应用').disabled, false);
  await click('绑定已有应用'); assert.ok(document.querySelector('.channel-setup')); assert.equal(visible(document.querySelector('.feishu-registration')), false);
  await click('返回自动创建'); assert.match(text(), /已取消本次等待/);
  assert.deepEqual(env.requests.filter(r => r.method === 'POST').map(r => r.url), [`/api${base}/channels/feishu/registration/cancel`]);
});
