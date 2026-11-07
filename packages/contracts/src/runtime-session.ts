import type { AgentRole, ContentRef } from '@dentity/domain';
import type { RuntimeRef } from './runtime-common.js';

export type SessionScope =
  | { readonly kind: 'interaction'; readonly conversationId: string }
  | { readonly kind: 'execution'; readonly taskId: string; readonly runId: string };

/** Trusted adapter location metadata, not a path or authorization to read a resource.
 * Resolve only through the owning runtime after platform scope/retention checks.
 * Other adapters may omit this capability; format does not imply native JSONL support.
 */
export interface SessionRecordLocation {
  readonly storage: 'local';
  readonly hostId: string;
  readonly resourceId: string;
  readonly format: string;
  readonly version: 1;
}

export interface SessionHandle {
  readonly runtime: RuntimeRef;
  /** Allocated before dispatch. Builtin interaction uses conversationId exactly;
   * external adapters retain their native session mapping independently of model/config revisions. */
  readonly sessionId: string;
  /** Runtime-owned, scoped to runtime + entity; not a platform primary key. */
  readonly opaqueHandle: string;
  readonly preparedAgentHandle: string;
  readonly specHash: string;
  readonly configRevision: string;
  readonly role: AgentRole;
  readonly scope: SessionScope;
  readonly recordLocation?: SessionRecordLocation;
}

/** Filtered platform snapshot; no shared directory or private runtime history required. */
export interface ContextBootstrap {
  readonly scope: SessionScope;
  readonly mode: 'new' | 'fork';
  readonly snapshotId: string;
  readonly bundleRef: ContentRef;
  readonly sourceSessionRef?: { readonly runtime: RuntimeRef; readonly sessionId: string };
  readonly inputRefs: readonly ContentRef[];
  readonly summaryRef?: ContentRef;
  readonly knowledgeScopes: readonly string[];
  readonly workStateViewRef: ContentRef;
  readonly budget: { readonly maxTokens: number; readonly maxBytes: number };
  readonly provenance: { readonly sourceRefs: readonly ContentRef[]; readonly authorizationDecisionRef: string; readonly createdAt: string };
}

/** Closing is not proof that outstanding effects were canceled. */
export type CloseResult =
  | { readonly status: 'closed' | 'already_closed' }
  | { readonly status: 'in_use' | 'unsupported' | 'unknown'; readonly reason: string };
