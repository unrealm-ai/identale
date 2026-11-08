import type {NormalizedMessageContent} from './message-content.js';
/** Channel contracts describe business capabilities, never arbitrary vendor commands. */
export type ChannelProvider = 'feishu' | 'dingtalk' | 'wecom';
export interface ChannelConnection {
  workspaceId: string;
  connectionId: string;
  provider: ChannelProvider;
  tenantId: string;
  identity: { kind: 'bot' | 'delegated_user'; externalId: string };
  /** A trusted host resolves this reference; never pass a token in a model argument. */
  credentialRef: string;
}
export interface ChannelResourceRef {
  provider: ChannelProvider;
  connectionId: string;
  tenantId: string;
  kind: 'conversation' | 'meeting' | 'minutes' | 'note' | 'transcript' | 'summary';
  /** Trusted ingress target metadata; never populated by model arguments. */
  conversationKind?: 'private' | 'group' | 'meeting';
  /** Fixed authenticated recipient for providers whose private send API uses user IDs. */
  privateRecipientId?: string;
  privateRecipientNamespace?: 'open_id'|'user_id';
  externalId: string;
}
export type CapabilityAvailability = 'available' | 'authorization_required' | 'unsupported' | 'unknown';
export interface ChannelCapability {
  supported: boolean;
  availability: CapabilityAvailability;
  reason?: string;
}
/** Media is direction- and conversation-specific. Absence means unknown, never available. */
export interface ChannelMediaKinds { image: ChannelCapability; file: ChannelCapability; }
export interface ChannelMediaCapabilities {
  inbound: { private: ChannelMediaKinds; group: ChannelMediaKinds };
  outbound: { private: ChannelMediaKinds; group: ChannelMediaKinds };
}
export interface ConversationCapabilities {
  media?: ChannelMediaCapabilities;
  /** Missing on legacy adapters means unsupported, never infer from group grants. */
  privateMessageEvents?: ChannelCapability;
  /** Authenticated provider delivery directed to this bot, not a fabricated mention. */
  directedBotMessageEvents?: ChannelCapability;
  mentionEvents: ChannelCapability;
  ordinaryMessageEvents: ChannelCapability;
  historyRead: ChannelCapability;
  proactiveSend: ChannelCapability;
  replyToMessage: ChannelCapability;
  threadRead: ChannelCapability;
}
export interface MeetingArtifactCapabilities {
  transcriptRead: ChannelCapability;
  officialSummaryRead: ChannelCapability;
  readinessEvents: ChannelCapability;
  speakerIdentity: 'external_user' | 'label_only' | 'embedded_labels' | 'none' | 'unknown';
  timestamps: 'segment' | 'sentence' | 'none' | 'unknown';
}
export interface ChannelActor {
  externalId?: string;
  /** Namespace is provider-specific; open_id remains scoped to the connection's app. */
  idNamespace?: 'open_id' | 'user_id' | 'union_id' | 'unknown';
  /** Trusted adapter configuration, required to interpret app-scoped open_id. */
  applicationId?: string;
  displayName?: string;
  kind: 'human' | 'bot' | 'system' | 'unknown';
  /** Only an authenticated channel event may assert channel_verified. */
  identityEvidence: 'channel_verified' | 'source_label' | 'unknown';
}
export interface ChannelConversation {
  ref: ChannelResourceRef;
  kind: 'direct' | 'group';
  title?: string;
}
/** Display-only mention mapping supplied by an adapter; never an authorization principal. */
export interface ChannelMention {
  key:string;
  id:string;
  name?:string;
}
export interface ChannelMessage {
  id: string;
  /** Adapter-authenticated source kind, not inferred from message text. Missing remains unknown. */
  conversationKind?: 'private' | 'group' | 'meeting';
  conversation: ChannelResourceRef;
  author: ChannelActor;
  occurredAt: number;
  text: string;
  /** Display metadata from the authenticated provider callback; never identity. */
  conversationTitle?:string;
  content?:NormalizedMessageContent;
  sharedAssets?:readonly {assetId:string;kind:string;name?:string}[];
  mentions: readonly string[];
  mentionDetails?:readonly ChannelMention[];
  /** Trusted WeCom ingress only; never infer from text or public request data. */
  providerDirectedBot?: boolean;
  replyToMessageId?: string;
  /** Authenticated source root; never used to infer a thread. */
  rootMessageId?: string;
  threadId?: string;
  attachments?: readonly { id: string; name?: string; mediaType?: string }[];
}
export interface ChannelMessageEvent {
  schemaVersion: 1;
  revision?: string;
  eventId: string;
  connectionId: string;
  tenantId: string;
  receivedAt: number;
  origin: 'live' | 'history';
  message: ChannelMessage;
}
export interface ChannelQuery {
  /** Requested chronological order; unsupported adapters must reject explicit ordering. */
  order?: 'asc' | 'desc';
  startAt?: number;
  endAt?: number;
  cursor?: string;
  limit?: number;
  threadId?: string;
}
/** Exhaustion is relative to this query/identity, not the entire conversation lifetime. */
export interface ChannelPage<T> {
  items: readonly T[];
  nextCursor?: string;
  exhausted: boolean;
  coverage: 'authorized_query' | 'mentions_only' | 'since_connected' | 'partial' | 'unknown';
  fetchedAt: number;
  warnings?: readonly string[];
}
export interface SendChannelMessage {
  /** Trusted runtime bytes, never model-provided paths, URLs, or vendor resource keys.
   * One native media message per operation keeps partial sends independently reconcilable. */
  attachment?: {kind:'image'|'file';name:string;mediaType:string;bytes:Uint8Array};
  /** Host-only final authorization/lease guard, never a model or public JSON argument. */
  beforeSend?: () => Promise<void>;
  /** Final synchronous host guard after credential awaits, immediately before transport dispatch. */
  assertSendAllowed?: () => void;
  conversation: ChannelResourceRef;
  text: string;
  operationId: string;
  replyToMessageId?: string;
  threadId?: string;
}
export interface ChannelSendReceipt {
  providerRequestId?: string;
  status: 'accepted' | 'sent' | 'unknown';
  messageId?: string;
  /** false means a timeout must not be automatically retried as exactly-once. */
  idempotent: boolean;
}
export interface ConversationPort {
  readonly connection: ChannelConnection;
  inspectCapabilities(resource?: ChannelResourceRef): Promise<ConversationCapabilities>;
  getConversation(ref: ChannelResourceRef): Promise<ChannelConversation>;
  listMessages(ref: ChannelResourceRef, query: ChannelQuery): Promise<ChannelPage<ChannelMessage>>;
  sendMessage(request: SendChannelMessage): Promise<ChannelSendReceipt>;
  /** Optional configuration catalog; not conversation history or a read grant. */
  listJoinedGroups?(query:{cursor?:string}):Promise<{items:readonly {id:string;name?:string}[];nextCursor?:string}>;
  /** Host-only check for the current token's own bot; never a user-selected identity. */
  isBotInGroup?(ref:ChannelResourceRef):Promise<boolean>;
}
export interface MeetingArtifact {
  sourceRef: ChannelResourceRef;
  ref: ChannelResourceRef;
  meetingRef?: ChannelResourceRef;
  kind: 'transcript' | 'summary';
  state: 'processing' | 'ready' | 'unavailable' | 'failed' | 'unknown';
  /** Current read failure, distinct from provider artifact generation state. */
  readError?: ChannelErrorCode;
  origin: 'provider_transcript' | 'provider_summary';
  version?: string;
  title?: string;
  sourceUrl?: string;
  reason?: string;
}
export interface TranscriptSegment {
  id: string;
  sequence: number;
  text: string;
  speaker?: ChannelActor;
  startMs?: number;
  endMs?: number;
  artifactRef: ChannelResourceRef;
}
export interface MeetingSummary {
  artifact: MeetingArtifact;
  text: string;
  format: 'text' | 'markdown';
  todos?: readonly string[];
}
export interface MeetingArtifactsPort {
  readonly connection: ChannelConnection;
  inspectCapabilities(resource?: ChannelResourceRef): Promise<MeetingArtifactCapabilities>;
  /** Ref kinds preserve vendor namespaces; a minute token is not a meeting ID. */
  resolveMeeting(ref: ChannelResourceRef): Promise<{ source: ChannelResourceRef; meeting?: ChannelResourceRef }>;
  listArtifacts(ref: ChannelResourceRef): Promise<readonly MeetingArtifact[]>;
  getArtifact(ref: ChannelResourceRef): Promise<MeetingArtifact>;
  readTranscript(ref: ChannelResourceRef, query: ChannelQuery): Promise<ChannelPage<TranscriptSegment>>;
  readSummary(ref: ChannelResourceRef): Promise<MeetingSummary>;
}
export type ChannelErrorCode = 'invalid_request' | 'conflict' | 'unauthenticated' | 'forbidden' | 'unsupported' | 'not_ready' | 'not_found' | 'rate_limited' | 'temporarily_unavailable' | 'partial_failure' | 'delivery_unknown';
export class ChannelError extends Error {
  constructor(readonly code: ChannelErrorCode, message: string = code, readonly retryAfterMs?: number) {
    super(message); this.name = 'ChannelError';
  }
}
export function assertChannelResource(connection: ChannelConnection, ref: ChannelResourceRef): void {
  if (ref.connectionId !== connection.connectionId || ref.tenantId !== connection.tenantId || ref.provider !== connection.provider) throw new ChannelError('forbidden', 'channel_resource_scope_mismatch');
  if (!ref.externalId || ref.externalId.length > 2048) throw new ChannelError('invalid_request', 'invalid_channel_resource');
}
export function requireChannelCapability(capability: ChannelCapability): void {
  if (!capability.supported || capability.availability === 'unsupported') throw new ChannelError('unsupported');
  if (capability.availability !== 'available') throw new ChannelError('forbidden', 'channel_capability_not_authorized');
}
export interface ChannelWebhookRequest {
  headers: Readonly<Record<string, string | undefined>>;
  rawBody: string;
  receivedAt: number;
}
export type ChannelWebhookResult = { kind: 'challenge'; challenge: string } | { kind: 'message'; event: ChannelMessageEvent } | { kind: 'ignored' };
/** Trusted adapter boundary. Validation must precede returning any message or challenge. */
export interface ChannelWebhookPort {
  readonly connection: ChannelConnection;
  receiveWebhook(request: ChannelWebhookRequest): Promise<ChannelWebhookResult>;
}
