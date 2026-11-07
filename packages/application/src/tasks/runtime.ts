/** Durable explicit start of a saved todo; not an approval of its business actions. */
export interface TodoStartFact { kind:'explicit_todo_start'; taskId:string; runId:string; operationId:string; inputRevision:number }
import type { ThinkingLevel } from '@dentity/contracts';
import type { ChannelPrincipalRef } from '@dentity/domain';
/** Platform-to-trusted-host boundary. Production must supply a real authenticated client. */
interface TaskCommandBase {
  operationId: string; runId: string; taskId: string; workspaceId: string; entityId: string;
  sessionId: string; inputRevision: number; input: string;
  continuation?:import('@dentity/contracts').HumanContinuation;
  context: { mode: 'new' | 'fork'; snapshotId: string; messages: { id: string; role: string; text: string }[] };
}
export type TaskCommand=TaskCommandBase & ({requester:ChannelPrincipalRef;triggerEvent?:never;assignment?:never}|{requester?:never;triggerEvent:import('./principal.js').BusinessTaskSource;assignment?:never}|{requester?:never;triggerEvent?:never;assignment:import('@dentity/contracts').AssignmentTaskSource});
export interface TaskRuntimeEvent {
  eventId: string; runId: string; sequence: number;
  workItemSafe?:import('@dentity/contracts').WorkItemSafeCheckpoint;
  human?:import('@dentity/contracts').HumanCheckpoint;
  type: 'work_item_safe'|'human_request'|'human_safe'|'status' | 'progress' | 'output_delta' | 'partial_result' | 'final_result' | 'input_receipt';
  status?: 'queued'|'running' | 'waiting_input' | 'waiting_approval' | 'needs_human' | 'succeeded' | 'failed' | 'canceled' | 'unknown';
  text?: string; inputRevision?: number; inputStatus?: 'received' | 'applied';
}
export interface TaskRuntimeCapabilities {
  runId: string; runtimeId: string; runtimeVersion: string; bindingVersion: string;
  observedAt: number; expiresAt: number;
  thinkingLevels?: Partial<Record<ThinkingLevel,'supported'|'unsupported'|'unknown'>>;
  appendInput: 'supported'|'unsupported'|'unknown'; cancel: 'supported'|'unsupported'|'unknown';
}
export interface TaskArtifactReadPort {
  /** Caller authorizes Task visibility and the destination; IDs are never bearer grants. */
  artifacts(runId:string):import('@dentity/contracts').ArtifactDescriptor[];
  artifactContent(runId:string,artifactId:string):Promise<{kind:'image'|'file';name:string;mediaType:string;bytes:Uint8Array}>;
}
export interface TaskRuntimeClient extends Partial<TaskArtifactReadPort> {
  /** Local, binding-scoped evidence only. Missing/expired evidence means unknown. */
  capabilities?(runId: string): TaskRuntimeCapabilities | undefined;
  /** Re-observe trusted adapter capabilities before mutations; never called by DTO rendering. */
  refreshCapabilities?(runId: string): Promise<void>;
  /** Must deduplicate operationId durably, or return unknown, never silently replay. */
  dispatch(command: TaskCommand): Promise<{ status: 'accepted' | 'rejected' | 'unknown' }>;
  input(command: TaskCommand): Promise<{ status: 'received' | 'applied' | 'unsupported' | 'unknown' }>;
  cancel(command: TaskCommand): Promise<{ status: 'requested' | 'confirmed' | 'unsupported' | 'unknown' }>;
  events(runId: string, afterSequence: number): Promise<TaskRuntimeEvent[]>;
  /** True only with documented durable operation-id deduplication at the receiving host. */
  readonly idempotentDispatch: boolean;
  readonly idempotentInput?: boolean;
  readonly idempotentCancel?: boolean;
}

export interface TaskHumanCoordinator {
 hasOpenRequest?(taskId:string):boolean;
 view?(taskId:string):unknown[];
 onEvent(task:import('./service.js').TaskRow,event:TaskRuntimeEvent):void;
 tick():Promise<void>;
 cancel(task:import('./service.js').TaskRow):void;
 continuation(runId:string):import('@dentity/contracts').HumanContinuation|undefined;
}
