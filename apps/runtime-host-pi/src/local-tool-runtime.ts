import { spawn } from 'node:child_process';
import { mkdir, realpath, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalToolError, nativeToolFailure, parseLocalToolResponse } from './local-tool-errors.js';
import { type ResolvedExecutionResource, type StandardToolName } from './execution-resources.js';

const sourceRoot = dirname(fileURLToPath(import.meta.url));
const runner = join(sourceRoot, 'native-tool-runner.js');
export const cleanToolEnvironment = (root: string, scratch: string): NodeJS.ProcessEnv => ({ PATH: '/usr/bin:/bin', HOME: root, TMPDIR: scratch, LANG: 'C.UTF-8', LC_ALL: 'C' });

/** Clean native-tool worker with a task cwd; no filesystem or network sandbox. */
export class LocalToolRuntime {
  private initialized = false;
  private unresolved = false;
  private child: ReturnType<typeof spawn> | undefined;
  private scratch = '';
  constructor(readonly resource: ResolvedExecutionResource) {}
  async initialize(): Promise<void> {
    if (this.initialized) return;
    if(await realpath(this.resource.directory)!==this.resource.directory)throw new Error('Execution directory identity changed');
    this.scratch=join(this.resource.directory,'.identale-tmp');
    await mkdir(this.scratch,{mode:0o700,recursive:true});
    const stat=await lstat(this.scratch);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Scratch directory changed');
    this.initialized=true;
  }
  async execute(name: StandardToolName, callId: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!this.initialized || this.unresolved || !this.resource.tools.includes(name) || this.child || signal?.aborted) throw new LocalToolError('TOOL_NOT_ACTIVE');
    try {
      if (await realpath(this.resource.directory) !== this.resource.directory) throw new LocalToolError('TOOL_NOT_ACTIVE');
      const scratchStat = await lstat(this.scratch); if (!scratchStat.isDirectory() || scratchStat.isSymbolicLink()) throw new LocalToolError('TOOL_NOT_ACTIVE');
      const request = JSON.stringify({ name, callId, args });
      if (Buffer.byteLength(request) > 1_048_576) throw new LocalToolError('TOOL_INPUT_TOO_LARGE');
    } catch (error) {
      const failure = nativeToolFailure(error, false);
      throw new LocalToolError(failure.code, failure.errorType);
    }
    // Command is fixed trusted code. Model command/arguments travel only in stdin JSON.
    const child = spawn(process.execPath, [runner], { cwd: this.resource.directory, env: {...cleanToolEnvironment(this.resource.directory, this.scratch),DENTITY_NATIVE_TOOL_RUNNER:'v1'}, stdio: ['pipe','pipe','pipe'], detached: true });
    this.child = child;
    child.stdin?.on('error', () => { /* A vanished runner is reconciled by its close/result below. */ });
    let output = ''; let bytes = 0; let failure: LocalToolError | undefined; let resultReceived = false;
    const stop = (error: LocalToolError) => {
      failure ??= error;
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Outcome stays unknown, never fallback. */ } }
    };
    const abort = () => stop(new LocalToolError('TOOL_INTERRUPTED'));
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop(new LocalToolError('TOOL_TIMEOUT')), 30_000).unref();
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk); if (bytes > 2_097_152) { stop(new LocalToolError('TOOL_OUTPUT_LIMIT')); return; }
      if (resultReceived) { stop(new LocalToolError('TOOL_RESPONSE_INVALID')); return; }
      output += chunk;
      if (output.includes('\n')) {
        const end = output.indexOf('\n');
        if (output.slice(end + 1).length) { stop(new LocalToolError('TOOL_RESPONSE_INVALID')); return; }
        output = output.slice(0, end); resultReceived = true;
        // Runner deliberately remains alive, so this is still the exact group
        // created above; no PID/PGID-file lookup or stale process identity.
        if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { failure = new LocalToolError('TOOL_OUTCOME_UNKNOWN'); } }
      }
    });
    child.stderr?.on('data', chunk => { bytes += chunk.length; if (bytes > 2_097_152) stop(new LocalToolError('TOOL_OUTPUT_LIMIT')); });
    child.stdin?.write(JSON.stringify({ name, callId, args, processGroup: child.pid }) + '\n');
    try {
      const code = await new Promise<number | null>((accept, reject) => {
        child.once('error', () => reject(new LocalToolError(child.pid ? 'TOOL_OUTCOME_UNKNOWN' : 'TOOL_START_FAILED')));
        child.once('close', accept);
      });
      if (failure) throw failure;
      if (signal?.aborted) throw new LocalToolError('TOOL_INTERRUPTED');
      if (!resultReceived || code !== null && code !== 0) throw new LocalToolError('TOOL_OUTCOME_UNKNOWN');
      return parseLocalToolResponse(output);
    } catch (error) {
      if (error instanceof LocalToolError && error.outcome === 'unknown') this.unresolved = true;
      throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.child = undefined; }
  }
  async close(): Promise<void> {
    const child = this.child; if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* caller must retain unknown */ } }
    this.child = undefined;
    this.initialized = false;
  }
}
