import { randomUUID } from 'node:crypto';
import { registerApp } from '@larksuiteoapi/node-sdk';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { DirectoryError } from '@dentity/application';
import { createDirectoryAdapter } from '../adapters/directory/index.js';
import { DirectoryCredentialVault, type SealedDirectoryCredential } from '../directory/secrets.js';
import { EmployeeApplicationTransport } from './provider.js';
import { EmployeeChannelError, type EmployeeChannelService } from './service.js';
import type { EmployeeChannelOptions, VerifiedEmployeeApplication } from './types.js';
import { validationOf, type ChannelValidation } from './validation.js';

/** Versioned, application-only profile for current conversation/directory behavior.
 * No document, meeting, OAuth, or application-management permissions. */
export const FEISHU_REGISTRATION_PERMISSIONS = {
  version: 'conversation-directory-v1',
  scopes: [
    'tenant:tenant:readonly', 'contact:contact.base:readonly', 'contact:user.base:readonly',
    'contact:user.employee:readonly', 'contact:user.department:readonly',
    'contact:department.base:readonly', 'contact:department.organize:readonly',
    'contact:user.employee_id:readonly',
    'im:message.p2p_msg:readonly', 'im:message.group_at_msg:readonly', 'im:message:send_as_bot',
    'im:message:readonly', 'im:message.group_msg', 'im:chat:readonly',
  ],
  events: ['im.message.receive_v1', 'im.chat.member.bot.added_v1',
    'im.chat.member.bot.deleted_v1', 'im.chat.disbanded_v1'],
} as const;

type State = 'starting' | 'awaiting_confirmation' | 'credentials_saved' | 'checking' |
  'needs_attention' | 'connected' | 'cancelled' | 'expired' | 'denied' | 'failed' | 'interrupted';
type Registration = {
  id: string; workspaceId: string; entityId: string; actorId: string; operationId: string;
  state: State; updatedAt: number; expiresAt: number; name: string; description: string;
  appId?: string; secret?: SealedDirectoryCredential; error?: string;
  missingScopes?: string[]; validation?: ChannelValidation;
};
type Live = { controller: AbortController; timer: ReturnType<typeof setTimeout>; url?: string };
const pending = (r: Registration) => ['starting', 'awaiting_confirmation'].includes(r.state);
const fail = (status: number, code: string): never => { throw new EmployeeChannelError(status, code); };
const validId = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v);
const validAppId = (v: unknown): v is string => typeof v === 'string' && /^cli_[a-zA-Z0-9_]{1,250}$/.test(v);
function missingPermissions(report: ChannelValidation | undefined): string[] {
  const inventory = report?.checks.find(c => c.id === 'scope_inventory')?.scopeInventory ?? [];
  return FEISHU_REGISTRATION_PERMISSIONS.scopes.filter(scope => {
    const rows = inventory.filter(item => item.scope === scope && item.identity === 'tenant');
    return !rows.length || rows.some(item => item.status !== 'granted');
  });
}

/** Platform-only durable setup. Incomplete credentials are never runtime configuration. */
export class FeishuAppRegistration {
  private readonly vault: DirectoryCredentialVault;
  private readonly now: () => number;
  private readonly live = new Map<string, Live>();
  private readonly checking = new Set<string>();
  private closed = false;
  constructor(private readonly channels: EmployeeChannelService, private readonly options: EmployeeChannelOptions,
    private readonly authorize: (workspaceId: string, entityId: string, actorId: string) => void = () => {}) {
    this.vault = new DirectoryCredentialVault(options.masterKey);
    this.now = options.now ?? Date.now;
    channels.repository.store.db.exec(`CREATE TABLE IF NOT EXISTS feishu_app_registrations (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      entity_id TEXT NOT NULL REFERENCES entities(id), actor_id TEXT NOT NULL REFERENCES users(id),
      operation_id TEXT NOT NULL, record_json TEXT NOT NULL,
      UNIQUE(workspace_id,entity_id,operation_id));`);
  }
  private get store() { return this.channels.repository.store; }
  private read(id: string): Registration | undefined {
    const row = this.store.one<{ record_json: string }>('SELECT record_json FROM feishu_app_registrations WHERE id=?', id);
    return row ? JSON.parse(row.record_json) as Registration : undefined;
  }
  private latest(w: string, e: string): Registration | undefined {
    const row = this.store.one<{ record_json: string }>('SELECT record_json FROM feishu_app_registrations WHERE workspace_id=? AND entity_id=? ORDER BY rowid DESC LIMIT 1', w, e);
    return row ? JSON.parse(row.record_json) as Registration : undefined;
  }
  private write(r: Registration) {
    r.updatedAt = this.now();
    this.store.run('UPDATE feishu_app_registrations SET record_json=? WHERE id=?', JSON.stringify(r), r.id);
  }
  private scope(r: Registration) { return ['feishu-registration', r.workspaceId, r.entityId, r.actorId, r.id]; }
  private entity(w: string, e: string) {
    return this.store.one<{ name: string; description: string }>('SELECT name,description FROM entities WHERE workspace_id=? AND id=?', w, e) ?? fail(404, 'entity_not_found');
  }
  private owned(w: string, e: string, a: string, id: string) {
    if (!validId(id)) fail(400, 'invalid_feishu_registration');
    const r = this.read(id);
    if (!r || r.workspaceId !== w || r.entityId !== e || r.actorId !== a) return fail(404, 'feishu_registration_not_found');
    return r;
  }
  private stop(id: string) {
    const live = this.live.get(id);
    if (live) { this.live.delete(id); clearTimeout(live.timer); live.controller.abort(); }
  }
  private settle(r: Registration, state: State, error?: string) {
    this.stop(r.id); r.state = state; delete r.error;
    if (error) r.error = error;
    this.write(r);
  }
  private reconcile(r: Registration) {
    if (pending(r) && !this.live.has(r.id)) this.settle(r, 'interrupted', 'feishu_registration_interrupted');
    if (r.state === 'checking' && !this.checking.has(r.id)) {
      r.state = 'needs_attention'; r.error = 'feishu_registration_verification_interrupted'; this.write(r);
    }
    if (pending(r) && r.expiresAt <= this.now()) this.settle(r, 'expired', 'feishu_registration_expired');
    const current = this.channels.repository.byProvider(r.workspaceId, r.entityId, 'feishu');
    // A crash may occur after the channel's guarded transaction commits and before
    // the setup record is marked complete. Recover only from the exact enabled
    // binding with independently persisted evidence for this entire profile.
    if (r.secret && r.appId && ['credentials_saved', 'checking', 'needs_attention'].includes(r.state) &&
      current?.appId === r.appId && current.enabled && current.status === 'verified' &&
      current.botId && current.directoryStatus === 'available' && current.validation?.canContinue &&
      !missingPermissions(current.validation).length) {
      r.state = 'connected'; r.validation = current.validation;
      delete r.secret; delete r.error; delete r.missingScopes; this.write(r);
    }
    if (r.state === 'connected' && (!current || current.appId !== r.appId)) {
      r.state = 'needs_attention'; r.error = 'feishu_registration_connection_changed'; this.write(r);
    }
    return r;
  }
  status(w: string, e: string, a: string) {
    const preset = this.entity(w, e), latest = this.latest(w, e);
    const r = latest?.actorId === a ? this.reconcile(latest) : undefined;
    const live = r && this.live.get(r.id);
    return { preset, permissions: FEISHU_REGISTRATION_PERMISSIONS, registration: r ? {
      id: r.id, state: r.state, updatedAt: r.updatedAt, credentialSaved: !!r.secret || r.state === 'connected',
      ...(r.appId ? { appId: r.appId } : {}), ...(pending(r) ? { expiresAt: r.expiresAt } : {}),
      ...(live?.url && pending(r) ? { verificationUrl: live.url } : {}),
      ...(r.error ? { error: r.error } : {}), ...(r.missingScopes ? { missingScopes: r.missingScopes } : {}),
      ...(r.validation ? { validation: r.validation } : {}),
    } : null };
  }
  start(w: string, e: string, a: string, operationId: unknown) {
    if (this.closed) fail(503, 'feishu_registration_unavailable');
    const operation = validId(operationId) ? operationId : fail(400, 'invalid_feishu_registration');
    if (!this.vault.available) fail(503, 'channel_secret_key_unconfigured');
    this.authorize(w, e, a);
    const preset = this.entity(w, e);
    const replay = this.store.one<{ id: string }>('SELECT id FROM feishu_app_registrations WHERE workspace_id=? AND entity_id=? AND operation_id=?', w, e, operation);
    if (replay) { this.owned(w, e, a, replay.id); return this.status(w, e, a); }
    if (this.channels.repository.byProvider(w, e, 'feishu')) fail(409, 'feishu_registration_already_connected');
    const old = this.latest(w, e);
    if (old) {
      this.reconcile(old);
      if (pending(old) || old.secret || old.state === 'checking') fail(409, 'feishu_registration_in_progress');
    }
    if (this.live.size >= 32) fail(429, 'feishu_registration_busy');
    const r: Registration = { id: randomUUID(), workspaceId: w, entityId: e, actorId: a,
      operationId: operation, name: preset.name, description: preset.description, state: 'starting',
      updatedAt: this.now(), expiresAt: this.now() + 10 * 60_000 };
    this.store.run('INSERT INTO feishu_app_registrations VALUES(?,?,?,?,?,?)', r.id, w, e, a, operation, JSON.stringify(r));
    const controller = new AbortController();
    const timer = setTimeout(() => { const current = this.read(r.id); if (current && pending(current)) this.settle(current, 'expired', 'feishu_registration_expired'); }, 10 * 60_000);
    timer.unref(); this.live.set(r.id, { controller, timer });
    void this.register(r, controller).catch(() => {
      if (this.closed) return;
      const current = this.read(r.id); if (current && pending(current)) this.settle(current, 'failed', 'feishu_registration_unavailable');
    });
    return this.status(w, e, a);
  }
  private async register(r: Registration, controller: AbortController) {
    try {
      const result = await (this.options.registerFeishuApp ?? registerApp)({
        createOnly: true, source: 'identale', signal: controller.signal,
        appPreset: { name: r.name, desc: r.description },
        addons: { preset: false, scopes: { tenant: [...FEISHU_REGISTRATION_PERMISSIONS.scopes] },
          events: { items: { tenant: [...FEISHU_REGISTRATION_PERMISSIONS.events] } } },
        onQRCodeReady: info => {
          if (this.closed || controller.signal.aborted) return;
          const current = this.read(r.id), live = this.live.get(r.id);
          if (this.closed || controller.signal.aborted || !current || !pending(current) || !live) return;
          let url: URL;
          try { url = new URL(info.url); } catch { throw new Error('invalid_url'); }
          if (url.protocol !== 'https:' || url.username || url.password || !['accounts.feishu.cn', 'open.feishu.cn'].includes(url.hostname) || !!url.port || !Number.isFinite(info.expireIn) || info.expireIn <= 0) throw new Error('invalid_url');
          live.url = url.toString(); current.expiresAt = Math.min(current.expiresAt, this.now() + info.expireIn * 1000);
          current.state = 'awaiting_confirmation'; this.write(current);
        },
        onStatusChange: info => {
          if (this.closed || controller.signal.aborted || info.status !== 'domain_switched') return;
          const current = this.read(r.id);
          if (current && pending(current)) this.settle(current, 'failed', 'feishu_registration_lark_unsupported');
        },
      });
      if (this.closed || controller.signal.aborted) return;
      const current = this.read(r.id);
      if (!current || !pending(current)) return;
      if (current.expiresAt <= this.now()) { this.settle(current, 'expired', 'feishu_registration_expired'); return; }
      if (result.user_info?.tenant_brand === 'lark') { this.settle(current, 'failed', 'feishu_registration_lark_unsupported'); return; }
      if (!validAppId(result.client_id) || typeof result.client_secret !== 'string' || !result.client_secret.trim() || result.client_secret.length > 8192 || /[\r\n\0]/.test(result.client_secret)) throw new Error('invalid_credentials');
      this.stop(r.id);
      current.appId = result.client_id;
      current.secret = this.vault.seal(result.client_secret, this.scope(current));
      current.state = 'credentials_saved'; this.write(current);
      this.beginCheck(current);
    } catch (error) {
      if (this.closed) return;
      const current = this.read(r.id);
      if (!current || !pending(current)) return;
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      const state = code === 'access_denied' ? 'denied' : code === 'expired_token' ? 'expired' : code === 'abort' ? 'cancelled' : 'failed';
      this.settle(current, state, `feishu_registration_${state}`);
    }
  }
  retry(w: string, e: string, a: string, id: string) {
    this.authorize(w, e, a);
    const r = this.reconcile(this.owned(w, e, a, id));
    if (r.state === 'connected' || this.checking.has(id)) return this.status(w, e, a);
    if (!r.secret || !r.appId) fail(409, 'feishu_registration_credentials_required');
    this.beginCheck(r); return this.status(w, e, a);
  }
  cancel(w: string, e: string, a: string, id: string) {
    const r = this.owned(w, e, a, id);
    if (pending(r)) this.settle(r, 'cancelled', 'feishu_registration_cancelled');
    // Credentials already returned remain encrypted and recoverable; cancelling a local
    // wait does not delete or revoke the external application.
    return this.status(w, e, a);
  }
  private beginCheck(r: Registration) {
    if (this.closed || this.checking.has(r.id)) return;
    this.checking.add(r.id); r.state = 'checking'; delete r.error; delete r.missingScopes; delete r.validation; this.write(r);
    void this.check(r).catch(() => {
      if (!this.closed) { const current = this.read(r.id); if (current?.state === 'checking') { current.state = 'needs_attention'; current.error = 'feishu_registration_verification_failed'; this.write(current); } }
    }).finally(() => this.checking.delete(r.id));
  }
  private current(r: Registration) {
    if (this.closed || this.read(r.id)?.state !== 'checking') fail(409, 'feishu_registration_interrupted');
    this.authorize(r.workspaceId, r.entityId, r.actorId);
    if (this.channels.repository.byProvider(r.workspaceId, r.entityId, 'feishu')) fail(409, 'feishu_registration_connection_changed');
  }
  private validateRequired(r: Registration, verified: VerifiedEmployeeApplication) {
      const report = verified.validation;
      const missing = missingPermissions(report);
      if (report) r.validation = report;
      if (missing.length) { r.missingScopes = missing; throw new EmployeeChannelError(409, 'feishu_registration_permissions_missing'); }
      if (!report?.canContinue || verified.directoryStatus !== 'available' || !verified.botId) throw new EmployeeChannelError(409, 'feishu_registration_validation_required');
  }
  private async check(r: Registration) {
    try {
      this.current(r);
      const appSecret = this.vault.open(r.secret!, this.scope(r));
      const directory = this.options.adapterFactory?.('feishu', { appId: r.appId!, appSecret }) ?? createDirectoryAdapter('feishu', { appId: r.appId!, appSecret, ...(this.options.fetch ? { fetch: this.options.fetch } : {}), ...(this.options.now ? { now: this.options.now } : {}) });
      const verified = this.options.verifyApplication ? await this.options.verifyApplication('feishu', r.appId!, { appSecret }) : await new EmployeeApplicationTransport('feishu', r.appId!, { appSecret }, this.options).verify(directory);
      this.current(r);
      this.validateRequired(r, verified);
      // Persist and enable only via the existing validation/binding path. Its final
      // guarded write fences employee changes, authorization withdrawal and manual binding.
      await this.channels.save(r.workspaceId, r.entityId, 'feishu', r.actorId,
        { appId: r.appId!, appSecret, expectedRevision: 0 }, latest => { this.current(r); this.validateRequired(r, latest); });
      if (this.closed) return;
      r.state = 'connected'; delete r.secret; delete r.error; delete r.missingScopes;
      this.write(r);
    } catch (error) {
      if (this.closed) return;
      const current = this.read(r.id);
      if (!current || current.state !== 'checking') return;
      r.state = 'needs_attention';
      const report = error instanceof EmployeeChannelError ? error.validation : validationOf(error);
      if (report) r.validation = report;
      r.error = error instanceof EmployeeChannelError ? error.code : error instanceof DirectoryError ? error.code : 'feishu_registration_verification_failed';
      this.write(r);
    }
  }
  close() {
    this.closed = true;
    for (const id of [...this.live.keys()]) { const r = this.read(id); if (r && pending(r)) this.settle(r, 'interrupted', 'feishu_registration_interrupted'); else this.stop(id); }
  }
}

export function registerFeishuAppRegistrationRoutes(app: FastifyInstance, service: FeishuAppRegistration,
  requireManager: (request: FastifyRequest, workspaceId: string, entityId: string) => string | Promise<string>) {
  const base = '/api/workspaces/:workspaceId/entities/:entityId/channels/feishu/registration';
  for (const action of ['status', 'start', 'retry', 'cancel'] as const) app.route({
    method: action === 'status' ? 'GET' : 'POST', url: base + (['retry', 'cancel'].includes(action) ? `/${action}` : ''),
    ...(action !== 'status' ? { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } } : {}),
    handler: async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const { workspaceId: w, entityId: e } = request.params as { workspaceId: string; entityId: string };
      const a = await requireManager(request, w, e);
      try {
        const body = request.body ?? {}, key = action === 'start' ? 'operationId' : 'id';
        if (action !== 'status' && (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !validId((body as Record<string, unknown>)[key]))) fail(400, 'invalid_feishu_registration');
        const value = (body as Record<string, string>)[key]!;
        return action === 'status' ? service.status(w, e, a) : action === 'start' ? service.start(w, e, a, value) : service[action](w, e, a, value);
      } catch (error) {
        if (error instanceof EmployeeChannelError) return reply.code(error.status).send({ error: error.code });
        return reply.code(503).send({ error: 'feishu_registration_unavailable' });
      }
    },
  });
}
