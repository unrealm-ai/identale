import {validateNativeAttachment} from './native-media.js';
import { ChannelCursorCodec, channelCursorScope } from './cursor.js';
import { createHash, createDecipheriv, timingSafeEqual } from 'node:crypto';
import {
  ChannelError, assertChannelResource, requireChannelCapability,parseFeishuMessageContent,renderMessageContent,
  type ChannelConnection, type ChannelResourceRef, type ChannelConversation, type ChannelMessage,
  type ChannelQuery, type ChannelPage, type ChannelSendReceipt, type SendChannelMessage,
  type ConversationPort, type ConversationCapabilities, type ChannelCapability,
  type ChannelWebhookPort, type ChannelWebhookRequest, type ChannelWebhookResult,
  type MeetingArtifactsPort, type MeetingArtifactCapabilities, type MeetingArtifact,
  type TranscriptSegment, type MeetingSummary,
} from '@dentity/application';
import { ProviderHttp, type ProviderHttpOptions, object, string, optionalString, array, timestamp, validateText } from './http.js';

export interface FeishuAdapterOptions extends ProviderHttpOptions {
  appId: string;
  /** Only display_id/app_id permit authenticated first-event tenant discovery; host must CAS-pin before business routing. */
  expectedTenantNamespace?: 'tenant_key' | 'display_id' | 'app_id' | 'corp_id';
  /** Granted by trusted installation configuration, not inferred from provider name. */
  grants?: Partial<Record<keyof ConversationCapabilities | 'transcriptRead' | 'officialSummaryRead', boolean>>;
}
const unavailable = (): ChannelCapability => ({supported:false, availability:'unsupported'});
function granted(value: boolean | undefined): ChannelCapability {
  return {supported:true, availability:value === true ? 'available' : 'authorization_required'};
}
const id = (value: string): string => encodeURIComponent(value);
function refFor(connection: ChannelConnection, kind: ChannelResourceRef['kind'], externalId: string): ChannelResourceRef {
  return {provider:connection.provider, connectionId:connection.connectionId, tenantId:connection.tenantId, kind, externalId};
}
function parseText(content: unknown): string {
  const text = string(content);
  let data: Record<string, unknown>;
  try { data = object(JSON.parse(text)); } catch { throw new ChannelError('temporarily_unavailable', 'invalid_message_content'); }
  return string(data.text);
}
// Keep provider mention keys private to binding verification; business messages retain
// their exact source text and the application model stays provider-independent.
const bindingTexts = new WeakMap<ChannelMessage, string>();
function bindingText(text: string, rawMentions: unknown, botId: string): string {
  if (rawMentions === undefined) return text.trim();
  const owners = new Map<string, Set<string>>();
  for (const value of array(rawMentions)) {
    const mention = object(value); const key = optionalString(mention.key);
    if (!key || !/^@_user_[0-9]+$/.test(key)) continue;
    const ids = owners.get(key) ?? new Set<string>();
    ids.add(string(object(mention.id).open_id)); owners.set(key, ids);
  }
  // Only standalone placeholders authenticated by the event metadata and belonging
  // exclusively to this bot are removable. Other mentions and literal @ text remain.
  return text.split(/(\s+)/).filter(part => {
    const ids = owners.get(part);
    return !(ids?.size === 1 && ids.has(botId));
  }).join('').trim();
}
/** Native text/image/file HTTP transport. Event lifecycle is provided separately. */
export function feishuMediaCapabilities(grants: FeishuAdapterOptions['grants'] = {}): NonNullable<ConversationCapabilities['media']> {
  const privateMedia = granted(grants.privateMessageEvents);
  const groupMedia = granted(grants.mentionEvents || grants.ordinaryMessageEvents);
  const outboundMedia = granted(grants.proactiveSend || grants.replyToMessage);
  return {inbound:{private:{image:privateMedia,file:privateMedia},group:{image:groupMedia,file:groupMedia}},outbound:{private:{image:outboundMedia,file:outboundMedia},group:{image:outboundMedia,file:outboundMedia}}};
}
export class FeishuConversationAdapter implements ConversationPort, ChannelWebhookPort {
  readonly connection: ChannelConnection;
  private readonly http: ProviderHttp;
  private readonly cursors = new ChannelCursorCodec();
  constructor(connection: ChannelConnection, private readonly options: FeishuAdapterOptions) {
    if (connection.provider !== 'feishu' || !connection.identity.externalId || !options.appId) throw new ChannelError('invalid_request');
    this.options = Object.freeze({...options, grants:Object.freeze({...options.grants})});
    this.connection = Object.freeze({...connection,identity:Object.freeze({...connection.identity})}); this.http = new ProviderHttp(this.connection, this.options);
  }
  async inspectCapabilities(resource?: ChannelResourceRef): Promise<ConversationCapabilities> {
    if (resource) this.conversation(resource);
    return {
      media: feishuMediaCapabilities(this.options.grants),
      privateMessageEvents:this.connection.identity.kind === 'bot' ? granted(this.options.grants?.privateMessageEvents) : unavailable(),
      mentionEvents:this.connection.identity.kind === 'bot' ? granted(this.options.grants?.mentionEvents) : unavailable(),
      ordinaryMessageEvents:this.connection.identity.kind === 'bot' ? granted(this.options.grants?.ordinaryMessageEvents) : unavailable(),
      historyRead:granted(this.options.grants?.historyRead), proactiveSend:granted(this.options.grants?.proactiveSend),
      replyToMessage:granted(this.options.grants?.replyToMessage), threadRead:granted(this.options.grants?.historyRead),
    };
  }
  private conversation(ref: ChannelResourceRef): void {
    assertChannelResource(this.connection, ref); if (ref.kind !== 'conversation') throw new ChannelError('invalid_request');
  }
  async getConversation(ref: ChannelResourceRef): Promise<ChannelConversation> {
    this.conversation(ref);
    const data = await this.http.feishu(`/open-apis/im/v1/chats/${id(ref.externalId)}`);
    if (data.chat_mode !== 'group' && data.chat_mode !== 'p2p') throw new ChannelError('temporarily_unavailable', 'unknown_conversation_kind');
    return {ref, kind:data.chat_mode === 'group' ? 'group' : 'direct', ...(optionalString(data.name) ? {title:string(data.name)} : {})};
  }
  async listJoinedGroups(query:{cursor?:string}) {
    const params=new URLSearchParams({page_size:'50'});
    if(query.cursor){if(query.cursor.length>4096||/[\x00-\x1f]/.test(query.cursor))throw new ChannelError('invalid_request','invalid_group_cursor');params.set('page_token',query.cursor);}
    const data=await this.http.feishu('/open-apis/im/v1/chats?'+params);
    const items=array(data.items).map(item=>{const row=object(item);return{id:string(row.chat_id),...(optionalString(row.name)?{name:string(row.name)}:{})};});
    if(typeof data.has_more!=='boolean'||data.has_more&&!optionalString(data.page_token))throw new ChannelError('temporarily_unavailable','invalid_group_page');
    return{items,...(data.has_more?{nextCursor:string(data.page_token)}:{})};
  }
  async isBotInGroup(ref:ChannelResourceRef):Promise<boolean> {
    this.conversation(ref);
    if(this.connection.identity.kind!=='bot'||ref.conversationKind!=='group')throw new ChannelError('invalid_request','bot_group_required');
    const data=await this.http.feishu(`/open-apis/im/v1/chats/${id(ref.externalId)}/members/is_in_chat`);
    if(typeof data.is_in_chat!=='boolean')throw new ChannelError('temporarily_unavailable','membership_response_invalid');
    return data.is_in_chat;
  }
  async listMessages(ref: ChannelResourceRef, query: ChannelQuery): Promise<ChannelPage<ChannelMessage>> {
    this.conversation(ref); requireChannelCapability((await this.inspectCapabilities(ref)).historyRead);
    if(query.threadId&&(typeof query.threadId!=='string'||query.threadId.length>200||/[\x00-\x1f]/.test(query.threadId)))throw new ChannelError('invalid_request','invalid_thread_reference');
    if(query.threadId&&query.order==='desc')throw new ChannelError('unsupported','thread_history_desc_unsupported');
    if (query.order !== undefined && query.order !== 'asc' && query.order !== 'desc') throw new ChannelError('invalid_request','invalid_history_order');
    const limit = query.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new ChannelError('invalid_request');
    const params = new URLSearchParams(query.threadId?{container_id_type:'thread',container_id:query.threadId,page_size:String(limit)}:{container_id_type:'chat',container_id:ref.externalId,page_size:String(limit),sort_type:query.order === 'desc' ? 'ByCreateTimeDesc' : 'ByCreateTimeAsc'});
    const scope = channelCursorScope(this.connection, ref, {...query,limit});
    const currentToken = query.cursor ? this.cursors.decode(scope,query.cursor).token : undefined;
    if (currentToken) params.set('page_token',currentToken);
    for (const [name, value] of [['start_time',query.startAt],['end_time',query.endAt]] as const) {
      if (value !== undefined) { if (!Number.isSafeInteger(value) || value < 0 || value % 1000 !== 0) throw new ChannelError('invalid_request'); if(!query.threadId)params.set(name,String(Math.floor(value / 1000))); }
    }
    if (query.startAt !== undefined && query.endAt !== undefined && query.startAt >= query.endAt) throw new ChannelError('invalid_request');
    const data = await this.http.feishu(`/open-apis/im/v1/messages?${params}`);
    if (typeof data.has_more !== 'boolean') throw new ChannelError('temporarily_unavailable','pagination_state_missing');
    const next = optionalString(data.page_token);
    if (data.has_more && (!next || next === currentToken)) throw new ChannelError('partial_failure','pagination_cursor_invalid');
    let unsupportedContent = false;
    const items = array(data.items).map(value => {
      const row = object(value); const sender = object(row.sender);
      if (row.chat_id !== undefined && row.chat_id !== ref.externalId) throw new ChannelError('forbidden','provider_conversation_mismatch');
      if(query.threadId&&row.thread_id!==undefined&&row.thread_id!==query.threadId)throw new ChannelError('forbidden','provider_thread_mismatch');
      const content = object(row.body);
      const text = row.msg_type === 'text' ? parseText(content.content) : '';
      if (row.msg_type !== 'text') unsupportedContent = true;
      return this.message(row, sender, ref, text, false);
    });
    return {items, ...(data.has_more && next ? {nextCursor:this.cursors.encode(scope,{token:next})} : {}), exhausted:!data.has_more, coverage:unsupportedContent?'partial':'authorized_query', fetchedAt:this.http.now(), warnings:['History is limited to this credential and query; chat pages do not expand all threads.',...(query.threadId?['Thread pages use provider order; time filtering is applied by the runtime within its scan budget.']:[]), ...(unsupportedContent?['Non-text message bodies are not projected by this adapter.']:[])]};
  }
  private message(row: Record<string, unknown>, sender: Record<string, unknown>, ref: ChannelResourceRef, text: string, event: boolean): ChannelMessage {
    const senderId = event ? optionalString(object(sender.sender_id).open_id) : sender.id_type === 'open_id' ? optionalString(sender.id) : undefined;
    const mentionRows=row.mentions===undefined?[]:array(row.mentions);
    const mentions = mentionRows.map(value => {
      const mention = object(value); if (event) return string(object(mention.id).open_id);
      if (mention.id_type !== 'open_id') throw new ChannelError('unsupported','mention_identity_namespace_not_supported');
      return string(mention.id);
    });
    return {id:string(row.message_id), conversation:ref,
      author:{...(senderId?{externalId:senderId,idNamespace:'open_id' as const,applicationId:this.options.appId}:{}), kind:sender.sender_type==='user'?'human':sender.sender_type==='app'?'bot':'unknown', identityEvidence:senderId?(event?'channel_verified':'source_label'):'unknown'},
      occurredAt:timestamp(row.create_time), text, mentions,
      mentionDetails:mentionRows.flatMap(value=>{const mention=object(value);return typeof mention.key==='string'?[{key:mention.key,id:event?string(object(mention.id).open_id):string(mention.id),...(typeof mention.name==='string'?{name:mention.name}:{})}]:[];}),
      ...(optionalString(row.parent_id)?{replyToMessageId:string(row.parent_id)}:{}),
      ...(optionalString(row.root_id)?{rootMessageId:string(row.root_id)}:{}),
      ...(optionalString(row.thread_id)?{threadId:string(row.thread_id)}:{}),
    };
  }
  async sendMessage(request: SendChannelMessage): Promise<ChannelSendReceipt> {
    this.conversation(request.conversation);
    if(!request.attachment)validateText(request.text);
    else {if(request.text)throw new ChannelError('invalid_request','invalid_native_attachment');validateNativeAttachment(request.attachment,{image:10_000_000,file:30_000_000});}
    if (!request.operationId || request.operationId.length > 50) throw new ChannelError('invalid_request','invalid_send_operation_id');
    if (request.threadId && !request.replyToMessageId) throw new ChannelError('invalid_request','thread_reply_target_required');
    const capabilities = await this.inspectCapabilities(request.conversation);
    requireChannelCapability(request.replyToMessageId ? capabilities.replyToMessage : capabilities.proactiveSend);
    // Validate reply target belongs to the requested conversation before sending.
    if (request.replyToMessageId) {
      const original = await this.http.feishu(`/open-apis/im/v1/messages/${id(request.replyToMessageId)}`);
      const messages = array(original.items);
      if (messages.length !== 1 || object(messages[0]).chat_id !== request.conversation.externalId) throw new ChannelError('forbidden','reply_target_scope_mismatch');
      if (request.threadId && object(messages[0]).thread_id !== request.threadId) throw new ChannelError('forbidden','reply_target_thread_mismatch');
    }
    const recipient=request.conversation.privateRecipientId,namespace=request.conversation.privateRecipientNamespace;
    if(namespace&&(!recipient||request.conversation.conversationKind!=='private'||request.replyToMessageId||!['open_id','user_id'].includes(namespace)))throw new ChannelError('invalid_request','invalid_private_recipient');
    await request.beforeSend?.();
    let messageType='text',content:Record<string,string>={text:request.text};
    if(request.attachment){
      const attachment=request.attachment,form=new FormData(),blob=new Blob([new Uint8Array(attachment.bytes)],{type:attachment.mediaType});
      if(attachment.kind==='image'){
        form.append('image_type','message');form.append('image',blob,attachment.name);
        const uploaded=await this.http.feishuUpload('/open-apis/im/v1/images',form,request.assertSendAllowed);
        if(typeof uploaded.image_key!=='string'||!uploaded.image_key)throw new ChannelError('temporarily_unavailable','image_upload_unconfirmed');messageType='image';content={image_key:uploaded.image_key};
      }else{
        form.append('file_type','stream');form.append('file_name',attachment.name);form.append('file',blob,attachment.name);
        const uploaded=await this.http.feishuUpload('/open-apis/im/v1/files',form,request.assertSendAllowed);
        if(typeof uploaded.file_key!=='string'||!uploaded.file_key)throw new ChannelError('temporarily_unavailable','file_upload_unconfirmed');messageType='file';content={file_key:uploaded.file_key};
      }
      // Upload can await credentials/network; recheck the source and lease before sending.
      await request.beforeSend?.();
    }
    const data = await this.http.feishu(request.replyToMessageId ? `/open-apis/im/v1/messages/${id(request.replyToMessageId)}/reply` : `/open-apis/im/v1/messages?receive_id_type=${namespace??'chat_id'}`, 'POST', {
      msg_type:messageType, content:JSON.stringify(content), uuid:request.operationId,
      ...(request.threadId?{reply_in_thread:true}:{}),
      ...(request.replyToMessageId?{}:{receive_id:namespace?recipient:request.conversation.externalId}),
    },request.assertSendAllowed);
    if (typeof data.message_id !== 'string' || !data.message_id) throw new ChannelError('delivery_unknown','provider_message_id_missing');
    if (request.threadId && (data.thread_id !== request.threadId || data.chat_id !== request.conversation.externalId)) throw new ChannelError('delivery_unknown','thread_reply_receipt_unconfirmed');
    return {status:'sent',messageId:data.message_id,idempotent:true};
  }
  async receiveWebhook(request: ChannelWebhookRequest): Promise<ChannelWebhookResult> {
    if (this.connection.identity.kind !== 'bot') throw new ChannelError('unsupported');
    if (Buffer.byteLength(request.rawBody) > 1024 * 1024) throw new ChannelError('invalid_request','webhook_too_large');
    // This integration deliberately requires an Encrypt Key, unlike the SDK's
    // optional token-only mode. Challenge requests alone may omit signature headers.
    const key = await this.http.credential('webhook_encrypt_key');
    let body: Record<string,unknown>;
    try {
      body = object(JSON.parse(request.rawBody));
      if (body.encrypt !== undefined) {
        const encoded = string(body.encrypt);
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error();
        const encrypted = Buffer.from(encoded,'base64'); if (encrypted.length < 32) throw new Error();
        const decipher = createDecipheriv('aes-256-cbc',createHash('sha256').update(key).digest(),encrypted.subarray(0,16));
        body = object(JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(16)),decipher.final()]).toString('utf8')));
      }
    } catch { throw new ChannelError('unauthenticated','webhook_payload_invalid'); }
    const expectedToken = await this.http.credential('webhook_verification_token');
    const token = body.type === 'url_verification' ? body.token : object(body.header).token;
    if (typeof token !== 'string' || !constantEqual(token,expectedToken)) throw new ChannelError('unauthenticated');
    if (body.type === 'url_verification') {
      if (typeof body.challenge !== 'string' || !body.challenge || body.challenge.length > 4096) throw new ChannelError('unauthenticated','webhook_payload_invalid');
      return {kind:'challenge',challenge:body.challenge};
    }
    const headers = Object.fromEntries(Object.entries(request.headers).map(([key,value])=>[key.toLowerCase(),value]));
    const time = headers['x-lark-request-timestamp']; const nonce = headers['x-lark-request-nonce']; const signature = headers['x-lark-signature'];
    if (!time || !/^\d{10}$/.test(time) || !nonce || nonce.length > 256 || !signature || !/^[a-fA-F0-9]{64}$/.test(signature)) throw new ChannelError('unauthenticated');
    if (Math.abs(this.http.now() - Number(time) * 1000) > 300000) throw new ChannelError('unauthenticated','webhook_timestamp_expired');
    const digest = createHash('sha256').update(time + nonce + key).update(request.rawBody).digest();
    if (!timingSafeEqual(digest,Buffer.from(signature,'hex'))) throw new ChannelError('unauthenticated');

    const header = object(body.header);
    const actualTenant = optionalString(header.tenant_key);
    const pendingTenant = this.options.expectedTenantNamespace === 'display_id' || this.options.expectedTenantNamespace === 'app_id';
    if (header.app_id !== this.options.appId || !actualTenant || actualTenant.length > 256 || (!pendingTenant && actualTenant !== this.connection.tenantId)) throw new ChannelError('forbidden','webhook_installation_mismatch');
    if (header.event_type !== 'im.message.receive_v1') return {kind:'ignored'};
    const event = object(body.event); const row = object(event.message); const sender = object(event.sender);
    if (sender.tenant_key !== undefined && sender.tenant_key !== actualTenant) throw new ChannelError('forbidden');
    if (row.chat_type !== 'group' && row.chat_type !== 'p2p') return {kind:'ignored'};
    const content=parseFeishuMessageContent(String(row.message_type),row.content);if(!content)return{kind:'ignored'};
    const conversationKind = row.chat_type === 'p2p' ? 'private' : 'group';
    const ref: ChannelResourceRef = {...refFor(this.connection,'conversation',string(row.chat_id)),tenantId:actualTenant,conversationKind};
    const message: ChannelMessage = {...this.message(row,sender,ref,renderMessageContent(content),true),conversationKind,content};
    if (message.author.externalId === this.connection.identity.externalId) return {kind:'ignored'};
    // Pending display IDs are not tenant keys. Only the host may pin and re-resolve this verified result.
    const capabilities = await this.inspectCapabilities();
    const isMention = message.mentions.includes(this.connection.identity.externalId);
    requireChannelCapability(conversationKind === 'private' ? capabilities.privateMessageEvents! : isMention ? capabilities.mentionEvents : capabilities.ordinaryMessageEvents);
    if (conversationKind === 'group') bindingTexts.set(message,bindingText(message.text,row.mentions,this.connection.identity.externalId));
    return {kind:'message',event:{schemaVersion:1,eventId:string(header.event_id),connectionId:this.connection.connectionId,tenantId:actualTenant,receivedAt:this.http.now(),origin:'live',message}};
  }
}
/** Explicit administrator challenge only. This helper never activates a binding or
 * returns an event for business execution; confirmation and CAS belong to the host. */
export async function verifyFeishuBindingCandidate(request: ChannelWebhookRequest, options: {
  adapter: ChannelWebhookPort;
  appId: string;
  botId: string;
  challengeText: string;
  expiresAt: number;
  now?: () => number;
}): Promise<{appId:string;botId:string;tenantId:string;challengeText:string;eventId:string;messageId:string}> {
  const config = {...options};
  if (!Number.isSafeInteger(config.expiresAt) || config.expiresAt <= (config.now?.() ?? Date.now())) throw new ChannelError('unauthenticated','binding_challenge_expired');
  if (!config.appId || !config.botId || !config.challengeText || config.challengeText.length > 256) throw new ChannelError('invalid_request','invalid_binding_challenge');
  if (config.adapter.connection.provider !== 'feishu' || config.adapter.connection.identity.kind !== 'bot' || config.adapter.connection.identity.externalId !== config.botId) throw new ChannelError('forbidden','binding_candidate_bot_mismatch');
  const result = await config.adapter.receiveWebhook(request);
  if (result.kind !== 'message') throw new ChannelError('invalid_request','binding_candidate_message_required');
  const {message,tenantId} = result.event;
  if (!result.event.eventId || result.event.eventId.length > 2048 || !message.id || message.id.length > 2048) throw new ChannelError('invalid_request','binding_candidate_event_required');
  if (message.author.kind !== 'human' || message.author.identityEvidence !== 'channel_verified' || !message.author.externalId || message.author.applicationId !== config.appId || message.author.externalId === config.botId) throw new ChannelError('forbidden','binding_candidate_identity_invalid');
  if (message.conversationKind !== 'private' && !(message.conversationKind === 'group' && message.mentions.includes(config.botId))) throw new ChannelError('forbidden','binding_candidate_target_invalid');
  const challengeText = bindingTexts.get(message) ?? message.text.trim();
  if (challengeText !== config.challengeText) throw new ChannelError('forbidden','binding_challenge_mismatch');
  return Object.freeze({appId:config.appId,botId:config.botId,tenantId,challengeText,eventId:result.event.eventId,messageId:message.id});
}
function constantEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.byteLength === b.byteLength && timingSafeEqual(a,b);
}

/** Minutes only. Note documents and conference-to-minutes discovery remain explicit unsupported routes. */
export class FeishuMinutesAdapter implements MeetingArtifactsPort {
  readonly connection: ChannelConnection;
  private readonly http: ProviderHttp;
  constructor(connection: ChannelConnection, private readonly options: FeishuAdapterOptions) {
    if (connection.provider !== 'feishu') throw new ChannelError('invalid_request');
    this.options = Object.freeze({...options, grants:Object.freeze({...options.grants})});
    this.connection = Object.freeze({...connection,identity:Object.freeze({...connection.identity})}); this.http = new ProviderHttp(this.connection, this.options);
  }
  async inspectCapabilities(resource?: ChannelResourceRef): Promise<MeetingArtifactCapabilities> {
    if (resource) this.source(resource);
    return {transcriptRead:granted(this.options.grants?.transcriptRead),officialSummaryRead:granted(this.options.grants?.officialSummaryRead),readinessEvents:unavailable(),speakerIdentity:'embedded_labels',timestamps:'unknown'};
  }
  private source(ref: ChannelResourceRef): void {
    assertChannelResource(this.connection,ref);
    if (!['minutes','transcript','summary'].includes(ref.kind)) throw new ChannelError('unsupported','only_minutes_source_supported');
    if (!/^[a-z0-9]+$/.test(ref.externalId)) throw new ChannelError('invalid_request');
  }
  async resolveMeeting(ref: ChannelResourceRef): Promise<{source:ChannelResourceRef}> {
    this.source(ref); if (ref.kind !== 'minutes') throw new ChannelError('unsupported'); await this.http.feishu(`/open-apis/minutes/v1/minutes/${id(ref.externalId)}`);
    return {source:ref};
  }
  private artifact(ref: ChannelResourceRef, kind: MeetingArtifact['kind'], state: MeetingArtifact['state'], text?: string): MeetingArtifact {
    return {ref:{...ref,kind},sourceRef:{...ref,kind:'minutes'},kind,state,origin:kind==='summary'?'provider_summary':'provider_transcript',...(text!==undefined?{version:createHash('sha256').update(text).digest('hex')}:{})};
  }
  private async content(ref: ChannelResourceRef): Promise<Record<string,unknown>> {
    this.source(ref);
    return this.http.feishu(`/open-apis/minutes/v1/minutes/${id(ref.externalId)}/artifacts`);
  }
  async listArtifacts(ref: ChannelResourceRef): Promise<readonly MeetingArtifact[]> {
    this.source(ref); if (ref.kind !== 'minutes') throw new ChannelError('invalid_request');
    const capabilities = await this.inspectCapabilities(ref);
    if (capabilities.transcriptRead.availability !== 'available' && capabilities.officialSummaryRead.availability !== 'available') throw new ChannelError('forbidden');
    return Promise.all((['transcript','summary'] as const).map(async kind => {
      try { return await this.getArtifact({...ref,kind}); }
      catch (error) {
        if (!(error instanceof ChannelError)) throw error;
        return {...this.artifact(ref,kind,'unknown'),readError:error.code};
      }
    }));
  }
  async getArtifact(ref: ChannelResourceRef): Promise<MeetingArtifact> {
    if (ref.kind !== 'transcript' && ref.kind !== 'summary') throw new ChannelError('invalid_request');
    this.source(ref);
    const capabilities = await this.inspectCapabilities(ref);
    requireChannelCapability(ref.kind === 'transcript' ? capabilities.transcriptRead : capabilities.officialSummaryRead);
    try {
      if (ref.kind === 'transcript') {
        const page = await this.readTranscript(ref,{});
        return this.artifact(ref,'transcript','ready',page.items.map(item=>item.text).join(''));
      }
      const data = await this.content(ref); const value = data.summary;
      if (value !== undefined && typeof value !== 'string') throw new ChannelError('temporarily_unavailable','artifact_shape_invalid');
      return this.artifact(ref,'summary',typeof value === 'string' && value.trim().length ? 'ready':'unavailable',typeof value === 'string'?value:undefined);
    } catch(error) {
      if (error instanceof ChannelError && error.code === 'not_ready') return this.artifact(ref,ref.kind,'processing');
      if (error instanceof ChannelError && error.code === 'not_found') return this.artifact(ref,ref.kind,'unavailable');
      throw error;
    }
  }
  async readTranscript(ref: ChannelResourceRef, query: ChannelQuery): Promise<ChannelPage<TranscriptSegment>> {
    this.source(ref); if (ref.kind !== 'transcript') throw new ChannelError('invalid_request');
    requireChannelCapability((await this.inspectCapabilities(ref)).transcriptRead);
    if (query.cursor || query.startAt !== undefined || query.endAt !== undefined || query.threadId || query.limit !== undefined || query.order !== undefined) throw new ChannelError('unsupported','minutes_text_is_single_material');
    const text = await this.http.feishuText(`/open-apis/minutes/v1/minutes/${id(ref.externalId)}/transcript?need_speaker=true&need_timestamp=true&file_format=txt`);
    if (!text.trim()) throw new ChannelError('not_found','transcript_not_available');
    return {items:[{id:createHash('sha256').update(text).digest('hex'),sequence:0,text,artifactRef:{...ref,kind:'transcript'}}],exhausted:true,coverage:'authorized_query',fetchedAt:this.http.now(),warnings:['Native transcript export requests speaker labels and timestamps and preserves them verbatim. Labels are embedded in text, not authenticated user IDs or structurally parsed segments.']};
  }
  async readSummary(ref: ChannelResourceRef): Promise<MeetingSummary> {
    this.source(ref); if (ref.kind !== 'summary') throw new ChannelError('invalid_request');
    requireChannelCapability((await this.inspectCapabilities(ref)).officialSummaryRead);
    const data = await this.content(ref); const text = string(data.summary);
    if (!text.trim()) throw new ChannelError('not_found','summary_not_available');
    return {artifact:this.artifact(ref,'summary','ready',text),text,format:'text'};
  }
}
