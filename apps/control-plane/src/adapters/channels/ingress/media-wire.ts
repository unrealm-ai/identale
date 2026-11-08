import {createHash} from 'node:crypto';
import {ChannelError,type SendChannelMessage} from '@dentity/application';
import {validateNativeAttachment} from '../native-media.js';
/** Identale conservative byte budgets, not the SDK's 50MiB chunking ceiling. */
export const WECOM_MEDIA_LIMITS={image:2_000_000,file:20_000_000};
export type SendWire=Omit<SendChannelMessage,'attachment'|'beforeSend'|'assertSendAllowed'|'originatingTaskScope'> & {attachment?:{kind:'image'|'file';name:string;mediaType:string;base64:string}};
export const wireHash=(wire:SendWire)=>createHash('sha256').update(JSON.stringify(wire)).digest('hex');
export function encodeSend(request:SendChannelMessage):SendWire{
 const wire:SendWire={conversation:{...request.conversation},text:request.text,operationId:request.operationId,...(request.replyToMessageId?{replyToMessageId:request.replyToMessageId}:{}),...(request.threadId?{threadId:request.threadId}:{})};
 if(request.attachment){validateNativeAttachment(request.attachment,WECOM_MEDIA_LIMITS);const {kind,name,mediaType,bytes}=request.attachment;wire.attachment={kind,name,mediaType,base64:Buffer.from(bytes).toString('base64')};}
 return wire;
}
export function decodeSend(wire:SendWire):SendChannelMessage{
 const {attachment,...request}=wire;
 if(!attachment)return request;
 if(typeof attachment.base64!=='string'||attachment.base64.length>Math.ceil(WECOM_MEDIA_LIMITS.file/3)*4||!attachment.base64.length||attachment.base64.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(attachment.base64))throw new ChannelError('invalid_request','invalid_media_wire');
 const bytes=Buffer.from(attachment.base64,'base64');
 if(bytes.toString('base64')!==attachment.base64)throw new ChannelError('invalid_request','invalid_media_wire');
 const media={kind:attachment.kind,name:attachment.name,mediaType:attachment.mediaType,bytes};validateNativeAttachment(media,WECOM_MEDIA_LIMITS);
 return {...request,attachment:media};
}
