// Modified for Identale; see the root NOTICE.
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { X509Certificate, createPrivateKey, createPublicKey, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import https from 'node:https';
import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import { serviceCatalog, serviceUnit, selectedServices, mockAutostartState, configureMockAutostart, restoreMockAutostart } from './deployment-services.mjs';
import {deploymentConfiguration, primaryCredentials} from './deployment-config.mjs';
import {environmentText, environmentPaths, environmentWords, protectedEnvironment} from './deployment-environment.mjs';
import {requestInstance} from '../local/local-instance.mjs';
import { assertNoLocalProcesses } from '../local/local-recovery.mjs';
import { claimCheckoutMode } from '../shared/checkout-mode.mjs';
import {localLauncherDirectory} from '../shared/local-paths.mjs';
import { checkServerIdentity } from 'node:tls';
import { dependenciesInstalled } from '../local/local-start.mjs';
import { copyWebDistribution, validateWebDistribution } from './web-distribution.mjs';
import { initializeSecrets, readSecrets, repositoryRoot } from '../shared/local-secrets.mjs';
import { serviceIdentity, ensureServiceAccount, deploymentStorage, planServicePermissions, applyServicePermissions, restoreServicePermissions, assertServiceAccess, assertEffectiveServiceIdentity, assertServiceProcessIdentity } from './deployment-identity.mjs';
import { planCheckoutAcls, applyCheckoutAcls, restoreCheckoutAcls, assertCheckoutAccess } from './checkout-access.mjs';

const configRoot = '/etc/identity';
const serviceNames = serviceCatalog.map(service => service.name);
const units = ['identity.target', ...serviceNames.map(name => `identity-${name}.service`), 'nginx.service'];
const resources = path.join(repositoryRoot, 'scripts/deploy/templates');
const secretEnv = { HOME: process.env.HOME || '/root', DENTITY_LOCAL_SECRETS_PATH: `${configRoot}/local-secrets.json` };

export function validateHost(host) {
  if (typeof host !== 'string' || host.length > 253 || !host.length) throw new Error('Provide --host with an IPv4 address or DNS name.');
  if (isIP(host) === 4) return host;
  if (/^[0-9.]+$/.test(host) || !host.split('.').every(label => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label))) throw new Error('Host must be an IPv4 address or DNS name without a scheme, port or path.');
  return host.toLowerCase();
}
export function validatePort(value) {
  const port = Number(value);
  if (!/^[1-9][0-9]{0,4}$/.test(String(value)) || port > 65535 || port === 80 || port >= 18300 && port <= 18304) throw new Error('Invalid HTTPS port or conflict with an internal service.');
  return port;
}
export function safePath(value) {
  if (!path.isAbsolute(value) || /[\x00-\x1f\x7f"\\$%]/.test(value)) throw new Error('Use absolute paths without control characters, quotes, backslashes, dollar signs or percent signs.');
  return path.resolve(value);
}
export function parseArgs(args) {
  const options = {};
  const valued = { '--host': 'host', '--port': 'port', '--data-dir': 'dataDir', '--cert': 'cert', '--key': 'key' };
  const flags = { '--init-secrets': 'initSecrets', '--skip-install': 'skipInstall', '--skip-build': 'skipBuild', '--mock': 'mock' };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (valued[arg]) {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${arg}.`);
      if (options[valued[arg]] !== undefined) throw new Error(`Repeated option: ${arg}.`);
      options[valued[arg]] = args[++index];
    } else if (flags[arg]) options[flags[arg]] = true;
    else throw new Error(`Unknown option: ${arg}. Use scripts/start.sh --help.`);
  }
  if (options.host) options.host = validateHost(options.host);
  if (options.port) options.port = validatePort(options.port);
  for (const key of ['dataDir', 'cert', 'key']) if (options[key]) options[key] = safePath(options[key]);
  if (!!options.cert !== !!options.key) throw new Error('Provide --cert and --key together.');
  return options;
}
export function envValue(text, key) {
  const lines = text.split('\n').filter(line => line.startsWith(`${key}=`));
  if (lines.length > 1) throw new Error(`Duplicate environment setting: ${key}.`);
  const value = lines[0]?.slice(key.length + 1).trim();
  if (!value) return undefined;
  if (value.startsWith('"')) {
    try { return JSON.parse(value); } catch { throw new Error(`Unsupported quoted environment setting: ${key}.`); }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'")) throw new Error(`Invalid environment setting: ${key}.`);
    return value.slice(1, -1);
  }
  return value;
}
export function mergeEnvironment(existing, updates) {
  const pending = new Map(Object.entries(updates));
  const lines = [];
  const managed = new Set(pending.keys());
  for (const line of existing.trimEnd().split('\n')) {
    const key = line.match(/^([A-Z][A-Z0-9_]*)=/)?.[1];
    if (!managed.has(key)) { if (line || existing) lines.push(line); continue; }
    if (pending.has(key)) {
      const value = String(pending.get(key));
      lines.push(`${key}=${/\s/.test(value) ? JSON.stringify(value) : value}`);
      pending.delete(key);
    }
  }
  for (const [key, value] of pending) lines.push(`${key}=${/\s/.test(String(value)) ? JSON.stringify(String(value)) : value}`);
  return `${lines.join('\n')}\n`;
}
export function render(template, values) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_match, key) => {
    if (!(key in values)) throw new Error(`Missing template value: ${key}.`);
    return values[key];
  });
}
export function renderNginx(template, host, port) {
  host = validateHost(host); port = validatePort(port);
  const origin = `https://${host}${port === 443 ? '' : `:${port}`}`;
  const redirect = (listener, tls = '') => `server {\n    listen ${listener};\n    server_name ${host};\n${tls}    return 308 ${origin}$request_uri;\n}\n`;
  const tls = '    ssl_certificate /etc/identity/tls/server.crt;\n    ssl_certificate_key /etc/identity/tls/server.key;\n    ssl_protocols TLSv1.2 TLSv1.3;\n';
  return render(template, { HOST: host, PORT: port, REDIRECTS: redirect('80') + (port === 443 ? '' : redirect('443 ssl', tls)) });
}
function cleanEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|LANG|LC_ALL|TERM|NO_COLOR|npm_config_cache|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR)$/.test(key)));
}
function run(command, args, { capture = false } = {}) {
  try { return execFileSync(command, args, { cwd: repositoryRoot, env: cleanEnvironment(), stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8', timeout: 600000 }); }
  catch { throw new Error(`${command} failed; resolve the reported error before retrying.`); }
}
const optionalText = async file => fs.readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
const template = name => fs.readFile(path.join(resources, name), 'utf8');
async function privateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o777) !== 0o700) throw new Error(`${directory} must be a root-owned directory with mode 0700.`);
}
async function atomicWrite(file, data, mode = 0o600) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, data, { mode, flag: 'wx' });
  await fs.rename(temporary, file);
}
export async function snapshot(paths, backup) {
  const entries = [];
  for (const [index, file] of paths.entries()) {
    let stat;
    try { stat = await fs.lstat(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const copy = path.join(backup, String(index));
    if (stat) await fs.cp(file, copy, { recursive: true, dereference: false });
    entries.push({ file, copy, existed: !!stat });
  }
  await fs.writeFile(path.join(backup, 'manifest.json'), JSON.stringify(entries, null, 2), { mode: 0o600 });
  return entries;
}
export async function restore(entries) {
  for (const { file, copy, existed } of entries) {
    await fs.rm(file, { recursive: true, force: true });
    if (existed) await fs.cp(copy, file, { recursive: true, dereference: false });
  }
}
export async function prepareCertificate(options, host, stage, existingDirectory = `${configRoot}/tls`) {
  let certificate, key;
  if (options.cert) {
    certificate = await fs.readFile(options.cert); key = await fs.readFile(options.key);
  } else if (existsSync(`${existingDirectory}/server.crt`) && existsSync(`${existingDirectory}/server.key`)) {
    certificate = await fs.readFile(`${existingDirectory}/server.crt`); key = await fs.readFile(`${existingDirectory}/server.key`);
    const parsed = new X509Certificate(certificate);
    const matches = isIP(host) ? parsed.checkIP(host) : parsed.checkHost(host, { subject: 'never' });
    if (!matches || Date.parse(parsed.validTo) < Date.now() + 86400000) {
      if (!parsed.verify(parsed.publicKey) || !parsed.checkIssued(parsed)) throw new Error('The existing certificate does not cover this host or is expiring. Provide --cert and --key; it was not replaced.');
      certificate = undefined; key = undefined;
    }
  } else if (existsSync(`${existingDirectory}/server.crt`) || existsSync(`${existingDirectory}/server.key`)) throw new Error('Existing TLS certificate/key pair is incomplete; restore it or provide --cert and --key.');
  if (!certificate) {
    console.log('Generating a self-signed HTTPS certificate. Browsers require explicit certificate trust.');
    run('openssl', ['req', '-x509', '-newkey', 'rsa:3072', '-sha256', '-days', '365', '-nodes', '-keyout', `${stage}/server.key`, '-out', `${stage}/server.crt`, '-subj', `/CN=${host.length <= 64 ? host : 'Identity'}`, '-addext', `subjectAltName=${isIP(host) ? 'IP' : 'DNS'}:${host}`, '-addext', 'extendedKeyUsage=serverAuth'], { capture: true });
    certificate = await fs.readFile(`${stage}/server.crt`); key = await fs.readFile(`${stage}/server.key`);
  }
  const parsed = new X509Certificate(certificate);
  if (!(isIP(host) ? parsed.checkIP(host) : parsed.checkHost(host, { subject: 'never' })) || Date.parse(parsed.validTo) < Date.now() + 86400000 || Date.parse(parsed.validFrom) > Date.now()) throw new Error('Certificate host or validity does not match this deployment.');
  const certificateKey = parsed.publicKey.export({ type: 'spki', format: 'der' });
  const privateKey = createPublicKey(createPrivateKey(key)).export({ type: 'spki', format: 'der' });
  if (!certificateKey.equals(privateKey)) throw new Error('TLS certificate and private key do not match.');
  await fs.writeFile(`${stage}/server.crt`, certificate, { mode: 0o644 });
  await fs.writeFile(`${stage}/server.key`, key, { mode: 0o600 });
  return certificate;
}
async function publicPermissions(directory) {
  await fs.chmod(directory, 0o755);
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Frontend build contains a symlink; refusing to publish it.');
    if (entry.isDirectory()) await publicPermissions(file);
    else await fs.chmod(file, 0o644);
  }
}
function httpsRequest(host, port, certificate, route, { data, origin } = {}) {
  return new Promise((resolve, reject) => {
    const request = https.request({ hostname: '127.0.0.1', port, path: route, method: data ? 'POST' : 'GET', servername: isIP(host) ? '' : host,
      ca: certificate, allowPartialTrustChain: true, checkServerIdentity: (_name, peer) => checkServerIdentity(host, peer),
      headers: { Host: `${host}:${port}`, ...(origin ? { Origin: origin } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) } }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.setTimeout(2000, () => request.destroy(new Error('HTTPS check timed out.')));
    request.on('error', reject); request.end(data);
  });
}
function serviceHealth(port, route) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: route }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
      response.on('end', () => { try { resolve(response.statusCode === 200 ? JSON.parse(body) : {}); } catch (error) { reject(error); } });
    });
    request.setTimeout(2000, () => request.destroy(new Error('Health check timed out.')));
    request.on('error', reject);
  });
}
async function waitForPage(host, port, certificate, services) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const page = await httpsRequest(host, port, certificate, '/');
      const auth = await httpsRequest(host, port, certificate, '/api/auth/me');
      const health = await Promise.all(services.map(service => serviceHealth(service.port, '/readyz')));
      if (page.status === 200 && page.body.includes('<html') && auth.status === 401 && JSON.parse(auth.body).error === 'unauthenticated'
        && health.every((result, index) => result.service === services[index].service && result.status === 'ready')) return;
    } catch { /* Service startup and TLS handover may still be in progress. */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('HTTPS page/API verification failed within 30 seconds.');
}

async function serviceEnvironment(unit, fallback) {
  let loaded = false;
  try {loaded = run('systemctl', ['show', unit, '-p', 'LoadState', '--value'], {capture:true}).trim() === 'loaded';} catch { /* First deployment. */ }
  if (!loaded) {
    const values = {};
    for (const file of fallback) Object.assign(values, await protectedEnvironment(file, true));
    return values;
  }
  const values = environmentWords(run('systemctl', ['show', unit, '-p', 'Environment', '--value'], {capture:true}));
  const files = environmentPaths(run('systemctl', ['show', unit, '-p', 'EnvironmentFiles', '--value'], {capture:true}));
  for (const {file, optional} of files) Object.assign(values, await protectedEnvironment(file, optional));
  return values;
}
export async function assertNoLocalLauncher(root = repositoryRoot) {
  // Includes pre-lease launchers under another UID/HOME. Inspection only: an
  // installer must never take over or signal an ordinary user's local process.
  await assertNoLocalProcesses(root);
  const folder = localLauncherDirectory(root);
  let state;
  try {
    const file = path.join(folder, 'instance.json'), stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('Invalid local launcher state; server deployment refused.');
    state = JSON.parse(await fs.readFile(file, 'utf8'));
    if (state.root !== await fs.realpath(root)) throw new Error('Local launcher root mismatch.');
  } catch (error) {if (error.code === 'ENOENT') return; throw error;}
  try {await requestInstance(path.join(folder, 'control.sock'), state, 'inspect', {timeoutMs:2000});}
  catch (error) {if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) return; throw error;}
  throw new Error('A local launcher from this checkout is running. Stop it before server deployment; no local process was stopped.');
}
export async function assertStorageOwnership(platformDatabase, runtimeDatabase) {
  const {tableOwner} = await import('../../apps/control-plane/dist/split/table-ownership.js');
  for (const [role, file] of [['platform', platformDatabase], ['runtime', runtimeDatabase]]) {
    if (!existsSync(file)) continue;
    const db = new DatabaseSync(file, {readOnly:true});
    try {
      for (const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
        if (tableOwner(name) !== role) throw new Error('Legacy or wrong-owner database detected. Explicitly migrate or select a fresh installation; no database was modified.');
      }
    } finally {db.close();}
  }
}

export function existingSkillRoot(platformDatabase, platform = {}) {
  if (platform.DENTITY_SKILL_RESOURCE_ROOT) return undefined; // Explicit configuration remains authoritative.
  const legacy = path.join(platform.HOME || '/root', '.identity/resources/skills');
  if (existsSync(legacy)) return legacy;
  if (!existsSync(platformDatabase)) return undefined;
  const db = new DatabaseSync(platformDatabase, { readOnly: true });
  try {
    // Missing files must not cause persisted Skill references to switch to a new empty root.
    const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='skill_resource_versions'").get();
    return hasTable && db.prepare('SELECT 1 FROM skill_resource_versions LIMIT 1').get() ? legacy : undefined;
  } finally { db.close(); }
}

export async function setup(args = process.argv.slice(2)) {
  // Argument/privilege validation precedes creation of checkout metadata.
  parseArgs(args);
  if (process.getuid?.() !== 0 || !existsSync('/run/systemd/system')) throw new Error('Run scripts/start.sh --host as root on a systemd machine.');
  const lease = await claimCheckoutMode(repositoryRoot, 'host');
  let completed = false;
  try { const result = await setupOwned(args); completed = true; return result; }
  finally { await lease.release({ recovered: completed }); }
}
async function setupOwned(args) {
  const options = parseArgs(args);
  const services = selectedServices(options.mock);
  const activeUnits = ['identity.target', ...services.map(service => serviceUnit(service.name)), 'nginx.service'];
  if (process.getuid?.() !== 0 || !existsSync('/run/systemd/system')) throw new Error('Run scripts/start.sh --host as root on a systemd machine.');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major !== 24 || minor < 19) throw new Error('Node.js >=24.19.0 and <25 is required.');
  safePath(repositoryRoot); safePath(process.execPath);
  await assertNoLocalLauncher();
  // Read the installed effective file list, including our earlier split-deployment
  // drop-ins, instead of accidentally reopening an obsolete all-in-one database.
  const oldPlatform = await serviceEnvironment('identity-control-plane.service', [`${configRoot}/control-plane.env`, `${configRoot}/control-plane-secrets.env`]);
  const oldRuntime = await serviceEnvironment('identity-runtime.service', [`${configRoot}/runtime.env`]);
  const oldHost = await serviceEnvironment('identity-runtime-host.service', [`${configRoot}/runtime-host.env`, `${configRoot}/runtime-host-secrets.env`]);
  let previous;
  if (oldPlatform.DENTITY_APP_ORIGIN) {try {previous = new URL(oldPlatform.DENTITY_APP_ORIGIN);} catch {throw new Error('The existing DENTITY_APP_ORIGIN is invalid.');}}
  const host = validateHost(options.host || previous?.hostname || '');
  const port = validatePort(options.port || (previous ? previous.port || 443 : 15173));
  const origin = `https://${host}${port === 443 ? '' : `:${port}`}`;
  const platformDatabase = safePath(path.resolve(oldPlatform.DENTITY_DATABASE_PATH || path.join(options.dataDir || '/var/lib/identity', 'platform/platform.sqlite')));
  const runtimeDatabase = safePath(path.resolve(oldRuntime.DENTITY_RUNTIME_DATABASE_PATH || path.join(options.dataDir || '/var/lib/identity', 'runtime/runtime.sqlite')));
  if (existsSync(platformDatabase) && !oldRuntime.DENTITY_RUNTIME_DATABASE_PATH && oldPlatform.DENTITY_DATABASE_PATH) throw new Error('Existing installation has no runtime database configuration. No data was migrated or reset.');
  if (options.dataDir && oldPlatform.DENTITY_DATABASE_PATH && platformDatabase !== path.resolve(options.dataDir, 'platform/platform.sqlite')) throw new Error('Changing an existing data directory requires an explicit migration; no data was moved.');
  const hasData = existsSync(platformDatabase) || existsSync(runtimeDatabase);
  let stored = await readSecrets({env:secretEnv});
  let credentials = primaryCredentials([oldPlatform, oldRuntime, oldHost], stored);
  if (!credentials && hasData) throw new Error('Existing database without credentials: restore the original master key. No replacement key was generated.');
  // Adopt an existing local initialization only for a new empty deployment.
  if (!credentials && !hasData) {
    stored = await readSecrets();
    credentials = primaryCredentials([], stored);
  }
  console.log(`Preparing deployment for ${origin}`);
  if (oldPlatform.DENTITY_DATABASE_PATH) console.log('Existing deployment detected: preserving configured storage and credentials; this is not a fresh install.');
  await assertStorageOwnership(platformDatabase, runtimeDatabase);
  const identity = ensureServiceAccount();
  const access = { root: repositoryRoot, entries: services.map(service => path.join(repositoryRoot, service.entry)) };
  const aclInput = { ...access, node: process.execPath };
  // Validate private paths, tools and storage scopes before dependency installation/build.
  const initialAcls = await planCheckoutAcls(identity, { ...aclInput, runtime: false });
  const legacySkillRoot = hasData ? existingSkillRoot(platformDatabase, oldPlatform) : undefined;
  const permissionOptions = { protectedPaths: [repositoryRoot, configRoot, path.dirname(process.execPath)] };
  const storagePreview = deploymentStorage({ platformDatabase, runtimeDatabase,
    records: path.resolve(oldRuntime.DENTITY_BUILTIN_RECORD_ROOT || path.join(path.dirname(runtimeDatabase), 'builtin-records')),
    state: path.resolve(oldHost.DENTITY_RUNTIME_HOST_STATE_DIR || path.join(options.dataDir || '/var/lib/identity', 'runtime-host-pi')),
    platform: { DENTITY_SKILL_RESOURCE_ROOT: path.resolve(oldPlatform.DENTITY_SKILL_RESOURCE_ROOT || legacySkillRoot || path.join(path.dirname(platformDatabase), 'skills')) } });
  for (const file of [...storagePreview.directories, ...storagePreview.trees, ...storagePreview.files]) safePath(file);
  await planServicePermissions(storagePreview, permissionOptions);
  await privateDirectory(configRoot);
  await privateDirectory(`${configRoot}/tls`);
  await privateDirectory(`${configRoot}/backups`);
  const stage = await fs.mkdtemp(`${configRoot}/.setup-`);
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const backup = `${configRoot}/backups/${id}`, release = `/srv/identity/releases/${id}/web`;
  const override = unit => `/etc/systemd/system/${unit}.d/zz-identity-managed.conf`;
  const stopInstalled = () => {
    const installed = units.filter(unit => unit !== 'nginx.service' && existsSync(`/etc/systemd/system/${unit}`));
    if (installed.length) run('systemctl', ['stop', ...installed]);
    for (const unit of installed.filter(unit => unit.endsWith('.service'))) {
      if (run('systemctl', ['show', unit, '-p', 'MainPID', '--value'], { capture: true }).trim() !== '0') throw new Error('Application service did not stop; refusing to change storage permissions.');
    }
  };
  const managed = [`${configRoot}/control-plane.env`, `${configRoot}/runtime.env`, `${configRoot}/runtime-host.env`, `${configRoot}/rule-model.env`, `${configRoot}/mock-mcp.env`, `${configRoot}/tls/server.crt`, `${configRoot}/tls/server.key`,
    '/etc/systemd/system/identity.target', ...serviceNames.flatMap(name => [`/etc/systemd/system/identity-${name}.service`, override(`identity-${name}.service`)]), '/etc/nginx/sites-available/identity', '/etc/nginx/sites-enabled/identity', '/srv/identity/web'];
  let entries, permissions, aclJournal, applied = false;
  const aclChanges = [];
  const mockBefore = mockAutostartState();
  const activeBefore = units.filter(unit => {try {return run('systemctl', ['is-active', '--quiet', unit], {capture:true}) === '';} catch {return false;}});
  try {
    await fs.mkdir(backup, { mode: 0o700 });
    aclJournal = await fs.open(path.join(backup, 'checkout-acl.jsonl'), 'wx', 0o600);
    await aclJournal.sync();
    // Make the journal's name and newly created backup hierarchy durable before
    // granting access. These are root-owned deployment paths, not user ancestors.
    for (const directory of [backup, path.dirname(backup), configRoot, path.dirname(configRoot)]) {
      const handle = await fs.open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); }
    }
    console.log(`Checkout ACL backup: ${backup}/checkout-acl.jsonl`);
    await applyCheckoutAcls(initialAcls, aclChanges, aclJournal);
    assertCheckoutAccess(identity, aclInput);
    if (!await dependenciesInstalled(repositoryRoot)) {
      if (options.skipInstall) throw new Error('Locked dependencies are missing; omit --skip-install.');
      run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
    }
    if (!options.skipBuild) run('npm', ['run', 'build']);
    for (const entry of [...services.map(service => service.entry), 'apps/web/dist/index.html']) await fs.access(path.join(repositoryRoot, entry));
    await validateWebDistribution(path.join(repositoryRoot, 'apps/web/dist'), repositoryRoot);
    await applyCheckoutAcls(await planCheckoutAcls(identity, aclInput), aclChanges, aclJournal);
    // Exercise the built password adapter after grants, before stopping installed services.
    assertServiceAccess(identity, { ...access, storage: { directories: [], trees: [], files: [] } });
    const certificate = await prepareCertificate(options, host, stage);
    const nginx = renderNginx(await template('nginx.conf.template'), host, port);
    await fs.writeFile(`${stage}/nginx-site.conf`, nginx.replaceAll('/etc/identity/tls/server.', `${stage}/server.`));
    await fs.writeFile(`${stage}/nginx-check.conf`, `events {}\nhttp { include /etc/nginx/mime.types; include ${stage}/nginx-site.conf; }\n`);
    run('nginx', ['-t', '-c', `${stage}/nginx-check.conf`]);
    if (!credentials) {
      await initializeSecrets({env:secretEnv, confirmed:true});
      credentials = primaryCredentials([], await readSecrets({env:secretEnv}));
      console.log('Created private deployment credentials; back up /etc/identity/local-secrets.json separately.');
    } else if (!existsSync(secretEnv.DENTITY_LOCAL_SECRETS_PATH)) {
      // Persist exactly the adopted credentials; never generate a replacement key.
      await fs.writeFile(secretEnv.DENTITY_LOCAL_SECRETS_PATH, JSON.stringify({version:1, modelMasterKey:credentials.DENTITY_MODEL_MASTER_KEY, runtimeHostToken:credentials.DENTITY_RUNTIME_HOST_TOKEN, platformResolverToken:credentials.DENTITY_PLATFORM_RESOLVER_TOKEN})+'\n', {flag:'wx', mode:0o600});
      await readSecrets({env:secretEnv});
    }
    // Preserve an old implicit Skill path rather than silently switching to an empty store.
    const configuration = deploymentConfiguration({platform:oldPlatform, runtime:oldRuntime, host:oldHost, credentials, origin,
      ...(options.dataDir ? {dataDir:options.dataDir} : {}), ...(legacySkillRoot ? {legacySkillRoot} : {})});
    for (const value of [configuration.platformDatabase, configuration.runtimeDatabase, configuration.records, configuration.state]) safePath(value);
    safePath(configuration.platform.DENTITY_SKILL_RESOURCE_ROOT);
    const storage = deploymentStorage(configuration);
    // Validate scopes/links before stopping. Collect authoritative metadata again after stopping.
    await planServicePermissions(storage, permissionOptions);
    const files = new Map([
      [`${configRoot}/control-plane.env`, environmentText(configuration.platform)],
      [`${configRoot}/runtime.env`, environmentText(configuration.runtime)],
      [`${configRoot}/runtime-host.env`, environmentText(configuration.host)],
      [`${configRoot}/rule-model.env`, mergeEnvironment(await optionalText(`${configRoot}/rule-model.env`), {NODE_ENV:'production', HOME:serviceIdentity.home, DENTITY_DEPLOYMENT:'server', DENTITY_MOCK_MODEL_PORT:'18302'})],
      [`${configRoot}/mock-mcp.env`, mergeEnvironment(await optionalText(`${configRoot}/mock-mcp.env`), {NODE_ENV:'production', HOME:serviceIdentity.home, DENTITY_DEPLOYMENT:'server', DENTITY_MOCK_MCP_PORT:'18303'})],
      ['/etc/systemd/system/identity.target', render(await template('identity.target'), {SERVICES: services.map(service => serviceUnit(service.name)).join(' ')})],
      ['/etc/nginx/sites-available/identity', nginx],
    ]);
    const entriesByService = serviceCatalog.map(service => service.entry);
    const unitTemplate = await template('identity.service.template');
    for (const [index, name] of serviceNames.entries()) {
      const unit = `identity-${name}.service`;
      files.set(`/etc/systemd/system/${unit}`, render(unitTemplate, {DESCRIPTION:`Identity ${name}`, ROOT:repositoryRoot, NODE:process.execPath, ENTRY:entriesByService[index], ENV_FILE:`${name}.env`, SECRETS_DIRECTIVE:''}));
      files.set(override(unit), `[Service]\nUser=identity\nGroup=identity\nSupplementaryGroups=\nNoNewPrivileges=true\nCapabilityBoundingSet=\nAmbientCapabilities=\nEnvironment=\nEnvironmentFile=\nEnvironmentFile=${configRoot}/${name}.env\n`);
    }
    const stagedUnits = [];
    for (const [file, contents] of files) {
      if (file.endsWith('.service') || file.endsWith('.target')) {
        const staged = path.join(stage, path.basename(file)); await fs.writeFile(staged, contents); stagedUnits.push(staged);
      }
    }
    run('systemd-analyze', ['verify', ...stagedUnits]);
    entries = await snapshot(managed, backup);
    await fs.mkdir(release, {recursive:true, mode:0o755});
    await copyWebDistribution(path.join(repositoryRoot, 'apps/web/dist'), release, repositoryRoot);
    for (const directory of ['/srv/identity', '/srv/identity/releases', path.dirname(release)]) await fs.chmod(directory, 0o755);
    await publicPermissions(release);
    console.log(`Configuration backup: ${backup}`);
    await assertNoLocalLauncher();
    applied = true;
    // Explicit service stop also covers old deployments with incomplete target wiring.
    stopInstalled();
    permissions = await planServicePermissions(storage, permissionOptions);
    await fs.writeFile(path.join(backup, 'permissions.json'), JSON.stringify(permissions, null, 2), { mode: 0o600, flag: 'wx' });
    await applyServicePermissions(permissions, identity);
    assertServiceAccess(identity, { ...access, storage, registryPath: configuration.host.DENTITY_RUNTIME_HOST_RESOURCE_REGISTRY ? safePath(configuration.host.DENTITY_RUNTIME_HOST_RESOURCE_REGISTRY) : undefined });
    for (const [file, contents] of files) {
      await fs.mkdir(path.dirname(file), {recursive:true, mode:file.startsWith('/etc/identity/') ? 0o700 : 0o755});
      await atomicWrite(file, contents, file.startsWith('/etc/identity/') ? 0o600 : 0o644);
    }
    await atomicWrite(`${configRoot}/tls/server.crt`, certificate, 0o644);
    await atomicWrite(`${configRoot}/tls/server.key`, await fs.readFile(`${stage}/server.key`));
    await fs.rm('/etc/nginx/sites-enabled/identity', {force:true}); await fs.symlink('/etc/nginx/sites-available/identity', '/etc/nginx/sites-enabled/identity');
    const next = `/srv/identity/.web-${id}`; await fs.symlink(release, next); await fs.rename(next, '/srv/identity/web');
    run('nginx', ['-t']); run('systemctl', ['daemon-reload']);
    // Ensure a later custom drop-in did not silently reintroduce old credential files.
    for (const name of serviceNames) {
      const actual = environmentPaths(run('systemctl', ['show', `identity-${name}.service`, '-p', 'EnvironmentFiles', '--value'], {capture:true}));
      if (actual.length !== 1 || actual[0].file !== `${configRoot}/${name}.env`) throw new Error('Conflicting systemd override; expected one scoped environment file.');
      const property = key => run('systemctl', ['show', `identity-${name}.service`, '-p', key, '--value'], {capture:true}).trim();
      assertEffectiveServiceIdentity({ user: property('User'), group: property('Group'), noNewPrivileges: property('NoNewPrivileges'),
        capabilities: property('CapabilityBoundingSet'), ambientCapabilities: property('AmbientCapabilities'), supplementaryGroups: property('SupplementaryGroups') });
    }
    configureMockAutostart(!!options.mock);
    run('systemctl', ['daemon-reload']);
    run('systemctl', ['start', ...activeUnits.filter(unit => unit !== 'nginx.service')]);
    run('systemctl', [activeBefore.includes('nginx.service') ? 'reload' : 'start', 'nginx.service']);
    await waitForPage(host, port, certificate, services);
    for (const unit of activeUnits) run('systemctl', ['is-active', '--quiet', unit], {capture:true});
    for (const service of services) {
      const pid = run('systemctl', ['show', serviceUnit(service.name), '-p', 'MainPID', '--value'], {capture:true}).trim();
      if (!/^[1-9][0-9]*$/.test(pid) || Number(pid) <= 1) throw new Error('Unable to verify service process identity.');
      assertServiceProcessIdentity(await fs.readFile(`/proc/${pid}/status`, 'utf8'), identity);
    }
    const login = await httpsRequest(host, port, certificate, '/api/auth/login', {data:'{}', origin});
    const blocked = await httpsRequest(host, port, certificate, '/api/auth/login', {data:'{}', origin:'https://invalid.example'});
    if (login.status !== 400 || blocked.status !== 403) throw new Error('API Origin enforcement verification failed.');
    run('systemctl', ['enable', 'identity.target', 'nginx.service']);
    console.log(`Deployment ready: ${origin}\nService account: identity (non-root; not a security sandbox)\nMock services: ${options.mock ? 'enabled' : 'disabled'}\nFuture startup: sudo bash scripts/start.sh --host ${host}${options.mock ? ' --mock' : ''}\nPrivate configuration: ${configRoot}\nHTTPS page/API and all service readiness checks passed. Model/provider connectivity has not been tested.`);
  } catch (error) {
    if (applied && entries) {
      console.error('Deployment failed; restoring previous configuration and frontend.');
      try {
        // Do not restore ownership under an application that failed to stop.
        stopInstalled();
        try { configureMockAutostart(false); } catch { /* Restore configuration even if optional-link cleanup fails. */ }
        await restore(entries);
        if (permissions) await restoreServicePermissions(permissions);
        await restoreCheckoutAcls(aclChanges);
        restoreMockAutostart(mockBefore); run('systemctl', ['daemon-reload']);
        const apps = activeBefore.filter(unit => unit !== 'nginx.service'); if (apps.length) run('systemctl', ['start', ...apps]);
        if (activeBefore.includes('nginx.service')) {run('nginx', ['-t']); run('systemctl', ['reload-or-restart', 'nginx.service']);} else run('systemctl', ['stop', 'nginx.service']);
        console.error(`Previous configuration restored; backup retained at ${backup}.`);
      } catch (restoreError) {console.error(`Automatic configuration restore needs attention: ${restoreError.message}. Backup: ${backup}`);}
    } else {
      try { await restoreCheckoutAcls(aclChanges); }
      catch (restoreError) { console.error(`Checkout ACL restore needs attention: ${restoreError.message}. Backup: ${backup}`); }
    }
    throw error;
  } finally {await aclJournal?.close(); await fs.rm(stage, {recursive:true, force:true});}
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) setup().catch(error => {console.error(error.message); process.exitCode = 1;});
