import type { ThinkingLevel } from '@dentity/contracts';
import type { EntityRepository, AccountEntity } from '@dentity/application';
import type { Store } from '../../store.js';
const select = 'SELECT id,workspace_id AS workspaceId,name,description,avatar_preset AS avatarPreset,owner_member_id AS ownerMemberId,created_by_member_id AS createdByMemberId,own_web_use AS ownWebUse,web_use_user_id AS webUseUserId,interaction_runtime AS interactionRuntime,execution_thinking_level AS executionThinkingLevel,lifecycle_enabled AS enabled,lifecycle_revision AS lifecycleRevision FROM entities';
type EntityRow = Omit<AccountEntity, 'ownWebUse'|'enabled'> & {ownWebUse: number;enabled:number};
const decode = (row: EntityRow): AccountEntity => ({...row, ownWebUse: Boolean(row.ownWebUse),enabled:Boolean(row.enabled)});
export class SqliteEntityRepository implements EntityRepository {
  constructor(private readonly store: Store) {}
  list(workspaceId: string) { return this.store.all<EntityRow>(`${select} WHERE workspace_id=?`, workspaceId).map(decode); }
  find(workspaceId: string, entityId: string) { const row = this.store.one<EntityRow>(`${select} WHERE id=? AND workspace_id=?`, entityId, workspaceId); return row ? decode(row) : undefined; }
  createOperation(userId: string, workspaceId: string, operationId: string) { return this.store.one<{requestHash: string; entityId: string}>('SELECT request_hash AS requestHash,entity_id AS entityId FROM entity_create_operations WHERE user_id=? AND workspace_id=? AND operation_id=?', userId, workspaceId, operationId); }
  activeOwner(memberId: string, workspaceId: string) { return !!this.store.one("SELECT m.id FROM members m JOIN users u ON u.id=m.user_id WHERE m.id=? AND m.workspace_id=? AND m.status='active' AND u.status='active'", memberId, workspaceId); }
  insert(entity: AccountEntity) { this.store.run('INSERT INTO entities(id,workspace_id,name,owner_member_id,created_by_member_id,own_web_use,web_use_user_id,interaction_runtime,description,execution_thinking_level,avatar_preset) VALUES(?,?,?,?,?,?,?,?,?,?,?)', entity.id, entity.workspaceId, entity.name, entity.ownerMemberId, entity.createdByMemberId, entity.ownWebUse ? 1 : 0, entity.webUseUserId, entity.interactionRuntime, entity.description, entity.executionThinkingLevel,entity.avatarPreset??null); }
  recordCreateOperation(userId: string, workspaceId: string, operationId: string, requestHash: string, entityId: string) { this.store.run('INSERT INTO entity_create_operations(user_id,workspace_id,operation_id,request_hash,entity_id) VALUES(?,?,?,?,?)', userId, workspaceId, operationId, requestHash, entityId); }
  update(workspaceId: string, entityId: string, patch: {avatarPreset?:string|null;name?: string; description?: string; executionThinkingLevel?: ThinkingLevel}) {
    if(patch.avatarPreset!==undefined)this.store.run('UPDATE entities SET avatar_preset=? WHERE id=? AND workspace_id=?',patch.avatarPreset,entityId,workspaceId);
    if (patch.name !== undefined) this.store.run('UPDATE entities SET name=? WHERE id=? AND workspace_id=?', patch.name, entityId, workspaceId);
    if (patch.executionThinkingLevel !== undefined) this.store.run('UPDATE entities SET execution_thinking_level=?,model_settings_revision=model_settings_revision+1 WHERE id=? AND workspace_id=?', patch.executionThinkingLevel, entityId, workspaceId);
    if (patch.description !== undefined) this.store.run('UPDATE entities SET description=? WHERE id=? AND workspace_id=?', patch.description, entityId, workspaceId);
  }
}
