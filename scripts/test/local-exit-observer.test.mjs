import { launcherDirectory, testHome } from './helpers/local-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const observerModule = new URL('../local/local-exit-observer.mjs', import.meta.url).href;
const processModule = new URL('../local/local-process-diagnostics.mjs', import.meta.url).href;
const loggerModule = new URL('../local/local-lifecycle-log.mjs', import.meta.url).href;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
  for (let i = 0; i < 200; i++) { const result = await fn(); if (result) return result; await pause(20); }
  assert.fail('isolated exit observation did not arrive');
}
async function fixture(t, body, { handlers = true, commandFile = process.execPath } = {}) {
  const root = await fs.realpath(await fs.mkdtemp('/tmp/id-exit-observer-'));
  const instanceId = randomUUID();
  const manager = `import {enableLauncherParentObservation,observeLauncherProcess} from ${JSON.stringify(processModule)};
import {lifecycleDiagnostics} from ${JSON.stringify(loggerModule)};
${handlers ? "process.on('SIGINT',()=>process.exit(130));process.on('SIGTERM',()=>process.exit(143));" : ''}
enableLauncherParentObservation();
observeLauncherProcess(lifecycleDiagnostics({root:${JSON.stringify(root)},instanceId:${JSON.stringify(instanceId)},role:'launcher'}),{instanceId:${JSON.stringify(instanceId)},heartbeatMs:20,state:()=>({processState:'running',childCount:0})});
${body}`;
  const script = `import {observeLocalExit,applyObservedExit} from ${JSON.stringify(observerModule)};
const running=observeLocalExit({root:${JSON.stringify(root)},command:{file:${JSON.stringify(commandFile)},args:['--input-type=module','-e',${JSON.stringify(manager)}],env:{HOME:${JSON.stringify(testHome)}}},heartbeatMs:20});
process.stdout.write(JSON.stringify({observationId:running.observationId,managerPid:running.managerPid})+'\\n');
running.completion.then(applyObservedExit);`;
  // Disable core files only in this isolated fixture. No host settings change.
  const outer = spawn('/bin/bash', ['-c', 'ulimit -c 0; exec "$@"', 'isolated-exit-observer', process.execPath, '--input-type=module', '-e', script], { cwd: root, env: { HOME: testHome }, stdio: ['ignore', 'pipe', 'pipe'] });
  outer.stderr.resume();
  const done = new Promise((resolve, reject) => { outer.once('exit', (code, signal) => resolve({ code, signal })); outer.once('error', reject); });
  const metadata = await new Promise((resolve, reject) => {
    let output = '';
    outer.stdout.on('data', chunk => { output += chunk; if (output.includes('\n')) { try { resolve(JSON.parse(output.split('\n')[0])); } catch { reject(new Error('isolated observer metadata invalid')); } } });
    outer.once('exit', () => reject(new Error('isolated observer exited before metadata')));
    outer.once('error', reject);
  });
  const read = async id => {
    const text = await fs.readFile(path.join(launcherDirectory(root), 'diagnostics', `${id}.jsonl`), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    assert.doesNotMatch(text, /synthetic-private-message|synthetic-private-token|"argv"|"env"|"stack"/);
    return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  };
  t.after(async () => {
    if (outer.exitCode === null && outer.signalCode === null) outer.kill('SIGKILL');
    await done;
    // Every PID below belongs to the one synthetic manager created above.
    if (Number.isInteger(metadata.managerPid) && !(await read(metadata.observationId)).some(row => row.event === 'manager_exit') && !(await read(instanceId)).some(row => row.event === 'process_exit')) {
      try { process.kill(metadata.managerPid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, outer, done, ...metadata, rows: () => read(metadata.observationId), managerRows: () => read(instanceId), async bound() {
    await until(async () => (await read(metadata.observationId)).some(row => row.event === 'manager_instance_bound'));
  } };
}

for (const code of [0, 23, 137]) {
  test(`external observer retains explicit numeric exit ${code}, independently of signal numbers`, { timeout: 10000 }, async t => {
    const f = await fixture(t, `setTimeout(()=>process.exit(${code}),100);`);
    assert.deepEqual(await f.done, { code, signal: null });
    const rows = await f.rows(), exit = rows.find(row => row.event === 'manager_exit');
    assert.equal(exit.exitCode, code); assert.equal(exit.signal, undefined);
    assert.equal(exit.childPid, f.managerPid); assert.ok(exit.managerInstanceId); assert.ok(exit.lastHeartbeatAt);
    assert.equal(rows.filter(row => row.event === 'manager_spawned').length, 1);
  });
}

for (const [name, body, origin] of [
  ['uncaught exception', "setTimeout(()=>{throw new Error('synthetic-private-message');},100);", 'uncaught_exception'],
  ['unhandled rejection', "setTimeout(()=>Promise.reject(new Error('synthetic-private-message')),100);", 'unhandled_rejection'],
]) {
  test(`external observer records ${name} exit without suppressing fatal policy`, { timeout: 10000 }, async t => {
    const f = await fixture(t, body);
    assert.deepEqual(await f.done, { code: 1, signal: null });
    assert.equal((await f.rows()).find(row => row.event === 'manager_exit').exitCode, 1);
    assert.ok((await f.managerRows()).some(row => row.event === 'process_fatal_exception' && row.origin === origin));
  });
}

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', null]]) {
  test(`observer forwards ${signal} once and preserves the manager outcome`, { timeout: 10000 }, async t => {
    const f = await fixture(t, 'setInterval(()=>{},1000);'); await f.bound();
    f.outer.kill(signal);
    assert.deepEqual(await f.done, { code, signal: code === null ? signal : null });
    const rows = await f.rows();
    assert.equal(rows.filter(row => row.event === 'manager_signal_forwarded' && row.signal === signal && row.delivered).length, 1);
    const exit = rows.find(row => row.event === 'manager_exit');
    assert.equal(exit.exitCode ?? null, code); assert.equal(exit.signal ?? null, code === null ? signal : null);
  });
}

test('external parent observes SIGKILL while internal hooks cannot; no relaunch occurs', { timeout: 10000 }, async t => {
  const f = await fixture(t, 'setInterval(()=>{},1000);'); await f.bound();
  process.kill(f.managerPid, 'SIGKILL');
  assert.deepEqual(await f.done, { code: null, signal: 'SIGKILL' });
  const rows = await f.rows(), exit = rows.find(row => row.event === 'manager_exit');
  assert.equal(exit.signal, 'SIGKILL'); assert.equal(exit.exitCode, undefined); assert.ok(exit.lastHeartbeatAt);
  assert.equal(rows.filter(row => row.event === 'manager_spawned').length, 1);
  assert.equal((await f.managerRows()).some(row => row.event === 'process_exit'), false);
});

test('external parent observes a native abort as SIGABRT without relying on JS hooks', { timeout: 10000 }, async t => {
  const f = await fixture(t, 'setTimeout(()=>process.abort(),100);');
  assert.deepEqual(await f.done, { code: null, signal: 'SIGABRT' });
  assert.equal((await f.rows()).find(row => row.event === 'manager_exit').signal, 'SIGABRT');
  assert.equal((await f.managerRows()).some(row => row.event === 'process_exit'), false);
});

test('IPC heartbeat and disconnect observation do not keep a naturally finished manager alive', { timeout: 10000 }, async t => {
  const f = await fixture(t, '');
  assert.deepEqual(await f.done, { code: 0, signal: null });
  assert.equal((await f.rows()).find(row => row.event === 'manager_exit').exitCode, 0);
});

test('observer loss records IPC disconnect but does not stop or relaunch the manager', { timeout: 10000 }, async t => {
  const f = await fixture(t, "setTimeout(()=>process.exit(0),500);"); await f.bound();
  f.outer.kill('SIGKILL'); assert.deepEqual(await f.done, { code: null, signal: 'SIGKILL' });
  await until(async () => (await f.managerRows()).some(row => row.event === 'observer_disconnected'));
  await until(async () => (await f.managerRows()).some(row => row.event === 'process_exit' && row.exitCode === 0));
  assert.equal((await f.rows()).some(row => row.event === 'manager_exit'), false);
});

test('manager spawn failure has a durable exit reason and no repeated spawn', { timeout: 10000 }, async t => {
  const f = await fixture(t, '', { commandFile: '/nonexistent-isolated-launcher-fixture/node' });
  assert.deepEqual(await f.done, { code: 1, signal: null });
  const rows = await f.rows();
  assert.ok(rows.some(row => row.event === 'manager_process_error' && row.errorCode === 'ENOENT'));
  assert.equal(rows.find(row => row.event === 'manager_exit').exitCode, 1);
  assert.equal(rows.some(row => row.event === 'manager_spawned'), false);
});

test('extra or unrelated IPC payloads never enter observation logs', { timeout: 10000 }, async t => {
  const f = await fixture(t, "process.send({type:'unrelated',secret:'synthetic-private-token'});setTimeout(()=>process.exit(0),100);");
  assert.deepEqual(await f.done, { code: 0, signal: null }); await f.rows();
});
