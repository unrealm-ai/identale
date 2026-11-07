import { constants, mkdirSync, lstatSync, openSync, fstatSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import path from 'node:path';
import { prepareLauncherDirectory } from '../shared/local-paths.mjs';

// Deliberately no argv, environment, error message, stack, or request body.
// Logging is best effort and must never change the launcher's cleanup policy.
export function lifecycleDiagnostics({ root, instanceId, role, service }) {
  let failed = false, file;
  const startedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
  const unavailable = error => {
    if (failed) return;
    failed = true;
    const reason = ['unsafe_diagnostic_path', 'unsafe_diagnostic_root', 'invalid_diagnostic_scope', 'diagnostic_short_write'].includes(error?.message) ? error.message : /^[A-Z][A-Z0-9_]{1,50}$/.test(error?.code) ? error.code : 'write_failed';
    try { process.stderr.write(`Local lifecycle diagnostics unavailable (${reason}); service lifecycle policy is unchanged.\n`); } catch {}
  };
  const owned = (stat, directory = false) => {
    if (stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== (directory ? 0o700 : 0o600) || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw new Error('unsafe_diagnostic_path');
  };
  const label = value => typeof value === 'string' ? value.replace(/(?:Bearer\s+\S+|sk-[\w-]+|[\w-]{24,})/gi, '[redacted]').replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 80) : undefined;
  const symbol = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value) ? value : undefined;
  try {
    if (!/^[a-f0-9-]{36}$/.test(instanceId) || !['launcher', 'guardian', 'observer'].includes(role)) throw new Error('invalid_diagnostic_scope');
    let folder = prepareLauncherDirectory(root);
    for (const name of ['diagnostics']) {
      folder = path.join(folder, name);
      try { mkdirSync(folder, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      owned(lstatSync(folder), true);
    }
    file = path.join(folder, `${instanceId}.jsonl`);
  } catch (error) { unavailable(error); }
  const record = (event, fields = {}) => {
    if (failed) return;
    let fd;
    try {
      fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      owned(fstatSync(fd));
      const row = { version: 1, time: new Date().toISOString(), startedAt, instanceId, role, pid: process.pid, ppid: process.ppid, service: label(fields.service ?? service), event: symbol(event) };
      for (const name of ['reason', 'signal', 'errorCode', 'errorName', 'origin', 'processState', 'managerState']) if (symbol(fields[name])) row[name] = symbol(fields[name]);
      for (const name of ['exitCode', 'childPid', 'guardianPid', 'uptimeMs', 'childCount', 'activeResourceCount', 'heartbeatGapMs']) if (Number.isSafeInteger(fields[name])) row[name] = fields[name];
      if (typeof fields.managerInstanceId === 'string' && /^[a-f0-9-]{36}$/.test(fields.managerInstanceId)) row.managerInstanceId = fields.managerInstanceId;
      if (typeof fields.lastHeartbeatAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(fields.lastHeartbeatAt)) row.lastHeartbeatAt = fields.lastHeartbeatAt;
      for (const name of ['detached', 'delivered', 'stdinIsTTY', 'stdoutIsTTY']) if (typeof fields[name] === 'boolean') row[name] = fields[name];
      if (typeof fields.cleanupConfirmed === 'boolean') row.cleanupConfirmed = fields.cleanupConfirmed;
      // Keep bounded append-only records, including legacy guardian fields for
      // older callers. Flush before exit or signalling an owned process.
      const bytes = Buffer.from(JSON.stringify(row) + '\n');
      if (writeSync(fd, bytes) !== bytes.length) throw new Error('diagnostic_short_write');
      fsyncSync(fd);
    } catch (error) { unavailable(error); }
    finally { if (fd !== undefined) try { closeSync(fd); } catch (error) { unavailable(error); } }
  };
  return { record, file: failed ? undefined : file };
}
