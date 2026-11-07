// Modified for Identale; see the root NOTICE.
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const commands = { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000,
  maxBuffer: 16 * 1024 * 1024, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C' } };
const inside = (parent, file) => file === parent || file.startsWith(parent + path.sep);
const privateName = name => ['.git', '.ssh', '.identale', '.dentity', 'local-secrets.json', '.env'].includes(name) || name.startsWith('.env.');
const bits = text => (text.includes('r') ? 4 : 0) | (text.includes('w') ? 2 : 0) | (text.includes('x') ? 1 : 0);
const permissions = value => `${value & 4 ? 'r' : '-'}${value & 2 ? 'w' : '-'}${value & 1 ? 'x' : '-'}`;
function entries(acl) {
  return acl.split('\n').filter(line => line && !line.startsWith('#')).map(line => {
    const match = /^(user|group|mask|other):([0-9]*):([r-][w-][x-])(?:\s+#.*)?$/.exec(line);
    if (!match) throw new Error('Unsupported checkout access ACL.');
    return { kind: match[1], id: match[2], value: bits(match[3]) };
  });
}
function aclText(rows) {
  const order = { user: 0, group: 1, mask: 2, other: 3 };
  return [...rows].sort((a, b) => order[a.kind] - order[b.kind] || (a.id === '' ? -1 : Number(a.id)) - (b.id === '' ? -1 : Number(b.id)))
    .map(row => `${row.kind}:${row.id}:${permissions(row.value)}`).join('\n') + '\n';
}

/** Add only the requested access; expanding the mask must not unmask other users/groups. */
export function checkoutAcl(acl, stat, identity, required) {
  const rows = entries(acl), get = (kind, id = '') => rows.find(row => row.kind === kind && row.id === id)?.value;
  const mask = get('mask') ?? 7;
  let effective;
  if (stat.uid === identity.uid) effective = get('user');
  else if (get('user', String(identity.uid)) !== undefined) effective = get('user', String(identity.uid)) & mask;
  else {
    const groups = rows.filter(row => row.kind === 'group' && (row.id ? Number(row.id) === identity.gid : stat.gid === identity.gid));
    effective = groups.length ? groups.reduce((value, row) => value | row.value, 0) & mask : get('other');
  }
  if (effective === undefined) throw new Error('Incomplete checkout access ACL.');
  if ((effective & required) === required) return undefined;
  if (stat.uid === identity.uid) rows.find(row => row.kind === 'user' && row.id === '').value |= required;
  else {
    for (const row of rows) if (row.kind === 'group' || row.kind === 'user' && row.id) row.value &= mask;
    let user = rows.find(row => row.kind === 'user' && row.id === String(identity.uid));
    if (!user) { user = { kind: 'user', id: String(identity.uid), value: effective }; rows.push(user); }
    user.value |= required;
    let limit = rows.find(row => row.kind === 'mask');
    if (!limit) { limit = { kind: 'mask', id: '', value: get('group') ?? 0 }; rows.push(limit); }
    limit.value |= required;
  }
  return aclText(rows);
}

async function canonical(file) {
  if (!path.isAbsolute(file) || /[\x00-\x1f\x7f\\]/.test(file) || path.resolve(file) !== file) throw new Error(`Unsupported checkout access path: ${file}`);
  if (inside('/root', file)) throw new Error(`Private root path cannot be granted to identity: ${file}. Place the checkout/Node outside /root.`);
  if (await fs.realpath(file) !== file) throw new Error(`Checkout access path contains a symbolic link: ${file}`);
}

/** Explicit runtime trees only. No recursive grant on the checkout or its home. */
export async function checkoutAccessTargets({ root, node, entries: serviceEntries = [], runtime = true }) {
  await canonical(root); await canonical(node);
  if (['/', '/home', '/opt', '/srv', '/var', '/usr', '/etc', '/var/lib'].includes(root) || inside('/etc', root) || inside('/usr', root)) throw new Error(`Unsafe checkout root: ${root}`);
  const targets = new Map();
  const add = async (file, required) => {
    await canonical(file);
    const stat = await fs.lstat(file);
    if (!stat.isDirectory() && !stat.isFile()) throw new Error(`Unsupported runtime file: ${file}`);
    targets.set(file, { file, required: (targets.get(file)?.required ?? 0) | required, stat });
    let parent = path.dirname(file);
    while (!targets.has(parent)) {
      await canonical(parent);
      targets.set(parent, { file: parent, required: 1, stat: await fs.lstat(parent) });
      const next = path.dirname(parent); if (next === parent) break; parent = next;
    }
  };
  await add(root, 5); await add(node, 5);
  await add(path.join(root, 'package.json'), 4);
  await add(path.join(root, 'scripts/deploy/deployment-identity.mjs'), 4);
  if (!runtime) return [...targets.values()];
  const dependencyRoot = path.join(root, 'node_modules');
  const workspaces = [];
  for (const item of await fs.readdir(path.join(root, 'packages'), { withFileTypes: true })) {
    if (!item.isDirectory() || privateName(item.name)) continue;
    const workspace = path.join(root, 'packages', item.name);
    await add(path.join(workspace, 'package.json'), 4);
    workspaces.push(workspace);
  }
  const trees = new Set([dependencyRoot, ...workspaces.map(file => path.join(file, 'dist'))]);
  const workspaceLinks = new Set(workspaces);
  for (const item of await fs.readdir(path.join(root, 'apps'), { withFileTypes: true })) {
    if (item.isDirectory() && !privateName(item.name)) workspaceLinks.add(path.join(root, 'apps', item.name));
  }
  for (const entry of serviceEntries) {
    if (!inside(root, entry) || !/^apps\/[^/]+\/dist\/.+/.test(path.relative(root, entry))) throw new Error(`Unsupported service entry: ${entry}`);
    trees.add(path.join(root, ...path.relative(root, entry).split(path.sep).slice(0, 3)));
    await add(path.join(root, ...path.relative(root, entry).split(path.sep).slice(0, 2), 'package.json'), 4);
  }
  const seen = new Set();
  const visit = async file => {
    if (privateName(path.basename(file)) || seen.has(file)) return;
    seen.add(file);
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) {
      const target = await fs.realpath(file);
      if (target.split(path.sep).some(privateName)) throw new Error(`Private runtime link target: ${file}`);
      // npm workspace links resolve to manifests and dist, never the entire workspace.
      if (workspaceLinks.has(target)) return;
      if (![...trees].some(tree => inside(tree, target)) && !workspaces.some(workspace => target === path.join(workspace, 'package.json'))) throw new Error(`Runtime link leaves approved trees: ${file}`);
      await visit(target); return;
    }
    await add(file, stat.isDirectory() || stat.mode & 0o111 ? 5 : 4);
    if (stat.isDirectory()) for (const name of await fs.readdir(file)) await visit(path.join(file, name));
  };
  for (const tree of trees) await visit(tree);
  return [...targets.values()];
}

export function requireCheckoutAclTools() {
  for (const tool of ['getfacl', 'setfacl']) {
    try { execFileSync(tool, ['--version'], commands); }
    catch { throw new Error(`Checkout access requires ${tool}; install the Debian/Ubuntu acl package or omit --skip-install.`); }
  }
}

export async function planCheckoutAcls(identity, input) {
  requireCheckoutAclTools();
  const targets = await checkoutAccessTargets(input), plan = [];
  // Batch reads: dependency trees may contain tens of thousands of files.
  for (let offset = 0; offset < targets.length; offset += 128) {
    const batch = targets.slice(offset, offset + 128);
    const text = execFileSync('getfacl', ['--absolute-names', '--numeric', '--access', '--', ...batch.map(entry => entry.file)], commands);
    const blocks = text.trimEnd().split(/\n\n+/);
    if (blocks.length !== batch.length) throw new Error('Unable to snapshot checkout ACLs.');
    for (let index = 0; index < batch.length; index++) {
      const { file, required, stat } = batch[index];
      const acl = blocks[index].split('\n').filter(line => !line.startsWith('#')).join('\n') + '\n';
      const updated = checkoutAcl(acl, stat, identity, required);
      if (!updated) continue;
      if (stat.isFile() && stat.nlink !== 1) throw new Error(`Refusing ACL change on a hardlinked runtime file: ${file}`);
      // Never repair access to operating-system ancestors or other private roots.
      if (!inside(input.root, file) && !inside('/home', file) && !inside('/opt', file) && !inside('/srv', file) && file !== input.node) throw new Error(`Refusing ACL change on an unmanaged ancestor: ${file}`);
      plan.push({ file, dev: stat.dev, ino: stat.ino, directory: stat.isDirectory(), acl, updated });
    }
  }
  return plan;
}

async function setAcl(entry, acl, restoring = false) {
  await canonical(entry.file);
  const handle = await fs.open(entry.file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (stat.dev !== entry.dev || stat.ino !== entry.ino || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) throw new Error(`Checkout file changed after ACL planning: ${entry.file}`);
    // Pin the inode while the external utility runs; do not follow a replaced pathname.
    const pinned = `/proc/${process.pid}/fd/${handle.fd}`;
    const current = aclText(entries(execFileSync('getfacl', ['--omit-header', '--numeric', '--access', '--', pinned], commands)));
    if (current !== aclText(entries(entry.acl)) && (!restoring || current !== aclText(entries(entry.updated)))) throw new Error(`Checkout ACL changed concurrently: ${entry.file}`);
    execFileSync('setfacl', ['--no-mask', '--set-file=-', '--', pinned], { ...commands, input: acl });
  } finally { await handle.close(); }
}

/** The caller owns changes even if a later mutation fails. Journal every entry before applying. */
export async function applyCheckoutAcls(plan, changes, journal) {
  const checkedDevices = new Set();
  for (const entry of plan) {
    if (!checkedDevices.has(entry.dev)) {
      // Unsupported filesystems must fail on a disposable file, before setfacl
      // can fall back to changing the real target's ordinary permission bits.
      const directory = entry.directory ? entry.file : path.dirname(entry.file);
      await canonical(directory);
      const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const probe = `/proc/${process.pid}/fd/${handle.fd}/.identale-acl-probe-${randomUUID()}`;
      try {
        const stat = await handle.stat();
        if (stat.dev !== entry.dev || entry.directory && stat.ino !== entry.ino) throw new Error('ACL probe directory changed.');
        await fs.writeFile(probe, '', { flag: 'wx', mode: 0o600 });
        execFileSync('setfacl', ['--no-mask', '-m', 'u:0:---,m::---', '--', probe], commands);
        if (!/^user:0:---$/m.test(execFileSync('getfacl', ['-c', '-n', '--access', '--', probe], commands))) throw new Error('Named ACL was not retained.');
      } catch { throw new Error(`Filesystem does not support the required checkout ACLs: ${entry.file}`); }
      finally { try { await fs.rm(probe, { force: true }); } finally { await handle.close(); } }
      checkedDevices.add(entry.dev);
    }
    await journal.write(JSON.stringify(entry) + '\n'); await journal.sync();
    changes.push(entry);
    await setAcl(entry, entry.updated);
  }
}

export async function restoreCheckoutAcls(changes) {
  const errors = [];
  for (const entry of [...changes].reverse()) {
    try { await setAcl(entry, entry.acl, true); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, `Unable to restore checkout ACL: ${errors[0].message}`);
}

export function assertCheckoutAccess(identity, { root, node }) {
  const script = 'const fs=require("node:fs");for(const p of process.argv.slice(1))fs.accessSync(p,fs.constants.R_OK|fs.constants.X_OK)';
  try {
    execFileSync('setpriv', ['--reuid', String(identity.uid), '--regid', String(identity.gid), '--clear-groups', '--no-new-privs', '--bounding-set=-all', node, '-e', script, root, node], { ...commands, cwd: root });
  } catch { throw new Error(`identity cannot access checkout ${root} or Node ${node}; verify the filesystem supports ACLs.`); }
}
