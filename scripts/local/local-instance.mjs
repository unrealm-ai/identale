// Modified for Identale; see the root NOTICE.
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { processIdentity, recoverProcesses, sameProcess } from './local-recovery.mjs';
import { prepareLauncherDirectory } from '../shared/local-paths.mjs';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const same = (a, b) => a.ino === b.ino && a.dev === b.dev;
const uid = () => process.getuid();
const validIdentity = value => value && Number.isSafeInteger(value.pid) && value.pid > 0 && Number.isSafeInteger(value.pgid) && value.pgid > 0 && Number.isSafeInteger(value.uid) && value.uid >= 0 && typeof value.start === 'string' && value.start.length > 0 && value.start.length < 64;
function owned(stat, mode, kind) {
  if (stat.isSymbolicLink() || stat.uid !== uid() || (stat.mode & 0o777) !== mode) throw new Error(`Unsafe local launcher ${kind}; no existing process was stopped.`);
}
async function stateAt(file) {
  let handle, observed;
  try {
    observed = await fs.lstat(file); owned(observed, 0o600, 'state');
    if (!observed.isFile() || observed.nlink !== 1 || observed.size > 4096) throw new Error('Invalid local launcher state.');
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const stat = await handle.stat(); owned(stat, 0o600, 'state');
    if (!same(stat, observed) || !stat.isFile() || stat.nlink !== 1 || stat.size > 4096) throw new Error('Invalid or replaced local launcher state.');
    let data; try { data = JSON.parse(await handle.readFile('utf8')); } catch { throw new Error('Invalid local launcher state JSON.'); }
    if (!data || typeof data !== 'object' || data.version !== 1 || typeof data.root !== 'string' || !Number.isSafeInteger(data.pid) || data.pid < 1 || !/^[a-f0-9-]{36}$/.test(data.instance) || data.cleanupUnverified !== undefined && typeof data.cleanupUnverified !== 'boolean' || !Array.isArray(data.ports) || !data.ports.length || data.ports.length > 16 || data.ports.some(p => !Number.isSafeInteger(p) || p < 1 || p > 65535) || new Set(data.ports).size !== data.ports.length) throw new Error('Invalid local launcher state fields.');
    if (data.owner !== undefined && (!validIdentity(data.owner) || data.owner.pid !== data.pid) || data.groups !== undefined && (!Array.isArray(data.groups) || data.groups.length > 16 || data.groups.some(group => !validIdentity(group) || group.pid !== group.pgid || !/^[a-f0-9-]{36}$/.test(group.marker)))) throw new Error('Invalid local launcher process identities.');
    return { data, stat };
  } finally { await handle.close(); }
}
async function unlinkSame(file, stat) {
  try { if (same(await fs.lstat(file), stat)) await fs.unlink(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function unlinkRecord(file, record) {
  const current = await stateAt(file);
  if (current && same(current.stat, record.stat) && current.data.instance === record.data.instance && current.data.root === record.data.root) await unlinkSame(file, current.stat);
}
async function markUnverified(file, record) {
  const current = await stateAt(file);
  if (!current || !same(current.stat, record.stat) || current.data.instance !== record.data.instance) throw new Error('Local state changed before cleanup status could be recorded.');
  const handle = await fs.open(file, constants.O_WRONLY | constants.O_NOFOLLOW);
  try {
    if (!same(await handle.stat(), current.stat)) throw new Error('Local state changed before cleanup status could be recorded.');
    await handle.truncate(0); await handle.writeFile(JSON.stringify({ ...current.data, cleanupUnverified: true })); await handle.sync();
  } finally { await handle.close(); }
}
async function socketStat(file) {
  try { const stat = await fs.lstat(file); owned(stat, 0o600, 'socket'); if (!stat.isSocket()) throw new Error('Launcher control path is not a socket.'); return stat; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export function requestInstance(socketPath, expected, action, { timeoutMs = 18000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath); let body = Buffer.alloc(0), done = false;
    const end = (error, value) => {
      if (done) return; done = true; clearTimeout(deadline);
      signal?.removeEventListener('abort', cancel);
      socket.off('connect', connected); socket.off('data', received); socket.off('end', ended); socket.off('error', failed);
      // A queued connection error can still arrive after destroy; it must not
      // become an uncaught error after the request's listeners were removed.
      socket.once('error', () => {}); socket.destroy(); error ? reject(error) : resolve(value);
    };
    const cancel = () => end(new Error('Local restart interrupted.'));
    const failed = error => end(error);
    const connected = () => socket.write(JSON.stringify({ version: 1, root: expected.root, instance: expected.instance, action }) + '\n');
    const ended = () => end(new Error('Previous local instance closed without a complete response.'));
    const received = chunk => {
      if (body.length + chunk.length > 4096) { end(new Error('Invalid local instance response.')); return; }
      body = Buffer.concat([body, chunk]);
      const newline = body.indexOf(10); if (newline < 0) return;
      let reply; try { reply = JSON.parse(body.subarray(0, newline).toString('utf8')); } catch { end(new Error('Invalid local instance response.')); return; }
      if (!reply || typeof reply !== 'object' || reply.version !== 1 || reply.root !== expected.root || reply.instance !== expected.instance || reply.pid !== expected.pid || JSON.stringify(reply.ports) !== JSON.stringify(expected.ports)) { end(new Error('Local instance identity mismatch; no process was stopped.')); return; }
      if (reply.action !== action) { end(new Error('Previous local instance response action mismatch.')); return; }
      if (reply.error) {
        const error = new Error('Previous local instance could not confirm safe cleanup.');
        if (action === 'stop' && reply.error === 'cleanup_unverified') error.code = 'LOCAL_CLEANUP_UNVERIFIED';
        end(error); return;
      }
      end(null, reply);
    };
    const deadline = setTimeout(() => end(new Error('Previous local instance exceeded its absolute deadline; no PID was signalled.')), timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) { cancel(); return; }
    socket.once('error', failed); socket.once('connect', connected); socket.on('data', received); socket.once('end', ended);
  });
}
/** API options are for isolated tests. CLI always uses its canonical repository. */
export async function claimLocalInstance({ root, ports, signalSource = process, log = console.log, stopTimeoutMs = 18000 }) {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Managed local restart requires macOS or Linux.');
  if (!Array.isArray(ports) || !ports.length || ports.length > 16 || ports.some(p => !Number.isSafeInteger(p) || p < 1 || p > 65535) || new Set(ports).size !== ports.length) throw new Error('Invalid local instance ports.');
  root = await fs.realpath(root);
  const folder = prepareLauncherDirectory(root);
  const gate = path.join(folder, 'starting'), stateFile = path.join(folder, 'instance.json'), socketPath = path.join(folder, 'control.sock');
  if (Buffer.byteLength(socketPath) > 100) throw new Error('Local launcher control path is too long for a Unix socket.');
  const ownerIdentity = await processIdentity(process.pid);
  if (!ownerIdentity) throw new Error('Launcher process identity unavailable.');
  try { await fs.mkdir(gate, { mode: 0o700 }); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const staleStat = await fs.lstat(gate); owned(staleStat, 0o700, 'startup gate');
    const ownerFile = path.join(gate, 'owner.json'), previous = await stateAt(ownerFile);
    const live = previous && await processIdentity(previous.data.pid);
    if (!previous || previous.data.root !== root || live && (!previous.data.owner || sameProcess(live, previous.data.owner))) throw new Error('Another startup or an unverifiable stale startup gate exists; no process was stopped.');
    // Only one contender may reclaim this dead owner's gate. Empty gates from
    // an in-progress mkdir/write pair are deliberately never considered stale.
    const reclaim = path.join(gate, 'reclaiming');
    try { await fs.mkdir(reclaim, { mode: 0o700 }); } catch { throw new Error('Another startup is reclaiming the stale startup gate.'); }
    try {
      if (!same(await fs.lstat(gate), staleStat)) throw new Error('Startup gate changed.');
      await unlinkRecord(ownerFile, previous);
    } finally { await fs.rmdir(reclaim); }
    await fs.rmdir(gate);
    try { await fs.mkdir(gate, { mode: 0o700 }); } catch { throw new Error('Another startup acquired the recovered startup gate.'); }
    log('Recovered a stale startup gate.');
  }
  const gateStat = await fs.lstat(gate), instance = randomUUID();
  let gateHeld = true, server, stopHandler, closePromise;
  const abort = new AbortController();
  let cancelledSignal;
  const startupHandlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, () => { cancelledSignal ??= signal; abort.abort(); }]));
  for (const [signal, handler] of startupHandlers) signalSource.on(signal, handler);
  const releaseGate = async () => {
    if (!gateHeld) return;
    for (const [signal, handler] of startupHandlers) signalSource.off(signal, handler);
    const stat = await fs.lstat(gate).catch(() => null);
    if (stat && same(stat, gateStat)) {
      const ownerFile = path.join(gate, 'owner.json'), owner = await stateAt(ownerFile);
      if (owner && owner.data.instance !== instance) throw new Error('Startup gate ownership changed; it was retained for inspection.');
      if (owner) await unlinkRecord(ownerFile, owner);
      await fs.rmdir(gate);
    }
    gateHeld = false;
  };
  const compact = value => ({ pid: value.pid, pgid: value.pgid, uid: value.uid, start: value.start });
  const data = { version: 1, root, instance, pid: process.pid, ports, owner: compact(ownerIdentity), groups: [] };
  let state, updates = Promise.resolve();
  try {
    await fs.writeFile(path.join(gate, 'owner.json'), JSON.stringify(data), { flag: 'wx', mode: 0o600 });
    const previous = await stateAt(stateFile), socket = await socketStat(socketPath);
    if (previous) {
      if (previous.data.root !== root) throw new Error('Local state belongs to another repository; no process was stopped.');
      const recoverPrevious = async (waitForExit = false) => {
        if (waitForExit) {
          // Allow an exiting old manager to finish, then use exact entry/cwd
          // verification to stop any manager or service it left running.
          const deadline = Date.now() + 250;
          while (sameProcess(await processIdentity(previous.data.pid), previous.data.owner)) {
            if (abort.signal.aborted) throw new Error('Local restart interrupted.');
            if (Date.now() >= deadline) break;
            await pause(20);
          }
        }
        const oldOwner = await processIdentity(previous.data.pid);
        await recoverProcesses(root, previous.data, { timeoutMs: stopTimeoutMs, signal: abort.signal, log });
        const currentOwner = await processIdentity(previous.data.pid);
        const ownerStillAlive = waitForExit && sameProcess(currentOwner, previous.data.owner);
        if (ownerStillAlive || sameProcess(oldOwner, currentOwner) && (!previous.data.owner || previous.data.pid !== process.pid && sameProcess(currentOwner, previous.data.owner))) throw new Error('Previous local instance cannot be verified; its live PID was not signalled.');
        if (socket) await unlinkSame(socketPath, socket);
        await unlinkRecord(stateFile, previous);
        log('Recovered stale local launcher files; continuing startup.');
      };
      let reachable = true;
      try { await requestInstance(socketPath, previous.data, 'inspect', { timeoutMs: 2000, signal: abort.signal }); }
      catch (error) {
        if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
        reachable = false;
      }
      if (reachable) {
        log('Stopping the verified previous instance of this repository…');
        try {
          await requestInstance(socketPath, previous.data, 'stop', { timeoutMs: stopTimeoutMs, signal: abort.signal });
          const deadline = Date.now() + 2000;
          while (await stateAt(stateFile)) { if (Date.now() >= deadline) throw new Error('Previous instance did not release its state; restart refused.'); await pause(20); }
          // server.close unlinks its socket before the old instance confirms completion.
          if (await socketStat(socketPath)) throw new Error('Previous instance did not release its control socket.');
        } catch (error) {
          if (error.code !== 'LOCAL_CLEANUP_UNVERIFIED') throw error;
          log('Previous launcher could not confirm cleanup; verifying its exit and recovering this repository’s processes…');
          await recoverPrevious(true);
        }
      } else {
        await recoverPrevious();
      }
    } else {
      // Missing state does not hide an exact same-root launcher entry. Recover
      // those verified processes first; a remaining live socket is still refused.
      await recoverProcesses(root, null, { timeoutMs: stopTimeoutMs, signal: abort.signal, log });
      if (socket) {
        // A live socket without a record is ambiguous; only refused/missing
        // endpoints may be removed. Never unlink another running control end.
        await new Promise((resolve, reject) => {
          const probe = net.createConnection(socketPath);
          const deadline = setTimeout(() => { probe.destroy(); reject(new Error('Unverified control socket timed out.')); }, 1000);
          probe.once('connect', () => { clearTimeout(deadline); probe.destroy(); reject(new Error('Control socket has no matching instance state; restart refused.')); });
          probe.once('error', error => { clearTimeout(deadline); probe.destroy(); ['ENOENT', 'ECONNREFUSED'].includes(error.code) ? resolve() : reject(error); });
        });
      }
      if (socket) await unlinkSame(socketPath, socket);
    }
    if (abort.signal.aborted) throw new Error('Local restart interrupted.');
    server = net.createServer(socket => {
      let body = Buffer.alloc(0), handled = false;
      socket.on('error', () => {});
      const deadline = setTimeout(() => socket.destroy(), stopTimeoutMs + 2000);
      socket.once('close', () => clearTimeout(deadline));
      socket.on('data', async chunk => {
        if (handled) return;
        if (body.length + chunk.length > 1024) { handled = true; socket.destroy(); return; }
        body = Buffer.concat([body, chunk]);
        const newline = body.indexOf(10); if (newline < 0) return;
        handled = true;
        let req; try { req = JSON.parse(body.subarray(0, newline).toString('utf8')); } catch { socket.destroy(); return; }
        if (!req || typeof req !== 'object' || req.version !== 1 || req.root !== root || req.instance !== instance || !['inspect', 'stop'].includes(req.action)) { socket.destroy(); return; }
        let error;
        if (req.action === 'stop') {
          if (!stopHandler) error = 'instance_starting';
          else try { await stopHandler(); } catch { error = 'cleanup_unverified'; }
        }
        socket.end(JSON.stringify({ ...data, action: req.action, ...(error ? { error } : {}) }) + '\n');
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    await fs.chmod(socketPath, 0o600);
    await fs.writeFile(stateFile, JSON.stringify(data), { flag: 'wx', mode: 0o600 });
    state = await stateAt(stateFile);
    const close = ({ cleanupConfirmed = true } = {}) => closePromise ??= (async () => {
      await updates.catch(() => {});
      await new Promise(resolve => server.close(resolve));
      if (cleanupConfirmed) await unlinkRecord(stateFile, state);
      else {
        await markUnverified(stateFile, state);
      }
      await releaseGate();
    })();
    return {
      data, socketPath, get cancelled() { return abort.signal.aborted; }, get cancelledSignal() { return cancelledSignal; },
      trackGroup(pid, marker) {
        updates = updates.then(async () => {
          const identity = await processIdentity(pid);
          if (!identity || identity.pgid !== pid || identity.uid !== process.getuid()) throw new Error('New local process group identity is unavailable.');
          if (data.groups.length >= 16) throw new Error('Too many local process groups.');
          const current = await stateAt(stateFile);
          if (!current || !same(current.stat, state.stat) || current.data.instance !== instance) throw new Error('Local state changed before process registration.');
          data.groups.push({ ...compact(identity), marker });
          const body = JSON.stringify(data);
          if (Buffer.byteLength(body) > 4096) throw new Error('Local process identity record is too large.');
          const temp = path.join(folder, `state-${instance}.tmp`);
          await fs.writeFile(temp, body, { flag: 'wx', mode: 0o600 });
          await fs.rename(temp, stateFile);
          state = await stateAt(stateFile);
        });
        return updates;
      },
      attachStop(handler) { stopHandler = handler; for (const [signal, listener] of startupHandlers) signalSource.off(signal, listener); },
      ready: releaseGate,
      close,
    };
  } catch (error) {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await releaseGate(); throw error;
  }
}
