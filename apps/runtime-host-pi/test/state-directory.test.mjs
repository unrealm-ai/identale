// Modified for Identale; see the root NOTICE.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const custom of [false, true]) test(`real PI entry uses ${custom ? 'explicit' : 'default'} state without adopting old directories`, { timeout: 10000 }, async t => {
  const base = await fs.realpath(await fs.mkdtemp('/tmp/id-pi-state-'));
  const root = path.join(base, 'checkout'), home = path.join(base, 'home');
  await fs.mkdir(root); await fs.mkdir(home);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const legacy = path.join(root, 'var/runtime-host-pi');
  await fs.mkdir(legacy, { recursive: true });
  await fs.writeFile(path.join(legacy, 'journal.json'), 'old state sentinel');
  await fs.mkdir(path.join(root, '.dentity/platform'), { recursive: true });
  await fs.writeFile(path.join(root, '.dentity/platform/platform.sqlite'), 'old database sentinel');
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/main.js', import.meta.url))], {
    cwd: root,
    env: { HOME: home, DENTITY_RUNTIME_HOST_PI_PORT: String(port), DENTITY_RUNTIME_HOST_TOKEN: 'synthetic-state-path-token', ...(custom ? { DENTITY_RUNTIME_HOST_STATE_DIR: '~/custom/pi' } : {}) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-4096); });
  const done = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    try { await done; } finally { clearTimeout(timer); }
  });
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    assert.equal(child.exitCode, null, stderr);
    try { ready = (await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(300) })).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(ready, true, stderr);
  const state = path.join(home, custom ? 'custom/pi' : '.identale/runtime-host-pi');
  assert.match(await fs.readFile(path.join(state, 'host-id'), 'utf8'), /^[0-9a-f-]{36}$/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(state, 'journal.json'), 'utf8')), { prepared: [], sessions: [], executions: [] });
  assert.equal((await fs.stat(path.join(state, 'materials'))).mode & 0o777, 0o700);
  assert.equal(await fs.readFile(path.join(legacy, 'journal.json'), 'utf8'), 'old state sentinel');
  assert.equal(await fs.readFile(path.join(root, '.dentity/platform/platform.sqlite'), 'utf8'), 'old database sentinel');
  if (custom) await assert.rejects(fs.access(path.join(home, '.identale')), { code: 'ENOENT' });
  child.kill('SIGTERM');
  assert.equal(await done, 0, stderr);
});
