import {ChannelError,dingtalkIdentityErrors,dingtalkIdentityFields,type ChannelIngressSession,type DingtalkIdentityDiagnostic} from '@dentity/application';
import type {ChannelIngressIdentityHints} from './normalize.js';

type FieldState=DingtalkIdentityDiagnostic['fields'][typeof dingtalkIdentityFields[number]];
const MAX_BODY_BYTES=1024*1024;
const object=(value:unknown):Record<string,unknown>|undefined=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
// Mirrors the parser's ID shape solely for observation; never used to authorize input.
function shape(value:unknown):FieldState {
 if(value===undefined||value===null||value==='')return'missing';
 return typeof value==='string'&&!!value.trim()&&value.length<=256&&!/[\x00-\x20\x7f]/.test(value)?'present':'invalid';
}
function compare(value:unknown,expected:unknown):FieldState {
 const state=shape(value);if(state!=='present')return state;
 return shape(expected)==='present'?(value===expected?'match':'mismatch'):'unknown';
}
/** Bounded, non-authoritative diagnostics. Never return an ID, body, URL or raw exception. */
export function dingtalkIdentityDiagnostic(session:ChannelIngressSession,envelope:unknown,hints:ChannelIngressIdentityHints,error:unknown):DingtalkIdentityDiagnostic|undefined {
 if(session.provider!=='dingtalk')return;
 const result:DingtalkIdentityDiagnostic={channel:'dingtalk',error:'unknown',conversationKind:'unknown',mentioned:'unknown',fields:Object.fromEntries(dingtalkIdentityFields.map(key=>[key,'unknown'])) as DingtalkIdentityDiagnostic['fields']};
 try{
  const reason=error instanceof ChannelError?error.message:undefined;
  if(typeof reason==='string'&&(dingtalkIdentityErrors as readonly string[]).includes(reason))result.error=reason as DingtalkIdentityDiagnostic['error'];
  const raw=object(envelope);if(!raw)return result;
  const headers=object(raw['headers']);result.fields.eventId=headers?shape(headers['messageId']):'unknown';
  const data=raw['data'];if(typeof data!=='string'||Buffer.byteLength(data)>MAX_BODY_BYTES)return result;
  const row=object(JSON.parse(data));if(!row)return result;
  result.conversationKind=row['conversationType']==='1'?'private':row['conversationType']==='2'?'group':'unknown';
  result.mentioned=row['isInAtList']===true?'yes':row['isInAtList']===false?'no':row['isInAtList']===undefined?'unknown':'invalid';
  result.fields={
   chatbotUserId:shape(row['chatbotUserId']),robotCode:compare(row['robotCode'],hints.robotCode),
   // An app_id hint is deliberately not a corporate identity assertion.
   chatbotCorpId:hints.tenantNamespace==='app_id'?(shape(row['chatbotCorpId'])==='present'?'unknown':shape(row['chatbotCorpId'])):compare(row['chatbotCorpId'],hints.tenantId),
   appId:compare(row['appId'],session.appId),appKey:compare(row['appKey'],session.appId),
   senderCorpId:compare(row['senderCorpId'],row['chatbotCorpId']),senderStaffId:shape(row['senderStaffId']),
   tenantNamespace:hints.tenantNamespace===undefined?'missing':['corp_id','app_id'].includes(hints.tenantNamespace)?'match':'mismatch',
   eventId:result.fields.eventId,messageId:shape(row['msgId']),conversationId:shape(row['conversationId']),
  };
 }catch{/* A diagnostic failure must preserve the original normalization failure and ACK path. */}
 return result;
}
