export interface ActivityTask {humanRequests?:{requestId:string;status:string;safe:boolean;notificationStatus:string;notificationError:string|null;continuationRunId:string|null;question:{goal:string;proposedAction:string;questions:{id:string;text:string}[]}}[]; employeeName?:string; entityId?:string; id: string; title?: string | null; input: string; status: string; createdAt: number; inputRevision: number }
export interface ActivityRun { id: string; status: string; attempt: number; kind?:'initial'|'human_continue'|'retry';parentRunId?:string|null;endReason?:string|null; createdAt: number; resultInputRevision: number | null }
export interface ActivityEntry {
  id: string; runId: string; sequence: number; type: string; createdAt: number;
  text: string; textLength: number; status: string | null; inputRevision: number | null; inputStatus: string | null;
}
export interface ActivityPage {notifications?:{id:string;sourceKind:string;generationState:string;deliveryState:string;error:string|null;createdAt:number}[]; task: ActivityTask; runs: ActivityRun[]; runId: string | null; entries: ActivityEntry[]; nextAfter: number | null; deliveries: { id: string; status: string; createdAt: number }[] }
export const replyEntry = (entry: ActivityEntry) => ['reply', 'partial_result', 'final_result'].includes(entry.type);
export const activityLabel = (entry: ActivityEntry) => ({ reply: '回复片段', partial_result: '阶段回复', final_result: '最终结果', progress: '执行进展', input_receipt: '补充回执', status: '执行状态' } as Record<string, string>)[entry.type] ?? '执行记录';
