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
  let stopped=false, authenticated=false, takenOver=false, transportFailed=false;
  const replies=new Map<string,{reqId:string;target:string;kind:string}>();
  // The SDK matches replies only by callback req_id. Once its outcome is
  // unknown, a late ACK must never confirm a later send on that callback.
  // Keep tombstones outside the evictable reply cache, including duplicate IDs.
  const poisonedRequests=new Set<string>(),poisonedMessages=new Set<string>();
  const clearReplies=()=>{replies.clear();poisonedRequests.clear();poisonedMessages.clear();};
  const busy=new Set<string>();
  const status=(state: 'connecting'|'connected'|'failed',error?:string)=>{if(!stopped)bridge.onStatus({state,changedAt:Date.now(),...(error?{error}:{})});};
  const poisonReply=(messageId:string,reqId:string)=>{
    if(stopped||!authenticated||takenOver)return;
    poisonedRequests.add(reqId);poisonedMessages.add(messageId);
    for(const [id,reply]of replies)if(id===messageId||reply.reqId===reqId)replies.delete(id);
    if(poisonedRequests.size>=1024||poisonedMessages.size>=1024){
      // Never evict a tombstone and revive an ambiguous ACK identity. A fresh
      // runner/connection may start normally; this instance cannot authenticate
      // or send again, even if an SDK callback arrives during disconnect.
      authenticated=false;status('failed','channel_transport_failed');stopped=true;
      clearReplies();client.disconnect();
    }
  };
  client.on('authenticated',()=>{if(stopped||takenOver||transportFailed)return;authenticated=true;status('connected');});
  client.on('disconnected',()=>{transportFailed=true;authenticated=false;clearReplies();if(!takenOver)status('failed','ingress_disconnected');});
  client.on('event.disconnected_event',()=>{takenOver=true;authenticated=false;clearReplies();status('failed','channel_connection_taken_over');});
  client.on('error',error=>{transportFailed=true;authenticated=false;clearReplies();status('failed',error instanceof WSAuthFailureError || /^Authentication failed:/.test(error.message)?'channel_authentication_failed':'channel_transport_failed');});
  client.on('message',frame=>{
    if(stopped||!authenticated||takenOver)return;
    // Reject malformed identity/targets before preserving minimal callback headers.
    // Optional corporate metadata never establishes the robot's identity scope.
    try {
      const reportedCorp=(frame.body?.from as {corpid?:unknown}|undefined)?.corpid;
      if(reportedCorp!==undefined&&typeof reportedCorp!=='string')return;
      const parsed=normalizeChannelIngressEvent(session,frame,{botId:session.appId,tenantId:session.appId,tenantNamespace:'app_id'},Date.now());
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
      if(!previous&&!poisonedMessages.has(m.id)&&!poisonedRequests.has(frame.headers.req_id))replies.set(m.id,{reqId:frame.headers.req_id,target:m.conversation.externalId,kind:m.conversationKind!});
      // Only supported content and validated identity cross private IPC. Download capabilities stay transient in the parent asset transport, never journals/model history.
      const clean={cmd:'aibot_msg_callback',headers:{req_id:frame.headers.req_id},body:{msgid:m.id,aibotid:session.appId,from:{userid:m.author.externalId,...(reportedCorp!==undefined?{corpid:reportedCorp}:{})},chattype:m.conversationKind==='private'?'single':'group',...(m.conversationKind==='group'?{chatid:m.conversation.externalId}:{}),msgtype:body.msgtype,...Object.fromEntries(['text','image','file','mixed','voice','quote'].filter(key=>body[key]!==undefined).map(key=>[key,body[key]]))}};
      void bridge.onEvent(clean).catch(()=>{replies.delete(m.id);status('failed','channel_ingress_persistence_failed');});
    } catch { /* Invalid input cannot establish identity or a reply target. */ }
  });
  status('connecting');client.connect();
  return {
    stop(){if(stopped)return;stopped=true;authenticated=false;clearReplies();client.disconnect();},
    async send(request:SendChannelMessage):Promise<ChannelSendReceipt>{
      if(stopped||!authenticated||takenOver||!client.isConnected)throw new ChannelError('not_ready','channel_session_unavailable');
      if(request.conversation.provider!=='wecom'||request.conversation.connectionId!==session.connectionId||request.threadId||(!request.attachment&&(!request.text||Buffer.byteLength(request.text)>16_384))||!request.operationId||request.operationId.length>256)throw new ChannelError('invalid_request');
      if(request.attachment){if(request.text)throw new ChannelError('invalid_request');validateNativeAttachment(request.attachment,WECOM_MEDIA_LIMITS);}
      const ref=request.conversation;
      if(ref.conversationKind!=='private'&&ref.conversationKind!=='group')throw new ChannelError('invalid_request');
      const target=ref.conversationKind==='private'?ref.privateRecipientId:ref.externalId;
      if(!target||target.length>256||/[\x00-\x20\x7f]/.test(target)||(ref.conversationKind==='private'&&ref.externalId!==target))throw new ChannelError('invalid_request','invalid_send_target');
      const reply=request.replyToMessageId?replies.get(request.replyToMessageId):undefined;
      if(request.replyToMessageId&&(!reply||poisonedMessages.has(request.replyToMessageId)||poisonedRequests.has(reply.reqId)||reply.target!==target||reply.kind!==ref.conversationKind))throw new ChannelError('invalid_request','channel_reply_context_expired');
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
        if(request.replyToMessageId&&(replies.get(request.replyToMessageId)!==reply||poisonedMessages.has(request.replyToMessageId)||poisonedRequests.has(reply!.reqId)))throw new ChannelError('invalid_request','channel_reply_context_expired');
        request.assertSendAllowed?.();
        dispatched=true;
        const result=mediaId&&request.attachment
          ?reply?await client.replyMedia({headers:{req_id:reply.reqId}},request.attachment.kind,mediaId):await client.sendMediaMessage(target,request.attachment.kind,mediaId)
          :reply?await client.replyStream({headers:{req_id:reply.reqId}},randomUUID(),request.text,true):await client.sendMessage(target,{msgtype:'markdown',markdown:{content:request.text}});
        // Locked official SDK 1.0.7 resolves only the pending req_id's business
        // ACK with errcode === 0. Upload ACKs never reach this send result.
        // This confirms provider send success, not client receipt or user read.
        const requestId=result.headers?.req_id;
        if(result.errcode!==0||typeof requestId!=='string'||!requestId||requestId.length>256||/[\x00-\x20\x7f]/.test(requestId)||(reply&&requestId!==reply.reqId))throw Error('invalid_send_receipt');
        if(stopped||!authenticated||takenOver||!client.isConnected)throw Error('stale_send_receipt');
        return {status:'sent',idempotent:false,providerRequestId:requestId};
      } catch(error) {
        if(dispatched&&reply&&request.replyToMessageId)poisonReply(request.replyToMessageId,reply.reqId);
        if(!dispatched&&error instanceof ChannelError)throw error;
        throw new ChannelError(dispatched?'delivery_unknown':'temporarily_unavailable',dispatched?'channel_send_outcome_unknown':'channel_send_not_dispatched');
      }
      finally {busy.delete(key);}
    },
  };
}
