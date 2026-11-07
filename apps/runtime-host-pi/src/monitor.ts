import type { ExecutionState } from '@dentity/contracts';
import { relative, sep } from 'node:path';
import { nativeRecordFile } from './raw-records.js';

/** Operational metadata only: neither these locators nor the monitor token grant record-content access. */
export interface PiMonitorStatus {
  service: 'runtime-host-pi'; runtimeId: string; hostId: string;
  counts: { sessions: number; activeSessions: number; executions: number; activeExecutions: number; unknownExecutions: number };
}
export interface PiMonitorExecution {
  service: 'runtime-host-pi'; runtimeId: string; hostId: string;
  workspaceId: string; entityId: string; executionId: string; sessionId: string; status: ExecutionState;
  eventCursor?:number;lastEventRead?:{at:string;cursor:number;returnedThrough:number;count:number};modelLifecycle?:import('./model-diagnostics.js').ModelFailureDiagnostic[];
  modelDiagnostics?:import('./model-diagnostics.js').ModelFailureDiagnostic[];
  records: { ownerService: 'runtime-host-pi'; storageId: 'pi-session-records'; format: 'pi-session-jsonl'; availability: 'available' | 'unavailable'; relativePath?: string; byteLength?: number };
}
export const isActiveExecution = (status: ExecutionState): boolean => !['succeeded', 'failed', 'canceled', 'unknown','needs_human'].includes(status);
export function monitorRecordLocator(directory: string, opaqueHandle: string | undefined): PiMonitorExecution['records'] {
  const base: PiMonitorExecution['records'] = { ownerService: 'runtime-host-pi', storageId: 'pi-session-records', format: 'pi-session-jsonl', availability: 'unavailable' };
  if (!opaqueHandle) return base;
  try {
    // Validate the host-owned pointer and stat the file. Do not read or hash its contents.
    const record = nativeRecordFile(directory, opaqueHandle);
    if (!record) return base;
    const path = relative(directory, record.file);
    if (path.startsWith(`..${sep}`) || path === '..') return base;
    return { ...base, availability: 'available', relativePath: path.split(sep).join('/'), byteLength: record.stat.size };
  } catch { return base; }
}
