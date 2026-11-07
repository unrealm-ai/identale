import { ApiError } from '../../shared/api';
import type { DirectoryProvider } from '../directory/types';

export interface ChannelCheck {
  id: 'scope_inventory' | 'credentials' | 'bot_identity' | 'directory_identity' | 'directory_scope' | 'department_read' | 'user_name' | 'group_history' | 'meeting_materials';
  required: boolean; supported: boolean; status: 'pass' | 'missing' | 'unsupported' | 'unverified';
  reason?: string; httpStatus?: number; providerCode?: number; requestId?: string; missingScopes?: string[];
  field?:{path:string;expected:string;actualType:string;itemCount?:number};
  scopeDisclosure?:{departments:boolean;users:boolean};
  scopeEvidence?: { scope: string; status: 'granted' | 'denied' | 'unverified' }[];
  scopeInventory?: { scope: string; identity: 'tenant' | 'user' | 'unknown'; status: 'granted' | 'denied' | 'unverified' }[];
  inventoryDiagnostics?:{totalRows:number;issueCount:number};
}
export interface ChannelValidation { version: 1; provider: DirectoryProvider; checkedAt: number; canContinue: boolean; checks: ChannelCheck[] }
export class ChannelValidationFailure extends ApiError {
  constructor(code: string, status: number, readonly validation?: ChannelValidation) { super(code, status); }
}
/** The general API helper deliberately exposes only a code; channel forms also need safe per-stage evidence. */
export async function channelApi<T>(path: string, signal: AbortSignal, body: unknown, method: 'POST' | 'PUT' = 'POST'): Promise<T> {
  const response = await fetch(`/api${path}`, { method, credentials: 'same-origin', cache: 'no-store', signal,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new ChannelValidationFailure(typeof result?.error === 'string' ? result.error : 'request_failed', response.status, result?.validation);
  return result as T;
}
