import type { ToolSchema } from './types.js';
const forbidden = new Set(['workspaceid', 'entityid', 'requester', 'requesterid', 'userid', 'grant', 'grantref', 'authorizationcontext', 'authorizationref', 'sourcechannel', 'sourceeventref', 'trigger', 'triggerid', 'triggerbindingid', 'invocationid', 'sessionid', 'configrevision', 'feedbacktarget', 'destination', 'recipient', 'channelid', 'tenantid', 'installationid', '__proto__', 'constructor', 'prototype']);
const normalized = (key: string) => key.toLowerCase().replace(/[^a-z0-9_]/g, '').replace(/_/g, '');
export function containsReserved(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => forbidden.has(normalized(key)) || containsReserved(child));
}
export function validateSchema(schema: ToolSchema, depth = 0): void {
  if (!schema || depth > 8 || !['object','string','number','integer','boolean','array','null'].includes(schema.type)) throw new Error('Invalid tool schema');
  if (Object.keys(schema).some(key => !['type','description','properties','required','additionalProperties','items','enum','minLength','maxLength','minimum','maximum','maxItems'].includes(key))) throw new Error('Unsupported schema keyword');
  if (schema.type === 'object') {
    if (schema.additionalProperties !== false || !schema.properties) throw new Error('Tool objects must explicitly deny additional properties');
    for (const [key, child] of Object.entries(schema.properties)) {
      if (forbidden.has(normalized(key))) throw new Error('Reserved identity field in tool schema');
      validateSchema(child, depth + 1);
    }
    if (schema.required?.some(key => !Object.hasOwn(schema.properties!, key))) throw new Error('Unknown required property');
  }
  if (schema.type === 'array') { if (!schema.items) throw new Error('Array items required'); validateSchema(schema.items, depth + 1); }
}
export function matches(schema: ToolSchema, value: unknown): boolean {
  if (schema.enum && !schema.enum.includes(value as never)) return false;
  switch (schema.type) {
    case 'null': return value === null;
    case 'boolean': return typeof value === 'boolean';
    case 'string': return typeof value === 'string' && value.length >= (schema.minLength ?? 0) && value.length <= (schema.maxLength ?? Infinity);
    case 'number': case 'integer': return typeof value === 'number' && Number.isFinite(value) && (schema.type !== 'integer' || Number.isInteger(value)) && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity);
    case 'array': return Array.isArray(value) && value.length <= (schema.maxItems ?? 1000) && value.every(item => matches(schema.items!, item));
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value)
      && (schema.required ?? []).every(key => Object.hasOwn(value, key))
      && Object.entries(value).every(([key, child]) => Object.hasOwn(schema.properties!, key) && matches(schema.properties![key]!, child));
  }
}
