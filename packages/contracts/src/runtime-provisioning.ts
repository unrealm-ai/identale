import type { AgentRole, ContentRef, EntityScope } from '@dentity/domain';
import type { CapabilityName, RuntimeRef, ThinkingLevel } from './runtime-common.js';

export interface ResolvedAgentSpec extends EntityScope {
  readonly specVersion: 1;
  readonly specId: string;
  readonly specHash: string;
  readonly agentBindingId: string;
  readonly role: AgentRole;
  /** New specs always supply this. Missing only retains legacy v1 role defaults. */
  readonly thinkingLevel?: ThinkingLevel;
  readonly sourceVersions: { readonly definition: string; readonly entityConfig: string; readonly profile: string };
  readonly instructions: ContentRef;
  /** Registered model configuration contains an approved endpoint and secret references. */
  readonly modelProfileRef: ContentRef;
  readonly skills: readonly { readonly resourceId: string; readonly version: string; readonly digest: string }[];
  readonly mcpServers: readonly {
    readonly serverRef: string;
    readonly version?: string;
    readonly allowedTools: readonly string[];
    readonly secretRef?: string;
  }[];
  readonly cliRequirements: readonly {
    readonly packageRef: string; readonly version: string; readonly entrypoint: string; readonly executionProfileRef: string;
  }[];
  /** Explicit deployment-registered local execution resources, never arbitrary model paths. */
  readonly executionResources?: readonly { readonly resourceId: string; readonly version: string; readonly tools: readonly ('read' | 'write' | 'edit' | 'bash')[] }[];
  readonly platformTools: readonly string[];
  readonly knowledgeScopes: readonly string[];
  readonly contextPolicyRef: string;
  readonly authorizationRef: string;
  readonly limits: { readonly timeoutSeconds: number; readonly maxConcurrentTools: number };
  readonly requiredCapabilities: readonly CapabilityName[];
  readonly optionalCapabilities: readonly CapabilityName[];
}

export interface ProvisioningPolicy {
  readonly policyRef: string;
  readonly allowedOptionalDegradations: readonly CapabilityName[];
  readonly secretDelivery: 'protected_only' | 'controlled_env_allowed';
}

export interface ValidationReport {
  readonly specId: string;
  readonly specHash: string;
  readonly valid: boolean;
  readonly fields: readonly {
    readonly field: string;
    readonly status: 'supported' | 'unsupported' | 'external_preconfiguration_required' | 'user_authorization_required' | 'unknown';
    readonly reason: string;
  }[];
}

export interface PreparedAgentHandle {
  readonly runtime: RuntimeRef;
  readonly opaqueHandle: string;
  readonly specId: string;
  readonly specHash: string;
  readonly role: AgentRole;
  readonly isolationScope: { readonly scopeId: string; readonly authorizationRef: string; readonly configRevision: string };
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly appliedConfigReportRef: string;
}

/** Report actual enforcement, not merely requested configuration. */
export interface AppliedConfigReport {
  readonly reportRef: string;
  readonly handle: PreparedAgentHandle;
  readonly observedAt: string;
  readonly fields: readonly {
    readonly field: string;
    readonly status: 'applied' | 'externally_managed' | 'input_only' | 'not_applied' | 'unverified';
    readonly reason: string;
    readonly enforcementLocation?: string;
  }[];
  readonly degradations: readonly { readonly capability: CapabilityName; readonly policyRef: string; readonly reason: string }[];
  readonly secretDelivery: {
    readonly mode: 'none' | 'protected_injection' | 'controlled_env';
    readonly recipientScopeRef?: string;
    readonly limitations: readonly string[];
  };
}

/** Release never implies cancellation, result deletion, or audit deletion. */
export type ReleaseResult =
  | { readonly status: 'released' | 'already_released' }
  | { readonly status: 'in_use' | 'unsupported' | 'unknown'; readonly reason: string };
