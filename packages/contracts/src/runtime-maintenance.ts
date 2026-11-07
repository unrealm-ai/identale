import type { SessionHandle } from './runtime-session.js';
/** Trusted policy, not model-provided arguments. All limits are bounded by the adapter. */
export interface ContextMaintenancePolicy {
  readonly retainMessages:number;
  readonly recentDays:number;
  readonly maxSummaryTokens:number;
  readonly maxDailySummaryTokens:number;
  readonly contextTokenThreshold:number;
  readonly timezone:string;
}
/** Maintenance is not a human invocation and carries no business-tool authority. */
export interface RuntimeMaintenanceRequest {
  readonly operationId:string;
  readonly deadlineAt:string;
  readonly authorization:{
    readonly workspaceId:string; readonly entityId:string; readonly conversationId:string;
    readonly sessionId:string; readonly configRevision:string; readonly policyRevision:string;
    readonly jobRunId:string; readonly leaseToken:string; readonly expiresAt:string;
  };
  readonly session:SessionHandle;
  readonly reason:'schedule'|'context_threshold';
  readonly policy:ContextMaintenancePolicy;
  readonly idempotencyKey:string;
}
export interface RuntimeContextInspection {
  readonly estimatedTokens:number;
  readonly historyRevision:string;
  readonly hasModel:boolean;
  readonly active:boolean;
}
export interface RuntimeMaintenanceReceipt {
  readonly status:'summarizing'|'ready'|'applied'|'skipped'|'failed'|'obsolete';
  readonly runId:string;
  readonly reason?:string;
}
