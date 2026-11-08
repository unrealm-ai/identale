import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {existsSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Window} from 'happy-dom';
import {build} from 'esbuild';
import {parse,compileScript} from '@vue/compiler-sfc';
const window=new Window({url:'http://127.0.0.1:5173/'});
for(const name of ['window','document','navigator','Node','ShadowRoot','Document','Element','HTMLElement','SVGElement','Event','MouseEvent','KeyboardEvent','InputEvent','FocusEvent','PointerEvent','Image','HTMLTextAreaElement','HTMLInputElement','getComputedStyle','MutationObserver','ResizeObserver','requestAnimationFrame','cancelAnimationFrame'])Object.defineProperty(globalThis,name,{value:name==='window'?window:window[name],configurable:true});
const {createApp,h,reactive,nextTick}=await import('vue');
const dir=await mkdtemp(resolve('apps/web/.capability-ui-test-'));
await build({entryPoints:{Access:'apps/web/src/features/employees/AccessSettings.vue',Receiver:'apps/web/src/features/employees/HandoffAccessSettings.vue',Editor:'apps/web/src/features/employees/CapabilityPackageEditor.vue',List:'apps/web/src/features/employees/CapabilityPackageList.vue',Trigger:'apps/web/src/features/employees/TriggerSettings.vue',helpers:'apps/web/src/features/employees/capability-package-view.ts'},outdir:dir,outExtension:{'.js':'.mjs'},bundle:true,platform:'node',format:'esm',external:['vue','naive-ui'],plugins:[{name:'vue',setup(builder){builder.onLoad({filter:/\.vue$/},async({path})=>{const {descriptor}=parse(await readFile(path,'utf8'),{filename:path});return{contents:compileScript(descriptor,{id:path,inlineTemplate:true,fs:{fileExists:existsSync,readFile:f=>readFileSync(f,'utf8')}}).content,loader:'ts',resolveDir:resolve(path,'..')};});}}]});
const Access=(await import(pathToFileURL(join(dir,'Access.mjs')))).default;
const Receiver=(await import(pathToFileURL(join(dir,'Receiver.mjs')))).default;
const Editor=(await import(pathToFileURL(join(dir,'Editor.mjs')))).default,List=(await import(pathToFileURL(join(dir,'List.mjs')))).default;
const Trigger=(await import(pathToFileURL(join(dir,'Trigger.mjs')))).default;
const {emptyPackage,packageEditor,packageInput,packageUserMode,packageChannelPolicies}=await import(pathToFileURL(join(dir,'helpers.mjs')));
test.after(async()=>{await rm(dir,{recursive:true,force:true});await window.happyDOM.close();});
const resources=[{id:'skill-a',kind:'skill',resourceId:'skill-a',version:'1',digest:'synthetic',name:'合成文章Skill'},{id:'skill-b',kind:'skill',resourceId:'skill-b',version:'2',digest:'synthetic',name:'合成摘要Skill'},{id:'mcp-a',kind:'mcp',serverRef:'server-a',allowedTools:['alpha'],name:'合成工具甲'},{id:'mcp-b',kind:'mcp',serverRef:'server-b',allowedTools:['beta'],name:'合成工具乙'},{id:'shell',kind:'execution',resourceId:'shell-r',version:'1',tools:['read','bash']}];
const member={id:'member-a',userId:'user-a',displayName:'合成成员甲',role:'member'};
const flush=async()=>{await new Promise(r=>setTimeout(r,20));await nextTick();};
async function until(predicate){for(let n=0;n<100;n++){await flush();if(predicate())return;}assert.fail(document.body.textContent);}
function button(label){const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===label);assert.ok(b,label);return b;}
function input(label,value){const field=document.querySelector(`input[aria-label="${label}"]`);assert.ok(field,label);field.value=value;field.dispatchEvent(new InputEvent('input',{bubbles:true,data:value}));}
function visible(element){for(let el=element;el instanceof HTMLElement;el=el.parentElement)if(el.hidden||el.style.display==='none'||el.getAttribute('aria-hidden')==='true')return false;return true;}
async function choose(label,option){const control=document.querySelector(`[aria-label="${label}"]`);assert.ok(control,label);const trigger=control.closest('.n-select').querySelector('.n-base-selection');const item=()=>[...document.querySelectorAll('.n-base-select-option')].find(i=>i.textContent.includes(option)&&visible(i));if(!item()||!control.closest('.n-select').classList.contains('n-select--active')){trigger.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));trigger.click();await flush();}await until(()=>item());item().click();await flush();}
async function mount(t,component,values){document.body.innerHTML='<div id="app"></div>';const props=reactive(values),events=[];const app=createApp({render:()=>h(component,{...props,onChange:v=>events.push(['change',v]),onSubmit:v=>events.push(['submit',v]),onClose:()=>events.push(['close']),onEdit:key=>events.push(['edit',key]),onToggle:key=>events.push(['toggle',key])})});app.mount('#app');await flush();t.after(()=>{app.unmount();document.body.innerHTML='';});return{props,events};}
const editorProps=(value=emptyPackage())=>({show:true,value,resources,members:[member],subjects:{sources:[],users:[],departments:[]},base:'/workspaces/synthetic',draft:true,busy:false});
async function save(){document.querySelector('.package-editor form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await flush();}

test('employee receiver toggles one active list, saves both values, and the all switch only hides configuration',async t=>{
 const originalFetch=globalThis.fetch,requests=[];let policy={version:1,allowAll:false,scope:{mode:'allowlist',selectionMode:'allowlist',allowEmployeeIds:['A'],denyEmployeeIds:['B']}};
 globalThis.fetch=async(url,init={})=>{if(init.method==='PUT'){const input=JSON.parse(init.body);requests.push(input);assert.equal(input.expectedVersion,policy.version);policy={version:policy.version+1,allowAll:input.allowAll,scope:input.scope};}return{ok:true,status:200,json:async()=>JSON.parse(JSON.stringify(String(url).endsWith('/handoff-options')?[{id:'A',name:'员工甲',enabled:true},{id:'B',name:'员工乙',enabled:true}]:policy))};};t.after(()=>globalThis.fetch=originalFetch);
 await mount(t,Receiver,{base:'/workspaces/synthetic/entities/receiver',disabled:false});await until(()=>document.querySelector('[aria-label="允许交接的来源员工"]'));
 assert.equal(document.querySelector('[aria-label="拒绝交接的来源员工"]'),null);await choose('员工交接接收策略','拒绝名单');assert.equal(document.querySelector('[aria-label="允许交接的来源员工"]'),null);assert.ok(document.querySelector('[aria-label="拒绝交接的来源员工"]'));button('保存交接接收范围').click();await until(()=>requests.length===1&&document.body.textContent.includes('已保存员工接收范围'));
 assert.equal(policy.scope.selectionMode,'denylist');assert.deepEqual(policy.scope.allowEmployeeIds,['A']);assert.deepEqual(policy.scope.denyEmployeeIds,['B']);
 document.querySelector('[aria-label="允许全部员工交接"]').click();await flush();assert.equal(document.querySelector('[aria-label="员工交接接收策略"]'),null);button('保存交接接收范围').click();await until(()=>requests.length===2&&policy.allowAll);assert.deepEqual(policy.scope.denyEmployeeIds,['B']);
 document.querySelector('[aria-label="允许全部员工交接"]').click();await flush();assert.ok(document.querySelector('[aria-label="拒绝交接的来源员工"]'));await choose('员工交接接收策略','允许名单');assert.ok(document.querySelector('[aria-label="允许交接的来源员工"]'));assert.equal(document.querySelector('[aria-label="拒绝交接的来源员工"]'),null);button('取消修改').click();await flush();assert.equal(document.querySelector('[aria-label="员工交接接收策略"]'),null,'Cancel restores saved all-switch state');
});
test('user list mode switching keeps both lists, hides inactive controls and survives saved reopening',async t=>{
 const value={...emptyPackage(),name:'名单切换',userPolicyMode:'allowlist',mode:'restrict',allowMemberIds:['member-a'],denyMemberIds:['member-b']},e=await mount(t,Editor,editorProps(value));
 const radio=label=>[...document.querySelectorAll('.n-radio')].find(r=>r.textContent.includes(label));
 assert.ok(document.querySelector('[aria-label="包内允许成员"]'));assert.equal(document.querySelector('[aria-label="包内拒绝成员"]'),null);
 radio('拒绝名单').click();await flush();assert.equal(document.querySelector('[aria-label="包内允许成员"]'),null);assert.ok(document.querySelector('[aria-label="包内拒绝成员"]'));await save();
 let saved=e.events.filter(v=>v[0]==='submit').at(-1)[1];assert.equal(saved.userPolicyMode,'denylist');assert.deepEqual(saved.allowMemberIds,['member-a']);assert.deepEqual(saved.denyMemberIds,['member-b']);
 e.props.show=false;await flush();e.props.value=packageEditor(packageInput(saved));e.props.show=true;await flush();assert.ok(document.querySelector('[aria-label="包内拒绝成员"]'));assert.equal(document.querySelector('[aria-label="包内允许成员"]'),null);
 radio('继承员工使用范围').click();await flush();assert.equal(document.querySelector('[aria-label="包内拒绝成员"]'),null);await save();saved=e.events.filter(v=>v[0]==='submit').at(-1)[1];assert.equal(saved.userPolicyMode,'inherit');assert.deepEqual(saved.allowMemberIds,['member-a']);assert.deepEqual(saved.denyMemberIds,['member-b']);
 radio('允许名单').click();await flush();await save();saved=e.events.filter(v=>v[0]==='submit').at(-1)[1];assert.equal(saved.userPolicyMode,'allowlist');assert.deepEqual(saved.allowMemberIds,['member-a']);assert.deepEqual(value.denyMemberIds,['member-b']);
});
test('Trigger and package handoff have all, white and black choices without deleting inactive values',async t=>{
 const e=await mount(t,Editor,{...editorProps({...emptyPackage(),name:'互斥来源',triggerUsageScope:{mode:'allowlist',selectionMode:'allowlist',allowTriggerIds:['trigger-a'],denyTriggerIds:['trigger-b']},handoffUsageMode:'custom',handoffUsageScope:{mode:'allowlist',selectionMode:'allowlist',allowEmployeeIds:['A'],denyEmployeeIds:['B']}}),handoffEnabled:true,handoffOptions:[{id:'A',name:'员工甲',enabled:true},{id:'B',name:'员工乙',enabled:true}],triggerOptions:[{id:'trigger-a',name:'自动化甲',enabled:true},{id:'trigger-b',name:'自动化乙',enabled:true}]});
 assert.ok(document.querySelector('[aria-label="允许的自动化任务"]'));assert.equal(document.querySelector('[aria-label="拒绝的自动化任务"]'),null);assert.ok(document.querySelector('[aria-label="允许交接的员工"]'));assert.equal(document.querySelector('[aria-label="拒绝交接的员工"]'),null);
 await choose('自动化任务使用策略','拒绝名单');await choose('数字员工交接使用策略','拒绝名单');assert.equal(document.querySelector('[aria-label="允许的自动化任务"]'),null);assert.equal(document.querySelector('[aria-label="允许交接的员工"]'),null);assert.ok(document.querySelector('[aria-label="拒绝的自动化任务"]'));assert.ok(document.querySelector('[aria-label="拒绝交接的员工"]'));await save();
 let saved=e.events.filter(v=>v[0]==='submit').at(-1)[1];assert.equal(saved.triggerUsageScope.selectionMode,'denylist');assert.equal(saved.handoffUsageScope.selectionMode,'denylist');assert.deepEqual(saved.triggerUsageScope.allowTriggerIds,['trigger-a']);assert.deepEqual(saved.handoffUsageScope.allowEmployeeIds,['A']);
 await choose('自动化任务使用策略','当前员工全部自动化任务');await choose('数字员工交接使用策略','员工接收范围内全部来源');assert.equal(document.querySelector('[aria-label="拒绝的自动化任务"]'),null);assert.equal(document.querySelector('[aria-label="拒绝交接的员工"]'),null);await save();saved=e.events.filter(v=>v[0]==='submit').at(-1)[1];assert.equal(saved.triggerUsageScope.selectionMode,'all');assert.equal(saved.handoffUsageScope.selectionMode,'all');assert.deepEqual(saved.triggerUsageScope.denyTriggerIds,['trigger-b']);assert.deepEqual(saved.handoffUsageScope.denyEmployeeIds,['B']);
});
test('legacy combined rules and missing/empty/meeting conversation fields round-trip without changing authorization',()=>{
  const raw={name:'旧包',enabled:true,mode:'restrict',allowMemberIds:['member-a'],denyMemberIds:['member-b'],resourceIds:['shell','missing'],directoryAccess:{allow:[],deny:[]}};
  const value=packageEditor(raw);assert.equal(packageUserMode(value),'legacy');assert.equal(value.conversationKinds,null);assert.deepEqual(packageInput(value),{...raw,description:''});
  assert.deepEqual(packageInput(packageEditor({...raw,conversationKinds:[]})).conversationKinds,[]);
  assert.deepEqual(packageInput(packageEditor({...raw,conversationKinds:['meeting']})).conversationKinds,['meeting']);
});
test('multiple package cards independently list several named skills and MCPs and retain execution resources',async t=>{
  const a={...emptyPackage(),key:'a',name:'文章能力包',resourceIds:['skill-a','skill-b','mcp-a','mcp-b','shell'],allowMemberIds:[],denyMemberIds:[]},b={...emptyPackage(),key:'b',name:'另一个包',enabled:false};
  const e=await mount(t,List,{packages:[a,b],resources,members:[member],disabled:false});assert.equal(document.querySelectorAll('.capability-package-card').length,2);
  const first=document.querySelector('.capability-package-card');assert.match(first.textContent,/Skill · 2/);assert.match(first.textContent,/MCP · 2/);assert.match(first.textContent,/合成文章Skill/);assert.match(first.textContent,/合成工具乙/);assert.match(first.textContent,/私聊、群聊/);
  button('编辑 文章能力包').click();button('启用').click();await flush();assert.deepEqual(e.events,[['edit','a'],['toggle','b']]);
});
test('resource editor selects multiple skills and MCPs while preserving existing advanced and unavailable resources',async t=>{
  const value={...emptyPackage(),name:'合成多资源包',resourceIds:['shell','missing']},e=await mount(t,Editor,editorProps(value));
  await choose('能力包Skill','合成文章Skill');await choose('能力包Skill','合成摘要Skill');await choose('能力包MCP','合成工具甲');await choose('能力包MCP','合成工具乙');await save();
  const result=e.events.find(v=>v[0]==='submit')[1];assert.deepEqual(new Set(result.resourceIds),new Set(['shell','missing','skill-a','skill-b','mcp-a','mcp-b']));assert.deepEqual(value.resourceIds,['shell','missing']);
});
test('canceling a changed editor confirms discard and never mutates parent draft or emits save',async t=>{
  const value={...emptyPackage(),name:'原始草稿'},e=await mount(t,Editor,editorProps(value));input('能力包名称','未保存修改');await flush();button('返回列表').click();await flush();assert.match(document.body.textContent,/丢弃本次未保存/);assert.equal(value.name,'原始草稿');assert.equal(e.events.length,0);button('继续编辑').click();await flush();assert.equal(document.querySelector('input[aria-label="能力包名称"]').value,'未保存修改');button('返回列表').click();await flush();button('丢弃修改并返回列表').click();assert.deepEqual(e.events,[['close']]);
});
test('switching complex historical user policy requires explicit conversion and never clears rules on resource edits',async t=>{
  const value={...emptyPackage(),name:'复杂旧包',mode:'restrict',allowMemberIds:['member-a'],denyMemberIds:['member-b'],conversationKinds:['meeting']},e=await mount(t,Editor,editorProps(value));assert.match(document.body.textContent,/历史组合策略/);
  await choose('能力包Skill','合成文章Skill');await save();let result=e.events.find(v=>v[0]==='submit')[1];assert.deepEqual(result.allowMemberIds,['member-a']);assert.deepEqual(result.denyMemberIds,['member-b']);assert.deepEqual(result.conversationKinds,['meeting']);
  [...document.querySelectorAll('.n-radio')].find(r=>r.textContent.includes('继承员工使用范围')).click();await flush();assert.match(document.body.textContent,/切换策略后仅选中名单生效/);button('保留原策略').click();await flush();await save();result=e.events.filter(v=>v[0]==='submit').at(-1)[1];assert.deepEqual(result.denyMemberIds,['member-b']);
});
test('an empty allowlist remains deny-by-default and an explicit empty conversation list is saved as empty',async t=>{
  const e=await mount(t,Editor,editorProps({...emptyPackage(),name:'空允许包',mode:'restrict',conversationKinds:[]}));assert.match(document.body.textContent,/不适用于任何会话/);await save();const value=e.events.find(v=>v[0]==='submit')[1];assert.equal(value.mode,'restrict');assert.deepEqual(value.allowMemberIds,[]);assert.deepEqual(value.conversationKinds,[]);
});
test('denylist radio remains editable when its first deny entry has not yet been added',async t=>{
  const e=await mount(t,Editor,editorProps({...emptyPackage(),name:'拒绝包'}));[...document.querySelectorAll('.n-radio')].find(r=>r.textContent.includes('拒绝名单')).click();await flush();assert.ok(document.querySelector('[aria-label="包内拒绝成员"]'));await choose('包内拒绝成员','合成成员甲');await save();const value=e.events.find(v=>v[0]==='submit')[1];assert.equal(value.mode,'inherit');assert.deepEqual(value.denyMemberIds,[member.id]);
});
test('in-flight editor disables saving and returning; Escape in IME or input cannot discard draft',async t=>{
  const e=await mount(t,Editor,editorProps({...emptyPackage(),name:'编辑包'}));const field=document.querySelector('input[aria-label="能力包名称"]');field.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',isComposing:true,bubbles:true}));await flush();assert.equal(e.events.length,0);assert.doesNotMatch(document.body.textContent,/丢弃本次未保存/);e.props.busy=true;await flush();assert.equal(button('保存包草稿').disabled,true);assert.equal(button('返回列表').disabled,true);button('保存包草稿').click();button('返回列表').click();assert.equal(e.events.length,0);
});
test('two immediate submit events emit one package save, including the draft path',async t=>{
  const e=await mount(t,Editor,editorProps({...emptyPackage(),name:'单次草稿'})),form=document.querySelector('.package-editor form');
  form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await flush();assert.equal(e.events.filter(v=>v[0]==='submit').length,1);
});

test('Escape from initial drawer header focus closes cleanly or confirms unsaved changes',async t=>{
  const e=await mount(t,Editor,editorProps({...emptyPackage(),name:'标题栏返回'}));
  const header=document.querySelector('.n-drawer-header__close');assert.ok(header);header.focus();header.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await flush();assert.deepEqual(e.events,[['close']]);
  e.events.length=0;input('能力包名称','未保存标题栏修改');await flush();header.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await flush();assert.equal(e.events.length,0);assert.match(document.body.textContent,/丢弃本次未保存/);assert.equal(e.props.value.name,'标题栏返回');
});
test('Trigger usage dimension keeps default all and explicit empty allowlist distinct without touching human rules',async t=>{const raw={name:'旧包',enabled:true,mode:'restrict',allowMemberIds:['member-a'],denyMemberIds:['member-b'],resourceIds:[],conversationKinds:['meeting']};assert.equal(packageInput(packageEditor(raw)).triggerUsageScope,undefined);const e=await mount(t,Editor,{...editorProps(packageEditor(raw)),triggerOptions:[{id:'trigger-a',name:'自动化任务甲',enabled:true},{id:'trigger-b',name:'自动化任务乙',enabled:false}]});await choose('自动化任务使用策略','允许名单');await save();let value=e.events.find(e=>e[0]==='submit')[1];assert.deepEqual(value.triggerUsageScope,{mode:'allowlist',selectionMode:'allowlist',allowTriggerIds:[],denyTriggerIds:[]});assert.deepEqual(value.allowMemberIds,['member-a']);assert.deepEqual(value.denyMemberIds,['member-b']);assert.deepEqual(value.conversationKinds,['meeting']);await choose('允许的自动化任务','自动化任务甲');document.querySelector('[aria-label="允许的自动化任务"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await flush();assert.equal(document.querySelector('[aria-label="拒绝的自动化任务"]'),null);await choose('自动化任务使用策略','拒绝名单');await choose('拒绝的自动化任务','自动化任务甲');await save();value=e.events.filter(e=>e[0]==='submit').at(-1)[1];assert.deepEqual(value.triggerUsageScope,{mode:'all',selectionMode:'denylist',allowTriggerIds:['trigger-a'],denyTriggerIds:['trigger-a']});});

test('Trigger draft defaults disabled and Beijing Cron, no configuration persists before final employee creation; cancel preserves saved draft',async t=>{const e=await mount(t,Trigger,{base:'/workspaces/synthetic',draft:true,disabled:false});button('新增自动化任务草稿').click();await flush();input('自动化任务标题','自动工单');await choose('何时执行','按时间执行');await flush();assert.equal(document.querySelector('input[aria-label="使用时区"]').value,'Asia/Shanghai');assert.equal([...document.querySelectorAll('.n-checkbox')].find(c=>c.textContent.includes('启用此自动化任务')).getAttribute('aria-checked'),'false');const field=document.querySelector('textarea[aria-label="自动化任务执行内容"]');assert.ok(field);field.value='Synthetic cron task';field.dispatchEvent(new InputEvent('input',{bubbles:true,data:field.value}));button('保存自动化任务草稿').click();await flush();const saved=e.events.filter(v=>v[0]==='change').at(-1)[1];assert.equal(saved.triggers.length,1);assert.equal(saved.triggers[0].enabled,false);assert.equal(saved.triggers[0].config.timezone,'Asia/Shanghai');assert.equal(saved.triggers[0].config.cron,'0 9 * * *');button('编辑 自动工单').click();await flush();input('自动化任务标题','未保存');button('返回自动化任务列表').click();await flush();assert.match(document.body.textContent,/丢弃本次未保存的修改/);button('丢弃并返回').click();await flush();assert.equal(e.events.filter(v=>v[0]==='change').at(-1)[1].triggers[0].name,'自动工单');});
test('double Trigger draft submit and closing-drawer stale submit create one draft only',async t=>{const e=await mount(t,Trigger,{base:'/workspaces/synthetic',draft:true,disabled:false});button('新增自动化任务草稿').click();await flush();input('自动化任务标题','单次入口');const form=document.querySelector('.n-drawer form');assert.ok(form);form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await flush();assert.equal(e.events.filter(v=>v[0]==='change').at(-1)[1].triggers.length,1);form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await flush();assert.equal(e.events.filter(v=>v[0]==='change').at(-1)[1].triggers.length,1);});


test('automatic task history choices explain independent, employee-wide and same-business grouping without changing policy values',async t=>{
 const e=await mount(t,Trigger,{base:'/workspaces/synthetic',draft:true,disabled:false});
 assert.match(document.querySelector('[data-testid="trigger-history-policy-help"]').textContent,/每个新任务单独处理/);
 document.querySelector('button[aria-label="历史任务参考规则"]').click();await flush();assert.match(document.body.textContent,/每个新任务仍独立执行/);assert.match(document.body.textContent,/包括失败或取消/);assert.match(document.body.textContent,/不会重新分组已有任务/);
 await choose('执行时参考哪些历史任务','员工内共享：参考其他自动化任务');
 assert.equal(e.events.filter(v=>v[0]==='change').at(-1)[1].policy,'employee_shared');
 assert.match(document.querySelector('[data-testid="trigger-history-policy-help"]').textContent,/不同自动化任务入口/);assert.match(document.querySelector('[data-testid="trigger-history-policy-help"]').textContent,/创建时归入/);
 await choose('执行时参考哪些历史任务','按业务分组：只参考同组任务');
 assert.equal(e.events.filter(v=>v[0]==='change').at(-1)[1].policy,'business_key');
 assert.match(document.querySelector('[data-testid="trigger-history-policy-help"]').textContent,/业务标识相同/);assert.match(document.querySelector('[data-testid="trigger-history-policy-help"]').textContent,/未填写标识的任务各自独立/);
 await choose('执行时参考哪些历史任务','独立处理：不参考其他任务');
 assert.equal(e.events.filter(v=>v[0]==='change').at(-1)[1].policy,'isolated');assert.equal(e.events.filter(v=>v[0]==='change').at(-1)[1].triggers.length,0);
});

test('capability description edits, saves and reopens through the HTTP projection with legacy defaults',async t=>{
 const raw={name:'描述包',description:'已保存的职责能力',enabled:true,mode:'inherit',allowMemberIds:[],denyMemberIds:[],resourceIds:[]};
 assert.equal(packageEditor({...raw,description:undefined}).description,'');
 const e=await mount(t,Editor,editorProps(packageEditor(raw))),field=document.querySelector('textarea[aria-label="能力包描述"]');assert.ok(field);assert.equal(field.value,raw.description);assert.equal(field.maxLength,4000);
 field.value='更新后的可用能力';field.dispatchEvent(new InputEvent('input',{bubbles:true,data:field.value}));await save();const saved=e.events.find(v=>v[0]==='submit')[1];assert.equal(packageInput(saved).description,'更新后的可用能力');
 e.props.show=false;await flush();e.props.value=packageEditor(packageInput(saved));e.props.show=true;await flush();assert.equal(document.querySelector('textarea[aria-label="能力包描述"]').value,'更新后的可用能力');
 e.props.busy=true;await flush();assert.equal(document.querySelector('textarea[aria-label="能力包描述"]').disabled,true);
});


test('saved employee capability page persists the edited description in the real save adapter',async t=>{
 const originalFetch=globalThis.fetch,requests=[];let item={id:'package-a',workspaceId:'synthetic',entityId:'receiver',version:1,name:'持久描述包',description:'原始描述',enabled:true,mode:'inherit',allowMemberIds:[],denyMemberIds:[],resourceIds:[]};
 globalThis.fetch=async(url,init={})=>{const path=String(url);let value=[];
  if(init.method==='PUT'){const body=JSON.parse(init.body);requests.push(body);item={...item,...body,version:2};value=item;}
  else if(path.endsWith('/capability-packages'))value=[item];
  else if(path.endsWith('/channels/subjects'))value={sources:[],users:[],departments:[]};
  else if(path.endsWith('/work-items/settings'))value={configured:{revision:0,enabled:false},effective:{enabled:false,available:true}};
  return{ok:true,status:200,json:async()=>JSON.parse(JSON.stringify(value))};};
 t.after(()=>globalThis.fetch=originalFetch);await mount(t,Access,{base:'/workspaces/synthetic/entities/receiver',section:'capabilities'});await until(()=>document.body.textContent.includes('原始描述'));
 button('编辑 持久描述包').click();await until(()=>document.querySelector('textarea[aria-label="能力包描述"]'));const field=document.querySelector('textarea[aria-label="能力包描述"]');field.value='新的可交接能力';field.dispatchEvent(new InputEvent('input',{bubbles:true,data:field.value}));await save();await until(()=>requests.length===1&&!document.querySelector('textarea[aria-label="能力包描述"]'));
 assert.equal(requests[0].description,'新的可交接能力');assert.match(document.body.textContent,/新的可交接能力/);button('编辑 持久描述包').click();await until(()=>document.querySelector('textarea[aria-label="能力包描述"]'));assert.equal(document.querySelector('textarea[aria-label="能力包描述"]').value,'新的可交接能力');
});

test('pure WeCom member-search source is selectable for package narrowing before first message',async t=>{
 const originalFetch=globalThis.fetch,requests=[];t.after(()=>{globalThis.fetch=originalFetch;});
 globalThis.fetch=async(url,init={})=>{requests.push({url:String(url),body:JSON.parse(init.body)});return new Response(JSON.stringify({sourceId:'wecom-source',provider:'wecom',appId:'bot-fixture',items:[{externalId:'member-1',subjectId:'member-1',displayName:'合成人员',kind:'channel_user',departmentPaths:['合成部门']}],exhausted:true}),{status:200,headers:{'content-type':'application/json'}});};
 const props=editorProps({...emptyPackage(),name:'企微名单能力包',userPolicyMode:'allowlist',mode:'restrict',directoryAccess:{allow:[],deny:[],channelPolicies:[{sourceId:'wecom-source',mode:'allowlist',allow:[],deny:[]}]}});props.draft=false;props.subjects.sources=[{sourceId:'wecom-source',provider:'wecom',appId:'bot-fixture',enabled:true,status:'pending_verification',directoryStatus:'unavailable',directoryMode:'member_search'}];
 const env=await mount(t,Editor,props);await until(()=>!!document.querySelector('input[aria-label="企业微信包内允许成员成员关键词"]'));
 assert.ok(!document.body.textContent.includes('查询当前目录'));input('企业微信包内允许成员成员关键词','合成人员');await flush();button('搜索企微成员').click();await until(()=>document.body.textContent.includes('选择人员'));button('选择人员').click();await flush();await save();
 const saved=env.events.filter(e=>e[0]==='submit').at(-1)[1];assert.equal(saved.userPolicyMode,'allowlist');assert.equal(saved.directoryAccess.channelPolicies[0].allow[0].sourceId,'wecom-source');assert.equal(saved.directoryAccess.channelPolicies[0].allow[0].kind,'channel_user');assert.equal(requests.length,1);assert.ok(requests[0].url.endsWith('/channels/wecom/member-search'));
});

test('new package inherits each channel independently including group members, saves all policies, and keeps Web unchanged',async t=>{
 const props=editorProps({...emptyPackage(),name:'三渠道继承'});props.draft=false;props.subjects.sources=['feishu','dingtalk','wecom'].map(provider=>({sourceId:provider+'-source',provider,appId:provider+'-app',enabled:true,status:'verified',directoryStatus:'available'}));
 const env=await mount(t,Editor,props);assert.match(document.body.textContent,/包括已获准在群内使用的群成员/);assert.equal(document.querySelectorAll('.package-channel-policies input[value="inherit"]:checked').length,3);await save();
 let saved=env.events.filter(e=>e[0]==='submit').at(-1)[1];assert.deepEqual(saved.directoryAccess.channelPolicies,props.subjects.sources.map(source=>({sourceId:source.sourceId,mode:'inherit',allow:[],deny:[]})));assert.equal(saved.mode,'inherit');
 const feishu=document.querySelector('[aria-label="飞书能力包使用范围"]');feishu.querySelector('input[value="allowlist"]').click();await flush();assert.match(feishu.textContent,/群内开放不会绕过本包白名单/);await save();saved=env.events.filter(e=>e[0]==='submit').at(-1)[1];assert.equal(saved.directoryAccess.channelPolicies.find(p=>p.sourceId==='feishu-source').mode,'allowlist');assert.equal(saved.directoryAccess.channelPolicies.find(p=>p.sourceId==='wecom-source').mode,'inherit');assert.equal(saved.mode,'inherit');
});
test('package channel policies round-trip both lists and unrelated channel restrictions without touching Web',async t=>{
 const allow={sourceId:'feishu-source',kind:'channel_user',subjectId:'allowed',conversationKinds:['private','group']},deny={...allow,subjectId:'blocked'};
 const value={...emptyPackage(),name:'渠道拒绝优先',directoryAccess:{allow:[],deny:[],channelPolicies:[{sourceId:'feishu-source',mode:'allowlist',allow:[allow],deny:[deny]},{sourceId:'wecom-source',mode:'inherit',allow:[],deny:[]}]}};
 const props=editorProps(value);props.subjects.sources=[{sourceId:'feishu-source',provider:'feishu',appId:'fixture-app',enabled:true,status:'verified',directoryStatus:'available'}];const env=await mount(t,Editor,props);
 document.querySelector('[aria-label="飞书能力包使用范围"] input[value="inherit"]').click();await flush();assert.equal(document.querySelectorAll('.package-channel-policies .directory-rule-detail').length,1,'blacklist stays visible and effective in inherit mode');await save();const saved=env.events.filter(e=>e[0]==='submit').at(-1)[1];assert.deepEqual(saved.directoryAccess.channelPolicies.find(p=>p.sourceId==='feishu-source'),{sourceId:'feishu-source',mode:'inherit',allow:[allow],deny:[deny]});assert.deepEqual(saved.directoryAccess.channelPolicies.find(p=>p.sourceId==='wecom-source'),value.directoryAccess.channelPolicies[1]);assert.deepEqual(packageInput(packageEditor(packageInput(saved))).directoryAccess,saved.directoryAccess);
});

test('legacy raw restrict response stays allowlisted with deny when editing only its name',async t=>{
 const allow={sourceId:'feishu-source',kind:'channel_user',subjectId:'allowed',conversationKinds:['private','group']},deny={...allow,subjectId:'blocked'};
 const props=editorProps(packageEditor({name:'旧规则包',enabled:true,mode:'restrict',allowMemberIds:[],denyMemberIds:[],resourceIds:[],directoryAccess:{allow:[allow],deny:[deny]}}));props.subjects.sources=[{sourceId:'feishu-source',provider:'feishu',appId:'fixture-app',enabled:true,status:'verified',directoryStatus:'available'}];
 const env=await mount(t,Editor,props);assert.ok(document.querySelector('[aria-label="飞书能力包使用范围"] input[value="allowlist"]').checked);input('能力包名称','仅改名称');await save();const saved=env.events.filter(e=>e[0]==='submit').at(-1)[1];assert.deepEqual(saved.directoryAccess.channelPolicies,[{sourceId:'feishu-source',mode:'allowlist',allow:[allow],deny:[deny]}]);
});
for(const legacyMode of ['restrict','inherit'])test(legacyMode+' legacy package status toggle then immediate name edit never loses its projected channel limits',async t=>{
 const originalFetch=globalThis.fetch,writes=[];t.after(()=>globalThis.fetch=originalFetch);
 const allow={sourceId:'feishu-source',kind:'channel_user',subjectId:'allowed',conversationKinds:['private','group']},deny={...allow,subjectId:'blocked'};
 const projected=[{sourceId:'feishu-source',mode:legacyMode==='restrict'?'allowlist':'denylist',...(legacyMode==='inherit'?{legacyAllowCheck:true}:{}),allow:[allow],deny:[deny]}];let item={id:'legacy-package',workspaceId:'synthetic',entityId:'receiver',version:1,name:'旧限制包',enabled:true,mode:legacyMode,allowMemberIds:[],denyMemberIds:[],resourceIds:[],directoryAccess:{allow:[allow],deny:[deny]}};
 globalThis.fetch=async(url,init={})=>{const path=String(url);let value=[];if(init.method==='PUT'){const body=JSON.parse(init.body);writes.push({path,body});item={...item,...body,version:item.version+1};value=item;}else if(path.endsWith('/capability-packages'))value=[{...item,directoryAccess:{...item.directoryAccess,channelPolicies:projected}}];else if(path.endsWith('/channels/subjects'))value={sources:[{sourceId:'feishu-source',provider:'feishu',appId:'fixture-app',enabled:true,status:'verified',directoryStatus:'available'}],users:[],departments:[]};else if(path.endsWith('/work-items/settings'))value={configured:{revision:0,enabled:false},effective:{enabled:false,available:true}};return{ok:true,status:200,json:async()=>JSON.parse(JSON.stringify(value))};};
 await mount(t,Access,{base:'/workspaces/synthetic/entities/receiver',section:'capabilities'});await until(()=>document.body.textContent.includes('旧限制包'));button('停用').click();await until(()=>writes.length===1&&document.body.textContent.includes('已停用'));button('编辑 旧限制包').click();await until(()=>document.querySelector('input[aria-label="能力包名称"]'));input('能力包名称','停用后仅改名称');await save();await until(()=>writes.length===2);assert.equal(writes[1].body.expectedVersion,2);assert.equal(writes[1].body.enabled,false);assert.deepEqual(writes[1].body.directoryAccess.channelPolicies,projected);assert.deepEqual(writes[1].body.directoryAccess.allow,[allow]);assert.deepEqual(writes[1].body.directoryAccess.deny,[deny]);
});

test('legacy inherited allow checking projects only onto its own source and survives DTO round-trip',()=>{
 const allow={sourceId:'feishu-source',kind:'channel_user',subjectId:'legacy-person',conversationKinds:['private','group']};
 const raw={...emptyPackage(),name:'旧继承包',directoryAccess:{allow:[allow],deny:[]}};
 const policies=packageChannelPolicies(raw,['feishu-source','wecom-source']);assert.deepEqual(policies,[{sourceId:'feishu-source',mode:'inherit',allow:[allow],deny:[],legacyAllowCheck:true},{sourceId:'wecom-source',mode:'inherit',allow:[],deny:[]}]);
 const value={...raw,directoryAccess:{...raw.directoryAccess,channelPolicies:policies}};assert.deepEqual(packageInput(packageEditor(packageInput(value))).directoryAccess,value.directoryAccess);
 assert.equal(packageChannelPolicies(emptyPackage(),['feishu-source'])[0].legacyAllowCheck,undefined);
 assert.equal(packageChannelPolicies({...raw,userPolicyMode:'inherit'},['feishu-source'])[0].legacyAllowCheck,undefined,'inactive historical allow does not add a new restriction');
});

test('legacy channel check is retained for Web and resource edits until explicit channel mode confirmation',async t=>{
 const allow={sourceId:'feishu-source',kind:'channel_user',subjectId:'legacy-person',conversationKinds:['private','group']},otherAllow={...allow,sourceId:'wecom-source'};
 const policies=[{sourceId:'feishu-source',mode:'inherit',allow:[allow],deny:[],legacyAllowCheck:true},{sourceId:'wecom-source',mode:'inherit',allow:[otherAllow],deny:[],legacyAllowCheck:true}];
 const props=editorProps({...emptyPackage(),name:'兼容名单包',directoryAccess:{allow:[allow,otherAllow],deny:[],channelPolicies:policies}});props.subjects.sources=[{sourceId:'feishu-source',provider:'feishu',appId:'fixture-app',enabled:true,status:'verified',directoryStatus:'available'}];
 const env=await mount(t,Editor,props);assert.match(document.body.textContent,/名单中的身份暂无法核实时，会暂停本渠道使用/);input('能力包名称','只改名称与网页');document.querySelector('[aria-label="能力包使用者策略"] input[value="allowlist"]').click();await flush();await choose('能力包Skill','合成文章Skill');await save();
 let saved=env.events.filter(e=>e[0]==='submit').at(-1)[1];assert.equal(saved.mode,'restrict');assert.deepEqual(saved.resourceIds,['skill-a']);assert.deepEqual(saved.directoryAccess.channelPolicies,policies);
 const channel=document.querySelector('[aria-label="飞书能力包使用范围"]');channel.querySelector('input[value="denylist"]').click();await flush();assert.match(channel.textContent,/可能扩大授权/);assert.equal(button('保存包草稿').disabled,true);const previous=env.events.filter(e=>e[0]==='submit').length;await save();assert.equal(env.events.filter(e=>e[0]==='submit').length,previous);
 button('保留渠道原策略').click();await flush();assert.ok(channel.querySelector('input[value="inherit"]').checked);await save();saved=env.events.filter(e=>e[0]==='submit').at(-1)[1];assert.equal(saved.directoryAccess.channelPolicies.find(p=>p.sourceId==='feishu-source').legacyAllowCheck,true);
 channel.querySelector('input[value="denylist"]').click();await flush();button('确认切换渠道策略').click();await flush();assert.ok(channel.querySelector('input[value="denylist"]').checked);await save();saved=env.events.filter(e=>e[0]==='submit').at(-1)[1];assert.equal(saved.directoryAccess.channelPolicies.find(p=>p.sourceId==='feishu-source').legacyAllowCheck,undefined);assert.equal(saved.directoryAccess.channelPolicies.find(p=>p.sourceId==='wecom-source').legacyAllowCheck,true);assert.deepEqual(saved.directoryAccess.channelPolicies.find(p=>p.sourceId==='feishu-source').allow,[allow]);assert.equal(saved.mode,'restrict','channel conversion does not modify Web scope');
});
