import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createServer } from '../dist/server.js';

// Approved local vendor HTTP fixtures exercise the real adapters. No enterprise or paid API egress.
const origin = 'http://127.0.0.1:5173', secret = 'synthetic-wizard-model-token';
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'identity-creation-'));
  let now = Date.now(), db, supervisor, channels;
  const state = { calls: [], users: ['person'], departments: ['1'], failStart: false, started: [], networkLockFailures: 0, beforeResponse: undefined };
  const provider = httpServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://fixture'), chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      // A second real SQLite writer proves no application write transaction spans network I/O.
      if (db) { try { db.exec('BEGIN IMMEDIATE'); db.exec('ROLLBACK'); } catch { state.networkLockFailures++; } }
      state.calls.push({ path: url.pathname, body });
      if (state.beforeResponse) await state.beforeResponse(url);
      let row;
      if (url.pathname === '/v1/chat/completions') {
        if (req.headers.authorization !== `Bearer ${secret}` || body.model === 'missing') { res.writeHead(401); res.end('synthetic provider failure'); return; }
        row = { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }] };
      } else if (url.pathname === '/open-apis/auth/v3/tenant_access_token/internal') row = { code: 0, tenant_access_token: 'fixture-token', expire: 7200 };
      else if (url.pathname === '/open-apis/bot/v3/info') row = { code: 0, bot: { open_id: 'fixture-feishu-bot' } };
      else if (url.pathname === '/open-apis/tenant/v2/tenant/query') row = { code: 0, data: { tenant: { tenant_key: 'fixture-tenant' } } };
      else if (url.pathname === '/open-apis/contact/v3/scopes') row = { code: 0, data: { department_ids: state.departments, user_ids: state.users, has_more: false } };
      else if (url.pathname.startsWith('/open-apis/contact/v3/departments/')) row = { code: 0, data: { department: { open_department_id: url.pathname.split('/').at(-1), name: '研发部', parent_department_id: '0' } } };
      else if (url.pathname.startsWith('/open-apis/contact/v3/users/')) row = { code: 0, data: { user: { open_id: url.pathname.split('/').at(-1), name: '渠道合成人员', department_ids: ['1'], status: { is_activated: true, is_frozen: false, is_resigned: false } } } };
      else if (url.pathname === '/v1.0/oauth2/accessToken') row = { accessToken: 'fixture-token', expireIn: 7200 };
      else if (url.pathname === '/auth/scopes') row = { errcode: 0, auth_org_scopes: { authed_dept: [1], authed_user: ['person'] } };
      else if (url.pathname === '/topapi/v2/user/get') row = { errcode: 0, result: { userid: body.userid, name: '钉钉合成人员', dept_id_list: [1], active: true } };
      else if (url.pathname === '/topapi/v2/department/get') row = { errcode: 0, result: { dept_id: body.dept_id, name: '钉钉部门', parent_id: 0 } };
      else if (url.pathname === '/cgi-bin/gettoken') {
        assert.equal(url.searchParams.get('corpsecret'), 'synthetic-directory-secret', 'Directory auth never uses robot secret');
        row = { errcode: 0, access_token: 'fixture-directory-token', expires_in: 7200 };
      } else if (url.pathname === '/cgi-bin/agent/get') row = { errcode: 0, agentid: Number(url.searchParams.get('agentid')), close: 0, allow_userinfos: { user: [{ userid: 'person' }] }, allow_partys: { partyid: [1] }, allow_tags: { tagid: [] } };
      else if (url.pathname === '/cgi-bin/user/get') row = { errcode: 0, userid: url.searchParams.get('userid'), name: '企业微信合成人员', department: [1], status: 1 };
      else if (url.pathname === '/cgi-bin/department/get') row = { errcode: 0, department: { id: Number(url.searchParams.get('id')), name: '企业微信部门', parentid: 0 } };
      else { res.writeHead(404); res.end('{}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(row));
    } catch { res.writeHead(500); res.end('{}'); }
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const local = `http://127.0.0.1:${provider.address().port}`;
  const vendorFetch = (url, options) => {
    const parsed = new URL(url);
    assert.ok(['https://open.feishu.cn', 'https://api.dingtalk.com', 'https://oapi.dingtalk.com', 'https://qyapi.weixin.qq.com'].includes(parsed.origin));
    return fetch(`${local}${parsed.pathname}${parsed.search}`, options);
  };
  const app = createServer({ databasePath: join(dir, 'test.sqlite'), origin, now: () => now, sessionTtlMs: 3_600_000, pollIntervalMs: 0,
    modelProfiles: { masterKey: Buffer.alloc(32, 29), allowLoopbackHttp: true },
    employeeChannels: { masterKey: Buffer.alloc(32, 29), fetch: vendorFetch, now: () => now },
    approvedResources: [{ id: 'fixture-skill', kind: 'skill', resourceId: 'skill', version: '1', digest: 'a'.repeat(64), shared: true }],
    channelIngressFactory: session => ({ async start(_session, sink) { assert.equal(db.prepare('SELECT count(*) n FROM employee_channel_connections WHERE id=?').get(session.connectionId).n, 1); db.exec('BEGIN IMMEDIATE'); db.exec('ROLLBACK'); state.started.push(session); if (state.failStart) throw new Error('synthetic start failure'); sink.onStatus({ state: 'connected', changedAt: now }); }, async stop() {} }),
    onChannelIngressSupervisor: value => { supervisor = value; }, onEmployeeChannelService: value => { channels = value; },
  });
  await app.ready(); db = new DatabaseSync(join(dir, 'test.sqlite')); db.exec('PRAGMA busy_timeout=0');
  const call = (method, path, body, cookie) => app.inject({ method, url: path, ...(body === undefined ? {} : { payload: body }), headers: { origin, ...(cookie ? { cookie } : {}) } });
  async function register(name, extra = {}) { const r = await call('POST', '/api/auth/register', { username: name, password: 'Synthetic wizard password 2026!', ...extra }); assert.equal(r.statusCode, 201, r.body); return { ...r.json(), cookie: r.headers['set-cookie'].split(';')[0] }; }
  const owner = await register('creation-owner'), base = `/api/workspaces/${owner.workspace.id}`;
  const body = extra => ({ operationId: randomUUID(), name: '合成向导员工', description: '隔离测试', ownWebUse: true, interactionRuntime: 'builtin-interaction', model: null, packages: [], ...extra });
  const config = extra => ({ name: '合成向导模型', provider: 'openai-compatible', endpoint: `${local}/v1`, modelId: 'supported', apiKey: secret, enabled: true, ...extra });
  async function receipt(configuration = config()) { const r = await call('POST', `${base}/model-profiles/test-connection`, configuration, owner.cookie); assert.equal(r.statusCode, 200, r.body); return { ...configuration, connectionTestReceipt: r.json().connectionTestReceipt }; }
  async function draft(provider = 'feishu', extra = {}) { const r = await call('POST', `${base}/employee-channel-drafts`, { provider, appId: `${provider}-fixture-app`, appSecret: 'synthetic-robot-secret', ...extra }, owner.cookie); assert.equal(r.statusCode, 200, r.body); return r.json(); }
  const counts = () => Object.fromEntries(['entities', 'model_catalog', 'entity_model_bindings', 'employee_channel_connections', 'capability_packages', 'employee_creation_operations'].map(table => [table, db.prepare(`SELECT count(*) n FROM ${table}`).get().n]));
  t.after(async () => { await app.close(); db.close(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  return { app, db, owner, base, call, body, config, receipt, draft, state, counts, register, channels, supervisor, advance: ms => { now += ms; } };
}
const expect = (response, status, code) => { assert.equal(response.statusCode, status, response.body); if (code) assert.equal(response.json().error, code); return response.json(); };
const packageDraft = extra => ({ name: '合成能力包', enabled: true, mode: 'restrict', allowMemberIds: [], denyMemberIds: [], resourceIds: ['fixture-skill'], ...extra });

test('wizard probe is nonpersistent; inline creation is rejected and existing model binding replays atomically', async t => {
  const f = await setup(t), input = f.config();
  expect(await f.call('POST', `${f.base}/model-profiles/test-connection`, { ...input, modelId: 'missing' }, f.owner.cookie), 502);
  assert.equal(f.counts().model_catalog, 0);
  const verified = await f.receipt(input); assert.ok(Object.values(f.counts()).every(n => n === 0));
  const inline = f.body({model:{kind:'new',configuration:verified}});expect(await f.call('POST',`${f.base}/employee-creations`,inline,f.owner.cookie),400,'employee_resource_creation_forbidden');
  expect(await f.call('POST',`${f.base}/model-profiles`,{...verified,apiKey:'changed-token'},f.owner.cookie),409,'model_connection_test_required');
  const profile=expect(await f.call('POST',`${f.base}/model-profiles`,verified,f.owner.cookie),200);
  const request = f.body({ model: { kind: 'existing', profileId:profile.id }, packages: [packageDraft({ allowMemberIds: [f.owner.workspace.memberId] })] });
  const created = expect(await f.call('POST', `${f.base}/employee-creations`, request, f.owner.cookie), 200).entity;
  assert.deepEqual(f.counts(), { entities: 1, model_catalog: 1, entity_model_bindings: 1, employee_channel_connections: 0, capability_packages: 1, employee_creation_operations: 1 });
  const raw = JSON.stringify(f.db.prepare('SELECT * FROM model_catalog').get()); assert.equal(raw.includes(secret), false);
  const oldNow = Date.now; Date.now = () => oldNow() + 600_000;
  try { assert.equal(expect(await f.call('POST', `${f.base}/employee-creations`, request, f.owner.cookie), 200).entity.id, created.id); } finally { Date.now = oldNow; }
  expect(await f.call('POST', `${f.base}/employee-creations`, { ...request, description: 'changed' }, f.owner.cookie), 409, 'idempotency_conflict');
  assert.equal(f.state.networkLockFailures, 0);
});

test('wizard existing model only binds, same-workspace existence is checked and duplicate clicks create once', async t => {
  const f = await setup(t), config = await f.receipt();
  const profile = expect(await f.call('POST', `${f.base}/model-profiles`, config, f.owner.cookie), 200);
  const request = f.body({ model: { kind: 'existing', profileId: profile.id } });
  const results = await Promise.all([1, 2, 3].map(() => f.call('POST', `${f.base}/employee-creations`, request, f.owner.cookie)));
  for (const r of results) expect(r, 200); assert.equal(new Set(results.map(r => r.json().entity.id)).size, 1); assert.equal(f.counts().model_catalog, 1);
  const other = expect(await f.call('POST', '/api/workspaces', { name: 'Other isolated workspace' }, f.owner.cookie), 200).workspace;
  expect(await f.call('POST', `/api/workspaces/${other.id}/employee-creations`, request, f.owner.cookie), 404, 'model_profile_not_found');
  expect(await f.call('POST', `${f.base}/employee-creations`, f.body({ model: { kind: 'existing', profileId: 'deleted-profile' } }), f.owner.cookie), 404);
  const options = expect(await f.call('GET', `${f.base}/employee-creation-options`, undefined, f.owner.cookie), 200);
  assert.ok(options.members.every(m => m.id === f.owner.workspace.memberId));
  assert.equal(f.counts().entities, 1);
});

test('wizard channel/model/package late SQL failure rolls back every formal row and preserves receipts for retry', async t => {
  const f = await setup(t), channel = await f.draft(), config = await f.receipt();
  const profile=expect(await f.call('POST',`${f.base}/model-profiles`,config,f.owner.cookie),200);
  const page = expect(await f.call('GET', `${f.base}/employee-channel-drafts/${channel.draftId}/directory?kind=departments`, undefined, f.owner.cookie), 200);
  assert.ok(Object.entries(f.counts()).every(([key,n])=>n===(key==='model_catalog'?1:0)));
  const rule = { sourceId: page.sourceId, kind: 'department', subjectId: page.items[0].subjectId, includeDescendants: false, conversationKinds: ['private'] };
  const request = f.body({ channelDraftId: channel.draftId, model: { kind: 'existing', profileId:profile.id }, directoryAccess: { allow: [rule], deny: [] }, packages: [packageDraft({ directoryAccess: { allow: [rule], deny: [] } })] });
  f.db.exec("CREATE TRIGGER reject_wizard_package BEFORE INSERT ON capability_packages BEGIN SELECT RAISE(ABORT,'synthetic late failure'); END;");
  expect(await f.call('POST', `${f.base}/employee-creations`, request, f.owner.cookie), 500);
  assert.ok(Object.entries(f.counts()).every(([key,n])=>n===(key==='model_catalog'?1:0))); assert.equal(f.db.prepare("SELECT count(*) n FROM audit WHERE action='entity.created'").get().n, 0); assert.equal(f.state.started.length, 0);
  f.db.exec('DROP TRIGGER reject_wizard_package');
  const created = expect(await f.call('POST', `${f.base}/employee-creations`, request, f.owner.cookie), 200).entity;
  assert.equal(JSON.parse(f.db.prepare('SELECT channel_policies_json FROM entity_directory_policies WHERE entity_id=?').get(created.id).channel_policies_json)[0].mode, 'allowlist');
  await f.supervisor.tick(); assert.equal(f.state.started.length, 1); assert.equal(f.counts().entities, 1); assert.equal(f.counts().model_catalog, 1); assert.equal(f.counts().capability_packages, 1);
  assert.equal(expect(await f.call('POST', `${f.base}/employee-creations`, request, f.owner.cookie), 200).entity.id, created.id);
  assert.equal(f.state.networkLockFailures, 0);
});

test('wizard directory pagination is bounded and cursor/source/authorization changes cannot carry across drafts', async t => {
  const f = await setup(t); f.state.users = Array.from({ length: 51 }, (_, i) => `person-${i}`);
  const channel = await f.draft();
  const page = expect(await f.call('GET', `${f.base}/employee-channel-drafts/${channel.draftId}/directory?kind=users`, undefined, f.owner.cookie), 200);
  assert.equal(page.items.length, 50); assert.equal(page.exhausted, false);
  const second = expect(await f.call('GET', `${f.base}/employee-channel-drafts/${channel.draftId}/directory?kind=users&cursor=${encodeURIComponent(page.nextCursor)}`, undefined, f.owner.cookie), 200); assert.equal(second.items.length, 1); assert.equal(second.exhausted, true);
  const switched = await f.draft('dingtalk');
  expect(await f.call('GET', `${f.base}/employee-channel-drafts/${switched.draftId}/directory?kind=users&cursor=${encodeURIComponent(page.nextCursor)}`, undefined, f.owner.cookie), 502);
  const rule = { sourceId: page.sourceId, kind: 'channel_user', subjectId: page.items[0].subjectId, conversationKinds: ['private'] };
  expect(await f.call('POST', `${f.base}/employee-creations`, f.body({ channelDraftId: switched.draftId, packages: [packageDraft({ directoryAccess: { allow: [rule], deny: [] } })] }), f.owner.cookie), 400, 'directory_source_not_found');
  assert.ok(Object.values(f.counts()).every(n => n === 0));
  f.state.users = ['changed-scope'];
  expect(await f.call('GET', `${f.base}/employee-channel-drafts/${channel.draftId}/directory?kind=users`, undefined, f.owner.cookie), 409, 'directory_scope_changed');
  expect(await f.call('POST', `${f.base}/employee-creations`, f.body({ channelDraftId: channel.draftId }), f.owner.cookie), 409, 'channel_creation_draft_required');
});

test('wizard channel drafts reject cross workspace/actor, expired/revoked/cancelled context and multi-channel input', async t => {
  const f = await setup(t), channel = await f.draft(), other = await f.register('other-manager');
  expect(await f.call('POST', `/api/workspaces/${other.workspace.id}/employee-creations`, f.body({ channelDraftId: channel.draftId }), other.cookie), 409, 'channel_creation_draft_required');
  f.db.prepare("INSERT INTO members(id,workspace_id,user_id,role) VALUES(?,?,?,'admin')").run(randomUUID(), f.owner.workspace.id, other.user.id);
  expect(await f.call('GET', `${f.base}/employee-channel-drafts/${channel.draftId}/directory?kind=users`, undefined, other.cookie), 409);
  expect(await f.call('POST', `${f.base}/employee-creations`, f.body({ channelDraftId: [channel.draftId] }), f.owner.cookie), 400);
  expect(await f.call('DELETE', `${f.base}/employee-channel-drafts/${channel.draftId}`, undefined, f.owner.cookie), 200);
  expect(await f.call('POST', `${f.base}/employee-creations`, f.body({ channelDraftId: channel.draftId }), f.owner.cookie), 409);
  const expired = await f.draft(); f.advance(600_001);
  expect(await f.call('POST', `${f.base}/employee-creations`, f.body({ channelDraftId: expired.draftId }), f.owner.cookie), 409);
  f.db.prepare("UPDATE members SET status='disabled' WHERE id=?").run(f.owner.workspace.memberId);
  expect(await f.call('POST', `${f.base}/employee-channel-drafts`, { provider: 'feishu', appId: 'x', appSecret: 'fixture' }, f.owner.cookie), 403);
  expect(await f.call('POST', `${f.base}/employee-creations`, f.body(), f.owner.cookie), 403);
  assert.ok(Object.values(f.counts()).every(n => n === 0));
});

test('wizard rechecks management authorization after network reads and never publishes revoked directory results', async t => {
  const f = await setup(t);
  f.state.beforeResponse = async () => { f.db.prepare("UPDATE members SET status='disabled' WHERE id=?").run(f.owner.workspace.memberId); };
  expect(await f.call('POST', `${f.base}/employee-channel-drafts`, { provider: 'feishu', appId: 'fixture-app', appSecret: 'synthetic-secret' }, f.owner.cookie), 403);
  assert.ok(Object.values(f.counts()).every(n => n === 0));
});

test('wizard WeCom uses only bot credentials and persists one connection at atomic employee commit', async t => {
  const f=await setup(t);
  const old=await f.call('POST',`${f.base}/employee-channel-drafts`,{provider:'wecom',appId:'bot-a',appSecret:'synthetic-robot-secret',directory:{corpId:'corp',agentId:'7'}},f.owner.cookie);
  assert.equal(old.statusCode,400);
  const channel=await f.draft('wecom',{appId:'bot-a'});
  assert.equal(channel.source.status,'pending_verification');assert.equal(channel.source.validation.canContinue,true);
  assert.equal(channel.source.validation.checks.find(c=>c.id==='credentials').status,'unverified');
  assert.ok(Object.values(f.counts()).every(n=>n===0));
  expect(await f.call('POST',`${f.base}/employee-creations`,f.body({channelDraftId:channel.draftId,directoryAccess:{channelPolicies:[{sourceId:channel.source.sourceId,mode:'all',allow:[],deny:[]}]}}),f.owner.cookie),200);
  assert.equal(f.counts().employee_channel_connections,1);
  const record=f.channels.repository.all()[0];assert.equal(record.identity.tenantIdNamespace,'app_id');assert.equal(record.directoryBinding,undefined);
  assert.equal(JSON.stringify(record).includes('synthetic-robot-secret'),false);
  assert.equal(f.channels.ingressConfiguration(record.id).credentials.botSecret,'synthetic-robot-secret');
});

test('wizard bot connection and policy roll back with employee on final configuration failure',async t=>{
  const f=await setup(t),channel=await f.draft('wecom');
  const request=f.body({channelDraftId:channel.draftId,packages:[packageDraft({resourceIds:['not-approved']})]});
  expect(await f.call('POST',`${f.base}/employee-creations`,request,f.owner.cookie),400,'unknown_approved_resource');
  assert.ok(Object.values(f.counts()).every(n=>n===0));
  expect(await f.call('POST',`${f.base}/employee-creations`,{...request,packages:[]},f.owner.cookie),200);
  assert.equal(f.counts().employee_channel_connections,1);
});

test('wizard postcommit transport failure remains visible without repeating employee or rolling back committed data', async t => {
  const f = await setup(t); f.state.failStart = true;
  const channel = await f.draft(), request = f.body({ channelDraftId: channel.draftId });
  const created = expect(await f.call('POST', `${f.base}/employee-creations`, request, f.owner.cookie), 200).entity;
  await f.supervisor.tick();
  const current = expect(await f.call('GET', `${f.base}/entities/${created.id}/channels`, undefined, f.owner.cookie), 200)[0];
  assert.equal(current.transport.state, 'failed'); assert.match(current.transport.error, /start_failed|unavailable/);
  expect(await f.call('POST', `${f.base}/employee-creations`, request, f.owner.cookie), 200);
  assert.equal(f.counts().entities, 1); assert.equal(f.counts().employee_channel_connections, 1); assert.equal(f.state.started.length, 1);
});

test('global robot identity is shared by editor/wizard, disabled retains claim and explicit CAS unbind releases cross workspace', async t => {
  const f = await setup(t), channel = await f.draft();
  const first = expect(await f.call('POST', `${f.base}/employee-creations`, f.body({ channelDraftId: channel.draftId }), f.owner.cookie), 200).entity;
  const other = await f.register('global-binding-owner'), otherBase = `/api/workspaces/${other.workspace.id}`;
  const second = expect(await f.call('POST', `${otherBase}/entities`, { name: 'Other employee', ownWebUse: true }, other.cookie), 200).entity;
  const request = { appId: 'feishu-fixture-app', appSecret: 'synthetic-robot-secret', expectedRevision: 0 };
  const editConflict = await f.call('PUT', `${otherBase}/entities/${second.id}/channels/feishu`, request, other.cookie);
  expect(editConflict, 409, 'channel_connection_conflict'); assert.equal(editConflict.body.includes(f.owner.workspace.id), false); assert.equal(editConflict.body.includes(first.id), false);
  const draft = expect(await f.call('POST', `${otherBase}/employee-channel-drafts`, { provider: 'feishu', appId: request.appId, appSecret: request.appSecret }, other.cookie), 200);
  const final = { ...f.body(), channelDraftId: draft.draftId };
  expect(await f.call('POST', `${otherBase}/employee-creations`, final, other.cookie), 409, 'channel_connection_conflict');
  const current = f.channels.list(f.owner.workspace.id, first.id)[0];
  expect(await f.call('PUT', `${f.base}/entities/${first.id}/channels/feishu/settings`, { expectedRevision: current.revision, enabled: false }, f.owner.cookie), 200);
  expect(await f.call('POST', `${otherBase}/employee-creations`, final, other.cookie), 409);
  expect(await f.call('DELETE', `${f.base}/entities/${first.id}/channels/feishu`, { expectedRevision: current.revision }, f.owner.cookie), 409, 'channel_configuration_changed');
  expect(await f.call('DELETE', `${f.base}/entities/${first.id}/channels/feishu`, { expectedRevision: current.revision + 1 }, f.owner.cookie), 200);
  expect(await f.call('POST', `${otherBase}/employee-creations`, final, other.cookie), 200);
  assert.equal(f.counts().employee_channel_connections, 1); assert.equal(f.channels.list(f.owner.workspace.id, first.id).length, 0);
  assert.equal(f.db.prepare("SELECT count(*) n FROM employee_channel_audit WHERE action='connection_unbound'").get().n, 1);
});


test('new employee Feishu draft commits listening on without claiming ordinary-message permission',async t=>{
 const f=await setup(t),draft=await f.draft(),created=expect(await f.call('POST',`${f.base}/employee-creations`,f.body({channelDraftId:draft.draftId}),f.owner.cookie),200).entity;
 const connections=expect(await f.call('GET',`${f.base}/entities/${created.id}/channels`,undefined,f.owner.cookie),200);
 assert.equal(connections.length,1);assert.equal(connections[0].context.groupListenEnabled,true);assert.notEqual(connections[0].groupListeningStatus.permission,'granted');
});

test('wizard first channel is all users and consumes only its provider default',async t=>{
 const f=await setup(t),draft=await f.draft(),created=expect(await f.call('POST',`${f.base}/employee-creations`,f.body({channelDraftId:draft.draftId,directoryAccess:{allow:[],deny:[],allowGroupMembers:true}}),f.owner.cookie),200).entity;
 const row=f.db.prepare('SELECT channel_policies_json FROM entity_directory_policies WHERE entity_id=?').get(created.id);
 const [policy]=JSON.parse(row.channel_policies_json);
 assert.equal(policy.mode,'denylist');assert.deepEqual(policy.deny,[]);assert.equal(policy.allowGroupMembers,true);
 const defaults=JSON.parse(f.db.prepare('SELECT initial_channel_defaults_json FROM entities WHERE id=?').get(created.id).initial_channel_defaults_json);
 assert.equal(defaults.feishu,undefined);assert.equal(defaults.dingtalk,'denylist');assert.equal(defaults.wecom,'denylist');
});
