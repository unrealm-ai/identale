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
const paths = { report: 'apps/web/src/features/employees/ChannelValidationReport.vue', permissions: 'apps/web/src/features/employees/ChannelPermissionBlocks.vue', wecom: 'apps/web/src/features/employees/WecomDirectoryBinding.vue', draft: 'apps/web/src/features/employees/WizardChannelDraft.vue', guide: 'apps/web/src/features/employees/WizardChannelGuide.vue', settings: 'apps/web/src/features/employees/ChannelConnections.vue' };
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
async function channelCard(id) { const dot=document.querySelector(`.channel-guide-dots button[data-step="${id}"]`); assert.ok(dot); dot.click(); await flush(); }
async function mount(t, name, initial, handler = async () => { throw new Error('Unexpected request'); }) {
  const props = reactive(initial), requests = [];
  globalThis.fetch = async (url, options = {}) => {
    assert.ok(String(url).startsWith('/api/'), 'Only relative local fixture API routes are permitted');
    const request = { url: String(url), method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : undefined };
    requests.push(request); const result = await handler(request);
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
const result=(provider='feishu')=>({draftId:'synthetic-channel-draft',expiresAt:Date.now()+60_000,source:{provider,status:'pending_verification',validation:report(provider)},scope:{departmentCount:1,userCount:1,entireOrganization:false}});
const base='/workspaces/synthetic-workspace';
async function choose(provider){const tab=[...document.querySelectorAll('[role=tab]')].find(el=>el.querySelector('.provider-label')&&el.textContent.trim()===provider);assert.ok(tab);tab.click();await flush();}

test('guide uses exactly two/two/three static cards, real console actions and no bottom documentation list',async t=>{
  const env=await mount(t,'guide',{provider:'feishu',ready:false,busy:false,skipped:false,locked:false});
  for(const [provider,count] of [['feishu',2],['dingtalk',2],['wecom',3]]){env.props.provider=provider;await flush();assert.equal(document.querySelectorAll('.channel-guide-dots button').length,count);assert.equal(document.querySelector('.guide-sources'),null);assert.equal(document.querySelector('.official-sources'),null);assert.ok([...document.querySelectorAll('.guide-figure img')].every(el=>el.getAttribute('src').startsWith('/channel-guides/')));assert.ok(document.querySelector('.slide a[href^="https://"]'));}
  assert.equal(env.requests.length,0);
});

test('credentials stay in first card; last card owns pending/result and optional warning permits ready',async t=>{
  const changes=[],ready=[];let release;const pending=new Promise(resolve=>{release=resolve;});t.after(()=>release());
  const env=await mount(t,'draft',{base,disabled:false,onChange:value=>changes.push(value),onReadyChanged:value=>ready.push(value)},async request=>request.method==='GET'?{directoryCredentials:[]}:request.method==='DELETE'?{}:(await pending,result()));
  input('渠道应用 ID','synthetic-app');input('渠道应用 Secret','synthetic-form-secret');
  assert.equal(document.querySelector('input[aria-label="渠道应用 ID"]').closest('.slide').getAttribute('aria-hidden'),'false');
  await channelCard('validate');await click('验证渠道并读取通讯录');
  assert.ok(text().includes('正在分层验证'));assert.equal(button('验证渠道并读取通讯录').disabled,true);
  release();await until(()=>text().includes('必要读取已通过'));
  assert.ok(text().includes('im:message.group_msg'));assert.equal(ready.at(-1),true);assert.equal(changes.at(-1).draftId,'synthetic-channel-draft');
  await channelCard('credentials');assert.equal(document.querySelector('input[aria-label="渠道应用 Secret"]').value,'synthetic-form-secret');
  assert.equal(env.requests.filter(r=>r.method==='POST').length,1);
});

test('necessary failure stays on validation card, never emits a usable channel draft, and edits invalidate results',async t=>{
  const ready=[];const env=await mount(t,'draft',{base,disabled:false,onReadyChanged:value=>ready.push(value)},async request=>request.method==='GET'?{directoryCredentials:[]}:{status:400,data:{error:'channel_validation_failed',validation:report('feishu',false)}});
  input('渠道应用 ID','synthetic-app');input('渠道应用 Secret','synthetic-form-secret');await channelCard('validate');await click('验证渠道并读取通讯录');
  await until(()=>text().includes('必要检查尚未全部通过'));assert.ok(text().includes('响应缺少必要字段'));assert.equal(ready.at(-1),false);
  await channelCard('credentials');input('渠道应用 Secret','synthetic-changed-secret');await flush();assert.equal(document.querySelector('.channel-validation-report'),null);assert.equal(env.requests.filter(r=>r.method==='POST').length,1);
});

test('WeCom directory validates independently before bot fields and final request uses the scoped directory receipt',async t=>{
  const env=await mount(t,'draft',{base,disabled:false},async request=>{
    if(request.method==='GET')return{directoryCredentials:[]};if(request.method==='DELETE')return{};
    if(request.body.operation==='directory')return{draftId:'synthetic-directory-draft',expiresAt:Date.now()+60_000,validation:report('wecom')};
    return result('wecom');
  });
  await choose('企业微信');
  input('通讯录配置名称','Synthetic directory');input('Corp ID','synthetic-corp');input('Agent ID','7');input('通讯录应用 Secret','synthetic-directory-secret');
  await click('单独验证通讯录与姓名');await until(()=>text().includes('必要读取已通过'));
  const directory=env.requests.find(r=>r.method==='POST');assert.equal(directory.body.operation,'directory');assert.equal(directory.body.appId,undefined);assert.equal(directory.body.appSecret,undefined);
  await channelCard('credentials');input('渠道应用 ID','synthetic-bot');input('渠道应用 Secret','synthetic-bot-secret');
  const checkbox=document.querySelector('.n-checkbox');assert.ok(checkbox);checkbox.click();await flush();
  await channelCard('validate');assert.equal(button('验证渠道并读取通讯录').disabled,false);await click('验证渠道并读取通讯录');await until(()=>text().includes('渠道草稿已准备'));
  const final=env.requests.filter(r=>r.method==='POST').at(-1);assert.deepEqual(final.body.directory,{draftId:'synthetic-directory-draft',confirmSameCorp:true});assert.equal(JSON.stringify(final.body).includes('synthetic-directory-secret'),false);
});

test('editing displays necessary validation failures inline without a tutorial card',async t=>{
  const env=await mount(t,'settings',{base:`${base}/entities/synthetic-employee`,canManage:true},async request=>request.method==='GET'?[]:{status:400,data:{error:'channel_validation_failed',validation:report('feishu',false)}});
  input('渠道应用 ID','synthetic-app');input('渠道应用密钥','synthetic-edit-secret');await click('验证并保存渠道连接');
  await until(()=>text().includes('必要检查尚未全部通过'));assert.equal(document.querySelectorAll('.channel-guide-dots button').length,0);assert.ok(document.querySelector('.channel-validation-report .validation-issues'));assert.equal(document.querySelector('.validation-diagnostics').open,false);assert.equal(env.requests.filter(r=>r.method==='PUT').length,1);
});

test('an existing WeCom directory can be independently revalidated without a robot connection',async t=>{
  const current={id:'directory-existing',label:'Synthetic directory',corpId:'synthetic-corp',agentId:'7',revision:3,status:'verified',referenceCount:0};
  const env=await mount(t,'wecom',{base:`${base}/entities/synthetic-employee`,disabled:false},async request=>request.method==='GET'?[current]:{...current,revision:4,validation:report('wecom')});
  await until(()=>text().includes('单独验证所选通讯录与姓名'));await click('单独验证所选通讯录与姓名');
  await until(()=>text().includes('所选目录应用已单独验证'));
  const request=env.requests.find(r=>r.method==='POST');assert.ok(request.url.endsWith('/directory-existing/revalidate'));assert.deepEqual(request.body,{expectedRevision:3});assert.equal(document.querySelector('input[aria-label="渠道应用密钥"]'),null);
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
  input('渠道应用 ID','synthetic-app');input('渠道应用 Secret','synthetic-hidden-secret');await channelCard('validate');await click('验证渠道并读取通讯录');
  await until(()=>text().includes('data.user_ids'));assert.ok(text().includes('array<string>'));assert.ok(text().includes('object'));assert.ok(text().includes('code 0'));assert.ok(!text().includes('synthetic-hidden-secret'));
});

test('an undisclosed user entry list is never shown as zero users after successful department/name reads',async t=>{
  const response=result();response.scope.userCount=null;response.source.validation.checks.find(c=>c.id==='directory_scope').scopeDisclosure={departments:true,users:false};
  await mount(t,'draft',{base,disabled:false},async request=>request.method==='GET'?{directoryCredentials:[]}:request.method==='DELETE'?{}:response);
  input('渠道应用 ID','synthetic-app');input('渠道应用 Secret','synthetic-hidden-secret');await channelCard('validate');await click('验证渠道并读取通讯录');
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
  const validation=report('wecom');validation.checks.push({id:'department_read',required:false,supported:true,status:'unverified',reason:'no_sample'});
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
