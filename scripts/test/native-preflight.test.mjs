import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { checkArgon2, nativePreflight } from '../shared/local-native-preflight.mjs';
import { verifyOfficialArgon2 } from '../shared/local-native-package.mjs';
import { repositoryRoot } from '../shared/local-secrets.mjs';

test.before(async () => { await verifyOfficialArgon2({ cwd: repositoryRoot, allowDownload: true }); });
async function fixture(t, official = false) {
  const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'dentity-native-'));
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'isolated-native-check', private: true, dependencies: { argon2: '0.45.1' } }));
  await fs.copyFile(path.join(repositoryRoot, 'package-lock.json'), path.join(dir, 'package-lock.json'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  if (official) {
    const modules = path.join(dir, 'node_modules'); await fs.mkdir(modules);
    for (const name of await fs.readdir(path.join(repositoryRoot, 'node_modules'))) {
      if (name === 'argon2' || name === '.package-lock.json') continue;
      await fs.symlink(path.join(repositoryRoot, 'node_modules', name), path.join(modules, name));
    }
    await fs.copyFile(path.join(repositoryRoot, 'node_modules/.package-lock.json'), path.join(modules, '.package-lock.json'));
    await fs.cp(path.join(repositoryRoot, 'node_modules/argon2'), path.join(modules, 'argon2'), { recursive: true });
  }
  return dir;
}
test('native preflight verifies official source before real addon hash/verify, without rebuilding', async () => {
  const messages = [];
  await nativePreflight({ cwd: repositoryRoot, repair: false, log: message => messages.push(message) });
  assert.deepEqual(messages, ['Argon2 native hash/verify: ready.']);
});
test('missing package provenance fails before package loading or repair', async t => {
  const cwd = await fixture(t);
  assert.equal(await checkArgon2({ cwd }), false);
  await assert.rejects(nativePreflight({ cwd, repair: false }), /identity could not be verified/);
});
test('macOS rebuilds only the verified official addon once and probes it again', { skip: process.platform !== 'darwin', timeout: 150000 }, async t => {
  const cwd = await fixture(t, true);
  await fs.rm(path.join(cwd, 'node_modules/argon2/build'), { recursive: true, force: true });
  assert.equal(await checkArgon2({ cwd }), false);
  await assert.rejects(nativePreflight({ cwd, repair: false }), /npm rebuild --rebuild-bundle=false/);
  const messages = [];
  await nativePreflight({ cwd, env: { ...process.env, npm_config_cache: path.join(cwd, 'cache') }, log: message => messages.push(message) });
  assert.equal(messages.filter(message => message.includes('rebuilding')).length, 1);
  assert.equal(await checkArgon2({ cwd }), true);
});
test('macOS stops after one failed official rebuild when npm is unavailable', { skip: process.platform !== 'darwin', timeout: 150000 }, async t => {
  const cwd = await fixture(t, true), messages = [];
  await fs.rm(path.join(cwd, 'node_modules/argon2/build'), { recursive: true, force: true });
  await fs.mkdir(path.join(cwd, 'empty-path'));
  await assert.rejects(nativePreflight({ cwd, env: { ...process.env, PATH: path.join(cwd, 'empty-path'), npm_config_cache: path.join(cwd, 'cache') }, log: message => messages.push(message) }), /Argon2 rebuild failed/);
  assert.equal(messages.filter(message => message.includes('rebuilding')).length, 1);
});
test('P2-2 a same-name/version fake package cannot run require or install markers, even with copied provenance', async t => {
  const cwd = await fixture(t, true), addon = path.join(cwd, 'node_modules/argon2');
  const marker = path.join(cwd, 'untrusted-package-executed');
  await fs.writeFile(path.join(addon, 'package.json'), JSON.stringify({ name: 'argon2', version: '0.45.1', main: 'index.cjs', scripts: { install: 'node install.cjs' } }));
  const action = `require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed');`;
  await fs.writeFile(path.join(addon, 'index.cjs'), action + "throw Error('untrusted');");
  await fs.writeFile(path.join(addon, 'install.cjs'), action);
  await assert.rejects(nativePreflight({ cwd, log() {} }), /identity could not be verified/);
  await assert.rejects(fs.access(marker));
});
test('P2-2 pin, installed origin/version, linked location and modified official source all fail closed', async t => {
  for (const kind of ['lock-origin', 'lock-integrity', 'lock-version', 'installed-origin', 'installed-version', 'linked', 'source-change']) {
    const cwd = await fixture(t, true), addon = path.join(cwd, 'node_modules/argon2');
    if (kind === 'linked') { const elsewhere = path.join(cwd, 'linked-addon'); await fs.rename(addon, elsewhere); await fs.symlink(elsewhere, addon); }
    else if (kind === 'source-change') await fs.appendFile(path.join(addon, 'argon2.cjs'), '\n// changed after install\n');
    else {
      const file = path.join(cwd, kind.startsWith('lock-') ? 'package-lock.json' : 'node_modules/.package-lock.json');
      const lock = JSON.parse(await fs.readFile(file, 'utf8')), entry = lock.packages['node_modules/argon2'];
      if (kind.endsWith('origin')) entry.resolved = 'https://unapproved.invalid/argon2.tgz';
      else if (kind.endsWith('integrity')) entry.integrity = 'sha512-invalid';
      else entry.version = '0.45.2';
      await fs.writeFile(file, JSON.stringify(lock));
    }
    const messages = [];
    await assert.rejects(nativePreflight({ cwd, log: message => messages.push(message) }), /identity could not be verified/);
    assert.equal(messages.some(message => message.includes('rebuilding')), false, kind);
  }
});

test('P2-2 rebuild targets only the verified directory, never a nested package with the same name', { skip: process.platform !== 'darwin', timeout: 150000 }, async t => {
  const cwd = await fixture(t, true), addon = path.join(cwd, 'node_modules/argon2');
  const wrapper = path.join(cwd, 'node_modules', 'native-scope-review-wrapper');
  // This is a new physical fixture directory, never a link into source deps.
  await fs.mkdir(wrapper, { recursive: false });
  await fs.writeFile(path.join(wrapper, 'package.json'), JSON.stringify({ name: 'native-scope-review-wrapper', version: '1.0.0', dependencies: { argon2: '0.45.1' } }));
  const nested = path.join(wrapper, 'node_modules/argon2'); await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(nested, 'package.json'), JSON.stringify({ name: 'argon2', version: '0.45.1', scripts: { install: 'node install.cjs' } }));
  await fs.writeFile(path.join(nested, 'install.cjs'), "require('node:fs').writeFileSync('nested-lifecycle-marker','executed');");
  await fs.rm(path.join(addon, 'build'), { recursive: true, force: true });
  await verifyOfficialArgon2({ cwd, allowDownload: false });
  const messages = [];
  await nativePreflight({ cwd, env: { ...process.env, npm_config_cache: path.join(cwd, 'cache') }, log: message => messages.push(message) });
  assert.equal(messages.filter(message => message.includes('rebuilding')).length, 1);
  assert.equal(await checkArgon2({ cwd }), true, 'verified top-level addon was repaired');
  await assert.rejects(fs.access(path.join(nested, 'nested-lifecycle-marker')), 'unverified nested lifecycle must not run');
});
