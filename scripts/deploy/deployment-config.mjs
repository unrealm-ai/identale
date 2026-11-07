// Modified for Identale; see the root NOTICE.
import path from 'node:path';
import {createHmac} from 'node:crypto';
import {validateMasterKey} from '../shared/local-secrets.mjs';
import {serviceIdentity} from './deployment-identity.mjs';

const primary = ['DENTITY_MODEL_MASTER_KEY', 'DENTITY_RUNTIME_HOST_TOKEN', 'DENTITY_PLATFORM_RESOLVER_TOKEN'];
const transport = ['DENTITY_RUNTIME_SERVICE_TOKEN', 'DENTITY_PLATFORM_CONFIG_TOKEN', 'DENTITY_PI_MONITOR_TOKEN'];
export function oneCredential(sources, key) {
  const values = [...new Set(sources.map(source => source[key]).filter(Boolean))];
  if (values.length > 1) throw new Error(`Conflicting ${key} sources; restore a consistent credential configuration. No key was replaced.`);
  return values[0];
}
export function primaryCredentials(sources, stored) {
  const saved = stored ? {DENTITY_MODEL_MASTER_KEY: stored.modelMasterKey, DENTITY_RUNTIME_HOST_TOKEN: stored.runtimeHostToken, DENTITY_PLATFORM_RESOLVER_TOKEN: stored.platformResolverToken} : {};
  const values = Object.fromEntries(primary.map(key => [key, oneCredential([...sources, saved], key)]));
  if (primary.every(key => !values[key])) return undefined;
  if (primary.some(key => !values[key])) throw new Error('Partial deployment credentials; restore the original master key and both execution tokens.');
  validateMasterKey(values.DENTITY_MODEL_MASTER_KEY);
  if (values.DENTITY_RUNTIME_HOST_TOKEN === values.DENTITY_PLATFORM_RESOLVER_TOKEN) throw new Error('Execution/resolver credentials must be distinct.');
  for (const key of primary.slice(1)) if (!/^[A-Za-z0-9_-]{43}$/.test(values[key])) throw new Error(`Invalid ${key}; no credential was replaced.`);
  return values;
}

/** Preserve operator settings, while assigning secrets and storage only to their owner. */
export function deploymentConfiguration({platform = {}, runtime = {}, host = {}, credentials, origin, dataDir, legacySkillRoot}) {
  if (!credentials) throw new Error('Deployment requires persistent credentials.');
  const sources = [platform, runtime, host];
  const key = Buffer.from(validateMasterKey(credentials.DENTITY_MODEL_MASTER_KEY), 'base64');
  const derive = purpose => createHmac('sha256', key).update(`dentity-local-v1:${purpose}`).digest('base64url');
  const service = oneCredential(sources, transport[0]) || derive('runtime-service');
  const config = oneCredential(sources, transport[1]) || derive('platform-config');
  const monitor = oneCredential(sources, transport[2]) || derive('pi-monitor');
  const tokens = [service, config, monitor, ...primary.slice(1).map(name => credentials[name])];
  if (new Set(tokens).size !== tokens.length || tokens.some(value => typeof value !== 'string' || value.length < 32 || /[\r\n\0]/.test(value))) throw new Error('Service credentials must be distinct, nonempty and valid.');
  const dataRoot = dataDir || '/var/lib/identity';
  const platformDatabase = path.resolve(platform.DENTITY_DATABASE_PATH || path.join(dataRoot, 'platform/platform.sqlite'));
  const runtimeDatabase = path.resolve(runtime.DENTITY_RUNTIME_DATABASE_PATH || path.join(dataRoot, 'runtime/runtime.sqlite'));
  if (platformDatabase === runtimeDatabase) throw new Error('Platform and runtime databases must be distinct.');
  if (platform.DENTITY_DATABASE_PATH && dataDir && platformDatabase !== path.resolve(dataDir, 'platform/platform.sqlite')) throw new Error('Changing an existing data directory requires an explicit migration; no data was moved.');
  const records = path.resolve(runtime.DENTITY_BUILTIN_RECORD_ROOT || path.join(path.dirname(runtimeDatabase), 'builtin-records'));
  const state = path.resolve(host.DENTITY_RUNTIME_HOST_STATE_DIR || path.join(dataRoot, 'runtime-host-pi'));
  const strip = source => Object.fromEntries(Object.entries(source).filter(([name]) => ![...primary, ...transport].includes(name)));
  const p = strip(platform), r = strip(runtime), h = strip(host);
  for (const name of ['DENTITY_RUNTIME_DATABASE_PATH', 'DENTITY_BUILTIN_RECORD_ROOT', 'DENTITY_RUNTIME_HOST_STATE_DIR', 'DENTITY_PLATFORM_RESOLVER_URL']) delete p[name];
  for (const name of ['DENTITY_DATABASE_PATH', 'DENTITY_SKILL_RESOURCE_ROOT', 'DENTITY_APPROVED_RESOURCES_JSON']) delete r[name];
  Object.assign(p, {NODE_ENV: 'production', DENTITY_DEPLOYMENT: 'server', DENTITY_APP_ORIGIN: origin, DENTITY_SECURE_COOKIES: 'true', DENTITY_CONTROL_PLANE_PORT: '18300', DENTITY_DATABASE_PATH: platformDatabase, DENTITY_RUNTIME_SERVICE_URL: 'http://127.0.0.1:18304', DENTITY_RUNTIME_SERVICE_TOKEN: service, DENTITY_PLATFORM_CONFIG_TOKEN: config, DENTITY_PI_MONITOR_TOKEN: monitor, DENTITY_RUNTIME_HOST_URL: 'http://127.0.0.1:18301', DENTITY_MODEL_MASTER_KEY: credentials.DENTITY_MODEL_MASTER_KEY});
  Object.assign(r, {NODE_ENV: 'production', DENTITY_DEPLOYMENT: 'server', DENTITY_APP_ORIGIN: origin, DENTITY_SECURE_COOKIES: 'true', DENTITY_RUNTIME_SERVICE_PORT: '18304', DENTITY_RUNTIME_DATABASE_PATH: runtimeDatabase, DENTITY_BUILTIN_RECORD_ROOT: records, DENTITY_PLATFORM_CONFIG_URL: 'http://127.0.0.1:18300', DENTITY_PLATFORM_CONFIG_TOKEN: config, DENTITY_RUNTIME_SERVICE_TOKEN: service, DENTITY_RUNTIME_HOST_URL: 'http://127.0.0.1:18301', DENTITY_RUNTIME_HOST_TOKEN: credentials.DENTITY_RUNTIME_HOST_TOKEN, DENTITY_PLATFORM_RESOLVER_TOKEN: credentials.DENTITY_PLATFORM_RESOLVER_TOKEN});
  delete h.DENTITY_PLATFORM_RESOLVER_URL;
  Object.assign(h, {NODE_ENV: 'production', DENTITY_DEPLOYMENT: 'server', DENTITY_RUNTIME_HOST_PI_PORT: '18301', DENTITY_RUNTIME_HOST_STATE_DIR: state, DENTITY_RUNTIME_HOST_TOKEN: credentials.DENTITY_RUNTIME_HOST_TOKEN, DENTITY_PI_MONITOR_TOKEN: monitor});
  for (const scope of [p, r, h]) scope.HOME = serviceIdentity.home;
  p.DENTITY_SKILL_RESOURCE_ROOT ||= legacySkillRoot || path.join(path.dirname(platformDatabase), 'skills');
  p.DENTITY_MODEL_ALLOW_LOOPBACK_HTTP ??= 'true';
  r.DENTITY_MODEL_ALLOW_LOOPBACK_HTTP ??= 'true';
  r.DENTITY_TRIGGER_ALLOW_LOOPBACK_HTTP ??= 'true';
  return {platform: p, runtime: r, host: h, platformDatabase, runtimeDatabase, records, state};
}
