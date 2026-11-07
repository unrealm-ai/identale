// Modified for Identale; see the root NOTICE.
import { launcherDirectory, testHome } from './helpers/local-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter, getEventListeners } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { superviseLocal, reservePorts, childEnvironments } from '../local/local-start.mjs';
import { requestInstance } from '../local/local-instance.mjs';
import { processIdentity, recoverProcesses } from '../local/local-recovery.mjs';
import { listenerOwnedByGroup, processGroupEmpty } from '../local/local-process-inspection.mjs';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, description = 'condition') { for (let i = 0; i < 150; i++) { const value = await fn(); if (value) return value; await pause(20); } assert.fail(description); }
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp('/tmp/dentity-restart-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function freePorts(n = 1) {
  const servers = Array.from({ length: n }, () => net.createServer());
  for (const s of servers) await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  const ports = servers.map(s => s.address().port);
  await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve))));
  return ports;
}
const serverCode = `const http=require('node:http'); const port=Number(process.argv[1]), ignore=process.argv[2]==='ignore';
const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({pid:process.pid,manager:process.ppid,service:'fixture',protocolVersion:1,status:'ready'}));if(req.url==='/fixture-shutdown')server.close(()=>process.exit(0));});
server.on('error',()=>process.exit(7));server.listen(port,'127.0.0.1');if(ignore)process.on('SIGTERM',()=>{});else process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`;
const commands = (ports, ignore = false) => ports.map((port, i) => ({ name: `fixture-${i}`, file: process.execPath, args: ['-e', serverCode, String(port), ignore ? 'ignore' : 'normal'], port, env: { HOME: testHome } }));
async function run(t, root, list, extra = {}) {
  const running = await superviseLocal({ cwd: root, commands: list, signalSource: new EventEmitter(), log() {}, timeoutMs: 2000, killAfterMs: 200, ...extra });
  t.after(async () => { await running.stop(); await running.completion; });
  return running;
}
async function released(ports) { const held = await reservePorts(ports); await Promise.all(held.map(s => new Promise(resolve => s.close(resolve)))); }
const statePath = root => path.join(launcherDirectory(root), 'instance.json');
async function stateFolder(root) { const dir = path.dirname(statePath(root)); await fs.mkdir(dir, { recursive: true, mode: 0o700 }); return dir; }
const deadRecord = (root, ports) => ({ version: 1, root, instance: randomUUID(), pid: 2147483647, ports });

test('R1 two same-root restarts stop all four previous services and hand over state', async t => {
  const root = await fixture(t), ports = await freePorts(4);
  let previous = await run(t, root, commands(ports));
  for (let restart = 0; restart < 2; restart++) {
    const before = await Promise.all(ports.map(async port => (await (await fetch(`http://127.0.0.1:${port}`)).json()).pid));
    const next = await run(t, root, commands(ports));
    assert.equal(await previous.completion, 0);
    assert.equal(previous.cleanupConfirmed, true);
    assert.notEqual(next.instance.instance, previous.instance.instance);
    for (const [index, port] of ports.entries()) {
      const after = await (await fetch(`http://127.0.0.1:${port}`)).json();
      assert.notEqual(after.pid, before[index]);
      assert.equal(await processGroupEmpty(before[index]), true);
    }
    assert.equal(JSON.parse(await fs.readFile(statePath(root))).instance, next.instance.instance);
    previous = next;
  }
});

test('a verified cleanup rejection recovers a dead manager but does not signal an unrelated live PID', async t => {
  for (const ownerAlive of [false, true]) {
    const root = await fixture(t), ports = await freePorts(), dir = await stateFolder(root);
    const record = ownerAlive ? { ...deadRecord(root, ports), pid: process.pid, owner: await processIdentity(process.pid) } : deadRecord(root, ports);
    await fs.writeFile(statePath(root), JSON.stringify(record), { mode: 0o600 });
    const socketPath = path.join(dir, 'control.sock'), actions = [];
    // Reuse the existing protocol-server fixture with a matching identity and
    // the cleanup_unverified response emitted by the previous launcher.
    const server = net.createServer(socket => socket.on('data', input => {
      const request = JSON.parse(String(input)); actions.push(request.action);
      socket.end(JSON.stringify({ ...record, action: request.action, ...(request.action === 'stop' ? { error: 'cleanup_unverified' } : {}) }) + '\n');
      if (request.action === 'stop') server.close();
    }));
    await new Promise(resolve => server.listen(socketPath, resolve)); await fs.chmod(socketPath, 0o600);
    t.after(() => { if (server.listening) return new Promise(resolve => server.close(resolve)); });
    if (ownerAlive) {
      await assert.rejects(run(t, root, commands(ports)), /cannot be verified/);
      assert.equal(process.kill(process.pid, 0), true);
      assert.equal(JSON.parse(await fs.readFile(statePath(root))).instance, record.instance);
      await released(ports);
    } else {
      const next = await run(t, root, commands(ports));
      assert.equal(next.started, true);
      assert.notEqual(next.instance.instance, record.instance);
    }
    assert.deepEqual(actions, ['inspect', 'stop']);
  }
});

for (const entry of ['scripts/local-manager-entry.mjs', 'scripts/local/local-manager-entry.mjs'])
for (const missingState of [false, true]) test(`a matching same-root manager (${entry}) is stopped with ${missingState ? 'missing state' : 'a cleanup rejection'}`, async t => {
  const root = await fixture(t), ports = await freePorts(), dir = await stateFolder(root);
  const script = path.join(root, entry), socketPath = path.join(dir, 'control.sock');
  await fs.mkdir(path.dirname(script), { recursive: true });
  // Use the existing Node/control-server fixture as a stalled previous manager.
  // It returns the old cleanup error and stays alive until OS recovery stops it.
  await fs.writeFile(script, `import net from 'node:net';import fs from 'node:fs/promises';
const server=net.createServer(socket=>socket.on('data',async input=>{const request=JSON.parse(String(input));const record=JSON.parse(await fs.readFile(${JSON.stringify(statePath(root))},'utf8'));socket.end(JSON.stringify({...record,action:request.action,...(request.action==='stop'?{error:'cleanup_unverified'}:{})})+'\\n');}));
server.listen(${JSON.stringify(socketPath)},()=>process.stdout.write('ready'));`);
  const worker = spawn(process.execPath, [script], { cwd: root, env: { HOME: testHome }, stdio: ['ignore', 'pipe', 'ignore'] });
  const ready = new Promise(resolve => worker.stdout.once('data', resolve));
  const exited = new Promise(resolve => worker.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => { if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL'); await exited; });
  await ready;
  const identity = await processIdentity(worker.pid);
  const record = { ...deadRecord(root, ports), pid: worker.pid, owner: identity };
  if (!missingState) await fs.writeFile(statePath(root), JSON.stringify(record), { mode: 0o600 });
  await fs.chmod(socketPath, 0o600);
  const next = await run(t, root, commands(ports));
  assert.equal(next.started, true);
  assert.deepEqual(await exited, { code: null, signal: 'SIGTERM' });
  assert.notEqual(next.instance.instance, record.instance);
});
test('R2 concurrent starts reject the contender while preparation keeps the gate', async t => {
  const root = await fixture(t), ports = await freePorts();
  const pending = run(t, root, commands(ports), { prepare: [{ name: 'bounded preparation', file: process.execPath, args: ['-e', "require('node:fs').writeFileSync('preparing','1');setTimeout(()=>process.exit(0),400)"], env: { HOME: testHome } }] });
  await until(() => fs.access(path.join(root, 'preparing')).then(() => true, () => false));
  await assert.rejects(superviseLocal({ cwd: root, commands: commands(ports), log() {} }), /startup.*gate|Another startup/);
  const running = await pending; assert.equal(running.started, true);
});
test('R3/R7 an unmanaged listener is never adopted or killed, including another-project name', async t => {
  const root = await fixture(t), listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => listener.close(resolve)));
  await assert.rejects(run(t, root, commands([listener.address().port])), /unavailable/);
  assert.equal(listener.listening, true);
  await assert.rejects(fs.access(statePath(root)));
});
test('R4 dead owner files are recovered, including cleanupUnverified legacy records', async t => {
  for (const cleanupUnverified of [false, true]) {
    const root = await fixture(t), ports = await freePorts(); await stateFolder(root);
    const record = { ...deadRecord(root, ports), cleanupUnverified };
    await fs.writeFile(statePath(root), JSON.stringify(record), { mode: 0o600 });
    const next = await run(t, root, commands(ports));
    assert.equal(next.started, true);
    assert.notEqual(next.instance.instance, record.instance);
    await next.stop(); await next.completion; await released(ports);
  }
});
test('R4 an unverifiable live legacy PID is never signalled', async t => {
  const root = await fixture(t), ports = await freePorts(); await stateFolder(root);
  const record = { ...deadRecord(root, ports), pid: process.pid };
  await fs.writeFile(statePath(root), JSON.stringify(record), { mode: 0o600 });
  await assert.rejects(run(t, root, commands(ports)), /cannot be verified/);
  assert.equal(JSON.parse(await fs.readFile(statePath(root))).instance, record.instance);
  assert.equal(process.kill(process.pid, 0), true);
});
test('R4 PID reused with a different start identity does not block recovery or get signalled', async t => {
  const root = await fixture(t), ports = await freePorts(); await stateFolder(root);
  const owner = { ...await processIdentity(process.pid), start: 'previous process birth' };
  await fs.writeFile(statePath(root), JSON.stringify({ ...deadRecord(root, ports), pid: process.pid, owner }), { mode: 0o600 });
  const next = await run(t, root, commands(ports));
  assert.equal(next.started, true); assert.equal(process.kill(process.pid, 0), true);
});
test('R4 group identity mismatch or missing marker never authorizes a signal', async t => {
  const root = await fixture(t);
  const worker = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: root, env: { HOME: testHome }, detached: true, stdio: 'ignore' });
  t.after(() => { if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL'); });
  const identity = await until(() => processIdentity(worker.pid));
  const group = { ...identity, marker: randomUUID() };
  await assert.rejects(recoverProcesses(root, { groups: [group] }, { log() {} }), /identity cannot be verified/);
  assert.equal(process.kill(worker.pid, 0), true);
  await recoverProcesses(root, { groups: [{ ...group, start: 'recycled group identity' }] }, { log() {} });
  assert.equal(process.kill(worker.pid, 0), true);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(recoverProcesses(root, { groups: [group] }, { signal: controller.signal, log() {} }), /interrupted/);
  assert.equal(process.kill(worker.pid, 0), true);
});
test('R4 root mismatch and instance response mismatch cannot stop a live original', async t => {
  const root = await fixture(t), ports = await freePorts(), running = await run(t, root, commands(ports));
  const record = JSON.parse(await fs.readFile(statePath(root)));
  await assert.rejects(requestInstance(running.socketPath, { ...record, instance: randomUUID() }, 'inspect', { timeoutMs: 500 }), /closed|response|time/);
  await fs.writeFile(statePath(root), JSON.stringify({ ...record, root: root + '-other' }));
  await assert.rejects(run(t, root, commands(ports)), /another repository/);
  assert.equal((await fetch(`http://127.0.0.1:${ports[0]}`)).status, 200);
});
test('R5 invalid, oversized, permissive, symlink and hardlink state are rejected without launch', async t => {
  for (const kind of ['null', 'json', 'oversize', 'permission', 'symlink', 'hardlink', 'directory', 'fifo']) {
    const root = await fixture(t), ports = await freePorts(); await stateFolder(root);
    const target = statePath(root), other = path.join(root, 'foreign-state');
    const data = JSON.stringify(deadRecord(root, ports));
    if (kind === 'fifo') { execFileSync('mkfifo', [target], { env: { PATH: '/usr/bin:/bin' } }); await fs.chmod(target, 0o600); }
    else if (kind === 'directory') await fs.mkdir(target, { mode: 0o700 });
    else if (kind === 'symlink') { await fs.writeFile(other, data, { mode: 0o600 }); await fs.symlink(other, target); }
    else { await fs.writeFile(target, kind === 'null' ? 'null' : kind === 'json' ? '{broken' : kind === 'oversize' ? ' '.repeat(5000) : data, { mode: kind === 'permission' ? 0o644 : 0o600 }); if (kind === 'hardlink') await fs.link(target, other); }
    if (kind === 'permission') await fs.chmod(target, 0o644); // Creation mode is masked by the caller's umask.
    await assert.rejects(run(t, root, commands(ports)), /Invalid|Unsafe|ELOOP/);
    assert.equal((await fs.lstat(target)).isSymbolicLink(), kind === 'symlink');
    await released(ports);
  }
});
test('R5 fake control identity is rejected before sending stop', async t => {
  const root = await fixture(t), ports = await freePorts(), dir = await stateFolder(root), record = { ...deadRecord(root, ports), pid: process.pid };
  await fs.writeFile(statePath(root), JSON.stringify(record), { mode: 0o600 });
  const socketPath = path.join(dir, 'control.sock'), actions = [];
  const fake = net.createServer(socket => socket.on('data', input => { const req = JSON.parse(String(input)); actions.push(req.action); socket.end(JSON.stringify({ ...record, root: root + '-wrong', action: req.action }) + '\n'); }));
  await new Promise(resolve => fake.listen(socketPath, resolve)); await fs.chmod(socketPath, 0o600);
  t.after(() => new Promise(resolve => fake.close(resolve)));
  await assert.rejects(run(t, root, commands(ports)), /identity mismatch/);
  assert.deepEqual(actions, ['inspect']);
});
test('R5 malformed control input closes the socket without crashing or stopping the instance', async t => {
  const root = await fixture(t), ports = await freePorts(), running = await run(t, root, commands(ports));
  for (const payload of ['null\n', '{invalid\n', 'x'.repeat(1100)]) await new Promise((resolve, reject) => {
    const socket = net.createConnection(running.socketPath); socket.on('error', reject);
    socket.on('connect', () => socket.end(payload)); socket.on('close', resolve);
  });
  assert.equal((await requestInstance(running.socketPath, running.instance, 'inspect')).action, 'inspect');
  assert.equal((await fetch(`http://127.0.0.1:${ports[0]}`)).status, 200);
});
test('R6 ignored TERM is forcibly cleaned by the single manager after verifying each process identity', async t => {
  const root = await fixture(t), ports = await freePorts(), running = await run(t, root, commands(ports, true));
  await running.stop(); assert.equal(await running.completion, 0); await released(ports);
});
test('R6 command exit leaving a descendant is cleaned using recorded identities after the command leader exits', async t => {
  const root = await fixture(t), ports = await freePorts();
  const code = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(serverCode)},process.argv[1],'ignore'],{stdio:'inherit'});setTimeout(()=>process.exit(0),250);`;
  const list = commands(ports); list[0].args = ['-e', code, String(ports[0])];
  const running = await run(t, root, list);
  assert.equal(await running.completion, 1); await released(ports);
});
test('R6 services are direct children of the one manager and retain distinct process groups', async t => {
  const root = await fixture(t), ports = await freePorts(2), running = await run(t, root, commands(ports));
  const record = JSON.parse(await fs.readFile(statePath(root)));
  for (const port of ports) {
    const identity = await (await fetch(`http://127.0.0.1:${port}`)).json();
    assert.equal(identity.manager, process.pid);
    assert.ok(record.groups.some(group => group.pid === identity.pid));
    assert.equal(await listenerOwnedByGroup(port, identity.pid), true);
  }
  assert.equal(record.groups.length, 2);
});
test('R7 stale startup gate fails closed and is not blindly removed', async t => {
  const root = await fixture(t), ports = await freePorts(), dir = await stateFolder(root);
  await fs.mkdir(path.join(dir, 'starting'), { mode: 0o700 });
  await assert.rejects(run(t, root, commands(ports)), /stale startup gate/);
  assert.equal((await fs.stat(path.join(dir, 'starting'))).isDirectory(), true);
});
test('R7 stale gate with a dead recorded owner is recovered automatically', async t => {
  const root = await fixture(t), ports = await freePorts(), dir = await stateFolder(root);
  const gate = path.join(dir, 'starting'); await fs.mkdir(gate, { mode: 0o700 });
  await fs.writeFile(path.join(gate, 'owner.json'), JSON.stringify(deadRecord(root, ports)), { mode: 0o600 });
  const next = await run(t, root, commands(ports));
  assert.equal(next.started, true); await assert.rejects(fs.access(gate));
});
test('R7 simultaneous recovery of a stale gate has one startup winner', async t => {
  const root = await fixture(t), ports = await freePorts(), dir = await stateFolder(root);
  const gate = path.join(dir, 'starting'); await fs.mkdir(gate, { mode: 0o700 });
  await fs.writeFile(path.join(gate, 'owner.json'), JSON.stringify(deadRecord(root, ports)), { mode: 0o600 });
  const pending = [run(t, root, commands(ports)), run(t, root, commands(ports))];
  const outcomes = await Promise.allSettled(pending);
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(value => value.status === 'rejected').length, 1);
  assert.equal(outcomes.find(value => value.status === 'fulfilled').value.started, true);
});
test('R7 a live startup owner remains busy and is not terminated', async t => {
  const root = await fixture(t), ports = await freePorts(), dir = await stateFolder(root);
  const gate = path.join(dir, 'starting'); await fs.mkdir(gate, { mode: 0o700 });
  await fs.writeFile(path.join(gate, 'owner.json'), JSON.stringify({ ...deadRecord(root, ports), pid: process.pid, owner: await processIdentity(process.pid) }), { mode: 0o600 });
  await assert.rejects(run(t, root, commands(ports)), /Another startup/);
  assert.equal(process.kill(process.pid, 0), true);
  assert.equal((await fs.stat(gate)).isDirectory(), true);
});
test('R4 orphaned control socket with no state is removed and replaced', async t => {
  const root = await fixture(t), ports = await freePorts(), dir = await stateFolder(root), socket = path.join(dir, 'control.sock');
  const worker = spawn(process.execPath, ['-e', "const fs=require('node:fs'),net=require('node:net');net.createServer().listen(process.argv[1],()=>fs.chmodSync(process.argv[1],0o600));", socket], { env: { HOME: testHome }, stdio: 'ignore' });
  t.after(() => { if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL'); });
  await until(() => fs.stat(socket).then(stat => stat.isSocket() && (stat.mode & 0o777) === 0o600, () => false));
  const done = new Promise(resolve => worker.once('exit', resolve)); worker.kill('SIGKILL'); await done;
  const next = await run(t, root, commands(ports)); assert.equal(next.started, true);
  assert.equal((await requestInstance(socket, next.instance, 'inspect')).instance, next.instance.instance);
});
for (const relative of ['apps/mock-model/dist/main.js', 'scripts/local-start.mjs', 'scripts/local/local-start.mjs'])
test(`R7 exact project entry ${relative} is cleaned but the same entry in another cwd survives`, async t => {
  const root = await fixture(t), otherRoot = await fixture(t), ports = await freePorts(2);
  const workers = [];
  for (const [cwd, port] of [[root, ports[0]], [otherRoot, ports[1]]]) {
    const file = path.join(cwd, relative); await fs.mkdir(path.dirname(file), { recursive: true });
    let source = serverCode.replace('const port=Number(process.argv[1]), ignore=process.argv[2]', 'const port=Number(process.argv[2]), ignore=process.argv[3]');
    if (relative.endsWith('.mjs')) source = source.replace("const http=require('node:http');", "import http from 'node:http';");
    await fs.writeFile(file, source);
    const worker = spawn(process.execPath, [relative, String(port), 'normal'], { cwd, env: { HOME: testHome }, stdio: 'ignore', detached: true });
    workers.push(worker);
    t.after(() => { if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL'); });
    await until(() => fetch(`http://127.0.0.1:${port}`).then(r => r.ok, () => false));
  }
  const next = await run(t, root, commands([ports[0]])); assert.equal(next.started, true);
  assert.throws(() => process.kill(workers[0].pid, 0), { code: 'ESRCH' });
  assert.equal(process.kill(workers[1].pid, 0), true);
  assert.equal((await fetch(`http://127.0.0.1:${ports[1]}`)).status, 200);
});
test('R8 preparatory and each partial four-service failure clean this instance only', async t => {
  for (const failed of [-1, 0, 1, 2, 3]) {
    const root = await fixture(t), ports = await freePorts(4), list = commands(ports);
    const prepare = failed === -1 ? [{ name: 'failed preparation', file: process.execPath, args: ['-e', 'process.exit(7)'], env: { HOME: testHome } }] : [];
    if (failed >= 0) list[failed].args = ['-e', 'process.exit(7)'];
    const running = await run(t, root, list, { prepare });
    assert.equal(await running.completion, 1); await released(ports); await assert.rejects(fs.access(statePath(root)));
  }
});
test('R8 startup timeout cleans its owned group and releases reservations', async t => {
  const root = await fixture(t), ports = await freePorts(2), list = commands(ports);
  list[1].args = ['-e', 'setInterval(()=>{},1000)'];
  const running = await run(t, root, list, { timeoutMs: 150 });
  assert.equal(await running.completion, 1); await released(ports);
});
test('R8 a port stolen after reservation release never becomes fake readiness or a kill target', async t => {
  const root = await fixture(t), ports = await freePorts(), list = commands(ports);
  list[0].args = ['-e', `setTimeout(()=>{${serverCode}},500)`, String(ports[0]), 'normal'];
  const pending = run(t, root, list, { timeoutMs: 1200, prepare: [{ name: 'race coordination', file: process.execPath, args: ['-e', "require('node:fs').writeFileSync('reserved','1');setTimeout(()=>process.exit(0),200)"], env: { HOME: testHome } }] });
  await until(() => fs.access(path.join(root, 'reserved')).then(() => true, () => false));
  const competitor = net.createServer(); competitor.on('error', () => {});
  t.after(() => competitor.listening ? new Promise(resolve => competitor.close(resolve)) : undefined);
  await until(async () => { if (competitor.listening) return true; await new Promise(resolve => { const failed = () => { competitor.off('listening', bound); resolve(); }; const bound = () => { competitor.off('error', failed); resolve(); }; competitor.once('error', failed); competitor.once('listening', bound); competitor.listen(ports[0], '127.0.0.1'); }); return competitor.listening; }, 'competitor acquires released port');
  const running = await pending;
  assert.equal(running.started, false); assert.equal(await running.completion, 1); assert.equal(competitor.listening, true);
});
test('R9 SIGINT/SIGTERM/SIGHUP during preparation release gate, state and owned preparation', async t => {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const root = await fixture(t), ports = await freePorts(), source = new EventEmitter();
    const pending = run(t, root, commands(ports), { signalSource: source, prepare: [{ name: 'held preparation', file: process.execPath, args: ['-e', "require('node:fs').writeFileSync('held','1');setInterval(()=>{},1000)"], env: { HOME: testHome } }] });
    await until(() => fs.access(path.join(root, 'held')).then(() => true, () => false)); source.emit(signal);
    const running = await pending; assert.equal(await running.completion, ({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 })[signal]); await released(ports); await assert.rejects(fs.access(statePath(root)));
  }
});
test('R9 interrupting an old/new handover releases the new gate without signalling stale identities', async t => {
  const root = await fixture(t), ports = await freePorts(), list = commands(ports);
  list[0].args = ['-e', serverCode.replace("server.close(()=>process.exit(0)))", "{require('node:fs').writeFileSync('terminating','1');setTimeout(()=>server.close(()=>process.exit(0)),400)})"), String(ports[0]), 'normal'];
  const first = await run(t, root, list, { killAfterMs: 1000 });
  const source = new EventEmitter();
  const pending = superviseLocal({ cwd: root, commands: commands(ports), signalSource: source, log() {}, killAfterMs: 1000 });
  await until(() => fs.access(path.join(root, 'terminating')).then(() => true, () => false));
  source.emit('SIGINT'); await assert.rejects(pending, /interrupted/);
  await first.completion;
  const next = await run(t, root, commands(ports));
  assert.equal(JSON.parse(await fs.readFile(statePath(root))).instance, next.instance.instance);
});
test('R10 fourth service needs matching HTTP readiness identity; a live wrong endpoint is rejected', async t => {
  for (const service of ['fixture', 'wrong-service']) {
    const root = await fixture(t), ports = await freePorts(4), list = commands(ports);
    list[3].health = { path: '/readyz', service, protocolVersion: 1, status: 'ready' };
    const running = await run(t, root, list, { timeoutMs: 1000 });
    assert.equal(running.started, service === 'fixture');
    await running.stop(); await running.completion; await released(ports);
  }
});
test('R10 mock environment is secret-free and retired model allowlist is not propagated', async t => {
  const root = await fixture(t);
  const env = await childEnvironments({ HOME: root, DENTITY_LOCAL_SECRETS_PATH: path.join(root, 'none.json'), DENTITY_MODEL_MASTER_KEY: Buffer.alloc(32, 5).toString('base64'), DENTITY_RUNTIME_HOST_TOKEN: 'synthetic-host', DENTITY_PLATFORM_RESOLVER_TOKEN: 'synthetic-resolver', OPENAI_API_KEY: 'must-not-leak', DENTITY_MODEL_ALLOWED_ORIGINS: 'https://approved.example' });
  assert.equal(env.platform.DENTITY_MODEL_ALLOW_LOOPBACK_HTTP, 'false');
  for (const child of Object.values(env)) assert.equal(child.DENTITY_MODEL_ALLOWED_ORIGINS, undefined);
  assert.equal(env.mockModel.DENTITY_MOCK_MODEL_PORT, '18302');
  for (const key of ['OPENAI_API_KEY', 'DENTITY_MODEL_MASTER_KEY', 'DENTITY_RUNTIME_HOST_TOKEN', 'DENTITY_PLATFORM_RESOLVER_TOKEN', 'DENTITY_MODEL_ALLOWED_ORIGINS', 'DENTITY_MODEL_ALLOW_LOOPBACK_HTTP']) assert.equal(env.mockModel[key], undefined);
});
test(`R11 ${process.platform} real listener metadata distinguishes owned and foreign groups`, async t => {
  const root = await fixture(t), ports = await freePorts(), running = await run(t, root, commands(ports));
  const identity = await (await fetch(`http://127.0.0.1:${ports[0]}`)).json();
  assert.equal(await listenerOwnedByGroup(ports[0], identity.pid), true);
  assert.equal(await processGroupEmpty(identity.pid), false);
  assert.equal(await listenerOwnedByGroup(ports[0], process.pid), false);
  await running.stop(); await running.completion;
  assert.equal(await listenerOwnedByGroup(ports[0], identity.pid), false);
  assert.equal(await processGroupEmpty(identity.pid), true);
});

test('P2-1 restart recovers a surviving non-listening service after the single manager is killed', { timeout: 15000 }, async t => {
  const root = await fs.realpath(await fs.mkdtemp('/tmp/dentity-crash-case-')), [port] = await freePorts();
  const sentinel = "const fs=require('node:fs'),http=require('node:http');const root=process.argv[1];const s=http.createServer((req,res)=>{res.end(JSON.stringify({pid:process.pid,manager:process.ppid}));if(req.url==='/release')s.close();});s.listen(Number(process.argv[2]),'127.0.0.1');setInterval(()=>{if(fs.existsSync(root+'/sentinel.exit'))process.exit(0)},30);";
  const command = { name: 'crash sentinel', file: process.execPath, args: ['-e', sentinel, root, String(port)], port, env: { HOME: testHome } };
  const launcherModule = pathToFileURL(path.resolve('scripts/local/local-start.mjs')).href;
  const workerCode = `import fs from 'node:fs/promises';import {superviseLocal} from ${JSON.stringify(launcherModule)};const running=await superviseLocal({cwd:${JSON.stringify(root)},commands:[${JSON.stringify(command)}],log(){},killAfterMs:200});await fs.writeFile(${JSON.stringify(path.join(root, 'owner-ready'))},'1');await running.completion;`;
  const worker = spawn(process.execPath, ['--input-type=module', '-e', workerCode], { env: { HOME: testHome }, stdio: 'inherit' });
  let identity;
  t.after(async () => { try { await fs.writeFile(path.join(root, 'sentinel.exit'), '1'); if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL'); if (identity) await until(() => { try { process.kill(identity.pid, 0); return false; } catch { return true; } }, 'owned sentinel exits'); } finally { await fs.rm(root, { recursive: true, force: true }); } });
  await until(() => fs.access(path.join(root, 'owner-ready')).then(() => true, () => false));
  identity = await (await fetch(`http://127.0.0.1:${port}`)).json();
  const exited = new Promise(resolve => worker.once('exit', resolve)); worker.kill('SIGKILL'); await exited;
  await fetch(`http://127.0.0.1:${port}/release`); await until(() => released([port]).then(() => true, () => false));
  assert.equal(process.kill(identity.pid, 0), true);
  const next = await run(t, root, commands([port]));
  assert.equal(next.started, true);
  assert.throws(() => process.kill(identity.pid, 0), { code: 'ESRCH' });
});
test('P2-3 continuous small response chunks cannot extend the absolute deadline or retain request listeners', async t => {
  const root = await fixture(t), socketPath = path.join(root, 'slow.sock'), sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {});
    const timer = setInterval(() => socket.write(' '), 10);
    socket.on('close', () => { clearInterval(timer); sockets.delete(socket); });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  const cancel = new AbortController(), start = performance.now();
  await assert.rejects(requestInstance(socketPath, { ...deadRecord(root, [49152]), pid: process.pid }, 'inspect', { timeoutMs: 100, signal: cancel.signal }), /absolute deadline/);
  assert.ok(performance.now() - start < 500, 'drip traffic must not refresh timeout');
  await until(() => sockets.size === 0, 'request socket closes');
  assert.equal(getEventListeners(cancel.signal, 'abort').length, 0);
});

test('P2-3 response cap counts UTF-8 bytes and closes an oversized response before its deadline', async t => {
  const root = await fixture(t), socketPath = path.join(root, 'oversize.sock');
  const server = net.createServer(socket => { socket.on('error', () => {}); socket.once('data', () => socket.write('🚀'.repeat(1100))); });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(requestInstance(socketPath, { ...deadRecord(root, [49152]), pid: process.pid }, 'inspect', { timeoutMs: 1000 }), /Invalid local instance response/);
});
