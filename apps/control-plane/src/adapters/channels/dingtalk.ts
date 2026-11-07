import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  ChannelError, assertChannelResource, requireChannelCapability,
  type ChannelConnection, type ChannelResourceRef, type ChannelConversation, type ChannelMessage,
  type ChannelQuery, type ChannelPage, type ChannelSendReceipt, type SendChannelMessage,
  type ConversationPort, type ConversationCapabilities,
  type ChannelWebhookPort, type ChannelWebhookRequest, type ChannelWebhookResult,
} from '@dentity/application';
import { ProviderHttp, type ProviderHttpOptions, object, string, timestamp, optionalString, validateText } from './http.js';

export interface DingTalkBotOptions extends ProviderHttpOptions {
  robotCode: string;
  /** Host-verified app ID/key bound to this installation and credential, never callback JSON. */
  appId?: string;
  /** Trusted installation config. A capability flag is not a substitute for upstream API authorization. */
  proactiveSendGranted?: boolean;
  /** Trusted composition: events arrive through the separate official Stream adapter. */
  streamIngress?: boolean;
  mentionEventsGranted?: boolean;
  privateMessageEventsGranted?: boolean;
  /** Host assertion: HTTPS terminates only at a trusted proxy, forwarding headers/body intact.
   * DingTalk's official signature authenticates timestamp+secret, NOT body integrity.
   * Never derive this flag from callback headers or request JSON. */
  trustedHttpsBoundary?: boolean;
}
/** Pending-installation proof is only a candidate: the caller must enforce its
 * administrator challenge, current revision, expiry, replay policy and confirmation.
 * Timestamp HMAC does NOT sign the body; a trusted HTTPS boundary is mandatory. */
export interface DingTalkBindingCandidateOptions {
  appId: string;
  resolveAppSecret: () => Promise<string>;
  challengeText: string;
  expiresAt: number;
  trustedHttpsBoundary: boolean;
  now?: () => number;
}
export interface DingTalkBindingCandidate {
  eventId: string;
  messageId: string;
  appId: string;
  botId: string;
  tenantId: string;
  robotCode: string;
  challengeText: string;
}
async function authenticatedCallback(request: ChannelWebhookRequest, options: Pick<DingTalkBindingCandidateOptions,'resolveAppSecret'|'trustedHttpsBoundary'|'now'>): Promise<Record<string,unknown>> {
  if (!options.trustedHttpsBoundary) throw new ChannelError('unauthenticated','trusted_https_boundary_required');
  if (Buffer.byteLength(request.rawBody) > 1024 * 1024) throw new ChannelError('invalid_request','webhook_too_large');
  const headers = Object.fromEntries(Object.entries(request.headers).map(([key,value])=>[key.toLowerCase(),value]));
  const time = headers.timestamp, signature = headers.sign;
  if (!time || !/^\d{13}$/.test(time) || !signature || !/^[A-Za-z0-9+/]{43}=$/.test(signature)) throw new ChannelError('unauthenticated');
  if (Math.abs((options.now?.() ?? Date.now())-Number(time)) > 3600000) throw new ChannelError('unauthenticated','webhook_timestamp_expired');
  let secret: string;
  try { secret = await options.resolveAppSecret(); } catch { throw new ChannelError('unauthenticated','channel_credential_unavailable'); }
  if (typeof secret !== 'string' || !secret || secret.length > 32768 || /[\r\n]/.test(secret)) throw new ChannelError('unauthenticated','channel_credential_invalid');
  const expected = createHmac('sha256',secret).update(`${time}\n${secret}`).digest();
  if (!timingSafeEqual(expected,Buffer.from(signature,'base64'))) throw new ChannelError('unauthenticated');
  try { return object(JSON.parse(request.rawBody)); } catch { throw new ChannelError('invalid_request','invalid_webhook_json'); }
}
export async function verifyDingTalkBindingCandidate(request: ChannelWebhookRequest, options: DingTalkBindingCandidateOptions): Promise<DingTalkBindingCandidate> {
  const now = options.now?.() ?? Date.now();
  if (!Number.isSafeInteger(options.expiresAt) || options.expiresAt <= now) throw new ChannelError('unauthenticated','binding_challenge_expired');
  const bounded = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && !/[\r\n]/.test(value);
  if (!bounded(options.appId) || !bounded(options.challengeText)) throw new ChannelError('invalid_request','invalid_binding_challenge');
  const row = await authenticatedCallback(request,options);
  if (!bounded(row.msgId) || !bounded(row.chatbotCorpId) || !bounded(row.chatbotUserId) || !bounded(row.robotCode) || !bounded(row.senderStaffId) || row.senderCorpId !== row.chatbotCorpId) throw new ChannelError('forbidden','binding_candidate_identity_invalid');
  if (row.senderId === row.chatbotUserId || row.senderStaffId === row.chatbotUserId) throw new ChannelError('forbidden','binding_candidate_sender_invalid');
  if (row.msgtype !== 'text' || (row.conversationType !== '1' && !(row.conversationType === '2' && row.isInAtList === true))) throw new ChannelError('invalid_request','binding_candidate_message_required');
  const text = typeof row.text === 'object' && row.text !== null && !Array.isArray(row.text) ? (row.text as Record<string,unknown>).content : undefined;
  if (typeof text !== 'string' || text.trim() !== options.challengeText) throw new ChannelError('forbidden','binding_challenge_mismatch');
  // Never accept application identity, verification status or a destination URL from JSON.
  return Object.freeze({eventId:row.msgId,messageId:row.msgId,appId:options.appId,botId:row.chatbotUserId,tenantId:row.chatbotCorpId,robotCode:row.robotCode,challengeText:text.trim()});
}
/** Official app-bot HTTP callback and send API; Stream is not implemented. */
export class DingTalkBotConversationAdapter implements ConversationPort, ChannelWebhookPort {
  readonly connection: ChannelConnection;
  private readonly http: ProviderHttp;
  constructor(connection: ChannelConnection, private readonly options: DingTalkBotOptions) {
    if (connection.provider !== 'dingtalk' || connection.identity.kind !== 'bot' || !connection.identity.externalId || !options.robotCode) throw new ChannelError('invalid_request');
    if (options.appId !== undefined && (typeof options.appId !== 'string' || !options.appId.trim() || options.appId.length > 256)) throw new ChannelError('invalid_request', 'invalid_trusted_app_id');
    this.options = Object.freeze({...options});
    this.connection = Object.freeze({...connection,identity:Object.freeze({...connection.identity})}); this.http = new ProviderHttp(this.connection, this.options);
  }
  private resource(ref: ChannelResourceRef): void {
    assertChannelResource(this.connection,ref); if (ref.kind !== 'conversation') throw new ChannelError('invalid_request');
    if (ref.conversationKind && ref.conversationKind !== 'private' && ref.conversationKind !== 'group') throw new ChannelError('unsupported','conversation_kind_not_supported');
  }
  async inspectCapabilities(ref?: ChannelResourceRef): Promise<ConversationCapabilities> {
    if (ref) this.resource(ref);
    const no = {supported:false,availability:'unsupported' as const};
    return {privateMessageEvents:{supported:true,availability:(this.options.streamIngress || this.options.trustedHttpsBoundary) && this.options.privateMessageEventsGranted?'available':'authorization_required'},mentionEvents:{supported:true,availability:(this.options.streamIngress || this.options.trustedHttpsBoundary) && this.options.mentionEventsGranted?'available':'authorization_required'},ordinaryMessageEvents:no,historyRead:no,replyToMessage:no,threadRead:no,
      proactiveSend:{supported:true,availability:this.options.proactiveSendGranted?'available':'authorization_required'}};
  }
  async getConversation(ref: ChannelResourceRef): Promise<ChannelConversation> {
    this.resource(ref); throw new ChannelError('unsupported','bot_conversation_lookup_not_implemented');
  }
  async listMessages(ref: ChannelResourceRef, _query: ChannelQuery): Promise<ChannelPage<ChannelMessage>> {
    this.resource(ref); throw new ChannelError('unsupported','bot_history_read_requires_separate_authorized_connector');
  }
  async sendMessage(request: SendChannelMessage): Promise<ChannelSendReceipt> {
    if(request.attachment)throw new ChannelError('unsupported','native_attachments_not_implemented_for_channel');
    this.resource(request.conversation); validateText(request.text);
    if (!request.operationId || request.operationId.length > 256) throw new ChannelError('invalid_request','invalid_send_operation_id');
    if (request.replyToMessageId || request.threadId) throw new ChannelError('unsupported','bot_message_quote_not_implemented');
    requireChannelCapability((await this.inspectCapabilities(request.conversation)).proactiveSend);
    const isPrivate = request.conversation.conversationKind === 'private';
    const recipient = request.conversation.privateRecipientId;
    if (isPrivate && (!recipient || recipient.length > 256)) throw new ChannelError('invalid_request','private_recipient_required');
    if (!isPrivate && recipient) throw new ChannelError('invalid_request','private_recipient_on_group');
    await request.beforeSend?.();
    const response = await this.http.request(isPrivate ? '/v1.0/robot/oToMessages/batchSend' : '/v1.0/robot/groupMessages/send','POST',{
      robotCode:this.options.robotCode,...(isPrivate?{userIds:[recipient]}:{openConversationId:request.conversation.externalId}),msgKey:'sampleText',msgParam:JSON.stringify({content:request.text}),
    },'json',request.assertSendAllowed);
    let data: Record<string,unknown>;
    try { data = object(response); } catch { throw new ChannelError('delivery_unknown','provider_response_shape_invalid'); }
    if (isPrivate) {
      for (const field of ['invalidStaffIdList','flowControlledStaffIdList']) {
        if (data[field] !== undefined && !Array.isArray(data[field])) throw new ChannelError('delivery_unknown','provider_response_shape_invalid');
        if (Array.isArray(data[field]) && (data[field] as unknown[]).length) throw new ChannelError(field === 'invalidStaffIdList' ? 'invalid_request' : 'rate_limited','private_recipient_rejected');
      }
    }
    // processQueryKey identifies the async send request, NOT a delivered channel message.
    if (typeof data.processQueryKey !== 'string' || !data.processQueryKey) throw new ChannelError('delivery_unknown','provider_request_id_missing');
    return {status:'accepted',providerRequestId:data.processQueryKey,idempotent:false};
  }
  async receiveWebhook(request: ChannelWebhookRequest): Promise<ChannelWebhookResult> {
    const row = await authenticatedCallback(request,{resolveAppSecret:()=>this.http.credential('webhook_app_secret'),trustedHttpsBoundary:this.options.trustedHttpsBoundary === true,now:this.http.now});
    if (row.chatbotCorpId !== this.connection.tenantId || row.robotCode !== this.options.robotCode || row.chatbotUserId !== this.connection.identity.externalId) throw new ChannelError('forbidden','webhook_installation_mismatch');
    const isPrivate = row.conversationType === '1';
    if ((!isPrivate && row.conversationType !== '2') || row.msgtype !== 'text' || (!isPrivate && row.isInAtList !== true)) return {kind:'ignored'};
    const caps = await this.inspectCapabilities();
    requireChannelCapability(isPrivate ? caps.privateMessageEvents! : caps.mentionEvents);
    if (row.senderCorpId !== this.connection.tenantId) throw new ChannelError('forbidden','external_corporation_sender_not_supported');
    // Published internal app bots provide staffId. Do not guess it from senderId/nickname.
    const senderId = optionalString(row.senderStaffId);
    if (isPrivate && !senderId) return {kind:'ignored'};
    if (senderId === this.connection.identity.externalId || row.senderId === this.connection.identity.externalId) return {kind:'ignored'};
    const conversationKind = isPrivate ? 'private' : 'group';
    const conversation: ChannelResourceRef = {provider:'dingtalk',connectionId:this.connection.connectionId,tenantId:this.connection.tenantId,kind:'conversation',externalId:string(row.conversationId),conversationKind,...(isPrivate?{privateRecipientId:senderId!}:{})};
    const message: ChannelMessage = {id:string(row.msgId),conversation,conversationKind,occurredAt:timestamp(row.createAt),
      author:{...(senderId?{externalId:senderId,idNamespace:'user_id' as const,...(this.options.appId?{applicationId:this.options.appId}:{})}:{}),...(optionalString(row.senderNick)?{displayName:string(row.senderNick)}:{}),kind:'human',identityEvidence:senderId?'channel_verified':'unknown'},
      text:string(object(row.text).content),mentions:isPrivate?[]:[this.connection.identity.externalId]};
    return {kind:'message',event:{schemaVersion:1,eventId:message.id,connectionId:this.connection.connectionId,tenantId:this.connection.tenantId,receivedAt:this.http.now(),origin:'live',message}};
  }

}
