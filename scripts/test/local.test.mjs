// Modified for Identale; see the root NOTICE.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { initializeSecrets, readSecrets, secretPath, validateMasterKey, repositoryRoot } from '../shared/local-secrets.mjs';
import { childEnvironments, supervise, reservePorts, parseArgs, dependenciesInstalled } from '../local/local-start.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'dentity-local-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const env = { HOME: dir, XDG_CONFIG_HOME: path.join(dir, 'config') };
  return { dir, env };
}
const syntheticKey = Buffer.alloc(32, 7).toString('base64');

test('first init is private, explicit, stable, and reused without overwriting', async t => {
  const { env } = await fixture(t);
  await assert.rejects(initializeSecrets({ env }), /confirmation/);
  assert.equal(await readSecrets({ env }), undefined);
  const first = await initializeSecrets({ env, confirmed: true });
  assert.equal(first.created, true);
  const contents = await fs.readFile(first.path, 'utf8');
  assert.equal((await fs.stat(first.path)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(first.path))).mode & 0o777, 0o700);
  const secrets = await readSecrets({ env });
  validateMasterKey(secrets.modelMasterKey);
  assert.notEqual(secrets.runtimeHostToken, secrets.platformResolverToken);
  assert.equal((await initializeSecrets({ env, confirmed: true })).created, false);
  assert.equal(await fs.readFile(first.path, 'utf8'), contents);
});

test('corrupt and insecure files fail closed and are not overwritten', async t => {
  const { env } = await fixture(t);
  const { path: target } = await initializeSecrets({ env, confirmed: true });
  await fs.writeFile(target, 'invalid');
  await assert.rejects(initializeSecrets({ env, confirmed: true }), /invalid/);
  assert.equal(await fs.readFile(target, 'utf8'), 'invalid');
  await fs.chmod(target, 0o644);
  await assert.rejects(readSecrets({ env }), /600/);
  await fs.chmod(target, 0o600);
  await fs.chmod(path.dirname(target), 0o755);
  await assert.rejects(readSecrets({ env }), /700/);
});

test('symlink, hardlink, repository and relative paths rejected; platform-independent default', async t => {
  const { env, dir } = await fixture(t);
  const { path: target } = await initializeSecrets({ env, confirmed: true });
  const alias = path.join(dir, 'alias');
  await fs.symlink(target, alias);
  await assert.rejects(readSecrets({ env: { ...env, DENTITY_LOCAL_SECRETS_PATH: alias } }), /Symlinks/);
  const hard = path.join(path.dirname(target), 'hard');
  await fs.link(target, hard);
  await assert.rejects(readSecrets({ env }), /non-linked/);
  await assert.rejects(readSecrets({ env: { ...env, DENTITY_LOCAL_SECRETS_PATH: path.join(repositoryRoot, 'credentials.json') } }), /outside/);
  assert.throws(() => secretPath({ ...env, DENTITY_LOCAL_SECRETS_PATH: 'relative.json' }), /absolute/);
  assert.equal(secretPath({ HOME: dir }), path.join(dir, '.identale/local-secrets.json'));
  await assert.rejects(initializeSecrets({ env, confirmed: true, platform: 'win32' }), /ACL/);
});

test('missing file is demo; environment secrets never enter Web, builds or unrelated Host', async t => {
  const { env } = await fixture(t);
  const inputs = { ...env, OPENAI_API_KEY: 'synthetic', ANTHROPIC_API_KEY: 'synthetic', VITE_SECRET: 'synthetic', NODE_OPTIONS: 'synthetic', DENTITY_MODEL_MASTER_KEY: syntheticKey };
  const result = await childEnvironments(inputs);
  assert.equal(result.platform.DENTITY_MODEL_MASTER_KEY, syntheticKey);
  for (const scope of ['runtime', 'web', 'build', 'host', 'mockModel', 'mockMcp']) assert.equal(result[scope].DENTITY_MODEL_MASTER_KEY, undefined);
  for (const scope of Object.values(result)) for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VITE_SECRET', 'NODE_OPTIONS']) assert.equal(scope[key], undefined);
  const demo = await childEnvironments(env);
  assert.equal(demo.platform.DENTITY_MODEL_MASTER_KEY, undefined);
  assert.equal(demo.host.DENTITY_RUNTIME_HOST_TOKEN, undefined);
  assert.equal(await readSecrets({ env }), undefined);
});

test('stored key is stable, env override wins, model allowlist is absent, tokens are distinct', async t => {
  const { env } = await fixture(t);
  await initializeSecrets({ env, confirmed: true });
  const stored = await readSecrets({ env });
  const result = await childEnvironments(env);
  assert.equal(result.platform.DENTITY_MODEL_MASTER_KEY, stored.modelMasterKey);
  assert.equal(result.platform.DENTITY_MODEL_ALLOWED_ORIGINS, undefined);
  assert.equal(result.platform.DENTITY_MODEL_ALLOW_LOOPBACK_HTTP, 'false');
  assert.equal(result.host.DENTITY_MODEL_MASTER_KEY, undefined);
  assert.equal(result.host.DENTITY_RUNTIME_HOST_TOKEN, stored.runtimeHostToken);
  assert.equal((await childEnvironments({ ...env, DENTITY_MODEL_MASTER_KEY: syntheticKey })).platform.DENTITY_MODEL_MASTER_KEY, syntheticKey);
  await assert.rejects(childEnvironments({ ...env, DENTITY_MODEL_MASTER_KEY: 'bad' }), /canonical/);
  await assert.rejects(childEnvironments({ ...env, DENTITY_RUNTIME_HOST_TOKEN: 'same', DENTITY_PLATFORM_RESOLVER_TOKEN: 'same' }), /distinct/);
  assert.equal((await childEnvironments({ ...env, DENTITY_CONTROL_PLANE_PORT: '4000' })).platform.DENTITY_CONTROL_PLANE_PORT, '4000');
});

test('init CLI does not create credentials without explicit confirmation', async t => {
  const { env } = await fixture(t);
  const result = spawnSync(process.execPath, ['scripts/local/local-init.mjs'], { cwd: repositoryRoot, env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /interactively/);
  assert.equal(await readSecrets({ env }), undefined);
  assert.throws(() => parseArgs(['--unknown']), /Usage/);
  assert.deepEqual(parseArgs(['--no-build', '--no-install']), { build: false, install: false, mock: false });
});

async function freePorts(count) {
  const servers = [];
  for (let i = 0; i < count; i++) { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server); }
  const ports = servers.map(server => server.address().port);
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  return ports;
}
const serverCode = `const net=require('node:net'); const s=net.createServer(); s.listen(Number(process.argv[1]), '127.0.0.1'); process.on('SIGTERM',()=>s.close());`;
function commands(ports, env = {}) { return ports.map((port, index) => ({ name: `fixture-${index}`, port, file: process.execPath, args: ['-e', serverCode, String(port)], env })); }

test('three synthetic servers start and SIGINT/SIGTERM/SIGHUP release their ports only', async t => {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const ports = await freePorts(3);
    const source = new EventEmitter();
    const running = await supervise({ commands: commands(ports), cwd: repositoryRoot, signalSource: source, log() {}, killAfterMs: 500 });
    t.after(() => running.stop());
    source.emit(signal);
    assert.equal(await running.completion, ({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 })[signal]);
    const reserved = await reservePorts(ports);
    await Promise.all(reserved.map(server => new Promise(resolve => server.close(resolve))));
    assert.equal(source.listenerCount(signal), 0);
  }
});

test('reservation closes incoming browser connections so releasing its port cannot hang', async () => {
  const [port] = await freePorts(1), [reservation] = await reservePorts([port]);
  let acceptedSocket;
  const accepted = new Promise(resolve => reservation.once('connection', socket => { acceptedSocket = socket; resolve(); }));
  const client = net.connect({ host: '127.0.0.1', port });
  client.on('error', () => {});
  const disconnected = new Promise(resolve => client.once('close', resolve));
  let timer;
  try {
    await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('error', reject); });
    client.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n');
    await accepted;
    const released = new Promise(resolve => reservation.close(resolve));
    await Promise.race([Promise.all([released, disconnected]), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Reservation retained a browser connection')), 1000); })]);
  } finally { clearTimeout(timer); client.destroy(); acceptedSocket?.destroy(); reservation.close(() => {}); }
});

test('SIGHUP during port reservation stops once before any service starts and releases every port', async t => {
  const { dir } = await fixture(t), ports = await freePorts(3), source = new EventEmitter();
  const pending = supervise({ commands: commands(ports), cwd: dir, signalSource: source, log() {}, killAfterMs: 500 });
  source.emit('SIGHUP'); source.emit('SIGHUP');
  const running = await pending;
  t.after(() => running.stop());
  assert.equal(await running.completion, 129); assert.equal(running.started, false); assert.equal(running.cleanupConfirmed, true);
  const held = await reservePorts(ports); await Promise.all(held.map(server => new Promise(resolve => server.close(resolve))));
  assert.equal(source.listenerCount('SIGHUP'), 0);
});

test('port collision identifies the service, releases earlier reservations and starts no command', async t => {
  const { dir } = await fixture(t);
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const occupiedPort = server.address().port;
  const [freePort] = await freePorts(1);
  const list = commands([freePort, occupiedPort]);
  const started = path.join(dir, 'command-started');
  const mark = { name: 'preparation', file: process.execPath, args: ['-e', "require('node:fs').writeFileSync(process.argv[1], 'started')", started], env: {} };
  for (const command of list) command.args = mark.args;
  try {
    await assert.rejects(supervise({ commands: list, prepare: [mark], cwd: dir, log() {} }), error => {
      assert.match(error.message, new RegExp(`127\\.0\\.0\\.1:${occupiedPort} for fixture-1.*unavailable \\(EADDRINUSE\\)`));
      assert.equal(error.code, 'EADDRINUSE');
      assert.equal(error.cause.code, 'EADDRINUSE');
      assert.equal(error.port, occupiedPort);
      return true;
    });
    assert.equal(server.listening, true);
    await assert.rejects(fs.access(started), { code: 'ENOENT' });
    const held = await reservePorts([freePort]);
    await Promise.all(held.map(reservation => new Promise(resolve => reservation.close(resolve))));
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('partial startup failure cleans up the first server and reservations', async t => {
  const ports = await freePorts(3);
  const list = commands(ports);
  list[1].args = ['-e', 'process.exit(7)'];
  const running = await supervise({ commands: list, cwd: repositoryRoot, signalSource: new EventEmitter(), log() {}, killAfterMs: 500 });
  t.after(() => running.stop());
  assert.equal(await running.completion, 1);
  const reserved = await reservePorts(ports);
  await Promise.all(reserved.map(server => new Promise(resolve => server.close(resolve))));
});

test('missing or mismatched locked dependencies detected without installing', async t => {
  const { dir } = await fixture(t);
  assert.equal(await dependenciesInstalled(dir), false);
  await fs.mkdir(path.join(dir, 'node_modules/example'), { recursive: true });
  await fs.writeFile(path.join(dir, 'node_modules/.package-lock.json'), '{}');
  await fs.writeFile(path.join(dir, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/example': { version: '1.0.0' } } }));
  await fs.writeFile(path.join(dir, 'node_modules/example/package.json'), JSON.stringify({ version: '1.0.0' }));
  assert.equal(await dependenciesInstalled(dir), true);
  await fs.writeFile(path.join(dir, 'node_modules/example/package.json'), JSON.stringify({ version: 'v1.0.0' }));
  assert.equal(await dependenciesInstalled(dir), true);
  await fs.writeFile(path.join(dir, 'node_modules/example/package.json'), JSON.stringify({ version: '2.0.0' }));
  assert.equal(await dependenciesInstalled(dir), false);
});

test('builtin record root reaches only the runtime child', async t => {
  const { env, dir } = await fixture(t);
  const root = path.join(dir, 'private-builtin-records');
  const environments = await childEnvironments({ ...env, DENTITY_BUILTIN_RECORD_ROOT: root });
  assert.equal(environments.runtime.DENTITY_BUILTIN_RECORD_ROOT, root);
  for (const scope of ['platform', 'host', 'web', 'build']) assert.equal(environments[scope].DENTITY_BUILTIN_RECORD_ROOT, undefined);
  assert.equal((await childEnvironments(env)).runtime.DENTITY_BUILTIN_RECORD_ROOT, undefined);
});

test('maintenance configuration is forwarded only to the runtime service', async t => {
  const { env } = await fixture(t);
  const settings = { DENTITY_MAINTENANCE_ENABLED: 'false', DENTITY_MAINTENANCE_INTERVAL_MS: '2000', DENTITY_CONTEXT_RETAIN_MESSAGES: '100', DENTITY_CONTEXT_TOKEN_THRESHOLD: '12000', DENTITY_SUMMARY_TIMEZONE: 'Asia/Shanghai', DENTITY_SUMMARY_RECENT_DAYS: '30' };
  const children = await childEnvironments({ ...env, ...settings });
  for (const [key, value] of Object.entries(settings)) { assert.equal(children.runtime[key], value); assert.equal(children.platform[key], undefined); assert.equal(children.host[key], undefined); }
});


test('local services do not inject resource catalogs or write business configuration; explicit settings survive', async t => {
 const {env,dir}=await fixture(t), children=await childEnvironments(env);
 assert.equal(children.platform.DENTITY_APPROVED_RESOURCES_JSON,undefined);assert.equal(children.host.DENTITY_RUNTIME_HOST_RESOURCE_REGISTRY,undefined);
 assert.deepEqual(await fs.readdir(dir),[]);assert.equal(children.mockMcp.DENTITY_MOCK_MCP_PORT,'18303');
 const custom={DENTITY_APPROVED_RESOURCES_JSON:'[]',DENTITY_RUNTIME_HOST_RESOURCE_REGISTRY:'/explicit/user/registry.json'};
 const configured=await childEnvironments({...env,...custom});assert.equal(configured.platform.DENTITY_APPROVED_RESOURCES_JSON,custom.DENTITY_APPROVED_RESOURCES_JSON);assert.equal(configured.host.DENTITY_RUNTIME_HOST_RESOURCE_REGISTRY,custom.DENTITY_RUNTIME_HOST_RESOURCE_REGISTRY);
 for(const scope of ['mockModel','mockMcp','web','build'])for(const key of ['DENTITY_APPROVED_RESOURCES_JSON','DENTITY_RUNTIME_HOST_RESOURCE_REGISTRY','DENTITY_RUNTIME_HOST_TOKEN','DENTITY_PLATFORM_RESOLVER_TOKEN'])assert.equal(configured[scope][key],undefined);
 assert.equal((await childEnvironments({...env,DENTITY_MOCK_MCP_PORT:'19303'})).mockMcp.DENTITY_MOCK_MCP_PORT,'19303');
});


test('Skill upload root reaches only platform, never model/MCP/Host/Web/build',async t=>{
 const {env,dir}=await fixture(t),root=path.join(dir,'skills');const children=await childEnvironments({...env,DENTITY_SKILL_RESOURCE_ROOT:root});assert.equal(children.platform.DENTITY_SKILL_RESOURCE_ROOT,root);for(const scope of ['host','mockModel','mockMcp','web','build'])assert.equal(children[scope].DENTITY_SKILL_RESOURCE_ROOT,undefined);
});
