import type { ContentRef, InvocationTarget } from '@dentity/domain';
import type { RuntimeError, RuntimeRef } from './runtime-common.js';

export interface TaskInputRevision {
  readonly taskId: string;
  readonly revision: number;
  readonly inputRef: ContentRef;
  readonly snapshotId: string;
}

/** Platform -> Runtime event. No model messages, tool names or result payloads. */
export interface RuntimeInteractionEvent {
  readonly schemaVersion:1;
  readonly source:'platform';
  readonly eventId:string;
  readonly type:'task_terminal'|'business_result';
  readonly data?:{readonly sourceKind:'task'|'trigger'|'work_item';readonly facts:Readonly<Record<string,unknown>>;readonly refs:readonly ContentRef[]};
  readonly taskId:string;
  readonly runId:string;
  readonly status:'succeeded'|'failed'|'canceled'|'pending'|'in_progress'|'waiting'|'awaiting_acceptance'|'completed';
  readonly conversationId:string;
}
export type InteractionEventReceipt={readonly eventId:string;readonly execution?:ExecutionRef;readonly replyId?:string;readonly outputRef?:ContentRef;readonly error?:RuntimeError;readonly status:'accepted'|'queued'|'processing'|'processed'|'failed'|'unsupported'|'unknown'};

export type InvocationInput =
  | { readonly kind: 'interaction_turn'; readonly conversationId: string; readonly turnId: string; readonly epoch: number; readonly messageRefs: readonly ContentRef[]; readonly historyBatchId?: string; readonly inputId?:string; readonly admissionAuthorized?:boolean; readonly routeBinding?:string }
  | { readonly kind: 'task_run'; readonly taskId: string; readonly runId: string; readonly taskInput: TaskInputRevision };

/** Allocate executionId before submit so unknown acceptance can still be reconciled. */
export interface ExecutionRef {
  readonly runtime: RuntimeRef;
  readonly executionId: string;
  readonly sessionId: string;
  readonly invocationId: string;
  readonly target: InvocationTarget;
  readonly remoteHandle?: string;
}

export type ExecutionReceipt = { readonly operationId: string; readonly execution: ExecutionRef } & (
  | { readonly status: 'accepted'; readonly acceptedAt: string;readonly state?:'queued'|'accepted' }
  | { readonly status: 'rejected'; readonly error: RuntimeError }
  | { readonly status: 'unknown'; readonly error: RuntimeError }
);

export type ExecutionState = 'queued' | 'accepted' | 'running' | 'waiting_input' | 'waiting_approval' | 'cancel_requested' | 'needs_human' | 'succeeded' | 'failed' | 'canceled' | 'unknown';

export interface ExecutionStatus {
  readonly execution: ExecutionRef;
  readonly status: ExecutionState;
  readonly observedAt: string;
  readonly lastCursor?: string;
  readonly error?: RuntimeError;
}

export type AdditionalInput =
  | { readonly kind: 'interaction_turn'; readonly messageRefs: readonly ContentRef[] }
  | { readonly kind: 'task_run'; readonly taskInput: TaskInputRevision };

/** received is not applied. provider_request evidence means consumed into the authorized
 * serialized request context, not acknowledged delivery to a remote model or task completion. */
export type InputReceipt = {
  readonly operationId: string;
  readonly execution: ExecutionRef;
  readonly inputId: string;
  readonly input: { readonly kind: 'interaction_turn' } | { readonly kind: 'task_run'; readonly inputRevision: number };
} & (
  | { readonly status: 'received'; readonly effect: 'queued_next_turn' | 'queued_steer' | 'pending'; readonly acceptedAt?: string; readonly queuedAt?: string }
  | { readonly status: 'applied'; readonly effect: 'steered' | 'resumed' | 'next_turn'; readonly appliedAt: string; readonly evidence?: { readonly kind: 'provider_request'; readonly requestId: string; readonly messageEntryId: string; readonly contentDigest: string } }
  | { readonly status: 'rejected' | 'unsupported' | 'unknown'; readonly error: RuntimeError }
);

/** confirmed only when the adapter knows all work in the invocation has stopped. */
export type CancelReceipt = { readonly operationId: string; readonly execution: ExecutionRef } & (
  | { readonly status: 'requested'; readonly requestedAt: string }
  | { readonly status: 'confirmed'; readonly confirmedAt: string }
  | { readonly status: 'unsupported' | 'unknown'; readonly reason: string }
);

export interface ArtifactRef {
  readonly content: ContentRef;
  readonly availability: 'available' | 'pending';
}

export interface ArtifactDescriptor extends ArtifactRef {readonly name:string;readonly mediaType:string;readonly size:number;readonly kind:'image'|'file'}

export interface ResultPayload {
  /** Structured content is separately stored and access-controlled, not a raw tool log. */
  readonly outputRef: ContentRef;
  readonly artifactRefs: readonly ArtifactRef[];
  readonly provenance: { readonly sourceRefs: readonly ContentRef[]; readonly producer: string };
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
}

export type InvocationResult = ResultPayload & (
  | { readonly kind: 'interaction_turn'; readonly conversationId: string; readonly turnId: string; readonly epoch: number;readonly replyId?:string;readonly coveredTurnIds?:readonly string[] }
  | { readonly kind: 'task_run'; readonly taskId: string; readonly runId: string; readonly basedOnInputRevision: number }
);

export type ExecutionResult =
  | { readonly status: 'available'; readonly execution: ExecutionRef; readonly result: InvocationResult }
  | { readonly status: 'not_ready' | 'unavailable' | 'unknown'; readonly execution: ExecutionRef; readonly reason: string };

/** Cursor is source-local and opaque; never substitute for the platform persistence cursor. */
export interface RuntimeEventEnvelope {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly execution: ExecutionRef;
  readonly occurredAt: string;
  readonly sequence: number;
  readonly cursor?: string;
  readonly operationId: string;
  readonly correlationId: string;
  readonly causationId: string;
  readonly producer: { readonly runtimeId: string; readonly adapterVersion: string };
}

export type RuntimeEvent = RuntimeEventEnvelope & (
  | {readonly eventType:'work_item_safe';readonly payload:import('./work-items.js').WorkItemSafeCheckpoint}
  | {readonly eventType:'human_request'|'human_safe';readonly payload:import('./human-confirmation.js').HumanCheckpoint}

  | { readonly eventType: 'status_changed'; readonly payload: { readonly status: ExecutionState; readonly error?: RuntimeError } }
  | { readonly eventType: 'progress' | 'milestone' | 'blocker' | 'input_required' | 'approval_required'; readonly payload: { readonly contentRef: ContentRef; readonly artifactRefs: readonly ArtifactRef[] } }
  | { readonly eventType: 'partial_result'; readonly payload: { readonly result: InvocationResult; readonly provisional: true } }
  | { readonly eventType: 'final_result'; readonly payload: { readonly result: InvocationResult } }
  /** Not a business milestone or task completion; consumers must check target + epoch. */
  | { readonly eventType: 'output_delta'; readonly payload: { readonly text: string } }
  | { readonly eventType: 'input_receipt'; readonly payload: InputReceipt }
);

/** Durable interaction facts; distinct from streaming fragments and execution completion. */
export type InteractionDeliveryEvent={readonly eventId:string;readonly cursor:string;readonly occurredAt:string;readonly inputIds:readonly string[];readonly turnIds:readonly string[]} & (
 | {readonly type:'input_committed';readonly inputId:string;readonly batchId?:string}
 | {readonly type:'output';readonly outputId:string;readonly outputRef:ContentRef}
 | {readonly type:'terminal';readonly status:ExecutionState;readonly error?:Pick<RuntimeError,'code'|'safeMessage'>}
);
