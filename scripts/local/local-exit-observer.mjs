import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { lifecycleDiagnostics } from './local-lifecycle-log.mjs';
import { observeLauncherProcess } from './local-process-diagnostics.mjs';

/** One parent waiting on one manager, not a restart loop or business supervisor.
 * command/interval options are JS-only isolated fixture hooks, never CLI input. */
export function observeLocalExit({ root, args = [], initialize = false, command, heartbeatMs = 30000 }) {
  const observationId = randomUUID();
  const diagnostics = lifecycleDiagnostics({ root, instanceId: observationId, role: 'observer' });
  let child, ended = false, managerInstanceId, lastHeartbeatAt, processState = 'starting';
  const context = () => ({ childPid: child?.pid, managerInstanceId, lastHeartbeatAt, processState });
  observeLauncherProcess(diagnostics, { state: context });
  diagnostics.record('observer_start', { ...context(), stdinIsTTY: !!process.stdin.isTTY, stdoutIsTTY: !!process.stdout.isTTY });
  const forwarded = new Map();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const handler = () => {
      diagnostics.record('observer_signal_received', { ...context(), signal });
      // Only this live ChildProcess handle; no saved PID/PGID or service signals.
      if (!ended && child?.pid) {
        try { diagnostics.record('manager_signal_forwarded', { ...context(), signal, delivered: child.kill(signal) }); }
        catch (error) { diagnostics.record('manager_signal_failed', { ...context(), signal, errorCode: error.code }); }
      }
    };
    forwarded.set(signal, handler); process.on(signal, handler);
  }
  const completion = new Promise(resolve => {
    const finish = (code, signal) => {
      if (ended) return;
      ended = true; processState = 'completed'; clearInterval(timer);
      diagnostics.record('manager_exit', { ...context(), ...(Number.isInteger(code) ? { exitCode: code } : {}), ...(signal ? { signal } : {}) });
      for (const [name, handler] of forwarded) process.off(name, handler);
      resolve({ code, signal });
    };
    // The manager gets a separate group so foreground group signals reach the
    // observer once and are explicitly forwarded once. Services still belong
    // exclusively to the manager; stdin/stdout policy and business cleanup stay there.
    child = spawn(command?.file ?? process.execPath, command?.args ?? [...process.execArgv, fileURLToPath(new URL('./local-manager-entry.mjs', import.meta.url)), initialize ? 'initialize' : 'existing', ...args], {
      cwd: root, env: command?.env ?? process.env, detached: true,
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    });
    diagnostics.record('manager_spawn_requested', { ...context(), detached: true });
    child.on('spawn', () => { processState = 'running'; diagnostics.record('manager_spawned', context()); });
    child.on('message', message => {
      // Never serialize arbitrary IPC. Only our versioned metadata protocol.
      if (!message || message.type !== 'local_launcher_observation' || message.version !== 1 || message.pid !== child.pid || !/^[a-f0-9-]{36}$/.test(message.instanceId) || !['starting', 'running', 'stopping', 'completed'].includes(message.processState) || !Number.isSafeInteger(message.childCount) || message.childCount < 0 || message.childCount > 16) return;
      const first = managerInstanceId !== message.instanceId;
      managerInstanceId = message.instanceId; lastHeartbeatAt = new Date().toISOString();
      if (first) diagnostics.record('manager_instance_bound', { ...context(), managerState: message.processState });
      diagnostics.record('manager_heartbeat', { ...context(), managerState: message.processState, childCount: message.childCount });
    });
    child.on('disconnect', () => diagnostics.record('manager_ipc_disconnected', context()));
    child.on('error', error => {
      diagnostics.record('manager_process_error', { ...context(), errorCode: error.code });
      if (!child.pid) finish(1, null);
    });
    child.on('exit', finish);
    child.on('close', (code, signal) => diagnostics.record('manager_closed', { ...context(), ...(Number.isInteger(code) ? { exitCode: code } : {}), ...(signal ? { signal } : {}) }));
    const timer = setInterval(() => diagnostics.record('observer_heartbeat', { ...context(), ...(lastHeartbeatAt ? { heartbeatGapMs: Math.max(0, Date.now() - Date.parse(lastHeartbeatAt)) } : {}) }), heartbeatMs);
    timer.unref();
  });
  return { completion, observationId, get managerPid() { return child?.pid; } };
}

/** Preserve code vs actual signal at the public CLI boundary after fsync. */
export function applyObservedExit({ code, signal }) {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
}
