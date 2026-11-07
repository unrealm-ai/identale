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
  const counts = () => Object.fromEntries(['entities', 'model_catalog', 'entity_model_bindings', 'employee_channel_connections', 'employee_channel_directory_credentials', 'capability_packages', 'employee_creation_operations'].map(table => [table, db.prepare(`SELECT count(*) n FROM ${table}`).get().n]));
  t.after(async () => { await app.close(); db.close(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  return { app, db, owner, base, call, body, config, receipt, draft, state, counts, register, channels, supervisor, advance: ms => { now += ms; } };
}
const expect = (response, status, code) => { assert.equal(response.statusCode, status, response.body); if (code) assert.equal(response.json().error, code); return response.json(); };
const packageDraft = extra => ({ name: '合成能力包', enabled: true, mode: 'restrict', allowMemberIds: [], denyMemberIds: [], resourceIds: ['fixture-skill'], ...extra });

test('employee creation persists group switch atomically and same operation replays',async t=>{
 const f=await setup(t),request=f.body({directoryAccess:{allow:[],deny:[],allowGroupMembers:true}});
 const result=expect(await f.call('POST',`${f.base}/employee-creations`,request,f.owner.cookie),200),id=result.entity.id;
 const policy=expect(await f.call('GET',`${f.base}/entities/${id}/directory-access`,undefined,f.owner.cookie),200);assert.equal(policy.allowGroupMembers,true);
 assert.equal(expect(await f.call('POST',`${f.base}/employee-creations`,request,f.owner.cookie),200).entity.id,id);
 expect(await f.call('POST',`${f.base}/employee-creations`,{...request,directoryAccess:{...request.directoryAccess,allowGroupMembers:false}},f.owner.cookie),409,'idempotency_conflict');
});
test('failed creation rolls group policy back; default creation remains closed',async t=>{
 const f=await setup(t);f.db.exec("CREATE TRIGGER reject_group_creation BEFORE INSERT ON capability_packages BEGIN SELECT RAISE(ABORT,'synthetic late failure'); END;");
 const request=f.body({directoryAccess:{allow:[],deny:[],allowGroupMembers:true},packages:[packageDraft()]});
 expect(await f.call('POST',`${f.base}/employee-creations`,request,f.owner.cookie),500);assert.equal(f.db.prepare('SELECT count(*) n FROM entity_directory_policies').get().n,0);assert.equal(f.counts().entities,0);
 f.db.exec('DROP TRIGGER reject_group_creation');
 const result=expect(await f.call('POST',`${f.base}/employee-creations`,f.body(),f.owner.cookie),200);
 assert.equal(expect(await f.call('GET',`${f.base}/entities/${result.entity.id}/directory-access`,undefined,f.owner.cookie),200).allowGroupMembers,false);
});
