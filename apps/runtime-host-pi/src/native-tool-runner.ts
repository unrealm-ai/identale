/** Fixed SDK tool adapter. This process receives no model, resolver, identity or IPC credentials. */
import { createBashTool, createReadTool, createWriteTool, createEditTool } from '@earendil-works/pi-coding-agent';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, writeFile, mkdir } from 'node:fs/promises';
import { LocalToolError, nativeToolFailure } from './local-tool-errors.js';
import type { StandardToolName } from './execution-resources.js';
// Keep this controlled process-group leader alive until the host has the result
// and terminates the group. Normal Bash children must not create another PGID.
let raw = '';
let inputComplete = false;
await new Promise<void>((accept, reject) => {
  process.stdin.on('data', chunk => { if(inputComplete)return; raw += String(chunk); if (Buffer.byteLength(raw) > 1_048_576) reject(new Error('Tool input too large')); else if (raw.includes('\n')) { raw = raw.slice(0, raw.indexOf('\n')); inputComplete = true; accept(); } });
  process.stdin.once('error', reject);
  process.stdin.once('end', () => { if (!raw) reject(new Error('Missing tool request')); });
});
let mayHaveMutated = false;
let operationError: unknown;
let fileOpenFailed = false;
// Keep the original errno when the SDK wraps an access error with its path.
const observe = async <T>(operation: () => Promise<T>): Promise<T> => {
  try { return await operation(); } catch (error) {
    operationError = error;
    // These syscalls failed before file contents could be written. Do not apply
    // this exception to later write/close errors or SDK Bash output collection.
    fileOpenFailed = error instanceof Error && 'syscall' in error && ['open', 'access', 'mkdir'].includes(String(error.syscall));
    throw error;
  }
};
try {
  const request = JSON.parse(raw) as { name: StandardToolName; args: unknown; callId: string; processGroup: number };
  // This dedicated pipe is written only by the trusted Host tool adapter,
  // using the PGID of the child it has just spawned with detached:true.
  const ownGroup = request.processGroup;
  if(process.env['DENTITY_NATIVE_TOOL_RUNNER'] !== 'v1' || !Number.isSafeInteger(ownGroup) || ownGroup <= 1)throw new LocalToolError('TOOL_RESPONSE_INVALID');
  // Parent/worker death closes this dedicated pipe. The helper can then stop
  // its own verified group even when the trusted parent cannot run cleanup.
  process.stdin.once('end', () => { try { process.kill(-ownGroup,'SIGKILL'); } catch { process.exit(1); } });
  const cwd = process.cwd();
  const factories = { read: () => createReadTool(cwd), write: () => createWriteTool(cwd, { operations: {
    mkdir: path => observe(async () => { mayHaveMutated = true; await mkdir(path, { recursive: true }); }),
    writeFile: (path, content) => observe(async () => { mayHaveMutated = true; await writeFile(path, content, 'utf-8'); }),
  } }), edit: () => createEditTool(cwd, { operations: {
    access: path => observe(() => access(path, constants.R_OK | constants.W_OK)),
    readFile: path => observe(() => readFile(path)),
    writeFile: (path, content) => observe(async () => { mayHaveMutated = true; await writeFile(path, content, 'utf-8'); }),
  } }), bash: () => createBashTool(cwd, { exposeSessionEnvironment: false, operations: {
    async exec(command, directory, { onData, timeout }) {
      mayHaveMutated = true;
      const child = spawn('/bin/bash', ['--noprofile','--norc','-c',command], { cwd: directory, env: { PATH: '/usr/bin:/bin', HOME: cwd, TMPDIR: process.env['TMPDIR'] ?? cwd, LANG: 'C.UTF-8' }, stdio: ['ignore','pipe','pipe'], detached: false });
      child.stdout.on('data', onData); child.stderr.on('data', onData);
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, Math.min(timeout ?? 30, 30) * 1000).unref();
      try { const exitCode = await new Promise<number | null>((accept,reject) => { child.once('error',reject); child.once('exit',accept); }); if (timedOut) throw new LocalToolError('TOOL_TIMEOUT'); if (exitCode === null) throw new LocalToolError('TOOL_OUTCOME_UNKNOWN'); return { exitCode }; }
      finally { clearTimeout(timer); }
    },
  } }) };
  if (!Object.hasOwn(factories, request.name)) throw new LocalToolError('TOOL_RESPONSE_INVALID');
  const result = await factories[request.name]().execute(request.callId, request.args as never);
  if (request.name === 'bash') result.details = { ...(result.details ?? {}), processLifecycle: 'foreground-exit-only', detachedDaemonCleanup: 'unsupported' };
  process.stdout.write(JSON.stringify({ ok: true, result }) + '\n');
} catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: nativeToolFailure(operationError ?? error, mayHaveMutated, fileOpenFailed) }) + '\n'); }
// The host owns this still-live group's identity. It closes this group after
// receiving the result, including ordinary background children. Arbitrary
// daemon/session escape cleanup is explicitly not claimed by this backend.
setInterval(() => {}, 1000);
