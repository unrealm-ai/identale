import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/store.js';
import { ModelProfileService } from '../dist/model-profiles.js';
import { SkillResources } from '../dist/skill-resources.js';
import { McpResources } from '../dist/mcp-resources.js';
import { EmployeeChannelRepository } from '../dist/employee-channels/repository.js';
import { TriggerStore } from '../dist/triggers/store.js';
import { DirectoryCredentialVault } from '../dist/directory/secrets.js';
import { ConfigurationPoller, registerConfigurationApi, deriveRuntimeConfigurationKey } from '../dist/split/config-sync.js';
const token = 'synthetic-configuration-service-token', key = Buffer.alloc(32, 31);
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'identity-config-sync-'));
  const platform = new Store(join(root, 'platform.sqlite'));
  const runtime = new Store(join(root, 'runtime.sqlite'), { role: 'runtime' });
  t.after(() => { platform.close(); runtime.close(); rmSync(root, { recursive: true, force: true }); });
  platform.run("INSERT INTO users(id,username,display_name) VALUES('u','user','User')");
  platform.run("INSERT INTO credentials VALUES('u','PASSWORD_HASH_NOT_FOR_RUNTIME')");
  platform.run("INSERT INTO workspaces(id,name,created_by) VALUES('w','Workspace','u')");
  platform.run("INSERT INTO members(id,workspace_id,user_id,role) VALUES('m','w','u','owner')");
  platform.run("INSERT INTO entities(id,workspace_id,name,owner_member_id,created_by_member_id,own_web_use,web_use_user_id,interaction_runtime) VALUES('e','w','Employee','m','m',1,'u','builtin')");
  const profiles = new ModelProfileService(platform, { masterKey: key });
  const profile = profiles.save('w', 'e', { provider: 'openai-compatible', endpoint: 'https://provider.example/v1', modelId: 'fixture', apiKey: 'MODEL_KEY_NOT_IN_SNAPSHOT' });
  const skills = new SkillResources(platform, join(root, 'skills'));
  const skill = skills.upload('w', { filename: 'guide.md', content: '---\nname: guide\ndescription: Authorized guide\n---\n# Guide\nOnly authorized work.', operationId: 'upload' });
  const mcp = new McpResources(platform, { masterKey: key, allowedOrigins: ['https://mcp.example'] });
  const vault = new DirectoryCredentialVault(key);
  const mcpRecord = { id: 'mc', workspaceId: 'w', name: 'MCP', endpoint: 'https://mcp.example/tool', version: 1, tools: [], auth: { kind: 'bearer', header: 'authorization' }, credential: vault.seal('MCP_SECRET_NOT_IN_SNAPSHOT', ['workspace-mcp', 'w', 'mc', 1]) };
  platform.run('INSERT INTO workspace_mcp_versions VALUES(?,?,?,?)', 'w', 'mc', 1, JSON.stringify(mcpRecord));
  platform.run('INSERT INTO workspace_mcp_state VALUES(?,?,?,?)', 'w', 'mc', 1, 1);
  const channels = new EmployeeChannelRepository(platform);
  const record = { id: 'ch', sourceId: 'source', workspaceId: 'w', entityId: 'e', provider: 'feishu', appId: 'app', revision: 1, authRevision: 1, stateVersion: 0, status: 'verified', enabled: true, identity: { tenantId: 'tenant', tenantIdNamespace: 'tenant_key' }, credential: vault.seal(JSON.stringify({ appSecret: 'CHANNEL_SECRET_NOT_IN_SNAPSHOT' }), ['w', 'e', 'ch', 'app', 1]) };
  assert.equal(channels.save(record, undefined), true);
  const triggers = new TriggerStore(platform, key);
  const trigger = triggers.save({ workspaceId: 'w', entityId: 'e', type: 'webhook', name: 'Hook', enabled: true, allowedActions: ['create_task'], config: { adapter: 'generic' } });
  triggers.addCredential('w', trigger.id, 'key', 'TRIGGER_SECRET_NOT_IN_SNAPSHOT_1234567890');
  let now = 1000;
  const app = Fastify(); t.after(() => app.close());
  const approvedResources = [];
  registerConfigurationApi(app, { store: platform, profiles, skills, mcp, token, masterKey: key, now: () => now, approvedResources });
  const fetch = async (input, init = {}) => {
    const response = await app.inject({ method: init.method ?? 'GET', url: new URL(input).pathname, headers: Object.fromEntries(new Headers(init.headers)), ...(init.body ? { payload: init.body } : {}) });
    return new Response(response.statusCode === 304 ? null : response.body, { status: response.statusCode, headers: response.headers });
  };
  return { root, platform, runtime, app, fetch, profiles, profile, skill, channels, record, triggers, trigger, approvedResources, now: value => { now = value; }, clock: () => now };
}
const auth = { authorization: 'Bearer ' + token };
test('snapshot separates account/model/MCP credentials, rewraps channel/trigger secrets and has stable module ETags', async t => {
  const f = await fixture(t), first = await f.app.inject({ url: '/internal/config/snapshot', headers: auth });
  assert.equal(first.statusCode, 200, first.body); const snapshot = first.json();
  const names = snapshot.tables.map(t => t.name);
  for (const name of ['credentials', 'sessions', 'invitations', 'audit', 'tasks', 'runs']) assert.equal(names.includes(name), false);
  for (const forbidden of ['PASSWORD_HASH_NOT_FOR_RUNTIME', 'MODEL_KEY_NOT_IN_SNAPSHOT', 'MCP_SECRET_NOT_IN_SNAPSHOT', 'CHANNEL_SECRET_NOT_IN_SNAPSHOT', 'TRIGGER_SECRET_NOT_IN_SNAPSHOT']) assert.equal(first.body.includes(forbidden), false);
  assert.equal(snapshot.tables.find(t => t.name === 'model_catalog').rows[0].ciphertext, null);
  assert.equal(first.body.includes(f.platform.one('SELECT ciphertext FROM model_catalog').ciphertext), false);
  assert.equal(first.body.includes(f.channels.byId('ch').credential.ciphertext), false);
  // Snapshot transport returns a file reference; it does not load Skill bytes.
  rmSync(f.platform.one('SELECT path FROM skill_resource_versions').path);
  assert.equal((await f.app.inject({ url: '/internal/config/snapshot', headers: auth })).statusCode, 200);
  assert.equal(JSON.parse(snapshot.tables.find(t => t.name === 'workspace_mcp_versions').rows[0].record_json).credential, null);
  assert.equal(JSON.parse(snapshot.tables.find(t => t.name === 'employee_channel_connections').rows[0].record_json).credential, null);
  const restricted = new DirectoryCredentialVault(deriveRuntimeConfigurationKey(token));
  const channel = JSON.parse(snapshot.privateCredentials.tables.find(t => t.name === 'employee_channel_connections').rows[0].record_json);
  assert.match(restricted.open(channel.credential, ['w', 'e', 'ch', 'app', 1]), /CHANNEL_SECRET/);
  assert.throws(() => new DirectoryCredentialVault(key).open(channel.credential, ['w', 'e', 'ch', 'app', 1]));
  const trigger = snapshot.privateCredentials.tables.find(t => t.name === 'trigger_credentials').rows[0];
  assert.match(restricted.open(trigger, ['trigger-hmac-v1', 'w', f.trigger.id, 'key', 1]), /TRIGGER_SECRET/);
  assert.equal((await f.app.inject({ url: '/internal/config/snapshot', headers: { ...auth, 'if-none-match': first.headers.etag } })).statusCode, 304);
  assert.equal((await f.app.inject('/internal/config/snapshot')).statusCode, 401);
  f.platform.run("UPDATE entities SET name='Updated' WHERE id='e'");
  const next = (await f.app.inject({ url: '/internal/config/snapshot', headers: auth })).json();
  assert.notEqual(next.moduleRevisions.identity, snapshot.moduleRevisions.identity);
  assert.equal(next.moduleRevisions.models, snapshot.moduleRevisions.models);
});
test('coherent RAM apply, conditional revalidation and stale failures do not put platform configuration on runtime disk', async t => {
  const f = await fixture(t), changes = [];
  const poller = new ConfigurationPoller({ store: f.runtime, baseUrl: 'http://127.0.0.1:9999', token, fetch: f.fetch, now: f.clock, maxAgeMs: 100, onApplied: change => changes.push(change) });
  assert.equal(poller.ready, false); assert.throws(() => poller.assertReady(), /not_ready/);
  assert.equal(await poller.poll(), true, JSON.stringify(poller.status));
  assert.equal(poller.ready, true); assert.equal(f.runtime.one("SELECT name FROM entities WHERE id='e'").name, 'Employee');
  assert.equal(f.runtime.one("SELECT name FROM main.sqlite_master WHERE name='entities'"), undefined);
  assert.equal(readFileSync(join(f.root, 'runtime.sqlite')).includes(Buffer.from('CHANNEL_SECRET')), false);
  assert.equal(changes.length, 1);
  f.now(1050); assert.equal(await poller.poll(), false); assert.equal(poller.status.lastValidatedAt, 1050);
  assert.equal(changes.length, 1);
  f.platform.run("UPDATE entities SET name='Updated' WHERE id='e'");
  assert.equal(await poller.poll(), true); assert.deepEqual(changes[1].changedModules, ['identity']);
  const revision = poller.status.epoch;
  f.now(1150); assert.equal(poller.ready, false); assert.throws(() => poller.assertReady(), /stale/);
  // A successful unchanged fetch revalidates the same coherent snapshot.
  assert.equal(await poller.poll(), false); assert.equal(poller.ready, true); assert.equal(poller.status.epoch, revision);
  poller.stop();
});
test('model, Skill and MCP resources use separate authenticated requests and validate purpose/version selectors', async t => {
  const f = await fixture(t), poller = new ConfigurationPoller({ store: f.runtime, baseUrl: 'http://127.0.0.1:9999', token, fetch: f.fetch, now: f.clock });
  await poller.poll();
  const model = await poller.request('model', { workspaceId: 'w', entityId: 'e', profileId: f.profile.id, configRevision: f.profile.configRevision, purpose: 'model-inference' });
  assert.equal(model.apiKey, 'MODEL_KEY_NOT_IN_SNAPSHOT');
  await assert.rejects(poller.request('model', { workspaceId: 'w', entityId: 'e', profileId: f.profile.id, configRevision: 999, purpose: 'model-inference' }), /unavailable/);
  await assert.rejects(poller.request('model', { workspaceId: 'w', entityId: 'e', profileId: f.profile.id, configRevision: 1, purpose: 'export' }), /unavailable/);
  const skill = await poller.request('skill', { workspaceId: 'w', ref: { resourceId: f.skill.resource.resourceId, version: String(f.skill.version) } });
  assert.match(skill.content, /Only authorized work/);
  const mcp = await poller.request('mcp', { workspaceId: 'w', resourceId: 'mc', version: '1' });
  assert.equal(mcp.headers.authorization, 'Bearer MCP_SECRET_NOT_IN_SNAPSHOT');
  await assert.rejects(poller.request('mcp', { workspaceId: 'other', resourceId: 'mc', version: '1' }), /unavailable/);
  poller.stop();
});
test('malformed snapshots preserve last valid state, reject SQL injection and fail stale new admission', async t => {
  const f = await fixture(t); let mode = 'valid';
  const fetch = async (...args) => {
    const response = await f.fetch(...args);
    if (mode === 'failure') throw Error('sensitive provider error not returned');
    if (mode === 'valid') return response;
    const snapshot = (await f.app.inject({ url: '/internal/config/snapshot', headers: auth })).json();
    if (mode === 'injection') snapshot.tables[0].sql += '; DELETE FROM tasks';
    if (mode === 'secret') snapshot.tables.find(t => t.name === 'model_catalog').rows[0].ciphertext = 'FORBIDDEN_PLATFORM_CIPHERTEXT';
    if (mode === 'forbidden') snapshot.tables.push({ name: 'credentials', sql: 'CREATE TABLE credentials(secret TEXT)', rows: [{ secret: 'bad' }] });
    return new Response(JSON.stringify(snapshot), { headers: { etag: '"' + snapshot.epoch + '"' } });
  };
  const poller = new ConfigurationPoller({ store: f.runtime, baseUrl: 'http://127.0.0.1:9999', token, fetch, now: f.clock, maxAgeMs: 100 });
  assert.equal(await poller.poll(), true);
  for (mode of ['injection', 'forbidden', 'secret', 'failure']) { assert.equal(await poller.poll(), false); assert.equal(f.runtime.one("SELECT name FROM entities WHERE id='e'").name, 'Employee'); }
  f.now(1100); assert.equal(poller.ready, false); assert.throws(() => poller.assertReady(), /stale/);
  assert.equal(poller.status.error, 'configuration_unavailable'); poller.stop();
});
test('empty initial configuration becomes ready, concurrent polls dedupe and stop prevents late apply', async t => {
  const f = await fixture(t), source = new Store(join(f.root, 'empty.sqlite')); t.after(() => source.close());
  const app = Fastify(); t.after(() => app.close());
  registerConfigurationApi(app, { store: source, profiles: f.profiles, skills: {}, mcp: {}, token });
  const snapshotResponse = await app.inject({ url: '/internal/config/snapshot', headers: auth });
  let release; let calls = 0;
  const fetch = async () => { calls++; await new Promise(r => { release = r; }); return new Response(snapshotResponse.body, { headers: { etag: snapshotResponse.headers.etag } }); };
  const poller = new ConfigurationPoller({ store: f.runtime, baseUrl: 'http://127.0.0.1:9999', token, fetch });
  const a = poller.poll(), b = poller.poll(); assert.equal(a, b); assert.equal(calls, 1);
  poller.stop(); release(); assert.equal(await a, false); assert.equal(poller.ready, false);
  const second = poller.poll(); release(); assert.equal(await second, true); assert.equal(poller.ready, true); assert.equal(f.runtime.all('SELECT * FROM entities').length, 0); poller.stop();
  assert.throws(() => new ConfigurationPoller({ store: f.runtime, baseUrl: 'http://untrusted.example', token }), /invalid/);
});

test('one unusable connection credential remains unavailable without blocking other configuration', async t => {
  const f = await fixture(t);
  const record = f.channels.byId('ch'); record.credential.tag = 'invalid';
  f.platform.run('UPDATE employee_channel_connections SET record_json=? WHERE id=?', JSON.stringify(record), 'ch');
  const response = await f.app.inject({ url: '/internal/config/snapshot', headers: auth });
  assert.equal(response.statusCode, 200, response.body);
  const restricted = JSON.parse(response.json().privateCredentials.tables.find(t => t.name === 'employee_channel_connections').rows[0].record_json);
  assert.throws(() => new DirectoryCredentialVault(deriveRuntimeConfigurationKey(token)).open(restricted.credential, ['w', 'e', 'ch', 'app', 1]));
  assert.equal(response.json().tables.find(t => t.name === 'entities').rows.length, 1);
});

test('deployment-approved resources travel as safe metadata and participate in resource module revisions', async t => {
  const f = await fixture(t);
  const read = async () => (await f.app.inject({ url: '/internal/config/snapshot', headers: auth })).json();
  const before = await read(); assert.deepEqual(before.approvedResources, []);
  const resource = { id: 'static-skill', kind: 'skill', resourceId: 'guide', version: '1', digest: 'a'.repeat(64), workspaceIds: ['w'] };
  f.approvedResources.push(resource);
  const after = await read(); assert.deepEqual(after.approvedResources, [resource]);
  assert.notEqual(before.moduleRevisions.resources, after.moduleRevisions.resources);
  for (const module of ['identity', 'models', 'permissions', 'channels', 'directory', 'triggers']) assert.equal(before.moduleRevisions[module], after.moduleRevisions[module]);
  f.approvedResources.push({ ...resource, id: 'bad', apiKey: 'MUST_NOT_EXPORT' });
  const invalid = await f.app.inject({ url: '/internal/config/snapshot', headers: auth });
  assert.equal(invalid.statusCode, 503); assert.equal(invalid.body.includes('MUST_NOT_EXPORT'), false);
});
