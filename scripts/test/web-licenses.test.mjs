// Modified for Identale; see the root NOTICE.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'vite';
import { copyWebDistribution, validateWebDistribution } from '../deploy/web-distribution.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sha256 = value => createHash('sha256').update(value).digest('hex');
let temporary, output, manifest, noticeText;
const renderedPackages = new Set();

before(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'identale-web-licenses-'));
  output = path.join(temporary, 'dist');
  await build({
    root: path.join(root, 'apps/web'), envFile: false, logLevel: 'silent',
    build: { outDir: output, emptyOutDir: true },
    plugins: [{ name: 'observe-real-rendered-modules', generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        for (const [id, module] of Object.entries(chunk.modules)) {
          if (module.renderedLength <= 0) continue;
          const name = id.match(/\/node_modules\/((?:@[^/]+\/)?[^/]+)\//)?.[1];
          if (name) renderedPackages.add(name);
          if (id.startsWith('\0vite/')) renderedPackages.add('vite');
          if (id.startsWith('\0plugin-vue:')) renderedPackages.add('@vitejs/plugin-vue');
        }
      }
    } }],
  });
  manifest = await validateWebDistribution(output, root);
  noticeText = await fs.readFile(path.join(output, 'THIRD_PARTY_NOTICES.txt'), 'utf8');
});
after(async () => { if (temporary) await fs.rm(temporary, { recursive: true, force: true }); });

test('real production build includes exactly the rendered dependencies, including runtime helpers', () => {
  assert.deepEqual(manifest.dependencies.map(item => item.name).sort(), [...renderedPackages].sort());
  for (const name of ['@vue/runtime-dom', 'naive-ui', 'vite', '@vitejs/plugin-vue']) assert.ok(renderedPackages.has(name), name);
  for (const name of ['typescript', 'happy-dom', '@babel/parser', '@vue/compiler-sfc', 'highlight.js']) assert.ok(!renderedPackages.has(name), name);
  assert.ok(manifest.dependencies.every(item => item.modules.length && item.documents.length));
  assert.ok(!noticeText.includes(root), 'No local checkout paths in public license text.');
  assert.ok(!JSON.stringify(manifest).includes(root), 'No local checkout paths in public manifest.');
});

test('project texts and every dependency license document retain their complete bytes', async () => {
  for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) {
    assert.deepEqual(await fs.readFile(path.join(output, name)), await fs.readFile(path.join(root, name)));
  }
  for (const dependency of manifest.dependencies) {
    for (const document of dependency.documents) {
      const filename = document.source.startsWith('node_modules/')
        ? path.join(root, document.source)
        : path.join(root, 'scripts/build/license-overrides', document.file);
      const content = await fs.readFile(filename, 'utf8');
      assert.equal(sha256(content), document.sha256, `${dependency.name}/${document.file}`);
      assert.ok(noticeText.includes(content), `${dependency.name}/${document.file} is complete`);
    }
  }
  assert.ok(noticeText.includes('Copyright 2019 JUGGLE LTD'));
  assert.ok(noticeText.includes('Based on Underscore.js, copyright Jeremy Ashkenas'));
  assert.ok(noticeText.includes('Copyright (c) 2020 07akioni'));
});

test('NOTICE absence and the specific vdirs evidence gap remain explicit, without invented copyright', () => {
  const resizeObserver = manifest.dependencies.find(item => item.name === '@juggle/resize-observer');
  assert.deepEqual(resizeObserver.notices, []);
  assert.match(resizeObserver.noticeStatus, /No standalone NOTICE/);
  const vdirs = manifest.dependencies.find(item => item.name === 'vdirs');
  assert.equal(vdirs.version, '0.1.8');
  assert.match(vdirs.warning, /copyright attribution still needs maintainer confirmation/);
  assert.match(noticeText, /Published author metadata \(not a copyright assertion\): 07akioni/);
  assert.ok(vdirs.documents.every(item => !item.source.startsWith('node_modules/')));
});

test('asset notices are retained both beside the copied resources and in the aggregate notice', async () => {
  assert.ok(manifest.publicNotices.some(item => item.file === 'channel-guides/LICENSE.dingtalk.txt'));
  assert.ok(manifest.publicNotices.some(item => item.file === 'employee-avatars/LICENSE.md'));
  for (const item of manifest.publicNotices) {
    const content = await fs.readFile(path.join(root, 'apps/web/public', item.file), 'utf8');
    assert.equal(await fs.readFile(path.join(output, item.file), 'utf8'), content);
    assert.ok(noticeText.includes(content));
  }
});

test('rebuilding regenerates deterministic legal artifacts and removes stale distribution files', async () => {
  const before = await fs.readFile(path.join(output, 'third-party-licenses.json'));
  await fs.writeFile(path.join(output, 'obsolete-test-marker.txt'), 'test artifact');
  await build({ root: path.join(root, 'apps/web'), envFile: false, logLevel: 'silent', build: { outDir: output, emptyOutDir: true } });
  await assert.rejects(fs.access(path.join(output, 'obsolete-test-marker.txt')), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(path.join(output, 'third-party-licenses.json')), before);
  assert.equal(await fs.readFile(path.join(output, 'THIRD_PARTY_NOTICES.txt'), 'utf8'), noticeText);
  await validateWebDistribution(output, root);
});

test('the production deployment copy retains all legal material and detects lost or altered files', async () => {
  const release = path.join(temporary, 'release');
  await copyWebDistribution(output, release, root);
  for (const file of [...manifest.legalFiles, ...manifest.publicNotices, ...manifest.artifacts].map(item => item.file)) {
    assert.deepEqual(await fs.readFile(path.join(release, file)), await fs.readFile(path.join(output, file)), file);
  }
  await fs.rm(path.join(release, 'NOTICE'));
  await assert.rejects(validateWebDistribution(release, root), { code: 'ENOENT' });
  await copyWebDistribution(output, release, root);
  const code = manifest.artifacts.find(item => item.file.endsWith('.js')).file;
  await fs.appendFile(path.join(release, code), '\n// altered after license collection\n');
  await assert.rejects(validateWebDistribution(release, root), /differs from its license manifest/);
  await assert.rejects(copyWebDistribution(release, path.join(temporary, 'invalid-release'), root), /differs from its license manifest/);
  await assert.rejects(fs.access(path.join(temporary, 'invalid-release')), { code: 'ENOENT' });
});
