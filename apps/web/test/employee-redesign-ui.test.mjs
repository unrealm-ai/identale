import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {existsSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Window} from 'happy-dom';
import {build} from 'esbuild';
import {parse,compileScript} from '@vue/compiler-sfc';
// User-approved UI transport fixtures: no real provider, model, channel or business data.
const window=new Window({url:'http://127.0.0.1:5173/'});
for(const name of ['window','document','navigator','location','history','localStorage','Node','ShadowRoot','Document','Element','HTMLElement','SVGElement','HTMLDialogElement','Event','MouseEvent','KeyboardEvent','PointerEvent','FocusEvent','InputEvent','Image','HTMLInputElement','HTMLTextAreaElement','getComputedStyle','MutationObserver','ResizeObserver','requestAnimationFrame','cancelAnimationFrame'])Object.defineProperty(globalThis,name,{value:name==='window'?window:window[name],configurable:true});
const {createApp,h,reactive,nextTick}=await import('vue');
const folder=await mkdtemp(resolve('apps/web/.employee-redesign-test-'));
const components={};
for(const [name,file] of Object.entries({directory:'EmployeeDirectory.vue',wizard:'EntityWizard.vue',settings:'EmployeeSettings.vue',overview:'EmployeeOverview.vue',scope:'WizardEmployeeAccess.vue',access:'AccessSettings.vue',channel:'ChannelConnections.vue',channelAccess:'ChannelAccessSettings.vue'})){
 const outfile=join(folder,name+'.mjs');
 await build({entryPoints:['apps/web/src/features/employees/'+file],outfile,bundle:true,platform:'node',format:'esm',external:['vue','naive-ui'],plugins:[{name:'vue-sfc',setup(b){b.onLoad({filter:/\.vue$/},async({path})=>{const {descriptor}=parse(await readFile(path,'utf8'),{filename:path});return{contents:compileScript(descriptor,{id:path,inlineTemplate:true,fs:{fileExists:existsSync,readFile:p=>readFileSync(p,'utf8')}}).content,loader:'ts',resolveDir:resolve(path,'..')};});}}]});components[name]=(await import(pathToFileURL(outfile).href)).default;
}
test.after(async()=>{await rm(folder,{recursive:true,force:true});await window.happyDOM.close();});
const workspace={id:'workspace-a',name:'测试工作区',memberId:'member-self',role:'member'};
const entity={id:'employee-a',workspaceId:workspace.id,name:'测试员工',description:'处理客户问题',avatarPreset:'thumbs-01',executionThinkingLevel:'medium',enabled:true,lifecycleRevision:1,webAllowed:true,modelReady:true,canChat:true,channelProviders:['feishu','wecom'],packages:2};
const profile={id:'model-a',name:'已有模型',provider:'openai-compatible',endpoint:'https://example.invalid/v1',modelId:'fixture-model',enabled:true,secretRef:'opaque',configRevision:1,referenceCount:0};
const bodyText=()=>document.body.textContent;
async function flush(){await new Promise(r=>setTimeout(r,10));await nextTick();}
async function until(fn,label='UI settled'){for(let i=0;i<120;i++){await flush();if(fn())return;}assert.fail(label+'\n'+bodyText());}
function visible(el){for(let n=el;n instanceof HTMLElement;n=n.parentElement)if(n.style.display==='none'||n.style.visibility==='hidden'||n.hidden||n.getAttribute('aria-hidden')==='true')return false;return true;}
function button(label){const e=[...document.querySelectorAll('button')].find(e=>visible(e)&&(e.textContent.trim()===label||e.getAttribute('aria-label')===label));assert.ok(e,'button '+label);return e;}
async function click(label){await nextTick();button(label).click();await flush();}
function input(label,value){const el=document.querySelector(`input[aria-label="${label}"],textarea[aria-label="${label}"]`);assert.ok(el,label);el.value=value;el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}));}
async function tab(label){const el=[...document.querySelectorAll('[role=tablist][aria-label="员工设置分类"] [role=tab]')].find(e=>e.textContent.trim()===label);assert.ok(el,'tab '+label);el.click();await flush();}
function defaults(r){if(r.url.endsWith('/group-sharing'))return{revision:0,rules:[]};if(r.url.endsWith('/group-sharing/status'))return{appliedRevision:0};if(r.url.endsWith('/employee-creation-options'))return{members:[{id:'member-self',displayName:'我',role:'member'}],resources:[],directoryCredentials:[]};if(r.url.endsWith('/model-profiles'))return{profiles:[profile],defaultProfileId:profile.id};if(r.url.endsWith('/model-settings'))return{selectedProfileId:profile.id,executionThinkingLevel:'medium',revision:'fixture-revision'};if(r.url.endsWith('/overview'))return{employee:{...entity,channels:2,checkedAt:Date.now()},partialFailures:[]};if(r.url.endsWith('/web-access'))return{allowMemberIds:[],denyMemberIds:[],revision:1};if(r.url.endsWith('/directory-access'))return{allow:[],deny:[],allowGroupMembers:false,revision:1};if(r.url.endsWith('/channels/subjects'))return{sources:[],users:[],departments:[]};if(r.url.endsWith('/runtime-status'))return{status:'unavailable',observedAt:null,configuration:{ready:false,modules:[]},employee:null,error:'temporarily_unavailable'};return[];}
async function mount(t,name,initial,handler=defaults){const requests=[],props=reactive(initial);globalThis.fetch=async(url,options={})=>{assert.ok(String(url).startsWith('/api/'));const req={url:String(url),method:options.method??'GET',body:options.body?JSON.parse(options.body):undefined};requests.push(req);const res=await handler(req);return new Response(JSON.stringify(res?.data??res),{status:res?.status??200,headers:{'content-type':'application/json'}});};document.body.innerHTML='<div id="app"></div>';const app=createApp({render:()=>h(components[name],props)});app.mount('#app');await flush();t.after(()=>{app.unmount();document.body.innerHTML='';});return{props,requests,app};}

test('creation exposes only self/workspace and emits dynamic workspace flag without snapshotting members',async t=>{
 const changes=[];await mount(t,'scope',{base:'/workspaces/a',channel:null,disabled:false,selfMemberId:'member-self',onChange:v=>changes.push(v)});
 const labels=[...document.querySelectorAll('.n-radio')].map(e=>e.textContent.trim());assert.deepEqual(labels,['我自己','工作区']);assert.equal(changes.at(-1).webAccess.allowWorkspaceMembers,false);
 document.querySelector('.n-radio input[value=workspace]').click();await flush();assert.equal(changes.at(-1).webAccess.allowWorkspaceMembers,true);assert.deepEqual(changes.at(-1).webAccess.allowMemberIds,['member-self']);assert.deepEqual(changes.at(-1).directoryAccess,{allow:[],deny:[],allowGroupMembers:false});assert.ok(bodyText().includes('以后加入'));
});

test('directory shows deduplicated configured channel icons and package counts, retains recent history entry',async t=>{
 let recent=0,chat=0,manage=0;await mount(t,'directory',{entities:[{...entity,channelProviders:['feishu','wecom','feishu']}],loaded:true,busy:false,canManage:true,canEdit:()=>true,onRecentConversations:()=>recent++,onChat:()=>chat++,onSettings:()=>manage++});
 assert.equal(document.querySelectorAll('.employee-channel-icons img').length,2);assert.ok(bodyText().includes('2 个能力包'));assert.ok(!bodyText().includes('使用范围'));assert.match(document.querySelector('.employee-channel-icons').title,/不代表在线/);await click('最近对话');await click('开始对话');await click('管理');assert.deepEqual([recent,chat,manage],[1,1,1]);
});

test('employee exposes seven tabs and independently edits basics without model save or losing form draft',async t=>{
 let recent=0;const emitted=[];const env=await mount(t,'settings',{entity:{...entity},workspace,section:'model',onBusyChanged:v=>emitted.push(v),onRecentConversations:()=>recent++});
 await until(()=>bodyText().includes('模型与思考强度'));assert.deepEqual([...document.querySelectorAll('[role=tablist][aria-label="员工设置分类"] [role=tab]')].map(e=>e.textContent.trim()),['概览','对话','任务','能力包','渠道','触发器','模型']);
 await click('编辑资料');await until(()=>!!document.querySelector('input[aria-label="员工名称"]'));input('员工名称','保留的草稿');await flush();assert.equal(emitted.at(-1),true);await click('取消员工信息修改');await until(()=>!document.querySelector('.n-drawer'));assert.equal(env.requests.filter(r=>r.method==='PATCH'||r.method==='PUT').length,0);
 await tab('概览');await tab('模型');assert.ok(document.querySelector('[aria-label="模型与思考强度"]'));
 document.querySelector('[aria-label="员工使用的模型"] input[value=""]').click();await flush();assert.equal(emitted.at(-1),true);await tab('概览');await tab('模型');assert.equal(document.querySelector('[aria-label="员工使用的模型"] input[value=""]').checked,true);await click('最近对话');assert.equal(recent,0,'dirty model cannot silently leave for recent conversations');await click('继续编辑员工');await click('取消模型修改');assert.equal(emitted.at(-1),false);assert.equal(env.requests.filter(r=>r.method==='PUT').length,0);
});

test('legacy identity deep link opens edit drawer while model configuration stays its own tab',async t=>{
 await mount(t,'settings',{entity:{...entity},workspace,section:'identity'});await until(()=>!!document.querySelector('input[aria-label="员工名称"]'));assert.ok(bodyText().includes('编辑资料'));assert.equal(document.querySelector('.n-drawer [aria-label="模型与思考强度"]'),null);await click('取消员工信息修改');await until(()=>!document.querySelector('.n-drawer'));
});

test('single page creation keeps three visible sections and posts only selected scope once',async t=>{
 const created=[];const env=await mount(t,'wizard',{workspace,onDone:e=>created.push(e)},async r=>r.url.endsWith('/employee-creations')?{entity:{...entity,name:r.body.name}}:defaults(r));
 await until(()=>!!document.querySelector('input[aria-label="员工名称"]'));assert.ok(visible(document.querySelector('[data-wizard-step="identity"]')));assert.ok(visible(document.querySelector('[data-wizard-step="model"]')));assert.ok(visible(document.querySelector('[data-wizard-step="access"]')));
 input('员工名称','新员工');await flush();document.querySelector('[aria-label="创建员工可用范围"] input[value=workspace]').click();await flush();await click('确认创建数字员工');await until(()=>created.length===1);
 const submitted=env.requests.filter(r=>r.url.endsWith('/employee-creations'));assert.equal(submitted.length,1);assert.equal(submitted[0].body.webAccess.allowWorkspaceMembers,true);assert.deepEqual(submitted[0].body.webAccess.allowMemberIds,['member-self']);assert.ok(submitted[0].body.operationId);assert.deepEqual(submitted[0].body.directoryAccess,{allow:[],deny:[],allowGroupMembers:false});
});

test('creation preview, advanced settings and cancellation keep a single page without optional flows',async t=>{
 let closed=0;const env=await mount(t,'wizard',{workspace,onClose:()=>closed++});await until(()=>!!document.querySelector('input[aria-label="员工名称"]'));input('员工名称','预览员工');input('职责与表达风格','整理会议纪要');await flush();
 assert.equal(document.querySelector('#wizard-heading').textContent,'新建数字员工');assert.equal(document.querySelectorAll('[data-wizard-step]').length,3);
 assert.equal(document.querySelector('[data-wizard-step="channels"]'),null);assert.equal(document.querySelector('[data-wizard-step="capabilities"]'),null);assert.equal(document.querySelector('[data-wizard-step="confirm"]'),null);
 assert.equal([...document.querySelectorAll('button')].some(b=>['资源库','接入渠道'].includes(b.textContent.trim())),false);
 assert.match(document.querySelector('.wizard-preview').textContent,/预览员工/);assert.match(document.querySelector('.wizard-preview').textContent,/整理会议纪要/);assert.equal(document.querySelector('.wizard-advanced').open,false);
 assert.equal(document.querySelector('input[aria-label="员工名称"]').maxLength,100);assert.equal(document.querySelector('textarea').maxLength,4000);
 await click('返回数字员工');await click('继续填写');assert.equal(document.querySelector('input[aria-label="员工名称"]').value,'预览员工');await click('取消');await click('丢弃草稿并退出');assert.equal(closed,1);assert.equal(env.requests.filter(r=>r.method==='POST').length,0);
});

test('inline shared model tests then saves, selects returned profile, and employee payload contains reference not secret',async t=>{
 const catalog=[profile],done=[];const newProfile={...profile,id:'model-new',name:'新共享模型'};
 const env=await mount(t,'wizard',{workspace,onDone:e=>done.push(e)},async r=>{if(r.url.endsWith('/test-connection'))return{connectionTestReceipt:'opaque-fixture-receipt',expiresAt:new Date(Date.now()+60000).toISOString()};if(r.url.endsWith('/model-profiles')&&r.method==='POST'){catalog.push(newProfile);return newProfile;}if(r.url.endsWith('/model-profiles'))return{profiles:[...catalog],defaultProfileId:profile.id};if(r.url.endsWith('/employee-creations'))return{entity:{...entity,name:r.body.name}};return defaults(r);});
 await until(()=>!button('添加新模型').disabled);input('员工名称','带模型员工');await click('添加新模型');await until(()=>!!document.querySelector('input[aria-label="配置名称"]'));input('配置名称','新共享模型');input('模型地址','https://example.invalid/v1');input('模型名称','new-fixture-model');input('API Key · 只写，不回显','fixture-key-not-real');await click('联通测试');await until(()=>!button('保存').disabled);await click('保存');await until(()=>!document.querySelector('.n-drawer')&&!button('确认创建数字员工').disabled);await click('确认创建数字员工');await until(()=>done.length===1);
 const post=env.requests.find(r=>r.url.endsWith('/employee-creations'));assert.deepEqual(post.body.model,{kind:'existing',profileId:'model-new'});assert.ok(!JSON.stringify(post.body).includes('fixture-key-not-real'));assert.ok(env.requests.findIndex(r=>r.url.endsWith('/test-connection'))<env.requests.findIndex(r=>r.url.endsWith('/model-profiles')&&r.method==='POST'));
});

test('precise permission editing displays workspace mode and preserves hidden deny on save',async t=>{
 const env=await mount(t,'access',{base:'/workspaces/a/entities/e',section:'access'},async r=>{if(r.method==='PUT')return{...r.body,revision:2};if(r.url.endsWith('/web-access'))return{allowWorkspaceMembers:true,allowMemberIds:['member-self'],denyMemberIds:['member-denied'],revision:1};return defaults(r);});
 await until(()=>!!document.querySelector('[aria-label="允许工作区成员使用"]'));assert.equal(document.querySelector('[aria-label="允许工作区成员使用"]').getAttribute('aria-checked'),'true');await click('保存 Web 使用策略');await until(()=>env.requests.some(r=>r.method==='PUT'));assert.deepEqual(env.requests.find(r=>r.method==='PUT').body,{allowMemberIds:['member-self'],denyMemberIds:['member-denied'],allowWorkspaceMembers:true});
 document.querySelector('[aria-label="允许工作区成员使用"]').click();await flush();await click('保存 Web 使用策略');await until(()=>env.requests.filter(r=>r.method==='PUT').length===2);assert.deepEqual(env.requests.filter(r=>r.method==='PUT')[1].body,{allowMemberIds:['member-self'],denyMemberIds:['member-denied'],allowWorkspaceMembers:false});
});

test('scope-only draft change is protected when cancelling creation',async t=>{
 let closed=0;const env=await mount(t,'wizard',{workspace,onClose:()=>closed++});await until(()=>!!document.querySelector('input[value=workspace]'));document.querySelector('[aria-label="创建员工可用范围"] input[value=workspace]').click();await flush();await click('取消');assert.equal(closed,0);assert.ok(bodyText().includes('退出将丢弃'));await click('继续填写');assert.equal(closed,0);assert.equal(env.requests.filter(r=>r.method==='POST').length,0);
});

test('unknown creation retries the frozen operation without changing the selected dynamic scope',async t=>{
 let attempts=0;const done=[];const env=await mount(t,'wizard',{workspace,onDone:e=>done.push(e)},async r=>{if(r.url.endsWith('/employee-creations'))return ++attempts===1?{status:503,data:{error:'temporarily_unavailable'}}:{entity:{...entity,name:r.body.name}};return defaults(r);});
 await until(()=>!!document.querySelector('input[aria-label="员工名称"]'));input('员工名称','未知结果员工');await flush();await until(()=>!button('确认创建数字员工').disabled);await click('确认创建数字员工');await until(()=>bodyText().includes('创建结果暂时无法确认'));await click('安全重试');await until(()=>done.length===1);const posts=env.requests.filter(r=>r.url.endsWith('/employee-creations'));assert.equal(posts.length,2);assert.deepEqual(posts[0].body,posts[1].body);assert.equal(posts[0].body.webAccess.allowWorkspaceMembers,false);
});

test('empty model catalog expands inline form, blank name never creates, and no-model creation keeps medium',async t=>{
 const done=[];const env=await mount(t,'wizard',{workspace,onDone:e=>done.push(e)},async r=>r.url.endsWith('/model-profiles')?{profiles:[],defaultProfileId:null}:r.url.endsWith('/employee-creations')?{entity:{...entity,name:r.body.name,modelReady:false}}:defaults(r));
 await until(()=>!!document.querySelector('#creation-model-form'));assert.ok(bodyText().includes('暂不能对话'));assert.equal(button('确认创建数字员工').disabled,true);
 document.querySelector('[data-wizard-step=identity]').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await flush();assert.equal(env.requests.filter(r=>r.method==='POST').length,0);
 input('员工名称','无模型员工');await flush();const create=button('确认创建数字员工');assert.equal(create.disabled,false);create.click();create.click();await until(()=>done.length===1);
 const posts=env.requests.filter(r=>r.url.endsWith('/employee-creations'));assert.equal(posts.length,1);assert.equal(posts[0].body.model,null);assert.equal(posts[0].body.executionThinkingLevel,'medium');assert.deepEqual(posts[0].body.packages,[]);assert.deepEqual(posts[0].body.triggers,[]);assert.equal('channelDraftId' in posts[0].body,false);
});

test('inline model failure retains form, invalidates receipt on edits, and cancellation protects only unsaved state',async t=>{
 let closed=0,failTest=true,failSave=true;const env=await mount(t,'wizard',{workspace,onClose:()=>closed++},async r=>{
  if(r.url.endsWith('/test-connection'))return failTest?{status:400,data:{error:'connection_test_failed'}}:{connectionTestReceipt:'opaque-fixture-receipt',expiresAt:new Date(Date.now()+60000).toISOString()};
  if(r.url.endsWith('/model-profiles')&&r.method==='POST')return failSave?{status:400,data:{error:'invalid_model_profile'}}:{...profile,id:'saved-model'};
  return defaults(r);
 });
 await until(()=>!!document.querySelector('.creation-model-choice'));input('员工名称','保留模型草稿');await click('添加新模型');input('配置名称','新模型');input('模型地址','https://example.invalid/v1');input('模型名称','fixture-model');input('API Key · 只写，不回显','fixture-key-not-real');await flush();assert.equal(button('确认创建数字员工').disabled,true);assert.equal(button('取消').disabled,false);
 await click('联通测试');await until(()=>!!document.querySelector('.model-settings [role=alert]'));assert.equal(document.querySelector('input[aria-label="配置名称"]').value,'新模型');assert.equal(button('保存').disabled,true);
 failTest=false;await click('联通测试');await until(()=>!button('保存').disabled);input('配置名称','改名模型');await flush();assert.equal(button('保存').disabled,true);await click('联通测试');await until(()=>!button('保存').disabled);await click('保存');await until(()=>!button('联通测试').disabled);assert.ok(document.querySelector('#creation-model-form'));assert.equal(document.querySelector('input[aria-label="配置名称"]').value,'改名模型');
 failSave=false;await click('保存');await until(()=>!document.querySelector('#creation-model-form'));assert.equal(document.querySelector('input[aria-label="API Key · 只写，不回显"]'),null);await click('取消');assert.ok(bodyText().includes('已保存的共享模型会保留'));await click('丢弃草稿并退出');assert.equal(closed,1);assert.equal(env.requests.filter(r=>r.url.endsWith('/employee-creations')).length,0);
});

test('catalog read failure offers retry and disabled models never appear available',async t=>{
 let failing=true;const env=await mount(t,'wizard',{workspace},async r=>r.url.endsWith('/model-profiles')?(failing?{status:503,data:{error:'temporarily_unavailable'}}:{profiles:[{...profile,enabled:false}],defaultProfileId:profile.id}):defaults(r));
 await until(()=>!!document.querySelector('.model-settings [role=alert]'));assert.equal(document.querySelector('#creation-model-form'),null);failing=false;await click('重新读取');await until(()=>!!document.querySelector('#creation-model-form'));assert.ok(bodyText().includes('未配置可用模型'));assert.equal(env.requests.filter(r=>r.method==='POST').length,0);
});

test('only thinking changes protect draft and selected advanced value is submitted',async t=>{
 const done=[];let closed=0;const env=await mount(t,'wizard',{workspace,onDone:e=>done.push(e),onClose:()=>closed++},async r=>r.url.endsWith('/employee-creations')?{entity:{...entity,name:r.body.name}}:defaults(r));await until(()=>!!document.querySelector('.creation-model-choice'));
 const advanced=document.querySelector('.wizard-advanced');advanced.open=true;advanced.dispatchEvent(new Event('toggle'));await flush();document.querySelector('[aria-label="思考强度"] .n-base-selection').click();await flush();const option=[...document.querySelectorAll('.n-base-select-option')].find(e=>e.textContent.includes('高'));assert.ok(option);option.click();await flush();await click('取消');assert.equal(closed,0);assert.ok(bodyText().includes('退出将丢弃'));await click('继续填写');input('员工名称','高思考员工');await flush();await click('确认创建数字员工');await until(()=>done.length===1);assert.equal(env.requests.find(r=>r.url.endsWith('/employee-creations')).body.executionThinkingLevel,'high');
});

const accessBase='/workspaces/workspace-a/entities/employee-a';
const accessConnection=(provider='feishu',sourceId='source-a')=>({id:'connection-'+sourceId,sourceId,provider,entityId:'employee-a',appId:'app-'+sourceId,tenantId:'tenant',tenantIdNamespace:'tenant_key',status:'verified',directoryStatus:'available',enabled:true,revision:1,authRevision:1,identityEvidence:'provider_api',inboundVerified:false,transport:{state:'stopped',changedAt:1},context:{historyEnabled:false,meetingRefs:[]}});
const accessRule=(sourceId='source-a',id='person')=>({sourceId,kind:'channel_user',subjectId:JSON.stringify(['channel_user','open_id','app-'+sourceId,id]),conversationKinds:['private']});
test('overview Web access disables member editing without clearing selections, survives tabs and preserves deny on save',async t=>{
 const original={allowMemberIds:['member-self'],denyMemberIds:['hidden-deny'],allowWorkspaceMembers:false,revision:1};let policy={...original};
 const env=await mount(t,'settings',{entity,workspace,section:'access'},async r=>{if(r.url.endsWith('/web-access')){if(r.method==='PUT')policy={...r.body,revision:2};return policy;}if(r.url.endsWith('/configuration-members'))return[{id:'member-self',displayName:'我',role:'owner'}];return defaults(r);});
 await until(()=>!!document.querySelector('.web-chat-access [aria-label="允许成员"]'));assert.equal(document.querySelector('[role=tab][aria-selected=true]').textContent.trim(),'概览');assert.equal(document.querySelectorAll('[role=tablist][aria-label="员工设置分类"] [role=tab]').length,7);
 document.querySelector('[aria-label="允许工作区成员使用"]').click();await flush();assert.ok(document.querySelector('.web-chat-access .n-base-selection').classList.contains('n-base-selection--disabled'));assert.match(document.querySelector('.web-chat-access').textContent,/我/);await tab('模型');await tab('概览');await until(()=>!!document.querySelector('.web-chat-access'));assert.equal(document.querySelector('[aria-label="允许工作区成员使用"]').getAttribute('aria-checked'),'true');
 await click('保存 Web 使用策略');await until(()=>env.requests.some(r=>r.method==='PUT'));assert.deepEqual(env.requests.find(r=>r.method==='PUT').body,{allowMemberIds:['member-self'],denyMemberIds:['hidden-deny'],allowWorkspaceMembers:true});document.querySelector('[aria-label="允许工作区成员使用"]').click();await flush();assert.ok(!document.querySelector('.web-chat-access .n-base-selection').classList.contains('n-base-selection--disabled'));await click('取消 Web 范围修改');assert.equal(document.querySelector('[aria-label="允许工作区成员使用"]').getAttribute('aria-checked'),'true');
 assert.equal(env.requests.some(r=>r.url.endsWith('/directory-access')),false,'Web scope reads no channel policy');
});
test('Web unknown result blocks edits and reconciles saved scope without duplicate writes',async t=>{
 let serverPolicy={allowMemberIds:[],denyMemberIds:[],allowWorkspaceMembers:false,revision:1};const env=await mount(t,'settings',{entity,workspace,section:'overview'},async r=>{if(r.url.endsWith('/web-access')){if(r.method==='PUT'){serverPolicy={...r.body,revision:2};return{status:503,data:{error:'temporarily_unavailable'}};}return serverPolicy;}return defaults(r);});await until(()=>!!document.querySelector('[aria-label="允许工作区成员使用"]'));document.querySelector('[aria-label="允许工作区成员使用"]').click();await flush();await click('保存 Web 使用策略');await until(()=>bodyText().includes('保存结果尚未确认'));assert.equal(button('保存 Web 使用策略').disabled,true);await click('读取服务器配置并核对');await until(()=>!bodyText().includes('保存结果尚未确认'));assert.equal(button('取消 Web 范围修改').disabled,true);assert.equal(env.requests.filter(r=>r.method==='PUT').length,1);
});
test('channel detail saves only current source and preserves historical scenes; unavailable directory keeps removable rules',async t=>{
 const a=accessRule(),b=accessRule('source-b');let policy={allow:[a,b],deny:[{...a,subjectId:'opaque-denied'}],allowGroupMembers:false,revision:3};const env=await mount(t,'channelAccess',{base:accessBase,connection:accessConnection(),canManage:true},async r=>{if(r.method==='PATCH'){policy={...policy,allowGroupMembers:r.body.allowGroupMembers,revision:4};return policy;}return policy;});await until(()=>!!document.querySelector('.directory-access-form'));assert.equal(document.querySelector('[aria-label="允许渠道用户或部门渠道来源"]'),null);assert.equal(document.querySelectorAll('.directory-rule-detail').length,2);assert.equal(document.querySelector('.directory-rule-detail .n-checkbox-group'),null);
 document.querySelector('[aria-label="允许群成员在群内使用"]').click();await flush();await click('保存渠道使用策略');await until(()=>env.requests.some(r=>r.method==='PATCH'));assert.deepEqual(env.requests.find(r=>r.method==='PATCH').body,{sourceId:'source-a',mode:'allowlist',allow:[a],deny:[{...a,subjectId:'opaque-denied'}],expectedRevision:3,allowGroupMembers:true});
 env.props.connection={...accessConnection(),directoryStatus:'unavailable'};await flush();assert.ok(bodyText().includes('暂不能新增'));assert.equal(button('查询当前目录').disabled,true);await click('移除此规则');assert.equal(document.querySelectorAll('.directory-rule-detail').length,1);await click('取消渠道范围修改');assert.equal(document.querySelectorAll('.directory-rule-detail').length,2);
});
test('channel policy conflicts preserve draft and late responses cannot replace another source',async t=>{
 let release;const held=new Promise(r=>release=r);const env=await mount(t,'channelAccess',{base:accessBase,connection:accessConnection(),canManage:true},async r=>{if(r.method==='PATCH')return{status:409,data:{error:'directory_policy_changed'}};if(r.url.endsWith('/directory-access')){if(!release)return{allow:[],deny:[],revision:0};return{allow:[accessRule()],deny:[],revision:3};}return[];});await until(()=>!!document.querySelector('.directory-access-form'));await click('移除此规则');await click('保存渠道使用策略');await until(()=>!!document.querySelector('[role=alert]'));assert.equal(document.querySelectorAll('.directory-rule-detail').length,0);assert.equal(button('取消渠道范围修改').disabled,false);
 globalThis.fetch=async()=>{await held;return new Response(JSON.stringify({allow:[accessRule()],deny:[],revision:99}),{headers:{'content-type':'application/json'}});};button('读取服务器配置并核对').click();await flush();env.props.connection=accessConnection('dingtalk','source-b');await flush();release();await flush();assert.ok(document.querySelector('[aria-label="允许群成员在群内使用"]'));assert.equal(document.querySelectorAll('.directory-rule-detail').length,0);
});
test('channel list has no policy forms; detail and provider switching protect unsaved scope',async t=>{
 const connections=[accessConnection(),accessConnection('dingtalk','source-b')];const env=await mount(t,'channel',{base:accessBase,canManage:true},async r=>r.url.endsWith('/channels')?connections:r.url.endsWith('/directory-access')?{allow:[accessRule()],deny:[],revision:1}:defaults(r));await until(()=>document.querySelectorAll('.connection-list .n-card').length===2);assert.equal(document.querySelector('.channel-access-settings'),null);await click('查看此连接');await until(()=>!!document.querySelector('.directory-access-form'));await click('移除此规则');assert.ok([...document.querySelectorAll('.channel-actions button')].every(b=>b.disabled),'connection mutations are visibly disabled while scope is dirty');
 const ding=[...document.querySelectorAll('[role=tablist][aria-label="员工渠道"] [role=tab]')].find(e=>e.textContent.trim()==='钉钉');ding.click();await flush();assert.ok(bodyText().includes('当前渠道有未保存的修改'));assert.match(document.querySelector('.channel-access-settings').textContent,/飞书/);assert.equal(ding.getAttribute('aria-selected'),'false');await click('继续编辑当前渠道');await click('返回连接列表');await click('放弃策略修改并切换');await until(()=>!document.querySelector('.channel-access-settings'));assert.equal(env.requests.some(r=>r.method==='PATCH'),false);
});
test('overview Web adds a workspace person, preserves draft on failure and cancels locally',async t=>{
 const env=await mount(t,'settings',{entity,workspace,section:'overview'},async r=>{if(r.url.endsWith('/web-access'))return r.method==='PUT'?{status:400,data:{error:'invalid_workspace_member'}}:{allowMemberIds:[],denyMemberIds:[],revision:1};if(r.url.endsWith('/configuration-members'))return[{id:'member-new',displayName:'新成员',role:'member'}];return defaults(r);});await until(()=>!!document.querySelector('.web-chat-access .n-base-selection'));const trigger=document.querySelector('.web-chat-access .n-base-selection');trigger.click();await flush();trigger.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));await flush();trigger.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await flush();assert.match(document.querySelector('.web-chat-access .n-select').textContent,/新成员/);await click('保存 Web 使用策略');await until(()=>!!document.querySelector('.web-chat-access [role=alert]'));assert.deepEqual(env.requests.find(r=>r.method==='PUT').body.allowMemberIds,['member-new']);assert.match(document.querySelector('.web-chat-access .n-select').textContent,/新成员/);await click('取消 Web 范围修改');assert.doesNotMatch(document.querySelector('.web-chat-access .n-select').textContent,/新成员/);assert.equal(env.requests.filter(r=>r.method==='PUT').length,1);
});
test('overview Web ignores a late policy from another employee while overview stays available',async t=>{
 let release;const held=new Promise(r=>release=r);t.after(()=>release());const env=await mount(t,'settings',{entity,workspace,section:'overview'},async r=>{if(r.url.endsWith('/web-access')){if(r.url.includes('/employee-a/'))await held;return r.url.includes('/employee-a/')?{allowMemberIds:['old-person'],denyMemberIds:[],revision:99}:{allowMemberIds:['new-person'],denyMemberIds:[],revision:1};}if(r.url.endsWith('/configuration-members'))return[{id:'new-person',displayName:'新员工可用成员',role:'member'}];return defaults(r);});env.props.entity={...entity,id:'employee-b',name:'第二位员工'};await until(()=>document.querySelector('.web-chat-access .n-select')?.textContent.includes('新员工可用成员'));release();await flush();assert.doesNotMatch(document.querySelector('.web-chat-access .n-select').textContent,/old-person/);assert.ok(document.querySelector('.employee-purpose'));assert.equal(env.requests.filter(r=>r.method==='PUT').length,0);
});
test('overview Web read failure remains local and supports retry without blocking employee facts',async t=>{
 let failing=true;const env=await mount(t,'settings',{entity,workspace,section:'overview'},async r=>r.url.endsWith('/web-access')?(failing?{status:503,data:{error:'temporarily_unavailable'}}:{allowMemberIds:[],denyMemberIds:[],revision:1}):defaults(r));await until(()=>!!document.querySelector('.web-chat-access [role=alert]'));assert.ok(document.querySelector('.employee-purpose'));assert.ok(document.querySelector('.employee-next-step'));assert.equal(document.querySelector('.web-chat-access .n-select'),null);failing=false;await click('重新读取 Web 范围');await until(()=>!!document.querySelector('.web-chat-access .n-select'));assert.equal(env.requests.filter(r=>r.method==='PUT').length,0);
});

test('omitted false workspace flag stays controlled after cancel, save and reread',async t=>{
 let policy={allowMemberIds:['member-self'],denyMemberIds:['hidden-deny'],revision:1};
 const env=await mount(t,'settings',{entity,workspace,section:'overview'},async r=>{if(r.url.endsWith('/web-access')){if(r.method==='PUT'){policy={allowMemberIds:r.body.allowMemberIds,denyMemberIds:r.body.denyMemberIds,revision:policy.revision+1,...(r.body.allowWorkspaceMembers?{allowWorkspaceMembers:true}:{})};}return policy;}return defaults(r);});
 await until(()=>!!document.querySelector('[aria-label="允许工作区成员使用"]'));
 const check=()=>document.querySelector('[aria-label="允许工作区成员使用"]');assert.equal(check().getAttribute('aria-checked'),'false');
 check().click();await flush();assert.equal(check().getAttribute('aria-checked'),'true');await click('取消 Web 范围修改');assert.equal(check().getAttribute('aria-checked'),'false');
 check().click();await flush();await click('保存 Web 使用策略');await until(()=>policy.allowWorkspaceMembers===true);
 check().click();await flush();await click('保存 Web 使用策略');await until(()=>policy.allowWorkspaceMembers===undefined&&policy.revision===3);assert.equal(check().getAttribute('aria-checked'),'false');
 await click('读取服务器配置并核对');assert.equal(check().getAttribute('aria-checked'),'false');assert.equal(button('保存 Web 使用策略').disabled,true);
 assert.deepEqual(policy.denyMemberIds,['hidden-deny']);assert.equal(env.requests.filter(r=>r.method==='PUT').length,2);
});


const confirmationTarget={kind:'platform',userId:'fixture-confirmation-person'};
function confirmationPolicy(rules=[]){return{version:7,rules,candidates:[{label:'测试确认人',target:confirmationTarget}],subjects:{sources:[],users:[],departments:[]}};}
const confirmationInput=()=>document.querySelector('input[aria-label="确认问题范围"]');

test('human confirmation collapse retains draft, dirty navigation protection and lazy loading',async t=>{
 let recent=0;const locked=[];
 const env=await mount(t,'settings',{entity,workspace,section:'overview',onBusyChanged:v=>locked.push(v),onRecentConversations:()=>recent++},async r=>r.url.endsWith('/human-confirmation')?confirmationPolicy():defaults(r));
 await until(()=>!!document.querySelector('.employee-extensions'));
 assert.equal(env.requests.filter(r=>r.url.endsWith('/human-confirmation')).length,0);
 await click('人工确认');await until(()=>!button('添加确认规则').disabled);await click('添加确认规则');input('确认问题范围','采购审批');await flush();
 const panel=document.querySelector('.human-settings');const draft=confirmationInput();
 assert.equal(locked.at(-1),true);
 for(let i=0;i<2;i++){
  await click('人工确认');assert.ok(document.querySelector('.human-settings')===panel,'collapse must retain the mounted panel');assert.equal(visible(panel),false);
  assert.equal(locked.at(-1),true);assert.ok(document.querySelector('.employee-dirty-banner'));
  await click('人工确认');assert.equal(visible(panel),true);assert.ok(confirmationInput()===draft,'collapse must retain the input and its draft');assert.equal(draft.value,'采购审批');
  assert.equal(button('人工确认').getAttribute('aria-expanded'),'true');
 }
 await click('人工确认');await tab('模型');await tab('概览');
 assert.equal(visible(panel),false);assert.equal(locked.at(-1),true);
 await click('最近对话');assert.equal(recent,0);assert.match(bodyText(),/确定丢弃并离开当前员工/);await click('继续编辑员工');
 await click('人工确认');assert.equal(draft.value,'采购审批');assert.match(panel.textContent,/测试确认人/);
 assert.equal(env.requests.filter(r=>r.url.endsWith('/human-confirmation')).length,1);
 assert.equal(env.requests.filter(r=>r.method==='PUT').length,0);
});

test('human confirmation collapse during save retains busy lock and applies the single response',async t=>{
 let release;const pending=new Promise(resolve=>release=resolve);t.after(()=>release());const locked=[];
 const env=await mount(t,'settings',{entity,workspace,section:'overview',onBusyChanged:v=>locked.push(v)},async r=>{
  if(!r.url.endsWith('/human-confirmation'))return defaults(r);
  if(r.method==='PUT'){await pending;return{version:8,rules:r.body.rules};}
  return confirmationPolicy();
 });
 await until(()=>!!document.querySelector('.employee-extensions'));await click('人工确认');await until(()=>!button('添加确认规则').disabled);await click('添加确认规则');input('确认问题范围','付款确认');await flush();
 await click('保存确认设置');await until(()=>env.requests.some(r=>r.method==='PUT'));
 const panel=document.querySelector('.human-settings');await click('人工确认');
 assert.ok(document.querySelector('.human-settings')===panel,'collapse must retain the mounted panel');assert.equal(visible(panel),false);assert.equal(locked.at(-1),true);
 assert.equal(button('返回员工列表').disabled,true);assert.equal(button('最近对话').disabled,true);
 await tab('模型');assert.equal(document.querySelector('[role=tab][aria-selected=true]').textContent.trim(),'概览');
 await click('人工确认');assert.equal(button('保存确认设置').disabled,true);await click('保存确认设置');await click('人工确认');
 assert.equal(env.requests.filter(r=>r.method==='PUT').length,1);
 release();await until(()=>locked.at(-1)===false);await click('人工确认');
 assert.match(panel.textContent,/人工确认接收人已保存/);assert.equal(confirmationInput().value,'付款确认');assert.equal(button('保存确认设置').disabled,true);
 assert.equal(document.querySelector('.employee-dirty-banner'),null);
 assert.deepEqual(env.requests.find(r=>r.method==='PUT').body,{expectedVersion:7,rules:[{questionScope:'付款确认',target:confirmationTarget}]});
 assert.equal(env.requests.filter(r=>r.url.endsWith('/human-confirmation')&&r.method==='GET').length,1);
});

test('human confirmation save failure while collapsed retains draft until explicit discard',async t=>{
 let release;const pending=new Promise(resolve=>release=resolve);t.after(()=>release());const locked=[];
 const env=await mount(t,'settings',{entity,workspace,section:'overview',onBusyChanged:v=>locked.push(v)},async r=>{
  if(!r.url.endsWith('/human-confirmation'))return defaults(r);
  if(r.method==='PUT'){await pending;return{status:409,data:{error:'version_conflict'}};}
  return confirmationPolicy();
 });
 await until(()=>!!document.querySelector('.employee-extensions'));await click('人工确认');await until(()=>!button('添加确认规则').disabled);await click('添加确认规则');input('确认问题范围','待核对草稿');await flush();
 await click('保存确认设置');await click('人工确认');release();await until(()=>!!document.querySelector('.human-settings [role=alert]'));
 assert.equal(locked.at(-1),true);assert.ok(document.querySelector('.employee-dirty-banner'));await click('人工确认');assert.equal(confirmationInput().value,'待核对草稿');
 await click('放弃更改');await until(()=>locked.at(-1)===false);assert.equal(confirmationInput(),null);assert.equal(document.querySelector('.employee-dirty-banner'),null);
 await click('人工确认');await click('人工确认');assert.equal(confirmationInput(),null);
 assert.equal(env.requests.filter(r=>r.method==='PUT').length,1);assert.equal(env.requests.filter(r=>r.url.endsWith('/human-confirmation')&&r.method==='GET').length,2);
});

test('standalone overview retains the confirmation panel without a Web slot and resets it for a different employee',async t=>{
 const base='/workspaces/workspace-a/entities/employee-a';const dirty=[];
 const env=await mount(t,'overview',{base,canManage:true,onDirtyChanged:v=>dirty.push(v)},async r=>r.url.endsWith('/human-confirmation')?confirmationPolicy():defaults(r));
 await until(()=>!!document.querySelector('.employee-extensions'));await click('人工确认');await until(()=>!button('添加确认规则').disabled);await click('添加确认规则');input('确认问题范围','旧员工草稿');await flush();
 const panel=document.querySelector('.human-settings');await click('人工确认');assert.ok(document.querySelector('.human-settings')===panel,'collapse must retain the mounted panel');assert.equal(visible(panel),false);assert.equal(dirty.at(-1),true);
 env.props.base='/workspaces/workspace-a/entities/employee-b';await until(()=>!document.querySelector('.human-settings')&&!!document.querySelector('.employee-extensions'));
 assert.equal(dirty.at(-1),false);assert.equal(env.requests.filter(r=>r.url.endsWith('/human-confirmation')).length,1);
 await click('人工确认');await until(()=>!button('添加确认规则').disabled);assert.ok(document.querySelector('.human-settings')!==panel,'a different employee must get a fresh panel');assert.equal(confirmationInput(),null);
 assert.equal(env.requests.filter(r=>r.url.endsWith('/human-confirmation')).length,2);
 env.props.canManage=false;await until(()=>!document.querySelector('.human-settings'));assert.equal(document.querySelector('.overview-access-stack'),null);
 assert.equal(env.requests.filter(r=>r.method==='PUT').length,0);
});
