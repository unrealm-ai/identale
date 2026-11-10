/** Protocol reference: DingTalk-Real-AI/dingtalk-openclaw-connector device-auth.ts.
 * Independent implementation; fixed official endpoint, no DWS user authorization. */
import {EmployeeChannelError} from './service.js';
const fail = (code = 'dingtalk_registration_invalid_response'): never => { throw new EmployeeChannelError(502, code); };
const field = (value: unknown, max = 8192): string => typeof value === 'string' && value.trim() && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : fail();
const duration = (value: unknown, fallback: number, maximum: number) => value === undefined ? fallback : typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(maximum, Math.ceil(value)) : fail();
export function registrationVerificationUrl(value: unknown): string {
 const text = field(value, 4096);
 let url: URL; try { url = new URL(text); } catch { return fail(); }
 if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !(url.hostname === 'dingtalk.com' || url.hostname.endsWith('.dingtalk.com'))) return fail();
 return url.href;
}
type Action = 'init'|'begin'|'poll';
type Shape = 'missing'|'null'|'array'|'string'|'number'|'boolean'|'object'|'other';
const shape = (value: unknown): Shape => value === undefined ? 'missing' : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'string' ? 'string' : typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : typeof value === 'object' ? 'object' : 'other';
const normalizedStatus = (value: unknown) => typeof value === 'string' ? value.trim().toUpperCase() : '';
const knownStatus = (value: unknown) => {
 const status = normalizedStatus(value);
 return status === 'WAITING' || status === 'SUCCESS' || status === 'FAIL' || status === 'EXPIRED' ? status : 'UNKNOWN';
};
type DiagnosticReason = 'missing_body'|'body_too_large'|'invalid_json'|'non_object_body'|'invalid_nonce'|'invalid_begin_fields'|'unknown_status'|'invalid_success_credentials';
type Diagnostic = {action:Action;reason:DiagnosticReason;bodyShape:Shape;status:'WAITING'|'SUCCESS'|'FAIL'|'EXPIRED'|'UNKNOWN';fields:Record<string,Shape>};
export class DingTalkRegistrationAdapter {
 constructor(private readonly transport: typeof fetch = fetch, private readonly diagnostic:(event:Diagnostic)=>void = event=>console.warn('[dingtalk-registration-protocol]',JSON.stringify(event))) {}
 // Values, unknown keys, provider error text, URLs and credential lengths never
 // enter this diagnostic. Only allowlisted field types and known status enums do.
 private report(action:Action, reason:DiagnosticReason, data?:unknown):void {
  const object = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string,unknown> : {};
  const fields = Object.fromEntries(['errcode','status','nonce','device_code','verification_uri_complete','expires_in','interval','client_id','client_secret'].map(key=>[key,shape(object[key])]));
  try { this.diagnostic({action,reason,bodyShape:shape(data),status:knownStatus(object['status']),fields}); } catch { /* Diagnostics cannot change protocol outcomes. */ }
 }
 private invalid(action:Action, reason:DiagnosticReason, data?:unknown):never {this.report(action,reason,data);return fail();}
 private async post(action: 'init'|'begin'|'poll', body: Record<string,string>, signal: AbortSignal): Promise<Record<string,unknown>> {
  try {
   const response = await this.transport(`https://oapi.dingtalk.com/app/registration/${action}`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(10000)])});
   if (!response.ok) return fail(response.status === 408 || response.status === 429 || response.status >= 500 ? 'dingtalk_registration_unavailable' : 'dingtalk_registration_rejected');
   const reader = response.body?.getReader(); if (!reader) return this.invalid(action,'missing_body');
   let size = 0; const parts: Uint8Array[] = [];
   try { while (true) { const {done,value} = await reader.read(); if (done) break; size += value.byteLength; if (size > 32768) return this.invalid(action,'body_too_large'); parts.push(value); } }
   finally { await reader.cancel().catch(()=>{}); }
   let data: unknown;
   try { data = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { return this.invalid(action,'invalid_json'); }
   if (!data || typeof data !== 'object' || Array.isArray(data)) return this.invalid(action,'non_object_body',data);
   const result = data as Record<string,unknown>;
   if (result['errcode'] !== 0) return fail('dingtalk_registration_rejected');
   return result;
  } catch (error) { if (error instanceof EmployeeChannelError) throw error; return fail('dingtalk_registration_unavailable'); }
 }
 async begin(source: string, signal: AbortSignal) {
  const init = await this.post('init',{source},signal);
  let nonce:string;try { nonce=field(init['nonce']); } catch { return this.invalid('init','invalid_nonce',init); }
  if (signal.aborted) return fail('dingtalk_registration_cancelled');
  const result = await this.post('begin',{nonce},signal);
  try {
  const deviceCode = field(result['device_code']);
  const verificationUrl = registrationVerificationUrl(result['verification_uri_complete']);
  // Neither credential redemption value belongs in a browser link. Check the
  // canonical URL and bounded percent-decoded forms, including nested parameters.
  let decoded=verificationUrl;
  for(let round=0;round<5;round++){
   if([nonce,deviceCode].some(secret=>decoded.includes(secret)||decoded.includes(encodeURIComponent(secret))))return fail();
   try{const next=decodeURIComponent(decoded);if(next===decoded)break;decoded=next;}catch{return fail();}
  }
  return {deviceCode,verificationUrl,expiresMs:duration(result['expires_in'],600,600)*1000,intervalMs:Math.max(1000,duration(result['interval'],3,60)*1000)};
  } catch { return this.invalid('begin','invalid_begin_fields',result); }
 }
 async poll(deviceCode: string, signal: AbortSignal) {
  const result = await this.post('poll',{device_code:deviceCode},signal);
  // Match the official connector's casing/whitespace normalization without
  // coercing arbitrary objects into protocol strings.
  const status = normalizedStatus(result['status']);
  if (status === 'WAITING' || status === 'FAIL' || status === 'EXPIRED') return {status};
  if (status !== 'SUCCESS') {
   if (typeof result['status'] !== 'string' && result['status'] !== undefined) return this.invalid('poll','unknown_status',result);
   this.report('poll','unknown_status',result);return {status:'UNKNOWN' as const};
  }
  try { return {status:'SUCCESS' as const,clientId:field(result['client_id'],256),clientSecret:field(result['client_secret'])}; }
  catch { return this.invalid('poll','invalid_success_credentials',result); }
 }
}
