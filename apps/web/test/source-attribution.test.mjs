import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parse, compileScript, compileStyle } from '@vue/compiler-sfc';
import { transform } from 'esbuild';
import { Window } from 'happy-dom';

// Component-only checks: no account, external request, model or business data.
const window = new Window({ url: 'http://127.0.0.1/' });
for (const name of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'ShadowRoot', 'Document']) {
  Object.defineProperty(globalThis, name, { value: name === 'window' ? window : window[name], configurable: true });
}
const { createApp } = await import('vue');
const { descriptor } = parse(await readFile(new URL('../src/shared/ui/SourceAttribution.vue', import.meta.url), 'utf8'));
const scope = 'data-v-source-attribution-test';
const script = compileScript(descriptor, { id: scope, inlineTemplate: true });
const code = (await transform(script.content, { loader: 'ts', format: 'esm' })).code
  .replaceAll('from "vue"', 'from ' + JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('vue')).href));
const component = (await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))).default;
component.__scopeId = scope;
test.after(async () => window.happyDOM.close());

function mount(t) {
  const root = document.createElement('div');
  document.body.append(root);
  const app = createApp(component);
  app.mount(root);
  t.after(() => { app.unmount(); root.remove(); });
  return root;
}

test('default footer preserves project and license links without leaking the referrer', t => {
  const root = mount(t);
  const footer = root.querySelector('footer[aria-label="项目来源与许可"]');
  assert.ok(footer);
  const links = [...footer.querySelectorAll('.source-attribution__line a')];
  assert.deepEqual(links.map(link => [link.textContent, link.getAttribute('href')]), [
    ['identale', 'https://github.com/unrealm-ai/identale'],
    ['Apache-2.0', 'https://www.apache.org/licenses/LICENSE-2.0'],
  ]);
  for (const link of footer.querySelectorAll('a')) {
    assert.equal(link.getAttribute('target'), '_blank');
    assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
  }
});

test('native disclosure is collapsed by default and describes third-party notices', t => {
  const root = mount(t);
  const details = root.querySelector('details');
  assert.equal(details.open, false);
  assert.equal(details.querySelector('summary').textContent, '许可说明');
  assert.match(details.textContent, /NOTICE 和 THIRD_PARTY_NOTICES\.md/);
  assert.doesNotMatch(root.textContent, /必须保留|不得移除|全部原创/);
});

test('the shared footer is unconditional and its scoped CSS supports wrapping and keyboard focus', async () => {
  const app = parse(await readFile(new URL('../src/App.vue', import.meta.url), 'utf8')).descriptor;
  assert.match(app.scriptSetup.content, /import SourceAttribution from '\.\/shared\/ui\/SourceAttribution\.vue'/);
  assert.match(app.template.content, /<SourceAttribution\s*\/>/);
  assert.equal((app.template.content.match(/<SourceAttribution\b/g) ?? []).length, 1);
  const styles = compileStyle({ id: scope, source: descriptor.styles[0].content, scoped: true });
  assert.deepEqual(styles.errors, []);
  assert.match(styles.code, /flex-wrap:wrap/);
  assert.match(styles.code, /summary[^{}]*:focus-visible/);
  assert.doesNotMatch(styles.code, /position:\s*(fixed|absolute)/);
});
