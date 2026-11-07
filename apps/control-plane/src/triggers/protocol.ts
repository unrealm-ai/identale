import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import type {TriggerCommand} from '@dentity/application';
export class TriggerError extends Error {constructor(readonly status:number,readonly code:string){super(code);}}
const fail=(status:number,code:string):never=>{throw new TriggerError(status,code);};
export const wellFormedUnicode=(value:string)=>!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
export const TRIGGER_BODY_LIMIT=256*1024;
export const triggerIdentifier=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(value);
export function bodyHash(body:Uint8Array){return createHash('sha256').update(body).digest('hex');}
export function webhookCanonical(triggerId:string,timestamp:string,hash:string){if(!triggerIdentifier(triggerId)||!/^(0|[1-9]\d{0,15})$/.test(timestamp)||! /^[a-f0-9]{64}$/.test(hash))return fail(401,'trigger_authentication_failed');return ['v1','POST','/api/triggers/webhook/'+triggerId,timestamp,hash].join('\n');}
export function verifyWebhookSignature(input:{triggerId:string;timestamp:unknown;signature:unknown;secret:string;body:Uint8Array;receivedAt:number}){
  const {timestamp,signature}=input;
  if(typeof timestamp!=='string'||!/^(0|[1-9]\d{0,15})$/.test(timestamp)||typeof signature!=='string'||!/^[a-f0-9]{64}$/.test(signature)||!Number.isSafeInteger(Number(timestamp))||!Number.isSafeInteger(input.receivedAt)||Math.abs(input.receivedAt-Number(timestamp))>300000)return fail(401,'trigger_authentication_failed');
  const hash=bodyHash(input.body),canonical=webhookCanonical(input.triggerId,timestamp,hash),expected=createHmac('sha256',Buffer.from(input.secret,'utf8')).update(canonical,'utf8').digest();
  if(!timingSafeEqual(expected,Buffer.from(signature,'hex')))return fail(401,'trigger_authentication_failed');
  return hash;
}
export function parseTriggerCommand(body:Uint8Array):TriggerCommand {
  if(!body.byteLength||body.byteLength>TRIGGER_BODY_LIMIT)return fail(400,'invalid_trigger_body');
  let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));}catch{return fail(400,'invalid_trigger_json');}
  if(!value||typeof value!=='object'||Array.isArray(value))return fail(400,'invalid_trigger_command');
  const b=value as Record<string,unknown>;
  if(Object.values(b).some(v=>typeof v==='string'&&!wellFormedUnicode(v)))return fail(400,'invalid_trigger_command');
  if(Object.keys(b).some(k=>!['version','eventId','action','description','businessKey','taskId','entityId'].includes(k))||b.version!==1||(typeof b.eventId!=='string'||!b.eventId.trim()||b.eventId.length>160||/[\x00-\x1f\x7f]/.test(b.eventId))||!['create_task','supplement_task','cancel_task'].includes(String(b.action)))return fail(400,'invalid_trigger_command');
  if(b.entityId!==undefined&&!triggerIdentifier(b.entityId)||b.taskId!==undefined&&!triggerIdentifier(b.taskId)||b.businessKey!==undefined&&(typeof b.businessKey!=='string'||b.businessKey.length>1024)||b.description!==undefined&&(typeof b.description!=='string'||b.description.length>8000))return fail(400,'invalid_trigger_command');
  if(b.action==='create_task'&&b.taskId!==undefined||b.action!=='create_task'&&b.taskId===undefined||b.action!=='cancel_task'&&(typeof b.description!=='string'||!b.description.trim()))return fail(400,'invalid_trigger_command');
  return b as unknown as TriggerCommand;
}
/** GitHub signs the raw body, not this platform's timestamp/path canonical. */
export function verifyGithubSignature(secret:string,body:Uint8Array,signature:unknown){if(typeof signature!=='string'||!/^sha256=[a-f0-9]{64}$/.test(signature))return fail(401,'trigger_authentication_failed');const expected=createHmac('sha256',Buffer.from(secret,'utf8')).update(body).digest();if(!timingSafeEqual(expected,Buffer.from(signature.slice(7),'hex')))return fail(401,'trigger_authentication_failed');return bodyHash(body);}
