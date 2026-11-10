import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// Approved synthetic popup fixtures only. No provider network or real credentials.
const directory = await mkdtemp(resolve('apps/web/.wecom-registration-test-'));
await build({ entryPoints: ['apps/web/src/features/employees/wecom-registration.ts'], outfile: join(directory, 'adapter.mjs'), bundle: true, platform: 'node', format: 'esm' });
const { beginWeComRegistration, WECOM_REGISTRATION_ORIGIN: origin, WECOM_REGISTRATION_SOURCE: source, WECOM_REGISTRATION_TIMEOUT_MS: timeout } = await import(pathToFileURL(join(directory, 'adapter.mjs')));
test.after(() => rm(directory, { recursive: true, force: true }));
const success = { type: 'AUTH_SUCCESS', payload: { botid: 'synthetic-bot', secret: 'synthetic-secret' } };
function fixture(mode) {
  const listeners = new Map(), timers = new Map(), intervals = new Map(), statuses = [], credentials = [], opens = [];
  let sequence = 0;
  const popup = { closed: false, close() { this.closed = true; } };
  const host = {
    crypto: { randomUUID: () => `synthetic-state-${++sequence}` },
    addEventListener(name, fn) { (listeners.get(name) ?? listeners.set(name, new Set()).get(name)).add(fn); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
    setTimeout(fn) { const id = ++sequence; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    setInterval(fn) { const id = ++sequence; intervals.set(id, fn); return id; }, clearInterval(id) { intervals.delete(id); },
    open(...args) { opens.push(args); if (mode === 'throw') throw Error('synthetic-secret'); return mode === 'blocked' ? null : popup; },
  };
  const dispatch = (name, event = {}) => [...(listeners.get(name) ?? [])].forEach(fn => fn(event));
  const attempt = beginWeComRegistration({ host, onStatus: status => statuses.push(status), onCredentials: value => credentials.push(value) });
  return { host, popup, opens, statuses, credentials, timers, intervals, attempt, dispatch,
    message(data = success, event = {}) { dispatch('message', { origin, source: popup, data, ...event }); },
    clean() { assert.equal(timers.size + intervals.size, 0); assert.ok([...listeners.values()].every(set => !set.size)); },
  };
}
test('official URL uses identale, unique popup state and default five-minute lifecycle; success consumed once', () => {
  const f = fixture(), [url, name, features] = f.opens[0], parsed = new URL(url);
  assert.equal(origin, 'https://work.weixin.qq.com'); assert.equal(source, 'identale'); assert.equal(timeout, 300000);
  assert.equal(parsed.origin, origin); assert.equal(parsed.pathname, '/ai/qc/gen'); assert.equal(parsed.searchParams.get('source'), 'identale');
  assert.ok(name.includes(parsed.searchParams.get('state'))); assert.ok(!features.includes('noopener'));
  f.message({ type: 'QR_CODE_READY' }); f.message(); f.message(); f.attempt.cancel();
  assert.deepEqual(f.statuses, ['waiting', 'ready', 'received']); assert.deepEqual(f.credentials, [{ botId: 'synthetic-bot', secret: 'synthetic-secret' }]); assert.equal(f.popup.closed, true); f.clean();
});
test('rejects spoofed origins and non-popup sources without consuming genuine callback', () => {
  const f = fixture();
  for (const bad of ['https://evil.example', 'http://work.weixin.qq.com', 'https://work.weixin.qq.com.evil.example', 'null']) f.message(success, { origin: bad });
  for (const bad of [null, {}, f.host]) f.message(success, { source: bad });
  assert.deepEqual(f.statuses, ['waiting']); assert.equal(f.credentials.length, 0); f.message(); assert.equal(f.credentials.length, 1); f.clean();
});
test('optional state is accepted only when every returned state matches', () => {
  for (const position of ['top', 'payload', 'both']) for (const matches of [true, false]) {
    const f = fixture(), data = structuredClone(success), state = matches ? new URL(f.opens[0][0]).searchParams.get('state') : 'foreign-state';
    if (position !== 'payload') data.state = state;
    if (position !== 'top') data.payload.state = state;
    f.message(data); assert.equal(f.statuses.at(-1), matches ? 'received' : 'failed'); assert.equal(f.credentials.length, matches ? 1 : 0); f.clean();
  }
});
test('malformed envelopes ignored; invalid credentials fail closed without leaking values', () => {
  const f = fixture(); for (const data of [null, [], 'synthetic-secret', {}, { type: 'UNKNOWN' }]) f.message(data);
  assert.deepEqual(f.statuses, ['waiting']); f.attempt.cancel(); f.clean();
  for (const payload of [null, [], {}, { botid: 1, secret: 'synthetic-secret' }, { botid: 'a', secret: '' }, { botid: ' a', secret: 'synthetic-secret' }, { botid: 'a', secret: 'bad\nsecret' }, { botid: 'a'.repeat(257), secret: 'synthetic-secret' }, { botid: 'a', secret: 'x'.repeat(8193) }]) {
    const f = fixture(); f.message({ type: 'AUTH_SUCCESS', payload }); assert.deepEqual(f.statuses, ['waiting', 'failed']); assert.deepEqual(f.credentials, []); f.clean();
  }
});
test('cancel, provider cancel/error, navigation, timeout and popup closure reject every late callback', () => {
  const stops = [f => f.attempt.cancel(), f => f.dispatch('pagehide'), f => f.dispatch('popstate'), f => [...f.timers.values()][0](), f => { f.popup.closed = true; [...f.intervals.values()][0](); }, ...['AUTH_CANCEL', 'WINDOW_CLOSE', 'AUTH_ERROR'].map(type => f => f.message({ type, payload: { error: 'synthetic-secret' } }))];
  for (const stop of stops) { const f = fixture(); stop(f); const statuses = [...f.statuses]; f.message(); f.attempt.cancel(); assert.deepEqual(f.statuses, statuses); assert.deepEqual(f.credentials, []); f.clean(); }
});
test('expired deadline rejects a message even when timeout callback was delayed', t => {
  const f = fixture(); t.mock.method(Date, 'now', () => Number.MAX_SAFE_INTEGER); f.message(); assert.equal(f.statuses.at(-1), 'expired'); assert.deepEqual(f.credentials, []); f.clean();
});
test('old attempt cannot fill new attempt and opening errors stay generic with no logs', t => {
  const logs = []; for (const method of ['log', 'warn', 'error', 'info', 'debug']) t.mock.method(console, method, (...args) => logs.push(args));
  const old = fixture(); old.attempt.cancel(); const next = fixture(); next.message(success, { source: old.popup }); assert.equal(next.credentials.length, 0); next.message(); next.clean();
  for (const mode of ['blocked', 'throw']) { const f = fixture(mode); assert.deepEqual(f.statuses, ['waiting', mode === 'blocked' ? 'blocked' : 'failed']); assert.deepEqual(f.credentials, []); f.clean(); }
  assert.deepEqual(logs, []);
});
