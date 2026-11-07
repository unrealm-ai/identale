// Modified for Identale; see the root NOTICE.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadLocalEnvironment } from '../local/local-environment.mjs';
import { localLauncherDirectory, prepareLauncherDirectory, localHome } from '../shared/local-paths.mjs';
import { initializeSecrets, secretPath, repositoryRoot, readSecrets } from '../shared/local-secrets.mjs';
import { childEnvironments, initializeLocalInstallation, localCommands } from '../local/local-start.mjs';

async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp('/tmp/id-env-'));
  const root = path.join(base, 'checkout'), home = path.join(base, 'home');
  await fs.mkdir(root); await fs.mkdir(home);
  await fs.copyFile(path.join(repositoryRoot, '.env.example'), path.join(root, '.env.example'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return { base, root, home, env: { HOME: home, PATH: process.env.PATH } };
}

test('fresh local .env is private, complete, concurrent-safe and reusable without overwriting user edits', async t => {
  const { root, env, home } = await fixture(t);
  const results = await Promise.all(Array.from({ length: 4 }, () => loadLocalEnvironment(env, root)));
  for (const value of results) {
    assert.equal(value.DENTITY_LOCAL_SECRETS_PATH, path.join(home, '.identale/local-secrets.json'));
    assert.equal(value.DENTITY_DATABASE_PATH, path.join(home, '.identale/platform/platform.sqlite'));
    assert.equal(value.DENTITY_RUNTIME_DATABASE_PATH, path.join(home, '.identale/runtime/runtime.sqlite'));
    assert.equal(value.DENTITY_RUNTIME_HOST_STATE_DIR, path.join(home, '.identale/runtime-host-pi'));
    assert.equal(value.DENTITY_SKILL_RESOURCE_ROOT, path.join(home, '.identale/resources/skills'));
  }
  assert.equal((await fs.stat(path.join(root, '.env'))).mode & 0o777, 0o600);
  assert.equal(await readSecrets({ env: results[0], root }), undefined, 'loading configuration does not generate credentials');
  const edited = '# user configuration\nDENTITY_DATABASE_PATH="~/custom store/platform.sqlite"\nDENTITY_MODEL_ALLOW_LOOPBACK_HTTP=false\n';
  await fs.writeFile(path.join(root, '.env'), edited);
  assert.equal((await loadLocalEnvironment(env, root)).DENTITY_DATABASE_PATH, path.join(home, 'custom store/platform.sqlite'));
  assert.equal(await fs.readFile(path.join(root, '.env'), 'utf8'), edited);
  assert.deepEqual((await fs.readdir(root)).sort(), ['.env', '.env.example']);
});

test('process environment overrides .env, .env overrides defaults and settings reach the correct service', async t => {
  const { root, env, home } = await fixture(t);
  await fs.writeFile(path.join(root, '.env'), [
    'DENTITY_DATABASE_PATH=./custom/platform.sqlite',
    'DENTITY_RUNTIME_DATABASE_PATH=~/custom/runtime.sqlite',
    'DENTITY_RUNTIME_HOST_STATE_DIR=./custom/pi',
    'DENTITY_BUILTIN_RECORD_ROOT=~/custom/records',
    'DENTITY_SKILL_RESOURCE_ROOT=~/custom/skills',
    'DENTITY_MODEL_ALLOW_LOOPBACK_HTTP=false',
    'DENTITY_TRIGGER_ALLOW_LOOPBACK_HTTP=false',
    'DENTITY_SECURE_COOKIES=false',
    'DENTITY_PLATFORM_CONFIG_POLL_INTERVAL_MS=2500',
    'DENTITY_CONTROL_PLANE_PORT=19300',
    'DENTITY_RUNTIME_SERVICE_PORT=19304',
    'DENTITY_RUNTIME_HOST_PI_PORT=19301',
    'DENTITY_WEB_PORT=16173',
    'DENTITY_MOCK_MODEL_PORT=19302',
    'DENTITY_MOCK_MCP_PORT=19303',
    'DENTITY_MODEL_MASTER_KEY=',
  ].join('\n'));
  const loaded = await loadLocalEnvironment({ ...env, DENTITY_DATABASE_PATH: '~/override/platform.sqlite' }, root);
  const children = await childEnvironments(loaded, { root });
  assert.equal(children.platform.DENTITY_DATABASE_PATH, path.join(home, 'override/platform.sqlite'));
  assert.equal(children.runtime.DENTITY_RUNTIME_DATABASE_PATH, path.join(home, 'custom/runtime.sqlite'));
  assert.equal(children.host.DENTITY_RUNTIME_HOST_STATE_DIR, path.join(root, 'custom/pi'));
  assert.equal(children.runtime.DENTITY_BUILTIN_RECORD_ROOT, path.join(home, 'custom/records'));
  assert.equal(children.platform.DENTITY_SKILL_RESOURCE_ROOT, path.join(home, 'custom/skills'));
  assert.equal(children.runtime.DENTITY_PLATFORM_CONFIG_POLL_INTERVAL_MS, '2500');
  assert.equal(children.platform.DENTITY_MODEL_ALLOW_LOOPBACK_HTTP, 'false');
  assert.equal(children.runtime.DENTITY_MODEL_ALLOW_LOOPBACK_HTTP, 'false');
  assert.equal(children.runtime.DENTITY_TRIGGER_ALLOW_LOOPBACK_HTTP, 'false');
  assert.equal(children.runtime.DENTITY_SECURE_COOKIES, 'false');
  assert.equal(children.runtime.DENTITY_PLATFORM_CONFIG_URL, 'http://127.0.0.1:19300');
  assert.equal(children.platform.DENTITY_RUNTIME_SERVICE_URL, 'http://127.0.0.1:19304');
  assert.equal(children.platform.DENTITY_RUNTIME_HOST_URL, 'http://127.0.0.1:19301');
  assert.equal(children.runtime.DENTITY_APP_ORIGIN, 'http://127.0.0.1:16173');
  assert.equal(children.web.DENTITY_CONTROL_PLANE_URL, 'http://127.0.0.1:19300');
  const commands = localCommands(children, { mock: true });
  assert.deepEqual(commands.map(command => command.port), [19302, 19303, 19300, 19304, 19301, 16173]);
  assert.ok(commands.at(-1).args.includes('16173'));
  assert.equal(children.build.DENTITY_DATABASE_PATH, undefined);
  assert.equal(children.web.DENTITY_MODEL_MASTER_KEY, undefined);
  await fs.writeFile(path.join(root, '.env'), 'DENTITY_MODEL_ALLOW_LOOPBACK_HTTP=true\n');
  assert.equal((await loadLocalEnvironment({ ...env, DENTITY_MODEL_ALLOW_LOOPBACK_HTTP: '' }, root)).DENTITY_MODEL_ALLOW_LOOPBACK_HTTP, '', 'even an explicitly empty process value wins');
});

test('old storage, credentials and resources do not change new installation defaults or get modified', async t => {
  const { root, env, home } = await fixture(t);
  const legacySecret = process.platform === 'darwin' ? path.join(home, 'Library/Application Support/dentity/local-secrets.json') : path.join(home, '.config/dentity/local-secrets.json');
  await initializeSecrets({ env: { ...env, DENTITY_LOCAL_SECRETS_PATH: legacySecret }, root, confirmed: true });
  const keyBefore = await fs.readFile(legacySecret);
  for (const relative of ['.dentity/platform', '.dentity/runtime', 'var/runtime-host-pi']) await fs.mkdir(path.join(root, relative), { recursive: true });
  await fs.mkdir(path.join(home, '.identity/resources/skills'), { recursive: true });
  const platform = path.join(root, '.dentity/platform/platform.sqlite');
  const runtime = path.join(root, '.dentity/runtime/runtime.sqlite');
  const single = path.join(root, '.dentity/control-plane.sqlite');
  for (const file of [platform, runtime, single]) await fs.writeFile(file, 'synthetic database sentinel');
  const loaded = await loadLocalEnvironment(env, root);
  assert.equal(loaded.DENTITY_DATABASE_PATH, path.join(home, '.identale/platform/platform.sqlite'));
  assert.equal(loaded.DENTITY_RUNTIME_DATABASE_PATH, path.join(home, '.identale/runtime/runtime.sqlite'));
  assert.equal(secretPath(loaded), path.join(home, '.identale/local-secrets.json'));
  assert.equal(secretPath(env), secretPath(loaded));
  assert.equal(loaded.DENTITY_RUNTIME_HOST_STATE_DIR, path.join(home, '.identale/runtime-host-pi'));
  assert.equal(loaded.DENTITY_SKILL_RESOURCE_ROOT, path.join(home, '.identale/resources/skills'));
  await initializeLocalInstallation(loaded, root);
  assert.ok(await readSecrets({ env: loaded, root }));
  assert.notDeepEqual(await fs.readFile(secretPath(loaded)), keyBefore);
  assert.deepEqual(await fs.readFile(legacySecret), keyBefore);
  for (const file of [platform, runtime, single]) assert.equal(await fs.readFile(file, 'utf8'), 'synthetic database sentinel');
});

for (const role of ['platform', 'runtime', 'custom']) test(`existing ${role} database without credentials never gets a replacement key`, async t => {
  const { root, env, home } = await fixture(t);
  const database = role === 'custom' ? path.join(root, '.dentity/explicit.sqlite') : path.join(home, `.identale/${role}/${role}.sqlite`);
  await fs.mkdir(path.dirname(database), { recursive: true, mode: 0o700 });
  await fs.writeFile(database, 'existing database sentinel');
  const configured = role === 'custom' ? { ...env, DENTITY_DATABASE_PATH: database } : env;
  const loaded = await loadLocalEnvironment(configured, root);
  await assert.rejects(initializeLocalInstallation(loaded, root), /original key/);
  await assert.rejects(fs.access(secretPath(loaded)), { code: 'ENOENT' });
  assert.equal(await fs.readFile(database, 'utf8'), 'existing database sentinel');
});

test('coexisting old and new credentials select the new default; an explicit old path remains usable', async t => {
  const { root, env, home } = await fixture(t);
  const current = path.join(home, '.identale/local-secrets.json');
  const legacy = process.platform === 'darwin' ? path.join(home, 'Library/Application Support/dentity/local-secrets.json') : path.join(home, '.config/dentity/local-secrets.json');
  for (const file of [current, legacy]) await initializeSecrets({ env: { ...env, DENTITY_LOCAL_SECRETS_PATH: file }, root, confirmed: true });
  const before = await Promise.all([current, legacy].map(file => fs.readFile(file)));
  assert.equal((await loadLocalEnvironment(env, root)).DENTITY_LOCAL_SECRETS_PATH, current);
  const loaded = await loadLocalEnvironment({ ...env, DENTITY_LOCAL_SECRETS_PATH: legacy }, root);
  assert.equal(loaded.DENTITY_LOCAL_SECRETS_PATH, legacy);
  await initializeLocalInstallation(loaded, root);
  assert.deepEqual(await Promise.all([current, legacy].map(file => fs.readFile(file))), before);
});

test('configuration is parsed as data, quoted spaces survive, links and unrelated environment injection are refused', async t => {
  const { root, env } = await fixture(t);
  const file = path.join(root, '.env');
  await fs.writeFile(file, 'DENTITY_RUNTIME_HOST_RESOURCE_REGISTRY="./with spaces/registry.json"\nDENTITY_MODEL_MASTER_KEY="$(touch must-not-exist)"\n');
  const loaded = await loadLocalEnvironment(env, root);
  assert.equal(loaded.DENTITY_RUNTIME_HOST_RESOURCE_REGISTRY, path.join(root, 'with spaces/registry.json'));
  assert.equal(loaded.DENTITY_MODEL_MASTER_KEY, '$(touch must-not-exist)');
  await assert.rejects(fs.access(path.join(root, 'must-not-exist')), { code: 'ENOENT' });
  await fs.writeFile(file, 'NODE_OPTIONS=--import=./unexpected.mjs\n');
  await assert.rejects(loadLocalEnvironment(env, root), /DENTITY_\*/);
  await fs.rm(file); await fs.symlink(path.join(root, '.env.example'), file);
  await assert.rejects(loadLocalEnvironment(env, root), /ELOOP/);
});

test('launcher metadata stays under ~/.identale and separated by checkout even with an old directory', async t => {
  const { root, env } = await fixture(t);
  const folder = prepareLauncherDirectory(root, env);
  assert.ok(folder.startsWith(path.join(localHome(env), 'launchers') + path.sep));
  assert.notEqual(folder, localLauncherDirectory(root + '-other', env));
  assert.equal((await fs.stat(folder)).mode & 0o777, 0o700);
  await fs.mkdir(path.join(root, '.dentity'));
  assert.equal(prepareLauncherDirectory(root, env), folder);
  assert.deepEqual(await fs.readdir(path.join(root, '.dentity')), []);
});

for (const level of ['home', 'launchers', 'checkout']) test(`launcher rejects unsafe ${level} directory without changing it`, async t => {
  const { root, env } = await fixture(t);
  const folder = prepareLauncherDirectory(root, env);
  const unsafe = level === 'home' ? localHome(env) : level === 'launchers' ? path.dirname(folder) : folder;
  await fs.chmod(unsafe, 0o755);
  assert.throws(() => prepareLauncherDirectory(root, env), /Unsafe local launcher directory/);
  assert.equal((await fs.stat(unsafe)).mode & 0o777, 0o755);
  await fs.chmod(unsafe, 0o700);
  const original = unsafe + '-original';
  await fs.rename(unsafe, original); await fs.symlink(original, unsafe);
  assert.throws(() => prepareLauncherDirectory(root, env), /Unsafe local launcher directory/);
  assert.equal((await fs.lstat(unsafe)).isSymbolicLink(), true);
});

for (const entry of ['scripts/start.sh', 'scripts/local/local-start.mjs']) test(`${entry} creates and reads .env before local credential initialization`, { timeout: 15000 }, async t => {
  const { root, env, home } = await fixture(t);
  await fs.cp(path.join(repositoryRoot, 'scripts'), path.join(root, 'scripts'), { recursive: true, filter: source => !path.relative(path.join(repositoryRoot, 'scripts'), source).split(path.sep).includes('test') });
  const run = () => spawnSync(entry.endsWith('.sh') ? 'bash' : process.execPath, [path.join(root, entry), '--no-install', '--no-build'], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
  let result = run();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Dependencies are missing/);
  assert.ok(await fs.readFile(path.join(root, '.env'), 'utf8'));
  const first = await fs.readFile(path.join(home, '.identale/local-secrets.json'));
  const custom = path.join(home, 'configured/private.json');
  await fs.mkdir(path.dirname(custom), { mode: 0o700 });
  await fs.copyFile(path.join(home, '.identale/local-secrets.json'), custom); await fs.chmod(custom, 0o600);
  await fs.writeFile(path.join(root, '.env'), `DENTITY_LOCAL_SECRETS_PATH=${JSON.stringify(custom)}\nDENTITY_DATABASE_PATH=./custom/platform.sqlite\nDENTITY_RUNTIME_DATABASE_PATH=./custom/runtime.sqlite\n`);
  result = run();
  assert.equal(result.status, 1, result.stderr); assert.match(result.stderr, /Dependencies are missing/);
  assert.ok(result.stdout.includes(custom), 'the actual entry reports the configured private-file source');
  assert.deepEqual(await fs.readFile(custom), first);
});
