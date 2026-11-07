import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {TaskError,type MessageLoopBinding} from '@dentity/application';
export interface NotificationTarget {
 kind:'group';provider:'feishu'|'dingtalk'|'wecom';connectionId:string;appId:string;tenantId:string;bindingVersion:string;
 id:string;label:string;
}
export type SelectedNotificationTarget=NotificationTarget&{proof:string};
export const targetKey=(t:NotificationTarget)=>JSON.stringify([t.provider,t.tenantId,t.appId,t.kind,t.id]);
const fail=():never=>{throw new TaskError(400,'invalid_notification_target');};
/** A signed selector is configuration evidence, never a channel credential or a read grant. */
export class NotificationTargetCodec {
 private readonly key:Buffer;
 constructor(key?:string){this.key=key?Buffer.from(key):randomBytes(32);}
 private mac(value:string){return createHmac('sha256',this.key).update('notification-target-v1\0'+value).digest();}
 issue(workspaceId:string,entityId:string,target:NotificationTarget):SelectedNotificationTarget{
  const payload=Buffer.from(JSON.stringify({version:1,workspaceId,entityId,target})).toString('base64url');
  return{...target,proof:payload+'.'+this.mac(payload).toString('base64url')};
 }
 read(workspaceId:string,entityId:string,value:unknown):SelectedNotificationTarget{
  try{
   const proof=(value as{proof?:unknown})?.proof;if(typeof proof!=='string'||proof.length>12000)return fail();
   const [payload,signature,...extra]=proof.split('.');if(!payload||!signature||extra.length)return fail();
   const supplied=Buffer.from(signature,'base64url'),expected=this.mac(payload);if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return fail();
   const data=JSON.parse(Buffer.from(payload,'base64url').toString('utf8')) as{version:number;workspaceId:string;entityId:string;target:NotificationTarget};
   const t=data.target;if(data.version!==1||data.workspaceId!==workspaceId||data.entityId!==entityId||!t||t.kind!=='group'||!['feishu','dingtalk','wecom'].includes(t.provider))return fail();
   for(const x of [t.connectionId,t.appId,t.tenantId,t.bindingVersion,t.id])if(typeof x!=='string'||!x||x.length>2048||/[\x00-\x1f]/.test(x))return fail();
   if(typeof t.label!=='string'||t.label.length>200)return fail();
   return{...t,proof};
  }catch{return fail();}
 }
 cursor(scope:string,value:string){const payload=Buffer.from(JSON.stringify({scope,value})).toString('base64url');return payload+'.'+this.mac(payload).toString('base64url');}
 readCursor(scope:string,value:unknown){try{if(typeof value!=='string'||value.length>16000)throw Error();const[p,s,...extra]=value.split('.');if(!p||!s||extra.length)throw Error();const sig=Buffer.from(s,'base64url'),mac=this.mac(p);if(sig.length!==mac.length||!timingSafeEqual(sig,mac))throw Error();const data=JSON.parse(Buffer.from(p,'base64url').toString());if(data.scope!==scope||typeof data.value!=='string')throw Error();return data.value as string;}catch{throw new TaskError(400,'invalid_group_cursor');}}
 list(w:string,e:string,value:unknown):SelectedNotificationTarget[]{
  if(value===undefined||value===null)return[];if(!Array.isArray(value)||value.length>50)return fail();
  return [...new Map(value.map(v=>{const t=this.read(w,e,v);return[targetKey(t),t] as const;})).values()];
 }
}
export function targetMatches(t:NotificationTarget,b:MessageLoopBinding){return b.enabled&&b.connectionId===t.connectionId&&b.provider===t.provider&&b.appId===t.appId&&b.connection.tenantId===t.tenantId&&b.bindingVersion===t.bindingVersion;}
export function messagePreview(value:string,type?:string){
 const text=type&&type!=='text'?'[非文本消息]':value.replace(/(?:Bearer\s+|(?:api[_-]?key|password|secret|token)\s*[:=]\s*)[^\s,;]+/gi,'[已隐藏]').replace(/(?:file:\/\/\S+|(?:\/(?:Users|home|private|tmp|var)\/|[A-Z]:\\)[^\s<>"']+)/g,'[文件引用]').replace(/[\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim();
 const parts=[...new Intl.Segmenter('zh-CN',{granularity:'grapheme'}).segment(text)].map(x=>x.segment);
 return parts.length>80?parts.slice(0,80).join('')+'…':text||'@了数字员工';
}
