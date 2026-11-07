import { launcherDirectory, testHome } from './helpers/local-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lifecycleDiagnostics } from '../local/local-lifecycle-log.mjs';
import { superviseLocal, reservePorts } from '../local/local-start.mjs';

const gateModule = fileURLToPath(new URL('../local/local-process-entry.sh', import.meta.url));
const launcherModule = new URL('../local/local-start.mjs', import.meta.url).href;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
  for (let i = 0; i < 150; i++) { const value = await fn(); if (value) return value; await pause(20); }
  assert.fail('isolated lifecycle fixture did not become ready');
}
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp('/tmp/id-lifecycle-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function freePort() {
  const s = net.createServer(); await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  const port = s.address().port; await new Promise(resolve => s.close(resolve)); return port;
}
const serverCode = `const http=require('node:http');const s=http.createServer((req,res)=>{res.end(JSON.stringify({pid:process.pid}));if(req.url==='/exit7')s.close(()=>process.exit(7));});s.listen(Number(process.argv[1]),'127.0.0.1');process.on('SIGTERM',()=>s.close(()=>process.exit(0)));`;
const command = port => ({ name: 'isolated-service', file: process.execPath, args: ['-e', serverCode, String(port)], env: { HOME: testHome }, port });
const logFile = (root, id) => path.join(launcherDirectory(root), 'diagnostics', id + '.jsonl');
async function rows(root, id) { return (await fs.readFile(logFile(root, id), 'utf8')).trim().split('\n').map(line => JSON.parse(line)); }
async function run(t, root, port, extra = {}) {
  const source = new EventEmitter();
  const running = await superviseLocal({ cwd: root, commands: [command(port)], signalSource: source, log() {}, timeoutMs: 4000, killAfterMs: 500, ...extra });
  t.after(async () => { await running.stop(); await running.completion; });
  return { running, source, id: running.instance.instance };
}
async function released(port) { const held = await reservePorts([port]); await Promise.all(held.map(s => new Promise(resolve => s.close(resolve)))); }

test('lifecycle diagnostics are synchronous, private, bounded, allowlisted and append across roles', async t => {
  const root = await fixture(t), instanceId = randomUUID();
  const first = lifecycleDiagnostics({ root, instanceId, role: 'launcher' });
  first.record('launcher_start', { reason: 'control_request', argv: 'PRIVATE PROMPT', apiKey: 'PRIVATE KEY', error: new Error('PRIVATE ERROR') });
  const second = lifecycleDiagnostics({ root, instanceId, role: 'guardian', service: 'Bearer synthetic-secret-credential\n' + 'x'.repeat(250) });
  second.record('launcher_ipc_disconnected', { exitCode: 1, errorCode: 'EPIPE' });
  const data = await rows(root, instanceId), text = JSON.stringify(data);
  assert.equal(data.length, 2); assert.equal(data[1].event, 'launcher_ipc_disconnected');
  assert.equal(data[0].instanceId, instanceId); assert.equal(data[1].instanceId, instanceId);
  assert.equal(data[0].pid, process.pid); assert.equal(data[0].ppid, process.ppid); assert.ok(Number.isFinite(Date.parse(data[0].time)));
  assert.equal((await fs.stat(first.file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(first.file))).mode & 0o777, 0o700);
  assert.ok(Buffer.byteLength(JSON.stringify(data[1])) < 2048); assert.ok(data[1].service.length <= 80);
  assert.doesNotMatch(text, /PRIVATE|synthetic-secret-credential|x{24}/);
  assert.ok(Number.isFinite(Date.parse(data[0].startedAt))); assert.ok(Date.parse(data[0].startedAt) <= Date.parse(data[0].time));
  assert.deepEqual(Object.keys(data[0]).sort(), ['event', 'instanceId', 'pid', 'ppid', 'reason', 'role', 'startedAt', 'time', 'version']);
});

test('unsafe log symlinks and hardlinks are not followed or modified', async t => {
  const root = await fixture(t), instanceId = randomUUID();
  const writer = lifecycleDiagnostics({ root, instanceId, role: 'launcher' });
  const target = path.join(root, 'private-sentinel'); await fs.writeFile(target, 'unchanged', { mode: 0o600 });
  await fs.symlink(target, writer.file); writer.record('launcher_start');
  assert.equal(await fs.readFile(target, 'utf8'), 'unchanged');
  await fs.unlink(writer.file); await fs.link(target, writer.file);
  lifecycleDiagnostics({ root, instanceId, role: 'launcher' }).record('launcher_start');
  assert.equal(await fs.readFile(target, 'utf8'), 'unchanged');
});

test('normal control stop retains preparation, service identities and durable completion', { timeout: 15000 }, async t => {
  const root = await fixture(t), port = await freePort();
  const { running, id } = await run(t, root, port, { prepare: [{ name: 'isolated-preparation', file: process.execPath, args: ['-e', 'process.exit(0)'], env: { HOME: testHome } }] });
  assert.equal(running.started, true); await running.stop(); assert.equal(await running.completion, 0);
  const data = await rows(root, id);
  assert.ok(data.some(x => x.event === 'command_exit' && x.service === 'isolated-preparation' && x.exitCode === 0));
  assert.ok(data.some(x => x.event === 'command_spawned' && x.service === 'isolated-service' && x.childPid > 0));
  assert.ok(data.some(x => x.event === 'command_registered' && x.service === 'isolated-service' && x.childPid > 0));
  assert.ok(data.some(x => x.event === 'command_close' && x.service === 'isolated-service'));
  assert.ok(data.some(x => x.event === 'group_clean' && x.service === 'isolated-service' && x.cleanupConfirmed));
  assert.deepEqual(data.at(-1).event, 'launcher_complete'); assert.equal(data.at(-1).reason, 'control_request');
  assert.equal(data.at(-1).exitCode, 0); assert.equal(data.at(-1).cleanupConfirmed, true);
  assert.ok(data.every(x => x.instanceId === id)); await released(port);
});

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  test(`${signal} records the received signal and keeps existing exit status and cleanup`, { timeout: 15000 }, async t => {
    const root = await fixture(t), port = await freePort();
    const codeText = `import {superviseLocal} from ${JSON.stringify(launcherModule)};const running=await superviseLocal({cwd:${JSON.stringify(root)},commands:[${JSON.stringify(command(port))}],log(){},killAfterMs:500});process.send({instanceId:running.instance.instance});process.exit(await running.completion);`;
    const launcher = spawn(process.execPath, ['--input-type=module', '-e', codeText], { cwd: root, env: { HOME: testHome }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = ''; launcher.stderr.on('data', chunk => { stderr += chunk; });
    const completion = new Promise((resolve, reject) => { launcher.once('exit', (code, signal) => resolve({ code, signal })); launcher.once('error', reject); });
    t.after(async () => { if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill('SIGTERM'); await completion; });
    const { instanceId: id } = await new Promise((resolve, reject) => { launcher.once('message', resolve); launcher.once('exit', () => reject(new Error('isolated launcher exited before ready'))); });
    launcher.kill(signal); assert.deepEqual(await completion, { code, signal: null }, stderr);
    const data = await rows(root, id);
    assert.ok(data.some(x => x.role === 'launcher' && x.event === 'signal_received' && x.signal === signal));
    assert.ok(data.some(x => x.event === 'launcher_stop_requested' && x.reason === 'signal_' + signal));
    const completed = data.find(x => x.event === 'launcher_complete');
    assert.equal(completed.exitCode, code); assert.equal(completed.cleanupConfirmed, true);
    assert.equal(data.at(-1).event, 'process_exit'); assert.equal(data.at(-1).exitCode, code);
    assert.equal(data.at(-1).processState, 'completed'); assert.equal(data.at(-1).childCount, 0); await released(port);
  });
}

test('unexpected service exit records exact code and service before existing all-group cleanup', { timeout: 15000 }, async t => {
  const root = await fixture(t), port = await freePort(), { running, id } = await run(t, root, port);
  await fetch(`http://127.0.0.1:${port}/exit7`); assert.equal(await running.completion, 1);
  const data = await rows(root, id);
  assert.ok(data.some(x => x.event === 'command_exit' && x.service === 'isolated-service' && x.exitCode === 7));
  assert.ok(data.some(x => x.event === 'launcher_stop_requested' && x.reason === 'command_exit'));
  assert.equal(data.at(-1).reason, 'command_exit'); await released(port);
});

test('a verified isolated service killed by signal reports the actual signal', { timeout: 15000 }, async t => {
  const root = await fixture(t), port = await freePort(), { running, id } = await run(t, root, port);
  const { pid } = await (await fetch(`http://127.0.0.1:${port}`)).json();
  assert.ok((await rows(root, id)).some(x => x.event === 'command_spawned' && x.childPid === pid));
  process.kill(pid, 'SIGUSR2'); assert.equal(await running.completion, 1);
  assert.ok((await rows(root, id)).some(x => x.event === 'command_exit' && x.childPid === pid && x.signal === 'SIGUSR2' && x.exitCode === undefined));
  await released(port);
});

test('an abandoned startup gate exits without running an unregistered command', { timeout: 15000 }, async t => {
  const root = await fixture(t), marker = path.join(root, 'must-not-start');
  const child = spawn('/bin/bash', [gateModule, process.execPath, '-e', "require('node:fs').writeFileSync(process.argv[1],'started')", marker], { cwd: root, env: { HOME: testHome }, detached: true, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] });
  const completion = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  child.stdio[3].end();
  assert.equal(await completion, 1);
  await assert.rejects(fs.access(marker), { code: 'ENOENT' });
});

test('unavailable diagnostic directory warns without changing service startup or stop', { timeout: 15000 }, async t => {
  const root = await fixture(t), port = await freePort(), folder = path.join(launcherDirectory(root), 'diagnostics');
  await fs.mkdir(folder, { recursive: true, mode: 0o700 }); await fs.chmod(folder, 0o755);
  const { running } = await run(t, root, port); assert.equal(running.started, true);
  await running.stop(); assert.equal(await running.completion, 0); await released(port);
  assert.deepEqual(await fs.readdir(folder), []); assert.equal((await fs.stat(folder)).mode & 0o777, 0o755);
});
