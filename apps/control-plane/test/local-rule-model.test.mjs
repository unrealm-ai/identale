import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer as createPlatform } from '../dist/server.js';
import { createServer as createModel, closeServer, DEFAULT_TOKEN } from '../../mock-model/dist/server.js';

const origin = 'http://127.0.0.1:15173';
async function eventually(work) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await work()) return; await new Promise(resolve => setTimeout(resolve, 15)); }
  assert.fail('Local rule model integration did not settle');
}
async function setup(t, maintenancePolicy = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dentity-rule-model-integration-'));
  const seen = [], model = createModel({ observe: (request, ruleId) => seen.push({ request, ruleId }) });
  let app, db;
  t.after(async () => { await app?.close(); db?.close(); await closeServer(model); await rm(dir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => { model.once('error', reject); model.listen(0, '127.0.0.1', resolve); });
  const modelOrigin = `http://127.0.0.1:${model.address().port}`;
  let maintenance;
  const config = { databasePath: join(dir, 'isolated.sqlite'), origin, pollIntervalMs: 0,
    modelProfiles: { masterKey: Buffer.alloc(32, 61), allowLoopbackHttp: true },
    maintenance: { policy: { contextTokenThreshold: 1, retainMessages: 2, ...maintenancePolicy } },
    onMaintenanceService: value => { maintenance = value; } };
  app = createPlatform(config); await app.ready(); db = new DatabaseSync(config.databasePath);
  const call = (method, url, payload, cookie) => app.inject({ method, url, ...(payload === undefined ? {} : { payload }), headers: { origin, ...(cookie ? { cookie } : {}) } });
  const registration = await call('POST', '/api/auth/register', { username: 'rule-model-user', password: 'Isolated synthetic model test password 2026!' });
  assert.equal(registration.statusCode, 201, registration.body);
  const account = registration.json(), cookie = registration.headers['set-cookie'].split(';')[0], workspace = `/api/workspaces/${account.workspace.id}`;
  const employee = await call('POST', `${workspace}/entities`, { name: 'Rule model employee', ownWebUse: true }, cookie);
  assert.equal(employee.statusCode, 200, employee.body);
  const base = `${workspace}/entities/${employee.json().entity.id}`;
  const input = { name: 'Isolated local rules', provider: 'openai-compatible', endpoint: `${modelOrigin}/v1`, modelId: 'mock', apiKey: DEFAULT_TOKEN, bindEntityId: employee.json().entity.id };
  async function configure() {
    const probe = await call('POST', `${workspace}/model-profiles/test-connection`, input, cookie);
    assert.equal(probe.statusCode, 200, probe.body);
    const saved = await call('POST', `${workspace}/model-profiles`, { ...input, connectionTestReceipt: probe.json().connectionTestReceipt }, cookie);
    assert.equal(saved.statusCode, 200, saved.body); return saved.json();
  }
  async function conversation(operationId = 'conversation') {
    const response = await call('POST', `${base}/conversations`, { operationId }, cookie);
    assert.ok([200,201].includes(response.statusCode), response.body); return response.json().conversation;
  }
  async function turn(c, text, operationId, expectedStatus = 'succeeded') {
    const response = await call('POST', `${base}/conversations/${c.id}/turns`, { text, operationId }, cookie);
    assert.equal(response.statusCode, 202, response.body); let result;
    await eventually(async () => { const state = await call('GET', `${base}/conversations/${c.id}/turns/${response.json().turn.id}`, undefined, cookie); assert.equal(state.statusCode, 200, state.body); result = state.json().turn; return ['succeeded', 'failed', 'unknown', 'canceled'].includes(result.status); });
    assert.equal(result.status, expectedStatus, JSON.stringify(result)); return result;
  }
  return { dir, db, seen, config, base, workspace, cookie, call, configure, conversation, turn,
    get maintenance() { return maintenance; },
    async restart() { await app.close(); app = createPlatform(config); await app.ready(); } };
}

test('manual model connection/save uses real rule HTTP; greeting and restart preserve real history; revocation never falls back', async t => {
  const s = await setup(t);
  const missing = await s.call('POST', `${s.base}/conversations`, {}, s.cookie);
  assert.equal(missing.statusCode, 409); assert.equal(missing.json().error, 'model_not_configured');
  assert.equal(s.seen.length, 0); assert.equal(s.db.prepare('SELECT count(*) AS n FROM model_catalog').get().n, 0);
  const profile = await s.configure(); assert.equal(s.seen.length, 1);assert.equal(s.seen[0].request.reasoningEffort,'none');assert.equal(s.seen[0].request.enableThinking,false);
  const c = await s.conversation(); assert.equal(c.mode, 'real'); assert.equal(c.simulated, false);
  assert.equal((await s.turn(c, '你好', 'greeting-1')).text, '你好。我可以帮你做什么');
  await s.restart(); assert.equal((await s.turn(c, '你好', 'greeting-2')).text, '你好。我可以帮你做什么');
  const messages = await s.call('GET', `${s.base}/conversations/${c.id}/messages`, undefined, s.cookie);
  assert.equal(messages.json().messages.length, 4); assert.ok(messages.json().messages.every(m => !m.simulated));
  const credentialRows=s.db.prepare('SELECT ciphertext,nonce,tag FROM model_catalog').all();assert.equal(credentialRows.length,1);for(const row of credentialRows){assert.ok(row.ciphertext&&row.nonce&&row.tag);assert.notEqual(row.ciphertext,DEFAULT_TOKEN);}
  const revoked = await s.call('POST', `${s.workspace}/model-profiles/${profile.id}/revoke`, {}, s.cookie); assert.equal(revoked.statusCode, 200, revoked.body);
  const calls = s.seen.length;
  assert.equal((await s.call('GET', `${s.base}/conversations/${c.id}/messages`, undefined, s.cookie)).json().messages.length, 4);
  const reopened=await s.call('POST', `${s.base}/conversations`, {}, s.cookie);assert.equal(reopened.statusCode,200,reopened.body);assert.equal(reopened.json().conversation.id,c.id);
  assert.equal((await s.call('POST', `${s.base}/conversations/${c.id}/turns`, { operationId: 'after-revoke', text: '你好' }, s.cookie)).statusCode, 409);
  assert.equal((await s.call('POST', `${s.base}/conversations/${c.id}/tasks`, { operationId: 'after-revoke-task', input: 'Do not execute' }, s.cookie)).statusCode, 409);
  assert.equal(s.seen.length, calls); assert.equal(s.db.prepare('SELECT count(*) AS n FROM tasks').get().n, 0);
});

test('actual maintenance calls rule HTTP and keeps original messages, tool exchange boundaries and archives across restart', async t => {
  const s = await setup(t); await s.configure(); const c = await s.conversation();
  for (let n = 0; n < 5; n++) await s.turn(c, '你好', `greeting-${n}`);
  // Baseline task creation no longer needs a business package. This isolated platform
  // intentionally has no execution Runtime: the real task_create exchange must fail closed.
  const noTools = await s.turn(c, '帮我写一个md文章', 'no-execution-runtime', 'failed'); assert.match(noTools.error, /Builtin runtime operation failed/);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM tasks').get().n, 0);
  for (let n = 5; n < 8; n++) await s.turn(c, '你好', `greeting-${n}`);
  const read = () => s.call('GET', `${s.base}/conversations/${c.id}/messages`, undefined, s.cookie);
  const before = (await read()).json().messages;
  await s.maintenance.tick();
  const jobs = s.db.prepare('SELECT status,error FROM scheduled_jobs').all(); assert.ok(jobs.some(job => job.status === 'succeeded'), JSON.stringify(jobs));
  assert.ok(s.seen.some(x => !x.request.tools?.length && x.request.messages.some(m => typeof m.content === 'string' && m.content.includes('factual memory summary'))));
  const files = await readdir(join(s.dir, 'builtin-records'), { recursive: true });
  assert.ok(files.some(f => f.endsWith('current.jsonl'))); assert.ok(files.some(f => f.endsWith('summary.jsonl')));
  assert.ok(files.some(f => f.endsWith('.jsonl') && !f.endsWith('current.jsonl') && !f.endsWith('summary.jsonl')));
  const summary = await Promise.all(files.filter(f => f.endsWith('summary.jsonl')).map(f => readFile(join(s.dir, 'builtin-records', f), 'utf8')));
  assert.ok(summary.every(text => text.trim().length));
  assert.deepEqual((await read()).json().messages, before);
  await s.restart(); assert.deepEqual((await read()).json().messages, before);
  await s.turn(c, '你好', 'after-maintenance');
  assert.equal((await read()).json().messages.length, before.length + 2);
  const metadata = JSON.stringify(s.db.prepare('SELECT json FROM builtin_records').all());
  assert.equal(metadata.includes('你好。我可以帮你做什么'), false);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM tasks').get().n, 0);
});
