import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from '../dist/server.js';

const origin = 'http://127.0.0.1:5173';
const password = 'Synthetic local test password 2026!';
async function setup(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dentity-accounts-'));
  const path = join(dir, 'test.sqlite');
  let now = 1800000000000;
  let app = createServer({ databasePath: path, origin, now: () => now, sessionTtlMs: 3600000, ...options });
  await app.ready();
  const db = new DatabaseSync(path);
  t.after(async () => { db.close(); await app.close(); await rm(dir, { recursive: true, force: true }); });
  const call = (method, url, body, cookie) => app.inject({ method, url, ...(body === undefined ? {} : { payload: body }), headers: { origin: options.origin ?? origin, ...(cookie ? { cookie } : {}) } });
  const register = async (username, extra = {}) => {
    const response = await call('POST', '/api/auth/register', { username, password, ...extra });
    assert.equal(response.statusCode, 201, response.body);
    return { ...response.json(), cookie: response.headers['set-cookie'].split(';')[0], response };
  };
  const restart=async()=>{await app.close();app=createServer({databasePath:path,origin,now:()=>now,sessionTtlMs:3600000,...options});await app.ready();return app;};
  return { app, restart, db, path, call, register, advance: ms => { now += ms; } };
}

test('new workspaces enable work items by default and a manager can persistently disable them', async t => {
  const f = await setup(t), owner = await f.register('default-items-owner');
  const created = await f.call('POST', '/api/workspaces', { name: 'Another workspace' }, owner.cookie);
  assert.equal(created.statusCode, 200, created.body);
  const workspace = created.json().workspace, settings = id => `/api/workspaces/${id}/work-items/settings`;
  for (const id of [owner.workspace.id, workspace.id]) {
    const response = await f.call('GET', settings(id), undefined, owner.cookie);
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().configured, { revision: 1, enabled: true });
    assert.equal(response.json().effective.enabled, true);
    assert.equal(f.db.prepare('SELECT enabled FROM workspace_work_item_settings WHERE workspace_id=?').get(id).enabled, 1);
  }
  assert.equal((await f.call('PUT', settings(workspace.id), { expectedRevision: 1, enabled: false }, owner.cookie)).statusCode, 200);
  const invite = (await f.call('POST', `/api/workspaces/${workspace.id}/invitations`, {}, owner.cookie)).json();
  const member = await f.register('default-items-member', { invitationToken: invite.token });
  assert.deepEqual((await f.call('GET', settings(workspace.id), undefined, member.cookie)).json().configured, { revision: 2, enabled: false }, 'Joining an existing workspace must not reset its setting');
  assert.equal((await f.call('PUT', settings(workspace.id), { expectedRevision: 2, enabled: true }, member.cookie)).statusCode, 403);
  await f.restart();
  const disabled = (await f.call('GET', settings(workspace.id), undefined, owner.cookie)).json();
  assert.deepEqual(disabled.configured, { revision: 2, enabled: false });
  assert.equal(disabled.effective.enabled, false);
  assert.deepEqual((await f.call('GET', settings(owner.workspace.id), undefined, owner.cookie)).json().configured, { revision: 1, enabled: true });
});

test('startup preserves existing enabled, disabled and unconfigured workspaces without backfilling', async t => {
  const f = await setup(t), owner = await f.register('legacy-items-owner');
  const create = async name => (await f.call('POST', '/api/workspaces', { name }, owner.cookie)).json().workspace;
  const disabled = await create('Explicitly disabled'), missing = await create('Legacy without settings');
  const settings = id => `/api/workspaces/${id}/work-items/settings`;
  assert.equal((await f.call('PUT', settings(disabled.id), { expectedRevision: 1, enabled: false }, owner.cookie)).statusCode, 200);
  f.db.prepare('DELETE FROM workspace_work_item_settings WHERE workspace_id=?').run(missing.id);
  const rows = () => f.db.prepare('SELECT * FROM workspace_work_item_settings ORDER BY workspace_id').all();
  const before = rows();
  await f.restart();
  assert.deepEqual(rows(), before);
  for (const [id, enabled, revision] of [[owner.workspace.id, true, 1], [disabled.id, false, 2], [missing.id, false, 0]]) {
    const response = (await f.call('GET', settings(id), undefined, owner.cookie)).json();
    assert.deepEqual(response.configured, { revision, enabled });
    assert.equal(response.effective.enabled, enabled);
  }
  const fresh = await create('Created after restart');
  assert.deepEqual((await f.call('GET', settings(fresh.id), undefined, owner.cookie)).json().configured, { revision: 1, enabled: true });
  assert.equal(f.db.prepare('SELECT count(*) n FROM workspace_work_item_settings WHERE workspace_id=?').get(missing.id).n, 0);
});

test('work item default initialization failure rolls back both registration and workspace creation', async t => {
  const f = await setup(t), owner = await f.register('atomic-items-owner');
  const tables = ['users', 'credentials', 'sessions', 'workspaces', 'members', 'workspace_work_item_settings', 'audit'];
  const counts = () => tables.map(table => f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n);
  const before = counts();
  f.db.exec("CREATE TRIGGER reject_item_defaults AFTER INSERT ON workspace_work_item_settings BEGIN SELECT RAISE(ABORT,'synthetic default initialization failure'); END");
  try {
    const registration = await f.call('POST', '/api/auth/register', { username: 'atomic-items-rejected', password });
    assert.equal(registration.statusCode, 500);
    assert.deepEqual(counts(), before);
    const creation = await f.call('POST', '/api/workspaces', { name: 'Rejected workspace' }, owner.cookie);
    assert.equal(creation.statusCode, 500);
    assert.deepEqual(counts(), before);
  } finally { f.db.exec('DROP TRIGGER reject_item_defaults'); }
});

test('ordinary registration is atomic, canonical unique, persistent, private, and explicit owner', async t => {
  const { db, call, register } = await setup(t);
  const alice = await register('Alice.Test', { displayName: '合成用户' });
  assert.equal(alice.user.username, 'alice.test');
  assert.equal(alice.workspace.role, 'owner');
  assert.equal(db.prepare('SELECT count(*) AS n FROM workspaces').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM members').get().n, 1);
  assert.match(db.prepare('SELECT password_hash FROM credentials').get().password_hash, /^\$argon2id\$/);
  assert.ok(!JSON.stringify(alice.response.json()).includes(password));
  assert.ok(!JSON.stringify(alice.response.json()).includes('password_hash'));
  assert.match(alice.response.headers['set-cookie'], /HttpOnly/);
  assert.match(alice.response.headers['set-cookie'], /SameSite=Strict/);
  assert.notEqual(db.prepare('SELECT token_hash FROM sessions').get().token_hash, alice.cookie.split('=')[1]);
  const duplicates = await Promise.all([1,2].map(() => call('POST', '/api/auth/register', { username: 'ALICE.TEST', password })));
  assert.deepEqual(duplicates.map(r => r.statusCode), [409,409]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM workspaces').get().n, 1);
  // Real SQLite abort proves transaction rollback, not just happy-path counts.
  db.exec("CREATE TRIGGER reject_workspace BEFORE INSERT ON workspaces BEGIN SELECT RAISE(ABORT, 'synthetic test failure'); END;");
  const failed = await call('POST', '/api/auth/register', { username: 'rollback-user', password });
  assert.equal(failed.statusCode, 500);
  assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM credentials').get().n, 1);
  db.exec("DROP TRIGGER reject_workspace; CREATE TRIGGER reject_audit BEFORE INSERT ON audit WHEN NEW.action='account.registered' BEGIN SELECT RAISE(ABORT, 'synthetic late failure'); END;");
  const lateFailure = await call('POST', '/api/auth/register', { username: 'late-rollback', password });
  assert.equal(lateFailure.statusCode, 500);
  assert.equal(lateFailure.headers['set-cookie'], undefined);
  assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get().n, 1);
});

test('login wrong/unknown use uniform error; logout, expiration and revocation deny access', async t => {
  const { db, call, register, advance } = await setup(t);
  const alice = await register('alice');
  const wrong = await call('POST', '/api/auth/login', { username: 'alice', password: 'wrong-password-value' });
  const unknown = await call('POST', '/api/auth/login', { username: 'unknown', password });
  assert.equal(wrong.statusCode, 401); assert.deepEqual(wrong.json(), unknown.json());
  const login = await call('POST', '/api/auth/login', { username: 'ALICE', password }, alice.cookie);
  assert.equal(login.statusCode, 200);
  const newCookie = login.headers['set-cookie'].split(';')[0];
  assert.equal((await call('GET', '/api/auth/me', undefined, alice.cookie)).statusCode, 401);
  assert.equal((await call('GET', '/api/auth/me', undefined, newCookie)).statusCode, 200);
  assert.equal((await call('POST', '/api/auth/logout', {}, newCookie)).statusCode, 200);
  assert.equal((await call('GET', '/api/auth/me', undefined, newCookie)).statusCode, 401);
  const second = await call('POST', '/api/auth/login', { username: 'alice', password });
  const secondCookie = second.headers['set-cookie'].split(';')[0];
  advance(3600001);
  assert.equal((await call('GET', '/api/auth/me', undefined, secondCookie)).statusCode, 401);
  const third = await call('POST', '/api/auth/login', { username: 'alice', password });
  db.exec('UPDATE sessions SET revoked=1');
  assert.equal((await call('GET', '/api/auth/me', undefined, third.headers['set-cookie'].split(';')[0])).statusCode, 401);
});

test('new member and admin invitations are reusable through their configured expiry', async t => {
  const { db, call, register, advance, restart } = await setup(t);
  const day = 86400000;
  const alice = await register('alice');
  const url = `/api/workspaces/${alice.workspace.id}/invitations`;
  const create = body => call('POST', url, body, alice.cookie);
  const inspect = token => call('POST', '/api/invitations/inspect', { token });
  const invite = (await create({})).json();
  assert.equal(invite.role, 'member');
  assert.equal(invite.expiresAt, 1800000000000 + day);
  assert.notEqual(db.prepare('SELECT token_hash FROM invitations').get().token_hash, invite.token);
  for (const hours of [0, 1.5, 180 * 24 + 1]) {
    const invalid = await create({ expiresInHours: hours });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().error, 'invalid_expiry');
  }
  const admin = (await create({ role: 'admin', expiresInHours: 180 * 24 })).json();
  assert.equal(admin.expiresAt, 1800000000000 + 180 * day);
  for (const { token, role } of [invite, admin]) {
    const joined = await Promise.all([`${role}-one`, `${role}-two`].map(username => register(username, { invitationToken: token })));
    for (const user of joined) {
      assert.equal(user.workspace.id, alice.workspace.id);
      assert.equal(user.workspace.role, role);
    }
    const repeated = await call('POST', '/api/invitations/accept', { token }, joined[0].cookie);
    assert.equal(repeated.json().workspace.memberId, joined[0].workspace.memberId);
    assert.equal((await inspect(token)).json().workspace.id, alice.workspace.id);
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM workspaces').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM members').get().n, 5);
  assert.equal(db.prepare("SELECT count(*) AS n FROM audit WHERE action='invitation.accepted'").get().n, 4);
  assert.equal(db.prepare('SELECT count(*) AS n FROM invitations WHERE used_by IS NOT NULL').get().n, 0);
  await restart();
  advance(180 * day - 1);
  assert.equal((await inspect(invite.token)).statusCode, 400);
  assert.equal((await inspect(admin.token)).statusCode, 200);
  advance(1);
  assert.equal((await inspect(admin.token)).statusCode, 400);
  const expired = await call('POST', '/api/auth/register', { username: 'late-guest', password, invitationToken: admin.token });
  assert.equal(expired.statusCode, 400);
  assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 5);
});

test('upgrading stored invitations preserves used links and single-use concurrency', async t => {
  const { db, call, register, restart } = await setup(t);
  const owner = await register('legacy-invite-owner');
  const url = `/api/workspaces/${owner.workspace.id}/invitations`;
  const used = (await call('POST', url, { role: 'admin' }, owner.cookie)).json();
  const unused = (await call('POST', url, {}, owner.cookie)).json();
  db.prepare("UPDATE invitations SET used_by=? WHERE role='admin'").run(owner.user.id);
  db.exec('DROP TABLE combined_schema_migrations; ALTER TABLE invitations DROP COLUMN reusable');
  await restart();
  assert.equal((await call('POST', '/api/invitations/inspect', { token: used.token })).statusCode, 400);
  const concurrent = await Promise.all(['legacy-one', 'legacy-two'].map(username => call('POST', '/api/auth/register', { username, password, invitationToken: unused.token })));
  assert.deepEqual(concurrent.map(r => r.statusCode).sort(), [201, 400]);
  assert.equal((await call('POST', '/api/invitations/inspect', { token: unused.token })).statusCode, 400);
  assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 2);
  assert.equal(db.prepare('SELECT count(*) AS n FROM workspaces').get().n, 1);
});

test('existing account invitation does not upgrade membership; admin cannot invite admin or owner', async t => {
  const { call, register, db, advance } = await setup(t, { sessionTtlMs: 86400000 });
  const owner = await register('owner'), guest = await register('guest');
  const url = `/api/workspaces/${owner.workspace.id}/invitations`;
  const invite = (await call('POST', url, { role: 'member' }, owner.cookie)).json();
  const joined = await call('POST', '/api/invitations/accept', { token: invite.token }, guest.cookie);
  assert.equal(joined.statusCode, 200); assert.equal(joined.json().workspace.role, 'member');
  const elevated = (await call('POST', url, { role: 'admin' }, owner.cookie)).json();
  assert.equal((await call('POST', '/api/invitations/accept', { token: elevated.token }, guest.cookie)).json().workspace.role, 'member');
  const anotherGuest = await register('another-guest');
  assert.equal((await call('POST', '/api/invitations/accept', { token: elevated.token }, anotherGuest.cookie)).json().workspace.role, 'admin');
  assert.equal((await call('POST', url, { role: 'owner' }, owner.cookie)).statusCode, 400);
  db.prepare("UPDATE members SET role='admin' WHERE workspace_id=? AND user_id=?").run(owner.workspace.id, guest.user.id);
  assert.equal((await call('POST', url, { role: 'admin' }, guest.cookie)).statusCode, 403);
  const expired = (await call('POST', url, { expiresInHours: 1 }, guest.cookie)).json();
  advance(3600001);
  assert.equal((await call('POST', '/api/invitations/inspect', { token: expired.token })).statusCode, 400);
  const invalidated = (await call('POST', url, {}, guest.cookie)).json();
  db.prepare("UPDATE members SET status='inactive' WHERE workspace_id=? AND user_id=?").run(owner.workspace.id, guest.user.id);
  assert.equal((await call('POST', '/api/invitations/inspect', { token: invalidated.token })).statusCode, 400);
  assert.equal((await call('POST', '/api/invitations/accept', { token: invalidated.token }, owner.cookie)).statusCode, 400);
  const forInactive = (await call('POST', url, {}, owner.cookie)).json();
  assert.equal((await call('POST', '/api/invitations/accept', { token: forInactive.token }, guest.cookie)).statusCode, 403);
  const revoked = (await call('POST', url, {}, owner.cookie)).json();
  db.exec('UPDATE invitations SET revoked=1');
  assert.equal((await call('POST', '/api/invitations/inspect', { token: revoked.token })).statusCode, 400);
  db.prepare("UPDATE members SET status='active',role='admin' WHERE workspace_id=? AND user_id=?").run(owner.workspace.id, guest.user.id);
  const demoted = (await call('POST', url, {}, guest.cookie)).json();
  db.prepare("UPDATE members SET role='member' WHERE workspace_id=? AND user_id=?").run(owner.workspace.id, guest.user.id);
  assert.equal((await call('POST', '/api/invitations/accept', { token: demoted.token }, owner.cookie)).statusCode, 400);
});

test('cross-workspace and actor spoof are denied; employee managers cannot be assigned', async t => {
  const { call, register, db } = await setup(t);
  const alice = await register('alice'), bob = await register('bob');
  const url = `/api/workspaces/${alice.workspace.id}/entities`;
  assert.equal((await call('GET', url, undefined, bob.cookie)).statusCode, 403);
  assert.equal((await call('POST', `/api/workspaces/${alice.workspace.id}/select`, {}, bob.cookie)).statusCode, 403);
  assert.equal((await call('POST', url, { name: 'Spoof', ownWebUse: true, userId: alice.user.id }, bob.cookie)).statusCode, 403);
  assert.equal((await call('POST', url, { name: 'Spoof', ownWebUse: true, createdByMemberId: bob.workspace.memberId }, alice.cookie)).statusCode, 400);
  assert.equal((await call('POST', url, { name: 'Bad owner', ownWebUse: true, ownerMemberId: bob.workspace.memberId }, alice.cookie)).statusCode, 400);
  assert.equal((await call('POST', url, { name: 'Not explicit' }, alice.cookie)).statusCode, 400);
  const created = await call('POST', url, { name: 'Synthetic employee', ownWebUse: true }, alice.cookie);
  assert.equal(created.statusCode, 200, created.body);
  const entity = created.json().entity;
  assert.equal(entity.ownerMemberId, undefined);
  assert.equal(entity.createdByMemberId, alice.workspace.memberId);
  assert.equal(entity.webUseUserId, alice.user.id); assert.equal(entity.ownWebUse, true);
  assert.equal(entity.readiness, 'not_configured'); assert.equal(entity.executionRuntime, 'local-pi');
  assert.equal((await call('GET', url, undefined, alice.cookie)).json().entities.length, 1);
  db.prepare("UPDATE members SET status='inactive' WHERE id=?").run(alice.workspace.memberId);
  assert.equal((await call('GET', url, undefined, alice.cookie)).statusCode, 403);
});

test('mutations require matching Origin and passwords retain whitespace/Unicode', async t => {
  const { app, call, register } = await setup(t);
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'csrf', password } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: 'https://evil.example' }, payload: { username: 'csrf', password } })).statusCode, 403);
  assert.equal((await call('POST', '/api/auth/register', { username: 'short', password: 'Ab!23' })).statusCode, 400);
  const long = ' 合成密码 '.repeat(20);
  await register('unicode', { password: long });
  assert.equal((await call('POST', '/api/auth/login', { username: 'unicode', password: long })).statusCode, 200);
  assert.equal((await call('POST', '/api/auth/login', { username: 'unicode', password: long.trim() })).statusCode, 401);
  assert.equal((await call('GET', '/readyz')).statusCode, 503);
});


test('secure deployment cookie settings and rate limits are enforced', async t => {
  const { call, register } = await setup(t, { origin: 'https://dentity.example', secureCookies: true });
  const alice = await register('alice');
  assert.match(alice.response.headers['set-cookie'], /^__Host-dentity_session=/);
  assert.match(alice.response.headers['set-cookie'], /; Secure/);
  assert.equal((await call('GET', '/api/auth/me', undefined, alice.cookie)).statusCode, 200);
  for (let i = 0; i < 20; i++) {
    assert.equal((await call('POST', '/api/auth/login', { username: 'unknown', password: 'invalid-test-password' })).statusCode, 401);
  }
  const limited = await call('POST', '/api/auth/login', { username: 'unknown', password: 'invalid-test-password' });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().error, 'rate_limited');
});


test('registration uses six Unicode code points while preserving existing password limits and login', async t => {
  const { call, register } = await setup(t);
  for (const secret of ['Ab!23', '😀😃😄😁😆']) {
    assert.equal((await call('POST', '/api/auth/register', { username: 'short-boundary', password: secret })).statusCode, 400);
  }
  for (const [name, secret] of [['six', 'Ab!234'], ['unicode-six', '😀😃😄😁😆😅'], ['maximum', 'Ab'.repeat(512)]]) {
    await register(name, { password: secret });
    assert.equal((await call('POST', '/api/auth/login', { username: name, password: secret })).statusCode, 200);
  }
  for (const secret of ['Ab'.repeat(512) + 'c', '😀'.repeat(512) + 'x']) {
    assert.equal((await call('POST', '/api/auth/register', { username: 'over-limit', password: secret })).statusCode, 400);
  }
  assert.equal((await call('POST', '/api/auth/register', { username: 'common', password: 'aaaaaa' })).json().error, 'common_password');
});

test('new accounts retain the Argon2id format and use independent salts', async t => {
  const { call, register, db } = await setup(t);
  const storedHash = db.prepare('SELECT password_hash FROM credentials WHERE user_id=?');
  const salts = [];
  for (const username of ['same-password-one', 'same-password-two']) {
    const { user } = await register(username);
    const { password_hash: hash } = storedHash.get(user.id);
    assert.match(hash, /^\$argon2id\$v=19\$m=19456,p=1,t=2\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
    salts.push(hash.split('$')[4]);
    assert.equal((await call('POST', '/api/auth/login', { username, password })).statusCode, 200);
  }
  assert.notEqual(salts[0], salts[1]);
});

// Fixed synthetic PHC strings generated by npm argon2 0.45.1 before its removal.
const previousPasswordHashes = [
  { username: 'previous-app-params', password: '原密码-😀-Valid', hash: '$argon2id$v=19$m=19456,p=1,t=2$Zml4ZWQtYXBwLXNhbHQhIQ$k09yL44ShkuQh7nkj3TVNc7eeicErI03M+LLckJ2RDE' },
  { username: 'previous-default-params', password: 'aB!23', hash: '$argon2id$v=19$m=65536,p=4,t=3$Zml4ZWQtb2xkLXNhbHQhIQ$Rj7EBSBgxmKi1skRSdFqOeja2vh9oNJFQMFXDEsrIXk' },
];

test('accounts with existing Argon2id hashes can log in after restart without rewriting credentials', async t => {
  const { call, register, db, restart } = await setup(t);
  const updateHash = db.prepare('UPDATE credentials SET password_hash=? WHERE user_id=?');
  const storedHash = db.prepare('SELECT password_hash FROM credentials WHERE user_id=?');
  const accounts = [];
  for (const fixture of previousPasswordHashes) {
    const { user } = await register(fixture.username);
    updateHash.run(fixture.hash, user.id);
    accounts.push({ ...fixture, userId: user.id });
  }
  await restart();
  for (const { username, password, hash, userId } of accounts) {
    assert.equal((await call('POST', '/api/auth/login', { username, password })).statusCode, 200);
    assert.equal((await call('POST', '/api/auth/login', { username, password: 'synthetic wrong password' })).statusCode, 401);
    assert.equal(storedHash.get(userId).password_hash, hash);
  }
});

test('login rejects malformed or out-of-range Argon2id credentials', async t => {
  const { call, register, db } = await setup(t);
  const [fixture] = previousPasswordHashes;
  const { user } = await register(fixture.username);
  const updateHash = db.prepare('UPDATE credentials SET password_hash=? WHERE user_id=?');
  for (const invalid of [
    fixture.hash.replace('v=19', 'v=16'),
    fixture.hash.replace('m=19456', 'm=65537'),
    fixture.hash.replace('p=1', 'p=5'),
    fixture.hash.replace('t=2', 't=4'),
    fixture.hash.replace('p=1', 'p=1,p=1'),
    fixture.hash.replace('hIQ$', 'hIR$'),
    fixture.hash.slice(0, -1),
  ]) {
    assert.notEqual(invalid, fixture.hash);
    updateHash.run(invalid, user.id);
    const response = await call('POST', '/api/auth/login', { username: fixture.username, password: fixture.password });
    assert.equal(response.statusCode, 401, response.body);
    assert.equal(response.json().error, 'invalid_credentials');
  }
});

test('employee metadata editing preserves manager ACL, bounded input, and description compatibility', async t => {
  const { call, register, db } = await setup(t);
  const owner = await register('owner'), outsider = await register('outsider');
  const invite = async (name, role) => {
    const token = (await call('POST', `/api/workspaces/${owner.workspace.id}/invitations`, { role }, owner.cookie)).json().token;
    return register(name, { invitationToken: token });
  };
  const admin = await invite('admin', 'admin'), member = await invite('member', 'member');
  const base = `/api/workspaces/${owner.workspace.id}/entities`;
  const entity = (await call('POST', base, { name: 'Original', description: 'Original description', ownWebUse: true }, owner.cookie)).json().entity;
  const url = `${base}/${entity.id}`;
  const edited = await call('PATCH', url, { name: ' Updated ', description: '' }, owner.cookie);
  assert.equal(edited.statusCode, 200); assert.equal(edited.json().entity.name, 'Updated'); assert.equal(edited.json().entity.description, '');
  assert.equal((await call('PATCH', url, { description: 'Admin description' }, admin.cookie)).statusCode, 200);
  assert.equal((await call('PATCH', url, { name: 'Forbidden' }, member.cookie)).statusCode, 200);
  assert.equal((await call('PATCH', url, { name: 'Forbidden' }, outsider.cookie)).statusCode, 403);
  assert.equal((await call('PATCH', `/api/workspaces/${outsider.workspace.id}/entities/${entity.id}`, { name: 'Wrong workspace' }, outsider.cookie)).statusCode, 404);
  for (const body of [{}, { name: '' }, { name: 'x'.repeat(121) }, { description: 'x'.repeat(4001) }, { ownerMemberId: member.workspace.memberId }]) {
    assert.equal((await call('PATCH', url, body, owner.cookie)).statusCode, 400);
  }
  assert.equal((await call('PATCH', url, { name: 'x'.repeat(120), description: 'x'.repeat(4000) }, admin.cookie)).statusCode, 200);
  assert.equal((await call('PUT', `${url}/description`, { description: 'Compatible' }, owner.cookie)).json().entity.description, 'Compatible');
  db.prepare('UPDATE entities SET owner_member_id=? WHERE id=?').run(member.workspace.memberId, entity.id);
  assert.equal((await call('PATCH', url, { name: 'Employee owner edit' }, member.cookie)).statusCode, 200);
  db.prepare("UPDATE members SET status='inactive' WHERE id=?").run(member.workspace.memberId);
  assert.equal((await call('PATCH', url, { name: 'No longer authorized' }, member.cookie)).statusCode, 403);
});

test('employee create operation IDs survive retries, isolate actor/workspace, and roll back atomically', async t => {
  const { call, register, db, path, restart } = await setup(t);
  const owner = await register('owner');
  const base = `/api/workspaces/${owner.workspace.id}/entities`;
  const body = { name: 'Synthetic employee', description: 'Wizard retry', ownWebUse: true, operationId: 'wizard-operation' };
  const results = await Promise.all([1, 2].map(() => call('POST', base, body, owner.cookie)));
  assert.deepEqual(results.map(r => r.statusCode), [200, 200]);
  assert.equal(results[0].json().entity.id, results[1].json().entity.id);
  assert.equal(db.prepare('SELECT count(*) AS n FROM entities').get().n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM audit WHERE action='entity.created'").get().n, 1);
  assert.equal((await call('POST', base, { ...body, name: 'Changed' }, owner.cookie)).statusCode, 409);
  assert.equal((await call('POST', base, { ...body, ownWebUse: false }, owner.cookie)).json().error, 'idempotency_conflict');
  assert.equal((await call('POST', base, { ...body, operationId: '' }, owner.cookie)).statusCode, 400);
  // Persisted receipt, not process-local state.
  assert.equal(db.prepare('SELECT entity_id FROM entity_create_operations').get().entity_id, results[0].json().entity.id);
  const reopened = await restart();
  try {
    await reopened.ready();
    const replay = await reopened.inject({ method: 'POST', url: base, payload: body, headers: { origin, cookie: owner.cookie } });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().entity.id, results[0].json().entity.id);
    assert.equal(db.prepare('SELECT count(*) AS n FROM entities').get().n, 1);
  } finally { /* The restarted fixture remains the only live owner. */ }
  const second = (await call('POST', '/api/workspaces', { name: 'Second' }, owner.cookie)).json().workspace;
  const isolated = await call('POST', `/api/workspaces/${second.id}/entities`, body, owner.cookie);
  assert.equal(isolated.statusCode, 200); assert.notEqual(isolated.json().entity.id, results[0].json().entity.id);
  const invite = (await call('POST', `/api/workspaces/${owner.workspace.id}/invitations`, { role: 'admin' }, owner.cookie)).json();
  const admin = await register('admin', { invitationToken: invite.token });
  const otherActor = await call('POST', base, body, admin.cookie);
  assert.equal(otherActor.statusCode, 200); assert.notEqual(otherActor.json().entity.id, results[0].json().entity.id);
  db.exec("CREATE TRIGGER reject_entity_audit BEFORE INSERT ON audit WHEN NEW.action='entity.created' BEGIN SELECT RAISE(ABORT, 'synthetic rollback'); END;");
  const retryBody = { ...body, operationId: 'rollback-operation' };
  assert.equal((await call('POST', base, retryBody, owner.cookie)).statusCode, 500);
  assert.equal(db.prepare('SELECT count(*) AS n FROM entities').get().n, 3);
  assert.equal(db.prepare('SELECT count(*) AS n FROM entity_create_operations').get().n, 3);
  db.exec('DROP TRIGGER reject_entity_audit');
  assert.equal((await call('POST', base, retryBody, owner.cookie)).statusCode, 200);
  db.prepare("UPDATE members SET role='member' WHERE id=?").run(owner.workspace.memberId);
  assert.equal((await call('POST', base, body, owner.cookie)).statusCode, 200);
});

test('workspace roles govern every employee and safe config reads never grant management or use', async t => {
  const {call, register, db} = await setup(t);
  const owner = await register('roles-owner'), outsider = await register('roles-outsider');
  const base = `/api/workspaces/${owner.workspace.id}`;
  const invite = async (name, role) => {
    const token = (await call('POST', `${base}/invitations`, {role}, owner.cookie)).json().token;
    return register(name, {invitationToken: token});
  };
  const admin = await invite('roles-admin','admin'), member = await invite('roles-member','member');
  const entities = [];
  for (const actor of [owner, admin]) {
    const created = await call('POST', `${base}/entities`, {name: `Employee ${actor.workspace.role}`, ownWebUse: false}, actor.cookie);
    assert.equal(created.statusCode,200,created.body); entities.push(created.json().entity);
  }
  const entity = entities[0], url = `${base}/entities/${entity.id}`;
  db.prepare('UPDATE entities SET owner_member_id=?,created_by_member_id=? WHERE id=?').run(member.workspace.memberId,member.workspace.memberId,entity.id);
  // Persisted policy projection is allowlisted, not a spread of raw JSON metadata.
  const departmentRule = {sourceId:'synthetic-source',kind:'department',subjectId:'synthetic-department',includeDescendants:true,conversationKinds:['private','group'],credentialRef:'hidden-directory-credential'};
  db.prepare('INSERT INTO entity_directory_policies(entity_id,workspace_id,revision,allow_json,deny_json) VALUES(?,?,1,?,?)').run(entity.id,owner.workspace.id,JSON.stringify([departmentRule]),'[]');
  // Synthetic model storage proves field redaction without provider calls or live credentials.
  db.prepare(`INSERT INTO model_catalog(id,name,workspace_id,provider,endpoint,model_id,secret_ref,revision,enabled) VALUES(?,?,?,?,?,?,?,?,?)`).run('role-profile','Role model',owner.workspace.id,'openai-compatible','https://private-provider.invalid/v1','synthetic-model','secret-ref-not-public',1,1);
  for (const actor of [owner, admin]) {
    for (const employee of entities) assert.equal((await call('PATCH',`${base}/entities/${employee.id}`,{description:'Managed by workspace'},actor.cookie)).statusCode,200);
    assert.equal((await call('PUT',`${base}/model-default`,{profileId:'role-profile'},actor.cookie)).statusCode,200);
    assert.equal((await call('PUT',`${url}/model-profile`,{profileId:'role-profile'},actor.cookie)).statusCode,200);
    assert.equal((await call('GET',`${base}/model-profiles`,undefined,actor.cookie)).json().profiles[0].endpoint,'https://private-provider.invalid/v1');
  }
  const list = await call('GET',`${base}/entities`,undefined,member.cookie);
  assert.equal(list.statusCode,200); assert.equal(list.json().entities.length,2); assert.equal(list.json().entities[0].ownerMemberId,undefined);
  const config = await call('GET',`${url}/configuration`,undefined,member.cookie);
  assert.equal(config.statusCode,200,config.body); assert.equal(config.json().model.name,'Role model');
  assert.deepEqual(config.json().directoryAccess.allow,[{sourceId:'synthetic-source',kind:'department',subjectId:'synthetic-department',includeDescendants:true,conversationKinds:['private','group']}]);
  assert.equal(config.json().entity.description,'Managed by workspace');
  const catalog = await call('GET',`${base}/model-profiles`,undefined,member.cookie);
  assert.equal(catalog.statusCode,200); assert.equal(catalog.json().profiles[0].modelId,'synthetic-model');
  for (const response of [config]) for (const forbidden of ['secretRef','endpoint','secret-ref-not-public','private-provider','ciphertext','serverRef','apiKey','credentialRef','hidden-directory-credential']) assert.ok(!response.body.includes(forbidden),forbidden);
  for (const suffix of ['model-profile','effective-model-profile','web-access','configuration-members','resource-catalog','capability-packages','directory-access']) assert.equal((await call('GET',`${url}/${suffix}`,undefined,member.cookie)).statusCode,200,suffix);
  assert.equal((await call('PATCH',url,{name:'Member edit'},member.cookie)).statusCode,200);
  assert.equal((await call('POST',`${base}/invitations`,{},member.cookie)).statusCode,403);
  assert.equal((await call('GET',`${url}/configuration`,undefined,outsider.cookie)).statusCode,403);
  assert.equal((await call('GET',`/api/workspaces/${outsider.workspace.id}/entities/${entity.id}/configuration`,undefined,outsider.cookie)).statusCode,404);
  // A read-only member still needs explicit use permission. Even managers do not bypass this.
  for (const actor of [member,owner,admin]) assert.equal((await call('POST',`${url}/conversations`,{mode:'real'},actor.cookie)).statusCode,403);
  assert.equal((await call('PUT',`${url}/web-access`,{allowMemberIds:[member.workspace.memberId],denyMemberIds:[]},admin.cookie)).statusCode,200);
  const retired = await call('POST',`${url}/conversations`,{mode:'demo'},member.cookie);
  assert.equal(retired.statusCode,400,retired.body);assert.equal(retired.json().error,'invalid_conversation_mode');
  // Use permission does not bypass the missing credential encryption configuration.
  const conversation = await call('POST',`${url}/conversations`,{mode:'real'},member.cookie);
  assert.equal(conversation.statusCode,503,conversation.body);assert.equal(conversation.json().error,'model_secret_store_unconfigured');
  assert.equal((await call('GET',`${url}/conversations`,undefined,member.cookie)).statusCode,200);
  assert.equal((await call('PATCH',url,{name:'Still editable'},member.cookie)).statusCode,200);
  assert.equal((await call('PUT',`${url}/web-access`,{allowMemberIds:[],denyMemberIds:[]},owner.cookie)).statusCode,200);
  assert.equal((await call('GET',`${url}/conversations`,undefined,member.cookie)).statusCode,403);
  db.prepare("UPDATE members SET status='inactive' WHERE id=?").run(member.workspace.memberId);
  assert.equal((await call('GET',`${url}/configuration`,undefined,member.cookie)).statusCode,403);
});

test('employee execution thinking has four persistent levels, defaults medium and enforces management scope',async t=>{
 const {call,register,db,path,restart}=await setup(t),owner=await register('thinking-owner');
 const base=`/api/workspaces/${owner.workspace.id}/entities`;
 const created=await call('POST',base,{name:'Thinking employee',ownWebUse:true,operationId:'thinking-default'},owner.cookie);assert.equal(created.statusCode,200,created.body);
 const entity=created.json().entity,url=`${base}/${entity.id}`;assert.equal(entity.executionThinkingLevel,'medium');
 for(const level of ['none','low','medium','high']){
  const changed=await call('PATCH',url,{executionThinkingLevel:level},owner.cookie);assert.equal(changed.statusCode,200,changed.body);assert.equal(changed.json().entity.executionThinkingLevel,level);
  assert.equal(db.prepare('SELECT execution_thinking_level AS level FROM entities WHERE id=?').get(entity.id).level,level);
  assert.equal((await call('GET',url+'/configuration',undefined,owner.cookie)).json().entity.executionThinkingLevel,level);
 }
 const reopened=await restart();
 try {const r=await reopened.inject({url:base,headers:{origin,cookie:owner.cookie}});assert.equal(r.json().entities[0].executionThinkingLevel,'high');}finally{/* Fixture cleanup closes the active replacement. */}
 for(const executionThinkingLevel of ['off','minimal','max','invalid',null,0,true,{}]){
  assert.equal((await call('PATCH',url,{executionThinkingLevel},owner.cookie)).statusCode,400);
  assert.equal((await call('POST',base,{name:'Invalid',ownWebUse:false,executionThinkingLevel},owner.cookie)).statusCode,400);
 }
 const invitation=(await call('POST',`/api/workspaces/${owner.workspace.id}/invitations`,{role:'member'},owner.cookie)).json();
 const member=await register('thinking-member',{invitationToken:invitation.token}),other=await register('thinking-outsider');
 assert.equal((await call('PATCH',url,{executionThinkingLevel:'none'},member.cookie)).statusCode,200);
 assert.equal((await call('GET',url+'/configuration',undefined,member.cookie)).json().entity.executionThinkingLevel,'none');
 assert.equal((await call('PATCH',url,{executionThinkingLevel:'none'},other.cookie)).statusCode,403);
 assert.equal((await call('PATCH',`/api/workspaces/${other.workspace.id}/entities/${entity.id}`,{executionThinkingLevel:'none'},other.cookie)).statusCode,404);
 assert.equal(db.prepare('SELECT execution_thinking_level AS level FROM entities WHERE id=?').get(entity.id).level,'none');
});


test('existing employee schema gains medium without rewriting existing employee fields',async t=>{
 const {register,call,db,path}=await setup(t),owner=await register('legacy-thinking-owner'),base=`/api/workspaces/${owner.workspace.id}/entities`;
 const created=(await call('POST',base,{name:'Legacy employee',description:'Retained',ownWebUse:false},owner.cookie)).json().entity;
 db.exec('DROP TABLE combined_schema_migrations; ALTER TABLE entities DROP COLUMN execution_thinking_level');const before=db.prepare('SELECT * FROM entities WHERE id=?').get(created.id);
 const {Store}=await import('../dist/store.js');const migrated=new Store(path);
 try{const after=migrated.one('SELECT * FROM entities WHERE id=?',created.id);assert.equal(after.execution_thinking_level,'medium');delete after.execution_thinking_level;assert.deepEqual({...after},{...before});}finally{migrated.close();}
});
