import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';import {build} from 'esbuild';
const dir=await mkdtemp(join(tmpdir(),'identity-theme-'));
await build({entryPoints:[fileURLToPath(new URL('../src/shared/theme/index.ts',import.meta.url))],outfile:join(dir,'theme.mjs'),bundle:true,format:'esm',platform:'node'});
const {palettes,themeOverrides,themeVariables}=await import(pathToFileURL(join(dir,'theme.mjs')).href);
test.after(()=>rm(dir,{recursive:true,force:true}));
const luminance=h=>{const v=h.slice(1).match(/../g).map(x=>parseInt(x,16)/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);return .2126*v[0]+.7152*v[1]+.0722*v[2];};const contrast=(a,b)=>{const x=luminance(a),y=luminance(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
for(const [mode,p] of Object.entries(palettes))test(mode+' semantic text and focus/boundaries meet measured contrast',()=>{for(const surface of ['background','surface','overlay','successTint','warningTint','dangerTint'])for(const color of ['text','muted','success','warning','danger'])assert.ok(contrast(p[color],p[surface])>=4.5,`${mode} ${color}/${surface}: ${contrast(p[color],p[surface]).toFixed(2)}`);for(const surface of ['background','surface','overlay'])assert.ok(contrast(p.link,p[surface])>=4.5,`${mode} link/${surface}`);assert.ok(contrast(p.border,p.surface)>=3);assert.ok(contrast(p.focus,p.surface)>=3);assert.ok(contrast(p.onPrimary,p.brand)>=4.5,`${mode} onPrimary/brand ${contrast(p.onPrimary,p.brand).toFixed(2)}`);});

for(const mode of ['light','dark'])test(mode+' component and semantic mappings keep primary, selection, links and disabled text accessible',()=>{const p=palettes[mode],v=themeVariables(mode),o=themeOverrides(mode);assert.equal(v['--id-primary'],p.brand);assert.equal(v['--id-button-primary-text'],p.onPrimary);assert.equal(o.Button.textColorPrimary,p.onPrimary);assert.equal(o.Menu.itemColorActive,p.tint);assert.equal(o.Menu.itemTextColorActive,p.selectedText);assert.equal(o.Empty.textColor,p.muted);assert.equal(o.common.placeholderColor,p.muted);assert.ok(contrast(p.selectedText,p.tint)>=4.5);assert.ok(contrast(p.disabled,p.disabledTint)>=4.5);for(const surface of ['background','surface','overlay']){assert.ok(contrast(o.Empty.textColor,p[surface])>=4.5);assert.ok(contrast(o.common.placeholderColor,p[surface])>=4.5);assert.ok(contrast(p.link,p[surface])>=4.5);assert.ok(contrast(p.focus,p[surface])>=3);}assert.equal(v['--id-radius-card'],'.75rem');assert.equal(v['--id-nav-width'],'4.5rem');});

// Naive 2.45 resolves select option heights from common, then calls seemly.depx
// before handing itemSize to its resizable virtual list. CSS-valid rem is not a
// numeric itemSize there; exercise that real dependency boundary, not a regex.
const {default:selectLight}=await import('naive-ui/es/select/styles/light.mjs');
const {default:selectDark}=await import('naive-ui/es/select/styles/dark.mjs');
const {default:commonLight}=await import('naive-ui/es/_styles/common/light.mjs');
const {default:commonDark}=await import('naive-ui/es/_styles/common/dark.mjs');
const {depx}=await import('seemly');
for(const mode of ['light','dark'])for(const compact of [false,true])test(`${mode} ${compact?'mobile':'desktop'} select virtual rows resolve to finite positive sizes while CSS tokens stay relative`,()=>{
 const native=mode==='dark'?selectDark:selectLight,base=mode==='dark'?commonDark:commonLight;
 const overrides=themeOverrides(mode,compact),resolved=native.peers.InternalSelectMenu.self({...base,...overrides.common});
 for(const size of ['Tiny','Small','Medium','Large','Huge']){const n=depx(resolved[`optionHeight${size}`]);assert.ok(Number.isFinite(n)&&n>0,`${mode}/${size} must be a finite virtual row height; got ${resolved[`optionHeight${size}`]}`);}
 assert.equal(depx(resolved.optionHeightSmall),28);assert.equal(depx(resolved.optionHeightMedium),compact?44:36);assert.equal(depx(resolved.optionHeightLarge),44);
 assert.equal(themeVariables(mode)['--id-control-md'],'2.25rem','semantic CSS size remains relative');
});

test('shared settings layout exports spacing, typography and field width from one semantic source',()=>{const v=themeVariables('light');assert.equal(v['--id-space-4'],'1rem');assert.equal(v['--id-space-6'],'1.5rem');assert.equal(v['--id-form-max-width'],'48rem');assert.equal(v['--id-font-size-body'],'.875rem');assert.equal(themeOverrides('light').common.heightMedium,'36px');});
