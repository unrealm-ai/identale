/** Design vocabulary only: these types do not advertise installed runtime support. */
export type AgentRole = 'interaction' | 'execution';
/** Registry identifier, extensible without changing core ports for each adapter.
 * Only trusted catalog entries validated for the requested role may be selected;
 * an arbitrary string is not evidence of registration, permission, or capability.
 * No runtime catalog implementation is provided by this type.
 */
export type RuntimeType = string;
/** Planned MVP choices only, not a list of installed or supported adapters. */
export type MvpRuntimeType = 'builtin-interaction' | 'local-pi';
export type {
  EntityScope, ConversationRef, ChannelRef, ChannelPrincipalRef, TriggerIdentity, ContentRef,
  InvocationTarget, RuntimeAuthorizationContext, ManagementAuthorizationContext, AuthorizationContext, InvocationContext,
} from './runtime.js';

export {
  evaluateEntityAccess, evaluatePackageAccess, projectRoleResources, PLATFORM_TASK_TOOLS,
} from './authorization.js';
export type {
  AuthorizationFact, AccessRequest, RequesterSelector, ChannelSelector, AccessRule,
  EntityAccessPolicy, PackageAccessPolicy, AccessDecision, RoleResource, RoleResourceProjection,
} from './authorization.js';
