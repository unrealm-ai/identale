// Modified for Identale; see the root NOTICE.

// Timers only report elapsed time; they never infer percentage or readiness.
export function startupStage(label, { log = console.log, intervalMs = 10000 } = {}) {
  const started = performance.now();
  const elapsed = () => `${((performance.now() - started) / 1000).toFixed(1)}s`;
  log(`[Identale] ${label}: starting…`);
  const timer = setInterval(() => log(`[Identale] ${label}: still running (${elapsed()} elapsed).`), intervalMs);
  timer.unref();
  let finished = false;
  return (status = 'completed') => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    log(`[Identale] ${label}: ${status} (${elapsed()}).`);
  };
}

export async function startupStep(label, action, options) {
  const finish = startupStage(label, options);
  try {
    const result = await action();
    finish();
    return result;
  } catch (error) {
    finish('failed');
    throw error;
  }
}
