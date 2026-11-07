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
const bundle = await mkdtemp(resolve('apps/web/.group-use-ui-test-'));
const paths={picker:'apps/web/src/features/directory/DirectoryRulePicker.vue',settings:'apps/web/src/features/employees/ChannelConnections.vue',access:'apps/web/src/features/employees/AccessSettings.vue',scope:'apps/web/src/features/employees/WizardEmployeeAccess.vue',summary:'apps/web/src/features/employees/EmployeeScopeSummary.vue',channelScope:'apps/web/src/features/employees/ChannelAccessSettings.vue'};
const components = {};
for (const [name, path] of Object.entries(paths)) {
  const outfile = join(bundle, `${name}.mjs`);
  await build({ entryPoints: [path], outfile, bundle: true, platform: 'node', format: 'esm', external: ['vue', 'naive-ui'], plugins: [{ name: 'vue-sfc', setup(builder) { builder.onLoad({ filter: /\.vue$/ }, async ({ path }) => { const { descriptor } = parse(await readFile(path, 'utf8'), { filename: path }); return { contents: compileScript(descriptor, { id: path, inlineTemplate: true, fs: { fileExists: existsSync, readFile: file => readFileSync(file, 'utf8') } }).content, loader: 'ts', resolveDir: resolve(path, '..') }; }); } }] });
  components[name] = (await import(pathToFileURL(outfile).href)).default;
}
test.after(async () => { await rm(bundle, { recursive: true, force: true }); await window.happyDOM.close(); });
async function continueToChannels(){
 if(visible(document.querySelector('[data-wizard-step="model"]'))){await until(()=>!button('下一步：整体使用范围').disabled);await click('下一步：整体使用范围');}
 if(visible(document.querySelector('[data-wizard-step="access"]'))){await until(()=>!button('下一步：确认创建').disabled);await click('下一步：确认创建');}
 await click('接入渠道');assert.ok(visible(document.querySelector('[data-wizard-step="channels"]')));
}
async function providerTab(name){const tab=[...document.querySelectorAll('[role=tablist][aria-label="员工渠道"] [role=tab]')].find(t=>t.textContent.trim()===name);assert.ok(tab,name);tab.click();await flush();}
const text = () => document.body.textContent;
async function flush() { await new Promise(resolve => setTimeout(resolve, 10)); await nextTick(); }
async function until(predicate, description = 'UI settled') { for (let index = 0; index < 100; index++) { await flush(); if (predicate()) return; } assert.fail(`${description}\n${text()}`); }
function visible(el) { for (let node = el; node instanceof HTMLElement; node = node.parentElement) if (node.hidden || node.style.display === 'none' || node.style.visibility === 'hidden' || node.getAttribute('aria-hidden') === 'true') return false; return true; }
function button(label) { const result = [...document.querySelectorAll('button')].find(item => visible(item) && (item.textContent.trim() === label || item.getAttribute('aria-label') === label)); assert.ok(result, `button ${label}`); return result; }
function input(label, value) { const field = document.querySelector(`input[aria-label="${label}"]`); assert.ok(field, label); field.value = value; field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value })); }
async function click(label) { await nextTick(); if(['验证并保存渠道连接','重新验证已存凭据','停用此渠道','启用此渠道','解除渠道绑定','验证渠道并读取通讯录'].includes(label)&&document.querySelector('.channel-guide-dots button[data-step=validate]'))await channelCard('validate'); button(label).click(); await flush(); }
async function channelCard(id) { id=id==='create'?'credentials':id==='optional'?'validate':id; const dot=document.querySelector(`.channel-guide-dots button[data-step="${id}"]`); assert.ok(dot); dot.click(); await flush(); }
async function mount(t, name, initial, handler = async () => { throw new Error('Unexpected request'); }) {
  const props = reactive(initial), requests = [];
  globalThis.fetch = async (url, options = {}) => {
    assert.ok(String(url).startsWith('/api/'), 'Only relative local fixture API routes are permitted');
    const request = { url: String(url), method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : undefined };
    requests.push(request); const result = await handler(request);
    return new Response(JSON.stringify(result?.data ?? result), { status: typeof result?.status === 'number' ? result.status : 200, headers: { 'content-type': 'application/json' } });
  };
  document.body.innerHTML = '<div id="app"></div>';
  const app = createApp({ render: () => h(components[name], props) }); app.mount('#app'); await flush();if(name==='settings'&&initial.canManage){await until(()=>!!document.querySelector('.connection-list'));const b=[...document.querySelectorAll('.connection-list button')].find(b=>b.textContent.trim()==='查看此连接')??[...document.querySelectorAll('.connection-list button')].find(b=>b.textContent.trim()==='添加渠道连接');if(b){b.click();await flush();}const details=document.querySelector('.channel-guide-toggle');if(details)details.open=true;}if(name==='wizard'){const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='展开渠道、工作能力与自动运行配置');if(b){b.click();await flush();}} if(name==='settings'&&document.querySelector('.channel-guide-dots button[data-step=validate]'))await channelCard('validate');
  t.after(() => { app.unmount(); document.body.innerHTML = ''; });
  return { props, requests, app };
}
const base = '/workspaces/workspace-a/entities/employee-a';
const connection = (overrides = {}) => ({ validation:{version:1,provider:overrides.provider??'feishu',checkedAt:Date.now(),canContinue:true,checks:[{id:'credentials',required:true,supported:true,status:'pass'},{id:'directory_identity',required:true,supported:true,status:'pass'},{id:'directory_scope',required:true,supported:true,status:'pass'},{id:'user_name',required:true,supported:true,status:'pass'}]},transport: { state: 'connected', changedAt: 1792756800000 }, id: 'connection-1', sourceId: 'source-1', entityId: 'employee-a', provider: 'feishu', appId: 'fixture-app', tenantId: 'fixture-tenant', tenantIdNamespace: 'tenant_key', revision: 1, authRevision: 1, status: 'verified', identityEvidence: 'provider_api', inboundVerified: false, directoryStatus: 'available', enabled: true, ...overrides });
const subjects = source => ({ sources: [source ?? connection()], users: [], departments: [] });
const department = { externalId: 'department-7', subjectId: JSON.stringify({ id: 'department-7', namespace: 'department_id', applicationId: 'fixture-app' }), displayName: '研发部', kind: 'department' };
const page = (items, overrides = {}) => ({ sourceId: 'source-1', provider: 'feishu', appId: 'fixture-app', items, exhausted: true, ...overrides });


async function checkGroup(){const el=document.querySelector('[role="checkbox"][aria-label="允许群成员在群内使用"]');assert.ok(el);el.click();await flush();return el;}
function accessResponse(request){if(request.url.endsWith('/directory-access'))return{allow:[],deny:[],allowGroupMembers:false,revision:3};if(request.url.endsWith('/web-access'))return{allowMemberIds:[],denyMemberIds:[],revision:1};if(request.url.endsWith('/channels/subjects'))return{sources:[],users:[],departments:[]};return[];}
test('employee editing defaults group closed, marks dirty, cancels, saves with revision and keeps failed draft',async t=>{
 let fail=false;const dirty=[];const env=await mount(t,'access',{base,onDirtyChanged:v=>dirty.push(v)},async r=>{if(r.method==='PUT'){if(fail)return{status:409,data:{error:'directory_policy_changed'}};return{...r.body,revision:4};}return accessResponse(r);});
 await until(()=>!!document.querySelector('.directory-access-form'));
 assert.equal(document.querySelector('[aria-label="允许群成员在群内使用"]').getAttribute('aria-checked'),'false');
 await checkGroup();assert.equal(dirty.at(-1),true);await click('取消渠道范围修改');assert.equal(dirty.at(-1),false);
 await checkGroup();fail=true;await click('保存渠道使用策略');await until(()=>text().includes('渠道使用策略已被更新'));assert.match(text(),/你的修改已保留/);assert.equal(document.querySelector('[aria-label="允许群成员在群内使用"]').getAttribute('aria-checked'),'true');assert.equal(dirty.at(-1),true);
 fail=false;await click('保存渠道使用策略');await until(()=>dirty.at(-1)===false);
 assert.deepEqual(env.requests.find(r=>r.method==='PUT').body,{allow:[],deny:[],allowGroupMembers:true,expectedRevision:3});
 assert.ok(text().includes('不会获得私聊或网页使用权'));
});
test('creation scope only grants self or dynamic workspace Web use and does not open channel groups',async t=>{
 const changes=[];await mount(t,'scope',{base,disabled:false,channel:null,selfMemberId:'me',onChange:v=>changes.push(v)},async()=>({members:[]}));
 assert.equal(changes.at(-1).directoryAccess.allowGroupMembers,false);assert.deepEqual(changes.at(-1).webAccess,{allowMemberIds:['me'],denyMemberIds:[],allowWorkspaceMembers:false});
 const choice=document.querySelector('input[type=radio][value=workspace]');assert.ok(choice);choice.click();await flush();
 assert.equal(changes.at(-1).webAccess.allowWorkspaceMembers,true);assert.equal(changes.at(-1).directoryAccess.allowGroupMembers,false);assert.deepEqual(changes.at(-1).directoryAccess.allow,[]);assert.equal(document.querySelector('[aria-label="允许群成员在群内使用"]'),null,'fine-grained group access remains in employee detail, not simple creation');
});
test('confirmation explicitly presents group permission without claiming nobody is allowed',async t=>{
 await mount(t,'summary',{members:[],directoryAccess:{allow:[],deny:[],allowGroupMembers:true}});assert.ok(text().includes('允许群成员在群内使用'));assert.ok(!text().includes('未允许渠道使用者'));
});
test('keywords remain an editable draft with honest missing grant; save/cancel and failure preserve input',async t=>{
 let current=connection({context:{historyEnabled:false,groupListenEnabled:false,groupTriggerKeywords:[],meetingRefs:[]}}),fail=true;const dirty=[];
 const env=await mount(t,'settings',{base,canManage:true,onDirtyChanged:v=>dirty.push(v)},async r=>{if(r.method==='GET')return[current];if(fail)return{status:409,data:{error:'channel_configuration_changed'}};current={...current,revision:current.revision+1,context:{...current.context,...r.body}};return current;});
 assert.ok(text().includes('普通群消息接收权限尚未验证'));
 const field=document.querySelector('textarea[aria-label="群聊触发关键词"]');assert.ok(field);field.value='  HELP  \n 需求';field.dispatchEvent(new InputEvent('input',{bubbles:true}));await flush();assert.equal(dirty.at(-1),true);
 await click('保存');await until(()=>text().includes('channel_configuration_changed'));assert.equal(field.value,'  HELP  \n 需求');assert.equal(dirty.at(-1),true);
 fail=false;await click('保存');await until(()=>text().includes('已保存。'));assert.deepEqual(env.requests.find(r=>r.method==='PUT').body,{enabled:true,expectedRevision:1,groupListenEnabled:false,groupTriggerKeywords:['HELP','需求']});assert.equal(dirty.at(-1),false);
 field.value='unsaved';field.dispatchEvent(new InputEvent('input',{bubbles:true}));await flush();await click('取消');assert.equal(field.value,'HELP\n需求');assert.equal(dirty.at(-1),false);
});

test('employee UI hides advanced restrictions but preserves existing Web deny and per-rule scenes on save',async t=>{
 const personal={sourceId:'source-1',kind:'channel_user',subjectId:'opaque-person',conversationKinds:['private']},hiddenDeny={...personal,subjectId:'opaque-denied',conversationKinds:['group']};
 const env=await mount(t,'access',{base,section:'access'},async r=>{if(r.method==='PUT')return{...r.body,revision:4};if(r.url.endsWith('/directory-access'))return{allow:[personal],deny:[hiddenDeny],allowGroupMembers:false,revision:3};if(r.url.endsWith('/web-access'))return{allowMemberIds:['platform-allowed'],denyMemberIds:['platform-denied'],revision:1};return accessResponse(r);});
 await until(()=>!!document.querySelector('.directory-access-form'));assert.ok(text().includes('已配置额外使用限制'));assert.ok(!text().includes('拒绝渠道用户 / 部门'));assert.equal(document.querySelector('input[aria-label="明确拒绝成员"]'),null);
 assert.equal(document.querySelector('.directory-rule-detail [role="checkbox"]'),null,'employee has no per-person scene controls');
 await checkGroup();await click('保存渠道使用策略');await until(()=>env.requests.some(r=>r.method==='PUT'));
 assert.deepEqual(env.requests.find(r=>r.url.endsWith('/directory-access')&&r.method==='PUT').body,{allow:[personal],deny:[hiddenDeny],allowGroupMembers:true,expectedRevision:3});
 await click('保存 Web 使用策略');assert.deepEqual(env.requests.find(r=>r.url.endsWith('/web-access')&&r.method==='PUT').body,{allowMemberIds:['platform-allowed'],denyMemberIds:['platform-denied']});
});
test('employee whitelist new selections default to both scenes while package picker retains its original scene controls',async t=>{
 let selected=[];let env=await mount(t,'picker',{base,label:'白名单',employeeScope:true,subjects:subjects(),rules:selected,'onUpdate:rules':v=>{selected=v;env.props.rules=v;}},async()=>page([department]));
 await click('查询当前目录');await until(()=>text().includes('研发部'));await click('选择部门');assert.deepEqual(selected[0].conversationKinds,['private','group']);assert.equal([...document.querySelectorAll('[role="checkbox"]')].some(el=>el.textContent.trim()==='私聊'||el.textContent.trim()==='群聊'),false);
 env.props.employeeScope=false;await flush();assert.ok([...document.querySelectorAll('[role="checkbox"]')].some(el=>el.textContent.trim()==='私聊'),'generic/package picker keeps scene selection');
});

for(const provider of ['feishu','dingtalk','wecom'])test(provider+' channel group-use switch saves with source CAS, preserves hidden deny rules and cancels unsaved changes',async t=>{let policy={allow:[],deny:[{sourceId:'source-1',kind:'channel_user',subjectId:JSON.stringify(['channel_user',provider==='feishu'?'open_id':'user_id','fixture-app','blocked']),conversationKinds:['group']}],allowGroupMembers:false,revision:3};const env=await mount(t,'channelScope',{base,connection:connection({provider}),canManage:true},async request=>{if(request.method==='PATCH'){assert.equal(request.body.sourceId,'source-1');assert.equal(request.body.expectedRevision,3);assert.equal(request.body.allowGroupMembers,true);assert.equal(request.body.deny,undefined);policy={...policy,allowGroupMembers:true,revision:4};}return policy;});await until(()=>document.querySelector('[role="checkbox"][aria-label="允许群成员在群内使用"]'));const checkbox=document.querySelector('[role="checkbox"][aria-label="允许群成员在群内使用"]');checkbox.click();await flush();button('保存渠道使用策略').click();await until(()=>text().includes('已保存'));assert.equal(env.requests.filter(r=>r.method==='PATCH').length,1);assert.equal(document.querySelector('[role="checkbox"][aria-label="允许群成员在群内使用"]').getAttribute('aria-checked'),'true');assert.ok(text().includes('额外使用限制'));checkbox.click();await flush();button('取消渠道范围修改').click();await flush();assert.equal(document.querySelector('[role="checkbox"][aria-label="允许群成员在群内使用"]').getAttribute('aria-checked'),'true');assert.equal(env.requests.filter(r=>r.method==='PATCH').length,1);});
