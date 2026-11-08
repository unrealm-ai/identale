import {validateNativeAttachment} from '../native-media.js';
import {WECOM_MEDIA_LIMITS} from './media-wire.js';
import {randomUUID} from 'node:crypto';
import {WSClient, WSAuthFailureError} from '@wecom/aibot-node-sdk';
import {ChannelError, type ChannelIngressSession, type ChannelSendReceipt, type SendChannelMessage} from '@dentity/application';
import type {ChannelIngressCredentials} from '../../../channel-loop/ingress-types.js';
import type {SdkBridge} from './sdk-client.js';
import {normalizeChannelIngressEvent} from './normalize.js';

/** Official 1.0.7 SDK, one instance for both directions. No durable inbound ACK API. */
export function startWeComClient(session: ChannelIngressSession, credentials: ChannelIngressCredentials, bridge: SdkBridge, factory?: (options: ConstructorParameters<typeof WSClient>[0]) => WSClient) {
  if (!credentials.botSecret) throw new Error('invalid_ingress_credentials');
  const options = {botId:session.appId,secret:credentials.botSecret,logger:{debug(){},info(){},warn(){},error(){}},maxAuthFailureAttempts:0,maxReconnectAttempts:0,maxReplyQueueSize:1};
  const client = factory ? factory(options) : new WSClient(options);
  let stopped=false, authenticated=false, takenOver=false;
  const replies=new Map<string,{reqId:string;target:string;kind:string}>();
  const busy=new Set<string>();
  const status=(state: 'connecting'|'connected'|'failed',error?:string)=>{if(!stopped)bridge.onStatus({state,changedAt:Date.now(),...(error?{error}:{})});};
  client.on('authenticated',()=>{authenticated=true;status('connected');});
  client.on('disconnected',()=>{authenticated=false;replies.clear();if(!takenOver)status('failed','ingress_disconnected');});
  client.on('event.disconnected_event',()=>{takenOver=true;authenticated=false;replies.clear();status('failed','channel_connection_taken_over');});
  client.on('error',error=>{authenticated=false;replies.clear();status('failed',error instanceof WSAuthFailureError || /^Authentication failed:/.test(error.message)?'channel_authentication_failed':'channel_transport_failed');});
  client.on('message',frame=>{
    if(stopped||!authenticated||takenOver)return;
    // Reject malformed identity/targets before preserving minimal callback headers.
    // Local parser context is NOT enterprise binding evidence. Preserve optional
    // corpid for the parent to compare with its admin_asserted directory binding.
    try {
      const reportedCorp=(frame.body?.from as {corpid?:unknown}|undefined)?.corpid;
      if(reportedCorp!==undefined&&typeof reportedCorp!=='string')return;
      const parsed=normalizeChannelIngressEvent(session,frame,{botId:session.appId,tenantId:reportedCorp??'validation-only',tenantNamespace:'corp_id'},Date.now());
      if(parsed.kind==='group_record'){
        const m=parsed.event.message;
        const clean={cmd:'aibot_msg_callback',headers:{req_id:frame.headers.req_id},body:{msgid:m.id,aibotid:session.appId,from:{userid:m.author.externalId,...(reportedCorp!==undefined?{corpid:reportedCorp}:{})},chattype:'group',chatid:m.conversation.externalId,msgtype:frame.body?.msgtype}};
        void bridge.onEvent(clean).catch(()=>status('failed','channel_ingress_persistence_failed'));return;
      }
      if(parsed.kind!=='message')return;
      const m=parsed.event.message,body=frame.body!;
      if(replies.size>=1024)replies.delete(replies.keys().next().value!);
      const previous=replies.get(m.id);
      if(previous&&(previous.target!==m.conversation.externalId||previous.kind!==m.conversationKind))return;
      if(!previous)replies.set(m.id,{reqId:frame.headers.req_id,target:m.conversation.externalId,kind:m.conversationKind!});
      // Only supported content and validated identity cross private IPC. Download capabilities stay transient in the parent asset transport, never journals/model history.
      const clean={cmd:'aibot_msg_callback',headers:{req_id:frame.headers.req_id},body:{msgid:m.id,aibotid:session.appId,from:{userid:m.author.externalId,...(reportedCorp!==undefined?{corpid:reportedCorp}:{})},chattype:m.conversationKind==='private'?'single':'group',...(m.conversationKind==='group'?{chatid:m.conversation.externalId}:{}),msgtype:body.msgtype,...Object.fromEntries(['text','image','file','mixed','voice','quote'].filter(key=>body[key]!==undefined).map(key=>[key,body[key]]))}};
      void bridge.onEvent(clean).catch(()=>{replies.delete(m.id);status('failed','channel_ingress_persistence_failed');});
    } catch { /* Invalid input cannot establish identity or a reply target. */ }
  });
  status('connecting');client.connect();
  return {
    stop(){if(stopped)return;stopped=true;authenticated=false;replies.clear();client.disconnect();},
    async send(request:SendChannelMessage):Promise<ChannelSendReceipt>{
      if(stopped||!authenticated||takenOver||!client.isConnected)throw new ChannelError('not_ready','channel_session_unavailable');
      if(request.conversation.provider!=='wecom'||request.conversation.connectionId!==session.connectionId||request.threadId||(!request.attachment&&(!request.text||Buffer.byteLength(request.text)>16_384))||!request.operationId||request.operationId.length>256)throw new ChannelError('invalid_request');
      if(request.attachment){if(request.text)throw new ChannelError('invalid_request');validateNativeAttachment(request.attachment,WECOM_MEDIA_LIMITS);}
      const ref=request.conversation;
      if(ref.conversationKind!=='private'&&ref.conversationKind!=='group')throw new ChannelError('invalid_request');
      const target=ref.conversationKind==='private'?ref.privateRecipientId:ref.externalId;
      if(!target||target.length>256||/[\x00-\x20\x7f]/.test(target)||(ref.conversationKind==='private'&&ref.externalId!==target))throw new ChannelError('invalid_request','invalid_send_target');
      const reply=request.replyToMessageId?replies.get(request.replyToMessageId):undefined;
      if(request.replyToMessageId&&(!reply||reply.target!==target||reply.kind!==ref.conversationKind))throw new ChannelError('not_ready','channel_reply_context_expired');
      const key=reply?.reqId??randomUUID();
      if(busy.has(key)||busy.size>=128)throw new ChannelError('rate_limited','channel_send_busy');
      busy.add(key);
      let dispatched=false;
      try {
        let mediaId:string|undefined;
        if(request.attachment){
          try {
            const uploaded=await client.uploadMedia(Buffer.from(request.attachment.bytes),{type:request.attachment.kind,filename:request.attachment.name});
            if(typeof uploaded.media_id!=='string'||!uploaded.media_id||uploaded.media_id.length>2048||uploaded.type!==request.attachment.kind)throw Error('invalid_upload_receipt');
            mediaId=uploaded.media_id;
          }catch{throw new ChannelError('temporarily_unavailable','channel_media_upload_failed');}
        }
        // The runner's callback requires a fresh host commit after the upload.
        await request.beforeSend?.();
        if(stopped||!authenticated||takenOver||!client.isConnected)throw new ChannelError('not_ready','channel_session_unavailable');
        if(request.replyToMessageId&&replies.get(request.replyToMessageId)!==reply)throw new ChannelError('not_ready','channel_reply_context_expired');
        request.assertSendAllowed?.();
        dispatched=true;
        const result=mediaId&&request.attachment
          ?reply?await client.replyMedia({headers:{req_id:reply.reqId}},request.attachment.kind,mediaId):await client.sendMediaMessage(target,request.attachment.kind,mediaId)
          :reply?await client.replyStream({headers:{req_id:reply.reqId}},randomUUID(),request.text,true):await client.sendMessage(target,{msgtype:'markdown',markdown:{content:request.text}});
        if(typeof result.headers?.req_id!=='string'||!result.headers.req_id)throw Error('invalid_send_receipt');
        return {status:'accepted',idempotent:false,providerRequestId:result.headers.req_id};
      } catch(error) {if(!dispatched&&error instanceof ChannelError)throw error;throw new ChannelError(dispatched?'delivery_unknown':'temporarily_unavailable',dispatched?'channel_send_outcome_unknown':'channel_send_not_dispatched');}
      finally {busy.delete(key);}
    },
  };
}
