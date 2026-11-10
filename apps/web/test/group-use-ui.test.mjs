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
const paths={verification:'apps/web/src/features/directory/WecomMemberVerification.vue',human:'apps/web/src/features/employees/HumanConfirmationSettings.vue',picker:'apps/web/src/features/directory/DirectoryRulePicker.vue',settings:'apps/web/src/features/employees/ChannelConnections.vue',access:'apps/web/src/features/employees/AccessSettings.vue',scope:'apps/web/src/features/employees/WizardEmployeeAccess.vue',summary:'apps/web/src/features/employees/EmployeeScopeSummary.vue',channelScope:'apps/web/src/features/employees/ChannelAccessSettings.vue'};
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
function button(label) { const alias={'验证渠道凭据':'检查并继续','验证并保存渠道连接':'保存机器人配置','重新验证已存凭据':'重新连接并检查'};if(alias[label]&&[...document.querySelectorAll('button')].some(b=>visible(b)&&b.textContent.trim()===alias[label]))label=alias[label]; const result = [...document.querySelectorAll('button')].find(item => visible(item) && (item.textContent.trim() === label || item.getAttribute('aria-label') === label)); assert.ok(result, `button ${label}`); return result; }
function input(label, value) { const field = document.querySelector(`input[aria-label="${label}"]`); assert.ok(field, label); field.value = value; field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value })); }
async function click(label) { await nextTick(); if(['验证并保存渠道连接','重新验证已存凭据','停用此渠道','启用此渠道','解除渠道绑定','验证渠道凭据'].includes(label)&&document.querySelector('.channel-guide-dots button[data-step=validate]'))await channelCard('validate'); button(label).click(); await flush(); }
async function channelCard(id) { id=id==='create'?'credentials':id==='optional'?'validate':id; const dot=document.querySelector(`.channel-guide-dots button[data-step="${id}"]`); assert.ok(dot); dot.click(); await flush(); }
async function mount(t, name, initial, handler = async () => { throw new Error('Unexpected request'); }) {
  const props = reactive(initial), requests = [];
  globalThis.fetch = async (url, options = {}) => {
    assert.ok(String(url).startsWith('/api/'), 'Only relative local fixture API routes are permitted');
    const request = { url: String(url), method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : undefined };
    requests.push(request); const result = name==='settings'&&request.url.endsWith('/group-sharing')?{revision:0,rules:[]}:name==='settings'&&request.url.endsWith('/group-sharing/status')?{appliedRevision:0}:await handler(request);
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
 const granted={supported:true,availability:'available'},required={supported:true,availability:'authorization_required'};
 const capabilities={privateMessages:granted,groupMentions:granted,ordinaryGroupMessages:required,keywordTriggers:required,recentGroupContext:required,directoryRead:granted,meetingRead:required,documentRead:required};
 let current=connection({capabilities,groupListeningStatus:{enabled:false,permission:'unverified',cachedMessages:0},context:{historyEnabled:false,groupListenEnabled:false,groupTriggerKeywords:[],meetingRefs:[]}}),fail=true;const dirty=[];
 const env=await mount(t,'settings',{base,canManage:true,onDirtyChanged:v=>dirty.push(v)},async r=>{if(r.url==='/api/business-resources/configuration')return{configured:false};if(r.method==='GET')return[current];if(fail)return{status:409,data:{error:'channel_configuration_changed'}};current={...current,revision:current.revision+1,context:{...current.context,...r.body}};return current;});
 assert.ok(text().includes('普通群消息接收权限尚未验证'));
 const field=document.querySelector('textarea[aria-label="群聊触发关键词"]');assert.ok(field);assert.equal(field.disabled,false);assert.equal(current.capabilities.keywordTriggers.availability,'authorization_required');field.value='  HELP  \n 需求';field.dispatchEvent(new InputEvent('input',{bubbles:true}));await flush();assert.equal(dirty.at(-1),true);
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
 await click('搜索');await until(()=>text().includes('研发部'));await click('选择部门');assert.deepEqual(selected[0].conversationKinds,['private','group']);assert.equal([...document.querySelectorAll('[role="checkbox"]')].some(el=>el.textContent.trim()==='私聊'||el.textContent.trim()==='群聊'),false);
 env.props.employeeScope=false;await flush();assert.ok([...document.querySelectorAll('[role="checkbox"]')].some(el=>el.textContent.trim()==='私聊'),'generic/package picker keeps scene selection');
});


async function selectMode(mode){const radio=document.querySelector(`input[type="radio"][value="${mode}"]`);assert.ok(radio,mode);radio.click();await flush();}
const wecomConnection=()=>connection({provider:'wecom',directoryMode:'member_search',directoryStatus:'unavailable',status:'pending_verification'});
for(const provider of ['feishu','dingtalk','wecom'])test(provider+' source policy starts with blank allowlist and group use, preserves deny in every mode, CAS and cancel',async t=>{
 const blocked={sourceId:'source-1',kind:'channel_user',subjectId:'blocked-person',conversationKinds:['private','group']};
 let policy={allow:[],deny:[],revision:30,channelPolicies:[{sourceId:'source-1',mode:'allowlist',allowGroupMembers:true,allow:[],deny:[blocked],revision:2}]};
 const env=await mount(t,'channelScope',{base,connection:provider==='wecom'?wecomConnection():connection({provider}),canManage:true},async request=>{if(request.method==='PATCH')policy={...policy,channelPolicies:[{...request.body,revision:policy.channelPolicies[0].revision+1}]};return policy;});
 await until(()=>document.querySelector('input[value="allowlist"]')?.checked);
 assert.equal(document.querySelector('[aria-label="允许群成员在群内使用"]').getAttribute('aria-checked'),'true');assert.match(text(),/不授予私聊或网页使用权/);assert.match(text(),/黑名单始终优先/);assert.equal(document.querySelectorAll('.directory-rule-detail').length,1);
 await selectMode('denylist');await click('保存渠道使用策略');await until(()=>text().includes('已保存'));
 assert.deepEqual(env.requests.find(r=>r.method==='PATCH').body,{sourceId:'source-1',mode:'denylist',allow:[],deny:[blocked],allowGroupMembers:true,expectedRevision:2});
 await selectMode('allowlist');await checkGroup();await click('取消渠道范围修改');assert.ok(document.querySelector('input[value="denylist"]').checked);assert.equal(document.querySelector('[aria-label="允许群成员在群内使用"]').getAttribute('aria-checked'),'true');
 await selectMode('allowlist');await click('保存渠道使用策略');assert.equal(env.requests.filter(r=>r.method==='PATCH').at(-1).body.expectedRevision,3);assert.deepEqual(env.requests.filter(r=>r.method==='PATCH').at(-1).body.deny,[blocked]);
});
test('existing all mode is shown as everyone plus blacklist without becoming dirty or changing defaults',async t=>{
 await mount(t,'channelScope',{base,connection:wecomConnection(),canManage:true},async()=>({allow:[],deny:[],revision:20,channelPolicies:[{sourceId:'source-1',mode:'all',allow:[],deny:[],allowGroupMembers:false,revision:2}]}));
 await until(()=>document.querySelector('input[value="denylist"]')?.checked);assert.equal(button('保存渠道使用策略').disabled,true);assert.equal(document.querySelector('[aria-label="允许群成员在群内使用"]').getAttribute('aria-checked'),'false');
});
test('source policy conflict retains edits, reload updates CAS, and switching employee drops late reads',async t=>{
 let revision=4,stale=true;const env=await mount(t,'channelScope',{base,connection:wecomConnection(),canManage:true},async request=>{
  if(request.method==='PATCH'&&stale)return{status:409,data:{error:'directory_policy_changed'}};
  return{allow:[],deny:[],revision:90,channelPolicies:[{sourceId:'source-1',mode:'allowlist',allow:[],deny:[],allowGroupMembers:true,revision},{sourceId:'source-next',mode:'denylist',allow:[],deny:[],allowGroupMembers:false,revision:7}]};
 });
 await until(()=>document.querySelector('input[value="allowlist"]')?.checked);await selectMode('denylist');await click('保存渠道使用策略');assert.ok(document.querySelector('input[value="denylist"]').checked);
 revision=5;await click('读取服务器配置并核对');assert.ok(text().includes('你的修改已保留'));stale=false;await click('保存渠道使用策略');assert.equal(env.requests.filter(r=>r.method==='PATCH').at(-1).body.expectedRevision,5);
 env.props.connection={...wecomConnection(),sourceId:'source-next'};await until(()=>document.querySelector('input[value="denylist"]')?.checked);assert.equal(button('保存渠道使用策略').disabled,true);
});
test('source switch ignores a late policy response from previous employee',async t=>{
 let release;const held=new Promise(resolve=>{release=resolve;});t.after(()=>release());
 const env=await mount(t,'channelScope',{base,connection:wecomConnection(),canManage:true},async request=>{if(request.url===`/api${base}/directory-access`){await held;return{allow:[],deny:[],revision:1,channelPolicies:[{sourceId:'source-1',mode:'allowlist',allow:[],deny:[],allowGroupMembers:true,revision:8}]};}return{allow:[],deny:[],revision:2,channelPolicies:[{sourceId:'source-next',mode:'denylist',allow:[],deny:[],allowGroupMembers:false,revision:9}]};});
 env.props.base='/workspaces/workspace-a/entities/employee-next';env.props.connection={...wecomConnection(),sourceId:'source-next'};await until(()=>document.querySelector('input[value="denylist"]')?.checked);release();await flush();assert.ok(document.querySelector('input[value="denylist"]').checked);assert.equal(button('保存渠道使用策略').disabled,true);
});
test('WeCom allowlist searches and saves people under current robot source',async t=>{
 const policy={allow:[],deny:[],revision:30,channelPolicies:[{sourceId:'source-1',mode:'allowlist',allow:[],deny:[],allowGroupMembers:true,revision:0}]};
 const env=await mount(t,'channelScope',{base,connection:wecomConnection(),canManage:true},async request=>{if(request.url.endsWith('/member-search'))return page([{externalId:'member-a',subjectId:'member-a',displayName:'合成成员',kind:'channel_user',departmentPaths:['部门仅用于识别']}],{provider:'wecom'});if(request.method==='PATCH')return{...policy,channelPolicies:[{...request.body,revision:1}]};return policy;});
 await until(()=>document.querySelector('input[value="allowlist"]')?.checked);input('允许成员成员关键词','合成成员');await click('搜索企微成员');await until(()=>text().includes('选择人员'));await click('选择人员');await click('保存渠道使用策略');
 const saved=env.requests.find(r=>r.method==='PATCH').body;assert.equal(saved.mode,'allowlist');assert.equal(saved.expectedRevision,0);assert.deepEqual(saved.allow,[{sourceId:'source-1',kind:'channel_user',subjectId:'member-a',conversationKinds:['private','group']}]);assert.deepEqual(saved.deny,[]);assert.equal(saved.allowGroupMembers,true);assert.ok(!text().includes('查询当前目录'));
});
test('channel policy blocks duplicate or uncertain saves and reconciles server result without erasing group choice',async t=>{
 let release;const held=new Promise(resolve=>{release=resolve;});t.after(()=>release());let policy={allow:[],deny:[],revision:20,channelPolicies:[{sourceId:'source-1',mode:'allowlist',allow:[],deny:[],allowGroupMembers:true,revision:1}]};
 const env=await mount(t,'channelScope',{base,connection:wecomConnection(),canManage:true},async request=>{if(request.method==='PATCH'){await held;policy={...policy,channelPolicies:[{...request.body,revision:2}]};return{status:503,data:{error:'runtime_service_unavailable'}};}return policy;});
 await until(()=>document.querySelector('input[value="allowlist"]')?.checked);await selectMode('denylist');await checkGroup();await click('保存渠道使用策略');button('保存渠道使用策略').click();assert.equal(env.requests.filter(r=>r.method==='PATCH').length,1);release();await until(()=>text().includes('保存结果尚未确认'));assert.equal(button('保存渠道使用策略').disabled,true);await click('读取服务器配置并核对');await until(()=>!text().includes('保存结果尚未确认'));assert.equal(button('保存渠道使用策略').disabled,true);assert.equal(document.querySelector('[aria-label="允许群成员在群内使用"]').getAttribute('aria-checked'),'false');assert.equal(env.requests.filter(r=>r.method==='PATCH').length,1);
});

test('WeCom blacklist warning remains until every selected person has identity evidence',async t=>{
 const deny={sourceId:'source-1',kind:'channel_user',subjectId:JSON.stringify(['channel_user','user_id','bot','unverified']),conversationKinds:['private','group']};
 const env=await mount(t,'channelScope',{base,connection:{...wecomConnection(),memberSearchIdentityVerified:true,memberSearchVerifiedUserIds:['someone-else']},canManage:true},async()=>({allow:[],deny:[deny],revision:1,channelPolicies:[{sourceId:'source-1',mode:'all',allow:[],deny:[deny],allowGroupMembers:true,revision:1}]}));
 await until(()=>text().includes('名单中仍有人员身份待核验'));
 env.props.connection={...env.props.connection,memberSearchVerifiedUserIds:['someone-else','unverified']};await flush();
 assert.equal(text().includes('名单中仍有人员身份待核验'),false);
 env.props.connection={...env.props.connection,memberSearchVerifiedUserIds:[]};await flush();
 assert.equal(text().includes('名单中仍有人员身份待核验'),true);
});


const verificationPerson={externalId:'searched-person',subjectId:JSON.stringify(['wecom','user_id','fixture-app','searched-person']),displayName:'核验测试成员',kind:'channel_user',departmentPaths:['研发部'],identityVerified:false};
const verificationProps={base,sourceId:'source-1',userId:'searched-person',authRevision:1,label:'核验测试成员'};
const currentCode=()=>({userId:'searched-person',status:'pending',phrase:'000123',expiresAt:Date.now()+86400000});
const codeInput=()=>document.querySelector('input[aria-label="核验测试成员验证码"]');
test('WeCom selected member auto-generates one six-digit 24-hour code, copies exact leading zeros and updates on reply',async t=>{
 let verified=false;const events=[];const env=await mount(t,'verification',{...verificationProps,onVerified:()=>events.push(true)},async r=>r.method==='POST'?currentCode():{userId:'searched-person',status:verified?'verified':'unverified'});
 await until(()=>codeInput());assert.equal(codeInput().value,'000123');await click('复制验证码');assert.equal(await navigator.clipboard.readText(),'000123');assert.match(text(),/24 小时有效/);assert.match(text(),/请让核验测试成员通过企微私聊向机器人发送验证码 000123，完成身份绑定。/);assert.equal(text().includes('可附带文字'),false);assert.equal(env.requests.filter(r=>r.method==='POST').length,1);
 verified=true;await click('查询验证状态');await until(()=>events.length===1);assert.equal(codeInput(),null);assert.match(text(),/身份已验证/);
});
test('WeCom reopen restores current code without POST; replacement is explicit and duplicate clicks blocked',async t=>{
 let release;const held=new Promise(resolve=>release=resolve);t.after(()=>release());
 const env=await mount(t,'verification',{...verificationProps},async r=>{if(r.method==='POST'){await held;return{...currentCode(),phrase:'000456'};}return currentCode();});
 await until(()=>codeInput());assert.equal(codeInput().value,'000123');assert.equal(env.requests.some(r=>r.method==='POST'),false);
 const generate=button('重新生成验证码');generate.click();generate.click();await flush();assert.equal(env.requests.filter(r=>r.method==='POST').length,1);assert.equal(env.requests.find(r=>r.method==='POST').body.replace,true);release();await until(()=>codeInput().value==='000456');
});
test('WeCom failed generation never automatically retries and explicit retry reuses requestId',async t=>{
 let posts=0;const env=await mount(t,'verification',{...verificationProps},async r=>{if(r.method==='POST'){posts++;if(posts===1)throw Error('fixture network failure');return currentCode();}return{userId:'searched-person',status:'unverified'};});
 await until(()=>text().includes('结果未知'));assert.equal(posts,1);await click('重试获取验证码');const requests=env.requests.filter(r=>r.method==='POST');assert.equal(requests[0].body.requestId,requests[1].body.requestId);assert.equal(codeInput().value,'000123');
});
for(const boundary of ['stop','unmount','source'])test(`WeCom automatic generation ignores late response after ${boundary}`,async t=>{
 let release;const held=new Promise(resolve=>release=resolve);t.after(()=>release());
 const env=await mount(t,'verification',{...verificationProps},async r=>{if(r.method==='POST'){await held;return currentCode();}return r.url.includes('source-next')?{userId:'searched-person',status:'failed'}:{userId:'searched-person',status:'unverified'};});
 await until(()=>env.requests.some(r=>r.method==='POST'));if(boundary==='stop')await click('停止查询');else if(boundary==='unmount')env.app.unmount();else{env.props.sourceId='source-next';await flush();}release();await flush();assert.equal(codeInput(),null);
});
test('WeCom expired code auto-renews on visible opening but never while hidden',async t=>{
 const original=Object.getOwnPropertyDescriptor(document,'visibilityState');let visibility='hidden';Object.defineProperty(document,'visibilityState',{get:()=>visibility,configurable:true});t.after(()=>{if(original)Object.defineProperty(document,'visibilityState',original);else delete document.visibilityState;});
 const env=await mount(t,'verification',{...verificationProps},async r=>r.method==='POST'?currentCode():{userId:'searched-person',status:'expired',expiresAt:Date.now()-1000});
 assert.equal(env.requests.length,0);visibility='visible';document.dispatchEvent(new Event('visibilitychange'));await until(()=>codeInput());assert.equal(env.requests.filter(r=>r.method==='POST').length,1);assert.equal(env.requests.find(r=>r.method==='POST').body.replace,undefined);
});
test('WeCom visible code expiry refreshes once without background rotation',async t=>{
 let reads=0;const env=await mount(t,'verification',{...verificationProps},async r=>{if(r.method==='POST')return{...currentCode(),phrase:'000456'};return ++reads===1?{...currentCode(),expiresAt:Date.now()+100}:{userId:'searched-person',status:'expired'};});
 await until(()=>codeInput()?.value==='000456');assert.equal(env.requests.filter(r=>r.method==='POST').length,1);
});
test('WeCom rules select immediately and retain automatic code entry after reopening without search',async t=>{
 let env;env=await mount(t,'picker',{base,label:'使用范围',subjects:subjects(wecomConnection()),rules:[],'onUpdate:rules':rules=>{env.props.rules=rules;}},async r=>r.url.endsWith('/member-search')?page([{...verificationPerson}],{provider:'wecom'}):currentCode());
 input('使用范围成员关键词','测试');await click('搜索企微成员');await click('选择人员');await until(()=>document.querySelector('.directory-rule-detail'));assert.equal(env.props.rules.length,1);assert.match(text(),/可先保存/);env.props.base='/workspaces/workspace-a/entities/employee-next';await flush();await until(()=>document.querySelector('.directory-rule-detail input[readonly]'));assert.ok(env.requests.some(r=>r.url.includes('/employee-next/channels/wecom/member-search')));
});
const pendingHumanTarget={kind:'wecom_directory',connectionId:'connection-1',provider:'wecom',appId:'fixture-app',tenantId:'fixture-tenant',sourceId:'source-1',authRevision:1,directoryUserId:'searched-person',identityNamespace:'user_id'};
for(const initiallyVerified of [false,true])test(`WeCom confirmation saves ${initiallyVerified?'verified':'pending'} target without waiting for member`,async t=>{
 let verified=initiallyVerified;const env=await mount(t,'human',{base},async r=>{
  if(r.url.endsWith('/member-search'))return page([{...verificationPerson,identityVerified:verified}],{provider:'wecom'});
  if(r.url.includes('/member-verification'))return verified?{userId:'searched-person',status:'verified'}:currentCode();
  if(r.method==='PUT')return{version:2,rules:r.body.rules};
  if(r.url.endsWith('/human-confirmation/resolve'))return{label:verificationPerson.displayName,directorySubjectId:verificationPerson.subjectId,identityVerified:verified,target:pendingHumanTarget};
  return{version:1,rules:[],subjects:subjects(wecomConnection()),candidates:[{label:verificationPerson.displayName,directorySubjectId:verificationPerson.subjectId,identityVerified:verified,target:pendingHumanTarget}]};
 });
 await until(()=>!button('从渠道目录选择').disabled);await click('从渠道目录选择');input('人工确认人成员关键词','测试');await click('搜索企微成员');await click('选择人员');await until(()=>document.querySelector('.human-rule'));await click('保存确认设置');await until(()=>text().includes('人工确认接收人已保存'));assert.deepEqual(env.requests.find(r=>r.method==='PUT').body.rules,[{questionScope:'*',target:pendingHumanTarget}]);
 if(!initiallyVerified){assert.match(text(),/身份待验证/);verified=true;await click('查询验证状态');await until(()=>text().includes('身份已验证'));assert.equal(button('保存确认设置').disabled,true);}
});
test('saved pending confirmation reopens current code without search or candidate',async t=>{
 const env=await mount(t,'human',{base},async r=>r.url.includes('/member-verification')?currentCode():{version:1,rules:[{questionScope:'*',target:pendingHumanTarget}],subjects:subjects(wecomConnection()),candidates:[]});
 await until(()=>document.querySelector('.human-rule input[readonly]'));assert.equal(env.requests.some(r=>r.method==='POST'),false);assert.equal(button('保存确认设置').disabled,true);
});
test('readonly WeCom identity rows never fetch or generate manager codes',async t=>{
 const env=await mount(t,'verification',{...verificationProps,readonly:true},async()=>{throw Error('read-only must not request');});assert.equal(env.requests.length,0);assert.equal(codeInput(),null);assert.equal(document.querySelector('button'),null);
});
test('WeCom confirmation rejects another robot even for the same directory identity and name',async t=>{
 const env=await mount(t,'human',{base},async r=>r.url.endsWith('/member-search')?page([verificationPerson],{provider:'wecom'}):{version:1,rules:[],subjects:subjects(wecomConnection()),candidates:[{label:verificationPerson.displayName,directorySubjectId:verificationPerson.subjectId,target:{...pendingHumanTarget,connectionId:'other-connection'}}]});
 await until(()=>!button('从渠道目录选择').disabled);await click('从渠道目录选择');input('人工确认人成员关键词','测试');await click('搜索企微成员');await click('选择人员');await until(()=>document.querySelector('.human-settings [role=alert]'));assert.equal(document.querySelector('.human-rule'),null);assert.equal(env.requests.some(r=>r.method==='PUT'),false);
});
test('WeCom verification updates warning and search badges without losing dirty rules or other pending people',async t=>{
 const people=[{...verificationPerson},{...verificationPerson,externalId:'second-person',subjectId:JSON.stringify(['wecom','user_id','fixture-app','second-person']),displayName:'另一个待验证成员'}],verified=new Set(),evidence=[];
 const policy={allow:[],deny:[],revision:1,channelPolicies:[{sourceId:'source-1',mode:'all',allow:[],deny:[],allowGroupMembers:true,revision:7}]};
 const env=await mount(t,'channelScope',{base,connection:wecomConnection(),canManage:true,onIdentityVerified:value=>evidence.push(value)},async r=>{
  if(r.url.endsWith('/member-search'))return page(people,{provider:'wecom'});
  if(r.url.includes('/member-verification')){const id=r.body?.userId??new URL(r.url,'http://fixture').searchParams.get('userId');return{...currentCode(),userId:id,status:verified.has(id)?'verified':'pending'};}
  return policy;
 });
 await until(()=>document.querySelector('input[value="denylist"]')?.checked);input('拒绝成员成员关键词','测试');await click('搜索企微成员');
 for(const option of document.querySelectorAll('.directory-option')){[...option.querySelectorAll('button')].find(b=>b.textContent.trim()==='选择人员').click();await flush();}
 assert.equal(document.querySelectorAll('.directory-rule-detail').length,2);assert.equal(button('保存渠道使用策略').disabled,false);assert.match(text(),/名单中仍有人员身份待核验/);
 verified.add('searched-person');const first=document.querySelectorAll('.directory-rule-detail')[0];[...first.querySelectorAll('button')].find(b=>b.textContent.trim()==='查询验证状态').click();await flush();
 assert.match(text(),/名单中仍有人员身份待核验/);assert.match(document.querySelectorAll('.directory-option')[0].textContent,/身份已核验/);assert.equal(document.querySelectorAll('.directory-option')[1].textContent.includes('身份已核验'),false);
 verified.add('second-person');const second=document.querySelectorAll('.directory-rule-detail')[1];[...second.querySelectorAll('button')].find(b=>b.textContent.trim()==='查询验证状态').click();await flush();assert.equal(text().includes('名单中仍有人员身份待核验'),false);assert.equal(document.querySelectorAll('.directory-rule-detail').length,2);assert.equal(button('保存渠道使用策略').disabled,false);assert.equal(env.requests.some(r=>r.method==='PATCH'),false);assert.deepEqual(evidence[0],{sourceId:'source-1',authRevision:1,userId:'searched-person'});
 env.props.connection={...env.props.connection,memberSearchVerifiedUserIds:['searched-person','second-person']};await flush();assert.equal(document.querySelectorAll('.directory-option').length,2);assert.equal(document.querySelector('input[aria-label="拒绝成员成员关键词"]').value,'测试');assert.equal(button('保存渠道使用策略').disabled,false);
 verified.clear();env.props.connection={...env.props.connection,authRevision:2,memberSearchVerifiedUserIds:[]};await flush();assert.match(text(),/名单中仍有人员身份待核验/);assert.equal(document.querySelectorAll('.directory-rule-detail').length,2);assert.equal(button('保存渠道使用策略').disabled,false);
});
test('ChannelConnections merges verified evidence without resetting credentials draft or reloading channel policy',async t=>{
 let verified=false;const policy={allow:[],deny:[],revision:1,channelPolicies:[{sourceId:'source-1',mode:'all',allow:[],deny:[],allowGroupMembers:true,revision:7}]};
 const env=await mount(t,'settings',{base,canManage:true},async r=>{
  if(r.url.endsWith('/channels'))return[wecomConnection()];if(r.url.endsWith('/runtime-status'))return{observedAt:null,employee:null};
  if(r.url.endsWith('/member-search'))return page([{...verificationPerson}],{provider:'wecom'});
  if(r.url.includes('/member-verification'))return{...currentCode(),status:verified?'verified':'pending'};
  if(r.url.endsWith('/directory-access'))return policy;
  return{};
 });
 await providerTab('企业微信');await until(()=>document.querySelector('input[value="denylist"]')?.checked);input('渠道应用 ID','unsaved-bot-id');input('拒绝成员成员关键词','测试');await click('搜索企微成员');await click('选择人员');await until(()=>document.querySelector('.member-verification input[readonly]'));
 verified=true;await click('查询验证状态');await until(()=>!text().includes('名单中仍有人员身份待核验'));assert.equal(document.querySelector('input[aria-label="渠道应用 ID"]').value,'unsaved-bot-id');assert.equal(document.querySelectorAll('.directory-option').length,1);assert.match(document.querySelector('.directory-option').textContent,/身份已核验/);assert.equal(button('保存渠道使用策略').disabled,false);assert.equal(env.requests.filter(r=>r.url.endsWith('/channels')).length,1);assert.equal(env.requests.filter(r=>r.url.endsWith('/directory-access')).length,1);assert.equal(env.requests.some(r=>r.method==='PATCH'),false);
});
for(const provider of ['feishu','wecom','dingtalk'])test(provider+' exposes only supported group sharing entry without enabling listening',async t=>{
 const current=connection({provider,status:'verified',...(provider==='wecom'?{directoryMode:'member_search',directoryStatus:'unavailable'}:{})});
 const env=await mount(t,'settings',{base,canManage:true},async r=>{
  if(r.url.endsWith('/channels'))return[current];
  if(r.url.endsWith('/runtime-status'))return{observedAt:null,employee:null};
  if(r.url.endsWith('/directory-access'))return{allow:[],deny:[],revision:1,channelPolicies:[]};
  return{};
 });
 await providerTab(provider==='feishu'?'飞书':provider==='wecom'?'企业微信':'钉钉');await until(()=>!!document.querySelector('input[aria-label="渠道应用 ID"]'));
 if(provider==='dingtalk'){assert.equal(document.querySelector('[aria-label="群消息共享"]'),null);}
 else{await until(()=>!!document.querySelector('[aria-label="群消息共享"]'));assert.ok(env.requests.some(r=>r.url.endsWith('/group-sharing')));}
 if(provider!=='feishu'){assert.equal(document.querySelector('[aria-label="群聊触发关键词"]'),null);assert.equal(document.querySelector('[aria-label="保留近期群消息作为上下文"]'),null);}
});

test('WeCom recent context defaults on, saves independently, preserves failed draft and cancels',async t=>{
 const yes={supported:true,availability:'available'},no={supported:false,availability:'unsupported'};
 const capabilities={privateMessages:yes,groupMentions:no,directedGroupMessages:yes,ordinaryGroupMessages:no,keywordTriggers:no,recentGroupContext:yes,directoryRead:yes,meetingRead:no,documentRead:no};
 let current=connection({provider:'wecom',capabilities,context:{historyEnabled:false,meetingRefs:[]}}),fail=true;const dirty=[];
 const env=await mount(t,'settings',{base,canManage:true,onDirtyChanged:v=>dirty.push(v)},async r=>{
  if(r.method==='PUT'){if(fail)return{status:409,data:{error:'channel_configuration_changed'}};current={...current,revision:current.revision+1,context:{...current.context,wecomRecentGroupContextEnabled:r.body.wecomRecentGroupContextEnabled}};return current;}
  if(r.url.endsWith('/channels'))return[current];if(r.url.endsWith('/runtime-status'))return{observedAt:null,employee:null};if(r.url.endsWith('/directory-access'))return{allow:[],deny:[],revision:1,channelPolicies:[]};return{};
 });
 await providerTab('企业微信');await until(()=>!!document.querySelector('[aria-label="近期群消息补充上下文"]'));
 const check=()=>document.querySelector('[aria-label="近期群消息补充上下文"]');
 assert.equal(check().getAttribute('aria-checked'),'true');assert.equal(document.querySelector('[aria-label="保留近期群消息作为上下文"]'),null);assert.equal(document.querySelector('[aria-label="群聊触发关键词"]'),null);assert.ok(text().includes('不监听普通群消息'));
 check().click();await flush();assert.equal(dirty.at(-1),true);await click('取消');assert.equal(check().getAttribute('aria-checked'),'true');assert.equal(dirty.at(-1),false);
 check().click();await flush();await click('保存');await until(()=>text().includes('channel_configuration_changed'));assert.equal(check().getAttribute('aria-checked'),'false');assert.equal(dirty.at(-1),true);
 fail=false;await click('保存');await until(()=>text().includes('已保存。'));assert.deepEqual(env.requests.filter(r=>r.method==='PUT').at(-1).body,{enabled:true,expectedRevision:1,wecomRecentGroupContextEnabled:false});assert.equal(check().getAttribute('aria-checked'),'false');assert.equal(dirty.at(-1),false);
 check().click();await flush();await click('返回连接列表');await until(()=>text().includes('当前渠道有未保存的修改'));await click('继续编辑当前渠道');assert.equal(check().getAttribute('aria-checked'),'true');await click('返回连接列表');await click('放弃策略修改并切换');assert.equal(dirty.at(-1),false);await click('查看此连接');assert.equal(check().getAttribute('aria-checked'),'false');
});
