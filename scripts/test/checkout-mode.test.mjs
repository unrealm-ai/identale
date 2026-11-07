// Modified for Identale; see the root NOTICE.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claimCheckoutMode } from '../shared/checkout-mode.mjs';

const moduleUrl = new URL('../shared/checkout-mode.mjs', import.meta.url).href;
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp('/tmp/id-checkout-mode-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function holder(t, root, mode, home) {
  const script = `import {claimCheckoutMode} from ${JSON.stringify(moduleUrl)};
const lease=await claimCheckoutMode(process.argv[1],process.argv[2]);
process.stdin.resume();process.stdin.once('data',async()=>{await lease.release();process.stdin.pause();});
console.log('ready');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, root, mode], { env: { HOME: home, PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise((resolve, reject) => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', reject); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await done; });
  await new Promise((resolve, reject) => {
    child.stdout.once('data', () => resolve());
    child.once('exit', () => reject(new Error(stderr)));
    child.once('error', reject);
  });
  return { child, done, async release() { child.stdin.end('stop'); assert.deepEqual(await done, { code: 0, signal: null }, stderr); } };
}

test('local leases exclude host across HOME and canonical checkout aliases; local handover stays available', async t => {
  const root = await fixture(t), alias = root + '-alias';
  await fs.symlink(root, alias); t.after(() => fs.unlink(alias));
  const first = await holder(t, root, 'local', path.join(root, 'ordinary-home'));
  await assert.rejects(claimCheckoutMode(alias, 'host'), /other mode is refused/);
  const replacement = await claimCheckoutMode(alias, 'local');
  await first.release();
  await assert.rejects(claimCheckoutMode(root, 'host'), /other mode is refused/);
  await replacement.release();
  const deployment = await claimCheckoutMode(root, 'host'); await deployment.release();
  assert.deepEqual(await fs.readdir(root), []);
});

test('host lease excludes local and a second host until release, independently of HOME', async t => {
  const root = await fixture(t), deployment = await holder(t, root, 'host', path.join(root, 'root-home'));
  await assert.rejects(claimCheckoutMode(root, 'local'), /other mode is refused/);
  await assert.rejects(claimCheckoutMode(root, 'host'), /other mode is refused/);
  await deployment.release();
  const local = await claimCheckoutMode(root, 'local'); await local.release();
  assert.deepEqual(await fs.readdir(root), []);
});

test('concurrent opposite modes have exactly one winner before any build can start', async t => {
  const root = await fixture(t);
  const attempts = await Promise.allSettled([claimCheckoutMode(root, 'local'), claimCheckoutMode(root, 'host')]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  const loser = attempts.find(result => result.status === 'rejected'); assert.match(loser.reason.message, /other mode is refused/);
  await attempts.find(result => result.status === 'fulfilled').value.release();
  assert.deepEqual(await fs.readdir(root), []);
});

test('unclean exit refuses switching modes until its own mode recovers the checkout', async t => {
  const root = await fixture(t), old = await holder(t, root, 'local', root);
  old.child.kill('SIGKILL'); await old.done;
  await assert.rejects(claimCheckoutMode(root, 'host'), /verify cleanup before switching/);
  const failedStartup = await claimCheckoutMode(root, 'local'); await failedStartup.release();
  await assert.rejects(claimCheckoutMode(root, 'host'), /verify cleanup before switching/);
  const recovery = await claimCheckoutMode(root, 'local'); await recovery.release({ recovered: true });
  const deployment = await claimCheckoutMode(root, 'host'); await deployment.release();
});

test('symlink metadata is refused without modifying its target', async t => {
  const root = await fixture(t), target = await fixture(t);
  await fs.writeFile(path.join(target, 'sentinel'), 'keep');
  await fs.symlink(target, path.join(root, '.identale-mode'));
  await assert.rejects(claimCheckoutMode(root, 'local'), /Unsafe checkout mode directory/);
  assert.deepEqual(await fs.readdir(target), ['sentinel']);
  assert.equal(await fs.readFile(path.join(target, 'sentinel'), 'utf8'), 'keep');
});

test('public local entry refuses a host lease before configuration, credentials or build writes', async t => {
  const root = await fixture(t), scripts = fileURLToPath(new URL('../', import.meta.url));
  await fs.cp(scripts, path.join(root, 'scripts'), { recursive: true, filter: source => !path.relative(scripts, source).split(path.sep).includes('test') });
  const deployment = await claimCheckoutMode(root, 'host');
  try {
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/local/local-start.mjs'), '--no-install', '--no-build'], { cwd: root, env: { HOME: path.join(root, 'local-home'), PATH: process.env.PATH }, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1, result.stderr); assert.match(result.stderr, /other mode is refused/);
    for (const target of ['.env', 'local-home/.identale/local-secrets.json', 'node_modules', 'apps']) await assert.rejects(fs.access(path.join(root, target)), { code: 'ENOENT' });
    assert.equal((await fs.readdir(path.join(root, '.identale-mode'))).length, 1);
  } finally { await deployment.release(); }
});

test('Linux root deployment sees a real different-UID local lease without changing its ownership', async t => {
  if (process.platform !== 'linux' || process.getuid() !== 0) { t.skip('requires isolated Linux root for a real UID switch'); return; }
  const root = await fixture(t); await fs.chmod(root, 0o777);
  // Copy the real implementation to a traversable temporary checkout rather
  // than granting another UID access to the developer's home or repository.
  const scripts = fileURLToPath(new URL('../', import.meta.url));
  await fs.cp(scripts, path.join(root, 'scripts'), { recursive: true, filter: source => !path.relative(scripts, source).split(path.sep).includes('test') });
  const script = `import {claimCheckoutMode} from './scripts/shared/checkout-mode.mjs';const lease=await claimCheckoutMode(process.cwd(),'local');console.log('ready');process.stdin.resume();process.stdin.once('data',async()=>{await lease.release();process.stdin.pause();});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: root, uid: 65534, gid: 65534, env: { HOME: '/nonexistent' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const done = new Promise(resolve => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', error => resolve({ error })); });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await done; });
  const ready = await Promise.race([new Promise(resolve => child.stdout.once('data', () => resolve(true))), done]);
  if (ready?.error?.code === 'EACCES') { t.skip('current Node binary cannot be executed by the isolated UID'); return; }
  assert.equal(ready, true, stderr);
  const folder = path.join(root, '.identale-mode'), before = await fs.stat(folder);
  await assert.rejects(claimCheckoutMode(root, 'host'), /other mode is refused/);
  assert.equal((await fs.stat(folder)).uid, before.uid); assert.equal(before.uid, 65534);
  child.stdin.end('stop'); assert.deepEqual(await done, { code: 0, signal: null });
  const deployment = await claimCheckoutMode(root, 'host'); await deployment.release();
});
