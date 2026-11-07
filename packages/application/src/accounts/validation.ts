export class AccountError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
export const accountFail = (status: number, code: string): never => { throw new AccountError(status, code); };
export function accountInput(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return accountFail(400, 'invalid_input');
  if (Object.keys(body).some(key => !allowed.includes(key))) return accountFail(400, 'unexpected_field');
  return body as Record<string, unknown>;
}
export function accountString(value: unknown, min = 1, max = 120): string {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) return accountFail(400, 'invalid_input');
  return value.trim();
}
export function accountUsername(value: unknown): string {
  const name = accountString(value, 3, 32).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]{2,31}$/.test(name)) return accountFail(400, 'invalid_username');
  return name;
}
export function accountPassword(value: unknown, registration = false): string {
  if (typeof value !== 'string' || [...value].length < (registration ? 6 : 1) || value.length > 1024) return accountFail(400, 'invalid_password');
  if (registration && (/^(.)\1+$/u.test(value) || ['passwordpassword', '123456789012345', '1234567890123456', 'qwertyuiopasdfgh', 'correct horse battery staple'].includes(value.toLowerCase()))) return accountFail(400, 'common_password');
  return value;
}
