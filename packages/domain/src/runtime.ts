/** Platform-owned identifiers, never vendor task/session IDs or authorization proofs. */
export interface EntityScope {
  readonly workspaceId: string;
  readonly entityId: string;
}

export interface ChannelRef {
  readonly channelType: string;
  readonly tenantId: string;
  readonly installationId: string;
}

export interface ChannelPrincipalRef {
  readonly channelType: string;
  readonly tenantId: string;
  readonly identityNamespace: string;
  readonly externalUserId: string;
}

export type TriggerIdentity =
  | { readonly kind: 'human_request'; readonly requester: ChannelPrincipalRef }
  | { readonly kind: 'configured_event'; readonly triggerBindingId: string }
  | {readonly kind:'business_notification';readonly eventId:string}
  | {readonly kind:'work_item_assignment';readonly workItemId:string;readonly assignmentId:string;readonly grantRef:string};

/** Object-store/application reference resolved with authorization, not a path or URL. */
export interface ContentRef {
  readonly resourceId: string;
  readonly version: string;
}

export type InvocationTarget =
  | {
      readonly kind: 'interaction_turn';
      readonly conversationId: string;
      readonly turnId: string;
      readonly epoch: number;
    }
  | { readonly kind: 'task_run'; readonly taskId: string; readonly runId: string };

export interface ConversationRef {
  readonly conversationId: string;
  readonly kind: 'private' | 'group' | 'meeting' | 'event';
  readonly threadId?: string;
}

/** References require current validation; possession of a reference grants no access. */
export interface RuntimeAuthorizationContext extends EntityScope {
  readonly authorizationRef: string;
  readonly expiresAt: string;
}

/** Control-plane permission decision, available before any conversation or trigger exists.
 * authenticatedActorRef resolves a verified operator/service principal, never a self-reported userId.
 */
export interface ManagementAuthorizationContext extends RuntimeAuthorizationContext {
  readonly authenticatedActorRef: string;
}

interface AuthorizationBinding extends RuntimeAuthorizationContext {
  readonly grantRef: string;
  readonly triggerId: string;
  readonly sourceEventRef: string;
  readonly configRevision: string;
}

/** Unattended events need an authenticated trigger binding, not a fabricated user/conversation. */
export type AuthorizationContext = AuthorizationBinding & (
  | {
      readonly trigger: Extract<TriggerIdentity, { readonly kind: 'human_request' }>;
      readonly sourceChannel: ChannelRef;
      readonly conversation: ConversationRef;
    }
  | {
      readonly trigger: Extract<TriggerIdentity, { readonly kind: 'configured_event'|'work_item_assignment'|'business_notification' }>;
      readonly sourceChannel?: ChannelRef;
      readonly conversation?: ConversationRef;
    }
);

/** Trusted host metadata, never part of model-controllable tool arguments. */
export type InvocationContext = AuthorizationContext & {
  readonly invocationId: string;
  readonly sessionId: string;
  readonly target: InvocationTarget;
};
