import type { ChannelPrincipalRef, ChannelRef } from './runtime.js';

/** Supplied by a trusted caller after authentication; not model input or proof of identity. */
export type AuthorizationFact<T> =
  | { readonly status: 'known'; readonly value: T }
  | { readonly status: 'unknown' | 'unsupported' };

export interface AccessRequest {
  readonly workspaceId: string;
  readonly principal: AuthorizationFact<ChannelPrincipalRef>;
  readonly channel: ChannelRef;
  readonly conversation: { readonly id: string; readonly kind: 'private' | 'group' | 'meeting' };
  /** Facts apply to this principal in this workspace; empty known lists mean no membership. */
  readonly workspaceMemberIds: AuthorizationFact<readonly string[]>;
  readonly verifiedGroupIds: AuthorizationFact<readonly string[]>;
  readonly identifiedInWorkspace: AuthorizationFact<boolean>;
}

export type RequesterSelector =
  | { readonly kind: 'principals'; readonly values: readonly ChannelPrincipalRef[] }
  | { readonly kind: 'workspace_members'; readonly ids: readonly string[] }
  | { readonly kind: 'verified_groups'; readonly ids: readonly string[] }
  | { readonly kind: 'identified_workspace_users' };

/** Required channel tuple prevents matching a similarly named conversation in another install. */
export interface ChannelSelector {
  readonly channel: ChannelRef;
  readonly kinds: readonly ('private' | 'group' | 'meeting')[];
  /** Omitted means all conversations in the explicit channel/kind; [] matches none. */
  readonly conversationIds?: readonly string[];
}
export interface AccessRule {
  readonly requester: RequesterSelector;
  readonly channel: ChannelSelector;
}
export interface EntityAccessPolicy {
  readonly workspaceId: string;
  readonly enabled: boolean;
  readonly allow: readonly AccessRule[];
  readonly deny: readonly AccessRule[];
}
export interface PackageAccessPolicy {
  readonly enabled: boolean;
  readonly mode: 'inherit' | 'restrict';
  readonly allow: readonly AccessRule[];
  readonly deny: readonly AccessRule[];
}
export type AccessDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: 'disabled' | 'invalid_request' | 'invalid_policy' | 'unknown_fact' | 'explicit_deny' | 'no_allow' };

type Match = boolean | 'unknown_fact' | 'invalid_policy';
const onlyKeys = (value: object, allowed: readonly string[]): boolean => Object.keys(value).every(key => allowed.includes(key));
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const strings = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every(nonempty);
function validChannel(value: ChannelRef): boolean {
  return !!value && nonempty(value.channelType) && nonempty(value.tenantId) && nonempty(value.installationId);
}
function sameChannel(a: ChannelRef, b: ChannelRef): boolean {
  return a.channelType === b.channelType && a.tenantId === b.tenantId && a.installationId === b.installationId;
}
function validPrincipal(value: ChannelPrincipalRef): boolean {
  return !!value && nonempty(value.channelType) && nonempty(value.tenantId) && nonempty(value.identityNamespace) && nonempty(value.externalUserId);
}
function samePrincipal(a: ChannelPrincipalRef, b: ChannelPrincipalRef): boolean {
  return a.channelType === b.channelType && a.tenantId === b.tenantId && a.identityNamespace === b.identityNamespace && a.externalUserId === b.externalUserId;
}
function matchIds(ids: readonly string[], fact: AuthorizationFact<readonly string[]>): Match {
  if (!strings(ids)) return 'invalid_policy';
  if (ids.length === 0) return false;
  if (!fact || fact.status !== 'known' || !strings(fact.value)) return 'unknown_fact';
  return ids.some(id => fact.value.includes(id));
}
function matchRequester(selector: RequesterSelector, request: AccessRequest): Match {
  if (!selector) return 'invalid_policy';
  const fields = selector.kind === 'principals' ? ['kind', 'values'] : selector.kind === 'identified_workspace_users' ? ['kind'] : ['kind', 'ids'];
  if (!onlyKeys(selector, fields)) return 'invalid_policy';
  switch (selector.kind) {
    case 'principals':
      if (!Array.isArray(selector.values) || !selector.values.every(validPrincipal)) return 'invalid_policy';
      if (request.principal.status !== 'known') return 'unknown_fact';
      return selector.values.some(value => request.principal.status === 'known' && samePrincipal(value, request.principal.value));
    case 'workspace_members': return matchIds(selector.ids, request.workspaceMemberIds);
    case 'verified_groups': return matchIds(selector.ids, request.verifiedGroupIds);
    case 'identified_workspace_users':
      return request.identifiedInWorkspace?.status === 'known' && typeof request.identifiedInWorkspace.value === 'boolean'
        ? request.identifiedInWorkspace.value : 'unknown_fact';
    default: return 'invalid_policy';
  }
}
function matchRule(rule: AccessRule, request: AccessRequest): Match {
  if (!rule || !rule.channel || !onlyKeys(rule, ['requester', 'channel'])) return 'invalid_policy';
  const selector = rule.channel;
  if (!onlyKeys(selector, ['channel', 'kinds', 'conversationIds']) || !validChannel(selector.channel) || !Array.isArray(selector.kinds)
    || !selector.kinds.every(kind => ['private', 'group', 'meeting'].includes(kind))
    || (selector.conversationIds !== undefined && !strings(selector.conversationIds))) return 'invalid_policy';
  const requester = matchRequester(rule.requester, request);
  if (requester === 'invalid_policy') return requester;
  const channelMatches = sameChannel(selector.channel, request.channel)
    && selector.kinds.includes(request.conversation.kind)
    && (selector.conversationIds === undefined || selector.conversationIds.includes(request.conversation.id));
  // Unknown facts on a provably irrelevant channel cannot affect this decision.
  return channelMatches ? requester : false;
}
function evaluateRules(allow: readonly AccessRule[], deny: readonly AccessRule[], request: AccessRequest, inherit: boolean): AccessDecision {
  if (!Array.isArray(allow) || !Array.isArray(deny)) return { allowed: false, reason: 'invalid_policy' };
  const denials = deny.map(rule => matchRule(rule, request));
  if (denials.includes(true)) return { allowed: false, reason: 'explicit_deny' };
  const allowances = allow.map(rule => matchRule(rule, request));
  const matches = [...denials, ...allowances];
  if (matches.includes('invalid_policy')) return { allowed: false, reason: 'invalid_policy' };
  if (matches.includes('unknown_fact')) return { allowed: false, reason: 'unknown_fact' };
  return inherit || allowances.includes(true) ? { allowed: true } : { allowed: false, reason: 'no_allow' };
}

/** Human requests only. Configured events require a separate explicit trigger-binding evaluator. */
export function evaluateEntityAccess(policy: EntityAccessPolicy, request: AccessRequest): AccessDecision {
  if (!policy || policy.enabled !== true) return { allowed: false, reason: 'disabled' };
  if (!onlyKeys(policy, ['workspaceId', 'enabled', 'allow', 'deny'])) return { allowed: false, reason: 'invalid_policy' };
  if (!request || !nonempty(request.workspaceId) || request.workspaceId !== policy.workspaceId
    || !request.principal || request.principal.status !== 'known' || !validPrincipal(request.principal.value)
    || !validChannel(request.channel) || (request.principal.value.channelType !== request.channel.channelType || request.principal.value.tenantId !== request.channel.tenantId)
    || !request.conversation || !nonempty(request.conversation.id)
    || !['private', 'group', 'meeting'].includes(request.conversation.kind)) return { allowed: false, reason: 'invalid_request' };
  return evaluateRules(policy.allow, policy.deny, request, false);
}

/** Re-evaluates entity policy first, so no package can grant access outside its boundary. */
export function evaluatePackageAccess(entity: EntityAccessPolicy, policy: PackageAccessPolicy, request: AccessRequest): AccessDecision {
  const entityDecision = evaluateEntityAccess(entity, request);
  if (!entityDecision.allowed) return entityDecision;
  if (!policy || policy.enabled !== true) return { allowed: false, reason: 'disabled' };
  if (!onlyKeys(policy, ['enabled', 'mode', 'allow', 'deny']) || (policy.mode !== 'inherit' && policy.mode !== 'restrict')) return { allowed: false, reason: 'invalid_policy' };
  return evaluateRules(policy.allow, policy.deny, request, policy.mode === 'inherit');
}

export const PLATFORM_TASK_TOOLS = ['task_create', 'task_create_todo', 'task_list', 'task_start', 'task_cancel_todo', 'task_query', 'task_query_results', 'task_supplement', 'task_cancel'] as const;
export type RoleResource =
  | { readonly kind: 'platform_task'; readonly id: string }
  | { readonly kind: 'knowledge_read'; readonly id: string; readonly packageId: string; readonly collectionId: string }
  | { readonly kind: 'skill' | 'cli'; readonly id: string; readonly packageId: string }
  | { readonly kind: 'mcp_tool'; readonly id: string; readonly packageId: string; readonly connectionId: string; readonly toolName: string };
export interface RoleResourceProjection {
  readonly valid: boolean;
  readonly resources: readonly RoleResource[];
  readonly rejected: readonly { readonly resource: RoleResource; readonly reason: 'unsupported_resource' | 'role_forbidden' | 'not_authorized' }[];
}
function resourceKey(resource: RoleResource): string | undefined {
  if (!resource || !nonempty(resource.id)) return undefined;
  switch (resource.kind) {
    case 'platform_task': return (PLATFORM_TASK_TOOLS as readonly string[]).includes(resource.id) ? JSON.stringify([resource.kind, resource.id]) : undefined;
    case 'knowledge_read': return nonempty(resource.packageId) && nonempty(resource.collectionId) ? JSON.stringify([resource.kind, resource.id, resource.packageId, resource.collectionId]) : undefined;
    case 'skill': case 'cli': return nonempty(resource.packageId) ? JSON.stringify([resource.kind, resource.id, resource.packageId]) : undefined;
    case 'mcp_tool': return nonempty(resource.packageId) && nonempty(resource.connectionId) && nonempty(resource.toolName) && resource.toolName !== '*'
      ? JSON.stringify([resource.kind, resource.id, resource.packageId, resource.connectionId, resource.toolName]) : undefined;
    default: return undefined;
  }
}
/** Authorized descriptors must come from current entity/package/resource ACL checks by trusted code.
 * This projection is not runtime isolation, identity verification, or a reusable permission grant.
 * A false valid flag means configuration validation failed; do not silently load rejected resources.
 */
export function projectRoleResources(role: 'interaction' | 'execution', requested: readonly RoleResource[], authorized: readonly RoleResource[]): RoleResourceProjection {
  const keys = new Set(authorized.map(resourceKey).filter((key): key is string => key !== undefined));
  const resources: RoleResource[] = [];
  const rejected: { resource: RoleResource; reason: 'unsupported_resource' | 'role_forbidden' | 'not_authorized' }[] = [];
  for (const resource of requested) {
    const key = resourceKey(resource);
    if (key === undefined) rejected.push({ resource, reason: 'unsupported_resource' });
    else if ((role !== 'interaction' && role !== 'execution') || (role === 'interaction' && resource.kind !== 'platform_task' && resource.kind !== 'knowledge_read')) rejected.push({ resource, reason: 'role_forbidden' });
    else if (!keys.has(key)) rejected.push({ resource, reason: 'not_authorized' });
    else resources.push({ ...resource });
  }
  return { valid: rejected.length === 0 && (role === 'interaction' || role === 'execution'), resources, rejected };
}
