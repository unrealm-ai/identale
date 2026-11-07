import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {parse,compileScript,compileStyle} from '@vue/compiler-sfc';
import {transform} from 'esbuild';
import {Window} from 'happy-dom';

const window=new Window();
for(const name of ['window','document','Node','Element','HTMLElement','SVGElement','ShadowRoot','Document','getComputedStyle'])Object.defineProperty(globalThis,name,{value:name==='window'?window:window[name],configurable:true});
const {createApp,nextTick}=await import('vue');
const {descriptor}=parse(await readFile(new URL('../src/shared/ui/BrandLogo.vue',import.meta.url),'utf8'));
const scope='data-v-brand-logo-test';
const script=compileScript(descriptor,{id:scope,inlineTemplate:true});
const code=(await transform(script.content,{loader:'ts',format:'esm'})).code.replaceAll('from "vue"','from '+JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('vue')).href));
const component=(await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'))).default;
component.__scopeId=scope;
const styles=compileStyle({id:scope,source:descriptor.styles[0].content,scoped:true});
assert.equal(styles.errors.length,0);
const style=document.createElement('style');style.textContent=styles.code;document.head.append(style);
test.after(async()=>window.happyDOM.close());

for(const [mode,props,asset,word] of [['light',{},'mark.svg','wordmark.svg'],['dark',{},'mark-dark.svg','wordmark-dark.svg'],['dark',{inverse:true},'mark-dark.svg','wordmark-dark.svg'],['light',{monochrome:true},'mark-mono.svg','wordmark.svg']])test(`brand ${mode} ${JSON.stringify(props)} shows the outlined mark and wordmark`,async()=>{
 document.documentElement.dataset.theme=mode;
 const root=document.createElement('div');document.body.append(root);const app=createApp(component,props);
 try{app.mount(root);await nextTick();const visible=[...root.querySelectorAll('img')].filter(img=>getComputedStyle(img).display!=='none');const symbol=visible.find(img=>!img.classList.contains('brand-logo-wordmark'));const wordmark=visible.find(img=>img.classList.contains('brand-logo-wordmark'));assert.equal(symbol?.getAttribute('src'),'/brand/'+asset);assert.equal(wordmark?.getAttribute('src'),'/brand/'+word);assert.equal(root.querySelector('[role="img"]').getAttribute('aria-label'),'identale');}
 finally{app.unmount();root.remove();}
});
test('compact sidebar mark is the small optical version without a wordmark',()=>{
 const root=document.createElement('div');document.body.append(root);const app=createApp(component,{compact:true});
 try{app.mount(root);assert.equal(root.querySelector('.brand-logo-wordmark'),null);assert.equal(root.querySelector('img').getAttribute('src'),'/brand/mark-small.svg');}finally{app.unmount();root.remove();}
});
test('horizontal lockup is one outlined image',async()=>{
 document.documentElement.dataset.theme='light';
 const root=document.createElement('div');document.body.append(root);const app=createApp(component,{lockup:true});
 try{app.mount(root);await nextTick();const visible=[...root.querySelectorAll('img')].filter(img=>getComputedStyle(img).display!=='none');assert.equal(visible.length,1);assert.equal(visible[0].getAttribute('src'),'/brand/lockup-horizontal.svg');}
 finally{app.unmount();root.remove();}
});
