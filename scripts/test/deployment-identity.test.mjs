import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { serviceIdentity, validateServiceAccount, deploymentStorage, planServicePermissions, applyServicePermissions, restoreServicePermissions,
  assertServiceAccess, assertEffectiveServiceIdentity, assertServiceProcessIdentity } from '../deploy/deployment-identity.mjs';
import { render } from '../deploy/setup-systemd.mjs';
import { serviceCatalog } from '../deploy/deployment-services.mjs';
import { repositoryRoot } from '../shared/local-secrets.mjs';

async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'identity-permissions-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const configuration = { platformDatabase: path.join(base, 'platform/platform.sqlite'), runtimeDatabase: path.join(base, 'runtime/runtime.sqlite'),
    records: path.join(base, 'runtime/records'), state: path.join(base, 'host'), platform: { DENTITY_SKILL_RESOURCE_ROOT: path.join(base, 'platform/skills') } };
  const storage = deploymentStorage(configuration, path.join(base, 'home'));
  const identity = { uid: process.getuid(), gid: process.getgid() };
  return { base, configuration, storage, identity };
}

test('deployment account rejects root, login shells, unlocked passwords and extra group access', () => {
  const passwd = `identity:x:991:992:Identale:${serviceIdentity.home}:/usr/sbin/nologin`;
  const group = 'identity:x:992:', shadow = 'identity:!:0:0:99999:7:::';
  assert.deepEqual(validateServiceAccount(passwd, group, shadow, '992'), { uid: 991, gid: 992 });
  for (const changed of [passwd.replace(':991:', ':0:'), passwd.replace(':992:', ':0:'), passwd.replace('nologin', 'bash'), passwd.replace(serviceIdentity.home, '/root')]) {
    assert.throws(() => validateServiceAccount(changed, group, shadow, '992'), /dedicated non-root/);
  }
  assert.throws(() => validateServiceAccount(passwd, group, shadow.replace('!', 'password-hash'), '992'), /locked/);
  assert.throws(() => validateServiceAccount(passwd, group, shadow, '992 27'), /private group/);
  assert.throws(() => validateServiceAccount(passwd, group + 'other-user', shadow, '992'), /private group/);
});

test('every rendered deployment service denies privilege gain and starts as identity', async () => {
  const source = await fs.readFile(new URL('../deploy/templates/identity.service.template', import.meta.url), 'utf8');
  for (const service of serviceCatalog) {
    const unit = render(source, { DESCRIPTION: service.name, ROOT: '/opt/identale', NODE: '/opt/node/bin/node', ENTRY: service.entry, ENV_FILE: service.name + '.env', SECRETS_DIRECTIVE: '' });
    assert.match(unit, /^User=identity$/m); assert.match(unit, /^Group=identity$/m);
    assert.match(unit, /^NoNewPrivileges=true$/m); assert.match(unit, /^CapabilityBoundingSet=$/m); assert.match(unit, /^AmbientCapabilities=$/m);
    assert.doesNotMatch(unit, /User=root|ExecStart=[+!]/);
  }
});

test('adoption preserves data and executable tools, handles SQLite sidecars, and leaves unrelated files alone', async t => {
  const { base, configuration: c, storage, identity } = await fixture(t);
  await fs.mkdir(path.dirname(c.platformDatabase));
  await fs.mkdir(c.state); await fs.mkdir(path.join(c.state, 'sessions'));
  const script = path.join(c.state, 'sessions/tool.sh'), unrelated = path.join(base, 'platform/unrelated.txt');
  await fs.writeFile(c.platformDatabase, 'synthetic database', { mode: 0o644 });
  await fs.writeFile(c.platformDatabase + '-wal', 'synthetic WAL', { mode: 0o640 });
  await fs.writeFile(script, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await fs.writeFile(unrelated, 'unrelated', { mode: 0o644 });
  const entries = await planServicePermissions(storage, { containers: [] });
  await applyServicePermissions(entries, identity);
  assert.equal((await fs.stat(c.platformDatabase)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(c.platformDatabase + '-wal')).mode & 0o777, 0o600);
  assert.equal((await fs.stat(c.state)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(script)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(script)).uid, identity.uid);
  assert.equal((await fs.stat(unrelated)).mode & 0o777, 0o644);
  assert.equal(await fs.readFile(c.platformDatabase, 'utf8'), 'synthetic database');
  assert.equal(await fs.readFile(c.platformDatabase + '-wal', 'utf8'), 'synthetic WAL');
  const second = await planServicePermissions(storage, { containers: [] });
  await applyServicePermissions(second, identity);
  assert.equal(await fs.readFile(c.platformDatabase, 'utf8'), 'synthetic database');
  await restoreServicePermissions(entries);
  assert.equal((await fs.stat(c.platformDatabase)).mode & 0o777, 0o644);
  assert.equal((await fs.stat(c.platformDatabase + '-wal')).mode & 0o777, 0o640);
  assert.equal((await fs.stat(script)).mode & 0o777, 0o755);
  await assert.rejects(fs.access(storage.directories[0]), { code: 'ENOENT' });
});

test('permission rollback restores metadata without deleting data created after service startup', async t => {
  const { configuration: c, storage, identity } = await fixture(t);
  const entries = await planServicePermissions(storage, { containers: [] });
  await applyServicePermissions(entries, identity);
  const result = path.join(c.state + '-execution', 'new-result.txt');
  await fs.writeFile(result, 'must survive configuration rollback');
  await restoreServicePermissions(entries);
  assert.equal(await fs.readFile(result, 'utf8'), 'must survive configuration rollback');
});

test('storage plans reject private/system/source scopes, linked ancestors, linked data and special entries before mutations', async t => {
  const { base, storage, configuration: c } = await fixture(t);
  for (const file of ['/root/task-data', '/etc/identity/data', '/var/lib', '/', base]) {
    await assert.rejects(planServicePermissions({ directories: [file], trees: [], files: [] }, { containers: [], protectedPaths: [path.join(base, 'source')] }), /Unsafe deployment storage scope/);
  }
  await fs.mkdir(c.state); await fs.writeFile(path.join(base, 'outside'), 'untouched', { mode: 0o644 });
  await fs.symlink(path.join(base, 'outside'), path.join(c.state, 'link'));
  await assert.rejects(planServicePermissions(storage, { containers: [] }), /symbolic link|Unsafe deployment storage entry/);
  await fs.rm(path.join(c.state, 'link'));
  await fs.link(path.join(base, 'outside'), path.join(c.state, 'hardlink'));
  await assert.rejects(planServicePermissions(storage, { containers: [] }), /Unsafe deployment storage entry/);
  await fs.rm(path.join(c.state, 'hardlink'));
  const fifo = path.join(c.state, 'fifo'); execFileSync('mkfifo', [fifo]);
  await assert.rejects(planServicePermissions(storage, { containers: [] }), /Unsafe deployment storage entry/);
  await fs.rm(fifo);
  await fs.symlink(c.state, path.join(base, 'alias'));
  await assert.rejects(planServicePermissions({ directories: [path.join(base, 'alias/child')], trees: [], files: [] }, { containers: [] }), /symbolic link/);
  assert.equal((await fs.stat(path.join(base, 'outside'))).mode & 0o777, 0o644);
  await assert.rejects(fs.access(storage.directories[0]), { code: 'ENOENT' });
});

test('permission updates detect a file replaced after planning and never follow its new symlink', async t => {
  const { base, storage, configuration: c, identity } = await fixture(t);
  await fs.mkdir(c.state);
  const file = path.join(c.state, 'record'), outside = path.join(base, 'outside');
  await fs.writeFile(file, 'before'); await fs.writeFile(outside, 'outside', { mode: 0o644 });
  const entries = await planServicePermissions(storage, { containers: [] });
  await fs.rm(file); await fs.symlink(outside, file);
  await assert.rejects(applyServicePermissions(entries, identity), /symbolic link/);
  assert.equal((await fs.stat(outside)).mode & 0o777, 0o644);
});

test('managed traversal container is not assigned to the service and its old mode is restored', async t => {
  const { base, storage, identity } = await fixture(t);
  await fs.chmod(base, 0o700);
  const before = await fs.stat(base);
  const entries = await planServicePermissions(storage, { containers: [base] });
  await applyServicePermissions(entries, identity);
  const after = await fs.stat(base);
  assert.equal(after.uid, before.uid); assert.equal(after.gid, before.gid); assert.equal(after.mode & 0o777, 0o711);
  await restoreServicePermissions(entries);
  assert.equal((await fs.stat(base)).mode & 0o777, 0o700);
});

test('access probe exercises the built password adapter and real non-root access', async t => {
  if (process.getuid() === 0) { t.skip('this probe test exercises the current non-root developer account'); return; }
  const { base, storage, identity } = await fixture(t);
  const entries = await planServicePermissions(storage, { containers: [] });
  await applyServicePermissions(entries, identity);
  const module = new URL('../deploy/deployment-identity.mjs', import.meta.url).href;
  const script = `import {probeServiceAccess} from ${JSON.stringify(module)}; await probeServiceAccess(JSON.parse(process.argv[1]));`;
  const input = { ...identity, root: repositoryRoot, node: process.execPath, entries: [path.join(repositoryRoot, 'package.json')], storage, extraFiles: [] };
  execFileSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(input)], { stdio: 'pipe' });
  const privateFile = path.join(base, 'unreadable-resource'); await fs.writeFile(privateFile, 'synthetic', { mode: 0o000 });
  try {
    assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify({ ...input, extraFiles: [privateFile] })], { stdio: 'pipe' }));
  } finally { await fs.chmod(privateFile, 0o600); }
  const registryPath = path.join(base, 'registry.json'), executionRoot = path.join(base, 'registered-execution');
  await fs.mkdir(executionRoot, { mode: 0o700 });
  await fs.writeFile(registryPath, JSON.stringify({ mcpServers: [], executionResources: [{ resourceId: 'synthetic-execution', version: '1', mode: 'task', root: executionRoot, tools: ['read', 'bash'] }] }));
  execFileSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify({ ...input, registryPath })], { stdio: 'pipe' });
  await fs.chmod(executionRoot, 0o755);
  assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify({ ...input, registryPath })], { stdio: 'pipe' }));
});

test('effective overrides and actual process metadata must both retain the reduced identity', () => {
  const expected = { user: 'identity', group: 'identity', noNewPrivileges: 'yes', capabilities: '', ambientCapabilities: '', supplementaryGroups: '' };
  assertEffectiveServiceIdentity(expected);
  for (const override of [{ user: 'root' }, { group: 'root' }, { noNewPrivileges: 'no' }, { capabilities: 'cap_sys_admin' }, { supplementaryGroups: 'sudo' }, { ambientCapabilities: 'cap_net_admin' }]) {
    assert.throws(() => assertEffectiveServiceIdentity({ ...expected, ...override }), /Conflicting systemd override/);
  }
  const status = 'Uid:\t991\t991\t991\t991\nGid:\t992\t992\t992\t992\nNoNewPrivs:\t1\nCapEff:\t00000000\nCapPrm:\t00000000\nCapBnd:\t00000000\nCapAmb:\t00000000\n';
  assertServiceProcessIdentity(status, { uid: 991, gid: 992 });
  for (const changed of [status.replace('991\t991', '0\t0'), status.replace('NoNewPrivs:\t1', 'NoNewPrivs:\t0'), status.replace('CapBnd:\t00000000', 'CapBnd:\t00000001')]) {
    assert.throws(() => assertServiceProcessIdentity(changed, { uid: 991, gid: 992 }), /running service/);
  }
});

test('real Linux privilege drop can write adopted storage and cannot read a root-only file', async t => {
  if (process.platform !== 'linux' || process.getuid() !== 0 || spawnSync('setpriv', ['--version']).status !== 0) {
    t.skip('requires an isolated Linux root environment with setpriv; no account is created'); return;
  }
  const nobody = execFileSync('getent', ['passwd', 'nobody'], { encoding: 'utf8' }).trim().split(':');
  const identity = { uid: Number(nobody[2]), gid: Number(nobody[3]) };
  const { base, storage } = await fixture(t);
  await fs.chmod(base, 0o711);
  const secret = path.join(base, 'root-only'); await fs.writeFile(secret, 'synthetic private file', { mode: 0o600 });
  const entries = await planServicePermissions(storage, { containers: [] });
  await applyServicePermissions(entries, identity);
  try {
    const script = `const fs=require('node:fs');fs.writeFileSync(process.argv[1],String(process.getuid()));try{fs.readFileSync(process.argv[2]);process.exit(1)}catch(e){if(e.code!=='EACCES')throw e}`;
    const result = path.join(storage.directories[0], 'result');
    execFileSync('setpriv', ['--reuid', String(identity.uid), '--regid', String(identity.gid), '--clear-groups', '--no-new-privs', '--bounding-set=-all', process.execPath, '-e', script, result, secret]);
    assert.equal(await fs.readFile(result, 'utf8'), String(identity.uid));
    await assert.rejects(fs.access(path.join(base, 'not-created')), { code: 'ENOENT' });
    // Also exercises the startup preflight's real access failure on a private checkout.
    assert.throws(() => assertServiceAccess(identity, { root: '/root', entries: [], storage }), /cannot access/);
  } finally { await restoreServicePermissions(entries); }
});
