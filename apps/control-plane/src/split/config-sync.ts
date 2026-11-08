import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { SQLInputValue } from 'node:sqlite';
import type { Store } from '../store.js';
import type { ModelProfileService, ModelCredentialScope } from '../model-profiles.js';
import type { ApprovedResource } from '../capability-config.js';
import type { SkillResources } from '../skill-resources.js';
import type { McpResources } from '../mcp-resources.js';
import type { EmployeeChannelService } from '../employee-channels/service.js';
import type { TriggerService } from '../triggers/service.js';
import { DirectoryCredentialVault, type SealedDirectoryCredential } from '../directory/secrets.js';
import { quoteIdentifier } from './sqlite-projection.js';

export const CONFIGURATION_MODULES = {
  identity: ['workspace_work_item_settings','users', 'workspaces', 'members', 'entities','employee_human_rules'],
  permissions: ['entity_web_policies', 'entity_directory_policies', 'employee_handoff_policies', 'capability_packages'],
  models: ['model_profiles', 'model_catalog', 'entity_model_bindings', 'workspace_model_defaults', 'model_selection_epochs'],
  resources: ['skill_resource_versions', 'skill_resource_state', 'workspace_mcp_versions', 'workspace_mcp_state'],
  channels: ['employee_group_sharing_rules', 'employee_channel_connections', 'employee_channel_verification_events','wecom_bot_contacts'],
  directory: ['directory_sync_tasks', 'directory_snapshot_users', 'directory_snapshot_aliases', 'directory_alias_projection_meta', 'directory_snapshot_departments', 'directory_sync_part_state'],
  triggers: ['trigger_bindings', 'trigger_credentials'],
} as const;
export type ConfigurationModule = keyof typeof CONFIGURATION_MODULES;
export type ConfigurationRow = Record<string, SQLInputValue>;
export interface ConfigurationTable { name: string; sql: string; rows: ConfigurationRow[] }
export interface ConfigurationSnapshot {
  schemaVersion: 1; epoch: string; generatedAt: number;
  moduleRevisions: Record<ConfigurationModule, string>;
  tables: ConfigurationTable[]; approvedResources: ApprovedResource[];
  /** Restricted infrastructure payload, never copied into ordinary events or persisted to runtime disk. */
  privateCredentials: { tables: { name: string; rows: ConfigurationRow[] }[] };
}
const allowedTables = new Set<string>(Object.values(CONFIGURATION_MODULES).flat());
const privateTables = new Set(['employee_channel_connections', 'trigger_credentials']);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function deriveRuntimeConfigurationKey(token: string): Buffer { return createHash('sha256').update('runtime-cache' + token).digest(); }
function authorized(actual: string | undefined, token: string): boolean {
  if (!actual || !token) return false;
  const a = Buffer.from(actual), b = Buffer.from('Bearer ' + token);
  return a.length === b.length && timingSafeEqual(a, b);
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function jsonRecord(row: ConfigurationRow): Record<string, unknown> {
  if (typeof row['record_json'] !== 'string') throw Error('configuration_record_invalid');
  const record: unknown = JSON.parse(row['record_json']);
  if (!object(record)) throw Error('configuration_record_invalid');
  return record;
}
function credentialScope(record: Record<string, unknown>): (string | number)[] {
  return [String(record['workspaceId']), String(record['entityId']), String(record['id']), String(record['appId']), Number(record['authRevision'])];
}
function projectTable(name: string, rows: ConfigurationRow[], sourceVault: DirectoryCredentialVault, runtimeVault: DirectoryCredentialVault, triggerWorkspace: Map<string, string>): { rows: ConfigurationRow[]; privateRows?: ConfigurationRow[] } {
  const privateRows: ConfigurationRow[] = [];
  const projected = rows.map(source => {
    const row = { ...source };
    if (name === 'model_profiles' || name === 'model_catalog') for (const key of ['ciphertext', 'nonce', 'tag']) row[key] = null;
    if (name === 'workspace_mcp_versions') { const record = jsonRecord(row); record['credential'] = null; row['record_json'] = JSON.stringify(record); }
    if (name === 'employee_channel_connections') {
      const record = jsonRecord(row), credential = record['credential'];
      if (!object(credential) || !['ciphertext', 'nonce', 'tag'].every(k => typeof credential[k] === 'string')) throw Error('configuration_credential_invalid');
      const scope = credentialScope(record);
      // A single unusable connection credential must not block unrelated employee configuration.
      // Preserve an explicitly undecryptable credential so its existing resolver fails closed locally.
      let restricted: SealedDirectoryCredential = { ciphertext: '', nonce: '', tag: '' };
      try { restricted = runtimeVault.seal(sourceVault.open(credential as unknown as SealedDirectoryCredential, scope), scope); } catch {}
      privateRows.push({ ...row, record_json: JSON.stringify({ ...record, credential: restricted }) });
      record['credential'] = null; row['record_json'] = JSON.stringify(record);
    }
    if (name === 'trigger_credentials') {
      const workspace = triggerWorkspace.get(String(row['trigger_id']));
      if (!workspace) throw Error('configuration_trigger_missing');
      const scope = ['trigger-hmac-v1', workspace, String(row['trigger_id']), String(row['key_id']), Number(row['credential_version'])];
      let restricted: SealedDirectoryCredential = { ciphertext: '', nonce: '', tag: '' };
      try { restricted = runtimeVault.seal(sourceVault.open(row as unknown as SealedDirectoryCredential, scope), scope); } catch {}
      privateRows.push({ ...row, ...restricted });
      for (const key of ['ciphertext', 'nonce', 'tag']) row[key] = null;
    }
    return row;
  });
  return { rows: projected, ...(privateRows.length ? { privateRows } : {}) };
}
export interface ConfigurationApiOptions {
  store: Store; profiles: ModelProfileService; skills: SkillResources; mcp: Pick<McpResources, 'resolve'>;
  channels?: EmployeeChannelService; triggers?: TriggerService;
  token: string; masterKey?: Uint8Array; now?: () => number; approvedResources?: readonly ApprovedResource[];
}
/** One synchronous read transaction gives every module the same configuration generation. */
export function configurationSnapshot(options: ConfigurationApiOptions): ConfigurationSnapshot {
  return options.store.transaction(() => {
    const schemas = options.store.all<{ name: string; sql: string }>("SELECT name,sql FROM main.sqlite_master WHERE type='table' ORDER BY name").filter(t => allowedTables.has(t.name));
    const originals = schemas.map(table => ({ ...table, rows: options.store.all<ConfigurationRow>(`SELECT * FROM main.${quoteIdentifier(table.name)}`).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) }));
    const workspace = new Map((originals.find(t => t.name === 'trigger_bindings')?.rows ?? []).map(row => [String(row['id']), String(row['workspace_id'])]));
    const approvedResources = JSON.parse(JSON.stringify(options.approvedResources ?? [])) as unknown; validateApprovedResources(approvedResources);
    const moduleRevisions = Object.fromEntries(Object.entries(CONFIGURATION_MODULES).map(([module, names]) => [module, digest([originals.filter(table => (names as readonly string[]).includes(table.name)), ...(module === 'resources' ? [approvedResources] : [])])])) as Record<ConfigurationModule, string>;
    const sourceVault = new DirectoryCredentialVault(options.masterKey), runtimeVault = new DirectoryCredentialVault(deriveRuntimeConfigurationKey(options.token));
    const privateCredentials: ConfigurationSnapshot['privateCredentials'] = { tables: [] };
    const tables = originals.map(table => {
      const projection = projectTable(table.name, table.rows, sourceVault, runtimeVault, workspace);
      if (projection.privateRows) privateCredentials.tables.push({ name: table.name, rows: projection.privateRows });
      return { name: table.name, sql: table.sql, rows: projection.rows };
    });
    return { schemaVersion: 1, epoch: digest(moduleRevisions), generatedAt: (options.now ?? Date.now)(), moduleRevisions, tables, approvedResources, privateCredentials };
  });
}
export function registerConfigurationApi(app: FastifyInstance, options: ConfigurationApiOptions): void {
  const prefix = '/internal/config';
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.split('?')[0]?.startsWith(prefix + '/') && !authorized(request.headers.authorization, options.token)) return reply.code(401).send({ error: 'configuration_unauthorized' });
  });
  app.get(prefix + '/snapshot', (request, reply) => {
    try {
      const snapshot = configurationSnapshot(options), etag = '"' + snapshot.epoch + '"';
      reply.header('cache-control', 'no-store').header('etag', etag);
      return request.headers['if-none-match'] === etag ? reply.code(304).send() : snapshot;
    } catch { return reply.code(503).send({ error: 'configuration_unavailable' }); }
  });
  app.post(prefix + '/model', async (request, reply) => {
    try {
      const body = request.body;
      if (!object(body) || Object.keys(body).some(k => !['workspaceId', 'entityId', 'source', 'bindingRevision', 'profileId', 'configRevision', 'purpose'].includes(k)) || typeof body['workspaceId'] !== 'string' || typeof body['entityId'] !== 'string' || typeof body['profileId'] !== 'string' || !Number.isSafeInteger(body['configRevision']) || body['purpose'] !== 'model-inference') return reply.code(400).send({ error: 'configuration_request_invalid' });
      reply.header('cache-control', 'no-store');
      return await options.profiles.resolve(body as unknown as ModelCredentialScope, () => true);
    } catch { return reply.code(409).send({ error: 'model_profile_unavailable' }); }
  });
  for (const method of ['skill', 'mcp'] as const) app.post(prefix + '/' + method, (request, reply) => {
    try {
      const body = request.body;
      if (!object(body) || typeof body['workspaceId'] !== 'string' || (method === 'skill' ? Object.keys(body).some(k => !['workspaceId', 'ref'].includes(k)) || !object(body['ref']) || typeof body['ref']['resourceId'] !== 'string' || typeof body['ref']['version'] !== 'string' || Object.keys(body['ref']).some(k => !['resourceId', 'version', 'digest'].includes(k)) : Object.keys(body).some(k => !['workspaceId', 'resourceId', 'version'].includes(k)) || typeof body['resourceId'] !== 'string' || typeof body['version'] !== 'string')) return reply.code(400).send({ error: 'configuration_request_invalid' });
      reply.header('cache-control', 'no-store');
      return method === 'skill' ? options.skills.read(body['workspaceId'], body['ref'] as unknown as Parameters<SkillResources['read']>[1]) : options.mcp.resolve(body['workspaceId'], String(body['resourceId']), String(body['version']));
    } catch { return reply.code(409).send({ error: 'resource_unavailable' }); }
  });
}

export interface ConfigurationPollerOptions {
  store: Pick<Store, 'db' | 'replaceConfigurationTables'>; baseUrl: string; token: string;
  pollMs?: number; maxAgeMs?: number; fetch?: typeof fetch; now?: () => number;
  onApplied?: (change: { snapshot: ConfigurationSnapshot; previousRevisions?: Record<ConfigurationModule, string>; changedModules: ConfigurationModule[] }) => void;
}
function validateApprovedResources(value: unknown): asserts value is ApprovedResource[] {
  const identifier = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:@-]{0,199}$/.test(v) && !v.includes('://');
  const identifiers = (v: unknown, nonempty = true): v is string[] => Array.isArray(v) && (!nonempty || v.length > 0) && v.length <= 1000 && v.every(identifier) && new Set(v).size === v.length;
  if (!Array.isArray(value) || value.length > 10000) throw Error('configuration_catalog_invalid');
  const seen = new Set<string>();
  for (const resource of value) {
    if (!object(resource) || !identifier(resource['id']) || seen.has(resource['id'])) throw Error('configuration_catalog_invalid');
    seen.add(resource['id']);
    const visibility = resource['shared'] === true && !('workspaceIds' in resource) || !('shared' in resource) && identifiers(resource['workspaceIds']);
    if (!visibility || resource['enabled'] !== undefined && typeof resource['enabled'] !== 'boolean' || resource['name'] !== undefined && (typeof resource['name'] !== 'string' || resource['name'].length > 200)) throw Error('configuration_catalog_invalid');
    const common = ['id', 'kind', 'name', 'enabled', 'shared', 'workspaceIds'];
    let keys: string[];
    if (resource['kind'] === 'skill') {
      keys = [...common, 'resourceId', 'version', 'digest'];
      if (!identifier(resource['resourceId']) || !identifier(resource['version']) || typeof resource['digest'] !== 'string' || !/^(sha256:)?[a-f0-9]{64}$/.test(resource['digest'])) throw Error('configuration_catalog_invalid');
    } else if (resource['kind'] === 'mcp') {
      keys = [...common, 'serverRef', 'version', 'allowedTools'];
      if (!identifier(resource['serverRef']) || !identifiers(resource['allowedTools']) || resource['version'] !== undefined && !identifier(resource['version'])) throw Error('configuration_catalog_invalid');
    } else if (resource['kind'] === 'execution') {
      keys = [...common, 'resourceId', 'version', 'tools'];
      if (!identifier(resource['resourceId']) || !identifier(resource['version']) || !Array.isArray(resource['tools']) || !resource['tools'].length || resource['tools'].some(v => !['read', 'write', 'edit', 'bash'].includes(String(v))) || new Set(resource['tools']).size !== resource['tools'].length) throw Error('configuration_catalog_invalid');
    } else throw Error('configuration_catalog_invalid');
    if (Object.keys(resource).some(key => !keys.includes(key))) throw Error('configuration_catalog_invalid');
  }
}
function validateSnapshot(value: unknown): asserts value is ConfigurationSnapshot {
  if (!object(value) || value['schemaVersion'] !== 1 || typeof value['epoch'] !== 'string' || !/^[a-f0-9]{64}$/.test(value['epoch']) || typeof value['generatedAt'] !== 'number' || !object(value['moduleRevisions']) || !Array.isArray(value['tables']) || !object(value['privateCredentials']) || !Array.isArray(value['privateCredentials']['tables'])) throw Error('configuration_snapshot_invalid');
  validateApprovedResources(value['approvedResources']);
  const revisions = value['moduleRevisions'];
  if (Object.keys(revisions).length !== Object.keys(CONFIGURATION_MODULES).length || Object.keys(CONFIGURATION_MODULES).some(key => typeof revisions[key] !== 'string' || !/^[a-f0-9]{64}$/.test(String(revisions[key])))) throw Error('configuration_snapshot_invalid');
  const seen = new Set<string>();
  for (const table of value['tables']) {
    if (!object(table) || typeof table['name'] !== 'string' || !allowedTables.has(table['name']) || seen.has(table['name']) || typeof table['sql'] !== 'string' || !Array.isArray(table['rows'])) throw Error('configuration_table_forbidden');
    const schema = table['sql'];
    const match = schema.match(/^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`\[]?([a-zA-Z_][a-zA-Z_0-9]*)["`\]]?\s*\(/i);
    if (!match || match[1] !== table['name'] || /;|--|\/\*|\b(?:ATTACH|DETACH|PRAGMA|VIRTUAL|TRIGGER|LOAD_EXTENSION)\b/i.test(schema)) throw Error('configuration_schema_invalid');
    seen.add(table['name']);
    for (const row of table['rows']) {
      validateRow(row);
      if ((table['name'] === 'model_profiles' || table['name'] === 'model_catalog' || table['name'] === 'trigger_credentials') && ['ciphertext', 'nonce', 'tag'].some(key => row[key] !== null)) throw Error('configuration_credentials_invalid');
      if (['workspace_mcp_versions', 'employee_channel_connections'].includes(table['name']) && jsonRecord(row)['credential'] !== null) throw Error('configuration_credentials_invalid');
    }
  }
  const privateSeen = new Set<string>();
  for (const table of value['privateCredentials']['tables']) {
    if (!object(table) || typeof table['name'] !== 'string' || !seen.has(table['name']) || !privateTables.has(table['name']) || privateSeen.has(table['name']) || !Array.isArray(table['rows'])) throw Error('configuration_credentials_invalid');
    privateSeen.add(table['name']); for (const row of table['rows']) validateRow(row);
    const ordinary = value['tables'].find(t => t.name === table['name']);
    if (!ordinary || ordinary.rows.length !== table['rows'].length) throw Error('configuration_credentials_invalid');
  }
}
function validateRow(row: unknown): asserts row is ConfigurationRow {
  if (!object(row) || !Object.keys(row).length || Object.keys(row).some(k => !/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(k)) || Object.values(row).some(v => !(v === null || typeof v === 'string' || typeof v === 'number' && Number.isFinite(v)))) throw Error('configuration_row_invalid');
}
export class ConfigurationPoller {
  private readonly options: ConfigurationPollerOptions; private timer: ReturnType<typeof setInterval> | undefined;
  private flight: Promise<boolean> | undefined; private controller: AbortController | undefined;
  private epoch: string | undefined; private revisions: Record<ConfigurationModule, string> | undefined;
  private readonly requests = new Set<AbortController>(); private tableNames: string[] = [];
  private validatedAt: number | undefined; private error: string | undefined; private stoppedGeneration = 0;
  constructor(options: ConfigurationPollerOptions) {
    const url = new URL(options.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || !options.token || !Number.isFinite(options.pollMs ?? 5000) || (options.pollMs ?? 5000) < 1 || !Number.isFinite(options.maxAgeMs ?? 60000) || (options.maxAgeMs ?? 60000) < 1) throw Error('configuration_poll_options_invalid');
    this.options = { ...options, baseUrl: url.href.replace(/\/$/, '') };
  }
  get ready(): boolean { const age = this.validatedAt === undefined ? -1 : (this.options.now ?? Date.now)() - this.validatedAt; return age >= 0 && age < (this.options.maxAgeMs ?? 60000); }
  get status() { return { state: this.validatedAt === undefined ? 'initializing' : this.ready ? 'ready' : 'stale', epoch: this.epoch ?? null, lastValidatedAt: this.validatedAt ?? null, error: this.error ?? null, moduleRevisions: this.revisions ?? null }; }
  assertReady(): void { if (!this.ready) throw Error(this.validatedAt === undefined ? 'configuration_not_ready' : 'configuration_stale'); }
  start(): void { if (this.timer) return; void this.poll().catch(() => {}); this.timer = setInterval(() => { void this.poll().catch(() => {}); }, this.options.pollMs ?? 5000); this.timer.unref(); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; this.stoppedGeneration++; this.controller?.abort(); for (const controller of this.requests) controller.abort(); }
  poll(): Promise<boolean> { if (this.flight) return this.flight; const flight = this.performPoll(); this.flight = flight; void flight.finally(() => { if (this.flight === flight) this.flight = undefined; }).catch(() => {}); return flight; }
  async request<T = unknown>(kind: 'model' | 'skill' | 'mcp', body: unknown): Promise<T> {
    if (!['model', 'skill', 'mcp'].includes(kind)) throw Error('configuration_request_invalid');
    const controller = new AbortController(), generation = this.stoppedGeneration; this.requests.add(controller);
    try {
      const response = await (this.options.fetch ?? fetch)(this.options.baseUrl + '/internal/config/' + kind, {
        method: 'POST', headers: { authorization: 'Bearer ' + this.options.token, 'content-type': 'application/json' },
        body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
      });
      if (!response.ok) throw Error('configuration_resource_unavailable');
      const value: unknown = await response.json();
      if (generation !== this.stoppedGeneration) throw Error('configuration_resource_unavailable');
      return value as T;
    } catch { throw Error('configuration_resource_unavailable'); }
    finally { this.requests.delete(controller); }
  }
  private async performPoll(): Promise<boolean> {
    const generation = this.stoppedGeneration; this.controller = new AbortController();
    try {
      const response = await (this.options.fetch ?? fetch)(this.options.baseUrl + '/internal/config/snapshot', { headers: { authorization: 'Bearer ' + this.options.token, ...(this.epoch ? { 'if-none-match': '"' + this.epoch + '"' } : {}) }, redirect: 'error', signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(10000)]) });
      if (generation !== this.stoppedGeneration) return false;
      if (response.status === 304) {
        if (!this.epoch || response.headers.get('etag') !== '"' + this.epoch + '"') throw Error('configuration_etag_invalid');
        this.validatedAt = (this.options.now ?? Date.now)(); this.error = undefined; return false;
      }
      if (!response.ok) throw Error('configuration_fetch_failed');
      const value: unknown = await response.json(); validateSnapshot(value);
      if (response.headers.get('etag') !== '"' + value.epoch + '"') throw Error('configuration_etag_invalid');
      if (generation !== this.stoppedGeneration) return false;
      const rows: Record<string, ConfigurationRow[]> = Object.fromEntries(value.tables.map(t => [t.name, t.rows]));
      for (const table of value.privateCredentials.tables) rows[table.name] = table.rows;
      for (const name of this.tableNames) if (!(name in rows)) rows[name] = [];
      // Schema evolution and row replacement are one synchronous TEMP-only transaction.
      const catalog = value.tables.map(table => ({ ...table, rows: rows[table.name]! }));
      for (const name of this.tableNames) if (!value.tables.some(table => table.name === name)) {
        const old = this.options.store.db.prepare("SELECT sql FROM temp.sqlite_master WHERE type='table' AND name=?").get(name);
        if (old && typeof old['sql'] === 'string') catalog.push({ name, sql: old['sql'], rows: [] });
      }
      this.options.store.replaceConfigurationTables(catalog);
      const changed = (Object.keys(CONFIGURATION_MODULES) as ConfigurationModule[]).filter(key => this.revisions?.[key] !== value.moduleRevisions[key]);
      try { this.options.onApplied?.({ snapshot: value, ...(this.revisions ? { previousRevisions: this.revisions } : {}), changedModules: changed }); }
      catch { this.validatedAt = undefined; throw Error('configuration_apply_hook_failed'); }
      this.tableNames = value.tables.map(table => table.name);
      this.epoch = value.epoch; this.revisions = value.moduleRevisions; this.validatedAt = (this.options.now ?? Date.now)(); this.error = undefined; return true;
    } catch { this.error = 'configuration_unavailable'; return false; }
    finally { this.controller = undefined; }
  }
}
