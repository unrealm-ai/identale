import type { ExecutionRecordContent, ExecutionRecordPage, ExecutionRecordQuery, ExecutionRecordReadPayload, ExecutionRecordViewer, RuntimeOutcome, RuntimeRequest } from '@dentity/contracts';
import type { RuntimeAuthorizationContext } from '@dentity/domain';
import { TaskError, taskBody, taskString } from './service.js';
export type { ExecutionRecordViewer, ExecutionRecordQuery, ExecutionRecordPage, ExecutionRecordContent } from '@dentity/contracts';
/** Read-only execution projections. No runtime invocation or arbitrary file address. */
export interface TaskExecutionRecordsReadPort {
  readRecords(taskId: string, runId: string, viewer: ExecutionRecordViewer, query: ExecutionRecordQuery): Promise<ExecutionRecordPage | ExecutionRecordContent>;
}
export interface ExecutionRecordsReadHostPort {
  readExecutionRecords(request: RuntimeRequest<ExecutionRecordReadPayload, RuntimeAuthorizationContext>): Promise<RuntimeOutcome<ExecutionRecordPage | ExecutionRecordContent>>;
}
export function executionRecordQuery(value: unknown): ExecutionRecordQuery {
  const q = taskBody(value, ['runId', 'cursor', 'entryId', 'offset']);
  const result: ExecutionRecordQuery = {};
  for (const key of ['cursor', 'entryId'] as const) if (q[key] !== undefined) result[key] = taskString(q[key], 6000);
  if (q['offset'] !== undefined) {
    if (typeof q['offset'] !== 'string' || !/^\d+$/.test(q['offset']) || !Number.isSafeInteger(Number(q['offset']))) throw new TaskError(400, 'invalid_task_query');
    result.offset = Number(q['offset']);
  }
  if (result.entryId && result.cursor || result.offset !== undefined && !result.entryId) throw new TaskError(400, 'invalid_task_query');
  return result;
}
export const unavailableExecutionRecords = (): ExecutionRecordPage => ({ status: 'unavailable', reason: 'execution_records_unavailable', records: [], nextCursor: null, tailCursor: null });
