import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiRuntimeAdapter } from '../dist/adapter.js';
import { createServer } from '../dist/server.js';

async function fixture(t, { withRecord = false, link = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-monitor-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtime = { runtimeId: 'local-pi', workspaceId: 'w', entityId: 'e' };
  const session = { runtime, sessionId: 's', opaqueHandle: 'host-session' };
  const state = { prepared: [], sessions: [{ handle: session, closed: false, owner: 'private-owner', bootstrap: { private: 'PRIVATE_CONTEXT' } }], executions: [{
    status: 'succeeded', events: [], request: { authorizationContext: { private: 'PRIVATE_AUTHORIZATION' }, payload: { session, execution: { runtime, executionId: 'run', sessionId: 's' }, private: 'PRIVATE_INPUT' } }, result: { private: 'PRIVATE_OUTPUT' },
  }] };
  await writeFile(join(directory, 'journal.json'), JSON.stringify(state));
  if (withRecord) {
    const folder = join(directory, 'sessions', 'host-session'); await mkdir(folder, { recursive: true });
    const path = join(folder, 'native.jsonl');
    if (link) { const outside = join(directory, 'unrelated.jsonl'); await writeFile(outside, 'PRIVATE_RECORD'); await symlink(outside, path); }
    else await writeFile(path, 'PRIVATE_RECORD_NOT_PARSED_AS_JSON\n');
    await writeFile(join(folder, 'session-pointer.json'), JSON.stringify(path));
  }
  let driverCalls = 0, resolverCalls = 0;
  const adapter = new PiRuntimeAdapter(directory, { verify: async () => { resolverCalls++; return false; } }, { start() { driverCalls++; throw Error('Must not run'); } });
  const server = createServer({ token: 'execution-test-token', monitorToken: 'monitor-test-token', adapter });
  t.after(() => server.close());
  return { directory, adapter, server, noBusinessCalls: () => { assert.equal(driverCalls, 0); assert.equal(resolverCalls, 0); } };
}
const headers = { authorization: 'Bearer monitor-test-token' };
test('monitor credentials are separate from execution credentials and fail closed', async t => {
  const { server, noBusinessCalls } = await fixture(t);
  for (const url of ['/internal/monitor/status', '/internal/monitor/executions/run']) {
    for (const authorization of [undefined, 'Bearer wrong', 'Bearer execution-test-token']) {
      assert.equal((await server.inject({ url, headers: authorization ? { authorization } : {} })).statusCode, 401);
    }
    assert.equal((await server.inject({ url, headers })).statusCode, 200);
  }
  assert.equal((await server.inject({ method: 'POST', url: '/v1/capabilities', headers, payload: {} })).statusCode, 401);
  const disabled = createServer(); t.after(() => disabled.close());
  assert.equal((await disabled.inject({ url: '/internal/monitor/status', headers })).statusCode, 503);
  const missing = createServer({ monitorToken: 'monitor-test-token' }); t.after(() => missing.close());
  assert.equal((await missing.inject({ url: '/internal/monitor/status', headers })).statusCode, 503);
  noBusinessCalls();
});
test('monitor returns only safe status and host-owned record locator, never contents or absolute paths', async t => {
  const f = await fixture(t, { withRecord: true });
  const before = await readFile(join(f.directory, 'journal.json'), 'utf8');
  const status = await f.server.inject({ url: '/internal/monitor/status', headers });
  assert.deepEqual(status.json().counts, { sessions: 1, activeSessions: 1, executions: 1, activeExecutions: 0, unknownExecutions: 0 });
  const metadata = await f.server.inject({ url: '/internal/monitor/executions/run', headers });
  assert.equal(metadata.statusCode, 200);
  assert.deepEqual(metadata.json().records, { ownerService: 'runtime-host-pi', storageId: 'pi-session-records', format: 'pi-session-jsonl', availability: 'available', relativePath: 'sessions/host-session/native.jsonl', byteLength: Buffer.byteLength('PRIVATE_RECORD_NOT_PARSED_AS_JSON\n') });
  for (const body of [status.body, metadata.body]) {
    assert.equal(body.includes('PRIVATE_'), false); assert.equal(body.includes(f.directory), false);
    assert.equal(body.includes('execution-test-token'), false); assert.equal(body.includes('monitor-test-token'), false);
  }
  assert.equal((await f.server.inject({ url: '/internal/monitor/executions/run?path=/etc/passwd', headers })).statusCode, 400);
  assert.equal((await f.server.inject({ url: '/internal/monitor/executions/missing', headers })).statusCode, 404);
  assert.equal((await f.server.inject({ url: '/internal/monitor/executions/%2E%2E%2Fetc%2Fpasswd', headers })).statusCode, 404);
  assert.equal(await readFile(join(f.directory, 'journal.json'), 'utf8'), before);
  f.noBusinessCalls();
});
test('missing and unsafe native records are unavailable metadata, without leaking file errors', async t => {
  for (const options of [{}, { withRecord: true, link: true }]) {
    const { server, noBusinessCalls } = await fixture(t, options);
    const response = await server.inject({ url: '/internal/monitor/executions/run', headers });
    assert.equal(response.statusCode, 200); assert.equal(response.json().records.availability, 'unavailable');
    assert.equal('relativePath' in response.json().records, false); noBusinessCalls();
  }
});
