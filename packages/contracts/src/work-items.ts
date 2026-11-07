export type WorkItemStatus='pending'|'in_progress'|'waiting'|'awaiting_acceptance'|'completed'|'canceled'|'failed';
/** Independent of the human and Trigger usage dimensions. */
/** selectionMode opts into mutually exclusive lists; omission preserves historical deny precedence. */
export interface HandoffUsageScope {mode:'all'|'allowlist';selectionMode?:'all'|'allowlist'|'denylist';allowEmployeeIds:string[];denyEmployeeIds:string[]}
export interface EmployeeHandoffPolicy{version:number;allowAll:boolean;scope:HandoffUsageScope}
export type HandoffUsageMode='inherit'|'custom';
export interface AssignmentTaskSource {workItemId:string;assignmentId:string;grantId:string;rootTaskId:string;sourceEmployeeId:string;targetEmployeeId:string}
export interface WorkItemAccess {version:1;endpoint:string;credential:string;runId:string;hostId:string}
export type WorkItemTaskRole='ordinary'|'work'|'acceptance';
/** Frozen Task permission ceiling. Runtime exposure is narrowed by its trusted assignment role. */
export const WORK_ITEM_TOOLS=['work_item_get_current','work_item_list_handoff_employees','work_item_handoff','work_item_update_progress','work_item_finish']as const;
export interface WorkItemTaskToolSnapshot{version:1;betaRevision:number;tools:readonly typeof WORK_ITEM_TOOLS[number][]}
export type WorkItemOperation='get_current'|'progress'|'handoff'|'finish'|'employees'|'reconcile';
export interface WorkItemBoundary{intentId:string;operationId:string;taskId:string;runId:string;workItemId:string;assignmentId:string;kind:'handoff'|'finish';digest:string}
export interface WorkItemSafeCheckpoint extends WorkItemBoundary{checkpointRef:string}
export interface WorkItemLaunchGate{version:1;workspaceId:string;revision:number;enabled:boolean}
export interface WorkItemProjection {assignmentKind?:'work'|'acceptance';id:string;workspaceId:string;title:string;goal:string;criteria:string;status:WorkItemStatus;summary:string;step:string;nextStep:string;waitReason:string;completionEvidence:string;ownerEmployeeId:string;originEmployeeId:string;currentAssignmentId:string;version:number;betaPaused:boolean;pendingDispatch?:{employeeId:string;assignmentId:string;status:'waiting'|'queued'|'started'|'blocked';error?:string};createdAt:number;updatedAt:number}

/** Minimal authorized discovery projection; package policy and resources stay server-side. */
export interface WorkItemHandoffEmployee{id:string;name:string;description:string;enabled:true;canReceive:true;reason:null;availablePackageCount:number;availablePackages:{name:string;description:string}[]}
