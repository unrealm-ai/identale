import {MODEL_PROTOCOLS,type ModelProtocol,type ModelInputCapabilities} from '@dentity/contracts';
import {probeImageInput} from './model-image-probe.js';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { BUILTIN_THINKING_POLICY_VERSION, interactionThinkingParameters, type InteractionThinkingControl,modelProtocolEndpoint,modelProtocolHeaders,modelProtocolRequest,modelProtocolResponse } from '@dentity/runtime-builtin';
import type { Store } from './store.js';
import {nullDiagnostics,type DiagnosticPort} from '@dentity/application';
import {ModelProbeDiagnostics,responseShapeIssue} from './model-probe-diagnostics.js';

export class ModelProfileError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
  get statusCode() { return this.status; }
}
const fail = (status: number, code: string): never => { throw new ModelProfileError(status, code); };
export interface ModelProfileOptions {
  diagnostics?:DiagnosticPort;
  /** Deployment-owned 32-byte key. Never generated implicitly; rotation is not yet supported. */
  masterKey?: Uint8Array;
  /** Explicit development-only exception, restricted to literal loopback hosts. */
  allowLoopbackHttp?: boolean;
}
export type ModelProfileSource = 'selection' | 'workspace_default';
type ExecutionThinkingControl = 'unconfigured' | 'openai_reasoning_effort_medium';
export interface ModelProfile {
  id: string; name: string; referenceCount: number; workspaceId: string; entityId: string | null; source: ModelProfileSource; bindingRevision: string; provider: 'openai-compatible';
  protocol:ModelProtocol; endpoint: string; modelId: string; secretRef: string | null; configRevision: number; enabled: boolean; inputCapabilities?:ModelInputCapabilities;
}
export interface ModelProfileInput {
  name?: string; bindEntityId?: string; setAsDefault?: boolean; protocol?:ModelProtocol; provider: 'openai-compatible'; endpoint: string; modelId: string; apiKey?: string | null; enabled?: boolean; connectionTestReceipt?: string;
}
export interface ModelCredentialScope {
  workspaceId: string; entityId: string; source?: ModelProfileSource; bindingRevision?: string; profileId: string; configRevision: number; purpose: 'model-inference';
}
export interface ResolvedModelCredential { protocol?:ModelProtocol;provider: 'openai-compatible'; endpoint: string; modelId: string; apiKey: string; inputCapabilities?:ModelInputCapabilities }
type Row = {protocol:ModelProtocol; input_capabilities_json:string|null; id: string; name: string; workspace_id: string; entity_id: string | null; provider: 'openai-compatible'; endpoint: string; model_id: string; secret_ref: string | null; revision: number; enabled: number; ciphertext: string | null; nonce: string | null; tag: string | null; interaction_thinking_control: InteractionThinkingControl; execution_thinking_control: ExecutionThinkingControl };
const dto = (r: Row, referenceCount = 0, source: ModelProfileSource = 'selection'): ModelProfile => ({ id: r.id, name: r.name, referenceCount, workspaceId: r.workspace_id, entityId: null, source, bindingRevision: '', provider: r.provider,protocol:r.protocol??'chat_completions', endpoint: r.endpoint, modelId: r.model_id, secretRef: r.secret_ref, configRevision: r.revision, enabled: r.enabled === 1,...(r.input_capabilities_json&&r.input_capabilities_json!=='null'?{inputCapabilities:JSON.parse(r.input_capabilities_json) as ModelInputCapabilities}:{}) });

/** Trusted infrastructure only. Never expose resolve/save as model tools or serialize resolved credentials. */
export class ModelProfileService {
  private readonly key: Buffer | undefined;
  private readonly optionsDiagnostics:DiagnosticPort;
  private readonly loopback: boolean;
  private readonly receiptKey = randomBytes(32);
  private readonly receipts = new Map<string, { actorId: string; binding: string; expiresAt: number; inputCapabilities:ModelInputCapabilities }>();
  private readonly probes = new Set<string>();
  constructor(private readonly store: Store, options: ModelProfileOptions = {}) {
    this.optionsDiagnostics=options.diagnostics??nullDiagnostics;
    if (options.masterKey && options.masterKey.byteLength !== 32) fail(503, 'model_secret_key_invalid');
    this.key = options.masterKey ? Buffer.from(options.masterKey) : undefined;
    this.loopback = options.allowLoopbackHttp === true;
    store.db.exec(`CREATE TABLE IF NOT EXISTS model_profiles (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), entity_id TEXT NOT NULL UNIQUE REFERENCES entities(id),
      provider TEXT NOT NULL, endpoint TEXT NOT NULL, model_id TEXT NOT NULL, secret_ref TEXT, revision INTEGER NOT NULL,
      enabled INTEGER NOT NULL, ciphertext TEXT, nonce TEXT, tag TEXT
    )`);
    for (const column of ['interaction_thinking_control', 'execution_thinking_control']) {
      if (!store.all<{name: string}>('PRAGMA table_info(model_profiles)').some(c => c.name === column)) {
        store.db.exec(`ALTER TABLE model_profiles ADD COLUMN ${column} TEXT NOT NULL DEFAULT 'unconfigured'`);
      }
    }
    store.db.exec(`CREATE TABLE IF NOT EXISTS model_catalog (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id), entity_id TEXT,
      provider TEXT NOT NULL, endpoint TEXT NOT NULL, model_id TEXT NOT NULL, secret_ref TEXT, revision INTEGER NOT NULL,
      enabled INTEGER NOT NULL, ciphertext TEXT, nonce TEXT, tag TEXT,
      interaction_thinking_control TEXT NOT NULL DEFAULT 'unconfigured', execution_thinking_control TEXT NOT NULL DEFAULT 'unconfigured'
    );
    CREATE TABLE IF NOT EXISTS entity_model_bindings (
      entity_id TEXT PRIMARY KEY REFERENCES entities(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      profile_id TEXT NOT NULL REFERENCES model_catalog(id)
    );
    CREATE TABLE IF NOT EXISTS workspace_model_defaults (
      workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id), profile_id TEXT NOT NULL REFERENCES model_catalog(id)
    );
    CREATE TABLE IF NOT EXISTS model_selection_epochs (workspace_id TEXT NOT NULL, entity_id TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(workspace_id,entity_id));
    CREATE TABLE IF NOT EXISTS model_catalog_migrations (id TEXT PRIMARY KEY);`);
    if(!store.all<{name:string}>('PRAGMA table_info(model_catalog)').some(c=>c.name==='input_capabilities_json'))store.db.exec("ALTER TABLE model_catalog ADD COLUMN input_capabilities_json TEXT");
    if(!store.all<{name:string}>('PRAGMA table_info(model_catalog)').some(c=>c.name==='protocol'))store.db.exec("ALTER TABLE model_catalog ADD COLUMN protocol TEXT NOT NULL DEFAULT 'chat_completions'");
    // Keep each old profile identity and legacy entity-bound AAD intact. Never deduplicate keys.
    store.transaction(() => {
      if (!store.one("SELECT id FROM model_catalog_migrations WHERE id='legacy-employee-v1'")) {
        store.db.exec(`INSERT INTO model_catalog(id,name,workspace_id,entity_id,provider,endpoint,model_id,secret_ref,revision,enabled,ciphertext,nonce,tag,interaction_thinking_control,execution_thinking_control) SELECT id,model_id,workspace_id,entity_id,provider,endpoint,model_id,secret_ref,revision,enabled,ciphertext,nonce,tag,interaction_thinking_control,execution_thinking_control FROM model_profiles;
          INSERT INTO entity_model_bindings SELECT entity_id,workspace_id,id FROM model_profiles;
          INSERT INTO model_catalog_migrations(id) VALUES('legacy-employee-v1');`);
      }
    });
  }
  private row(workspaceId: string, profileId: string | null) { return profileId === null ? undefined
    : this.store.one<Row>('SELECT * FROM model_catalog WHERE workspace_id=? AND id=?', workspaceId, profileId); }
  private countReferences(profileId: string): number {
    return this.store.one<{n: number}>('SELECT (SELECT count(*) FROM entity_model_bindings WHERE profile_id=?) + (SELECT count(*) FROM workspace_model_defaults WHERE profile_id=?) AS n', profileId, profileId)!.n;
  }
  private profile(row: Row, source: ModelProfileSource = 'selection') { return dto(row, this.countReferences(row.id), source); }
  list(workspaceId: string): ModelProfile[] { return this.store.all<Row>('SELECT * FROM model_catalog WHERE workspace_id=? ORDER BY name,id', workspaceId).map(row => this.profile(row)); }
  hasCatalog(workspaceId: string): boolean { return !!this.store.one('SELECT id FROM model_catalog WHERE workspace_id=? LIMIT 1', workspaceId); }
  getProfile(workspaceId: string, profileId: string): ModelProfile | null { const row = this.row(workspaceId, profileId); return row ? this.profile(row) : null; }
  defaultProfileId(workspaceId: string): string | null { return this.store.one<{profile_id: string}>('SELECT profile_id FROM workspace_model_defaults WHERE workspace_id=?', workspaceId)?.profile_id ?? null; }
  selectedProfileId(workspaceId: string, entityId: string): string | null { return this.store.one<{profile_id: string}>('SELECT profile_id FROM entity_model_bindings WHERE workspace_id=? AND entity_id=?', workspaceId, entityId)?.profile_id ?? null; }
  get(workspaceId: string, entityId: string): ModelProfile | null { const id = this.selectedProfileId(workspaceId, entityId); return id ? this.getProfile(workspaceId, id) : null; }
  getWorkspace(workspaceId: string): ModelProfile | null { const id = this.defaultProfileId(workspaceId); const row = this.row(workspaceId, id); return row ? this.profile(row, 'workspace_default') : null; }
  effective(workspaceId: string, entityId: string): ModelProfile | null {
    if (!this.store.one('SELECT id FROM entities WHERE id=? AND workspace_id=?', entityId, workspaceId)) return null;
    const selected = this.get(workspaceId, entityId), profile = selected ?? this.getWorkspace(workspaceId);
    return profile ? { ...profile, bindingRevision: JSON.stringify([this.epoch(workspaceId, entityId), ...(selected ? [] : [this.epoch(workspaceId, '')])]) } : null;
  }
  revisionKey(workspaceId: string, entityId: string): string { const p = this.effective(workspaceId, entityId); return p ? JSON.stringify([p.source, p.id, p.configRevision, p.bindingRevision]) : this.hasCatalog(workspaceId) ? 'model_selection_required' : 'model_not_configured'; }
  selectionRevision(workspaceId:string,entityId:string){return [this.epoch(workspaceId,entityId),this.epoch(workspaceId,'')];}
  private epoch(workspaceId: string, entityId: string): number { return this.store.one<{revision: number}>('SELECT revision FROM model_selection_epochs WHERE workspace_id=? AND entity_id=?', workspaceId, entityId)?.revision ?? 0; }
  private bumpEpoch(workspaceId: string, entityId: string): void { this.store.run('INSERT INTO model_selection_epochs(workspace_id,entity_id,revision) VALUES(?,?,1) ON CONFLICT(workspace_id,entity_id) DO UPDATE SET revision=revision+1', workspaceId, entityId); }
  select(workspaceId: string, entityId: string, profileId: string | null): void {
    this.store.transaction(() => {
      if (!this.store.one('SELECT id FROM entities WHERE id=? AND workspace_id=?', entityId, workspaceId)) fail(404, 'entity_not_found');
      if (profileId !== null && !this.row(workspaceId, profileId)) fail(404, 'model_profile_not_found');
      if (profileId !== this.selectedProfileId(workspaceId, entityId)) this.bumpEpoch(workspaceId, entityId);
      if (profileId === null) this.store.run('DELETE FROM entity_model_bindings WHERE workspace_id=? AND entity_id=?', workspaceId, entityId);
      else this.store.run('INSERT INTO entity_model_bindings(entity_id,workspace_id,profile_id) VALUES(?,?,?) ON CONFLICT(entity_id) DO UPDATE SET profile_id=excluded.profile_id', entityId, workspaceId, profileId);
    });
  }
  setDefault(workspaceId: string, profileId: string | null): void {
    this.store.transaction(() => {
    if (!this.store.one('SELECT id FROM workspaces WHERE id=?', workspaceId)) fail(404, 'workspace_not_found');
    if (profileId !== null && !this.row(workspaceId, profileId)) fail(404, 'model_profile_not_found');
    if (profileId !== this.defaultProfileId(workspaceId)) this.bumpEpoch(workspaceId, '');
    if (profileId === null) this.store.run('DELETE FROM workspace_model_defaults WHERE workspace_id=?', workspaceId);
    else this.store.run('INSERT INTO workspace_model_defaults(workspace_id,profile_id) VALUES(?,?) ON CONFLICT(workspace_id) DO UPDATE SET profile_id=excluded.profile_id', workspaceId, profileId);
    });
  }
  deleteProfile(workspaceId: string, profileId: string): void {
    this.store.transaction(() => {
      if (!this.row(workspaceId, profileId)) fail(404, 'model_profile_not_found');
      if (this.countReferences(profileId)) fail(409, 'model_profile_in_use');
      this.clearLegacyCredential(workspaceId, profileId);
      this.store.run('DELETE FROM model_catalog WHERE workspace_id=? AND id=?', workspaceId, profileId);
    });
  }
  private clearLegacyCredential(workspaceId: string, profileId: string): void {
    // Migrated rows are inactive compatibility metadata, not a second retained credential store.
    this.store.run('UPDATE model_profiles SET enabled=0,secret_ref=NULL,ciphertext=NULL,nonce=NULL,tag=NULL WHERE workspace_id=? AND id=?', workspaceId, profileId);
  }
  revoke(workspaceId: string, profileId: string): ModelProfile {
    return this.store.transaction(() => {
      if (!this.row(workspaceId, profileId)) fail(404, 'model_profile_not_found');
      this.store.run('UPDATE model_catalog SET enabled=0,secret_ref=NULL,ciphertext=NULL,nonce=NULL,tag=NULL,revision=revision+1 WHERE workspace_id=? AND id=?', workspaceId, profileId);
      this.clearLegacyCredential(workspaceId, profileId);
      return this.getProfile(workspaceId, profileId)!;
    });
  }
  setEnabled(workspaceId:string,profileId:string,value:unknown){
    const body=value as {enabled?:unknown;expectedVersion?:unknown};
    if(!body||typeof body.enabled!=='boolean'||!Number.isSafeInteger(body.expectedVersion)||Object.keys(body).some(k=>!['enabled','expectedVersion'].includes(k)))return fail(400,'invalid_model_status');
    return this.store.transaction(()=>{const row=this.row(workspaceId,profileId);if(!row)return fail(404,'model_profile_not_found');if(row.revision!==body.expectedVersion)return fail(409,'model_profile_changed');if(body.enabled&&!row.secret_ref)return fail(409,'model_profile_unavailable');
      const next={...row,enabled:body.enabled?1:0,revision:row.revision+1};
      // Revision participates in AAD: reseal the same credential under the new revision.
      if(row.secret_ref){const secret=this.decrypt(row),nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.requireKey(),nonce);cipher.setAAD(this.aad(next));next.ciphertext=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]).toString('base64');next.nonce=nonce.toString('base64');next.tag=cipher.getAuthTag().toString('base64');}
      this.store.run('UPDATE model_catalog SET enabled=?,revision=?,ciphertext=?,nonce=?,tag=? WHERE workspace_id=? AND id=? AND revision=?',next.enabled,next.revision,next.ciphertext,next.nonce,next.tag,workspaceId,profileId,row.revision);return this.getProfile(workspaceId,profileId)!;
    });
  }
  delete(workspaceId: string, entityId: string): void { this.select(workspaceId, entityId, null); }
  deleteWorkspace(workspaceId: string): void { this.setDefault(workspaceId, null); }
  private requireKey(): Buffer { return this.key ?? fail(503, 'model_secret_store_unconfigured'); }
  private endpoint(value: unknown): string {
    if (typeof value !== 'string' || value.length > 2048) return fail(400, 'invalid_model_endpoint');
    let url: URL;
    try { url = new URL(value); } catch { return fail(400, 'invalid_model_endpoint'); }
    if (url.username || url.password || url.search || url.hash) fail(400, 'invalid_model_endpoint');
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && this.loopback)) fail(400, 'model_endpoint_requires_tls');
    // Model destinations are user-configured. Redirects stay disabled in inference clients;
    // deployment network policy owns any further egress restrictions.
    return url.href.replace(/\/+$/, '');
  }
  private aad(row: Row): Buffer { return Buffer.from(JSON.stringify([row.workspace_id, row.entity_id ?? 'workspace', row.id, row.endpoint, row.model_id, row.secret_ref, row.revision, 'model-inference',...(row.protocol&&row.protocol!=='chat_completions'?[row.protocol]:[])])); }
  private decrypt(row: Row): string {
    const key = this.requireKey();
    if (!row.secret_ref || !row.ciphertext || !row.nonce || !row.tag) return fail(409, 'model_credential_missing');
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(row.nonce, 'base64'));
      decipher.setAAD(this.aad(row)); decipher.setAuthTag(Buffer.from(row.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(row.ciphertext, 'base64')), decipher.final()]).toString('utf8');
    } catch { return fail(503, 'model_credential_unavailable'); }
  }
  private candidate(workspaceId: string, profileId: string | null, input: ModelProfileInput) {
    this.requireKey();
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['provider','protocol', 'endpoint', 'modelId', 'apiKey', 'enabled', 'interactionThinking', 'interactionThinkingControl', 'executionThinking', 'executionThinkingControl', 'connectionTestReceipt', 'name', 'bindEntityId', 'setAsDefault'].includes(k))) fail(400, 'invalid_model_profile');
    if(input.protocol!==undefined&&!(MODEL_PROTOCOLS as readonly unknown[]).includes(input.protocol))fail(400,'invalid_model_protocol');
    if (input.provider !== 'openai-compatible' || typeof input.modelId !== 'string' || !input.modelId.trim() || input.modelId.length > 200 || (input.enabled !== undefined && typeof input.enabled !== 'boolean')) fail(400, 'invalid_model_profile');
    if (input.apiKey !== undefined && input.apiKey !== null && (typeof input.apiKey !== 'string' || !input.apiKey.trim() || input.apiKey.length > 8192 || /[\r\n\0]/.test(input.apiKey))) fail(400, 'invalid_model_credential');
    if (['interactionThinking','interactionThinkingControl','executionThinking','executionThinkingControl'].some(key => Object.hasOwn(input,key))) fail(400, 'model_thinking_configuration_removed');
    const endpoint = this.endpoint(input.endpoint);
    if (!this.store.one('SELECT id FROM workspaces WHERE id=?', workspaceId)) fail(404, 'workspace_not_found');
    if (profileId !== null && !this.row(workspaceId, profileId)) fail(404, 'model_profile_not_found');
    if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120)) fail(400, 'invalid_model_profile_name');
    if (input.setAsDefault !== undefined && typeof input.setAsDefault !== 'boolean') fail(400, 'invalid_model_profile');
    if (input.bindEntityId !== undefined && (typeof input.bindEntityId !== 'string' || !this.store.one('SELECT id FROM entities WHERE id=? AND workspace_id=?', input.bindEntityId, workspaceId))) fail(404, 'entity_not_found');
    const old = this.row(workspaceId, profileId);
    if (old && old.endpoint !== endpoint && input.apiKey === undefined && old.secret_ref) fail(409, 'endpoint_change_requires_credential_replacement');
    const secret = input.apiKey === null ? null : input.apiKey ?? (old?.secret_ref ? this.decrypt(old) : null);
    return {old,secret,endpoint,protocol:input.protocol??old?.protocol??'chat_completions', name: input.name?.trim() ?? old?.name ?? input.modelId.trim(), modelId: input.modelId.trim(), enabled: input.enabled !== false,
      interactionThinkingControl: old?.interaction_thinking_control ?? 'unconfigured',
      executionThinkingControl: old?.execution_thinking_control ?? 'unconfigured' };
  }
  private binding(workspaceId: string, profileId: string | null, input: ModelProfileInput): string {
    const c = this.candidate(workspaceId, profileId, input);
    // Secret-dependent HMAC never leaves this service. Bind exact scope and current profile identity,
    // including deletion/recreation, credential operation and all effective configuration fields.
    return createHmac('sha256', this.receiptKey).update(JSON.stringify([workspaceId, profileId,
      c.old?.id ?? null, c.old?.revision ?? 0, c.name, input.bindEntityId ?? null, input.setAsDefault === true, input.bindEntityId ? this.epoch(workspaceId, input.bindEntityId) : null, input.setAsDefault ? this.epoch(workspaceId, '') : null, c.endpoint,c.protocol, c.modelId, input.provider, c.enabled,
      BUILTIN_THINKING_POLICY_VERSION, c.secret, input.apiKey === undefined ? 'retain' : 'replace'])).digest('hex');
  }
  /** Explicit user-triggered provider requests only. No business data, retries or redirects. */
  async testConnection(workspaceId: string, profileId: string | null, actorId: string, input: ModelProfileInput): Promise<{ connectionTestReceipt: string; expiresAt: string;inputCapabilities:ModelInputCapabilities }> {
    if (!actorId) fail(403, 'model_profile_actor_required');
    const c = this.candidate(workspaceId, profileId, input), binding = this.binding(workspaceId, profileId, input);
    if (!c.secret) fail(409, 'model_credential_missing');
    const interaction = interactionThinkingParameters();
    const probeKey = JSON.stringify([actorId, workspaceId, profileId]);
    if (this.probes.has(probeKey)) fail(429, 'model_connection_test_in_progress');
    this.probes.add(probeKey);
    const probeId=randomUUID(),probe=new ModelProbeDiagnostics(this.optionsDiagnostics,'text',c.protocol,modelProtocolEndpoint(c.endpoint,c.protocol),probeId);
    try {
      const signal = AbortSignal.timeout(20_000);
      for (const parameters of [interaction]) {
        const response = await fetch(modelProtocolEndpoint(c.endpoint,c.protocol), { method: 'POST', redirect: 'error', signal,
          headers:modelProtocolHeaders(c.secret??fail(409,'model_credential_missing'),c.protocol),
          body: JSON.stringify(modelProtocolRequest({ model: c.modelId, messages: [{ role: 'user', content: 'Reply OK.' }], max_completion_tokens: 64, stream: false, ...parameters },c.protocol)) });
        probe.response(response.status,response.headers.get('content-type'));
        if (!response.ok) { probe.mark('http_status');await response.body?.cancel(); fail(502, [400,422].includes(response.status) ? 'model_parameters_incompatible' : 'model_connection_test_failed'); }
        // Bound provider-controlled response size and never reflect its contents/errors to callers.
        const reader = response.body?.getReader();
        if (!reader) {probe.mark('empty_body');fail(502, 'model_connection_test_invalid_response');}
        const chunks: Uint8Array[] = []; let size = 0;
        try {
          for (;;) { let part:ReadableStreamReadResult<Uint8Array>;try{part=await reader!.read();}catch(error){probe.mark('body_read');throw error;}if (part.done) break;
            size += part.value.byteLength; if (size > 65_536) { probe.mark('body_limit');await reader!.cancel(); fail(502, 'model_connection_test_invalid_response'); } chunks.push(part.value); }
        } finally { reader!.releaseLock(); }
        let body: { choices?: { message?: { role?: unknown; content?: unknown }; finish_reason?: unknown }[] };
        let parsed:unknown;
        try { parsed=JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {probe.mark(size===0?'empty_body':'payload_json');return fail(502, 'model_connection_test_invalid_response');}
        try {body=modelProtocolResponse(parsed,c.protocol) as typeof body;}catch{probe.mark('protocol_shape');return fail(502,'model_connection_test_invalid_response');}
        const choice = body?.choices?.[0];
        if (!choice?.message) {probe.mark('choice_missing');return fail(502,'model_connection_test_invalid_response');}
        if(typeof choice.message.content !== 'string' && choice.message.content !== null){probe.mark('protocol_shape');fail(502,'model_connection_test_invalid_response');}
        if(!['stop','length'].includes(String(choice.finish_reason))){probe.mark(responseShapeIssue(c.protocol,parsed));fail(502,'model_connection_test_invalid_response');}
      }
      probe.mark('passed');probe.finish();
      const image=await probeImageInput({endpoint:c.endpoint,modelId:c.modelId,protocol:c.protocol,apiKey:c.secret??fail(409,'model_credential_missing'),diagnostics:this.optionsDiagnostics,probeId});
      const inputCapabilities:ModelInputCapabilities={text:'passed',image,testedAt:new Date().toISOString(),probeVersion:1};
      if (this.binding(workspaceId, profileId, input) !== binding) fail(409, 'model_connection_test_stale');
      const now = Date.now();
      for (const [token, receipt] of this.receipts) if (receipt.expiresAt <= now) this.receipts.delete(token);
      if (this.receipts.size >= 1000) fail(429, 'model_connection_test_capacity');
      const connectionTestReceipt = randomBytes(32).toString('base64url'), expiresAt = now + 5 * 60_000;
      this.receipts.set(connectionTestReceipt, { actorId, binding, expiresAt,inputCapabilities });
      return { connectionTestReceipt, expiresAt: new Date(expiresAt).toISOString(),inputCapabilities };
    } catch (error) {
      if (error instanceof ModelProfileError) throw error;
      if(error&&typeof error==='object'&&['TimeoutError','AbortError'].includes(String((error as {name?:unknown}).name)))probe.mark('timeout');
      return fail(502, 'model_connection_test_failed');
    } finally { probe.finish();this.probes.delete(probeKey); }
  }
  saveValidated(workspaceId: string, profileId: string | null, actorId: string, input: ModelProfileInput): ModelProfile {
    return this.withValidatedSave(workspaceId, profileId, actorId, input, save => save());
  }
  /** Consume the receipt only after the whole caller transaction commits, including employee/config writes. */
  withValidatedSave<T>(workspaceId: string, profileId: string | null, actorId: string, input: ModelProfileInput, commit: (save: () => ModelProfile) => T): T {
    const result = this.store.transaction(() => {
      const binding = this.binding(workspaceId, profileId, input);
      const receipt = typeof input.connectionTestReceipt === 'string' ? this.receipts.get(input.connectionTestReceipt) : undefined;
      if (!receipt || receipt.expiresAt <= Date.now() || receipt.actorId !== actorId || receipt.binding !== binding) return fail(409, 'model_connection_test_required');
      return commit(() => this.persist(workspaceId, profileId, input,receipt.inputCapabilities));
    });
    this.receipts.delete(input.connectionTestReceipt!);
    return result;
  }
  /** Stable keyed fingerprint for idempotent drafts; no token or unkeyed credential digest is stored. */
  creationFingerprint(input: unknown): string {
    return createHmac('sha256', this.requireKey()).update(JSON.stringify(input)).digest('hex');
  }
  /** Trusted fixture/import primitives. Production HTTP routes only call saveValidated. */
  save(workspaceId: string, entityId: string, input: ModelProfileInput): ModelProfile {
    return this.store.transaction(() => this.persist(workspaceId, this.selectedProfileId(workspaceId, entityId), { ...input, bindEntityId: entityId }));
  }
  saveWorkspace(workspaceId: string, input: ModelProfileInput): ModelProfile {
    return this.store.transaction(() => this.persist(workspaceId, this.defaultProfileId(workspaceId), { ...input, setAsDefault: true }));
  }
  private persist(workspaceId: string, profileId: string | null, input: ModelProfileInput,inputCapabilities?:ModelInputCapabilities): ModelProfile {
    const key = this.requireKey(), c = this.candidate(workspaceId, profileId, input), old = c.old;
    const row: Row = {protocol:c.protocol,input_capabilities_json:JSON.stringify(inputCapabilities??null), id: old?.id ?? randomUUID(), name: c.name, workspace_id: workspaceId, entity_id: old?.entity_id ?? null, provider: input.provider,
      endpoint: c.endpoint, model_id: c.modelId, secret_ref: c.secret ? (input.apiKey !== undefined ? randomUUID() : old!.secret_ref) : null,
      revision: (old?.revision ?? 0) + 1, enabled: c.enabled ? 1 : 0, ciphertext: null, nonce: null, tag: null,
      interaction_thinking_control: c.interactionThinkingControl, execution_thinking_control: c.executionThinkingControl };
    if (c.secret) {
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(this.aad(row));
      row.ciphertext = Buffer.concat([cipher.update(c.secret, 'utf8'), cipher.final()]).toString('base64');
      row.nonce = nonce.toString('base64'); row.tag = cipher.getAuthTag().toString('base64');
    }
    const columns = ['protocol','input_capabilities_json','id','name','workspace_id','entity_id','provider','endpoint','model_id','secret_ref','revision','enabled','ciphertext','nonce','tag','interaction_thinking_control','execution_thinking_control'];
    this.store.run(`INSERT INTO model_catalog(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})
      ON CONFLICT(id) DO UPDATE SET ${columns.filter(k => !['id','workspace_id','entity_id'].includes(k)).map(k => `${k}=excluded.${k}`).join(',')}`,
      ...columns.map(k => row[k as keyof Row]));
    this.clearLegacyCredential(workspaceId, row.id);
    if (input.bindEntityId !== undefined) this.select(workspaceId, input.bindEntityId, row.id);
    if (input.setAsDefault === true) this.setDefault(workspaceId, row.id);
    return this.profile(row);
  }
  assertEnabledProfile(workspaceId:string,profileId:string){const p=this.row(workspaceId,profileId);if(!p||p.enabled!==1||!p.secret_ref)return fail(409,'model_profile_unavailable');}
  /** Metadata-only check for a remote configuration projection. Credentials are
   * resolved by the owning platform through its protected purpose-bound API. */
  assertConfigured(workspaceId:string,entityId:string):ModelProfile {
    const profile=this.effective(workspaceId,entityId);
    if(!profile)return fail(409,this.hasCatalog(workspaceId)?'model_selection_required':'model_not_configured');
    if(!profile.enabled||!profile.secretRef)return fail(409,'model_profile_unavailable');
    this.endpoint(profile.endpoint);return profile;
  }
  assertUsable(workspaceId: string, entityId: string): ModelProfile {
    const profile = this.effective(workspaceId, entityId);
    if (!profile) return fail(409, this.hasCatalog(workspaceId) ? 'model_selection_required' : 'model_not_configured');
    const row = this.row(workspaceId, profile.id)!;
    if (!profile.enabled || !profile.secretRef) fail(409, 'model_profile_unavailable');
    this.endpoint(row.endpoint); this.decrypt(row);
    return profile;
  }
  /** Callback must revalidate current task/session/requester authority from trusted server state. */
  async resolve(scope: ModelCredentialScope, authorize: (scope: Readonly<ModelCredentialScope>) => boolean | Promise<boolean>): Promise<ResolvedModelCredential> {
    const bound = Object.freeze({ ...scope });
    if (bound.purpose !== 'model-inference' || typeof authorize !== 'function' || (await authorize(bound)) !== true) fail(403, 'model_credential_forbidden');
    this.requireKey();
    const effective = this.effective(bound.workspaceId, bound.entityId);
    if (!effective || (bound.source !== undefined && effective.source !== bound.source)) return fail(409, 'model_profile_unavailable');
    if (bound.bindingRevision !== undefined && bound.bindingRevision !== effective.bindingRevision) fail(409, 'model_profile_unavailable');
    const row = this.row(bound.workspaceId, effective.id);
    if (!row || row.id !== bound.profileId || row.revision !== bound.configRevision || row.enabled !== 1) return fail(409, 'model_profile_unavailable');
    this.endpoint(row.endpoint);
    return {...(row.protocol!=='chat_completions'?{protocol:row.protocol}:{}),provider: row.provider, endpoint: row.endpoint, modelId: row.model_id, apiKey: this.decrypt(row),...(row.input_capabilities_json&&row.input_capabilities_json!=='null'?{inputCapabilities:JSON.parse(row.input_capabilities_json) as ModelInputCapabilities}:{}) };
  }
}

export async function registerModelProfileRoutes(app: FastifyInstance, service: ModelProfileService, auth: {
  requireManager: (request: FastifyRequest, workspaceId: string, entityId: string) => void | Promise<void>;
  requireWorkspaceManager?: (request: FastifyRequest, workspaceId: string) => void | Promise<void>;
  requireWorkspaceMember?: (request: FastifyRequest, workspaceId: string) => void | Promise<void>;
  canManageWorkspace?: (request: FastifyRequest, workspaceId: string) => boolean | Promise<boolean>;
  currentUser?: (request: FastifyRequest) => { id: string };
}) {
  const base = '/api/workspaces/:workspaceId';
  type Action = 'list' | 'create' | 'update' | 'delete' | 'test-create' | 'test-update' | 'default' | 'selection' | 'select' | 'effective' | 'revoke' | 'status';
  const handler = (action: Action) => async (request: FastifyRequest, reply: import('fastify').FastifyReply) => {
    const { workspaceId, entityId, profileId } = request.params as { workspaceId: string; entityId?: string; profileId?: string };
    try {
      if (['selection','select','effective'].includes(action)) await auth.requireManager(request, workspaceId, entityId!);
      else if (action === 'list') {
        if (!auth.requireWorkspaceMember) fail(403, 'workspace_member_required');
        await auth.requireWorkspaceMember!(request, workspaceId);
      } else {
        if (!auth.requireWorkspaceManager) fail(403, 'workspace_manager_required');
        await auth.requireWorkspaceManager!(request, workspaceId);
      }
      if (action === 'list') {
        const canManage = await auth.canManageWorkspace?.(request, workspaceId) ?? false;
        const profiles = service.list(workspaceId);
        return { profiles: canManage ? profiles : profiles.map(p => ({id: p.id, name: p.name, provider: p.provider, modelId: p.modelId, enabled: p.enabled})), defaultProfileId: service.defaultProfileId(workspaceId) };
      }
      const selection = () => { const effectiveProfile = service.effective(workspaceId, entityId!); return { selectedProfileId: service.selectedProfileId(workspaceId, entityId!), effectiveProfile, source: effectiveProfile?.source ?? 'none' }; };
      if (action === 'selection') return selection();
      if (action === 'effective') return service.effective(workspaceId, entityId!);
      if (action === 'select' || action === 'default') {
        const body = request.body as { profileId?: unknown };
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => k !== 'profileId') || (body.profileId !== null && typeof body.profileId !== 'string')) fail(400, 'invalid_model_selection');
        if (action === 'select') { service.select(workspaceId, entityId!, body.profileId as string | null); return selection(); }
        service.setDefault(workspaceId, body.profileId as string | null); return { defaultProfileId: service.defaultProfileId(workspaceId) };
      }
      if (action === 'status') return service.setEnabled(workspaceId,profileId!,request.body);
      if (action === 'revoke') {
        if (request.body !== undefined && (!request.body || typeof request.body !== 'object' || Array.isArray(request.body) || Object.keys(request.body).length > 0)) fail(400, 'invalid_model_revocation');
        return service.revoke(workspaceId, profileId!);
      }
      if (action === 'delete') { service.deleteProfile(workspaceId, profileId!); return reply.code(204).send(); }
      const input = request.body as ModelProfileInput;
      if (input?.bindEntityId !== undefined) await auth.requireManager(request, workspaceId, input.bindEntityId);
      const actorId = auth.currentUser?.(request).id ?? fail(403, 'model_profile_actor_required');
      if (action === 'test-create' || action === 'test-update') return await service.testConnection(workspaceId, action === 'test-create' ? null : profileId!, actorId, input);
      return service.saveValidated(workspaceId, action === 'create' ? null : profileId!, actorId, input);
    } catch (error) { if (error instanceof ModelProfileError) return reply.code(error.status).send({ error: error.code }); throw error; }
  };
  app.get(`${base}/model-profiles`, handler('list'));
  app.post(`${base}/model-profiles`, handler('create'));
  app.put(`${base}/model-profiles/:profileId`, handler('update'));
  app.delete(`${base}/model-profiles/:profileId`, handler('delete'));
  app.post(`${base}/model-profiles/:profileId/revoke`, handler('revoke'));
  app.put(`${base}/model-profiles/:profileId/status`,handler('status'));
  app.put(`${base}/model-default`, handler('default'));
  app.post(`${base}/model-profiles/test-connection`, { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, handler('test-create'));
  app.post(`${base}/model-profiles/:profileId/test-connection`, { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, handler('test-update'));
  app.get(`${base}/entities/:entityId/model-profile`, handler('selection'));
  app.put(`${base}/entities/:entityId/model-profile`, handler('select'));
  app.get(`${base}/entities/:entityId/effective-model-profile`, handler('effective'));
}
