import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, readdir, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childEnvironments } from '../local/local-start.mjs';
import { initializeSecrets, repositoryRoot } from '../shared/local-secrets.mjs';

async function fixture(t) {
  const base = await mkdtemp(join(await realpath(tmpdir()), 'dentity-split-env-'));
  const dir = join(base, 'checkout'); await mkdir(dir);
  t.after(() => rm(base, { recursive: true, force: true }));
  return { dir, env: { HOME: join(base, 'home'), XDG_CONFIG_HOME: join(base, 'config') } };
}

test('three-service launcher isolates storage and keeps PI passive without business resolver credentials', async t => {
  const { env } = await fixture(t);
  await initializeSecrets({ env, confirmed: true });
  const children = await childEnvironments({ ...env, DENTITY_DATABASE_PATH: '/tmp/platform-fixture.sqlite', DENTITY_RUNTIME_DATABASE_PATH: '/tmp/runtime-fixture.sqlite' });
  assert.equal(children.platform.DENTITY_DATABASE_PATH, '/tmp/platform-fixture.sqlite');
  assert.equal(children.runtime.DENTITY_RUNTIME_DATABASE_PATH, '/tmp/runtime-fixture.sqlite');
  assert.equal(children.runtime.DENTITY_DATABASE_PATH, undefined);
  assert.equal(children.runtime.DENTITY_MODEL_MASTER_KEY, undefined);
  assert.equal(children.host.DENTITY_PLATFORM_RESOLVER_URL,undefined);assert.equal(children.host.DENTITY_PLATFORM_RESOLVER_TOKEN,undefined);
  assert.equal(children.platform.DENTITY_PLATFORM_RESOLVER_TOKEN, undefined);
  assert.equal(children.platform.DENTITY_RUNTIME_HOST_TOKEN, undefined);
  assert.equal(typeof children.runtime.DENTITY_PLATFORM_RESOLVER_TOKEN,'string');assert.equal(children.host.DENTITY_PLATFORM_RESOLVER_TOKEN,undefined);
  assert.equal(children.platform.DENTITY_RUNTIME_SERVICE_TOKEN, children.runtime.DENTITY_RUNTIME_SERVICE_TOKEN);
  assert.equal(children.platform.DENTITY_PLATFORM_CONFIG_TOKEN, children.runtime.DENTITY_PLATFORM_CONFIG_TOKEN);
  assert.notEqual(children.platform.DENTITY_RUNTIME_SERVICE_TOKEN, children.platform.DENTITY_PLATFORM_CONFIG_TOKEN);
  assert.equal(children.platform.DENTITY_PI_MONITOR_TOKEN, children.host.DENTITY_PI_MONITOR_TOKEN);
  assert.equal(children.runtime.DENTITY_PI_MONITOR_TOKEN, undefined);
  assert.notEqual(children.host.DENTITY_PI_MONITOR_TOKEN, children.host.DENTITY_RUNTIME_HOST_TOKEN);
  for (const scope of ['mockModel', 'mockMcp', 'web', 'build']) assert.equal(children[scope].DENTITY_PI_MONITOR_TOKEN, undefined);
  for (const scope of ['host', 'mockModel', 'mockMcp', 'web', 'build']) {
    for (const key of ['DENTITY_PLATFORM_CONFIG_TOKEN', 'DENTITY_RUNTIME_SERVICE_TOKEN', 'DENTITY_DATABASE_PATH', 'DENTITY_RUNTIME_DATABASE_PATH']) assert.equal(children[scope][key], undefined);
  }
});

test('transport scopes reuse private key derivation without rewriting private credentials', async t => {
  const { env } = await fixture(t);
  const initialized = await initializeSecrets({ env, confirmed: true });
  const before = await readFile(initialized.path, 'utf8');
  const first = await childEnvironments(env), second = await childEnvironments(env);
  assert.equal(first.runtime.DENTITY_PLATFORM_CONFIG_TOKEN, second.runtime.DENTITY_PLATFORM_CONFIG_TOKEN);
  assert.equal(first.runtime.DENTITY_RUNTIME_SERVICE_TOKEN, second.runtime.DENTITY_RUNTIME_SERVICE_TOKEN);
  assert.equal(await readFile(initialized.path, 'utf8'), before);
});

test('uninitialized launch keeps model unconfigured and transport credentials ephemeral', async t => {
  const { dir, env } = await fixture(t);
  const first = await childEnvironments(env), second = await childEnvironments(env);
  assert.equal(first.platform.DENTITY_MODEL_MASTER_KEY, undefined);
  assert.equal(first.host.DENTITY_RUNTIME_HOST_TOKEN, undefined);
  assert.notEqual(first.runtime.DENTITY_PLATFORM_CONFIG_TOKEN, second.runtime.DENTITY_PLATFORM_CONFIG_TOKEN);
  assert.deepEqual(await readdir(dir), []);
});

test('same DB, partial tokens, shared credentials and wrong runtime target are rejected', async t => {
  const { env } = await fixture(t);
  await assert.rejects(childEnvironments({ ...env, DENTITY_DATABASE_PATH: '/tmp/same.sqlite', DENTITY_RUNTIME_DATABASE_PATH: '/tmp/./same.sqlite' }), /distinct/);
  await assert.rejects(childEnvironments({ ...env, DENTITY_RUNTIME_SERVICE_TOKEN: 'one' }), /both distinct/);
  await assert.rejects(childEnvironments({ ...env, DENTITY_RUNTIME_SERVICE_TOKEN: 'same', DENTITY_PLATFORM_CONFIG_TOKEN: 'same' }), /distinct/);
  await assert.rejects(childEnvironments({ ...env, DENTITY_RUNTIME_SERVICE_PORT: '18300' }), /distinct/);
  await assert.rejects(childEnvironments({ ...env, DENTITY_PLATFORM_RESOLVER_URL: 'http://127.0.0.1:18300/internal/runtime' }), /18304/);
});

test('runtime service has an independent start entry and exact recovery identity', async () => {
  const manifest = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.scripts['start:runtime'], 'node apps/control-plane/dist/runtime-main.js');
  const recovery = await readFile(join(repositoryRoot, 'scripts/local/local-recovery.mjs'), 'utf8');
  assert.ok(recovery.includes("'apps/control-plane/dist/runtime-main.js'"));
});
