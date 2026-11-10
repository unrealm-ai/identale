import { randomBytes, randomUUID } from 'node:crypto';
import { accountInput, DirectoryError, type DirectoryPort, type DirectoryProvider, type DirectoryAuthorizedScope } from '@dentity/application';
import { DirectoryCredentialVault } from '../directory/secrets.js';
import { DirectoryCursors } from '../adapters/directory/http.js';
import { createDirectoryAdapter } from '../adapters/directory/index.js';
import { EmployeeApplicationTransport } from './provider.js';
import { channelSubject, EmployeeChannelError, type EmployeeChannelService } from './service.js';
import type { EmployeeChannelOptions, EmployeeChannelRecord } from './types.js';
import {validationOf,wecomBotValidation} from './validation.js';
import type {VerifiedEmployeeApplication} from './types.js';

const fail = (status: number, code: string): never => { throw new EmployeeChannelError(status, code); };
const validId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\x00-\x1f]/.test(v);
const scopeSummary=(scope:DirectoryAuthorizedScope)=>({entireOrganization:scope.entireOrganization,departmentCount:scope.disclosed?.departments===false?null:scope.departmentIds.length,userCount:scope.disclosed?.users===false?null:scope.userIds.length,...(scope.disclosed?{disclosed:scope.disclosed}:{})});
type Draft = { id: string; workspaceId: string; actorId: string; expiresAt: number; record: EmployeeChannelRecord; directory?: DirectoryPort; scope: DirectoryAuthorizedScope; secret: ReturnType<DirectoryCredentialVault['seal']> };


/** No employee, connection, credential or organization rows are written by prepare/discovery. */
export class EmployeeChannelCreationDrafts {
  private readonly drafts = new Map<string, Draft>();
  private readonly preparing = new Set<string>();
  private readonly vault: DirectoryCredentialVault;
  private readonly cursors = new DirectoryCursors();
  private readonly now: () => number;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly channels: EmployeeChannelService, private readonly options: EmployeeChannelOptions) {
    this.vault = new DirectoryCredentialVault(options.masterKey); this.now = options.now ?? Date.now;
    this.timer = setInterval(() => this.prune(), 30_000); this.timer.unref();
  }
  close() { clearInterval(this.timer); this.drafts.clear(); }
  private prune() { for (const [id,d] of this.drafts) if(d.expiresAt<=this.now())this.drafts.delete(id); }
  private draft(workspaceId: string, actorId: string, id: string) {
    this.prune(); const d = this.drafts.get(id);
    if (!d || d.workspaceId !== workspaceId || d.actorId !== actorId) return fail(409, 'channel_creation_draft_required');
    return d;
  }
  private validateSecret(value: unknown) { if (typeof value !== 'string' || !value.trim() || value.length > 8192 || /[\r\n\0]/.test(value)) fail(400, 'invalid_channel_credentials'); }
  async prepare(workspaceId: string, actorId: string, raw: unknown) {
    this.prune(); if (!this.vault.available) fail(503, 'channel_secret_key_unconfigured');
    const key = JSON.stringify([workspaceId, actorId]);
    if (this.preparing.has(key) || this.drafts.size >= 500) fail(429, 'channel_creation_draft_busy');
    const input = accountInput(raw, ['provider', 'appId', 'appSecret']);
    if (!['feishu', 'dingtalk', 'wecom'].includes(input['provider'] as string) || !validId(input['appId'])) fail(400, 'invalid_channel_credentials');
    this.validateSecret(input['appSecret']);
    const provider = input['provider'] as DirectoryProvider, appId = input['appId'] as string, appSecret = input['appSecret'] as string;
    const id = randomBytes(32).toString('base64url');
    this.preparing.add(key);
    try {
      let directory: DirectoryPort|undefined, verified:VerifiedEmployeeApplication;
      if (provider==='wecom') {
        verified={identity:{appId,tenantId:appId,tenantIdNamespace:'app_id'},botId:appId,directoryStatus:'unavailable',validation:wecomBotValidation(this.now)};
      } else {
        directory = this.options.adapterFactory?.(provider, { appId, appSecret }) ?? createDirectoryAdapter(provider, { appId, appSecret, ...(this.options.fetch ? { fetch: this.options.fetch } : {}), ...(this.options.now ? { now: this.options.now } : {}) });
        verified = this.options.verifyApplication ? await this.options.verifyApplication(provider, appId, { appSecret }) : await new EmployeeApplicationTransport(provider, appId, { appSecret }, this.options).verify(directory);
        if (verified.identity.appId !== appId || !validId(verified.identity.tenantId) || provider==='feishu'&&verified.directoryStatus !== 'available') fail(400, 'channel_directory_unavailable');
      }
      if(verified.validation&&!verified.validation.canContinue)throw new EmployeeChannelError(400,'channel_validation_failed',verified.validation);
      const {authorizedScope,...verifiedApplication}=verified;
      const scope = authorizedScope??(directory&&verified.directoryStatus==='available'?await directory.getAuthorizedScope():{
        departmentIds:[],userIds:[],entireOrganization:false,revision:'unavailable',disclosed:{departments:false,users:false},
      });
      const record: EmployeeChannelRecord = { id: randomUUID(), sourceId: randomUUID(), workspaceId, entityId: '', provider, appId, ...verifiedApplication,
        revision: 1, authRevision: 1, stateVersion: 0, enabled: true, status: provider==='feishu' && verified.botId && verified.eventTenantId ? 'verified' : 'pending_verification',
        identityEvidence: provider==='feishu'&&verified.botId&&verified.eventTenantId ? 'provider_api' : 'app_credentials_only', inboundVerified: false,
        ...(provider==='feishu'?{context:{historyEnabled:false,groupListenEnabled:true,listenGeneration:0,meetingRefs:[]}}:provider==='wecom'?{context:{historyEnabled:false,wecomRecentGroupContextEnabled:true,wecomRecentGroupContextGeneration:0,meetingRefs:[]}}:{}),lastError: null, credential: { ciphertext: '', nonce: '', tag: '' }, createdBy: actorId, updatedBy: actorId };
      const d: Draft = { id, workspaceId, actorId, expiresAt: this.now() + 10 * 60_000, record, ...(directory?{directory}:{}), scope, secret: this.vault.seal(JSON.stringify({ appSecret }), ['employee-creation-draft', workspaceId, actorId, id]) };
      this.drafts.set(id, d);
      return { draftId: id, expiresAt: d.expiresAt, source: this.channels.dto(record), ...(record.validation?{validation:record.validation}:{}), scope: scopeSummary(scope) };
    } catch (error) { if(error instanceof EmployeeChannelError)throw error;if (error instanceof DirectoryError) throw new EmployeeChannelError(400,validationOf(error)?'channel_validation_failed':error.code,validationOf(error)); throw new EmployeeChannelError(502, 'channel_connection_unavailable'); }
    finally { this.preparing.delete(key); }
  }
  async discovery(workspaceId: string, actorId: string, id: string, query: { kind: string; parentId?: string; cursor?: string }) {
    const d = this.draft(workspaceId, actorId, id), r = d.record;
    const directory=d.directory;
    if(!directory||r.directoryStatus!=='available')return fail(403,'channel_directory_unavailable');
    if (!['departments', 'users'].includes(query.kind) || query.parentId !== undefined && !validId(query.parentId)) fail(400, 'invalid_directory_query');
    try {
      const scope = await directory.getAuthorizedScope();
      if (scope.revision !== d.scope.revision) { this.drafts.delete(id); fail(409, 'directory_scope_changed'); }
      let values: unknown[], exhausted: boolean, nextCursor: string | undefined;
      if (!query.parentId) {
        const cursorScope = JSON.stringify([id, query.kind, scope.revision]);
        const offset = query.cursor ? Number(this.cursors.decode(cursorScope, query.cursor)) : 0;
        if (!Number.isSafeInteger(offset) || offset < 0) fail(400, 'invalid_directory_cursor');
        const ids = query.kind === 'departments' ? scope.entireOrganization ? [r.provider === 'feishu' ? '0' : '1'] : scope.departmentIds : scope.userIds;
        if (ids.length > 1000) fail(400, 'directory_scope_requires_department_query');
        values = query.kind === 'departments' ? await Promise.all((ids as string[]).slice(offset, offset + 50).map(v => directory.getDepartment(v))) : await Promise.all((ids as typeof scope.userIds).slice(offset, offset + 50).map(v => directory.getUser(v)));
        exhausted = offset + 50 >= ids.length; if (!exhausted) nextCursor = this.cursors.encode(cursorScope, String(offset + 50));
      } else {
        const page = query.kind === 'departments' ? await directory.listChildDepartments(query.parentId, query.cursor) : await directory.listDepartmentMembers(query.parentId, query.cursor);
        values = [...page.items]; exhausted = page.exhausted; nextCursor = page.nextCursor;
      }
      this.draft(workspaceId, actorId, id);
      return { sourceId: r.sourceId, provider: r.provider, appId: r.appId, items: values.map(value => {
        const v = value as { departmentIds?: unknown; id: string | { id: string; namespace: string }; namespace?: string; displayName: string };
        const person = typeof v.id !== 'string', externalId = person ? (v.id as { id: string }).id : v.id as string, namespace = person ? (v.id as { namespace: string }).namespace : v.namespace!;
        const kind = person ? 'channel_user' as const : 'department' as const;
        return { kind, externalId, displayName: v.displayName, subjectId: channelSubject(kind, externalId, namespace, r.appId) };
      }), exhausted, ...(nextCursor ? { nextCursor } : {}) };
    } catch (error) { if (error instanceof DirectoryError && ['authentication_failed', 'authorization_denied'].includes(error.code)) this.drafts.delete(id); if (error instanceof EmployeeChannelError) throw error; throw new EmployeeChannelError(502, error instanceof DirectoryError ? error.code : 'channel_connection_unavailable'); }
  }
  /** Synchronous SQL only. Caller owns the employee/model/package transaction. */
  persist(workspaceId: string, actorId: string, id: string, entityId: string): string {
    const d = this.draft(workspaceId, actorId, id), record = structuredClone(d.record);
    if (!this.channels.repository.store.one('SELECT id FROM entities WHERE workspace_id=? AND id=?', workspaceId, entityId)) fail(404, 'entity_not_found');
    record.entityId = entityId;
    const secret = this.vault.open(d.secret, ['employee-creation-draft', workspaceId, actorId, id]);
    record.credential = this.vault.seal(secret, [workspaceId, entityId, record.id, record.appId, record.authRevision]);
    this.channels.persistCreation(record, actorId);
    return record.id;
  }
  discard(workspaceId: string, actorId: string, id: string) { const d = this.drafts.get(id); if (d?.workspaceId === workspaceId && d.actorId === actorId) this.drafts.delete(id); }
  committed(workspaceId: string, actorId: string, id: string, connectionId: string) {
    this.discard(workspaceId, actorId, id);
    // Durable connection is already committed. The supervisor also scans records after restart.
    try { this.channels.notifyCommitted(connectionId); }
    catch {
      const current = this.channels.repository.byId(connectionId);
      if (current) this.channels.repository.store.transaction(() => {
        const next = { ...current, status: 'invalid' as const, lastError: 'channel_start_failed', revision: current.revision + 1 };
        this.channels.repository.save(next, current); this.channels.repository.audit(next, actorId, 'channel_start_failed', this.now());
      });
    }
  }
}
