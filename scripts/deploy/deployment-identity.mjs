import * as fs from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const serviceIdentity = { name: 'identity', home: '/var/lib/identity/service-home' };
const commandOptions = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000,
  env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' } };
const command = (name, args) => execFileSync(name, args, commandOptions).trim();
function lookup(database, name) {
  const result = spawnSync('getent', [database, name], commandOptions);
  if (result.status === 2) return undefined;
  if (result.error || result.status !== 0) throw new Error(`Unable to inspect deployment ${database}.`);
  return result.stdout.trim();
}

export function validateServiceAccount(passwd, group, shadow, groups) {
  const p = passwd?.split(':'), g = group?.split(':'), password = shadow?.split(':')[1];
  const uid = Number(p?.[2]), gid = Number(p?.[3]);
  if (p?.length !== 7 || p[0] !== serviceIdentity.name || !Number.isSafeInteger(uid) || uid <= 0 ||
      !Number.isSafeInteger(gid) || gid <= 0 || p[5] !== serviceIdentity.home ||
      !['/usr/sbin/nologin', '/sbin/nologin'].includes(p[6]) || g?.[0] !== serviceIdentity.name ||
      Number(g[2]) !== gid || g[3]?.split(',').filter(Boolean).some(name => name !== serviceIdentity.name) ||
      !password || !/^[!*]/.test(password) || groups.trim() !== String(gid)) {
    throw new Error('The identity account must be a dedicated non-root, locked nologin account with only its private group and the managed home; no existing account was modified.');
  }
  return { uid, gid };
}

export function ensureServiceAccount() {
  let passwd = lookup('passwd', serviceIdentity.name);
  if (!passwd) {
    const group = lookup('group', serviceIdentity.name);
    if (group && (Number(group.split(':')[2]) <= 0 || group.split(':')[3])) throw new Error('The identity group is already in use; no account was created.');
    if (!group) command('groupadd', ['--system', serviceIdentity.name]);
    const shell = ['/usr/sbin/nologin', '/sbin/nologin'].find(existsSync);
    if (!shell) throw new Error('A nologin shell is required for the deployment account.');
    command('useradd', ['--system', '--gid', serviceIdentity.name, '--home-dir', serviceIdentity.home, '--no-create-home', '--shell', shell, serviceIdentity.name]);
    passwd = lookup('passwd', serviceIdentity.name);
  }
  return validateServiceAccount(passwd, lookup('group', serviceIdentity.name), lookup('shadow', serviceIdentity.name), command('id', ['-G', serviceIdentity.name]));
}

const contains = (parent, child) => child === parent || child.startsWith(parent + path.sep);
const optionalStat = async file => fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });

/** Refuse links in every ancestor; never chmod a private ancestor to make it traversable. */
export async function assertCanonicalPath(file) {
  if (!path.isAbsolute(file) || path.resolve(file) !== file) throw new Error('Deployment storage paths must be absolute and canonical.');
  let current = path.parse(file).root;
  for (const part of file.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await optionalStat(current);
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new Error(`Deployment storage contains a symbolic link: ${current}. No link was followed.`);
    if (current !== file && !stat.isDirectory()) throw new Error('Deployment storage ancestor is not a directory.');
  }
}

/** Only explicit storage trees and SQLite files are adopted, never the entire database parent. */
export function deploymentStorage(configuration, home = serviceIdentity.home) {
  const databases = [configuration.platformDatabase, configuration.runtimeDatabase];
  const directories = [home, ...databases.map(file => path.dirname(file))];
  const trees = [configuration.records, configuration.state, `${configuration.state}-execution`, configuration.platform.DENTITY_SKILL_RESOURCE_ROOT];
  // A registered execution root is operator-owned configuration, not permission to chown it.
  return { directories, trees, files: databases.flatMap(file => [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) };
}

/** Build a complete metadata journal while services are stopped, before changing ownership. */
export async function planServicePermissions(storage, { protectedPaths = [], containers = ['/var/lib/identity'] } = {}) {
  const entries = new Map();
  const forbidden = ['/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/boot', '/dev', '/proc', '/sys', '/root'];
  const assertTarget = file => {
    if (!file || file.split(path.sep).filter(Boolean).length < 2 || ['/var/lib', '/var/log', '/var/cache', '/var/tmp'].includes(file) || forbidden.some(root => contains(root, file)) ||
        protectedPaths.some(root => contains(root, file) || contains(file, root))) throw new Error(`Unsafe deployment storage scope: ${file}. Relocate storage instead of changing system, source or private configuration permissions; existing configuration is preserved, not reset.`);
  };
  const add = async (file, { directory = false, recursive = false, container = false } = {}) => {
    assertTarget(file);
    await assertCanonicalPath(file);
    const stat = await optionalStat(file);
    if (!stat && !directory) return;
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1) || directory && !stat.isDirectory())) {
      throw new Error(`Unsafe deployment storage entry: ${file}. Symlinks, hardlinks and special files require manual review.`);
    }
    if (!stat) {
      const parent = path.dirname(file);
      if (!await optionalStat(parent)) await add(parent, { directory: true, container: true });
    }
    const mode = container ? 0o711 : directory || stat?.isDirectory() ? 0o700 : 0o600 | (stat.mode & 0o100);
    const prior = entries.get(file);
    // Explicit storage ownership takes precedence over a traversal-only container.
    if (!prior || prior.container && !container) entries.set(file, { file, container, existed: !!stat, mode,
      ...(stat ? { uid: stat.uid, gid: stat.gid, originalMode: stat.mode & 0o7777, dev: stat.dev, ino: stat.ino } : {}) });
    if (recursive && stat?.isDirectory()) {
      for (const name of await fs.readdir(file)) await add(path.join(file, name), { recursive: true });
    }
  };
  for (const file of containers) {
    // Only the managed data container may need its old root-only mode opened for traversal.
    const stat = await optionalStat(file);
    if (stat && stat.uid !== 0 && stat.uid !== process.getuid()) throw new Error('Managed data container has an unexpected owner.');
    await add(file, { directory: true, container: true });
  }
  for (const file of storage.directories) await add(file, { directory: true });
  for (const file of storage.trees) await add(file, { directory: true, recursive: true });
  for (const file of storage.files) {
    const stat = await optionalStat(file);
    if (stat && !stat.isFile()) throw new Error('Configured database is not a regular file.');
    await add(file);
  }
  return [...entries.values()].sort((a, b) => a.file.split(path.sep).length - b.file.split(path.sep).length);
}

async function openEntry(entry) {
  await assertCanonicalPath(entry.file);
  const before = await fs.lstat(entry.file);
  if (!before.isDirectory() && (!before.isFile() || before.nlink !== 1)) throw new Error('Unsafe deployment storage entry during permission update.');
  const handle = await fs.open(entry.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const stat = await handle.stat();
  if ((!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) || entry.existed && (stat.dev !== entry.dev || stat.ino !== entry.ino)) {
    await handle.close(); throw new Error('Deployment storage changed during permission update; manual review is required.');
  }
  return { handle, stat };
}

export async function applyServicePermissions(entries, identity) {
  for (const entry of entries) {
    if (!entry.existed) await fs.mkdir(entry.file, { mode: entry.mode });
    const { handle, stat } = await openEntry(entry);
    try {
      const uid = entry.container ? stat.uid : identity.uid, gid = entry.container ? stat.gid : identity.gid;
      if (stat.uid !== uid || stat.gid !== gid) await handle.chown(uid, gid);
      if ((stat.mode & 0o7777) !== entry.mode) await handle.chmod(entry.mode);
    } finally { await handle.close(); }
  }
}

export async function restoreServicePermissions(entries) {
  for (const entry of [...entries].reverse()) {
    const stat = await optionalStat(entry.file);
    if (!stat) continue; // SQLite may remove its transient WAL/SHM files during shutdown.
    if (!entry.existed) {
      // Never delete newly created business data when rolling back configuration.
      await fs.rmdir(entry.file).catch(error => { if (!['ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; });
      continue;
    }
    const { handle, stat: current } = await openEntry(entry);
    try {
      if (current.uid !== entry.uid || current.gid !== entry.gid) await handle.chown(entry.uid, entry.gid);
      if ((current.mode & 0o7777) !== entry.originalMode) await handle.chmod(entry.originalMode);
    } finally { await handle.close(); }
  }
}

export async function probeServiceAccess(input) {
  if (process.getuid() !== input.uid || process.getgid() !== input.gid || process.getuid() === 0) throw new Error('Unexpected service probe identity.');
  await fs.access(input.root, constants.R_OK | constants.X_OK);
  await fs.access(input.node, constants.R_OK | constants.X_OK);
  for (const file of [...input.entries, ...input.extraFiles]) await fs.access(file, constants.R_OK);
  for (const file of [...input.storage.directories, ...input.storage.trees]) await fs.access(file, constants.R_OK | constants.W_OK | constants.X_OK);
  for (const file of input.storage.files) if (await optionalStat(file)) await fs.access(file, constants.R_OK | constants.W_OK);
  for (const name of ['fastify', '@earendil-works/pi-coding-agent', '@dentity/domain', 'argon2']) await fs.access(fileURLToPath(import.meta.resolve(name)), constants.R_OK);
  await import('argon2');
  if (input.registryPath) {
    const registry = JSON.parse(await fs.readFile(input.registryPath, 'utf8'));
    const { validateRegistry } = await import('../../apps/runtime-host-pi/dist/resources.js');
    validateRegistry(registry);
    for (const resource of registry.executionResources || []) {
      await assertCanonicalPath(resource.root);
      const stat = await optionalStat(resource.root);
      if (stat) {
        if (!stat.isDirectory() || stat.uid !== input.uid || stat.mode & 0o077) throw new Error('Registered execution root must already be private and owned by identity.');
        await fs.access(resource.root, constants.R_OK | constants.W_OK | constants.X_OK);
      } else {
        let parent = path.dirname(resource.root);
        while (!await optionalStat(parent)) parent = path.dirname(parent);
        await fs.access(parent, constants.W_OK | constants.X_OK);
      }
    }
  }
}

/** Exercise real OS access as the service account, with supplementary groups and capabilities removed. */
export function assertServiceAccess({ uid, gid }, { root, node = process.execPath, entries, storage, extraFiles = [], registryPath }) {
  const script = `try { const { probeServiceAccess } = await import(${JSON.stringify(import.meta.url)}); await probeServiceAccess(JSON.parse(process.argv[1])); } catch (error) { console.error('Service access failed: ' + (error.code || error.name) + ' ' + (error.path || '(dependency/registry validation)')); process.exitCode = 1; }`;
  try {
    execFileSync('setpriv', ['--reuid', String(uid), '--regid', String(gid), '--clear-groups', '--no-new-privs', '--bounding-set=-all',
      node, '--input-type=module', '-e', script, JSON.stringify({ uid, gid, root, node, entries, storage, extraFiles, registryPath })], { ...commandOptions, cwd: root });
  } catch (error) {
    const detail = error.stderr?.toString().trim() || 'Unable to execute the configured Node.';
    throw new Error(`The identity service account cannot access the configured runtime. ${detail} Explicitly migrate private storage if needed; /root was not opened.`);
  }
}

export function assertEffectiveServiceIdentity({ user, group, noNewPrivileges, capabilities, ambientCapabilities, supplementaryGroups }) {
  if (user !== serviceIdentity.name || group !== serviceIdentity.name || noNewPrivileges !== 'yes' ||
      capabilities || ambientCapabilities || supplementaryGroups) throw new Error('Conflicting systemd override; expected identity:identity, NoNewPrivileges and no capabilities or supplementary groups.');
}

export function assertServiceProcessIdentity(status, { uid, gid }) {
  const fields = Object.fromEntries(status.split('\n').map(line => {
    const colon = line.indexOf(':'); return [line.slice(0, colon), line.slice(colon + 1).trim()];
  }));
  if (!fields.Uid || !fields.Gid || fields.Uid.split(/\s+/).some(value => Number(value) !== uid) ||
      fields.Gid.split(/\s+/).some(value => Number(value) !== gid) || fields.NoNewPrivs !== '1' ||
      ['CapEff', 'CapPrm', 'CapBnd', 'CapAmb'].some(key => !/^0+$/.test(fields[key] || ''))) {
    throw new Error('The running service did not retain its expected non-root identity and privilege restrictions.');
  }
}
