import { DirectoryError, type DirectoryAuthorizedScope, type DirectoryIdentity, type DirectoryPort, type DirectoryProvider } from '@dentity/application';
import { DirectoryRequestError, directoryNameIsVerified,type DirectoryFieldDiagnostic } from '../adapters/directory/http.js';

export type ChannelCheckId = 'scope_inventory' | 'credentials' | 'bot_identity' | 'directory_identity' | 'directory_scope' | 'department_read' | 'user_name' | 'group_history' | 'meeting_materials';
export interface ChannelCheck {
  id: ChannelCheckId;
  required: boolean;
  supported: boolean;
  status: 'pass' | 'missing' | 'unsupported' | 'unverified';
  reason?: 'prerequisite' | 'authentication' | 'denied' | 'scope_denied' | 'timeout' | 'network' | 'parse' | 'limit' | 'empty_scope' | 'scope_not_disclosed' | 'no_sample' | 'required_field' | 'resource_required' | 'after_creation' | 'adapter_unsupported' | 'inventory_unavailable';
  httpStatus?: number;
  providerCode?: number;
  requestId?: string;
  missingScopes?: string[];
  field?:DirectoryFieldDiagnostic;
  scopeDisclosure?:{departments:boolean;users:boolean};
  scopeEvidence?: { scope: string; status: 'granted' | 'denied' | 'unverified' }[];
  scopeInventory?: { scope: string; identity: 'tenant' | 'user' | 'unknown'; status: 'granted' | 'denied' | 'unverified' }[];
  inventoryDiagnostics?:{totalRows:number;issueCount:number};
}
export interface ChannelValidation { version: 1; provider: DirectoryProvider; checkedAt: number; canContinue: boolean; checks: ChannelCheck[] }
export class ChannelValidationError extends DirectoryError {
  constructor(readonly validation: ChannelValidation, code: ConstructorParameters<typeof DirectoryError>[0] = 'unavailable') { super(code); }
}
export const validationOf = (error: unknown): ChannelValidation | undefined => error instanceof ChannelValidationError ? error.validation : undefined;
export function validationReport(provider: DirectoryProvider, checks: ChannelCheck[], now: () => number = Date.now): ChannelValidation {
  return { version: 1, provider, checkedAt: now(), canContinue: checks.filter(c => c.required).every(c => c.status === 'pass'), checks: structuredClone(checks) };
}
export function channelChecks(provider: DirectoryProvider): ChannelCheck[] {
  const required = (id: ChannelCheckId): ChannelCheck => ({ id, required: true, supported: true, status: 'unverified', reason: 'prerequisite' });
  return [required('credentials'), { ...required('bot_identity'), ...(provider !== 'feishu' ? { required: false, reason: 'after_creation' as const } : {}) },
    required('directory_identity'), required('directory_scope'), required('department_read'), required('user_name'),
    {id:'scope_inventory',required:false,supported:false,status:'unverified',reason:'inventory_unavailable'},
    ...(['group_history', 'meeting_materials'] as const).map(id => ({ id, required: false, supported: provider === 'feishu', status: provider === 'feishu' ? 'unverified' as const : 'unsupported' as const, reason: provider === 'feishu' ? 'resource_required' as const : 'adapter_unsupported' as const }))];
}
export function failedCheck(id: ChannelCheckId, error: unknown, required = true): ChannelCheck {
  const details = error instanceof DirectoryRequestError ? error.details : undefined;
  const denied = error instanceof DirectoryError && ['authentication_failed', 'authorization_denied'].includes(error.code);
  const reason: ChannelCheck['reason'] = details?.reason ?? (error instanceof DirectoryError ? ({ authentication_failed: 'authentication', authorization_denied: 'denied', invalid_response: 'parse', unavailable: 'network', unsupported: 'adapter_unsupported', limit_exceeded: 'limit' } as const)[error.code] : 'network');
  return { id, required, supported: !(error instanceof DirectoryError && error.code === 'unsupported'), status: denied ? 'missing' : error instanceof DirectoryError && error.code === 'unsupported' ? 'unsupported' : 'unverified', reason,
    ...(details?.httpStatus === undefined ? {} : { httpStatus: details.httpStatus }), ...(details?.providerCode === undefined ? {} : { providerCode: details.providerCode }),
    ...(details?.requestId ? { requestId: details.requestId } : {}), ...(details?.missingScopes?.length ? { missingScopes: details.missingScopes } : {}),...(details?.field?{field:details.field}:{}) };
}
export async function validationStep<T>(provider: DirectoryProvider, checks: ChannelCheck[], id: ChannelCheckId, action: () => Promise<T>, now?: () => number): Promise<T> {
  try { const result = await action(); checks[checks.findIndex(c => c.id === id)] = { id, required: true, supported: true, status: 'pass' }; return result; }
  catch (error) { checks[checks.findIndex(c => c.id === id)] = failedCheck(id, error); throw new ChannelValidationError(validationReport(provider, checks, now),error instanceof DirectoryError?error.code:'unavailable'); }
}
/** Bounded live reads. No organization snapshot, resource guessing, messages or persistence. */
export async function validateDirectory(directory: DirectoryPort, provider: DirectoryProvider, checks = channelChecks(provider), now?: () => number, expected?: DirectoryIdentity): Promise<{ identity: DirectoryIdentity; scope: DirectoryAuthorizedScope; validation: ChannelValidation }> {
  const identity = await validationStep(provider, checks, 'directory_identity', async () => {
    const value = await directory.verify();
    if (expected && (value.appId !== expected.appId || value.tenantId !== expected.tenantId || value.tenantIdNamespace !== expected.tenantIdNamespace)) throw new DirectoryError('authorization_denied');
    return value;
  }, now);
  const scope = await validationStep(provider, checks, 'directory_scope', async () => {const value=await directory.getAuthorizedScope();if(!value||!Array.isArray(value.departmentIds)||!Array.isArray(value.userIds)||typeof value.entireOrganization!=='boolean'||typeof value.revision!=='string')throw new DirectoryError('invalid_response');return value;}, now);
  if(scope.disclosed)checks.find(c=>c.id==='directory_scope')!.scopeDisclosure={...scope.disclosed};
  // Directory credentials have just been authenticated by the adapter, including the expected app binding.
  if (provider === 'wecom') checks[0] = { id: 'credentials', required: true, supported: true, status: 'pass' };
  function stop(id: ChannelCheckId, reason: 'empty_scope' | 'scope_not_disclosed' | 'no_sample' | 'required_field'): never {
    checks[checks.findIndex(c => c.id === id)] = { ...checks.find(c=>c.id===id)!,id, required: true, supported: true, status: 'unverified', reason };
    throw new ChannelValidationError(validationReport(provider, checks, now));
  }
  if (!scope.entireOrganization && !scope.departmentIds.length && !scope.userIds.length) stop('directory_scope', scope.disclosed?'scope_not_disclosed':'empty_scope');
  const departments = [...scope.departmentIds];
  if (!departments.length && scope.entireOrganization) departments.push(provider === 'feishu' ? '0' : '1');
  if (departments.length) await validationStep(provider, checks, 'department_read', () => directory.getDepartment(departments[0]!), now);
  else checks[checks.findIndex(c => c.id === 'department_read')] = { id: 'department_read', required: false, supported: true, status: 'unverified', reason: 'no_sample' };
  await validationStep(provider, checks, 'user_name', async () => {
    let person = scope.userIds[0] ? await directory.getUser(scope.userIds[0]) : undefined;
    const seen = new Set<string>();
    for (let index = 0; !person && index < departments.length && seen.size < 3; index++) {
      const id = departments[index]!; if (seen.has(id)) continue; seen.add(id);
      const page = await directory.listDepartmentMembers(id); person = page.items[0];
      if (!person && seen.size < 3) {
        const children = await directory.listChildDepartments(id);
        departments.push(...children.items.map(d => d.id).filter(v => !seen.has(v)).slice(0, 3 - seen.size));
      }
    }
    if (!person) throw new DirectoryRequestError('invalid_response', { reason: 'no_sample' });
    if (!directoryNameIsVerified(person)) throw new DirectoryRequestError('invalid_response', { reason: 'required_field' });
  }, now);
  return { identity, scope, validation: validationReport(provider, checks, now) };
}
