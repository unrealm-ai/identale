import { launcherDirectory, testHome } from './helpers/local-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const observerModule = new URL('../local/local-process-diagnostics.mjs', import.meta.url).href;
const logModule = new URL('../local/local-lifecycle-log.mjs', import.meta.url).href;

async function fixture(t, body, { flags = [], before = '', sinkFails = false } = {}) {
  const root = await fs.realpath(await fs.mkdtemp('/tmp/id-process-observer-'));
  const instanceId = randomUUID();
  const file = path.join(launcherDirectory(root), 'diagnostics', `${instanceId}.jsonl`);
  const script = `import {observeLauncherProcess} from ${JSON.stringify(observerModule)};
import {lifecycleDiagnostics} from ${JSON.stringify(logModule)};
${before}
const writer=lifecycleDiagnostics({root:${JSON.stringify(root)},instanceId:${JSON.stringify(instanceId)},role:'launcher'});
const beforeCounts=['uncaughtException','unhandledRejection','SIGHUP','exit'].map(name=>process.listenerCount(name));
const sink=${sinkFails ? "{record(){throw new Error('synthetic-private-message')}}" : 'writer'};
observeLauncherProcess(sink,{state:()=>({processState:'running',childCount:0})});
observeLauncherProcess(sink,{state:()=>({processState:'running',childCount:0})});
const afterCounts=['uncaughtException','unhandledRejection','SIGHUP','exit'].map(name=>process.listenerCount(name));
if(afterCounts[0]!==beforeCounts[0]||afterCounts[1]!==beforeCounts[1]||afterCounts[2]!==beforeCounts[2]+1||afterCounts[3]!==beforeCounts[3]+1)process.exit(99);
${body}`;
  const child = spawn(process.execPath, [...flags, '--input-type=module', '-e', script], { cwd: root, env: { HOME: testHome }, stdio: ['ignore', 'pipe', 'pipe'] });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 10000); deadline.unref();
  // Native stderr may contain the deliberately synthetic exception message.
  // Keep it in memory only, and never copy it to persisted diagnostic evidence.
  child.stderr.resume();
  const ready = new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.once('exit', () => reject(new Error('isolated observer exited before signal readiness')));
  });
  ready.catch(() => {});
  const done = new Promise((resolve, reject) => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', reject); });
  t.after(async () => {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await done; await fs.rm(root, { recursive: true, force: true });
  });
  return { child, ready, done, async rows() {
    const text = await fs.readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    assert.doesNotMatch(text, /synthetic-private-message|synthetic-private-token|stack|argv|environment/);
    return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  } };
}

test('natural exit and explicit exit retain status with synchronous final process evidence', async t => {
  for (const code of [0, 7]) {
    const f = await fixture(t, code ? 'process.exit(7);' : '');
    assert.deepEqual(await f.done, { code, signal: null });
    const data = await f.rows();
    assert.equal(data.at(-1).event, 'process_exit'); assert.equal(data.at(-1).exitCode, code);
    assert.equal(data.at(-1).processState, 'running'); assert.equal(data.at(-1).childCount, 0);
    assert.ok(data.at(-1).uptimeMs >= 0); assert.ok(Date.parse(data.at(-1).startedAt) <= Date.parse(data.at(-1).time));
    assert.equal(data.filter(row => row.event === 'process_before_exit').length, code ? 0 : 1);
    assert.equal(data.filter(row => row.event === 'process_exit').length, 1);
  }
});

test('fatal exception is observed without suppressing Node default crash or exposing error text', async t => {
  const f = await fixture(t, "setImmediate(()=>{const e=new TypeError('synthetic-private-message');e.code='EACCES';throw e;});");
  assert.deepEqual(await f.done, { code: 1, signal: null });
  const data = await f.rows(), fatal = data.find(row => row.event === 'process_fatal_exception');
  assert.equal(fatal.origin, 'uncaught_exception'); assert.equal(fatal.errorName, 'TypeError'); assert.equal(fatal.errorCode, 'EACCES');
  assert.equal(data.at(-1).reason, 'uncaught_exception'); assert.equal(data.at(-1).exitCode, 1);
});

for (const mode of ['default', 'throw', 'strict', 'warn', 'none']) {
  test(`unhandled rejection preserves Node ${mode} policy`, async t => {
    const f = await fixture(t, "Promise.reject(new Error('synthetic-private-message'));", { flags: mode === 'default' ? [] : [`--unhandled-rejections=${mode}`] });
    const fatal = ['default', 'throw', 'strict'].includes(mode);
    assert.deepEqual(await f.done, { code: fatal ? 1 : 0, signal: null });
    const data = await f.rows();
    assert.equal(data.some(row => row.event === 'process_fatal_exception' && row.origin === 'unhandled_rejection'), fatal);
    assert.equal(data.some(row => row.event === 'process_rejection_warning'), mode === 'warn');
  });
}

test('SIGHUP retains actual signal termination and records evidence before re-delivery', async t => {
  const f = await fixture(t, "setInterval(()=>{},1000);process.stdout.write('ready');");
  await f.ready; f.child.kill('SIGHUP');
  assert.deepEqual(await f.done, { code: null, signal: 'SIGHUP' });
  const data = await f.rows();
  assert.ok(data.some(row => row.event === 'signal_received' && row.signal === 'SIGHUP'));
  assert.equal(data.some(row => row.event === 'process_exit'), false);
});

test('SIGHUP preserves an existing once handler and its exit policy', async t => {
  const f = await fixture(t, "setInterval(()=>{},1000);process.stdout.write('ready');", { before: "process.once('SIGHUP',()=>process.exit(23));" });
  await f.ready; f.child.kill('SIGHUP');
  assert.deepEqual(await f.done, { code: 23, signal: null });
  assert.ok((await f.rows()).some(row => row.event === 'signal_received' && row.signal === 'SIGHUP'));
});

test('SIGKILL cannot be captured by in-process logging', async t => {
  const f = await fixture(t, "setInterval(()=>{},1000);process.stdout.write('ready');");
  await f.ready; f.child.kill('SIGKILL');
  assert.deepEqual(await f.done, { code: null, signal: 'SIGKILL' });
  const data = await f.rows();
  assert.equal(data.some(row => ['signal_received', 'process_exit', 'process_before_exit'].includes(row.event)), false);
});

test('a throwing diagnostics sink does not swallow the original fatal exception', async t => {
  const f = await fixture(t, "setImmediate(()=>{throw new Error('synthetic-private-message');});", { sinkFails: true });
  assert.deepEqual(await f.done, { code: 1, signal: null }); assert.deepEqual(await f.rows(), []);
});
