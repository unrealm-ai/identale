import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { checkoutAcl, checkoutAccessTargets, planCheckoutAcls, applyCheckoutAcls, restoreCheckoutAcls, assertCheckoutAccess } from '../deploy/checkout-access.mjs';

test('ACL grant preserves the effective access of masked users and groups', () => {
  const acl = 'user::rwx\nuser:1001:rwx\nuser:1002:rwx\ngroup::rwx\ngroup:2000:rwx\nmask::--x\nother::---\n';
  const result = checkoutAcl(acl, { uid: 0, gid: 0 }, { uid: 1001, gid: 1001 }, 4);
  assert.match(result, /^user:1001:r-x$/m);
  assert.match(result, /^user:1002:--x$/m);
  assert.match(result, /^group::--x$/m);
  assert.match(result, /^group:2000:--x$/m);
  assert.match(result, /^mask::r-x$/m);
  assert.match(result, /^other::---$/m);
  assert.equal(checkoutAcl(result, { uid: 0, gid: 0 }, { uid: 1001, gid: 1001 }, 4), undefined);
});

test('ACL planning respects owner, named-user precedence and primary-group access', () => {
  assert.equal(checkoutAcl('user::rwx\ngroup::---\nother::---\n', { uid: 10, gid: 20 }, { uid: 10, gid: 30 }, 5), undefined);
  assert.equal(checkoutAcl('user::rwx\ngroup::r-x\nother::---\n', { uid: 10, gid: 20 }, { uid: 11, gid: 20 }, 5), undefined);
  const named = 'user::rwx\nuser:11:---\ngroup::r-x\nmask::r-x\nother::r-x\n';
  assert.match(checkoutAcl(named, { uid: 10, gid: 20 }, { uid: 11, gid: 20 }, 1), /^user:11:--x$/m);
  const owner = checkoutAcl('user::--x\ngroup::---\nother::---\n', { uid: 11, gid: 20 }, { uid: 11, gid: 20 }, 5);
  assert.match(owner, /^user::r-x$/m); assert.doesNotMatch(owner, /^user:11:/m);
});

async function fixture(t, linuxRoot = false) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(linuxRoot ? '/home' : os.tmpdir(), 'identale-acl-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.chmod(base, 0o711);
  const home = path.join(base, 'owner'), root = path.join(home, 'checkout');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const write = async (relative, text) => {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, text, { mode: 0o600 }); return file;
  };
  await write('package.json', '{"type":"module"}');
  await write('scripts/deploy/deployment-identity.mjs', 'export const fixture=true;');
  await write('apps/control-plane/package.json', '{"type":"module"}');
  const entry = await write('apps/control-plane/dist/main.js', 'import {value} from "synthetic-dependency"; import {workspace} from "@dentity/domain"; console.log(value+workspace);');
  await write('node_modules/synthetic-dependency/package.json', '{"name":"synthetic-dependency","type":"module","exports":"./index.js"}');
  const dependency = await write('node_modules/synthetic-dependency/index.js', 'export const value="dependency:";');
  await write('packages/domain/package.json', '{"name":"@dentity/domain","type":"module","exports":"./dist/index.js"}');
  await write('packages/domain/dist/index.js', 'export const workspace="workspace";');
  await fs.mkdir(path.join(root, 'node_modules/@dentity'), { mode: 0o700 });
  await fs.symlink('../../packages/domain', path.join(root, 'node_modules/@dentity/domain'));
  await fs.symlink('../../apps/control-plane', path.join(root, 'node_modules/@dentity/control-plane'));
  await write('apps/web/package.json', '{"name":"@dentity/web"}');
  await write('apps/web/src/private.txt', 'NOT_A_SERVER_RUNTIME');
  await fs.symlink('../../apps/web', path.join(root, 'node_modules/@dentity/web'));
  await write('.env', 'PRIVATE_SYNTHETIC_CONFIG');
  await write('.git/config', 'PRIVATE_SYNTHETIC_GIT');
  await write('packages/domain/src/private.txt', 'NOT_RUNTIME');
  await write('node_modules/synthetic-dependency/.env', 'PRIVATE_SYNTHETIC_DEPENDENCY_ENV');
  const outside = path.join(home, 'private.txt'); await fs.writeFile(outside, 'PRIVATE_SYNTHETIC_HOME', { mode: 0o600 });
  return { base, home, root, entry, dependency, outside, write, input: { root, node: await fs.realpath(process.execPath), entries: [entry] } };
}

test('runtime inventory includes workspace output and dependencies, excludes private files and source', async t => {
  const f = await fixture(t), targets = await checkoutAccessTargets(f.input), files = new Set(targets.map(entry => entry.file));
  assert.ok(files.has(f.dependency)); assert.ok(files.has(f.entry));
  assert.ok(files.has(path.join(f.root, 'packages/domain/dist/index.js')));
  for (const relative of ['.env', '.git', '.git/config', 'packages/domain/src', 'packages/domain/src/private.txt', 'apps/web/src/private.txt', 'node_modules/synthetic-dependency/.env']) assert.ok(!files.has(path.join(f.root, relative)), relative);
  assert.equal(targets.find(entry => entry.file === f.home).required, 1);
  assert.ok(!files.has(f.outside));
  const initial = await checkoutAccessTargets({ ...f.input, runtime: false });
  assert.ok(!initial.some(entry => entry.file === f.dependency || entry.file === f.entry));
});

test('runtime inventory refuses external links, private link targets and a linked checkout ancestor', async t => {
  const f = await fixture(t), link = path.join(f.root, 'node_modules/synthetic-dependency/link');
  await fs.symlink(f.outside, link);
  await assert.rejects(checkoutAccessTargets(f.input), /leaves approved trees/);
  await fs.rm(link); await fs.symlink(path.join(f.root, '.env'), link);
  await assert.rejects(checkoutAccessTargets(f.input), /Private runtime link target/);
  await fs.rm(link);
  const alias = path.join(f.base, 'alias'); await fs.symlink(f.home, alias);
  await assert.rejects(checkoutAccessTargets({ ...f.input, root: path.join(alias, 'checkout') }), /symbolic link/);
  await assert.rejects(checkoutAccessTargets({ ...f.input, root: '/root/checkout' }), /Private root path/);
});

function linuxIdentity(t) {
  if (process.platform !== 'linux' || process.getuid() !== 0 || ['setpriv', 'getfacl', 'setfacl'].some(tool => spawnSync(tool, ['--version']).status !== 0)) {
    t.skip('requires isolated Linux root with util-linux and acl; creates no account'); return undefined;
  }
  const row = execFileSync('getent', ['passwd', 'nobody'], { encoding: 'utf8' }).trim().split(':');
  return { uid: Number(row[2]), gid: Number(row[3]) };
}
function as(identity, script, args = []) {
  return execFileSync('setpriv', ['--reuid', String(identity.uid), '--regid', String(identity.gid), '--clear-groups', '--no-new-privs', '--bounding-set=-all', process.execPath, '--input-type=module', '-e', script, ...args], { encoding: 'utf8', stdio: 'pipe' });
}
const getAcl = file => execFileSync('getfacl', ['-c', '-n', '-p', '--access', '--', file], { encoding: 'utf8' }).trimEnd() + '\n';

test('real private-home grant imports dependencies/workspaces, preserves privacy and restores ACLs', async t => {
  const identity = linuxIdentity(t); if (!identity) return;
  const f = await fixture(t, true), beforeHome = getAcl(f.home), beforeDependency = getAcl(f.dependency), owner = await fs.stat(f.root);
  const changes = [], journal = await fs.open(path.join(f.base, 'acl.jsonl'), 'wx', 0o600);
  assert.throws(() => assertCheckoutAccess(identity, f.input), /cannot access/);
  try {
    await applyCheckoutAcls(await planCheckoutAcls(identity, { ...f.input, runtime: false }), changes, journal);
    assertCheckoutAccess(identity, f.input);
    await applyCheckoutAcls(await planCheckoutAcls(identity, f.input), changes, journal);
    assert.equal(as(identity, `await import(process.argv[1])`, [new URL('file://' + f.entry).href]).trim(), 'dependency:workspace');
    const privateFiles = [path.join(f.root, '.env'), path.join(f.root, '.git/config'), f.outside, path.join(f.root, 'packages/domain/src/private.txt'), path.join(f.root, 'node_modules/synthetic-dependency/.env')];
    as(identity, `import fs from 'node:fs'; for(const p of process.argv.slice(1)){try{fs.readFileSync(p);throw Error('private file exposed')}catch(e){if(e.code!=='EACCES')throw e}}`, privateFiles);
    as(identity, `import fs from 'node:fs';try{fs.readdirSync(process.argv[1]);throw Error('home listing exposed')}catch(e){if(e.code!=='EACCES')throw e}`, [f.home]);
    assert.equal((await fs.stat(f.root)).uid, owner.uid); assert.equal((await fs.stat(f.root)).gid, owner.gid);
    assert.deepEqual(await planCheckoutAcls(identity, f.input), []);
    assert.equal((await fs.stat(path.join(f.base, 'acl.jsonl'))).mode & 0o777, 0o600);
    const records = (await fs.readFile(path.join(f.base, 'acl.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(records.length, changes.length);
    assert.ok(records.some(entry => entry.file === f.home && entry.acl === beforeHome));
  } finally { await journal.close(); await restoreCheckoutAcls(changes); }
  assert.equal(getAcl(f.home), beforeHome); assert.equal(getAcl(f.dependency), beforeDependency);
  assert.throws(() => assertCheckoutAccess(identity, f.input), /cannot access/);
});

test('real ACL mask expansion never unlocks another masked user and rollback retains original entries', async t => {
  const identity = linuxIdentity(t); if (!identity) return;
  const f = await fixture(t, true), other = identity.uid + 1;
  execFileSync('setfacl', ['-m', `u:${other}:rwx,m::---`, '--', f.dependency]);
  execFileSync('setfacl', ['-d', '-m', `u:${other}:rwx,m::---`, '--', f.home]);
  const defaults = () => execFileSync('getfacl', ['-c', '-n', '-p', '--default', '--', f.home], { encoding: 'utf8' });
  const beforeDefault = defaults();
  const before = getAcl(f.dependency), changes = [], journal = await fs.open(path.join(f.base, 'acl.jsonl'), 'wx', 0o600);
  try {
    await applyCheckoutAcls(await planCheckoutAcls(identity, f.input), changes, journal);
    assert.match(getAcl(f.dependency), new RegExp(`^user:${other}:---$`, 'm'));
    assert.equal(defaults(), beforeDefault);
    as(identity, `import fs from 'node:fs';fs.readFileSync(process.argv[1])`, [f.dependency]);
  } finally { await journal.close(); await restoreCheckoutAcls(changes); }
  assert.equal(getAcl(f.dependency), before);
  assert.equal(defaults(), beforeDefault);
});

test('an unwritable ACL journal prevents permission changes before the first grant', async t => {
  const identity = linuxIdentity(t); if (!identity) return;
  const f = await fixture(t, true), before = getAcl(f.home), changes = [];
  const journal = await fs.open(path.join(f.base, 'closed-journal.jsonl'), 'wx', 0o600); await journal.close();
  const plan = await planCheckoutAcls(identity, f.input);
  await assert.rejects(applyCheckoutAcls(plan, changes, journal), /closed|EBADF/);
  assert.deepEqual(changes, []); assert.equal(getAcl(f.home), before);
});

test('replaced runtime files fail safely, rollback still restores earlier entries, and hardlinks are refused', async t => {
  const identity = linuxIdentity(t); if (!identity) return;
  const f = await fixture(t, true), before = getAcl(f.home), changes = [], journal = await fs.open(path.join(f.base, 'acl.jsonl'), 'wx', 0o600);
  const plan = await planCheckoutAcls(identity, f.input);
  const bad = plan.find(entry => entry.file === f.dependency), good = plan.find(entry => entry.file === f.home);
  await applyCheckoutAcls([good], changes, journal);
  await fs.rm(f.dependency); await fs.symlink(f.outside, f.dependency);
  try {
    await assert.rejects(applyCheckoutAcls([bad], changes, journal), /symbolic link/);
    await assert.rejects(restoreCheckoutAcls(changes), /Unable to restore checkout ACL/);
    assert.equal(getAcl(f.home), before);
    assert.equal((await fs.stat(f.outside)).mode & 0o777, 0o600);
    await fs.rm(f.dependency); await fs.link(f.outside, f.dependency);
    await assert.rejects(planCheckoutAcls(identity, f.input), /hardlinked runtime file/);
  } finally { await journal.close(); }
});

test('journal writes and reopens below a root-owned 0711 container without reading it', async t => {
  const identity = linuxIdentity(t); if (!identity) return;
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'identale-journal-0711-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.chmod(base, 0o711);
  const runtime = path.join(base, 'runtime'); await fs.mkdir(runtime, { mode: 0o700 }); await fs.chown(runtime, identity.uid, identity.gid);
  // The compiled journal is self-contained; copy only this executable fixture.
  const module = path.join(base, 'journal.mjs');
  await fs.copyFile(new URL('../../packages/runtime-builtin/dist/journal.js', import.meta.url), module); await fs.chmod(module, 0o644);
  const script = `import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';import {pathToFileURL} from 'node:url';
    const {JsonlJournal}=await import(pathToFileURL(process.argv[1]));
    try{fs.openSync(process.argv[2],fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);throw Error('container unexpectedly readable')}catch(e){if(e.code!=='EACCES')throw e}
    const db=new DatabaseSync(process.argv[3]+'/runtime.sqlite');const serialize=fn=>{db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result}catch(e){db.exec('ROLLBACK');throw e}};
    const options={root:process.argv[3]+'/new/parent/records',ownerId:'fixture-db',serialize},scope={workspaceId:'w',entityId:'e',conversationId:'c'};
    const first=new JsonlJournal(options),ref=first.put(scope,'text','durable');
    if(new JsonlJournal(options).read(scope,ref)!=='durable')throw Error('journal reopen failed');db.close();`;
  as(identity, script, [module, base, runtime]);
  assert.equal((await fs.stat(base)).mode & 0o777, 0o711);
  assert.equal((await fs.stat(path.join(runtime, 'new/parent/records'))).mode & 0o777, 0o700);
});
