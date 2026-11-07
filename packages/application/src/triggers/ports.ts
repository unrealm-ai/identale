/** Business ingress is independent of conversation/channel adapters. */
export type TriggerAction='create_task'|'supplement_task'|'cancel_task';
export type TriggerHistoryPolicy='isolated'|'employee_shared'|'business_key';
export type TriggerContextNamespace='isolated'|'shared'|'business';
export type TriggerSourceKind='webhook'|'github_issue'|'schedule';
export interface TriggerCommand {
  readonly version:1;
  readonly eventId:string;
  readonly action:TriggerAction;
  readonly description?:string;
  readonly businessKey?:string;
  readonly taskId?:string;
  readonly entityId?:string;
}
export interface VerifiedTriggerEvent {
  readonly triggerId:string;
  readonly sourceKind:TriggerSourceKind;
  readonly sourceEvidenceRef:string;
  readonly receivedAt:number;
  readonly occurredAt:number;
  readonly bodyHash:string;
  readonly command:TriggerCommand;
  readonly scheduledAt?:number;
  readonly timezone?:string;
}
export interface TriggerReceipt {
  readonly eventId:string;
  readonly eventRecordId:string;
  readonly taskId?:string;
  readonly contextId?:string;
  readonly commandId?:string;
  readonly status:'accepted'|'rejected';
  readonly duplicate:boolean;
  readonly errorCode?:string;
}
export interface TriggerAcceptancePort {accept(event:VerifiedTriggerEvent):Promise<TriggerReceipt>}
export interface WebhookTriggerPort {
  receive(input:{triggerId:string;method:string;path:string;secure:boolean;headers:Readonly<Record<string,string|undefined>>;body:Uint8Array;receivedAt:number}):Promise<TriggerReceipt>;
}
export interface ScheduledTriggerPort {
  occurrence(input:{triggerId:string;bindingVersion:number;scheduledAt:number;receivedAt:number}):Promise<TriggerReceipt>;
}
export interface TriggerHistoryItem {
  readonly taskId:string;
  readonly taskStatus:'succeeded'|'failed'|'canceled';
  readonly runId:string;
  readonly attempt:number;
  readonly runStatus:'succeeded'|'failed'|'canceled';
  readonly resultRef?:string;
  readonly records:readonly {resourceId:string;runtimeId:string;hostId:string;format:string;version?:number;committedCursor?:string;sha256?:string;byteLength?:number;availability:'available'|'unavailable'}[];
}
export interface TriggerHistoryManifest {
  readonly version:1;
  readonly workspaceId:string;
  readonly entityId:string;
  readonly taskId:string;
  readonly runId:string;
  readonly policyRevision:number;
  readonly contextNamespace:TriggerContextNamespace;
  readonly contextKey:string;
  readonly cutoffAt:number;
  readonly items:readonly TriggerHistoryItem[];
}

/** Native export reports logical references only; never accepts caller-selected file paths. */
export interface ExecutionRecordsPort {executionRecords(request:import('@dentity/contracts').RuntimeRequest<{execution:import('@dentity/contracts').ExecutionRef},import('@dentity/domain').RuntimeAuthorizationContext>):Promise<import('@dentity/contracts').RuntimeOutcome<TriggerHistoryItem['records']>>}
