import type { AgentRole, AuthorizationContext, EntityScope, InvocationContext, ManagementAuthorizationContext, RuntimeAuthorizationContext, RuntimeType } from '@dentity/domain';

/** Version of these logical DTOs, not a claim that an HTTP wire protocol exists. */
export const RUNTIME_CONTRACT_VERSION = 1 as const;

/** Platform vocabulary. Vendor SDK names (such as pi's off) belong in adapters. */
export type ThinkingLevel = 'none' | 'low' | 'medium' | 'high';
export const THINKING_LEVELS = ['none', 'low', 'medium', 'high'] as const;
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return THINKING_LEVELS.some(level => level === value);
}
/** Missing is reserved for authenticated, persisted v1 configurations. Never mutate their hashes. */
export function resolvedThinkingLevel(spec: { readonly role: AgentRole; readonly thinkingLevel?: ThinkingLevel }): ThinkingLevel {
  const level = spec.thinkingLevel === undefined ? (spec.role === 'interaction' ? 'none' : 'medium') : spec.thinkingLevel;
  if (!isThinkingLevel(level) || (spec.role === 'interaction' && level !== 'none')) throw new Error('unsupported_thinking_level');
  return level;
}

export interface RuntimeRef extends EntityScope {
  readonly runtimeId: string;
}

/** Required for reads as well as writes. Adapter verifies context against trusted records. */
export interface RuntimeRequest<T, C extends RuntimeAuthorizationContext = AuthorizationContext> {
  readonly schemaVersion: typeof RUNTIME_CONTRACT_VERSION;
  readonly operationId: string;
  readonly correlationId: string;
  readonly causationId: string;
  readonly deadlineAt: string;
  readonly authorizationContext: C;
  readonly payload: T;
}

export type ProvisioningRequest<T> = RuntimeRequest<T, ManagementAuthorizationContext>;

export type InvocationRequest<T> = RuntimeRequest<T, InvocationContext>;

export type RuntimeErrorCode =
  | 'INVALID_SPEC' | 'UNSUPPORTED_CAPABILITY' | 'POLICY_DENIED' | 'RESOURCE_MISSING'
  | 'MAINTENANCE_RECONCILIATION_REQUIRED' | 'CREDENTIAL_UNAVAILABLE' | 'RUNTIME_UNAVAILABLE' | 'REMOTE_REJECTED'
  | 'TIMEOUT_UNKNOWN' | 'SESSION_NOT_FOUND' | 'CONFLICT';

export interface RuntimeError {
  readonly code: RuntimeErrorCode;
  /** Eligibility only; never permission to replay an unknown side effect. */
  readonly retryable: boolean;
  readonly operationId: string;
  readonly safeMessage: string;
  readonly detailsRef?: string;
}

/** Expected failures are data; thrown transport failures never prove non-execution. */
export type RuntimeOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RuntimeError };

export type CapabilityName =
  | 'prompt' | 'model' | 'skills' | 'mcp' | 'cli'
  | 'createSession' | 'resumeSession' | 'persistSession' | 'nativeFork' | 'importHistory'
  | 'rawExecutionRecords' | 'exportCheckpoint' | 'interactionTurn' | 'taskRun' | 'stream' | 'poll'
  | 'interactionEvents' | 'appendInput' | 'steer' | 'inputQueue' | 'cancel' | 'interrupt' | 'idempotentSubmit'
  | 'toolAllowlist' | 'credentialScope' | 'filesystemScope' | 'networkScope'
  | 'nativePermissions' | 'blockingBeforeInvokeHook' | 'beforeModelResultHook'
  | 'trustedInvocationContext' | 'perInvocationIsolation' | 'remoteIdentityPropagation'
  | 'protectedSecretStore' | 'protectedMcpInjection' | 'scopedCredentialBinding'
  | 'secretLifecycle' | 'secretEnvInjection' | 'secretRedaction'
  | 'contextBootstrap' | 'scopedContextRetrieval' | 'hostContextProxy'
  | 'incrementalInput' | 'inputAppliedAck' | 'outboundTaskPolling'
  | 'uploadInput' | 'readOutput' | 'eventCursor' | 'usage' | 'trace' | 'remoteStatusQuery'
  | 'progressReporting' | 'partialResults' | 'contextCompaction' | 'backgroundCompaction';

/** Omitted entries are unknown, never implicitly supported. Limits are adapter evidence. */
export interface CapabilitySupport {
  readonly status: 'supported' | 'unsupported' | 'unknown';
  readonly reason: string;
  readonly limitations: readonly string[];
}

export interface RuntimeCapabilities {
  readonly runtime: RuntimeRef;
  readonly type: RuntimeType;
  readonly runtimeVersion: string;
  readonly observedAt: string;
  readonly available: CapabilitySupport;
  readonly provisioningMode: 'managed' | 'external';
  readonly roles: readonly {
    readonly role: AgentRole;
    readonly support: CapabilitySupport;
    readonly capabilities: Readonly<Partial<Record<CapabilityName, CapabilitySupport>>>;
    /** SDK/adapter parameter support, not proof of a provider's internal reasoning semantics. Omitted means unknown. */
    readonly thinkingLevels?: Readonly<Partial<Record<ThinkingLevel, CapabilitySupport>>>;
    readonly reportingModes: readonly ('push' | 'poll')[];
    readonly isolationLevel: string;
    readonly coveredToolPaths: readonly string[];
    readonly bypassConstraints: readonly string[];
    readonly maxConcurrentInvocations?: number;
    readonly maxContextPayloadBytes?: number;
  }[];
}
