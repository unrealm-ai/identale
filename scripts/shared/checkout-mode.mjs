// Modified for Identale; see the root NOTICE.
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { processIdentity, sameProcess } from '../local/local-recovery.mjs';

// Checkout-local metadata is intentionally independent of HOME and UID. Local
// leases may overlap only for the existing same-user restart handover. A host
// installer excludes every local lease, including one owned by another user.
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
async function recordAt(file) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2048 || stat.mode & 0o022) throw new Error('Unsafe checkout mode record; startup refused.');
    const data = JSON.parse(await handle.readFile('utf8'));
    if (!data || !['local', 'host'].includes(data.mode) || !/^[a-f0-9-]{36}$/.test(data.id) || !data.owner || !Number.isSafeInteger(data.owner.pid) || data.owner.pid < 1 || !Number.isSafeInteger(data.owner.pgid) || data.owner.pgid < 1 || data.owner.uid !== stat.uid || typeof data.owner.start !== 'string' || !data.owner.start) throw new Error('Invalid checkout mode record; startup refused.');
    return { data, stat };
  } finally { await handle.close(); }
}
async function checkedDirectory(folder) {
  const stat = await fs.lstat(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o022) throw new Error('Unsafe checkout mode directory; startup refused.');
  return stat;
}
async function unlinkRecord(file, record) {
  if (!sameFile(await fs.lstat(file), record.stat)) throw new Error('Checkout mode record changed; startup refused.');
  await fs.unlink(file);
}
async function transition(root, data, action) {
  const gate = path.join(root, '.identale-mode-transition');
  const deadline = Date.now() + 2500;
  for (;;) {
    try { await fs.mkdir(gate, { mode: 0o755 }); break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    let stat;
    try { stat = await checkedDirectory(gate); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    let old;
    try { old = await recordAt(path.join(gate, 'owner.json')); }
    catch (error) {
      if (error.code !== 'ENOENT' || Date.now() >= deadline) throw new Error('Unverifiable checkout mode transition; inspect it before retrying.');
    }
    if (old && !sameProcess(await processIdentity(old.data.owner.pid), old.data.owner)) {
      const reclaim = path.join(gate, 'reclaiming');
      try { await fs.mkdir(reclaim); }
      catch (error) { if (error.code !== 'EEXIST' && error.code !== 'ENOENT') throw error; continue; }
      try {
        if (!sameFile(await fs.lstat(gate), stat)) throw new Error('Checkout mode transition changed.');
        await unlinkRecord(path.join(gate, 'owner.json'), old);
      } finally { await fs.rmdir(reclaim); }
      await fs.rmdir(gate);
      continue;
    }
    if (Date.now() >= deadline) throw new Error('Another checkout mode transition is running; retry after it completes.');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  try {
    await fs.writeFile(path.join(gate, 'owner.json'), JSON.stringify(data), { flag: 'wx', mode: 0o644 });
    return await action();
  } finally {
    await fs.unlink(path.join(gate, 'owner.json'));
    await fs.rmdir(gate);
  }
}

export async function claimCheckoutMode(root, mode) {
  if (!['local', 'host'].includes(mode)) throw new Error('Invalid checkout startup mode.');
  root = await fs.realpath(root);
  const owner = await processIdentity(process.pid);
  if (!owner) throw new Error('Checkout mode process identity unavailable.');
  const data = { mode, id: randomUUID(), owner: { pid: owner.pid, pgid: owner.pgid, uid: owner.uid, start: owner.start } };
  const folder = path.join(root, '.identale-mode');
  const file = path.join(folder, `${data.id}.json`);
  let ownRecord;
  const stale = [];
  await transition(root, data, async () => {
    const leases = [];
    try {
      await checkedDirectory(folder);
      for (const name of await fs.readdir(folder)) {
        if (!/^[a-f0-9-]{36}\.json$/.test(name)) throw new Error('Unknown checkout mode record; startup refused.');
        const target = path.join(folder, name), record = await recordAt(target);
        if (sameProcess(await processIdentity(record.data.owner.pid), record.data.owner)) leases.push(record.data);
        else {
          // A dead manager can leave a detached build or service behind. Only
          // its own mode may perform the existing recovery before a handover.
          if (record.data.mode !== mode) throw new Error('The other startup mode did not release this checkout. Retry that mode to verify cleanup before switching.');
          stale.push({ target, record });
        }
      }
      // An empty root-owned directory can be removed by the checkout owner;
      // recreate it rather than changing ownership or permissions in place.
      if (!leases.length && !stale.length) await fs.rmdir(folder);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (leases.some(lease => mode !== 'local' || lease.mode !== 'local' || lease.owner.uid !== owner.uid)) throw new Error('A local launcher or host deployment from this checkout is running; the other mode is refused. Stop it before switching modes.');
    if (!leases.length && !stale.length) await fs.mkdir(folder, { mode: 0o755 });
    await fs.writeFile(file, JSON.stringify(data), { flag: 'wx', mode: 0o644 });
    ownRecord = await recordAt(file);
  });
  let released;
  return { release({ cleanupConfirmed = true, recovered = false } = {}) {
    return released ??= transition(root, data, async () => {
      await checkedDirectory(folder);
      // A failed startup must not erase another manager's unverified cleanup.
      // The caller certifies recovery only after its existing recovery flow ran.
      if (recovered) for (const { target, record } of stale) {
        try { await unlinkRecord(target, record); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (cleanupConfirmed) await unlinkRecord(file, ownRecord);
      if (!(await fs.readdir(folder)).length) await fs.rmdir(folder);
    });
  } };
}
