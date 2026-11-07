import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Window} from 'happy-dom';
import {build} from 'esbuild';
import {parse,compileScript} from '@vue/compiler-sfc';
const window=new Window({url:'http://localhost/'});
for(const name of ['window','document','navigator','Node','Element','HTMLElement','SVGElement','Event','MouseEvent','FocusEvent','KeyboardEvent','Image','ShadowRoot','Document','getComputedStyle','ResizeObserver','MutationObserver','requestAnimationFrame','cancelAnimationFrame'])Object.defineProperty(globalThis,name,{value:name==='window'?window:window[name],configurable:true});
const {createApp,h,nextTick}=await import('vue');
const dir=await mkdtemp(resolve('apps/web/.info-test-'));
await build({entryPoints:['apps/web/src/shared/ui/InfoHint.vue'],outfile:join(dir,'hint.mjs'),bundle:true,platform:'node',format:'esm',external:['vue','naive-ui'],plugins:[{name:'vue',setup(b){b.onLoad({filter:/\.vue$/},async({path})=>{const {descriptor}=parse(await readFile(path,'utf8'),{filename:path});return{contents:compileScript(descriptor,{id:path,inlineTemplate:true}).content,loader:'ts',resolveDir:resolve(path,'..')};});}}]});
const Hint=(await import(pathToFileURL(join(dir,'hint.mjs')))).default;
test.after(async()=>{await rm(dir,{recursive:true,force:true});await window.happyDOM.close();});
async function flush(){await nextTick();await new Promise(r=>setTimeout(r,30));}
function mount(t){document.body.innerHTML='<div id="app"></div>';const app=createApp({render:()=>h(Hint,{label:'会话与后台任务说明'},{default:()=> '切换页面不会取消任务。'})});app.mount('#app');t.after(()=>{app.unmount();document.body.innerHTML='';});return document.querySelector('button');}
test('information is absent from normal content and hover opens its accessible tooltip',async t=>{const b=mount(t);assert.equal(document.querySelector('[role=tooltip]'),null);assert.equal(b.getAttribute('aria-label'),'会话与后台任务说明');b.dispatchEvent(new MouseEvent('mouseenter'));await flush();assert.equal(b.getAttribute('aria-expanded'),'true');const id=b.getAttribute('aria-describedby');assert.equal(document.getElementById(id).textContent,'切换页面不会取消任务。');b.dispatchEvent(new MouseEvent('mouseleave'));await new Promise(r=>setTimeout(r,150));await flush();assert.equal(b.getAttribute('aria-expanded'),'false');});
test('keyboard focus reads the hint and Escape dismisses without moving focus',async t=>{const b=mount(t);b.focus();await flush();assert.equal(b.getAttribute('aria-expanded'),'true');b.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await flush();assert.equal(b.getAttribute('aria-expanded'),'false');assert.equal(document.activeElement,b);});
test('touch-style click pins the hint and second click dismisses it',async t=>{const b=mount(t);b.click();await flush();assert.equal(b.getAttribute('aria-expanded'),'true');b.click();await flush();assert.equal(b.getAttribute('aria-expanded'),'false');});

test('hover content stays open while moving from the icon into the tooltip',async t=>{const b=mount(t);b.dispatchEvent(new MouseEvent('mouseenter'));await flush();const content=document.getElementById(b.getAttribute('aria-describedby'));b.dispatchEvent(new MouseEvent('mouseleave'));content.dispatchEvent(new MouseEvent('mouseenter'));await new Promise(r=>setTimeout(r,180));await flush();assert.equal(b.getAttribute('aria-expanded'),'true');content.dispatchEvent(new MouseEvent('mouseleave'));await new Promise(r=>setTimeout(r,150));await flush();assert.equal(b.getAttribute('aria-expanded'),'false');});
