import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { EntityService, DirectoryAccessRule } from '@dentity/application';
import type { ModelProfileService } from './model-profiles.js';
import { activeUserPolicy, type CapabilityConfigService } from './capability-config.js';

/** Explicit read projection. Do not reuse admin DTOs or resolved credentials here. */
export function registerEmployeeConfigurationRoutes(app: FastifyInstance, services: {
  entities: EntityService; profiles: ModelProfileService; capabilities: CapabilityConfigService;
  currentUser(request: FastifyRequest): {id: string};
}) {
  app.get('/api/workspaces/:workspaceId/entities/:entityId/configuration', request => {
    const {workspaceId, entityId} = request.params as {workspaceId: string; entityId: string};
    const entity = services.entities.requireReader(services.currentUser(request).id, workspaceId, entityId);
    const profile = services.profiles.effective(workspaceId, entityId);
    const access = services.capabilities.getWebAccess(workspaceId, entityId);
    const members = services.capabilities.members(workspaceId);
    const names = (ids: string[]) => ids.map(id => ({memberId: id, displayName: members.find(m => m.id === id)?.displayName ?? '已失效成员'}));
    const rules = (items: readonly DirectoryAccessRule[]) => items.map(rule => ({sourceId: rule.sourceId, kind: rule.kind, subjectId: rule.subjectId, includeDescendants: rule.includeDescendants === true, conversationKinds: [...rule.conversationKinds]}));
    const directoryAccess = services.capabilities.getDirectoryAccess(workspaceId, entityId);
    return {
      entity: {enabled:entity.enabled,lifecycleRevision:entity.lifecycleRevision,id: entity.id, workspaceId: entity.workspaceId, name: entity.name, description: entity.description, interactionRuntime: entity.interactionRuntime, executionRuntime: entity.executionRuntime, executionThinkingLevel: entity.executionThinkingLevel},
      model: profile ? {name: profile.name, modelId: profile.modelId, provider: profile.provider, source: profile.source, enabled: profile.enabled} : null,
      webAccess: {allow: names(access.allowMemberIds), deny: names(access.denyMemberIds),...(access.allowWorkspaceMembers?{allowWorkspaceMembers:true}:{})},
      directoryAccess: {allow: rules(directoryAccess.allow), deny: rules(directoryAccess.deny), allowGroupMembers:directoryAccess.allowGroupMembers, channelPolicies:directoryAccess.channelPolicies},
      packages: services.capabilities.list(workspaceId, entityId).map(activeUserPolicy).map(p => ({id: p.id, name: p.name, enabled: p.enabled, mode: p.mode, ...(p.conversationKinds?{conversationKinds:p.conversationKinds}:{}), allow: names(p.allowMemberIds), deny: names(p.denyMemberIds), resourceCount: p.resourceIds.length, directoryAccess: {allow: rules(p.directoryAccess?.allow ?? []), deny: rules(p.directoryAccess?.deny ?? []),channelPolicies:p.directoryAccess?.channelPolicies}})),
    };
  });
}
