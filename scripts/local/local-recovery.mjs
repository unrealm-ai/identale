// Modified for Identale; see the root NOTICE.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { launcherObserverParentPid } from './local-process-diagnostics.mjs';

const exec = promisify(execFile);
const env = { PATH: '/usr/bin:/bin:/usr/sbin', LC_ALL: 'C' };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const options = { env, timeout: 2000, maxBuffer: 4 * 1024 * 1024 };
const gone = error => ['ENOENT', 'ESRCH'].includes(error.code);

// Do not persist or log command arguments or environments: they may contain secrets.
export async function processTable() {
  const { stdout } = await exec('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid=,uid=,lstart=,stat=,comm='], options);
  return stdout.trim().split('\n').filter(Boolean).map(line => {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 11) throw new Error('Process identity inspection unavailable.');
    return { pid: Number(fields[0]), ppid: Number(fields[1]), pgid: Number(fields[2]), uid: Number(fields[3]), start: fields.slice(4, 9).join(' '), stat: fields[9], executable: fields.slice(10).join(' ') };
  }).filter(row => !row.stat.startsWith('Z'));
}
export async function processIdentity(pid) {
  return (await processTable()).find(row => row.pid === pid) ?? null;
}
export const sameProcess = (a, b) => !!a && !!b && a.pid === b.pid && a.start === b.start && a.uid === b.uid && a.pgid === b.pgid;

async function commandLine(pid, environment = false) {
  try {
    return (await exec('/bin/ps', [...(environment ? ['eww'] : ['-ww']), '-p', String(pid), '-o', 'command='], options)).stdout.trim();
  } catch (error) { if (error.code === 1 && !error.stdout) return null; throw error; }
}
async function marked(pid, marker) {
  if (process.platform === 'linux') {
    try { return (await fs.readFile(`/proc/${pid}/environ`, 'utf8')).split('\0').includes(`DENTITY_LOCAL_INSTANCE=${marker}`); }
    catch (error) { if (gone(error)) return false; throw error; }
  }
  const command = await commandLine(pid, true);
  return command !== null && new RegExp(`(?:^|\\s)DENTITY_LOCAL_INSTANCE=${marker}(?=\\s|$)`).test(command);
}
async function cwdOf(pid) {
  if (process.platform === 'linux') {
    try { return await fs.realpath(`/proc/${pid}/cwd`); } catch (error) { if (gone(error)) return null; throw error; }
  }
  try {
    const { stdout } = await exec('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], options);
    const cwd = stdout.split('\n').find(line => line.startsWith('n'))?.slice(1);
    return cwd ? await fs.realpath(cwd).catch(error => { if (gone(error)) return null; throw error; }) : null;
  } catch (error) { if (error.code === 1 && !error.stdout) return null; throw error; }
}
// Retain removed launcher entries only to identify live legacy installations
// during their first handover to the current launcher.
const entries = ['scripts/local-start.mjs', 'scripts/local-manager-entry.mjs', 'scripts/local/local-start.mjs', 'scripts/local/local-manager-entry.mjs', 'scripts/start-local.mjs', 'scripts/local-process-group.mjs', 'apps/control-plane/dist/main.js', 'apps/control-plane/dist/runtime-main.js', 'apps/runtime-host-pi/dist/main.js', 'apps/mock-model/dist/main.js', 'apps/mock-model/dist/mcp-main.js', 'node_modules/vite/bin/vite.js'];
async function legacyEntry(row, root, { allUsers = false, ignoreServer = false } = {}) {
  if ((!allUsers && row.uid !== process.getuid()) || row.pid === process.pid || row.pid === launcherObserverParentPid()) return false;
  let executable = row.executable;
  if (process.platform === 'linux') {
    try { executable = await fs.readlink(`/proc/${row.pid}/exe`); }
    catch (error) { if (gone(error)) return false; throw error; }
  }
  if (path.basename(executable) !== 'node') return false;
  // Require Node's first script argument, never a matching string in node -e.
  // Linux argv boundaries also preserve managed runtime paths containing spaces.
  if (process.platform === 'linux') {
    let argv;
    try { argv = (await fs.readFile(`/proc/${row.pid}/cmdline`, 'utf8')).split('\0'); }
    catch (error) { if (gone(error)) return false; throw error; }
    if (!entries.some(entry => [entry, path.join(root, entry)].includes(argv[1]))) return false;
  } else {
    const command = await commandLine(row.pid);
    if (!command) return false;
    const prefix = executable + ' ';
    const args = command.startsWith(prefix) ? command.slice(prefix.length) : /^(?:\S*\/)?node\s+/.test(command) ? command.replace(/^(?:\S*\/)?node\s+/, '') : null;
    if (!args || !entries.some(entry => [entry, path.join(root, entry)].some(file => args === file || args.startsWith(file + ' ')))) return false;
  }
  if (await cwdOf(row.pid) !== root) return false;
  if (process.platform === 'linux') {
    try {
      const cgroup = await fs.readFile(`/proc/${row.pid}/cgroup`, 'utf8');
      const environment = await fs.readFile(`/proc/${row.pid}/environ`, 'utf8');
      if (/\/identity-[^/\n]+\.service(?:\/|$)/m.test(cgroup) || environment.split('\0').includes('DENTITY_DEPLOYMENT=server')) {
        if (ignoreServer) return false;
        throw new Error('A server instance from this checkout is running; local startup/recovery refused. No server process was stopped.');
      }
    } catch (error) { if (gone(error)) return false; throw error; }
  }
  return true;
}

export async function assertNoServerInstance(root) {
  root = await fs.realpath(root);
  // Check again after the checkout lease is acquired. The shell's earlier
  // check alone races a concurrent deployment and cannot see its future units.
  if (process.platform === 'linux' && await fs.access('/run/systemd/system').then(() => true, () => false)) {
    for (const name of ['control-plane', 'runtime', 'runtime-host', 'rule-model', 'mock-mcp']) {
      const { stdout } = await exec('systemctl', ['show', `identity-${name}.service`, '-p', 'LoadState', '-p', 'WorkingDirectory', '-p', 'ActiveState'], options).catch(error => {
        if (error.code === 1 && /LoadState=not-found/.test(error.stdout ?? '')) return { stdout: error.stdout };
        throw error;
      });
      const values = Object.fromEntries(stdout.trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
      const directory = values.WorkingDirectory && await fs.realpath(values.WorkingDirectory).catch(() => null);
      if (directory === root && values.ActiveState && !['inactive', 'failed'].includes(values.ActiveState)) throw new Error('A server instance from this checkout is running; local startup/recovery refused. No server process was stopped.');
    }
  }
  for (const row of await processTable()) await legacyEntry(row, root);
}

export async function assertNoLocalProcesses(root) {
  root = await fs.realpath(root);
  for (const row of await processTable()) {
    if (await legacyEntry(row, root, { allUsers: true, ignoreServer: true })) throw new Error('A local launcher from this checkout is running. Stop it before server deployment; no local process was stopped.');
  }
}

/** Recover only this repository's marked groups or exact legacy entry points. */
export async function recoverProcesses(root, record, { timeoutMs = 18000, graceMs, signal, log = console.log, includeLegacy = true, onSignal } = {}) {
  const groups = record?.groups ?? [];
  const owned = new Map();
  const check = () => { if (signal?.aborted) throw new Error('Local restart interrupted.'); };
  async function discover() {
    check();
    const rows = await processTable();
    for (const group of groups) {
      const members = rows.filter(row => row.pgid === group.pid);
      for (const row of members) {
        if (row.uid === process.getuid() && row.pid !== process.pid && await marked(row.pid, group.marker)) owned.set(row.pid, { ...row, marker: group.marker });
      }
      // An absent leader with unmarked members is ambiguous; do not declare
      // cleanup complete just because the original listening port is now free.
      if (members.length && !members.some(row => owned.has(row.pid)) && !members.some(row => row.pid === group.pid && !sameProcess(row, group))) {
        throw new Error('Residual process group identity cannot be verified; no unrelated process was signalled.');
      }
    }
    const seeds = [];
    if (includeLegacy) for (const row of rows) if (!owned.has(row.pid) && await legacyEntry(row, root)) seeds.push(row);
    for (const row of seeds) owned.set(row.pid, { ...row, legacy: true });
    // Capture live descendants while their parent relationship is still known.
    let changed;
    do {
      changed = false;
      for (const row of rows) if (row.pid !== process.pid && row.uid === process.getuid() && !owned.has(row.pid) && owned.has(row.ppid) && sameProcess(rows.find(parent => parent.pid === row.ppid), owned.get(row.ppid))) {
        owned.set(row.pid, { ...row, descendant: true }); changed = true;
      }
    } while (changed);
    return rows;
  }
  async function survivors() {
    const rows = await discover();
    return [...owned.values()].filter(saved => sameProcess(rows.find(row => row.pid === saved.pid), saved));
  }
  async function send(saved, name) {
    check();
    if (!sameProcess(await processIdentity(saved.pid), saved)) return;
    if (saved.marker && !await marked(saved.pid, saved.marker)) {
      // A previous TERM (or another owned process stopping) can complete while
      // ps/proc inspects this PID. Absence is exit, not a changed live identity.
      if (!sameProcess(await processIdentity(saved.pid), saved)) return;
      throw new Error('Residual process marker changed; cleanup stopped.');
    }
    if (saved.legacy && !await legacyEntry(saved, root)) {
      if (!sameProcess(await processIdentity(saved.pid), saved)) return;
      throw new Error('Residual process entry changed; cleanup stopped.');
    }
    // Never signal a saved negative PGID, which may have been recycled.
    try { process.kill(saved.pid, name); onSignal?.(saved.pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  let remaining = await survivors();
  if (remaining.length) log(`Cleaning ${remaining.length} verified local residual process(es)…`);
  const deadline = Date.now() + timeoutMs;
  const forceAt = Date.now() + (graceMs ?? Math.min(1200, Math.max(100, timeoutMs / 2)));
  const terminated = new Set(), killed = new Set();
  while (remaining.length) {
    check();
    const force = Date.now() >= forceAt, sent = force ? killed : terminated;
    for (const saved of remaining) {
      const key = `${saved.pid}:${saved.start}`;
      if (!sent.has(key)) { await send(saved, force ? 'SIGKILL' : 'SIGTERM'); sent.add(key); }
    }
    if (Date.now() >= deadline) throw new Error('Timed out cleaning verified local residual processes.');
    await pause(40); remaining = await survivors();
  }
  check();
}
