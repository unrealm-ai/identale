import { isThinkingLevel,isEmployeeAvatarPreset } from '@dentity/contracts';
import type { AccountRepository, EntityRepository, AccountSecurity, AccountEntity } from './ports.js';
import { WorkspaceService } from './workspace-service.js';
import { accountFail as fail, accountInput as input, accountString as str } from './validation.js';
const dto = ({ownerMemberId: _legacyOwner, ...entity}: AccountEntity) => ({...entity, executionRuntime: 'local-pi', readiness: 'not_configured'});
export interface EntityAccess { authorizeEntity(scope: {workspaceId: string; entityId: string; userId: string}): unknown }
export class EntityService {
  constructor(private readonly repository: EntityRepository, private readonly accounts: AccountRepository, private readonly workspaces: WorkspaceService, private readonly security: AccountSecurity, private readonly now: () => number) {}
  /** Trusted internal lookup; callers must authorize the request scope first. */
  getRuntimeDefinition(workspaceId: string, entityId: string): {name: string; description: string; interactionRuntime: string} | undefined {
    const entity = this.repository.find(workspaceId, entityId);
    return entity ? {name: entity.name, description: entity.description, interactionRuntime: entity.interactionRuntime} : undefined;
  }
  list(userId: string, workspaceId: string) {
    const selected = this.workspaces.get(userId, workspaceId);
    return this.repository.list(selected.id).map(dto);
  }
  requireReader(userId: string, workspaceId: string, entityId: string) {
    this.workspaces.get(userId, workspaceId);
    const entity = this.repository.find(workspaceId, entityId);
    if (!entity) return fail(404, 'entity_not_found');
    return dto(entity);
  }

  requireManager(userId: string, workspaceId: string, entityId: string) {
    this.workspaces.get(userId, workspaceId); const entity = this.repository.find(workspaceId, entityId);
    if (!entity) return fail(404, 'entity_not_found');
  }
  create(userId: string, workspaceId: string, value: unknown) {
    const selected = this.workspaces.get(userId, workspaceId), body = input(value, ['name', 'description','avatarPreset', 'ownWebUse', 'interactionRuntime', 'executionThinkingLevel', 'operationId']);
    if(body['avatarPreset']!==undefined&&body['avatarPreset']!==null&&!isEmployeeAvatarPreset(body['avatarPreset']))return fail(400,'invalid_avatar_preset');
    const name = str(body['name']), owner = selected.memberId; // Legacy storage only; never grants management rights.
    if (typeof body['ownWebUse'] !== 'boolean') return fail(400, 'explicit_web_use_required');
    const ownWebUse = body['ownWebUse'];
    const description = body['description'] === undefined ? '' : str(body['description'], 0, 4000);
    const runtime = body['interactionRuntime'] ?? 'builtin-interaction';
    if (runtime !== 'builtin-interaction' && runtime !== 'local-pi') return fail(400, 'invalid_runtime');
    const executionThinkingLevel = body['executionThinkingLevel'] ?? 'medium';
    if (body['executionThinkingLevel'] === null || !isThinkingLevel(executionThinkingLevel)) return fail(400, 'invalid_execution_thinking_level');
    const operationId = body['operationId'] === undefined ? undefined : str(body['operationId'], 1, 128);
    const requestHash = this.security.digest(JSON.stringify({...(body['avatarPreset']===undefined?{}:{avatarPreset:body['avatarPreset']}),name, description, ownerMemberId: owner, ownWebUse, interactionRuntime: runtime, ...(executionThinkingLevel === 'medium' ? {} : {executionThinkingLevel})}));
    return this.accounts.transaction(() => {
      if (operationId) {
        const previous = this.repository.createOperation(userId, selected.id, operationId);
        if (previous) {
          if (previous.requestHash !== requestHash) return fail(409, 'idempotency_conflict');
          return dto(this.repository.find(selected.id, previous.entityId)!);
        }
      }
      const entity: AccountEntity = {...(body['avatarPreset']===undefined?{}:{avatarPreset:body['avatarPreset'] as string|null}),id: this.security.id(), workspaceId: selected.id, name, description, ownerMemberId: owner, createdByMemberId: selected.memberId, ownWebUse, webUseUserId: userId, interactionRuntime: runtime, executionThinkingLevel};
      this.repository.insert(entity);
      if (operationId) this.repository.recordCreateOperation(userId, selected.id, operationId, requestHash, entity.id);
      this.accounts.audit(this.now(), 'entity.created', userId, selected.id);
      return dto(this.repository.find(selected.id, entity.id)!);
    });
  }
  patch(userId: string, workspaceId: string, entityId: string, value: unknown) {
    this.requireManager(userId, workspaceId, entityId);
    const body = input(value, ['name', 'description','avatarPreset', 'executionThinkingLevel']);
    if (body['name'] === undefined && body['description'] === undefined && body['avatarPreset']===undefined && body['executionThinkingLevel'] === undefined) return fail(400, 'invalid_input');
    if (body['executionThinkingLevel'] !== undefined && !isThinkingLevel(body['executionThinkingLevel'])) return fail(400, 'invalid_execution_thinking_level');
    if(body['avatarPreset']!==undefined&&body['avatarPreset']!==null&&!isEmployeeAvatarPreset(body['avatarPreset']))return fail(400,'invalid_avatar_preset');
    const patch = {...(body['avatarPreset']===undefined?{}:{avatarPreset:body['avatarPreset'] as string|null}),...(body['name'] === undefined ? {} : {name: str(body['name'])}), ...(body['description'] === undefined ? {} : {description: str(body['description'], 0, 4000)}), ...(body['executionThinkingLevel'] === undefined ? {} : {executionThinkingLevel: body['executionThinkingLevel']})};
    return this.accounts.transaction(() => {
      this.repository.update(workspaceId, entityId, patch);
      this.accounts.audit(this.now(), 'entity.updated', userId, workspaceId);
      return dto(this.repository.find(workspaceId, entityId)!);
    });
  }
  setDescription(userId: string, workspaceId: string, entityId: string, value: unknown) {
    this.requireManager(userId, workspaceId, entityId);
    const body = input(value, ['description']), description = str(body['description'], 0, 4000);
    this.repository.update(workspaceId, entityId, {description});
    this.accounts.audit(this.now(), 'entity.description_updated', userId, workspaceId);
    return dto(this.repository.find(workspaceId, entityId)!);
  }
}
