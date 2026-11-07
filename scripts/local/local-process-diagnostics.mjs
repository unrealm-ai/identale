// Observers only: do not install uncaughtException/unhandledRejection handlers,
// because those change Node's fatal-error/rejection policy.
const observers = new WeakMap();
let parentObservationEnabled = false;
export function enableLauncherParentObservation() { parentObservationEnabled = true; }
// The internal entry enables this before claiming the instance. A live direct
// IPC parent is this launch's observer, not a residual legacy launcher. Never
// accept a caller-provided PID, cached PID or environment flag for this guard.
export function launcherObserverParentPid() { return parentObservationEnabled && process.connected ? process.ppid : undefined; }
const errorNames = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'AggregateError']);
function errorFields(error) {
  try {
    return {
      errorName: errorNames.has(error?.name) ? error.name : 'Error',
      ...(/^[A-Z][A-Z0-9_]{1,50}$/.test(error?.code ?? '') ? { errorCode: error.code } : {}),
    };
  } catch { return { errorName: 'Error' }; }
}

/** One observer per OS process, even when a test/embedder starts sequential instances. */
export function observeLauncherProcess(diagnostics, { source = process, state = () => ({}), instanceId, heartbeatMs = 30000 } = {}) {
  const old = observers.get(source);
  if (old) {
    old.diagnostics = diagnostics; old.state = state; old.instanceId = instanceId;
    old.record('process_observer_attached');
    return;
  }
  const observer = { diagnostics, state, instanceId, fatalOrigin: undefined, record(event, fields = {}) {
    try {
      this.diagnostics.record(event, { ...this.state(), ...fields, uptimeMs: Math.floor(source.uptime() * 1000) });
    } catch { /* Observation must not change the original process outcome. */ }
  } };
  observers.set(source, observer);
  const heartbeat = () => {
    observer.record('process_heartbeat', { activeResourceCount: source.getActiveResourcesInfo?.().length });
    if (parentObservationEnabled && source.connected && source.send && /^[a-f0-9-]{36}$/.test(observer.instanceId)) {
      try { source.send({ type: 'local_launcher_observation', version: 1, pid: source.pid, instanceId: observer.instanceId, ...observer.state() }, error => {
        if (error) observer.record('observer_channel_failed', { errorCode: error.code });
      }); } catch (error) { observer.record('observer_channel_failed', { errorCode: error.code }); }
    }
  };
  const heartbeatTimer = setInterval(heartbeat, heartbeatMs); heartbeatTimer.unref();
  if (parentObservationEnabled && source.channel) {
    source.on('disconnect', () => observer.record('observer_disconnected'));
    // IPC observation must not keep an otherwise naturally finished manager alive.
    source.channel.unref();
  }
  source.on('beforeExit', code => observer.record('process_before_exit', { exitCode: Number(code) }));
  source.on('exit', code => observer.record('process_exit', { exitCode: Number(code), reason: observer.fatalOrigin ?? 'natural_or_explicit_exit' }));
  source.on('uncaughtExceptionMonitor', (error, origin) => {
    observer.fatalOrigin = origin === 'unhandledRejection' ? 'unhandled_rejection' : 'uncaught_exception';
    observer.record('process_fatal_exception', { ...errorFields(error), origin: observer.fatalOrigin });
  });
  // In warn mode Node emits warnings; adding an unhandledRejection listener
  // instead would suppress the default throw-mode crash. In none mode no
  // rejection event can be passively observed without changing that policy.
  source.on('warning', warning => {
    if (['UnhandledPromiseRejectionWarning', 'PromiseRejectionHandledWarning'].includes(warning?.name)) {
      observer.record('process_rejection_warning', { origin: 'unhandled_rejection' });
    }
  });
  if (source.platform !== 'win32') {
    const onHangup = () => {
      observer.record('signal_received', { signal: 'SIGHUP', reason: 'signal_SIGHUP' });
      // Keep an embedder's existing SIGHUP policy. Otherwise remove only our
      // listener and re-deliver the original signal: no graceful-cleanup or
      // numeric-exit substitution for the previous default signal termination.
      if (source.listeners('SIGHUP').some(listener => listener !== onHangup)) return;
      source.removeListener('SIGHUP', onHangup);
      source.kill(source.pid, 'SIGHUP');
    };
    source.prependListener('SIGHUP', onHangup);
  }
  observer.record('process_observer_attached');
  heartbeat();
}
