import type { ChannelCheck } from './channel-validation';
import './channel-validation-state.css';

export type ValidationTone = 'success' | 'error' | 'warning' | 'idle';
export const tagTone = (tone: ValidationTone) => tone === 'idle' ? 'default' as const : tone;
export function checkTone(check?: ChannelCheck): ValidationTone {
  if (!check) return 'idle';
  if (check.status === 'pass' && check.supported) return 'success';
  return check.required ? 'error' : 'warning';
}
export const checkCategory = (check: ChannelCheck): string => check.required ? '必需' : check.id === 'scope_inventory' ? '参考' : '可选';
export function checkLabel(check: ChannelCheck): string {
  if (checkTone(check) === 'success') return check.id === 'scope_inventory' ? '清单已查询' : ['department_read', 'user_name', 'group_history', 'meeting_materials'].includes(check.id) ? '读取已验证' : '通过';
  if (check.inventoryDiagnostics?.issueCount) return '部分未核验';
  if (check.reason === 'scope_denied') return '权限未授权，未读取资源';
  if (check.status === 'unsupported') return '当前不支持';
  if (check.status === 'missing') return check.reason === 'authentication' ? '认证失败' : '明确拒绝';
  return check.required ? '未能确认通过' : '未验证';
}

export function scopeState(checks: ChannelCheck[], code: string): 'granted' | 'denied' | 'unverified' {
  const matching = checks.find(check => check.id === 'scope_inventory')?.scopeInventory?.filter(scope => scope.scope === code && scope.identity === 'tenant') ?? [];
  const explicit = checks.flatMap(check => check.scopeEvidence ?? []).filter(scope => scope.scope === code);
  const rows = matching.length ? matching : explicit;
  if (rows.length) return rows.every(row => row.status === rows[0]!.status) ? rows[0]!.status : 'unverified';
  return checks.some(check => check.missingScopes?.includes(code)) ? 'denied' : 'unverified';
}
/** One required permission group is OR; groups are combined only for the stated feature. */
export function permissionState(checks: ChannelCheck[], groups: readonly (readonly string[])[]): 'pass' | 'missing' | 'unverified' {
  const states = groups.map(group => {
    const values = group.map(code => scopeState(checks, code));
    return values.includes('granted') ? 'pass' : values.every(value => value === 'denied') ? 'missing' : 'unverified';
  });
  return states.every(state => state === 'pass') ? 'pass' : states.includes('missing') ? 'missing' : 'unverified';
}
