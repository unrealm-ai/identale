import type {TriggerService} from './triggers/service.js';
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { accountInput, AccountError, type EntityService, type WorkspaceService } from '@dentity/application';
import type { CapabilityConfigService } from './capability-config.js';
import type { ModelProfileService } from './model-profiles.js';
import type { Store } from './store.js';
import type { EmployeeChannelService } from './employee-channels/service.js';
import type { EmployeeChannelCreationDrafts } from './employee-channels/creation-drafts.js';

const fail = (status: number, code: string): never => { throw new AccountError(status, code); };
// Stable ordering makes equivalent JSON bodies replayable after a transport retry.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}

/** Wizard transport: all network probing uses test-connection before this synchronous transaction. */
export function registerEmployeeCreationRoutes(app: FastifyInstance, services: {
  store: Store; entities: EntityService; workspaces: WorkspaceService; profiles: ModelProfileService; capabilities: CapabilityConfigService;
  employeeChannels: EmployeeChannelService; channelDrafts: EmployeeChannelCreationDrafts;
  trigger?:()=>TriggerService|undefined;
  auth(request: FastifyRequest): { id: string };
}) {
  const { store, entities, workspaces, profiles, capabilities, channelDrafts } = services;
  store.db.exec(`CREATE TABLE IF NOT EXISTS employee_creation_operations (
    user_id TEXT NOT NULL REFERENCES users(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    operation_id TEXT NOT NULL, request_hash TEXT NOT NULL, entity_id TEXT NOT NULL REFERENCES entities(id),
    PRIMARY KEY(user_id, workspace_id, operation_id))`);
  function manager(userId: string, workspaceId: string) {
    workspaces.get(userId,workspaceId);
  }
  app.get('/api/workspaces/:workspaceId/employee-creation-options', request => {
    const { workspaceId } = request.params as { workspaceId: string };
    manager(services.auth(request).id, workspaceId);
    return { members: capabilities.members(workspaceId), resources: capabilities.resources(workspaceId) };
  });
  const draftBase = '/api/workspaces/:workspaceId/employee-channel-drafts';
  app.post(draftBase, {config: {rateLimit: {max: 6, timeWindow: '1 minute'}}}, async request => {
    const { workspaceId } = request.params as { workspaceId: string }, userId = services.auth(request).id;
    manager(userId, workspaceId);
    const result = await channelDrafts.prepare(workspaceId, userId, request.body);
    try { manager(services.auth(request).id, workspaceId); } catch (error) { channelDrafts.discard(workspaceId, userId, result.draftId); throw error; }
    return result;
  });
  app.get(`${draftBase}/:draftId/directory`, async request => {
    const { workspaceId, draftId } = request.params as { workspaceId: string; draftId: string }, userId = services.auth(request).id;
    manager(userId, workspaceId);
    const query = accountInput(request.query, ['kind', 'parentId', 'cursor']) as unknown as { kind: string; parentId?: string; cursor?: string };
    const result = await channelDrafts.discovery(workspaceId, userId, draftId, query);
    manager(services.auth(request).id, workspaceId); return result;
  });
  app.delete(`${draftBase}/:draftId`, request => {
    const { workspaceId, draftId } = request.params as { workspaceId: string; draftId: string }, userId = services.auth(request).id;
    manager(userId, workspaceId); channelDrafts.discard(workspaceId, userId, draftId); return { ok: true };
  });
  app.post('/api/workspaces/:workspaceId/employee-creations', request => {
    const { workspaceId } = request.params as { workspaceId: string }, userId = services.auth(request).id;
    manager(userId, workspaceId);
    const body = accountInput(request.body, ['operationId', 'name', 'description','avatarPreset', 'ownWebUse', 'interactionRuntime', 'executionThinkingLevel', 'model', 'packages', 'webAccess', 'channelDraftId', 'directoryAccess','triggers','triggerHistoryPolicy']);
    if (body['channelDraftId'] !== undefined && (typeof body['channelDraftId'] !== 'string' || !body['channelDraftId'])) fail(400, 'invalid_channel_credentials');
    if (typeof body['operationId'] !== 'string' || !body['operationId'].trim() || body['operationId'].length > 128) fail(400, 'invalid_input');
    const operationId = body['operationId'] as string;
    const model = body['model'] === undefined || body['model'] === null ? null : accountInput(body['model'], ['kind', 'profileId', 'configuration']);
    if (model) {
      if (model['kind'] === 'existing') {
        if (typeof model['profileId'] !== 'string' || !model['profileId'] || model['configuration'] !== undefined) fail(400, 'invalid_model_selection');
      } else if (model['kind'] === 'new') { fail(400,'employee_resource_creation_forbidden');
      } else fail(400, 'invalid_model_selection');
    }
    if (body['packages'] !== undefined && (!Array.isArray(body['packages']) || body['packages'].length > 50)) fail(400, 'invalid_capability_configuration');
    const packages = (body['packages'] ?? []) as unknown[];
    const identity = { operationId,...(body['avatarPreset']===undefined?{}:{avatarPreset:body['avatarPreset']}), name: body['name'], description: body['description'], ownWebUse: body['ownWebUse'], interactionRuntime: body['interactionRuntime'] ?? 'builtin-interaction', ...(body['executionThinkingLevel'] === undefined ? {} : {executionThinkingLevel: body['executionThinkingLevel']}) };
    const drafts=(body['triggers']??[]) as Record<string,unknown>[];if(!Array.isArray(drafts)||drafts.length>50||drafts.some(d=>!d||typeof d!=='object'||typeof d['draftId']!=='string'||!/^[-a-zA-Z0-9_]{1,160}$/.test(d['draftId'])))fail(400,'invalid_trigger_configuration');if(new Set(drafts.map(d=>d['draftId'])).size!==drafts.length)fail(400,'invalid_trigger_configuration');const serialized=JSON.stringify(canonical(body)),hash=drafts.some(d=>d['credential'])?profiles.creationFingerprint(serialized):createHash('sha256').update(serialized).digest('hex');
    const previous = store.one<{ request_hash: string; entity_id: string }>('SELECT request_hash, entity_id FROM employee_creation_operations WHERE user_id=? AND workspace_id=? AND operation_id=?', userId, workspaceId, operationId);
    if (previous) {
      if (previous.request_hash !== hash) fail(409, 'idempotency_conflict');
      return { entity: entities.requireReader(userId, workspaceId, previous.entity_id) };
    }
    let connectionId: string | undefined;
    const commit = () => {
      manager(userId, workspaceId);
      // Another connection may have committed while this request waited for BEGIN IMMEDIATE.
      const replay = store.one<{ request_hash: string; entity_id: string }>('SELECT request_hash, entity_id FROM employee_creation_operations WHERE user_id=? AND workspace_id=? AND operation_id=?', userId, workspaceId, operationId);
      if (replay) {
        if (replay.request_hash !== hash) fail(409, 'idempotency_conflict');
        return { entity: entities.requireReader(userId, workspaceId, replay.entity_id) };
      }
      // Do not attach a wizard draft to an employee created via another transport using the same key.
      if (store.one('SELECT entity_id FROM entity_create_operations WHERE user_id=? AND workspace_id=? AND operation_id=?', userId, workspaceId, operationId)) fail(409, 'idempotency_conflict');
      const entity = entities.create(userId, workspaceId, identity);
      if (typeof body['channelDraftId'] === 'string') connectionId = channelDrafts.persist(workspaceId, userId, body['channelDraftId'], entity.id);
      if (model?.['kind'] === 'existing') profiles.select(workspaceId, entity.id, model['profileId'] as string);
      if (body['webAccess'] !== undefined) capabilities.saveWebAccess(workspaceId, entity.id, body['webAccess']);
      if (body['directoryAccess'] !== undefined) {
        const access = capabilities.saveDirectoryAccess(workspaceId, entity.id, body['directoryAccess']);
        // Explicit creation-time allow rules must not be ignored by the new all-user default.
        const requested = body['directoryAccess'] as Record<string, unknown>;
        if (requested['channelPolicies'] === undefined && Array.isArray(requested['allow']) && requested['allow'].length) {
          for (const policy of access.channelPolicies ?? []) if (policy.allow.length) capabilities.patchDirectoryAccess(workspaceId, entity.id, {
            sourceId: policy.sourceId, mode: 'allowlist', allow: policy.allow, deny: policy.deny,
            allowGroupMembers: policy.allowGroupMembers, expectedRevision: policy.revision,
          });
        }
      }
      const triggerMap=new Map<string,string>();const triggerService=services.trigger?.();if((drafts.length||body['triggerHistoryPolicy']!==undefined)&&!triggerService)fail(503,'trigger_unavailable');if(triggerService){if(body['triggerHistoryPolicy']!==undefined)triggerService.setPolicy(workspaceId,entity.id,{policy:body['triggerHistoryPolicy'],expectedVersion:1});for(const d of drafts){const{draftId,...input}=d;const t=triggerService.save(workspaceId,entity.id,input);triggerMap.set(String(draftId),t.id);}}
      for (const draft of packages){const p=draft as Record<string,unknown>,usage=p['triggerUsageScope'] as {mode:string;allowTriggerIds:string[];denyTriggerIds:string[]}|undefined;capabilities.save(workspaceId,entity.id,usage?{...p,triggerUsageScope:{...usage,allowTriggerIds:Array.isArray(usage.allowTriggerIds)?usage.allowTriggerIds.map(id=>triggerMap.get(id)??id):usage.allowTriggerIds,denyTriggerIds:Array.isArray(usage.denyTriggerIds)?usage.denyTriggerIds.map(id=>triggerMap.get(id)??id):usage.denyTriggerIds}}:draft);}
      store.run('INSERT INTO employee_creation_operations(user_id,workspace_id,operation_id,request_hash,entity_id) VALUES(?,?,?,?,?)', userId, workspaceId, operationId, hash, entity.id);
      return { entity };
    };
    const result = store.transaction(commit);
    if (connectionId && typeof body['channelDraftId'] === 'string') channelDrafts.committed(workspaceId, userId, body['channelDraftId'], connectionId);
    return result;
  });
}
