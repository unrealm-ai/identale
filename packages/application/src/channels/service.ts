import { ChannelError, assertChannelResource, requireChannelCapability } from './ports.js';
import type { ChannelConnection, ChannelQuery, ChannelResourceRef, ChannelWebhookPort, ChannelWebhookRequest, ConversationPort, MeetingArtifactsPort, SendChannelMessage, ChannelMessageEvent, MeetingArtifact, ChannelActor } from './ports.js';
import { ChannelInteractionController } from './controller.js';
import type { ChannelInteractionDecision, ChannelInteractionPolicy } from './controller.js';
export interface ChannelAccessScope {
  workspaceId: string;
  entityId: string;
  requesterId: string;
  requesterKind: 'platform_user' | 'channel_user' | 'system';
  /** Trusted caller metadata; live ingress derives it only from the verified author. */
  requesterIdentity?: Pick<ChannelActor, 'idNamespace' | 'applicationId'>;
  conversationKind?: ChannelMessageEvent['message']['conversationKind'];
  /** Verified bot-group source supplied by ingress or persisted TaskScope, never request body. */
  groupContext?: {conversationId:string;bindingVersion:string};
}
export type ChannelOperation = 'inspect' | 'read_conversation' | 'read_history' | 'send' | 'read_meeting' | 'receive';
export interface ChannelAccessPolicy {
  /** Must validate the current entity/source binding and access; absence never means allow. */
  authorize(scope: ChannelAccessScope, connection: ChannelConnection, operation: ChannelOperation, resource?: ChannelResourceRef): Promise<boolean>;
}
export interface ChannelIntegration {
  connection: ChannelConnection;
  conversation?: ConversationPort;
  meetingArtifacts?: MeetingArtifactsPort;
  webhook?: ChannelWebhookPort;
  /** Fixed host-configured routing. Incoming payloads cannot choose a workspace/entity. */
  ingress?: { scope: Pick<ChannelAccessScope, 'workspaceId' | 'entityId'>; policy: ChannelInteractionPolicy };
}
export interface ChannelInboxSink {
  /** Atomically persist dedup key + event + decision before returning. A host-owned durable consumer executes it later. */
  accept(record: { key: string; scope: ChannelAccessScope; event: ChannelMessageEvent; decision: ChannelInteractionDecision }): Promise<'created' | 'duplicate'>;
}
export interface ChannelIntegrationOptions {
  integrations: readonly ChannelIntegration[];
  accessPolicy: ChannelAccessPolicy;
  inbox?: ChannelInboxSink;
}
/** Controlled composition API, not a public HTTP/LLM JSON endpoint. */
export class ChannelIntegrationService {
  private readonly integrations = new Map<string, ChannelIntegration>();
  private readonly controller = new ChannelInteractionController();
  constructor(private readonly options: ChannelIntegrationOptions) {
    for (const integration of options.integrations) {
      const c = integration.connection;
      if (!c.workspaceId || !c.connectionId || !c.tenantId || !c.credentialRef || this.integrations.has(c.connectionId)) throw new ChannelError('invalid_request', 'invalid_channel_connection');
      for (const port of [integration.conversation, integration.meetingArtifacts, integration.webhook]) {
        if (port && (port.connection.workspaceId !== c.workspaceId || port.connection.connectionId !== c.connectionId || port.connection.tenantId !== c.tenantId || port.connection.provider !== c.provider || port.connection.identity.kind !== c.identity.kind || port.connection.identity.externalId !== c.identity.externalId || port.connection.credentialRef !== c.credentialRef)) throw new ChannelError('invalid_request', 'channel_adapter_connection_mismatch');
      }
      if (integration.ingress && integration.ingress.scope.workspaceId !== c.workspaceId) throw new ChannelError('forbidden', 'channel_ingress_workspace_mismatch');
      this.integrations.set(c.connectionId, {...integration, connection: Object.freeze({...c, identity:Object.freeze({...c.identity})}), ...(integration.ingress ? {ingress:{scope:Object.freeze({...integration.ingress.scope}),policy:Object.freeze({...integration.ingress.policy,ownSenderIds:Object.freeze([...integration.ingress.policy.ownSenderIds]),...(integration.ingress.policy.groupTriggerKeywords?{groupTriggerKeywords:Object.freeze([...integration.ingress.policy.groupTriggerKeywords])}:{})})}} : {})});
    }
  }
  private async authorized(scope: ChannelAccessScope, id: string, operation: ChannelOperation, resource?: ChannelResourceRef) {
    const integration = this.integrations.get(id);
    if (!integration || scope.workspaceId !== integration.connection.workspaceId || !scope.entityId || !scope.requesterId) throw new ChannelError('forbidden');
    if (resource) assertChannelResource(integration.connection, resource);
    if (!await this.options.accessPolicy.authorize(scope, integration.connection, operation, resource)) throw new ChannelError('forbidden');
    return integration;
  }
  async inspectCapabilities(scope: ChannelAccessScope, id: string, resource?: ChannelResourceRef) {
    const i = await this.authorized(scope, id, 'inspect', resource);
    return { conversation: i.conversation && (!resource || resource.kind === 'conversation') ? await i.conversation.inspectCapabilities(resource) : null, meetingArtifacts: i.meetingArtifacts && (!resource || resource.kind !== 'conversation') ? await i.meetingArtifacts.inspectCapabilities(resource) : null };
  }
  async getConversation(scope: ChannelAccessScope, ref: ChannelResourceRef) {
    const i = await this.authorized(scope, ref.connectionId, 'read_conversation', ref);
    if (!i.conversation) throw new ChannelError('unsupported');
    const result = await i.conversation.getConversation(ref);
    assertChannelResource(i.connection, result.ref);
    if (result.ref.externalId !== ref.externalId) throw new ChannelError('forbidden', 'channel_response_resource_mismatch');
    return result;
  }
  async listMessages(scope: ChannelAccessScope, ref: ChannelResourceRef, query: ChannelQuery) {
    const i = await this.authorized(scope, ref.connectionId, 'read_history', ref);
    if (!i.conversation) throw new ChannelError('unsupported');
    requireChannelCapability((await i.conversation.inspectCapabilities(ref)).historyRead);
    const result = await i.conversation.listMessages(ref, query);
    for (const message of result.items) { assertChannelResource(i.connection, message.conversation); if (message.conversation.externalId !== ref.externalId) throw new ChannelError('forbidden', 'channel_response_resource_mismatch'); }
    return result;
  }
  async sendMessage(scope: ChannelAccessScope, request: SendChannelMessage) {
    const i = await this.authorized(scope, request.conversation.connectionId, 'send', request.conversation);
    if (!i.conversation) throw new ChannelError('unsupported');
    const caps = await i.conversation.inspectCapabilities(request.conversation);
    requireChannelCapability(request.replyToMessageId ? caps.replyToMessage : caps.proactiveSend);
    // No retries here: unknown delivery must not become duplicate business output.
    return i.conversation.sendMessage(request);
  }
  private async meetings(scope: ChannelAccessScope, ref: ChannelResourceRef) {
    const i = await this.authorized(scope, ref.connectionId, 'read_meeting', ref);
    if (!i.meetingArtifacts) throw new ChannelError('unsupported');
    return i.meetingArtifacts;
  }
  private assertRef(connection: ChannelConnection, actual: ChannelResourceRef, expected?: ChannelResourceRef) {
    assertChannelResource(connection, actual);
    if (expected && (actual.kind !== expected.kind || actual.externalId !== expected.externalId)) throw new ChannelError('forbidden', 'channel_response_resource_mismatch');
  }
  private assertArtifact(connection: ChannelConnection, artifact: MeetingArtifact, expected?: ChannelResourceRef) {
    this.assertRef(connection, artifact.ref, expected); this.assertRef(connection, artifact.sourceRef);
    if (artifact.meetingRef) this.assertRef(connection, artifact.meetingRef);
  }
  async resolveMeeting(scope: ChannelAccessScope, ref: ChannelResourceRef) {
    const port = await this.meetings(scope, ref); const result = await port.resolveMeeting(ref);
    this.assertRef(port.connection, result.source, ref); if (result.meeting) this.assertRef(port.connection, result.meeting); return result;
  }
  async listArtifacts(scope: ChannelAccessScope, ref: ChannelResourceRef) {
    const port = await this.meetings(scope, ref); const results = await port.listArtifacts(ref);
    for (const artifact of results) { this.assertArtifact(port.connection, artifact); this.assertRef(port.connection, artifact.sourceRef, ref); }
    return results;
  }
  async getArtifact(scope: ChannelAccessScope, ref: ChannelResourceRef) {
    const port = await this.meetings(scope, ref); const result = await port.getArtifact(ref); this.assertArtifact(port.connection, result, ref); return result;
  }
  async readTranscript(scope: ChannelAccessScope, ref: ChannelResourceRef, query: ChannelQuery) {
    const port = await this.meetings(scope, ref); requireChannelCapability((await port.inspectCapabilities(ref)).transcriptRead);
    const result = await port.readTranscript(ref, query);
    for (const segment of result.items) this.assertRef(port.connection, segment.artifactRef, ref);
    return result;
  }
  async readSummary(scope: ChannelAccessScope, ref: ChannelResourceRef) {
    const port = await this.meetings(scope, ref); requireChannelCapability((await port.inspectCapabilities(ref)).officialSummaryRead);
    const result = await port.readSummary(ref); this.assertArtifact(port.connection, result.artifact, ref); return result;
  }
  async receiveWebhook(connectionId: string, request: ChannelWebhookRequest) {
    const i = this.integrations.get(connectionId);
    if (!i?.webhook || !i.ingress || !i.conversation) throw new ChannelError('unsupported', 'channel_ingress_not_configured');
    if (!this.options.inbox) throw new ChannelError('unsupported', 'durable_channel_inbox_required');
    // Only the registered adapter can construct the event. No public accept(event) escape hatch.
    const result = await i.webhook.receiveWebhook(request);
    if (result.kind !== 'message') return result;
    const event = result.event;
    if (event.connectionId !== connectionId || event.tenantId !== i.connection.tenantId || event.origin !== 'live' || !event.eventId) throw new ChannelError('forbidden', 'channel_event_scope_mismatch');
    if (event.message.author.identityEvidence !== 'channel_verified' || !event.message.author.externalId || event.message.author.kind !== 'human') return {kind:'ignored' as const};
    const author = event.message.author;
    const target = event.message.conversation;
    if (target.kind !== 'conversation' || (target.conversationKind && target.conversationKind !== event.message.conversationKind)) throw new ChannelError('forbidden','channel_conversation_kind_mismatch');
    if (target.privateRecipientId && (event.message.conversationKind !== 'private' || target.privateRecipientId !== author.externalId)) throw new ChannelError('forbidden','channel_private_recipient_mismatch');
    const scope: ChannelAccessScope = {
      ...i.ingress.scope, requesterKind:'channel_user', requesterId:author.externalId!,
      ...(event.message.conversationKind ? {conversationKind:event.message.conversationKind} : {}),
      requesterIdentity: Object.freeze({
        ...(author.idNamespace ? {idNamespace:author.idNamespace} : {}),
        ...(author.applicationId ? {applicationId:author.applicationId} : {}),
      }),
    };
    await this.authorized(scope, connectionId, 'receive', event.message.conversation);
    const caps = await i.conversation.inspectCapabilities(event.message.conversation);
    const mentioned = event.message.mentions.includes(i.ingress.policy.entityMentionId);
    const isPrivate = event.message.conversationKind === 'private';
    requireChannelCapability(isPrivate ? caps.privateMessageEvents ?? {supported:false,availability:'unsupported'} : mentioned ? caps.mentionEvents : caps.ordinaryMessageEvents);
    if (!isPrivate && i.ingress.policy.mode !== 'mentions_only') requireChannelCapability(caps.ordinaryMessageEvents);
    const decision = this.controller.decide(event, i.ingress.policy, caps);
    const key = JSON.stringify([scope.workspaceId, scope.entityId, connectionId, event.tenantId, event.eventId, event.revision ?? 'initial']);
    const status = await this.options.inbox.accept({ key, scope, event, decision });
    return { kind: 'accepted' as const, status, decision };
  }
}
