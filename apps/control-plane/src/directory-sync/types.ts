import type {DirectoryProvider,DiagnosticFailure} from '@dentity/application';
export type DirectorySyncTrigger='scheduled'|'manual'|'demand'|'configuration';
export type DirectorySyncErrorCode='source_unavailable'|'source_changed'|'remote_authentication'|'remote_permission'|'remote_timeout'|'remote_network'|'remote_parse'|'sync_budget'|'sync_interrupted'|'sync_unavailable'|'dependency_unavailable';
export interface DirectorySyncError {code:DirectorySyncErrorCode;category:'authentication'|'permission'|'timeout'|'network'|'parse'|'limit'|'source'|'unknown';httpStatus?:number;providerCode?:number;operation?:NonNullable<DiagnosticFailure['operation']>;endpoint?:NonNullable<DiagnosticFailure['endpoint']>;userIdType?:NonNullable<DiagnosticFailure['userIdType']>;departmentIdType?:NonNullable<DiagnosticFailure['departmentIdType']>;rootDepartment?:boolean;requestId?:string}
export type DirectorySyncPartKind='scope'|'user'|'department'|'department_members'|'department_children'|'department_descendants';
export interface DirectorySyncPart {partId:string;kind:DirectorySyncPartKind;status:'running'|'success'|'failure'|'blocked'|'abandoned';startedAt:number;finishedAt:number|null;version:number;lastSuccessAt:number|null;stale:boolean;userCount:number;departmentCount:number;error:DirectorySyncError|null}
export interface DirectorySyncPartSummary {total:number;succeeded:number;failed:number;blocked:number;running:number}
export interface DirectorySyncTask {
 id:string;workspaceId:string;entityId:string;entityName:string;connectionId:string;provider:DirectoryProvider;appId:string;
 memberConnectionIds?:readonly string[];version:number;enabled:boolean;periodMs:number;nextScheduledAt:number|null;running:boolean;
 lastStartedAt:number|null;lastFinishedAt:number|null;lastSuccessAt:number|null;
 lastResult:'never'|'success'|'failure'|'invalidated';lastError:DirectorySyncError|null;
 snapshotVersion:number;hasSnapshot:boolean;stale:boolean;parts:DirectorySyncPart[];partSummary:DirectorySyncPartSummary;
}
export interface DirectorySyncHistory {
 id:string;taskId:string;trigger:DirectorySyncTrigger;startedAt:number;finishedAt:number|null;
 status:'running'|'success'|'failure'|'abandoned';snapshotVersion:number|null;
 userCount:number;departmentCount:number;error:DirectorySyncError|null;parts:DirectorySyncPart[];partSummary:DirectorySyncPartSummary;
}
export interface DirectorySyncTaskPatch {expectedVersion:number;enabled?:boolean;periodMs?:number}
export interface DirectorySyncTaskList {tasks:DirectorySyncTask[];capabilities:{provider:DirectoryProvider;status:'supported'|'planned'}[]}
export interface DirectorySyncHistoryPage {items:DirectorySyncHistory[];nextCursor:string|null}
export interface DirectorySyncRunAccepted {accepted:boolean;task:DirectorySyncTask}
