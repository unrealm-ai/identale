import {ChannelError,assertChannelResource,type ChannelConnection,type ChannelResourceRef,type ChannelConversation,type ChannelQuery,type ChannelPage,type ChannelMessage,type SendChannelMessage,type ChannelSendReceipt,type ConversationCapabilities,type ConversationPort} from '@dentity/application';
/** No extra SDK instance: sending is delegated to the currently owned receive session. */
export class WeComConversationAdapter implements ConversationPort {
  readonly connection:ChannelConnection;
  constructor(connection:ChannelConnection,private readonly session:{send:(request:SendChannelMessage)=>Promise<ChannelSendReceipt>}) {
    if(connection.provider!=='wecom'||connection.identity.kind!=='bot')throw new ChannelError('invalid_request');
    this.connection=Object.freeze({...connection,identity:Object.freeze({...connection.identity})});
  }
  private resource(ref:ChannelResourceRef){assertChannelResource(this.connection,ref);if(ref.kind!=='conversation')throw new ChannelError('unsupported');}
  async inspectCapabilities(ref?:ChannelResourceRef):Promise<ConversationCapabilities>{
    if(ref)this.resource(ref);const yes={supported:true,availability:'available' as const},no={supported:false,availability:'unsupported' as const};
    return {privateMessageEvents:yes,directedBotMessageEvents:yes,mentionEvents:no,ordinaryMessageEvents:no,historyRead:no,proactiveSend:yes,replyToMessage:yes,threadRead:no};
  }
  async getConversation(ref:ChannelResourceRef):Promise<ChannelConversation>{this.resource(ref);throw new ChannelError('unsupported','wecom_conversation_lookup_unsupported');}
  async listMessages(ref:ChannelResourceRef,_query:ChannelQuery):Promise<ChannelPage<ChannelMessage>>{this.resource(ref);throw new ChannelError('unsupported','wecom_history_unsupported');}
  async sendMessage(request:SendChannelMessage):Promise<ChannelSendReceipt>{
    if(request.attachment)throw new ChannelError('unsupported','native_attachments_not_implemented_for_channel');
    this.resource(request.conversation);
    if(request.threadId)throw new ChannelError('unsupported','wecom_threads_unsupported');
    if(!request.operationId||request.operationId.length>256||!request.text||Buffer.byteLength(request.text)>16_384)throw new ChannelError('invalid_request');
    return this.session.send(request);
  }
}
