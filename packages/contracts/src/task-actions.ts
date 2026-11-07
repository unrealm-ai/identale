/** Platform-owned action vocabulary; adapters never define model tool schemas. */
export type TaskActionReason = 'permission_denied' | 'task_not_started' | 'task_terminal' | 'cancel_already_requested' | 'run_terminal' | 'runtime_not_bound' | 'runtime_state_unknown' | 'runtime_capability_unknown' | 'runtime_action_unsupported' | 'runtime_not_configured' | 'platform_action_unsupported';
export interface TaskActionAvailability { available: boolean; reason?: TaskActionReason }
export interface TaskAvailableActions {
  query: TaskActionAvailability & { mode: 'read' };
  start: TaskActionAvailability & { mode: 'start_planned' };
  supplement: TaskActionAvailability & { mode: 'platform_record_only' | 'runtime_input' | 'dispatch_input'; runtimeDelivery: { support: 'supported'|'unsupported'|'unknown'; reason?: TaskActionReason }; application: 'not_guaranteed'|'on_start' };
  cancel: TaskActionAvailability & { mode: 'request_cancel'|'cancel_planned'; confirmation: 'runtime_required'|'platform_confirmed' };
  pause: TaskActionAvailability;
  resume: TaskActionAvailability;
}
export interface TaskActionReceipt {
  action: 'supplement'|'cancel'|'start'; operationId: string; status: 'recorded'|'requested'|'queued'|'canceled'|'already_started';
  inputRevision?: number; deliveryMode?: 'platform_record_only'|'runtime_input'|'dispatch_input';
  /** Current authoritative observation, not a promise that the executor applied/stopped. */
  runtimeStatus: string;
}
