import {parseBotContent,type InboundAssetLocator} from './media.js';
import {ChannelError, type ChannelIngressSession, type ChannelMessageEvent, type ChannelReplyRoute,type ChannelMention,parseFeishuMessageContent,renderMessageContent} from '@dentity/application';

/** Host-resolved installation facts. Never populate these from an event or HTTP input. */
export interface ChannelIngressIdentityHints {
  botId?: string;
  tenantId?: string;
  tenantNamespace?: 'tenant_key' | 'display_id' | 'app_id' | 'corp_id';
  robotCode?: string;
}
export interface ChannelIngressCandidate {
  appId: string;
  botId: string;
  tenantId: string;
  tenantNamespace: 'tenant_key' | 'corp_id';
  robotCode?: string;
}
export type NormalizedChannelIngress =
  | {kind: 'message'; event: ChannelMessageEvent; verificationText: string; candidate: ChannelIngressCandidate;media?:InboundAssetLocator[]}
  | {kind:'group_record';event:ChannelMessageEvent;candidate:ChannelIngressCandidate}
  | {kind:'membership';chatId:string;present:boolean;occurredAt:number;eventId?:string;name?:string;disbanded?:boolean}
  | {kind: 'ignored'; reason: string};
const MAX_BODY_BYTES = 1024 * 1024;
function invalid(reason: string): never { throw new ChannelError('invalid_request', reason); }
function mismatch(reason: string): never { throw new ChannelError('forbidden', reason); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('invalid_ingress_object');
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\x00-\x20\x7f]/.test(value)) return invalid('invalid_ingress_id');
  return value;
}
function time(value: unknown): number {
  const n = typeof value === 'string' && /^\d{1,16}$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) return invalid('invalid_ingress_timestamp');
  return n;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_BODY_BYTES) return invalid('invalid_ingress_text');
  return value;
}
function parse(value: unknown): Record<string, unknown> {
  try { return object(JSON.parse(text(value))); } catch { return invalid('invalid_ingress_json'); }
}
function match(value: unknown, expected: string, reason: string): void {
  if (id(value) !== expected) mismatch(reason);
}
function checkOptional(value: unknown, expected: string, reason: string): void {
  if (value !== undefined) match(value, expected, reason);
}
/** Pure parser, NOT an authentication API. Only the parent sink of a current SDK
 * child may invoke this, after checking child identity/session/generation. The
 * parent must fence the subsequent durable write and preserve replay tombstones.
 * No public route, boolean flag, or identityEvidence field confers that authority. */
export function normalizeChannelIngressEvent(
  session: ChannelIngressSession, envelope: unknown, hints: ChannelIngressIdentityHints = {}, receivedAt = Date.now(),
): NormalizedChannelIngress {
  id(session.connectionId); id(session.appId); id(session.generation); time(receivedAt);
  for (const value of [hints.botId,hints.tenantId,hints.robotCode]) if (value !== undefined) id(value);
  let encoded: string | undefined;
  try { encoded = JSON.stringify(envelope); } catch { return invalid('invalid_ingress_json'); }
  if (!encoded || Buffer.byteLength(encoded) > MAX_BODY_BYTES) return invalid('ingress_too_large');
  const raw = object(envelope);
  if (session.provider === 'feishu') return feishu(session, raw, hints, receivedAt);
  if (session.provider === 'dingtalk') return dingtalk(session, raw, hints, receivedAt);
  if (session.provider === 'wecom') return wecom(session, raw, hints, receivedAt);
  return invalid('unsupported_ingress_provider');
}
function feishu(session: ChannelIngressSession, raw: Record<string,unknown>, hints: ChannelIngressIdentityHints, receivedAt: number): NormalizedChannelIngress {
  if (raw.schema !== '2.0') return invalid('unsupported_feishu_schema');
  const header = object(raw.header), payload = object(raw.event);
  if (!['im.message.receive_v1','im.chat.member.bot.added_v1','im.chat.member.bot.deleted_v1','im.chat.disbanded_v1'].includes(String(header.event_type)))return{kind:'ignored',reason:'unsupported_feishu_event'};
  match(header.app_id,session.appId,'ingress_app_mismatch');
  const tenantId = id(header.tenant_key), eventId = id(header.event_id);
  // Do not flatten the dispatcher payload over the authenticated envelope header.
  for (const field of ['app_id','tenant_key','event_id','event_type'] as const) {
    if (payload[field] !== undefined && payload[field] !== header[field]) mismatch('ingress_header_override');
  }
  if (hints.tenantId && (hints.tenantNamespace === undefined || hints.tenantNamespace === 'tenant_key')) match(tenantId,hints.tenantId,'ingress_tenant_mismatch');
  if (hints.tenantNamespace === 'corp_id') mismatch('ingress_tenant_namespace_mismatch');
  // A display_id from tenant/query is not a tenant_key. Bot identity comes from
  // authenticated bot-info, never the first mention or an arbitrary event field.
  if (!hints.botId) return {kind:'ignored',reason:'bot_identity_unavailable'};
  const botId = hints.botId;
  if(header.event_type!=='im.message.receive_v1'){
    const rawTime=time(header.create_time);return{kind:'membership',chatId:id(payload.chat_id),present:header.event_type==='im.chat.member.bot.added_v1',occurredAt:rawTime>100000000000000?Math.floor(rawTime/1000):rawTime,eventId,...(typeof payload.name==='string'?{name:payload.name.slice(0,120)}:{}),...(header.event_type==='im.chat.disbanded_v1'?{disbanded:true}:{})};
  }
  const row = object(payload.message), sender = object(payload.sender);
  checkOptional(sender.tenant_key,tenantId,'ingress_sender_tenant_mismatch');
  if (row.chat_type !== 'p2p' && row.chat_type !== 'group') return invalid('unsupported_conversation_kind');
  const normalizedContent=parseFeishuMessageContent(String(row.message_type),row.content);if(!normalizedContent)return{kind:'ignored',reason:'unsupported_message_type'};
  const messageId = id(row.message_id), chatId = id(row.chat_id);
  const content = renderMessageContent(normalizedContent), senderIds = object(sender.sender_id);
  if (!['user','app'].includes(String(sender.sender_type)) || senderIds.open_id === undefined) throw new ChannelError('unauthenticated','ingress_sender_identity_invalid');
  const senderId = id(senderIds.open_id);
  if (senderId === botId) return {kind:'ignored',reason:'self_message'};
  const owners = new Map<string,Set<string>>();
  const mentionDetails:ChannelMention[]=[];
  let mentioned = false;
  if (row.mentions !== undefined) {
    if (!Array.isArray(row.mentions) || row.mentions.length > 256) return invalid('invalid_ingress_mentions');
    for (const value of row.mentions) {
      const mention = object(value), mentionId = id(object(mention.id).open_id);
      if (mentionId === botId) mentioned = true;
      if (mention.key !== undefined) {
        const key = id(mention.key);
        mentionDetails.push({key,id:mentionId,...(typeof mention.name==='string'?{name:mention.name}:{})});
        if (/^@_user_[0-9]+$/.test(key)) { const set = owners.get(key) ?? new Set<string>(); set.add(mentionId); owners.set(key,set); }
      }
    }
  }
  const verificationText = content.split(/(\s+)/).filter(part => { const set = owners.get(part); return !(set?.size === 1 && set.has(botId)); }).join('').trim();
  const conversationKind = row.chat_type === 'p2p' ? 'private' : 'group';
  const event: ChannelMessageEvent = {schemaVersion:1,eventId,connectionId:session.connectionId,tenantId,receivedAt,origin:'live',message:{
    id:messageId,conversationKind,conversation:{provider:'feishu',connectionId:session.connectionId,tenantId,kind:'conversation',externalId:chatId,conversationKind},
    author:{externalId:senderId,idNamespace:'open_id',applicationId:session.appId,kind:sender.sender_type==='app'?'bot':'human',identityEvidence:'channel_verified'},
    occurredAt:time(row.create_time),text:content,content:normalizedContent,mentions:mentioned?[botId]:[],mentionDetails,
    ...(row.parent_id ? {replyToMessageId:id(row.parent_id)} : {}),...(row.root_id ? {rootMessageId:id(row.root_id)} : {}),...(row.thread_id ? {threadId:id(row.thread_id)} : {}),
  }};
  return {kind:'message',event,verificationText,candidate:{appId:session.appId,botId,tenantId,tenantNamespace:'tenant_key'}};
}
function dingtalk(session: ChannelIngressSession, raw: Record<string,unknown>, hints: ChannelIngressIdentityHints, receivedAt: number): NormalizedChannelIngress {
  if (raw.type !== 'CALLBACK') return invalid('unsupported_dingtalk_frame');
  const headers = object(raw.headers);
  if (headers.topic !== '/v1.0/im/bot/messages/get') return invalid('unsupported_dingtalk_topic');
  const eventId = id(headers.messageId), row = parse(raw.data);
  const tenantId = id(row.chatbotCorpId), botId = id(row.chatbotUserId), robotCode = id(row.robotCode);
  if (hints.botId) match(botId,hints.botId,'ingress_bot_mismatch');
  if (hints.robotCode) match(robotCode,hints.robotCode,'ingress_robot_mismatch');
  if (hints.tenantNamespace && hints.tenantNamespace !== 'corp_id' && hints.tenantNamespace !== 'app_id') mismatch('ingress_tenant_namespace_mismatch');
  if (hints.tenantId && hints.tenantNamespace !== 'app_id') match(tenantId,hints.tenantId,'ingress_tenant_mismatch');
  // appKey is credential-scoped, not robotCode; only genuine corp evidence pins
  // staff IDs. Never use senderId/nickname as a missing senderStaffId fallback.
  checkOptional(row.appId,session.appId,'ingress_app_mismatch');
  checkOptional(row.appKey,session.appId,'ingress_app_mismatch');
  if (row.conversationType !== '1' && row.conversationType !== '2') return invalid('unsupported_conversation_kind');
  const messageId = id(row.msgId), chatId = id(row.conversationId), content = row.msgtype==='text'?text(object(row.text).content):['image','picture'].includes(String(row.msgtype))?'[图片]':row.msgtype==='file'?'[文件]':'[非文本消息]';
  match(row.senderCorpId,tenantId,'ingress_sender_tenant_mismatch');
  if (row.senderStaffId === undefined || row.senderStaffId === '') throw new ChannelError('unauthenticated','ingress_sender_identity_invalid');
  const senderId = id(row.senderStaffId);
  if (senderId === botId || row.senderId === botId) return {kind:'ignored',reason:'self_message'};
  if (row.isInAtList !== undefined && typeof row.isInAtList !== 'boolean') return invalid('invalid_ingress_mentions');
  const conversationKind = row.conversationType === '1' ? 'private' : 'group';
  const event: ChannelMessageEvent = {schemaVersion:1,eventId,connectionId:session.connectionId,tenantId,receivedAt,origin:'live',message:{
    id:messageId,conversationKind,conversation:{provider:'dingtalk',connectionId:session.connectionId,tenantId,kind:'conversation',externalId:chatId,conversationKind,...(conversationKind === 'private'?{privateRecipientId:senderId}:{})},
    author:{externalId:senderId,idNamespace:'user_id',applicationId:session.appId,kind:'human',identityEvidence:'channel_verified'},
    occurredAt:time(row.createAt),text:content,mentions:row.isInAtList === true?[botId]:[],...(typeof row.conversationTitle==='string'?{conversationTitle:row.conversationTitle}:{}),
  }};
  const candidate={appId:session.appId,botId,tenantId,tenantNamespace:'corp_id' as const,robotCode},parsed=parseBotContent('dingtalk',row);
  if(parsed)return{kind:'message',event:{...event,message:{...event.message,content:parsed.content,text:renderMessageContent(parsed.content)}},verificationText:row.msgtype==='text'?content.trim():'',candidate,media:parsed.media};
  if(row.msgtype!=='text')return conversationKind==='group'&&row.isInAtList===true?{kind:'group_record',event,candidate}:{kind:'ignored',reason:'unsupported_message_type'};
  return {kind:'message',event,verificationText:content.trim(),candidate};
}

function wecom(session: ChannelIngressSession, raw: Record<string,unknown>, hints: ChannelIngressIdentityHints, receivedAt: number): NormalizedChannelIngress {
  if(raw.cmd!=='aibot_msg_callback')return invalid('unsupported_wecom_frame');
  id(object(raw.headers).req_id);
  const row=object(raw.body),botId=id(row.aibotid);
  match(botId,session.appId,'ingress_bot_mismatch');
  if(hints.botId)match(botId,hints.botId,'ingress_bot_mismatch');
  if(!hints.tenantId)return {kind:'ignored',reason:'directory_binding_required'};
  if(hints.tenantNamespace!=='corp_id')return mismatch('ingress_tenant_namespace_mismatch');
  // Internal bot callbacks do not prove CorpID; only host admin_asserted binding does.
  const tenantId=hints.tenantId;
  if(row.chattype!=='single'&&row.chattype!=='group')return invalid('unsupported_conversation_kind');
  const sender=object(row.from),senderId=id(sender.userid);
  if(sender.corpid!==undefined)match(sender.corpid,tenantId,'ingress_sender_tenant_mismatch');
  if(senderId===botId)return {kind:'ignored',reason:'self_message'};
  const messageId=id(row.msgid),content=row.msgtype==='text'?text(object(row.text).content):['image','picture'].includes(String(row.msgtype))?'[图片]':row.msgtype==='file'?'[文件]':'[非文本消息]',conversationKind=row.chattype==='single'?'private':'group';
  const chatId=conversationKind==='group'?id(row.chatid):senderId;
  const event:ChannelMessageEvent={schemaVersion:1,eventId:messageId,connectionId:session.connectionId,tenantId,receivedAt,origin:'live',message:{
    id:messageId,conversationKind,providerDirectedBot:true,
    conversation:{provider:'wecom',connectionId:session.connectionId,tenantId,kind:'conversation',externalId:chatId,conversationKind,...(conversationKind==='private'?{privateRecipientId:senderId}:{})},
    author:{externalId:senderId,idNamespace:'user_id',applicationId:session.appId,kind:'human',identityEvidence:'channel_verified'},
    occurredAt:receivedAt,text:content,mentions:[],
  }};
  const candidate={appId:session.appId,botId,tenantId,tenantNamespace:'corp_id' as const},parsed=parseBotContent('wecom',row);
  if(parsed)return{kind:'message',event:{...event,message:{...event.message,content:parsed.content,text:renderMessageContent(parsed.content)}},verificationText:row.msgtype==='text'?content.trim():'',candidate,media:parsed.media};
  if(row.msgtype!=='text')return conversationKind==='group'?{kind:'group_record',event,candidate}:{kind:'ignored',reason:'unsupported_message_type'};
  return {kind:'message',event,verificationText:content.trim(),candidate};
}

/** Read only message text, never an envelope/credential dump. Does not assert sender identity. */
export function ingressMessageText(provider:ChannelIngressSession['provider'],envelope:unknown):string|undefined {
 try{
  const raw=object(envelope);let value:unknown;
  if(provider==='feishu'){const row=object(object(raw.event).message);if(row.message_type!=='text')return;try{value=JSON.parse(String(row.content)).text;}catch{value=row.content;}}
  else if(provider==='dingtalk'){const row=object(JSON.parse(String(raw.data)));if(row.msgtype!=='text')return;value=object(row.text).content;}
  else {const row=object(raw.body);if(row.msgtype!=='text')return;value=object(row.text).content;}
  return typeof value==='string'&&Buffer.byteLength(value)<=MAX_BODY_BYTES?value:undefined;
 }catch{return;}
}
/** Recover only a fixed original reply destination after sender/content parsing fails.
 * A mismatched installation, missing target, self-message or non-triggering group cannot obtain a route. */
export function ingressReplyTarget(session:ChannelIngressSession,envelope:unknown,hints:ChannelIngressIdentityHints):Pick<ChannelReplyRoute,'conversation'|'messageId'|'eventId'|'threadId'>|undefined {
 try{
  const raw=object(envelope);let chatId:string,messageId:string,eventId:string,tenantId:string,kind:'private'|'group',recipient:string|undefined,threadId:string|undefined;
  if(!hints.botId||!hints.tenantId)return;
  if(session.provider==='feishu'){
   const header=object(raw.header),payload=object(raw.event),row=object(payload.message);
   if(raw.schema!=='2.0'||header.event_type!=='im.message.receive_v1'||header.app_id!==session.appId||header.tenant_key!==hints.tenantId||hints.tenantNamespace!=='tenant_key'||!['text','post','image','file','video_chat','sticker'].includes(String(row.message_type)))return;
   for(const field of ['app_id','tenant_key','event_id','event_type'])if(payload[field]!==undefined&&payload[field]!==header[field])return;
   if(row.chat_type!=='p2p'&&row.chat_type!=='group')return;
   const sender=payload.sender as {sender_id?:{open_id?:unknown}}|undefined;if(sender?.sender_id?.open_id===hints.botId)return;
   kind=row.chat_type==='p2p'?'private':'group';
   if(kind==='group'&&(!Array.isArray(row.mentions)||!row.mentions.some(m=>m?.id?.open_id===hints.botId)))return;
   chatId=id(row.chat_id);messageId=id(row.message_id);eventId=id(header.event_id);tenantId=hints.tenantId;
   if(row.thread_id!==undefined)threadId=id(row.thread_id);
  }else if(session.provider==='dingtalk'){
   const headers=object(raw.headers),row=object(JSON.parse(String(raw.data)));
   if(raw.type!=='CALLBACK'||headers.topic!=='/v1.0/im/bot/messages/get'||row.chatbotCorpId!==hints.tenantId||row.chatbotUserId!==hints.botId||row.robotCode!==hints.robotCode||row.msgtype!=='text')return;
   for(const key of ['appId','appKey'])if(row[key]!==undefined&&row[key]!==session.appId)return;
   if(row.senderStaffId===hints.botId||row.senderId===hints.botId)return;
   if(row.conversationType!=='1'&&row.conversationType!=='2')return;
   kind=row.conversationType==='1'?'private':'group';if(kind==='group'&&row.isInAtList!==true)return;
   if(kind==='private')recipient=id(row.senderStaffId);
   chatId=id(row.conversationId);messageId=id(row.msgId);eventId=id(headers.messageId);tenantId=hints.tenantId;
  }else{
   const row=object(raw.body);if(raw.cmd!=='aibot_msg_callback'||row.aibotid!==session.appId||row.aibotid!==hints.botId||hints.tenantNamespace!=='corp_id'||row.msgtype!=='text')return;
   if(row.chattype!=='single'&&row.chattype!=='group')return;
   const sender=row.from as {userid?:unknown}|undefined;if(sender?.userid===hints.botId)return;
   kind=row.chattype==='single'?'private':'group';if(kind==='private')recipient=id(sender?.userid);
   chatId=kind==='private'?recipient!:id(row.chatid);messageId=id(row.msgid);eventId=messageId;tenantId=hints.tenantId;
  }
  return{conversation:{provider:session.provider,connectionId:session.connectionId,tenantId,kind:'conversation',externalId:chatId,conversationKind:kind,...(recipient?{privateRecipientId:recipient}:{})},messageId,eventId,...(threadId?{threadId}:{})};
 }catch{return;}
}
