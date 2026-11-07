// Modified for Identale; see the root NOTICE.
import { spawn } from 'node:child_process';
import { observeLauncherProcess } from './local-process-diagnostics.mjs';
import { observeLocalExit, applyObservedExit } from './local-exit-observer.mjs';
import net from 'node:net';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { claimLocalInstance } from './local-instance.mjs';
import { listenerOwnedByGroup, processGroupEmpty } from './local-process-inspection.mjs';
import { initializeSecrets, readSecrets, repositoryRoot, secretPath, validateMasterKey } from '../shared/local-secrets.mjs';
import { assertNoServerInstance, processIdentity, recoverProcesses } from './local-recovery.mjs';
import { lifecycleDiagnostics } from './local-lifecycle-log.mjs';
import { loadLocalEnvironment } from './local-environment.mjs';
import { localDatabasePaths, localResourcePaths, expandLocalPath } from '../shared/local-paths.mjs';
import { claimCheckoutMode } from '../shared/checkout-mode.mjs';

export function parseArgs(args) {
  if (args.some(arg => !['--no-install', '--no-build', '--mock'].includes(arg))) throw new Error('Usage: npm run local:start -- [--no-install] [--no-build] [--mock]');
  return { install: !args.includes('--no-install'), build: !args.includes('--no-build'), mock: args.includes('--mock') };
}
// An allowlist prevents inherited provider keys, NODE_OPTIONS and VITE_* from
// accidentally reaching builds, Vite, or an unrelated server process.
export function baseEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TMP|TEMP|LANG|LC_ALL|TERM|NO_COLOR|FORCE_COLOR|SystemRoot|COMSPEC|PATHEXT|npm_config_cache|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR)$/.test(key)));
}
export async function childEnvironments(env = process.env, options = {}) {
  const ports = {};
  for (const [key, fallback] of Object.entries({ DENTITY_CONTROL_PLANE_PORT: '18300', DENTITY_RUNTIME_SERVICE_PORT: '18304', DENTITY_RUNTIME_HOST_PI_PORT: '18301', DENTITY_MOCK_MODEL_PORT: '18302', DENTITY_MOCK_MCP_PORT: '18303', DENTITY_WEB_PORT: '15173' })) {
    const value = env[key] ?? fallback;
    if (!/^[1-9]\d{0,4}$/.test(value) || Number(value) > 65535) throw new Error(`${key} must be an integer between 1 and 65535.`);
    ports[key] = value;
  }
  if (new Set(Object.values(ports)).size !== Object.keys(ports).length) throw new Error('Local service ports must be distinct.');
  const platformUrl = `http://127.0.0.1:${ports.DENTITY_CONTROL_PLANE_PORT}`;
  const runtimeUrl = `http://127.0.0.1:${ports.DENTITY_RUNTIME_SERVICE_PORT}`;
  const hostUrl = `http://127.0.0.1:${ports.DENTITY_RUNTIME_HOST_PI_PORT}`;
  const origin = `http://127.0.0.1:${ports.DENTITY_WEB_PORT}`;
  for (const [key, expected] of Object.entries({ DENTITY_APP_ORIGIN: origin, DENTITY_RUNTIME_HOST_URL: hostUrl, DENTITY_PLATFORM_RESOLVER_URL: `${runtimeUrl}/internal/runtime`, DENTITY_RUNTIME_SERVICE_URL: runtimeUrl, DENTITY_PLATFORM_CONFIG_URL: platformUrl })) {
    if (env[key] && env[key] !== expected) throw new Error(`${key} must be ${expected} for this local launcher.`);
  }
  const stored = await readSecrets({ env, ...options });
  const masterKey = env.DENTITY_MODEL_MASTER_KEY ? validateMasterKey(env.DENTITY_MODEL_MASTER_KEY) : stored?.modelMasterKey;
  const hostToken = env.DENTITY_RUNTIME_HOST_TOKEN || stored?.runtimeHostToken;
  const resolverToken = env.DENTITY_PLATFORM_RESOLVER_TOKEN || stored?.platformResolverToken;
  if (!!hostToken !== !!resolverToken || (hostToken && hostToken === resolverToken)) throw new Error('Configure both distinct runtime authentication tokens.');
  if ((env.DENTITY_RUNTIME_HOST_URL || env.DENTITY_PLATFORM_RESOLVER_URL) && !hostToken) throw new Error('Runtime URLs require both distinct authentication tokens.');
  if (!!env.DENTITY_RUNTIME_SERVICE_TOKEN !== !!env.DENTITY_PLATFORM_CONFIG_TOKEN) throw new Error('Configure both distinct platform/runtime service tokens.');
  // Separate scopes without rewriting an existing private credential file. An
  // uninitialized installation gets launch-scoped transport tokens, not a model
  // encryption key or automatically configured model credentials.
  const transportSeed = masterKey ? Buffer.from(masterKey, 'base64') : randomBytes(32);
  const derive = purpose => createHmac('sha256', transportSeed).update(`dentity-local-v1:${purpose}`).digest('base64url');
  const serviceToken = env.DENTITY_RUNTIME_SERVICE_TOKEN || derive('runtime-service');
  const configToken = env.DENTITY_PLATFORM_CONFIG_TOKEN || derive('platform-config');
  const monitorToken = env.DENTITY_PI_MONITOR_TOKEN || derive('pi-monitor');
  const tokens = [serviceToken, configToken, monitorToken, hostToken, resolverToken].filter(Boolean);
  if (new Set(tokens).size !== tokens.length) throw new Error('Platform, runtime and resolver authentication tokens must be distinct.');
  const root = options.root ?? repositoryRoot;
  const { platform: platformDatabase, runtime: runtimeDatabase } = localDatabasePaths(env, root);
  if (path.resolve(platformDatabase) === path.resolve(runtimeDatabase)) throw new Error('Platform and runtime database paths must be distinct.');
  const base = baseEnvironment(env);
  const platform = { ...base, DENTITY_APP_ORIGIN: origin, DENTITY_CONTROL_PLANE_PORT: ports.DENTITY_CONTROL_PLANE_PORT, DENTITY_DATABASE_PATH: platformDatabase, DENTITY_RUNTIME_SERVICE_URL: runtimeUrl, DENTITY_RUNTIME_SERVICE_TOKEN: serviceToken, DENTITY_PLATFORM_CONFIG_TOKEN: configToken, DENTITY_PI_MONITOR_TOKEN: monitorToken, DENTITY_RUNTIME_HOST_URL: hostUrl };
  const runtime = { ...base, DENTITY_APP_ORIGIN: origin, DENTITY_RUNTIME_SERVICE_PORT: ports.DENTITY_RUNTIME_SERVICE_PORT, DENTITY_RUNTIME_DATABASE_PATH: runtimeDatabase, DENTITY_PLATFORM_CONFIG_URL: platformUrl, DENTITY_PLATFORM_CONFIG_TOKEN: configToken, DENTITY_RUNTIME_SERVICE_TOKEN: serviceToken };
  const host = { ...base, DENTITY_RUNTIME_HOST_PI_PORT: ports.DENTITY_RUNTIME_HOST_PI_PORT, DENTITY_PI_MONITOR_TOKEN: monitorToken };
  for (const key of ['DENTITY_SKILL_RESOURCE_ROOT', 'DENTITY_SECURE_COOKIES', 'DENTITY_MCP_ALLOWED_ORIGINS', 'DENTITY_MODEL_ALLOW_LOOPBACK_HTTP', 'DENTITY_APPROVED_RESOURCES_JSON']) if (env[key]) platform[key] = env[key];
  for (const key of ['DENTITY_BUILTIN_RECORD_ROOT', 'DENTITY_MCP_ALLOWED_ORIGINS', 'DENTITY_TRIGGER_ALLOW_LOOPBACK_HTTP', 'DENTITY_MODEL_ALLOW_LOOPBACK_HTTP', 'DENTITY_MAINTENANCE_ENABLED', 'DENTITY_MAINTENANCE_INTERVAL_MS', 'DENTITY_CONTEXT_RETAIN_MESSAGES', 'DENTITY_CONTEXT_TOKEN_THRESHOLD', 'DENTITY_SUMMARY_TIMEZONE', 'DENTITY_SUMMARY_RECENT_DAYS', 'DENTITY_PLATFORM_CONFIG_POLL_INTERVAL_MS']) if (env[key]) runtime[key] = env[key];
  platform.DENTITY_MODEL_ALLOW_LOOPBACK_HTTP = env.DENTITY_MODEL_ALLOW_LOOPBACK_HTTP ?? 'false';
  runtime.DENTITY_MODEL_ALLOW_LOOPBACK_HTTP = env.DENTITY_MODEL_ALLOW_LOOPBACK_HTTP ?? 'false';
  platform.DENTITY_TRIGGER_ALLOW_LOOPBACK_HTTP = env.DENTITY_TRIGGER_ALLOW_LOOPBACK_HTTP ?? 'false';
  runtime.DENTITY_TRIGGER_ALLOW_LOOPBACK_HTTP = env.DENTITY_TRIGGER_ALLOW_LOOPBACK_HTTP ?? 'false';
  runtime.DENTITY_SECURE_COOKIES = env.DENTITY_SECURE_COOKIES ?? 'false';
  for (const key of ['DENTITY_RUNTIME_HOST_STATE_DIR', 'DENTITY_RUNTIME_HOST_RESOURCE_REGISTRY']) if (env[key]) host[key] = env[key];
  const resources = localResourcePaths(env, root);
  host.DENTITY_RUNTIME_HOST_STATE_DIR = resources.state;
  platform.DENTITY_SKILL_RESOURCE_ROOT = resources.skills;
  for (const key of ['DENTITY_BUILTIN_RECORD_ROOT', 'DENTITY_RUNTIME_HOST_RESOURCE_REGISTRY']) {
    const scope = key === 'DENTITY_BUILTIN_RECORD_ROOT' ? runtime : host;
    if (scope[key]) scope[key] = expandLocalPath(scope[key], env, root);
  }
  if (masterKey) platform.DENTITY_MODEL_MASTER_KEY = masterKey;
  if (hostToken) {
    Object.assign(runtime, { DENTITY_RUNTIME_HOST_TOKEN: hostToken, DENTITY_PLATFORM_RESOLVER_TOKEN: resolverToken, DENTITY_RUNTIME_HOST_URL: hostUrl });
    Object.assign(host, { DENTITY_RUNTIME_HOST_TOKEN: hostToken });
  }
  // Vite otherwise binds readline to inherited TTY input and exits on stdin
  // EOF. The launcher owns lifecycle signals; Web must not depend on that TTY.
  return { platform, runtime, host, mockModel: { ...base, DENTITY_MOCK_MODEL_PORT: ports.DENTITY_MOCK_MODEL_PORT }, mockMcp: { ...base, DENTITY_MOCK_MCP_PORT: ports.DENTITY_MOCK_MCP_PORT }, web: { ...base, CI: 'true', DENTITY_WEB_PORT: ports.DENTITY_WEB_PORT, DENTITY_CONTROL_PLANE_URL: platformUrl }, build: { ...base } };
}
export async function reservePorts(ports, services = []) {
  if (new Set(ports).size !== ports.length) throw new Error('Local ports must be distinct.');
  const reservations = [];
  let failedPort, failedService;
  try {
    for (const [index, port] of ports.entries()) {
      failedPort = port; failedService = services[index];
      // A reservation is not a service. Browser retries must never leave an
      // accepted socket keeping server.close() pending during handover/cleanup.
      const server = net.createServer(socket => socket.destroy());
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve); });
      reservations.push(server);
    }
    return reservations;
  } catch (cause) {
    await Promise.all(reservations.map(closeReservation));
    const error = new Error(`Local port 127.0.0.1:${failedPort}${failedService ? ` for ${failedService}` : ''} is unavailable (${cause.code ?? 'UNKNOWN'}). Stop the conflicting service; no existing process was killed.`, { cause });
    Object.assign(error, { code: cause.code, port: failedPort, address: '127.0.0.1' });
    throw error;
  }
}
const closeReservation = server => new Promise(resolve => server.close(resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function cleanupFailure(error) {
  const reasons = new Map([
    ['Process identity inspection unavailable.', 'process_identity_unavailable'],
    ['Residual process group identity cannot be verified; no unrelated process was signalled.', 'group_identity_unverified'],
    ['Residual process marker changed; cleanup stopped.', 'process_marker_changed'],
    ['Residual process entry changed; cleanup stopped.', 'process_entry_changed'],
    ['Timed out cleaning verified local residual processes.', 'process_cleanup_timeout'],
    ['cleanup_unverified', 'group_exit_unverified'],
  ]);
  return {
    reason: reasons.get(error.message) ?? 'process_cleanup_failed',
    errorCode: Number.isInteger(error.code) ? `PROCESS_EXIT_${error.code}` : error.code,
    errorName: error.name,
  };
}
async function listening(port) {
  return new Promise(resolve => { const socket = net.connect({ host: '127.0.0.1', port }); socket.setTimeout(200); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); socket.once('timeout', () => { socket.destroy(); resolve(false); }); });
}

// Command injection exists only as a JS API for isolated tests, never CLI flags.
export async function supervise({ commands, prepare = [], cwd, signalSource = process, log = console.log, timeoutMs = 30000, killAfterMs = 12000, onControl, registerGroup, lifecycleInstanceId = randomUUID() }) {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Local process groups require macOS or Linux.');
  const diagnostics = lifecycleDiagnostics({ root: cwd, instanceId: lifecycleInstanceId, role: 'launcher' });
  diagnostics.record('launcher_start');
  const children = new Set();
  let stopping = false, started = false, resultCode = 0, cleanupConfirmed = true, finish, stopPromise, processState = 'starting';
  const live = child => !child.spawnFailed && child.exitCode === null && child.signalCode === null;
  let reservations = [];
  // Signals are installed before awaiting reservation. Stop waits for that
  // operation, so a signal cannot strand a newly reserved port.
  const reserving = reservePorts(commands.map(command => command.port), commands.map(command => command.name)).then(value => { reservations = value; });
  const completion = new Promise(resolve => { finish = resolve; });
  const cleanup = async list => {
    await Promise.all(list.map(child => child.registration));
    const groups = list.flatMap(child => child.identity ? [child.identity] : []);
    let recoveryError;
    try {
      await recoverProcesses(cwd, { groups }, {
        includeLegacy: false, graceMs: killAfterMs, timeoutMs: killAfterMs + 3000, log() {},
        onSignal(pid, signal) { diagnostics.record('owned_process_signalled', { childPid: pid, signal }); },
      });
    } catch (error) {
      recoveryError = error;
      diagnostics.record('cleanup_recheck', cleanupFailure(error));
    }
    // A process may disappear while recovery inspects it. An intermediate
    // inspection error is not the exit postcondition: verify every registered
    // group and the ChildProcess handles independently before accepting cleanup.
    const deadline = Date.now() + 1000;
    let waitingRecorded = false;
    for (;;) {
      const exited = await Promise.all(list.map(async child => child.spawnFailed || !!child.identity && await processGroupEmpty(child.pid)));
      if (exited.every(Boolean) && !list.some(live)) break;
      if (!waitingRecorded) {
        diagnostics.record('cleanup_waiting', { reason: 'waiting_for_group_exit', childCount: exited.filter(value => !value).length });
        waitingRecorded = true;
      }
      if (Date.now() >= deadline) throw recoveryError ?? new Error('cleanup_unverified');
      await delay(20);
    }
    for (const child of list) {
      if (!child.spawnFailed && (!child.identity || !await processGroupEmpty(child.pid))) throw new Error('cleanup_unverified');
      child.cleanupVerified = true;
      diagnostics.record('group_clean', { service: child.service, childPid: child.pid, cleanupConfirmed: true });
    }
  };
  const stop = (code = 0, reason = 'control_request') => {
    resultCode = Math.max(resultCode, code);
    if (stopPromise) return stopPromise;
    diagnostics.record('launcher_stop_requested', { reason, exitCode: code });
    stopping = true; processState = 'stopping';
    stopPromise = (async () => {
      try {
        await reserving.catch(() => {});
        await Promise.all(reservations.map(closeReservation));
        await cleanup([...children]);
        // Wait for ChildProcess exit notifications as well as OS disappearance.
        const deadline = Date.now() + 1000;
        while ([...children].some(live) && Date.now() < deadline) await delay(20);
        if ([...children].some(live)) throw new Error('cleanup_unverified');
      } catch (error) {
        cleanupConfirmed = false; resultCode = Math.max(resultCode, 1);
        const failure = cleanupFailure(error);
        diagnostics.record('cleanup_unverified', failure);
        log(`Unable to confirm cleanup of a launcher-owned process group (${failure.reason}${failure.errorCode ? `, ${failure.errorCode}` : ''}); restart will verify residual identities.`);
        for (const child of children) if (live(child)) child.unref();
      }
      for (const [signal, handler] of handlers) signalSource.off(signal, handler);
      diagnostics.record('launcher_complete', { reason, exitCode: resultCode, cleanupConfirmed });
      processState = 'completed';
      finish(resultCode);
    })();
    return stopPromise;
  };
  const handlers = new Map(Object.entries({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }).map(([signal, code]) => [signal, () => { diagnostics.record('signal_received', { signal }); void stop(code, `signal_${signal}`); }]));
  for (const [signal, handler] of handlers) signalSource.on(signal, handler);
  if (signalSource === process) observeLauncherProcess(diagnostics, { instanceId: lifecycleInstanceId, state: () => ({ processState, childCount: [...children].filter(live).length }) });
  try { await reserving; }
  catch (error) { await stop(1, 'port_reservation_failed'); throw error; }
  onControl?.({ stop, completion, get cleanupConfirmed() { return cleanupConfirmed; } });
  function launch(command, preparatory = false) {
    const marker = randomUUID();
    const child = spawn('/bin/bash', [fileURLToPath(new URL('./local-process-entry.sh', import.meta.url)), command.file, ...command.args], { cwd, env: { ...command.env, DENTITY_LOCAL_INSTANCE: marker }, stdio: ['ignore', 'inherit', 'inherit', 'pipe'], shell: false, detached: true });
    child.service = command.name;
    child.cleanupVerified = false;
    children.add(child);
    child.stdio[3].on('error', error => {
      if (!stopping) { diagnostics.record('command_start_failed', { service: command.name, childPid: child.pid, errorCode: error.code }); void stop(1, 'command_start_failed'); }
    });
    child.registration = new Promise(resolve => {
      child.once('error', resolve);
      child.once('spawn', async () => {
        diagnostics.record('command_spawned', { childPid: child.pid, service: command.name });
        try {
          const identity = await processIdentity(child.pid);
          if (!identity || identity.pgid !== child.pid || identity.uid !== process.getuid()) throw new Error('process_identity_unavailable');
          child.identity = { pid: identity.pid, pgid: identity.pgid, uid: identity.uid, start: identity.start, marker };
          await registerGroup?.(child.pid, marker);
          diagnostics.record('command_registered', { childPid: child.pid, service: command.name });
          // The shell becomes the service in the same PID only after recording
          // its identity. This pipe is closed by exec and has no runtime role.
          if (!stopping) child.stdio[3].end('run\n');
          else child.stdio[3].end();
        } catch (error) {
          child.stdio[3].end();
          log(`Unable to register ${command.name} for local recovery.`);
          diagnostics.record('command_registration_failed', { service: command.name, childPid: child.pid, errorCode: error.code });
          void stop(1, 'group_registration_failed');
        } finally { resolve(); }
      });
    });
    child.once('error', error => { child.spawnFailed = !child.pid; diagnostics.record('command_error', { childPid: child.pid, service: command.name, errorCode: error.code }); log(`Unable to launch ${command.name}.`); void stop(1, 'command_error'); });
    child.once('exit', (code, signal) => {
      diagnostics.record('command_exit', { childPid: child.pid, service: command.name, exitCode: code, signal });
      if (!stopping && (!preparatory || code !== 0)) {
        log(`${command.name} exited (code=${code ?? 'none'}, signal=${signal ?? 'none'}); stopping local services.`);
        void stop(1, 'command_exit');
      }
    });
    child.once('close', (code, signal) => diagnostics.record('command_close', { childPid: child.pid, service: command.name, exitCode: code, signal }));
    return child;
  }
  try {
    for (const command of prepare) {
      if (stopping) break;
      log(`Running ${command.name}…`);
      const child = launch(command, true);
      await new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
      if (!stopping && child.exitCode === 0) {
        try { await cleanup([child]); children.delete(child); }
        catch { await stop(1, 'preparation_cleanup_failed'); break; }
      } else { await stop(1, 'preparation_failed'); break; }
    }
    for (const [index, command] of commands.entries()) {
      if (stopping) break;
      await closeReservation(reservations[index]);
      if (stopping) break;
      const child = launch(command), deadline = Date.now() + timeoutMs;
      while (!stopping && !await commandReady(command, child)) {
        if (Date.now() >= deadline) throw new Error(`${command.name} did not start in time.`);
        await delay(60);
      }
      if (stopping || !live(child)) break;
    }
    if (!stopping) { started = true; processState = 'running'; diagnostics.record('launcher_ready'); log(`Local services listening. Open http://127.0.0.1:${commands.find(command => command.name === 'Web')?.port ?? 15173}. Ctrl+C stops this launcher’s instance. Configure a model API manually before chatting.`); }
  } catch (error) { diagnostics.record('startup_failed', { errorCode: error.code }); log(error.message); await stop(1, 'startup_failed'); }
  return { completion, stop, get started() { return started; }, get cleanupConfirmed() { return cleanupConfirmed; } };
}
async function commandReady(command, child) {
  if (!await listening(command.port)) return false;
  if (!await listenerOwnedByGroup(command.port, child.pid)) return false;
  if (!command.health) return true;
  try {
    const response = await fetch(`http://127.0.0.1:${command.port}${command.health.path}`, { redirect: 'error', signal: AbortSignal.timeout(500) });
    if (!response.ok) return false;
    const data = await response.json();
    return data.service === command.health.service && data.protocolVersion === command.health.protocolVersion && data.status === command.health.status;
  } catch { return false; }
}
export async function superviseLocal(options) {
  const instance = await claimLocalInstance({ root: options.cwd, ports: options.commands.map(command => command.port), signalSource: options.signalSource, log: options.log, stopTimeoutMs: (options.killAfterMs ?? 12000) + 6000 });
  let running;
  try {
    running = await supervise({ ...options, lifecycleInstanceId: instance.data.instance, registerGroup: (pid, marker) => instance.trackGroup(pid, marker), onControl(control) {
      instance.attachStop(async () => { await control.stop(0, 'instance_control_request'); if (!control.cleanupConfirmed) throw new Error('cleanup_unverified'); });
      if (instance.cancelled) void control.stop(({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 })[instance.cancelledSignal] ?? 130, `signal_${instance.cancelledSignal ?? 'SIGINT'}`);
      options.onControl?.(control);
    } });
    if (running.started) await instance.ready();
    const completion = running.completion.then(async code => { await instance.close({ cleanupConfirmed: running.cleanupConfirmed }); return code; });
    return { completion, stop: running.stop, get started() { return running.started; }, get cleanupConfirmed() { return running.cleanupConfirmed; }, instance: instance.data, socketPath: instance.socketPath };
  } catch (error) { await running?.stop(1); await instance.close({ cleanupConfirmed: running?.cleanupConfirmed ?? true }); throw error; }
}

export async function dependenciesInstalled(root = repositoryRoot) {
  try {
    await fs.access(path.join(root, 'node_modules/.package-lock.json'));
    const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
    for (const [location, entry] of Object.entries(lock.packages)) {
      if (!location.includes('node_modules/') || entry.optional) continue;
      const manifest = JSON.parse(await fs.readFile(path.join(root, location, 'package.json'), 'utf8'));
      // npm accepts the conventional leading v in a package's own manifest.
      if (!entry.link && manifest.version !== entry.version && manifest.version !== `v${entry.version}`) return false;
    }
    return true;
  } catch { return false; }
}

export async function initializeLocalInstallation(env = process.env, root = repositoryRoot) {
  if (await readSecrets({env, root})) return;
  const names = ['DENTITY_MODEL_MASTER_KEY', 'DENTITY_RUNTIME_HOST_TOKEN', 'DENTITY_PLATFORM_RESOLVER_TOKEN'];
  if (names.every(name => !!env[name])) return; // Explicit external credential management.
  if (names.some(name => !!env[name])) throw new Error('Partial external credentials configured; provide all three or restore the private credentials file. No key was generated.');
  const selected = localDatabasePaths(env, root);
  const databases = [selected.platform, selected.runtime];
  for (const database of databases) {
    if (await fs.access(path.resolve(root, database)).then(() => true, () => false)) throw new Error('Existing database without private credentials; restore its original key before starting. No replacement key was generated.');
  }
  const folder = path.dirname(secretPath(env)), lock = path.join(folder, '.initializing');
  await fs.mkdir(folder, {recursive:true, mode:0o700});
  try { await fs.mkdir(lock, {mode:0o700}); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Another credential initialization is running; retry after it finishes.'); throw error; }
  try {
    const result = await initializeSecrets({env, root, confirmed: true});
    console.log(`Private credentials ${result.created ? 'created' : 'reused'}: ${result.path}. Back up this file separately; startup never replaces it.`);
  } finally { await fs.rmdir(lock); }
}

export function localCommands(environments, { mock = false } = {}) {
  const port = (scope, key, fallback) => Number(environments[scope][key] ?? fallback);
  const webPort = port('web', 'DENTITY_WEB_PORT', 15173);
  return [
    ...(mock ? [{ name: 'local rule model', file: process.execPath, args: ['apps/mock-model/dist/main.js'], port: port('mockModel', 'DENTITY_MOCK_MODEL_PORT', 18302), env: environments.mockModel, health: { path: '/readyz', service: 'dentity-rule-model', protocolVersion: 1, status: 'ready' } },
    { name: 'local Mock MCP', file: process.execPath, args: ['apps/mock-model/dist/mcp-main.js'], port: port('mockMcp', 'DENTITY_MOCK_MCP_PORT', 18303), env: environments.mockMcp, health: { path: '/readyz', service: 'dentity-mock-mcp', protocolVersion: 1, status: 'ready' } }] : []),
    { name: 'platform', file: process.execPath, args: ['apps/control-plane/dist/main.js'], port: port('platform', 'DENTITY_CONTROL_PLANE_PORT', 18300), env: environments.platform },
    { name: 'interaction and task service', file: process.execPath, args: ['apps/control-plane/dist/runtime-main.js'], port: port('runtime', 'DENTITY_RUNTIME_SERVICE_PORT', 18304), env: environments.runtime },
    { name: 'runtime Host', file: process.execPath, args: ['apps/runtime-host-pi/dist/main.js'], port: port('host', 'DENTITY_RUNTIME_HOST_PI_PORT', 18301), env: environments.host },
    { name: 'Web', file: process.execPath, args: ['node_modules/vite/bin/vite.js', 'apps/web', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], port: webPort, env: environments.web },
  ];
}

export async function startLocal(args = process.argv.slice(2), env = process.env, {initialize = false} = {}) {
  parseArgs(args);
  let lease, startupSignal, runningControl;
  const codes = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
  const handlers = Object.keys(codes).map(signal => [signal, () => { startupSignal ??= signal; }]);
  const removeHandlers = () => { for (const [signal, handler] of handlers) process.off(signal, handler); };
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const checkSignal = () => { if (startupSignal) throw new Error('Local startup interrupted.'); };
  try {
    lease = await claimCheckoutMode(repositoryRoot, 'local');
    checkSignal();
    return await startLocalOwned(args, env, initialize, checkSignal, control => {
      runningControl = control;
      if (startupSignal) void control.stop(codes[startupSignal], `signal_${startupSignal}`);
      removeHandlers();
    });
  } catch (error) { if (startupSignal) return codes[startupSignal]; throw error; }
  finally { removeHandlers(); await lease?.release({ cleanupConfirmed: runningControl?.cleanupConfirmed ?? true, recovered: !!runningControl }); }
}
async function startLocalOwned(args, env, initialize, checkSignal, onControl) {
  if (process.platform === 'win32') throw new Error('This launcher currently supports macOS/Linux; Windows process-tree cleanup is not verified.');
  const major = Number(process.versions.node.split('.')[0]);
  const minor = Number(process.versions.node.split('.')[1]);
  if (major !== 24 || minor < 19) throw new Error('Use Node.js >=24.19.0 and <25 (npm 11.9.0 recommended).');
  const options = parseArgs(args);
  await assertNoServerInstance(repositoryRoot);
  checkSignal();
  env = await loadLocalEnvironment(env);
  let environments = await childEnvironments(env);
  checkSignal();
  if (initialize) { await initializeLocalInstallation(env); environments = await childEnvironments(env); }
  console.log(env.DENTITY_MODEL_MASTER_KEY ? 'Model master key source: environment override (back up that override securely, not an unused local file).' : environments.platform.DENTITY_MODEL_MASTER_KEY ? `Model master key source: private file ${secretPath(env)}` : 'Model master key: unconfigured. Model configuration requires explicit initialization; no key was generated.');
  const exists = async target => fs.access(path.join(repositoryRoot, target)).then(() => true, () => false);
  const installed = await dependenciesInstalled();
  if (!installed && !options.install) throw new Error('Dependencies are missing. Run npm ci --ignore-scripts or omit --no-install.');
  const prepare = [];
  if (!installed) prepare.push({ name: 'locked dependency install', file: 'npm', args: ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], env: environments.build });
  prepare.push({ name: 'Argon2 native preflight', file: process.execPath, args: ['scripts/shared/local-native-preflight.mjs', ...(!options.install ? ['--no-repair'] : [])], env: environments.build });
  if (options.build) prepare.push({ name: 'build', file: 'npm', args: ['run', 'build'], env: environments.build });
  else for (const command of localCommands(environments, options)) if (!await exists(command.args[0])) throw new Error('Build output is missing; omit --no-build.');
  const commands = localCommands(environments, options);
  if (options.mock) {
    console.log(`Local rule model: manually configure http://127.0.0.1:${environments.mockModel.DENTITY_MOCK_MODEL_PORT}/v1 · model mock · public test token identity-local-test-token. No platform model or employee binding is created automatically.`);
    console.log(`Local Mock MCP: http://127.0.0.1:${environments.mockMcp.DENTITY_MOCK_MCP_PORT}/{alpha,beta}; calls: /calls. Administrators must explicitly configure capability packages and usage scope.`);
  }
  checkSignal();
  const running = await superviseLocal({ commands, prepare, cwd: repositoryRoot, onControl });
  return running.completion;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2); parseArgs(args);
    observeLocalExit({ root: repositoryRoot, args, initialize: true }).completion.then(applyObservedExit);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
