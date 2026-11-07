// Modified for Identale; see the root NOTICE.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { localLauncherDirectory } from '../shared/local-paths.mjs';

const scripts = fileURLToPath(new URL('../', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
  for (let i = 0; i < 300; i++) { const result = await fn(); if (result) return result; await pause(20); }
  assert.fail('isolated CLI fixture did not become ready');
}
async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp('/tmp/id-observed-cli-'));
  const root = path.join(base, 'checkout'); await fs.mkdir(root);
  // RepositoryRoot in this copy points only at the isolated checkout. No real
  // entry, database, credential path or business port can be selected by it.
  await fs.cp(scripts, path.join(root, 'scripts'), { recursive: true, filter: source => !path.relative(scripts, source).split(path.sep).includes('test') });
  const runs = [];
  const start = (entry, args, flags = []) => {
    const child = spawn(process.execPath, [...flags, path.join(root, 'scripts', entry), ...args], { cwd: root, env: { HOME: base, PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
    const done = new Promise((resolve, reject) => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', reject); });
    const run = { child, done, stderr: () => stderr }; runs.push(run); return run;
  };
  t.after(async () => {
    for (const { child, done } of runs) { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await done; }
    await fs.rm(base, { recursive: true, force: true });
  });
  const launcher = localLauncherDirectory(root, { HOME: base });
  return { root, launcher, start, async rows() {
    const folder = path.join(launcher, 'diagnostics');
    return (await Promise.all((await fs.readdir(folder)).map(async name => (await fs.readFile(path.join(folder, name), 'utf8')).trim().split('\n').map(JSON.parse)))).flat();
  } };
}

test('local-start.mjs starts one initializing observed manager with unchanged arguments', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'scripts/local/local-manager-entry.mjs'), `if(JSON.stringify(process.argv.slice(2))!==${JSON.stringify(JSON.stringify(['initialize', '--no-install', '--no-build', '--mock']))})process.exit(99);process.exit(23);`);
  assert.deepEqual(await f.start('local/local-start.mjs', ['--no-install', '--no-build', '--mock']).done, { code: 23, signal: null });
  const rows = await f.rows();
  assert.equal(rows.filter(row => row.event === 'manager_spawned').length, 1);
  assert.equal(rows.find(row => row.event === 'manager_exit').exitCode, 23);
});

test('public entry preserves explicit Node unhandled-rejection policy in the observed manager', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'scripts/local/local-manager-entry.mjs'), "Promise.reject(new Error('synthetic-private-message'));");
  assert.deepEqual(await f.start('local/local-start.mjs', [], ['--unhandled-rejections=warn']).done, { code: 0, signal: null });
  assert.equal((await f.rows()).find(row => row.event === 'manager_exit').exitCode, 0);
});

test('invalid public arguments still fail without creating observer state', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.start('local/local-start.mjs', ['--unknown']).done, { code: 1, signal: null });
  await assert.rejects(fs.access(f.launcher), { code: 'ENOENT' });
});

for (const [signal, exitCode] of [['SIGTERM', 143], ['SIGHUP', 129]]) test(`observed CLI retains one real business manager, verified control ownership and ${signal} cleanup`, { timeout: 25000 }, async t => {
  const f = await fixture(t), reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const legacyPath = path.join(f.root, 'apps/control-plane/dist/main.js');
  await fs.mkdir(path.dirname(legacyPath), { recursive: true });
  await fs.writeFile(legacyPath, "require('node:fs').writeFileSync('legacy-ready','ready');setInterval(()=>{},1000);");
  const legacy = f.start('../apps/control-plane/dist/main.js', []);
  await until(() => fs.access(path.join(f.root, 'legacy-ready')).then(() => true, () => false));
  const service = "const s=require('node:net').createServer();s.listen(Number(process.argv[1]),'127.0.0.1');process.on('SIGTERM',()=>s.close());";
  await fs.writeFile(path.join(f.root, 'scripts/local/local-manager-entry.mjs'), `import {superviseLocal} from './local-start.mjs';import {enableLauncherParentObservation} from './local-process-diagnostics.mjs';import fs from 'node:fs/promises';enableLauncherParentObservation();
const running=await superviseLocal({cwd:${JSON.stringify(f.root)},commands:[{name:'isolated-cli-service',port:${port},file:process.execPath,args:['-e',${JSON.stringify(service)},String(${port})],env:{}}],log(){},killAfterMs:300});await fs.writeFile('ready.json',JSON.stringify({manager:process.pid,instanceId:running.instance.instance}));process.exit(await running.completion);`);
  const { child, done, stderr } = f.start('local/local-start.mjs', ['--no-install', '--no-build']);
  const ready = await until(async () => {
    if (child.exitCode !== null || child.signalCode !== null) assert.fail(`isolated CLI exited: code=${child.exitCode} signal=${child.signalCode}; ${stderr()}`);
    return fs.readFile(path.join(f.root, 'ready.json'), 'utf8').then(JSON.parse, error => { if (error.code === 'ENOENT') return false; throw error; });
  });
  const state = JSON.parse(await fs.readFile(path.join(f.launcher, 'instance.json'), 'utf8'));
  assert.deepEqual(await legacy.done, { code: null, signal: 'SIGTERM' });
  assert.equal(state.pid, ready.manager); assert.notEqual(state.pid, child.pid); assert.equal(state.groups.length, 1);
  assert.equal((await f.rows()).find(row => row.event === 'manager_instance_bound').managerInstanceId, ready.instanceId);
  child.kill(signal); assert.deepEqual(await done, { code: exitCode, signal: null });
  const rows = await f.rows();
  assert.ok(rows.some(row => row.event === 'launcher_complete' && row.cleanupConfirmed));
  assert.ok(rows.some(row => row.event === 'manager_exit' && row.exitCode === exitCode && row.managerInstanceId === ready.instanceId));
  await assert.rejects(fs.access(path.join(f.launcher, 'instance.json')), { code: 'ENOENT' });
  const probe = net.createServer(); await new Promise(resolve => probe.listen(port, '127.0.0.1', resolve)); await new Promise(resolve => probe.close(resolve));
});
