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
export class DingTalkRegistrationAdapter {
 constructor(private readonly transport: typeof fetch = fetch) {}
 private async post(action: 'init'|'begin'|'poll', body: Record<string,string>, signal: AbortSignal): Promise<Record<string,unknown>> {
  try {
   const response = await this.transport(`https://oapi.dingtalk.com/app/registration/${action}`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(10000)])});
   if (!response.ok) return fail('dingtalk_registration_unavailable');
   const reader = response.body?.getReader(); if (!reader) return fail();
   let size = 0; const parts: Uint8Array[] = [];
   try { while (true) { const {done,value} = await reader.read(); if (done) break; size += value.byteLength; if (size > 32768) return fail(); parts.push(value); } }
   finally { await reader.cancel().catch(()=>{}); }
   const data: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'));
   if (!data || typeof data !== 'object' || Array.isArray(data)) return fail();
   const result = data as Record<string,unknown>;
   if (result['errcode'] !== 0) return fail('dingtalk_registration_rejected');
   return result;
  } catch (error) { if (error instanceof EmployeeChannelError) throw error; return fail('dingtalk_registration_unavailable'); }
 }
 async begin(source: string, signal: AbortSignal) {
  const init = await this.post('init',{source},signal), nonce = field(init['nonce']);
  if (signal.aborted) return fail('dingtalk_registration_cancelled');
  const result = await this.post('begin',{nonce},signal), deviceCode = field(result['device_code']);
  const verificationUrl = registrationVerificationUrl(result['verification_uri_complete']);
  // Neither credential redemption value belongs in a browser link. Check the
  // canonical URL and bounded percent-decoded forms, including nested parameters.
  let decoded=verificationUrl;
  for(let round=0;round<5;round++){
   if([nonce,deviceCode].some(secret=>decoded.includes(secret)||decoded.includes(encodeURIComponent(secret))))return fail();
   try{const next=decodeURIComponent(decoded);if(next===decoded)break;decoded=next;}catch{return fail();}
  }
  return {deviceCode,verificationUrl,expiresMs:duration(result['expires_in'],600,600)*1000,intervalMs:Math.max(1000,duration(result['interval'],3,60)*1000)};
 }
 async poll(deviceCode: string, signal: AbortSignal) {
  const result = await this.post('poll',{device_code:deviceCode},signal);
  const status = result['status'];
  if (status === 'WAITING' || status === 'FAIL' || status === 'EXPIRED') return {status};
  if (status !== 'SUCCESS') return fail();
  return {status:'SUCCESS' as const,clientId:field(result['client_id'],256),clientSecret:field(result['client_secret'])};
 }
}
