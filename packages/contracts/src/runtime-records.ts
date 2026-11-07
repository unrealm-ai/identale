import type { ExecutionRef } from './runtime-execution.js';
export interface ExecutionRecordQuery { cursor?: string; entryId?: string; offset?: number }
export type ExecutionRecordViewer = { userId: string; workspaceId: string } & ({ kind: 'admin' } | { kind: 'conversation'; entityId: string; conversationId: string });
export interface PublicExecutionRecord {
  id: string; runId: string; type: 'reply' | 'tool_call' | 'tool_result'; createdAt: number;
  text: string; textLength: number; toolName?: string; toolCallId?: string; isError?: boolean; restricted?: boolean;
}
export interface ExecutionRecordPage {
  status: 'available' | 'unavailable' | 'changed'; reason?: string; records: PublicExecutionRecord[];
  nextCursor: string | null; tailCursor: string | null;
}
export interface ExecutionRecordContent { text: string; nextOffset: number | null; unavailableReason?: 'restricted_context' }
export interface ExecutionRecordReadPayload { execution: ExecutionRef; query: ExecutionRecordQuery; viewer: ExecutionRecordViewer }
