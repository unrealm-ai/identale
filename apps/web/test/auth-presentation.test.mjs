import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {existsSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Window} from 'happy-dom';
import {build} from 'esbuild';
import {parse,compileScript} from '@vue/compiler-sfc';

// Component-only form tests. No transport, model, channel or production data.
const window=new Window({url:'http://127.0.0.1:5173/'});
for(const name of ['window','document','navigator','location','history','localStorage','Node','ShadowRoot','Document','Element','HTMLElement','SVGElement','Event','MouseEvent','KeyboardEvent','FocusEvent','InputEvent','Image','HTMLInputElement','HTMLTextAreaElement','getComputedStyle','MutationObserver','ResizeObserver','requestAnimationFrame','cancelAnimationFrame'])Object.defineProperty(globalThis,name,{value:name==='window'?window:window[name],configurable:true});
const {createApp,h,reactive,nextTick}=await import('vue');
const dir=await mkdtemp(resolve('apps/web/.auth-presentation-test-'));
const output=join(dir,'auth.mjs');
await build({entryPoints:['apps/web/src/features/auth/AuthPage.vue'],outfile:output,bundle:true,platform:'node',format:'esm',external:['vue','naive-ui'],plugins:[{name:'sfc',setup(builder){builder.onLoad({filter:/\.vue$/},async({path})=>{const {descriptor}=parse(await readFile(path,'utf8'),{filename:path});return{contents:compileScript(descriptor,{id:path,inlineTemplate:true,fs:{fileExists:existsSync,readFile:p=>readFileSync(p,'utf8')}}).content,loader:'ts',resolveDir:resolve(path,'..')};});}}]});
const Auth=(await import(pathToFileURL(output).href)).default;
test.after(async()=>{await rm(dir,{recursive:true,force:true});await window.happyDOM.close();});
const flush=async()=>{await new Promise(r=>setTimeout(r,10));await nextTick();};
async function until(predicate){for(let i=0;i<100;i++){await flush();if(predicate())return;}assert.fail(document.body.textContent);}
function mount(t,overrides={}){const state=reactive({busy:false,invitationToken:'',invitationValid:true,mode:'login',username:'',password:'',displayName:'',...overrides}),submissions=[];document.body.innerHTML='<div id="app"></div>';const app=createApp({render:()=>h(Auth,{...state,'onUpdate:mode':v=>state.mode=v,'onUpdate:username':v=>state.username=v,'onUpdate:password':v=>state.password=v,'onUpdate:displayName':v=>state.displayName=v,onSubmit:()=>submissions.push({username:state.username,password:state.password,displayName:state.displayName,mode:state.mode,invitationToken:state.invitationToken})})});app.mount('#app');t.after(()=>{app.unmount();document.body.innerHTML='';});return{state,submissions};}
function input(name,value){const el=document.querySelector(`input[name="${name}"]`);assert.ok(el,name);el.value=value;el.dispatchEvent(new InputEvent('input',{bubbles:true,data:value}));}
function submit(){document.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));}

test('login displays identale with only account and password, not unsupported authentication',async t=>{
 mount(t);await flush();assert.ok(document.querySelector('[role=img][aria-label=identale]'));
 assert.deepEqual([...document.querySelectorAll('input')].map(e=>e.name),['username','password']);
 assert.equal(document.querySelector('input[name=password]').autocomplete,'current-password');
 assert.doesNotMatch(document.body.textContent,/邮箱|验证码|SSO|记住我|确认密码|独立.*Host|模型 API|事务|原子|沙箱/);
 assert.equal(document.querySelector('.auth-panel button[type=submit]').textContent.trim(),'登录');
});
test('keyboard mode switch clears secret draft, retains account and optional display name field',async t=>{
 const {state}=mount(t);await flush();input('username','new-member');input('password','private-draft');await flush();
 const login=document.querySelector('[role=tab][data-name=login]');login.focus();login.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
 await until(()=>state.mode==='register');assert.equal(state.password,'');assert.equal(state.username,'new-member');
 assert.deepEqual([...document.querySelectorAll('input')].map(e=>e.name),['username','displayName','password']);
 const tab=document.querySelector('[role=tab][aria-selected=true]'),panel=document.getElementById(tab.getAttribute('aria-controls'));assert.equal(panel.getAttribute('aria-labelledby'),tab.id);assert.equal(document.activeElement,tab);
 assert.equal(document.querySelector('input[name=password]').autocomplete,'new-password');
});
test('invalid form retains input, emits no request and focuses the first invalid field',async t=>{
 const {submissions}=mount(t,{mode:'register'});await flush();input('username','a');input('password','short');await flush();submit();
 await until(()=>document.body.textContent.includes('请输入 3–32'));assert.equal(submissions.length,0);assert.equal(document.querySelector('input[name=username]').value,'a');
 await until(()=>document.activeElement===document.querySelector('input[name=username]'));
 input('username','valid-member');await flush();submit();await until(()=>document.body.textContent.includes('密码至少 6 个字符'));assert.equal(submissions.length,0);
 await until(()=>document.activeElement===document.querySelector('input[name=password]'));
});
test('valid registration keeps password whitespace and guards same-tick duplicate submit',async t=>{
 const {state,submissions}=mount(t,{mode:'register'});await flush();input('username','valid-member');input('password','  secret  ');await flush();submit();submit();
 await until(()=>submissions.length===1);assert.equal(submissions[0].password,'  secret  ');assert.equal(submissions[0].displayName,'');assert.equal(state.password,'  secret  ');
});
test('invalid invitation cannot submit or silently become public registration; corrected invitation can continue',async t=>{
 const {state,submissions}=mount(t,{mode:'register',invitationToken:'fixture-invitation',invitationValid:false,username:'invited-member',password:'fixture-password'});await flush();
 assert.equal(document.querySelector('button[type=submit]').disabled,true);submit();await flush();assert.equal(submissions.length,0);assert.equal(state.invitationToken,'fixture-invitation');assert.match(document.body.textContent,/确认邀请有效/);
 state.invitationValid=true;await flush();submit();await until(()=>submissions.length===1);assert.equal(submissions[0].invitationToken,'fixture-invitation');assert.equal(document.querySelector('button[type=submit]').getAttribute('aria-label'),'注册并加入受邀工作区');
});
test('busy authentication disables form, tabs and duplicate submission while preserving input',async t=>{
 const {state,submissions}=mount(t,{busy:true,username:'busy-member',password:'fixture-password'});await flush();
 assert.equal(document.querySelector('button[type=submit]').disabled,true);assert.equal(document.querySelector('input[name=username]').disabled,true);assert.equal(document.querySelector('.auth-panel').getAttribute('aria-busy'),'true');
 submit();await flush();assert.equal(submissions.length,0);assert.equal(state.username,'busy-member');assert.equal(state.password,'fixture-password');
});
