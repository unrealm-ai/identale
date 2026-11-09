import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {DirectoryError} from '@dentity/application';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from '../dist/server.js';
import {CONFIGURATION_MODULES, configurationSnapshot} from '../dist/split/config-sync.js';
import {Store} from '../dist/store.js';
import {EmployeeChannelRepository} from '../dist/employee-channels/repository.js';
import {EmployeeChannelService, EmployeeChannelError} from '../dist/employee-channels/service.js';
import {DirectoryCredentialVault} from '../dist/directory/secrets.js';
import {
  FeishuAppRegistration,
  FEISHU_REGISTRATION_PERMISSIONS,
  registerFeishuAppRegistrationRoutes,
} from '../dist/employee-channels/feishu-registration.js';
import {PLATFORM_TABLES, RUNTIME_TABLES} from '../dist/split/table-ownership.js';

// Synthetic SDK and verification fixtures only. No real provider, app, tenant or credentials.
const secret = 'synthetic-registration-secret-never-returned';
const verificationUrl = 'https://accounts.feishu.cn/synthetic/confirm?token=synthetic-ephemeral-token';
const credentials = {client_id: 'cli_synthetic', client_secret: secret};
const base = '/api/workspaces/w/entities/e/channels/feishu/registration';
const requiredScopes = [
  'tenant:tenant:readonly', 'contact:contact.base:readonly', 'contact:user.base:readonly',
  'contact:user.employee:readonly', 'contact:user.department:readonly',
  'contact:department.base:readonly', 'contact:department.organize:readonly',
  'contact:user.employee_id:readonly', 'im:message.p2p_msg:readonly',
  'im:message.group_at_msg:readonly', 'im:message:send_as_bot',
  'im:message:readonly', 'im:message.group_msg', 'im:chat:readonly',
];
const requiredEvents = [
  'im.message.receive_v1', 'im.chat.member.bot.added_v1',
  'im.chat.member.bot.deleted_v1', 'im.chat.disbanded_v1',
];
const legacyProfile = {
  version: 'conversation-directory-v1', scopes: requiredScopes, userScopes: [], events: requiredEvents,
  groups: [{id: 'legacy-basic', label: 'Legacy baseline', required: true, identity: 'tenant', scopes: requiredScopes}],
};
const code = expected => error => error.code === expected;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
};
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(read, expected, label = 'registration state') {
  for (let attempt = 0; attempt < 200; attempt++) {
    const actual = read();
    if (actual === expected) return;
    await tick();
  }
  assert.equal(read(), expected, label);
}
function verified(appId, clock, changes = {}) {
  return {
    identity: {appId, tenantId: 'synthetic-tenant', tenantIdNamespace: 'tenant_key'},
    botId: 'synthetic-bot-' + appId, eventTenantId: 'synthetic-tenant', directoryStatus: 'available',
    validation: {
      version: 1, provider: 'feishu', checkedAt: clock, canContinue: true,
      checks: [{id: 'scope_inventory', required: false, supported: true, status: 'pass',
        scopeInventory: requiredScopes.map(scope => ({scope, identity: 'tenant', status: 'granted'}))}],
    },
    ...changes,
  };
}
function fixture(t, {role, masterKey = new Uint8Array(32).fill(7), register, profile = legacyProfile} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'identale-feishu-registration-'));
  const path = join(dir, 'test.sqlite');
  const state = {clock: 1800000000000, sdk: [], verification: [], unexpectedNetwork: [], diagnostics: []};
  const f = {dir, path, state, profile, store: new Store(path, role ? {role} : {})};
  f.store.run("INSERT INTO users(id,username,display_name) VALUES('u','owner','Owner'),('v','second','Second manager'),('guest','guest','Guest')");
  f.store.run("INSERT INTO workspaces(id,name,created_by) VALUES('w','Workspace','u'),('other','Other','u')");
  f.store.run("INSERT INTO members(id,workspace_id,user_id,role) VALUES('m','w','u','owner'),('v','w','v','admin'),('g','w','guest','member'),('om','other','u','owner')");
  f.store.run("INSERT INTO entities(id,workspace_id,name,description,owner_member_id,created_by_member_id,own_web_use,web_use_user_id,interaction_runtime) VALUES('e','w','合成员工','合成员工简介','m','m',1,'u','builtin'),('e2','w','Second','Other employee','m','m',1,'u','builtin'),('oe','other','Other','Other workspace','om','om',1,'u','builtin')");
  f.options = {
    masterKey, now: () => state.clock,
    diagnostics: {event: event => state.diagnostics.push(event)},
    fetch: async () => { state.unexpectedNetwork.push('fetch'); throw new Error('real provider access forbidden in fixture'); },
    registerFeishuApp: input => {
      const completion = deferred();
      const call = {input, ...completion};
      state.sdk.push(call);
      return register ? register(call) : completion.promise;
    },
    verifyApplication: async (provider, appId, value) => {
      assert.equal(provider, 'feishu');
      state.verification.push({appId, appSecret: value.appSecret});
      return state.verify ? state.verify(appId, state.verification.length) : verified(appId, state.clock);
    },
    adapterFactory: provider => ({provider, capabilities: {}}),
  };
  f.authorize = (workspaceId, entityId, actorId) => {
    const entity = f.store.one('SELECT lifecycle_enabled FROM entities WHERE workspace_id=? AND id=?', workspaceId, entityId);
    if (!entity) throw new EmployeeChannelError(404, 'entity_not_found');
    const member = f.store.one('SELECT role,status FROM members WHERE workspace_id=? AND user_id=?', workspaceId, actorId);
    if (!member || member.status !== 'active' || !['owner', 'admin'].includes(member.role)) throw new EmployeeChannelError(403, 'entity_manage_forbidden');
    if (!entity.lifecycle_enabled) throw new EmployeeChannelError(409, 'entity_disabled');
  };
  f.construct = () => {
    f.repository = new EmployeeChannelRepository(f.store);
    f.channels = new EmployeeChannelService(f.repository, f.options);
    f.registration = new FeishuAppRegistration(f.channels, f.options, f.authorize, f.profile);
  };
  f.construct();
  f.status = () => f.registration.status('w', 'e', 'u').registration;
  f.start = (operationId = 'synthetic-operation') => f.registration.start('w', 'e', 'u', operationId).registration;
  f.retry = (automatic = false) => f.registration.retry('w', 'e', 'u', f.status().id, automatic).registration;
  f.cancel = () => f.registration.cancel('w', 'e', 'u', f.status().id).registration;
  f.raw = () => JSON.parse(f.store.one('SELECT record_json FROM feishu_app_registrations WHERE id=?', f.status().id).record_json);
  f.connection = () => f.repository.byProvider('w', 'e', 'feishu');
  f.restart = () => {
    f.registration.close();
    f.store.close();
    f.store = new Store(path, role ? {role} : {});
    f.construct();
  };
  f.app = () => {
    const app = Fastify();
    registerFeishuAppRegistrationRoutes(app, f.registration, (request, w, e) => {
      const actor = request.headers['x-test-user'] ?? 'u';
      f.authorize(w, e, actor);
      return actor;
    });
    t.after(() => app.close());
    return app;
  };
  t.after(async () => {
    f.registration.close();
    await tick();
    f.store.close();
    rmSync(dir, {recursive: true, force: true});
    assert.deepEqual(state.unexpectedNetwork, [], 'fixture must never contact a real provider');
  });
  return f;
}
function assertPrivate(f, {pendingUrl = false} = {}) {
  const exposed = JSON.stringify({status: f.registration.status('w', 'e', 'u'), channels: f.channels.list('w', 'e'), diagnostics: f.state.diagnostics});
  assert.ok(!exposed.includes(secret));
  for (const key of ['client_secret', 'ciphertext', 'nonce', 'tag']) assert.ok(!exposed.includes('"' + key + '"'));
  if (!pendingUrl) assert.ok(!exposed.includes(verificationUrl));
  const stored = JSON.stringify(f.store.all('SELECT record_json FROM feishu_app_registrations'));
  assert.ok(!stored.includes(secret));
  assert.ok(!stored.includes(verificationUrl));
  assert.ok(!stored.includes('synthetic-ephemeral-token'));
  for (const name of readdirSync(f.dir).filter(name => name.startsWith('test.sqlite'))) {
    const bytes = readFileSync(join(f.dir, name));
    assert.equal(bytes.includes(Buffer.from(secret)), false, `plaintext secret in ${name}`);
    assert.equal(bytes.includes(Buffer.from(verificationUrl)), false, `verification URL in ${name}`);
  }
}
async function accept(f) {
  f.state.sdk.at(-1).resolve({...credentials});
  await until(() => f.status().state, 'connected');
}

test('server employee metadata and exact application-only permissions drive SDK registration', async t => {
  const f = fixture(t), status = f.registration.status('w', 'e', 'u');
  assert.deepEqual({...status.preset}, {name: '合成员工', description: '合成员工简介'});
  assert.equal(status.registration, null);
  assert.deepEqual(status.permissions, legacyProfile);
  assert.equal(f.start().state, 'starting');
  const {input} = f.state.sdk[0];
  assert.equal(input.createOnly, true);
  assert.equal(input.source, 'identale');
  assert.deepEqual(input.appPreset, {name: '合成员工', desc: '合成员工简介'});
  assert.deepEqual(input.addons, {preset: false, scopes: {tenant: requiredScopes}, events: {items: {tenant: requiredEvents}}});
  assert.ok(!JSON.stringify(input.addons).match(/document|drive:|meeting:|offline_access|application:|"user"/));
  input.onQRCodeReady({url: verificationUrl, expireIn: 120});
  assert.equal(f.status().state, 'awaiting_confirmation');
  assert.equal(f.status().verificationUrl, verificationUrl);
  assert.equal(f.status().expiresAt, f.state.clock + 120_000);
  assertPrivate(f, {pendingUrl: true});
  await accept(f);
});

test('approved v2 profile preserves all explicitly requested scopes and sends the full grouped manifest', async t => {
  const explicitlyRequested = [
    'contact:contact.base:readonly', 'contact:department.base:readonly', 'im:chat:read', 'im:chat:readonly',
    'im:chat.access_event.bot_p2p_chat:read', 'im:chat.announcement:read', 'im:chat.members:read',
    'im:message.group_at_msg.include_bot:readonly', 'im:message.group_msg.include_bot:read',
    'im:message.pins:read', 'im:message.reactions:read', 'contact:user.basic_profile:readonly',
    'directory:department:search', 'directory:department.base:read', 'directory:department.department_path:read',
    'directory:department.has_child:read', 'directory:department.name:read', 'directory:department.organization:read',
    'directory:department.parent_id:read', 'directory:employee:list', 'directory:employee:read',
    'directory:employee.base.base:read', 'directory:employee.base.department:read',
    'directory:employee.base.department_path:read', 'directory:department:list', 'directory:department:read',
    'directory:employee:search',
  ];
  const profile = FEISHU_REGISTRATION_PERMISSIONS, f = fixture(t, {profile});
  assert.equal(profile.version, 'conversation-business-v2');
  for (const scope of explicitlyRequested) assert.ok(profile.scopes.includes(scope), scope);
  assert.deepEqual(profile.userScopes, []);
  assert.deepEqual(profile.groups.filter(group => group.required).flatMap(group => group.scopes), requiredScopes);
  assert.deepEqual(profile.groups.map(group => group.id), [
    'conversation-directory', 'messages-groups', 'organization', 'documents', 'base', 'calendar', 'tasks', 'meetings-minutes', 'approvals',
  ]);
  assert.deepEqual(new Set(profile.scopes), new Set(profile.groups.flatMap(group => group.scopes)));
  f.start();
  assert.deepEqual(f.state.sdk[0].input.addons, {preset: false, scopes: {tenant: profile.scopes}, events: {items: {tenant: requiredEvents}}});
  await accept(f); await settledCheck(f);
  assert.equal(f.status().state, 'connected', 'unapproved optional groups cannot block verified baseline');
  assert.equal(f.status().permissionGroups[0].status, 'granted');
  assert.ok(f.status().permissionGroups.slice(1).every(group => group.status === 'unknown'));
});

test('first credentials are encrypted before verification and enabled only after both checks', async t => {
  const f = fixture(t), gate = deferred();
  f.state.verify = async appId => { await gate.promise; return verified(appId, f.state.clock); };
  f.start();
  f.state.sdk[0].input.onQRCodeReady({url: verificationUrl, expireIn: 120});
  f.state.sdk[0].resolve({...credentials});
  await until(() => f.status().state, 'checking');
  assert.equal(f.status().credentialSaved, true);
  assert.equal(f.connection(), undefined);
  const raw = f.raw();
  assert.ok(raw.secret.ciphertext && raw.secret.nonce && raw.secret.tag);
  const vault = new DirectoryCredentialVault(f.options.masterKey);
  assert.equal(vault.open(raw.secret, ['feishu-registration', 'w', 'e', 'u', raw.id]), secret);
  assert.throws(() => vault.open(raw.secret, ['feishu-registration', 'w', 'e2', 'u', raw.id]));
  assertPrivate(f);
  gate.resolve();
  await until(() => f.status().state, 'connected');
  assert.equal(f.state.verification.length, 2);
  assert.ok(f.state.verification.every(call => call.appSecret === secret));
  const connection = f.connection();
  assert.equal(connection.enabled, true);
  assert.equal(connection.status, 'verified');
  assert.equal(connection.revision, 1);
  assert.equal(connection.appId, credentials.client_id);
  assert.equal(f.raw().secret, undefined);
  assert.equal(f.status().credentialSaved, true);
  assert.equal(f.store.one('SELECT count(*) AS n FROM employee_channel_audit').n, 1);
  assertPrivate(f);
});

for (const mode of ['missing', 'denied', 'unverified', 'user-only', 'duplicate-denied']) {
  test(`scope ${mode} saves credentials without enabling and retry does not register again`, async t => {
    const f = fixture(t);
    f.state.verify = appId => {
      const result = verified(appId, f.state.clock);
      const inventory = result.validation.checks[0].scopeInventory;
      const scope = inventory[0];
      if (mode === 'missing') inventory.shift();
      else if (mode === 'user-only') scope.identity = 'user';
      else if (mode === 'duplicate-denied') inventory.push({...scope, status: 'denied'});
      else scope.status = mode;
      return result;
    };
    f.start(); f.state.sdk[0].resolve({...credentials});
    await until(() => f.status().state, 'needs_attention');
    assert.equal(f.status().error, 'feishu_registration_permissions_missing');
    assert.deepEqual(f.status().missingScopes, [requiredScopes[0]]);
    assert.equal(f.status().credentialSaved, true);
    assert.equal(f.connection(), undefined);
    assert.throws(() => f.start('second-operation'), code('feishu_registration_in_progress'));
    assertPrivate(f);
    f.state.verify = undefined;
    f.retry();
    await until(() => f.status().state, 'connected');
    assert.equal(f.state.sdk.length, 1);
    assert.equal(f.connection().enabled, true);
  });
}

for (const mode of ['missing-report', 'cannot-continue', 'directory-unavailable', 'missing-bot']) {
  test(`incomplete verification ${mode} never creates a channel`, async t => {
    const f = fixture(t);
    f.state.verify = appId => {
      const result = verified(appId, f.state.clock);
      if (mode === 'missing-report') delete result.validation;
      if (mode === 'cannot-continue') result.validation.canContinue = false;
      if (mode === 'directory-unavailable') result.directoryStatus = 'unavailable';
      if (mode === 'missing-bot') delete result.botId;
      return result;
    };
    f.start(); f.state.sdk[0].resolve({...credentials});
    await until(() => f.status().state, 'needs_attention');
    assert.equal(f.status().credentialSaved, true);
    assert.equal(f.connection(), undefined);
    assertPrivate(f);
  });
}

test('permission removed between initial validation and final channel save fails closed', async t => {
  const f = fixture(t);
  f.state.verify = (appId, call) => {
    const result = verified(appId, f.state.clock);
    if (call === 2) result.validation.checks[0].scopeInventory[0].status = 'denied';
    return result;
  };
  f.start(); f.state.sdk[0].resolve({...credentials});
  await until(() => f.status().state, 'needs_attention');
  assert.equal(f.state.verification.length, 2);
  assert.equal(f.status().error, 'feishu_registration_permissions_missing');
  assert.equal(f.connection(), undefined);
  assert.equal(f.status().credentialSaved, true);
});

test('duplicate starts, checks and terminal retries are idempotent', async t => {
  const f = fixture(t), first = f.start();
  assert.equal(f.start().id, first.id);
  assert.throws(() => f.start('different-operation'), code('feishu_registration_in_progress'));
  assert.equal(f.state.sdk.length, 1);
  const gate = deferred();
  f.state.verify = async appId => { await gate.promise; return verified(appId, f.state.clock); };
  f.state.sdk[0].resolve({...credentials});
  await until(() => f.status().state, 'checking');
  assert.equal(f.retry().id, first.id);
  assert.equal(f.retry().id, first.id);
  assert.equal(f.start().id, first.id);
  assert.equal(f.state.verification.length, 1);
  gate.resolve();
  await until(() => f.status().state, 'connected');
  const connection = f.connection();
  assert.equal(f.retry().state, 'connected');
  await settledCheck(f);
  assert.equal(f.start().id, first.id);
  assert.equal(f.cancel().state, 'connected');
  assert.deepEqual(f.connection(), connection);
  assert.equal(f.state.sdk.length, 1);
  assert.equal(f.state.verification.length, 2, 'completed baseline-only retry remains a no-op');
  assert.equal(f.store.one('SELECT count(*) AS n FROM feishu_app_registrations').n, 1);
});

test('cancel aborts waiting SDK and late URL, status and credentials cannot revive it', async t => {
  const f = fixture(t), first = f.start(), call = f.state.sdk[0];
  call.input.onQRCodeReady({url: verificationUrl, expireIn: 120});
  assert.equal(f.cancel().state, 'cancelled');
  assert.equal(call.input.signal.aborted, true);
  call.input.onQRCodeReady({url: verificationUrl, expireIn: 120});
  call.input.onStatusChange({status: 'domain_switched'});
  call.resolve({...credentials});
  await tick();
  assert.equal(f.status().state, 'cancelled');
  assert.equal(f.status().credentialSaved, false);
  assert.equal(f.connection(), undefined);
  assert.equal(f.cancel().state, 'cancelled');
  assert.equal(f.start().id, first.id);
  assert.equal(f.state.sdk.length, 1);
  assert.throws(() => f.retry(), code('feishu_registration_credentials_required'));
  assertPrivate(f);
  const next = f.start('new-operation');
  assert.notEqual(next.id, first.id);
  assert.equal(f.state.sdk.length, 2);
});

for (const trigger of ['status', 'credentials']) {
  test(`expiry through ${trigger} rejects late credentials and removes the URL`, async t => {
    const f = fixture(t); f.start();
    const call = f.state.sdk[0];
    call.input.onQRCodeReady({url: verificationUrl, expireIn: 1});
    f.state.clock += 1001;
    if (trigger === 'status') assert.equal(f.status().state, 'expired');
    call.resolve({...credentials});
    await until(() => f.status().state, 'expired');
    assert.equal(call.input.signal.aborted, true);
    assert.equal(f.status().credentialSaved, false);
    assert.equal(f.connection(), undefined);
    assertPrivate(f);
  });
}

for (const [providerCode, expected] of [['access_denied', 'denied'], ['expired_token', 'expired'], ['abort', 'cancelled'], ['synthetic_failure', 'failed']]) {
  test(`SDK ${providerCode} yields safe ${expected} without exposing provider error content`, async t => {
    const f = fixture(t); f.start();
    f.state.sdk[0].reject(Object.assign(new Error(secret + ' ' + verificationUrl), {code: providerCode, response: {client_secret: secret}}));
    await until(() => f.status().state, expected);
    assert.equal(f.status().error, 'feishu_registration_' + expected);
    assert.equal(f.status().credentialSaved, false);
    assert.equal(f.connection(), undefined);
    assertPrivate(f);
  });
}

for (const url of ['http://accounts.feishu.cn/confirm', 'https://evil.invalid/confirm', 'https://open.feishu.cn.evil.invalid/confirm', 'https://user:password@open.feishu.cn/confirm', 'https://accounts.feishu.cn:444/confirm', 'https://untrusted.feishu.cn/confirm', 'javascript:alert(1)']) {
  test(`rejects unsafe verification URL ${new URL(url).protocol} ${new URL(url).host}`, async t => {
    const f = fixture(t, {register: async ({input}) => { input.onQRCodeReady({url, expireIn: 60}); return {...credentials}; }});
    f.start();
    await until(() => f.status().state, 'failed');
    assert.equal(f.status().verificationUrl, undefined);
    assert.equal(f.connection(), undefined);
    assertPrivate(f);
  });
}

for (const mode of ['status-switch', 'result-brand']) {
  test(`Lark ${mode} fails closed without enabling a Feishu application`, async t => {
    const f = fixture(t); f.start();
    if (mode === 'status-switch') f.state.sdk[0].input.onStatusChange({status: 'domain_switched'});
    f.state.sdk[0].resolve({...credentials, user_info: {tenant_brand: 'lark'}});
    await until(() => f.status().state, 'failed');
    assert.equal(f.status().error, 'feishu_registration_lark_unsupported');
    assert.equal(f.connection(), undefined);
    assert.equal(f.status().credentialSaved, false);
  });
}

for (const invalid of [{client_id: 'invalid-app-id'}, {client_secret: ''}, {client_secret: 'line\nbreak'}, {client_secret: 'x'.repeat(8193)}]) {
  test(`invalid SDK credential ${Object.keys(invalid)[0]} never persists or enables`, async t => {
    const f = fixture(t); f.start(); f.state.sdk[0].resolve({...credentials, ...invalid});
    await until(() => f.status().state, 'failed');
    assert.equal(f.status().credentialSaved, false);
    assert.equal(f.connection(), undefined);
    assertPrivate(f);
  });
}

test('saved credentials survive actual SQLite close/reopen and recovery reuses the application', async t => {
  const f = fixture(t, {role: 'platform'});
  f.state.verify = appId => { const result = verified(appId, f.state.clock); result.validation.checks[0].scopeInventory.shift(); return result; };
  const first = f.start(); f.state.sdk[0].resolve({...credentials});
  await until(() => f.status().state, 'needs_attention');
  const encrypted = f.raw().secret;
  f.restart();
  assert.equal(f.status().id, first.id);
  assert.equal(f.status().credentialSaved, true);
  assert.deepEqual(f.raw().secret, encrypted);
  assert.equal(f.connection(), undefined);
  f.state.verify = undefined;
  f.retry();
  await until(() => f.status().state, 'connected');
  assert.equal(f.state.sdk.length, 1);
  assert.equal(f.connection().appId, credentials.client_id);
  assertPrivate(f);
});

test('in-progress verification interrupted by restart retains credentials and ignores late completion', async t => {
  const f = fixture(t), gate = deferred();
  f.state.verify = async appId => { await gate.promise; return verified(appId, f.state.clock); };
  f.start(); f.state.sdk[0].resolve({...credentials});
  await until(() => f.status().state, 'checking');
  f.restart();
  assert.equal(f.status().state, 'needs_attention');
  assert.equal(f.status().error, 'feishu_registration_verification_interrupted');
  assert.equal(f.status().credentialSaved, true);
  gate.resolve(); await tick();
  assert.equal(f.connection(), undefined);
  f.state.verify = undefined;
  f.retry();
  await until(() => f.status().state, 'connected');
  assert.equal(f.state.sdk.length, 1);
});

test('waiting registration interrupted by restart never restores the confirmation URL or accepts a late callback', async t => {
  const f = fixture(t); f.start();
  const call = f.state.sdk[0]; call.input.onQRCodeReady({url: verificationUrl, expireIn: 120});
  f.restart();
  assert.equal(f.status().state, 'interrupted');
  assert.equal(f.status().verificationUrl, undefined);
  assert.equal(f.status().credentialSaved, false);
  assert.doesNotThrow(() => call.input.onQRCodeReady({url: verificationUrl, expireIn: 120}));
  assert.doesNotThrow(() => call.input.onStatusChange({status: 'domain_switched'}));
  call.resolve({...credentials}); await tick();
  assert.equal(f.status().state, 'interrupted');
  assert.equal(f.connection(), undefined);
  assertPrivate(f);
});

for (const phase of [1, 2]) {
  for (const change of ['role-revoked', 'employee-disabled', 'manual-binding']) {
    test(`${change} during verification phase ${phase} cannot enable or overwrite a channel`, async t => {
      const f = fixture(t), gate = deferred();
      f.state.verify = async (appId, call) => { if (call === phase) await gate.promise; return verified(appId, f.state.clock); };
      f.start(); f.state.sdk[0].resolve({...credentials});
      await until(() => f.state.verification.length, phase, 'verification phase');
      let manual;
      if (change === 'role-revoked') f.store.run("UPDATE members SET role='member' WHERE id='m'");
      if (change === 'employee-disabled') f.store.run("UPDATE entities SET lifecycle_enabled=0 WHERE id='e'");
      if (change === 'manual-binding') {
        manual = await f.channels.save('w', 'e', 'feishu', 'u', {appId: 'cli_manual', appSecret: 'synthetic-manual-secret', expectedRevision: 0});
      }
      gate.resolve();
      await until(() => f.status().state, 'needs_attention');
      assert.equal(f.status().credentialSaved, true);
      if (manual) {
        assert.equal(f.connection().id, manual.id);
        assert.equal(f.connection().appId, 'cli_manual');
        assert.equal(f.connection().revision, 1);
        assert.equal(f.status().error, 'feishu_registration_connection_changed');
      } else assert.equal(f.connection(), undefined);
      if (change === 'role-revoked') assert.throws(() => f.retry(), code('entity_manage_forbidden'));
      assertPrivate(f);
    });
  }
}

test('pre-existing manual binding prevents SDK registration entirely', async t => {
  const f = fixture(t);
  await f.channels.save('w', 'e', 'feishu', 'u', {appId: 'cli_manual', appSecret: 'synthetic-manual-secret', expectedRevision: 0});
  const original = f.connection();
  assert.throws(() => f.start(), code('feishu_registration_already_connected'));
  assert.deepEqual(f.connection(), original);
  assert.equal(f.state.sdk.length, 0);
});

test('cancel after credential return preserves recoverable credentials without registering again', async t => {
  const f = fixture(t), gate = deferred();
  f.state.verify = async appId => { await gate.promise; const result = verified(appId, f.state.clock); result.validation.checks[0].scopeInventory.shift(); return result; };
  f.start(); f.state.sdk[0].resolve({...credentials});
  await until(() => f.status().state, 'checking');
  assert.equal(f.cancel().credentialSaved, true);
  gate.resolve();
  await until(() => f.status().state, 'needs_attention');
  assert.equal(f.cancel().credentialSaved, true);
  assert.equal(f.connection(), undefined);
  f.state.verify = undefined; f.retry();
  await until(() => f.status().state, 'connected');
  assert.equal(f.state.sdk.length, 1);
});

test('HTTP routes enforce manager and ownership checks, reject extra input, and never expose secret material', async t => {
  const f = fixture(t), app = f.app();
  for (const [method, suffix, payload] of [['GET', ''], ['POST', '', {operationId: 'unauthorized'}], ['POST', '/retry', {id: 'unauthorized'}], ['POST', '/cancel', {id: 'unauthorized'}]]) {
    const response = await app.inject({method, url: base + suffix, headers: {'x-test-user': 'guest'}, ...(payload ? {payload} : {})});
    assert.equal(response.statusCode, 403);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  for (const payload of [{}, [], {operationId: 'invalid space'}, {operationId: 'op', appSecret: 'forged'}, {operationId: 'op', appId: 'cli_forged'}, {operationId: 'op', name: 'forged'}, {operationId: 'op', scopes: ['drive:drive']}]) {
    const response = await app.inject({method: 'POST', url: base, payload});
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), {error: 'invalid_feishu_registration'});
  }
  assert.equal(f.state.sdk.length, 0);
  const started = await app.inject({method: 'POST', url: base, payload: {operationId: 'api-operation'}});
  assert.equal(started.statusCode, 200);
  assert.equal(started.headers['cache-control'], 'no-store');
  const id = started.json().registration.id;
  f.state.sdk[0].input.onQRCodeReady({url: verificationUrl, expireIn: 120});
  const hidden = await app.inject({url: base, headers: {'x-test-user': 'v'}});
  assert.equal(hidden.statusCode, 200);
  assert.equal(hidden.json().registration, null);
  assert.ok(!hidden.body.includes(verificationUrl));
  for (const suffix of ['/retry', '/cancel']) {
    const denied = await app.inject({method: 'POST', url: base + suffix, headers: {'x-test-user': 'v'}, payload: {id}});
    assert.equal(denied.statusCode, 404);
  }
  const foreignOperation = await app.inject({method: 'POST', url: base, headers: {'x-test-user': 'v'}, payload: {operationId: 'api-operation'}});
  assert.equal(foreignOperation.statusCode, 404);
  assert.throws(() => f.registration.cancel('w', 'e2', 'u', id), code('feishu_registration_not_found'));
  assert.throws(() => f.registration.cancel('other', 'oe', 'u', id), code('feishu_registration_not_found'));
  await accept(f);
  const completed = await app.inject({url: base});
  assert.equal(completed.json().registration.state, 'connected');
  assert.ok(!completed.body.includes(secret));
  assert.ok(!completed.body.includes(verificationUrl));
  assertPrivate(f);
});

test('missing server encryption key refuses before calling the SDK', t => {
  const f = fixture(t, {masterKey: null});
  assert.throws(() => f.start(), code('channel_secret_key_unconfigured'));
  assert.equal(f.state.sdk.length, 0);
});

test('registration state is platform-owned and forbidden in both runtime snapshot formats', async t => {
  const f = fixture(t, {role: 'platform'});
  f.start(); f.state.sdk[0].resolve({...credentials});
  await until(() => f.status().state, 'connected');
  assert.ok(PLATFORM_TABLES.includes('feishu_app_registrations'));
  assert.ok(!RUNTIME_TABLES.includes('feishu_app_registrations'));
  assert.ok(!Object.values(CONFIGURATION_MODULES).flat().includes('feishu_app_registrations'));
  const snapshot = configurationSnapshot({store: f.store, token: 'synthetic-runtime-token', masterKey: f.options.masterKey});
  assert.ok(!JSON.stringify(snapshot).includes('feishu_app_registrations'));
  assert.ok(!JSON.stringify(snapshot).includes(f.status().id));
  const table = f.store.one("SELECT sql FROM main.sqlite_master WHERE name='feishu_app_registrations'");
  assert.ok(table);
  const runtime = new Store(join(f.dir, 'runtime.sqlite'), {role: 'runtime'});
  try {
    assert.throws(() => runtime.replaceConfigurationTables({feishu_app_registrations: []}), /snapshot_table_forbidden:feishu_app_registrations/);
    assert.throws(() => runtime.replaceConfigurationTables([{name: 'feishu_app_registrations', sql: table.sql, rows: []}]), /snapshot_table_forbidden:feishu_app_registrations/);
    assert.equal(runtime.one("SELECT name FROM main.sqlite_master WHERE name='feishu_app_registrations'"), undefined);
  } finally { runtime.close(); }
});

test('real Feishu transport and directory adapters parse synthetic scope inventory before enabling', async t => {
  const f = fixture(t), calls = [];
  let granted = false;
  delete f.options.verifyApplication;
  delete f.options.adapterFactory;
  const json = data => new Response(JSON.stringify(data), {headers: {'content-type': 'application/json'}});
  const envelope = data => json({code: 0, data});
  f.options.fetch = async (url, init = {}) => {
    const target = new URL(url), path = target.pathname;
    assert.equal(target.origin, 'https://open.feishu.cn');
    assert.equal(init.redirect, 'error');
    calls.push({path, method: init.method});
    if (path === '/open-apis/auth/v3/tenant_access_token/internal') {
      assert.equal(init.method, 'POST');
      assert.deepEqual(JSON.parse(init.body), {app_id: credentials.client_id, app_secret: secret});
      return json({code: 0, tenant_access_token: 'synthetic-transport-token', expire: 7200});
    }
    assert.equal(init.method, 'GET', 'no permission mutation, publication or messages during verification');
    if (path === '/open-apis/application/v6/scopes') return envelope({scopes: requiredScopes.map((scope_name, index) => ({scope_name, scope_type: 'tenant', grant_status: granted || index > 0 ? 1 : 2}))});
    if (path === '/open-apis/bot/v3/info') return json({code: 0, bot: {open_id: 'synthetic-bot'}});
    if (path === '/open-apis/tenant/v2/tenant/query') return envelope({tenant: {tenant_key: 'synthetic-tenant'}});
    if (path === '/open-apis/contact/v3/scopes') return envelope({department_ids: ['od_synthetic'], user_ids: ['ou_synthetic'], has_more: false});
    if (path === '/open-apis/contact/v3/departments/od_synthetic') return envelope({department: {open_department_id: 'od_synthetic', name: 'Synthetic department', parent_department_id: '0'}});
    if (path === '/open-apis/contact/v3/users/ou_synthetic') return envelope({user: {open_id: 'ou_synthetic', name: 'Synthetic private person', department_ids: ['od_synthetic']}});
    assert.fail('Unexpected synthetic provider route ' + path);
  };
  f.start(); f.state.sdk[0].resolve({...credentials});
  await until(() => f.status().state, 'needs_attention');
  assert.deepEqual(f.status().missingScopes, [requiredScopes[0]]);
  assert.equal(f.status().credentialSaved, true);
  assert.equal(f.connection(), undefined);
  const inventory = f.status().validation.checks.find(check => check.id === 'scope_inventory').scopeInventory;
  assert.deepEqual(inventory[0], {scope: requiredScopes[0], identity: 'tenant', status: 'denied'});
  assert.ok(calls.some(call => call.path === '/open-apis/contact/v3/users/ou_synthetic'));
  granted = true;
  f.retry();
  await until(() => f.status().state, 'connected');
  assert.equal(f.connection().enabled, true);
  assert.equal(f.connection().status, 'verified');
  assert.equal(f.state.sdk.length, 1);
  assert.equal(calls.filter(call => call.path === '/open-apis/application/v6/scopes').length, 3);
  assert.ok(f.connection().validation.checks.find(check => check.id === 'scope_inventory').scopeInventory.every(row => row.status === 'granted'));
  const publicData = JSON.stringify(f.registration.status('w', 'e', 'u'));
  assert.ok(!publicData.includes('synthetic-transport-token'));
  assert.ok(!publicData.includes('Synthetic private person'));
  assertPrivate(f);
});

for (const late of ['resolve', 'reject']) {
  test(`real bootstrap closes a waiting registration before its Store and ignores late SDK ${late}`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'identale-feishu-registration-server-'));
    const path = join(dir, 'test.sqlite'), calls = [];
    const origin = 'http://127.0.0.1:5173';
    let closed = false;
    const server = createServer({
      databasePath: path, origin, pollIntervalMs: 0, directorySync: {automatic: false},
      employeeChannels: {
        masterKey: new Uint8Array(32).fill(17),
        registerFeishuApp: input => { const completion = deferred(); calls.push({input, ...completion}); return completion.promise; },
        fetch: async () => { assert.fail('No real network access is permitted'); },
      },
      channelIngressFactory: () => ({async start() { assert.fail('Waiting registration must not create an ingress connection'); }, async stop() {}}),
    });
    t.after(async () => { if (!closed) await server.close(); rmSync(dir, {recursive: true, force: true}); });
    await server.ready();
    const user = await server.inject({method: 'POST', url: '/api/auth/register', headers: {origin}, payload: {username: 'registration-close-' + late, password: 'Synthetic test account password 2026!'}});
    assert.equal(user.statusCode, 201, user.body);
    const headers = {origin, cookie: user.headers['set-cookie'].split(';')[0]};
    const workspaceId = user.json().workspace.id;
    const entity = await server.inject({method: 'POST', url: `/api/workspaces/${workspaceId}/entities`, headers, payload: {name: 'Synthetic registration shutdown', ownWebUse: true}});
    assert.equal(entity.statusCode, 200, entity.body);
    const entityId = entity.json().entity.id;
    const url = `/api/workspaces/${workspaceId}/entities/${entityId}/channels/feishu/registration`;
    const started = await server.inject({method: 'POST', url, headers, payload: {operationId: 'synthetic-server-operation'}});
    assert.equal(started.statusCode, 200, started.body);
    assert.equal(calls.length, 1);
    calls[0].input.onQRCodeReady({url: verificationUrl, expireIn: 120});
    const pending = await server.inject({url, headers});
    assert.equal(pending.json().registration.state, 'awaiting_confirmation');
    await assert.doesNotReject(server.close());
    closed = true;
    assert.equal(calls[0].input.signal.aborted, true);
    assert.doesNotThrow(() => calls[0].input.onQRCodeReady({url: verificationUrl, expireIn: 120}));
    assert.doesNotThrow(() => calls[0].input.onStatusChange({status: 'domain_switched'}));
    if (late === 'resolve') calls[0].resolve({...credentials});
    else calls[0].reject(new Error(secret + ' ' + verificationUrl));
    await tick(); await tick();
    const db = new DatabaseSync(path);
    try {
      const raw = JSON.parse(db.prepare('SELECT record_json FROM feishu_app_registrations').get().record_json);
      assert.equal(raw.state, 'interrupted');
      assert.equal(raw.secret, undefined);
      assert.equal(raw.appId, undefined);
      assert.equal(db.prepare('SELECT count(*) AS n FROM employee_channel_connections').get().n, 0);
      assert.ok(!JSON.stringify(raw).includes(verificationUrl));
      assert.ok(!JSON.stringify(raw).includes(secret));
    } finally { db.close(); }
  });
}

async function committedBeforeRegistrationStatus(f) {
  // The supported post-commit notification runs before save() resolves. Closing the
  // registration there reproduces the crash window without constructing DB state.
  f.channels.setCleanupListener(() => f.registration.close());
  const started = f.start();
  f.state.sdk[0].resolve({...credentials});
  await until(() => !!f.connection(), true, 'channel transaction committed');
  await tick();
  const record = JSON.parse(f.store.one('SELECT record_json FROM feishu_app_registrations WHERE id=?', started.id).record_json);
  assert.equal(record.state, 'checking');
  assert.ok(record.secret.ciphertext);
  assert.equal(f.connection().enabled, true);
  assert.equal(f.connection().status, 'verified');
  assert.equal(f.state.verification.length, 2);
  f.channels.setCleanupListener(undefined);
  return record;
}

test('restart repairs channel-commit registration-status window without another registration or channel write', async t => {
  const f = fixture(t, {role: 'platform'}), unfinished = await committedBeforeRegistrationStatus(f);
  const saved = f.connection();
  const auditCount = f.store.one('SELECT count(*) AS n FROM employee_channel_audit').n;
  f.restart();
  assert.equal(f.status().id, unfinished.id);
  assert.equal(f.status().state, 'connected');
  assert.equal(f.status().credentialSaved, true);
  assert.equal(f.raw().secret, undefined);
  assert.equal(f.status().error, undefined);
  assert.equal(f.status().missingScopes, undefined);
  assert.deepEqual(f.connection(), saved);
  assert.equal(f.retry().state, 'connected');
  await settledCheck(f);
  assert.equal(f.start().id, unfinished.id);
  assert.equal(f.state.sdk.length, 1);
  assert.equal(f.state.verification.length, 2, 'recovered baseline-only registration needs no extra provider read');
  assert.equal(f.store.one('SELECT count(*) AS n FROM employee_channel_audit').n, auditCount);
  assertPrivate(f);
});

for (const change of ['disabled', 'pending-verification', 'directory-unavailable', 'missing-scope', 'user-only-scope', 'different-app']) {
  test(`restart does not mistake ${change} channel for a completed registration`, async t => {
    const f = fixture(t), unfinished = await committedBeforeRegistrationStatus(f);
    const saved = f.connection();
    if (change === 'disabled') {
      f.channels.settings('w', 'e', 'feishu', 'u', {enabled: false, expectedRevision: saved.revision});
      assert.equal(f.connection().enabled, false);
    } else if (change === 'directory-unavailable') {
      f.options.adapterFactory = provider => ({provider, capabilities: {}, getAuthorizedScope: async () => { throw new DirectoryError('authorization_denied'); }});
      await assert.rejects(f.channels.discovery('w', 'e', 'feishu', {kind: 'departments'}), code('authorization_denied'));
      assert.equal(f.connection().directoryStatus, 'unavailable');
    } else {
      f.state.verify = appId => {
        const result = verified(appId, f.state.clock);
        if (change === 'pending-verification') delete result.eventTenantId;
        if (change === 'missing-scope') result.validation.checks[0].scopeInventory.shift();
        if (change === 'user-only-scope') result.validation.checks[0].scopeInventory[0].identity = 'user';
        return result;
      };
      await f.channels.save('w', 'e', 'feishu', 'u', {
        appId: change === 'different-app' ? 'cli_manual_after_commit' : credentials.client_id,
        appSecret: secret, expectedRevision: saved.revision,
        ...(change === 'different-app' ? {replaceSource: true} : {}),
      });
      if (change === 'pending-verification') assert.equal(f.connection().status, 'pending_verification');
    }
    const changed = f.connection();
    f.restart();
    assert.equal(f.status().id, unfinished.id);
    assert.equal(f.status().state, 'needs_attention');
    assert.equal(f.status().credentialSaved, true);
    assert.deepEqual(f.raw().secret, unfinished.secret);
    assert.deepEqual(f.connection(), changed);
    const verificationCount = f.state.verification.length;
    f.retry();
    await until(() => f.status().state, 'needs_attention');
    assert.equal(f.state.verification.length, verificationCount);
    assert.equal(f.status().error, 'feishu_registration_connection_changed');
    assert.deepEqual(f.connection(), changed);
    assert.equal(f.state.sdk.length, 1);
    assertPrivate(f);
  });
}

// These extension names test grouping only. They are not a production permission manifest.
const syntheticTenantScope = 'synthetic:extension:read';
const syntheticUserScope = 'synthetic:user_extension:read';
const groupedProfile = () => ({
  version: 'synthetic-grouped-v1', scopes: [...requiredScopes, syntheticTenantScope],
  userScopes: [syntheticUserScope], events: [...requiredEvents],
  groups: [
    {id: 'basic', label: 'Synthetic baseline', required: true, identity: 'tenant', scopes: [...requiredScopes]},
    {id: 'extended', label: 'Synthetic extension', required: false, identity: 'tenant', scopes: [syntheticTenantScope]},
    {id: 'user-extension', label: 'Synthetic user extension', required: false, identity: 'user', scopes: [syntheticUserScope], note: 'User authorization is separate from application registration.'},
  ],
});
const group = (f, id) => f.status().permissionGroups.find(value => value.id === id);
const inventory = result => result.validation.checks.find(check => check.id === 'scope_inventory').scopeInventory;
const baselineRows = () => requiredScopes.map(scope => ({scope, identity: 'tenant', status: 'granted'}));
function optionalRows({tenant = 'denied', user = 'denied'} = {}) {
  return [...baselineRows(), {scope: syntheticTenantScope, identity: 'tenant', status: tenant}, {scope: syntheticUserScope, identity: 'user', status: user}];
}
function installInventoryFetch(f, getRows = () => optionalRows()) {
  delete f.options.verifyApplication; // Exercise the real read-only provider scope transport.
  const calls = [];
  const json = value => new Response(JSON.stringify(value), {headers: {'content-type': 'application/json'}});
  f.options.fetch = async (url, init = {}) => {
    const target = new URL(url);
    assert.equal(target.origin, 'https://open.feishu.cn');
    assert.equal(init.redirect, 'error');
    calls.push(target.pathname);
    if (target.pathname === '/open-apis/auth/v3/tenant_access_token/internal') {
      assert.equal(init.method, 'POST');
      assert.deepEqual(JSON.parse(init.body), {app_id: credentials.client_id, app_secret: secret});
      return json({code: 0, tenant_access_token: 'synthetic-readonly-inventory-token', expire: 7200});
    }
    assert.equal(target.pathname, '/open-apis/application/v6/scopes', 'connected refresh must only inspect scopes');
    assert.equal(init.method, 'GET');
    const rows = await getRows();
    return json({code: 0, data: {scopes: rows.map(row => ({scope_name: row.scope, scope_type: row.identity, grant_status: row.status === 'granted' ? 1 : row.status === 'denied' ? 2 : 99}))}});
  };
  return calls;
}
async function settledCheck(f) {
  await until(() => f.status().autoCheck.inProgress, false, 'automatic check completion');
  await tick();
}

test('grouped profile requests explicit tenant/user unions and optional denial does not block baseline completion', async t => {
  const profile = groupedProfile(), f = fixture(t, {profile});
  f.state.verify = appId => {
    const result = verified(appId, f.state.clock);
    inventory(result).push(...optionalRows().slice(requiredScopes.length));
    return result;
  };
  f.start();
  assert.deepEqual(f.state.sdk[0].input.addons.scopes, {tenant: profile.scopes, user: profile.userScopes});
  await accept(f); await settledCheck(f);
  assert.equal(f.status().profileVersion, profile.version);
  assert.equal(group(f, 'basic').status, 'granted');
  assert.equal(group(f, 'extended').required, false);
  assert.equal(group(f, 'extended').status, 'missing');
  assert.deepEqual(group(f, 'extended').missingScopes, [syntheticTenantScope]);
  assert.equal(group(f, 'user-extension').identity, 'user');
  assert.equal(group(f, 'user-extension').status, 'missing');
  assert.ok(group(f, 'user-extension').note.includes('separate'));
  assert.equal(f.connection().enabled, true);
  assert.equal(f.connection().revision, 1);
  assert.equal(f.status().missingScopes, undefined);
  assert.equal(f.status().autoCheck.eligible, true);
  assertPrivate(f);
});

test('cross-identity grants never satisfy tenant or user extension groups', async t => {
  const f = fixture(t, {profile: groupedProfile()});
  f.state.verify = appId => {
    const result = verified(appId, f.state.clock);
    inventory(result).push(
      {scope: syntheticTenantScope, identity: 'user', status: 'granted'},
      {scope: syntheticUserScope, identity: 'tenant', status: 'granted'},
    );
    return result;
  };
  f.start(); await accept(f); await settledCheck(f);
  assert.equal(group(f, 'basic').status, 'granted');
  for (const id of ['extended', 'user-extension']) {
    assert.notEqual(group(f, id).status, 'granted');
    assert.ok(group(f, id).scopeStates.every(row => row.status !== 'granted'));
  }
  assert.equal(f.connection().enabled, true);
  assertPrivate(f);
});

test('unknown inventory remains unknown rather than inventing granted or denied group evidence', async t => {
  const f = fixture(t, {profile: groupedProfile()});
  f.state.verify = appId => {
    const result = verified(appId, f.state.clock);
    result.validation.checks[0] = {id: 'scope_inventory', required: false, supported: true, status: 'unverified', reason: 'inventory_unavailable'};
    return result;
  };
  f.start(); f.state.sdk[0].resolve({...credentials});
  await until(() => f.status().state, 'needs_attention');
  assert.ok(f.status().permissionGroups.every(value => value.status === 'unknown'));
  assert.equal(f.connection(), undefined);
  assert.equal(f.status().credentialSaved, true);
});

test('automatic retry observes approval and completes without another SDK registration', async t => {
  const f = fixture(t, {profile: groupedProfile()});
  let approved = false;
  f.state.verify = appId => {
    const result = verified(appId, f.state.clock);
    if (!approved) inventory(result)[0].status = 'denied';
    return result;
  };
  f.start(); f.state.sdk[0].resolve({...credentials});
  await until(() => f.status().state, 'needs_attention'); await settledCheck(f);
  assert.equal(f.status().autoCheck.eligible, true);
  assert.equal(f.status().autoCheck.nextCheckAt, f.state.clock + 5000);
  approved = true;
  f.state.clock = f.status().autoCheck.nextCheckAt;
  f.retry(true);
  await until(() => f.status().state, 'connected'); await settledCheck(f);
  assert.equal(f.state.sdk.length, 1);
  assert.equal(f.connection().revision, 1);
  assert.equal(group(f, 'basic').status, 'granted');
  assertPrivate(f);
});

test('GET remains provider-read-only at scheduled check time and automatic retries use bounded backoff', async t => {
  const f = fixture(t, {profile: groupedProfile()}), app = f.app();
  f.state.verify = appId => { const result = verified(appId, f.state.clock); inventory(result)[0].status = 'denied'; return result; };
  f.start(); f.state.sdk[0].resolve({...credentials});
  await until(() => f.status().state, 'needs_attention'); await settledCheck(f);
  for (const delay of [5000, 10000, 20000, 30000, 60000, 60000]) {
    const dto = f.status(), before = f.state.verification.length;
    assert.equal(dto.autoCheck.nextCheckAt - f.state.clock, delay);
    f.retry(true); await tick();
    assert.equal(f.state.verification.length, before, 'automatic retry cannot bypass cooldown');
    f.state.clock = dto.autoCheck.nextCheckAt;
    for (let read = 0; read < 3; read++) {
      const response = await app.inject({url: base});
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.json().registration.autoCheck.inProgress, false);
    }
    assert.equal(f.state.verification.length, before, 'GET must not launch provider requests');
    f.retry(true); await settledCheck(f);
    assert.equal(f.state.verification.length, before + 1);
    assert.equal(f.status().state, 'needs_attention');
  }
  const before = f.state.verification.length;
  f.retry(false); await settledCheck(f);
  assert.equal(f.state.verification.length, before + 1, 'manual retry is immediate during cooldown');
  assert.equal(f.state.sdk.length, 1);
});

test('concurrent automatic retry requests share one check and HTTP rejects unapproved automatic input', async t => {
  const f = fixture(t, {profile: groupedProfile()}), app = f.app(), gate = deferred();
  let gated = false;
  f.state.verify = async appId => {
    if (gated) await gate.promise;
    const result = verified(appId, f.state.clock); inventory(result)[0].status = 'denied'; return result;
  };
  f.start(); f.state.sdk[0].resolve({...credentials});
  await until(() => f.status().state, 'needs_attention'); await settledCheck(f);
  const id = f.status().id;
  for (const payload of [{id, automatic: 'true'}, {id, automatic: true, scopes: [syntheticTenantScope]}, {id, automatic: true, appId: 'cli_forged'}]) {
    const response = await app.inject({method: 'POST', url: base + '/retry', payload});
    assert.equal(response.statusCode, 400);
  }
  f.state.clock = f.status().autoCheck.nextCheckAt;
  gated = true;
  const before = f.state.verification.length;
  const replies = await Promise.all(Array.from({length: 4}, () => app.inject({method: 'POST', url: base + '/retry', payload: {id, automatic: true}})));
  assert.ok(replies.every(reply => reply.statusCode === 200));
  assert.equal(f.state.verification.length, before + 1);
  assert.equal(f.status().autoCheck.inProgress, true);
  gate.resolve(); await settledCheck(f);
  assert.equal(f.state.verification.length, before + 1);
  assert.equal(f.state.sdk.length, 1);
});

test('connected optional refresh reads scopes once without saving, reconnecting or authorizing user resources', async t => {
  const f = fixture(t, {profile: groupedProfile()});
  f.start(); await accept(f); await settledCheck(f);
  const connection = f.connection(), audit = f.store.all('SELECT * FROM employee_channel_audit');
  let notifications = 0;
  f.channels.setCleanupListener(() => notifications++);
  const gate = deferred();
  const calls = installInventoryFetch(f, async () => { await gate.promise; return optionalRows({tenant: 'granted', user: 'granted'}); });
  f.state.clock = f.status().autoCheck.nextCheckAt;
  f.retry(true);
  await until(() => calls.filter(path => path.endsWith('/scopes')).length, 1, 'scope inventory request');
  assert.equal(f.status().state, 'connected');
  assert.equal(f.status().autoCheck.inProgress, true);
  f.retry(true); f.retry(false);
  assert.equal(calls.filter(path => path.endsWith('/scopes')).length, 1);
  gate.resolve(); await settledCheck(f);
  assert.ok(f.status().permissionGroups.every(value => value.status === 'granted'));
  assert.equal(f.status().autoCheck.eligible, false);
  assert.equal(f.status().autoCheck.nextCheckAt, null);
  assert.equal(group(f, 'user-extension').identity, 'user');
  assert.ok(group(f, 'user-extension').note.includes('separate'));
  assert.deepEqual(f.connection(), connection);
  assert.deepEqual(f.store.all('SELECT * FROM employee_channel_audit'), audit);
  assert.equal(notifications, 0);
  const requestCount = calls.length;
  f.state.clock += 120_000;
  f.retry(true); await tick();
  assert.equal(calls.length, requestCount, 'completed groups must stop automatic provider checks');
  assert.equal(f.state.verification.length, 2, 'no repeated full application validation');
  assert.equal(f.state.sdk.length, 1);
  assertPrivate(f);
});

test('registration keeps its profile snapshot through caller mutation, restart and a newer default', async t => {
  const profile = groupedProfile(), original = structuredClone(profile), f = fixture(t, {profile});
  f.state.verify = appId => { const result = verified(appId, f.state.clock); inventory(result)[0].status = 'denied'; return result; };
  f.start();
  profile.version = 'mutated-after-start';
  profile.scopes.push('synthetic:mutated_requirement:read');
  profile.groups[0].scopes.push('synthetic:mutated_requirement:read');
  f.state.sdk[0].resolve({...credentials});
  await until(() => f.status().state, 'needs_attention'); await settledCheck(f);
  assert.equal(f.status().profileVersion, original.version);
  assert.deepEqual(f.raw().profile, original);
  assert.deepEqual(f.status().requestedPermissions, original);
  assert.deepEqual(f.status().permissionGroups.map(({status, scopeStates, missingScopes, ...value}) => value), original.groups);
  f.profile = groupedProfile();
  f.profile.version = 'synthetic-grouped-v2';
  f.profile.scopes.push('synthetic:new_baseline:read');
  f.profile.groups[0].scopes.push('synthetic:new_baseline:read');
  f.restart();
  assert.equal(f.status().profileVersion, original.version);
  assert.deepEqual(f.raw().profile, original);
  assert.deepEqual(f.status().requestedPermissions, original);
  assert.deepEqual(f.status().permissionGroups.map(({status, scopeStates, missingScopes, ...value}) => value), original.groups);
  f.state.verify = undefined;
  f.retry();
  await until(() => f.status().state, 'connected'); await settledCheck(f);
  assert.equal(f.state.sdk.length, 1);
  const next = f.registration.start('w', 'e2', 'u', 'new-profile-operation');
  assert.equal(next.registration.profileVersion, 'synthetic-grouped-v2');
  assert.deepEqual(next.registration.requestedPermissions, f.profile);
  assert.ok(f.state.sdk[1].input.addons.scopes.tenant.includes('synthetic:new_baseline:read'));
});

test('legacy records without profile keep the original fourteen requirements after upgrade', async t => {
  const f = fixture(t);
  f.state.verify = appId => { const result = verified(appId, f.state.clock); inventory(result)[0].status = 'denied'; return result; };
  f.start(); f.state.sdk[0].resolve({...credentials});
  await until(() => f.status().state, 'needs_attention'); await settledCheck(f);
  const historical = f.raw();
  delete historical.profile; // Only emulate the pre-profile serialized record format.
  f.store.run('UPDATE feishu_app_registrations SET record_json=? WHERE id=?', JSON.stringify(historical), historical.id);
  f.profile = groupedProfile();
  f.profile.version = 'synthetic-upgraded-default';
  f.profile.groups[0].scopes.push('synthetic:added_requirement:read');
  f.profile.scopes.push('synthetic:added_requirement:read');
  f.restart();
  assert.equal(f.status().profileVersion, 'conversation-directory-v1');
  assert.equal(f.status().requestedPermissions.version, 'conversation-directory-v1');
  assert.deepEqual(f.status().requestedPermissions.scopes, requiredScopes);
  assert.deepEqual(f.status().requestedPermissions.userScopes, []);
  assert.deepEqual(f.status().requestedPermissions.events, requiredEvents);
  assert.deepEqual(f.status().permissionGroups.flatMap(value => value.scopes), requiredScopes);
  f.state.verify = undefined; f.retry();
  await until(() => f.status().state, 'connected'); await settledCheck(f);
  assert.equal(f.state.sdk.length, 1);
  assertPrivate(f);
});

test('automatic cooldown and profile survive restart without a background provider call', async t => {
  const f = fixture(t, {profile: groupedProfile()});
  f.state.verify = appId => { const result = verified(appId, f.state.clock); inventory(result)[0].status = 'denied'; return result; };
  f.start(); f.state.sdk[0].resolve({...credentials});
  await until(() => f.status().state, 'needs_attention'); await settledCheck(f);
  const schedule = f.status().autoCheck.nextCheckAt, before = f.state.verification.length;
  f.restart();
  assert.equal(f.status().autoCheck.nextCheckAt, schedule);
  assert.equal(f.status().profileVersion, 'synthetic-grouped-v1');
  assert.equal(f.status().autoCheck.inProgress, false);
  f.state.clock = schedule + 60_000;
  for (let i = 0; i < 5; i++) { f.status(); await tick(); }
  assert.equal(f.state.verification.length, before);
  f.retry(true); await settledCheck(f);
  assert.equal(f.state.verification.length, before + 1);
  assert.equal(f.state.sdk.length, 1);
});

for (const change of ['role-revoked', 'employee-disabled', 'channel-disabled', 'different-app', 'credentials-rotated']) {
  test(`connected refresh fences ${change} during an in-flight scope read`, async t => {
    const f = fixture(t, {profile: groupedProfile()});
    f.start(); await accept(f); await settledCheck(f);
    const gate = deferred();
    const calls = installInventoryFetch(f, async () => { await gate.promise; return optionalRows({tenant: 'granted', user: 'granted'}); });
    f.retry();
    await until(() => calls.filter(path => path.endsWith('/scopes')).length, 1);
    const before = f.connection();
    if (change === 'role-revoked') f.store.run("UPDATE members SET role='member' WHERE id='m'");
    if (change === 'employee-disabled') f.store.run("UPDATE entities SET lifecycle_enabled=0 WHERE id='e'");
    if (change === 'channel-disabled') f.channels.settings('w', 'e', 'feishu', 'u', {enabled: false, expectedRevision: before.revision});
    if (change === 'different-app' || change === 'credentials-rotated') {
      const replacementService = new EmployeeChannelService(f.repository, {...f.options, verifyApplication: async (_provider, appId) => verified(appId, f.state.clock)});
      await replacementService.save('w', 'e', 'feishu', 'u', {appId: change === 'different-app' ? 'cli_replacement' : credentials.client_id, appSecret: 'synthetic-replacement', expectedRevision: before.revision, ...(change === 'different-app' ? {replaceSource: true} : {})});
    }
    const current = f.connection();
    gate.resolve(); await settledCheck(f);
    assert.notEqual(group(f, 'extended').status, 'granted');
    assert.deepEqual(f.connection(), current);
    assert.equal(f.state.sdk.length, 1);
    assertPrivate(f);
  });
}

test('closing during connected optional refresh drops late results and restart recovers its read-only check', async t => {
  const f = fixture(t, {profile: groupedProfile()});
  f.start(); await accept(f); await settledCheck(f);
  const before = f.connection(), gate = deferred();
  const calls = installInventoryFetch(f, async () => { await gate.promise; return optionalRows({tenant: 'granted', user: 'granted'}); });
  f.retry();
  await until(() => calls.filter(path => path.endsWith('/scopes')).length, 1);
  f.restart();
  assert.equal(f.status().autoCheck.inProgress, false);
  gate.resolve(); await tick(); await tick();
  assert.notEqual(group(f, 'extended').status, 'granted');
  assert.deepEqual(f.connection(), before);
  installInventoryFetch(f, () => optionalRows({tenant: 'granted', user: 'granted'}));
  f.retry(); await settledCheck(f);
  assert.equal(group(f, 'extended').status, 'granted');
  assert.deepEqual(f.connection(), before);
  assert.equal(f.state.sdk.length, 1);
  assertPrivate(f);
});

for (const change of ['role-revoked', 'employee-disabled', 'channel-disabled', 'different-app']) {
  test(`automatic and manual checks refuse ${change} before provider access`, async t => {
    const f = fixture(t, {profile: groupedProfile()});
    f.start(); await accept(f); await settledCheck(f);
    const before = f.connection();
    if (change === 'role-revoked') f.store.run("UPDATE members SET role='member' WHERE id='m'");
    if (change === 'employee-disabled') f.store.run("UPDATE entities SET lifecycle_enabled=0 WHERE id='e'");
    if (change === 'channel-disabled') f.channels.settings('w', 'e', 'feishu', 'u', {enabled: false, expectedRevision: before.revision});
    if (change === 'different-app') await f.channels.save('w', 'e', 'feishu', 'u', {appId: 'cli_changed_before_check', appSecret: 'synthetic-new-secret', expectedRevision: before.revision, replaceSource: true});
    const current = f.connection(), calls = installInventoryFetch(f);
    assert.equal(f.status().autoCheck.eligible, false);
    f.state.clock += 120_000;
    for (const automatic of [true, false]) {
      try { f.retry(automatic); }
      catch (error) { assert.ok(error instanceof EmployeeChannelError); }
      await tick();
    }
    assert.equal(calls.length, 0);
    assert.deepEqual(f.connection(), current);
    assert.equal(f.state.sdk.length, 1);
  });
}

test('connected inventory errors are redacted, preserve channel configuration and remain unknown', async t => {
  const f = fixture(t, {profile: groupedProfile()});
  f.start(); await accept(f); await settledCheck(f);
  const before = f.connection();
  installInventoryFetch(f, () => { throw new Error(secret + ' ' + verificationUrl); });
  f.retry(); await settledCheck(f);
  assert.equal(f.status().state, 'connected');
  assert.equal(group(f, 'extended').status, 'unknown');
  assert.equal(group(f, 'user-extension').status, 'unknown');
  assert.deepEqual(f.connection(), before);
  assert.equal(f.state.sdk.length, 1);
  assertPrivate(f);
});

test('connected inventory authentication failure pauses automatic retries until an explicit successful check', async t => {
  const f = fixture(t, {profile: groupedProfile()});
  f.start(); await accept(f); await settledCheck(f);
  const before = f.connection();
  const calls = installInventoryFetch(f, () => optionalRows({tenant: 'granted', user: 'granted'}));
  const fetch = f.options.fetch;
  let rejectInventory = true;
  f.options.fetch = async (url, init) => {
    if (rejectInventory && new URL(url).pathname.endsWith('/scopes')) {
      calls.push(new URL(url).pathname);
      return new Response(JSON.stringify({code: 99991663, msg: secret}), {status: 401, headers: {'content-type': 'application/json'}});
    }
    return fetch(url, init);
  };
  f.retry(); await settledCheck(f);
  assert.equal(f.status().state, 'connected');
  assert.equal(f.status().error, 'authentication_failed');
  assert.equal(f.status().validation.checks.find(check => check.id === 'scope_inventory').reason, 'authentication');
  assert.equal(f.status().autoCheck.eligible, false);
  assert.equal(group(f, 'extended').status, 'unknown');
  assert.deepEqual(f.connection(), before);
  const count = calls.length;
  f.state.clock += 120_000;
  f.retry(true); await settledCheck(f);
  assert.equal(calls.length, count, 'automatic retry must not repeat a known authentication failure');
  rejectInventory = false;
  f.retry(); await settledCheck(f);
  assert.equal(f.status().error, undefined);
  assert.ok(f.status().permissionGroups.every(value => value.status === 'granted'));
  assert.deepEqual(f.connection(), before);
  assertPrivate(f);
});

for (const phase of [1, 2]) {
  test(`initial inventory authentication failure at validation phase ${phase} pauses automatic retry and keeps credentials`, async t => {
    const f = fixture(t, {profile: groupedProfile()});
    f.state.verify = (appId, call) => {
      const result = verified(appId, f.state.clock);
      if (call === phase) result.validation.checks[0] = {id: 'scope_inventory', required: false, supported: true, status: 'missing', reason: 'authentication', httpStatus: 401};
      return result;
    };
    f.start(); f.state.sdk[0].resolve({...credentials});
    await until(() => f.status().state, 'needs_attention'); await settledCheck(f);
    assert.equal(f.status().error, 'authentication_failed');
    assert.equal(f.status().credentialSaved, true);
    assert.equal(f.status().autoCheck.eligible, false);
    assert.equal(f.connection(), undefined);
    const count = f.state.verification.length;
    f.state.clock += 120_000;
    f.retry(true); await settledCheck(f);
    assert.equal(f.state.verification.length, count);
    f.state.verify = undefined;
    f.retry(); await until(() => f.status().state, 'connected'); await settledCheck(f);
    assert.equal(f.status().error, undefined);
    assert.equal(f.state.sdk.length, 1);
    assertPrivate(f);
  });
}
