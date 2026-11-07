// Modified for Identale; see the root NOTICE.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseEnvironment } from '../local/local-start.mjs';
import { startupStep } from '../shared/startup-progress.mjs';

test('a failed startup step preserves the error and stops elapsed-time messages', async () => {
  const messages = [], error = new Error('synthetic failure');
  await assert.rejects(startupStep('Configuration check', async () => {
    await new Promise(resolve => setTimeout(resolve, 80));
    throw error;
  }, { log: message => messages.push(message), intervalMs: 20 }), value => value === error);
  assert.match(messages[0], /Configuration check: starting/);
  assert.ok(messages.some(message => /Configuration check: still running \([\d.]+s elapsed\)/.test(message)));
  assert.match(messages.at(-1), /Configuration check: failed \([\d.]+s\)/);
  const count = messages.length;
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(messages.length, count);
});

test('real compiler invocation errors name the failed phase and prevent later bundling', async t => {
  const root = await fs.realpath(await fs.mkdtemp('/tmp/id-build-progress-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const name of ['build/build.mjs', 'shared/startup-progress.mjs']) {
    const target = path.join(root, 'scripts', name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(new URL(`../${name}`, import.meta.url), target);
  }
  await fs.mkdir(path.join(root, 'apps/web'), { recursive: true });
  for (const [mode, label] of [['backend', 'Backend TypeScript compilation'], ['web', 'Frontend type checking']]) {
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/build/build.mjs'), mode], { cwd: root, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stdout.includes(`${label}: starting`));
    assert.ok(result.stdout.includes(`${label}: failed (exit code 1)`));
    assert.match(result.stderr, /MODULE_NOT_FOUND/);
    assert.doesNotMatch(result.stdout, /Frontend Vite bundling|: completed/);
  }
});

test('the Web workspace forwards Vite options after type checking and preserves argument boundaries', { timeout: 75000 }, async t => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const temporary = await fs.realpath(await fs.mkdtemp('/tmp/id-build-args-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const output = path.join(temporary, 'review output');
  const result = spawnSync('npm', ['run', 'build', '--workspace', '@dentity/web', '--', '--base=/review/', '--outDir', output], {
    cwd: root, env: baseEnvironment(process.env), encoding: 'utf8', timeout: 60000,
  });
  assert.equal(result.status, 0, result.stderr + '\n' + result.stdout);
  assert.match(result.stdout, /Frontend type checking: completed/);
  assert.match(result.stdout, /Frontend Vite bundling: completed/);
  const html = await fs.readFile(path.join(output, 'index.html'), 'utf8');
  assert.match(html, /src="\/review\/assets\//);
  assert.match(html, /href="\/review\/assets\//);
  assert.doesNotMatch(html, /(?:src|href)="\/assets\//);
});

test('the backend build still rejects extra arguments before launching the compiler', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../build/build.mjs', import.meta.url)), 'backend', '--base=/review/'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /Usage:/);
  assert.doesNotMatch(result.stdout, /starting/);
});
