import { TaskError, taskBody, taskString } from './service.js';

/** Public task facts only. Native model messages and execution journals are excluded. */
export interface TaskActivityRun { id: string; status: string; attempt: number; kind?:'initial'|'human_continue'|'retry';parentRunId?:string|null;endReason?:string|null; createdAt: number; resultInputRevision: number | null }
export interface TaskActivityEntry {
  id: string; runId: string; sequence: number; type: string; createdAt: number;
  text: string; textLength: number; status: string | null; inputRevision: number | null; inputStatus: string | null;
}
export interface TaskNotificationView{id:string;sourceKind:string;generationState:string;deliveryState:string;error:string|null;createdAt:number}
export interface TaskActivityReadPort {
  activityNotifications?(taskId:string):TaskNotificationView[];
  activityRuns(taskId: string): TaskActivityRun[];
  activityEntries(taskId: string, runId: string, after: number, limit: number): TaskActivityEntry[];
  activityContent(taskId: string, runId: string, entryId: string, offset: number): { text: string; nextOffset: number | null } | undefined;
  activityDeliveries(taskId: string): { id: string; status: string; createdAt: number }[];
}
export function readTaskActivity(repository: TaskActivityReadPort, taskId: string, value: unknown = {}) {
  const query = taskBody(value, ['runId', 'after', 'entryId', 'offset']);
  const runs = repository.activityRuns(taskId);
  const runId = query['runId'] === undefined ? runs[0]?.id : taskString(query['runId'], 160);
  if (runId && !runs.some(run => run.id === runId)) throw new TaskError(404, 'run_not_found');
  const integer = (key: string) => {
    const v = query[key] ?? '0';
    if (typeof v !== 'string' || !/^\d+$/.test(v) || !Number.isSafeInteger(Number(v))) throw new TaskError(400, 'invalid_task_query');
    return Number(v);
  };
  if (query['entryId'] !== undefined) {
    if (!runId) throw new TaskError(404, 'run_not_found');
    const content = repository.activityContent(taskId, runId, taskString(query['entryId'], 180), integer('offset'));
    if (!content) throw new TaskError(404, 'task_entry_not_found');
    return content;
  }
  const after = integer('after');
  const rows = runId ? repository.activityEntries(taskId, runId, after, 51) : [];
  const entries = rows.slice(0, 50);
  return { runs, runId: runId ?? null, entries, nextAfter: rows.length > 50 ? entries.at(-1)!.sequence : null, notifications:repository.activityNotifications?.(taskId)??[], deliveries: repository.activityDeliveries(taskId) };
}
