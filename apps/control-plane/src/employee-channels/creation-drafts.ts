import { randomBytes, randomUUID } from 'node:crypto';
import { accountInput, DirectoryError, type DirectoryPort, type DirectoryProvider, type DirectoryAuthorizedScope } from '@dentity/application';
import { DirectoryCredentialVault } from '../directory/secrets.js';
import { DirectoryCursors } from '../adapters/directory/http.js';
import { createDirectoryAdapter } from '../adapters/directory/index.js';
import { EmployeeApplicationTransport } from './provider.js';
import { channelSubject, EmployeeChannelError, type EmployeeChannelService } from './service.js';
import type { EmployeeChannelOptions, EmployeeChannelRecord } from './types.js';
import type { SharedDirectoryCredential } from './directory-credentials.js';
import {validateDirectory,validationOf,type ChannelValidation} from './validation.js';
import type {VerifiedEmployeeApplication} from './types.js';

const fail = (status: number, code: string): never => { throw new EmployeeChannelError(status, code); };
const validId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\x00-\x1f]/.test(v);
const scopeSummary=(scope:DirectoryAuthorizedScope)=>({entireOrganization:scope.entireOrganization,departmentCount:scope.disclosed?.departments===false?null:scope.departmentIds.length,userCount:scope.disclosed?.users===false?null:scope.userIds.length,...(scope.disclosed?{disclosed:scope.disclosed}:{})});
type Draft = { id: string; workspaceId: string; actorId: string; expiresAt: number; record: EmployeeChannelRecord; directory: DirectoryPort; scope: DirectoryAuthorizedScope; secret: ReturnType<DirectoryCredentialVault['seal']>; shared?: SharedDirectoryCredential; existingSharedVersion?: number };
type DirectoryDraft = { id:string;workspaceId:string;actorId:string;expiresAt:number;shared:SharedDirectoryCredential;directory:DirectoryPort;scope:DirectoryAuthorizedScope;validation:ChannelValidation;existingSharedVersion?:number };

/** No employee, connection, credential or organization rows are written by prepare/discovery. */
export class EmployeeChannelCreationDrafts {
  private readonly drafts = new Map<string, Draft>();
  private readonly directoryDrafts = new Map<string,DirectoryDraft>();
  private readonly preparing = new Set<string>();
  private readonly vault: DirectoryCredentialVault;
  private readonly cursors = new DirectoryCursors();
  private readonly now: () => number;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly channels: EmployeeChannelService, private readonly options: EmployeeChannelOptions) {
    this.vault = new DirectoryCredentialVault(options.masterKey); this.now = options.now ?? Date.now;
    this.timer = setInterval(() => this.prune(), 30_000); this.timer.unref();
  }
  close() { clearInterval(this.timer); this.drafts.clear(); this.directoryDrafts.clear(); }
  private prune() { for (const drafts of [this.drafts,this.directoryDrafts]) for (const [id, d] of drafts) if (d.expiresAt <= this.now()) drafts.delete(id); }
  private draft(workspaceId: string, actorId: string, id: string) {
    this.prune(); const d = this.drafts.get(id);
    if (!d || d.workspaceId !== workspaceId || d.actorId !== actorId) return fail(409, 'channel_creation_draft_required');
    if (d.shared && d.existingSharedVersion !== undefined) {
      const current = this.channels.directories.byId(d.shared.id);
      if (!current || current.workspaceId !== workspaceId || current.stateVersion !== d.existingSharedVersion || current.status !== 'verified') fail(409, 'directory_configuration_changed');
    }
    return d;
  }
  private validateSecret(value: unknown) { if (typeof value !== 'string' || !value.trim() || value.length > 8192 || /[\r\n\0]/.test(value)) fail(400, 'invalid_channel_credentials'); }
  async prepare(workspaceId: string, actorId: string, raw: unknown) {
    this.prune(); if (!this.vault.available) fail(503, 'channel_secret_key_unconfigured');
    const key = JSON.stringify([workspaceId, actorId]);
    if (this.preparing.has(key) || this.drafts.size+this.directoryDrafts.size >= 500) fail(429, 'channel_creation_draft_busy');
    const input = accountInput(raw, ['provider', 'appId', 'appSecret', 'directory','operation']);
    if(input['operation']==='directory'){
      if(input['provider']!=='wecom'||input['appId']!==undefined||input['appSecret']!==undefined)fail(400,'invalid_directory_credentials');
      this.preparing.add(key);
      try{return await this.prepareDirectory(workspaceId,actorId,input['directory']);}
      catch(error){if(error instanceof EmployeeChannelError)throw error;throw new EmployeeChannelError(400,validationOf(error)?'channel_validation_failed':error instanceof DirectoryError?error.code:'channel_connection_unavailable',validationOf(error));}
      finally{this.preparing.delete(key);}
    }
    if(input['operation']!==undefined)fail(400,'invalid_channel_credentials');
    if (!['feishu', 'dingtalk', 'wecom'].includes(input['provider'] as string) || !validId(input['appId'])) fail(400, 'invalid_channel_credentials');
    this.validateSecret(input['appSecret']);
    const provider = input['provider'] as DirectoryProvider, appId = input['appId'] as string, appSecret = input['appSecret'] as string;
    const id = randomBytes(32).toString('base64url');
    let shared: SharedDirectoryCredential | undefined, existingSharedVersion: number | undefined;
    this.preparing.add(key);
    try {
      let directory: DirectoryPort, verified:VerifiedEmployeeApplication;
      if (provider === 'wecom') {
        const dir = accountInput(input['directory'], ['draftId','credentialId', 'label', 'corpId', 'agentId', 'appSecret', 'confirmSameCorp']);
        if (dir['confirmSameCorp'] !== true) fail(400, 'same_corp_confirmation_required');
        if(typeof dir['draftId']==='string'){
          if(Object.keys(dir).some(k=>!['draftId','confirmSameCorp'].includes(k)))fail(400,'invalid_directory_credentials');
          const d=this.directoryDrafts.get(dir['draftId']);
          if(!d||d.workspaceId!==workspaceId||d.actorId!==actorId||d.expiresAt<=this.now())fail(409,'channel_creation_draft_required');
          shared=d!.shared;existingSharedVersion=d!.existingSharedVersion;
          if(existingSharedVersion!==undefined){const current=this.channels.directories.byId(shared.id);if(!current||current.workspaceId!==workspaceId||current.status!=='verified'||current.stateVersion!==existingSharedVersion)fail(409,'directory_configuration_changed');}
        }else if (typeof dir['credentialId'] === 'string') {
          if (Object.keys(dir).some(k => !['credentialId', 'confirmSameCorp'].includes(k))) fail(400, 'invalid_directory_credentials');
          shared = this.channels.directories.byId(dir['credentialId']);
          if (!shared || shared.workspaceId !== workspaceId || shared.status !== 'verified') fail(404, 'directory_credential_not_found');
          existingSharedVersion = shared!.stateVersion;
        } else {
          if (!validId(dir['label']) || !validId(dir['corpId']) || !validId(dir['agentId']) || !/^\d+$/.test(dir['agentId'] as string)) fail(400, 'invalid_directory_credentials');
          this.validateSecret(dir['appSecret']);
          shared = this.channels.directories.create(workspaceId, actorId, dir as unknown as { label: string; corpId: string; agentId: string; appSecret: string });
        }
        directory = this.channels.directories.port(shared!);
        const result=await validateDirectory(directory,'wecom',undefined,this.now,{appId:shared!.agentId,tenantId:shared!.corpId,tenantIdNamespace:'corp_id'});
        const scope=result.scope;
        if (existingSharedVersion !== undefined && shared!.scopeRevision !== scope.revision) fail(409, 'directory_scope_changed');
        shared = { ...shared!, status: 'verified', scopeRevision: scope.revision, lastVerifiedAt: this.now(), lastError: null };
        verified = { identity: { appId, tenantId: shared.corpId, tenantIdNamespace: 'corp_id' }, botId: appId, eventTenantId: shared.corpId, directoryStatus: 'available',validation:result.validation,authorizedScope:scope };
      } else {
        if (input['directory'] !== undefined) fail(400, 'invalid_directory_credentials');
        directory = this.options.adapterFactory?.(provider, { appId, appSecret }) ?? createDirectoryAdapter(provider, { appId, appSecret, ...(this.options.fetch ? { fetch: this.options.fetch } : {}), ...(this.options.now ? { now: this.options.now } : {}) });
        verified = this.options.verifyApplication ? await this.options.verifyApplication(provider, appId, { appSecret }) : await new EmployeeApplicationTransport(provider, appId, { appSecret }, this.options).verify(directory);
        if (verified.identity.appId !== appId || !validId(verified.identity.tenantId) || verified.directoryStatus !== 'available') fail(400, 'channel_directory_unavailable');
      }
      if(verified.validation&&!verified.validation.canContinue)throw new EmployeeChannelError(400,'channel_validation_failed',verified.validation);
      const {authorizedScope,...verifiedApplication}=verified;
      const scope = authorizedScope??await directory.getAuthorizedScope();
      const record: EmployeeChannelRecord = { id: randomUUID(), sourceId: randomUUID(), workspaceId, entityId: '', provider, appId, ...verifiedApplication,
        revision: 1, authRevision: 1, stateVersion: 0, enabled: true, status: provider !== 'wecom' && verified.botId && verified.eventTenantId ? 'verified' : 'pending_verification',
        identityEvidence: provider === 'wecom' ? 'admin_asserted' : verified.botId && verified.eventTenantId ? 'provider_api' : 'app_credentials_only', inboundVerified: false,
        ...(provider==='feishu'?{context:{historyEnabled:false,groupListenEnabled:true,listenGeneration:0,meetingRefs:[]}}:{}),lastError: null, credential: { ciphertext: '', nonce: '', tag: '' }, createdBy: actorId, updatedBy: actorId };
      if (shared) record.directoryBinding = { credentialId: shared.id, corpId: shared.corpId, agentId: shared.agentId, sourceRevision: 1, credentialRevision: shared.credentialRevision, scopeRevision: shared.scopeRevision, status: 'confirmed', assertion: { evidence: 'admin_asserted', actorId, confirmedAt: this.now(), botId: appId, corpId: shared.corpId, credentialRevision: shared.credentialRevision } };
      const d: Draft = { id, workspaceId, actorId, expiresAt: this.now() + 10 * 60_000, record, directory, scope, secret: this.vault.seal(JSON.stringify({ appSecret }), ['employee-creation-draft', workspaceId, actorId, id]), ...(shared ? { shared } : {}), ...(existingSharedVersion === undefined ? {} : { existingSharedVersion }) };
      this.drafts.set(id, d);
      return { draftId: id, expiresAt: d.expiresAt, source: this.channels.dto(record), scope: scopeSummary(scope) };
    } catch (error) { if(error instanceof EmployeeChannelError)throw error;if (error instanceof DirectoryError) throw new EmployeeChannelError(400,validationOf(error)?'channel_validation_failed':error.code,validationOf(error)); throw new EmployeeChannelError(502, 'channel_connection_unavailable'); }
    finally { this.preparing.delete(key); }
  }
  private async prepareDirectory(workspaceId:string,actorId:string,raw:unknown){
    const input=accountInput(raw,['credentialId','label','corpId','agentId','appSecret']);
    let shared:SharedDirectoryCredential,existingSharedVersion:number|undefined;
    if(typeof input['credentialId']==='string'){
      if(Object.keys(input).some(k=>k!=='credentialId'))fail(400,'invalid_directory_credentials');
      const existing=this.channels.directories.byId(input['credentialId']);
      if(!existing||existing.workspaceId!==workspaceId||existing.status!=='verified')fail(404,'directory_credential_not_found');
      shared=existing!;existingSharedVersion=shared.stateVersion;
    }else{
      if(!validId(input['label'])||!validId(input['corpId'])||!validId(input['agentId'])||!/^\d+$/.test(input['agentId'] as string))fail(400,'invalid_directory_credentials');
      this.validateSecret(input['appSecret']);
      shared=this.channels.directories.create(workspaceId,actorId,input as unknown as {label:string;corpId:string;agentId:string;appSecret:string});
    }
    const directory=this.channels.directories.port(shared);
    const result=await validateDirectory(directory,'wecom',undefined,this.now,{appId:shared.agentId,tenantId:shared.corpId,tenantIdNamespace:'corp_id'});
    if(existingSharedVersion!==undefined){const current=this.channels.directories.byId(shared.id);if(!current||current.stateVersion!==existingSharedVersion||current.status!=='verified')fail(409,'directory_configuration_changed');if(current!.scopeRevision!==result.scope.revision)fail(409,'directory_scope_changed');}
    const id=randomBytes(32).toString('base64url'),expiresAt=this.now()+10*60_000;
    this.directoryDrafts.set(id,{id,workspaceId,actorId,expiresAt,shared,directory,scope:result.scope,validation:result.validation,...(existingSharedVersion===undefined?{}:{existingSharedVersion})});
    return {draftId:id,expiresAt,validation:result.validation,scope:scopeSummary(result.scope)};
  }
  async discovery(workspaceId: string, actorId: string, id: string, query: { kind: string; parentId?: string; cursor?: string }) {
    const d = this.draft(workspaceId, actorId, id), r = d.record;
    if (!['departments', 'users'].includes(query.kind) || query.parentId !== undefined && !validId(query.parentId)) fail(400, 'invalid_directory_query');
    try {
      const scope = await d.directory.getAuthorizedScope();
      if (scope.revision !== d.scope.revision) { this.drafts.delete(id); fail(409, 'directory_scope_changed'); }
      let values: unknown[], exhausted: boolean, nextCursor: string | undefined;
      if (!query.parentId) {
        const cursorScope = JSON.stringify([id, query.kind, scope.revision]);
        const offset = query.cursor ? Number(this.cursors.decode(cursorScope, query.cursor)) : 0;
        if (!Number.isSafeInteger(offset) || offset < 0) fail(400, 'invalid_directory_cursor');
        const ids = query.kind === 'departments' ? scope.entireOrganization ? [r.provider === 'feishu' ? '0' : '1'] : scope.departmentIds : scope.userIds;
        if (ids.length > 1000) fail(400, 'directory_scope_requires_department_query');
        values = query.kind === 'departments' ? await Promise.all((ids as string[]).slice(offset, offset + 50).map(v => d.directory.getDepartment(v))) : await Promise.all((ids as typeof scope.userIds).slice(offset, offset + 50).map(v => d.directory.getUser(v)));
        exhausted = offset + 50 >= ids.length; if (!exhausted) nextCursor = this.cursors.encode(cursorScope, String(offset + 50));
      } else {
        const page = query.kind === 'departments' ? await d.directory.listChildDepartments(query.parentId, query.cursor) : await d.directory.listDepartmentMembers(query.parentId, query.cursor);
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
    if (d.shared && d.existingSharedVersion === undefined) {
      const shared = structuredClone(d.shared);
      try { if (!this.channels.directories.save(shared)) fail(409, 'directory_configuration_changed'); }
      catch { fail(409, 'directory_credential_conflict'); }
    }
    record.entityId = entityId;
    const secret = this.vault.open(d.secret, ['employee-creation-draft', workspaceId, actorId, id]);
    record.credential = this.vault.seal(secret, [workspaceId, entityId, record.id, record.appId, record.authRevision]);
    this.channels.persistCreation(record, actorId);
    return record.id;
  }
  discard(workspaceId: string, actorId: string, id: string) { const d = this.drafts.get(id); if (d?.workspaceId === workspaceId && d.actorId === actorId) this.drafts.delete(id);const directory=this.directoryDrafts.get(id);if(directory?.workspaceId===workspaceId&&directory.actorId===actorId)this.directoryDrafts.delete(id); }
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
