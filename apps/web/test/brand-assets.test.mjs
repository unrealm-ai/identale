import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const base = new URL('../public/brand/', import.meta.url);
const files = ['mark.svg','mark-dark.svg','mark-small.svg','mark-mono.svg','lockup-horizontal.svg','lockup-horizontal-dark.svg','wordmark.svg','wordmark-dark.svg','favicon.svg'];
for (const name of files) test(`production brand ${name} is local static SVG without active or external content`, async () => {
  const svg=await readFile(new URL(name,base),'utf8');
  assert.match(svg,/^<svg\b/); assert.match(svg,/viewBox="[^"]+"/); assert.match(svg,/<title>identale/);
  assert.doesNotMatch(svg,/<(?:script|foreignObject|image|iframe)\b|\bon[a-z]+\s*=|(?:href|src)\s*=|url\(\s*(?!#)/i);
  assert.match(svg,/<(?:path|rect|circle|mask)\b/);
});
test('browser identity points to the swappable local favicon and keeps internal code entry',async()=>{
 const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
 assert.match(html,/<title>identale<\/title>/);assert.match(html,/href="\/brand\/favicon\.svg"/);
 assert.match(html,/src="\/src\/main\.ts"/);
});
