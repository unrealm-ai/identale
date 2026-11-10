import type{WeComHistoryReader}from'./wecom-history-reader.js';
import {validateNativeAttachment} from './native-media.js';
import {WECOM_MEDIA_LIMITS} from './ingress/media-wire.js';
import {ChannelError,assertChannelResource,type ChannelConnection,type ChannelResourceRef,type ChannelConversation,type ChannelQuery,type ChannelPage,type ChannelMessage,type SendChannelMessage,type ChannelSendReceipt,type ConversationCapabilities,type ConversationPort} from '@dentity/application';
export function wecomMediaCapabilities():NonNullable<ConversationCapabilities['media']>{const yes={supported:true,availability:'available' as const};return {inbound:{private:{image:yes,file:yes},group:{image:yes,file:yes}},outbound:{private:{image:yes,file:yes},group:{image:yes,file:yes}}};}
/** No extra SDK instance: sending is delegated to the currently owned receive session. */
export class WeComConversationAdapter implements ConversationPort {
  readonly connection:ChannelConnection;
  constructor(connection:ChannelConnection,private readonly session:{send:(request:SendChannelMessage)=>Promise<ChannelSendReceipt>},private readonly history?:WeComHistoryReader) {
    if(connection.provider!=='wecom'||connection.identity.kind!=='bot')throw new ChannelError('invalid_request');
    this.connection=Object.freeze({...connection,identity:Object.freeze({...connection.identity})});
  }
  private resource(ref:ChannelResourceRef){assertChannelResource(this.connection,ref);if(ref.kind!=='conversation')throw new ChannelError('unsupported');}
  async inspectCapabilities(ref?:ChannelResourceRef):Promise<ConversationCapabilities>{
    if(ref)this.resource(ref);const yes={supported:true,availability:'available' as const},no={supported:false,availability:'unsupported' as const};
    return {media:wecomMediaCapabilities(),privateMessageEvents:yes,directedBotMessageEvents:yes,mentionEvents:no,ordinaryMessageEvents:no,historyRead:this.history?{supported:true,availability:'unknown'}:no,proactiveSend:yes,replyToMessage:yes,threadRead:no};
  }
  async getConversation(ref:ChannelResourceRef):Promise<ChannelConversation>{this.resource(ref);throw new ChannelError('unsupported','wecom_conversation_lookup_unsupported');}
  async listMessages(ref:ChannelResourceRef,_query:ChannelQuery):Promise<ChannelPage<ChannelMessage>>{this.resource(ref);if(!this.history)throw new ChannelError('unsupported','wecom_history_unsupported');return this.history.listMessages(ref,_query);}
  async listJoinedGroups(query:{cursor?:string}){if(!this.history)throw new ChannelError('unsupported','wecom_history_unsupported');return this.history.listJoinedGroups(query);}
  async sendMessage(request:SendChannelMessage):Promise<ChannelSendReceipt>{
    if(request.attachment){if(request.text)throw new ChannelError('invalid_request');validateNativeAttachment(request.attachment,WECOM_MEDIA_LIMITS);}
    this.resource(request.conversation);
    if(request.threadId)throw new ChannelError('unsupported','wecom_threads_unsupported');
    if(!request.operationId||request.operationId.length>256||(!request.attachment&&(!request.text||Buffer.byteLength(request.text)>16_384)))throw new ChannelError('invalid_request');
    const ref=request.conversation;
    if(ref.conversationKind==='private'){
      const recipient=ref.privateRecipientId;
      if(!recipient||recipient.length>256||/[\x00-\x20\x7f]/.test(recipient)||ref.privateRecipientNamespace!==undefined&&ref.privateRecipientNamespace!=='user_id')throw new ChannelError('invalid_request','invalid_send_target');
      // Human-confirmation outbox rows use a stable logical conversation ID before
      // any incoming private chat exists. Only this exact user_id route can be
      // translated to the official userid target; the SDK keeps its strict check.
      if(ref.externalId!==recipient){
        if(ref.privateRecipientNamespace!=='user_id'||ref.externalId!==`human-user:user_id:${recipient}`||request.replyToMessageId)throw new ChannelError('invalid_request','invalid_send_target');
        return this.session.send({...request,conversation:{...ref,externalId:recipient}});
      }
    }else if(ref.conversationKind!=='group'||ref.privateRecipientId||ref.privateRecipientNamespace)throw new ChannelError('invalid_request','invalid_send_target');
    return this.session.send(request);
  }
}
