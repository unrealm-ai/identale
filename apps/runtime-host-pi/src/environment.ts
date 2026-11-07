import type { InvocationContext } from '@dentity/domain';
/** Identity derives exclusively from a verified platform context, never arbitrary metadata. */
export function invocationEnvironment(c: InvocationContext): Record<string, string> {
  const env: Record<string, string> = {
    DENTITY_CONTEXT_VERSION: '1', DENTITY_ENTITY_ID: c.entityId, DENTITY_WORKSPACE_ID: c.workspaceId,
    DENTITY_TRIGGER_KIND: c.trigger.kind, DENTITY_REQUESTER_PRESENT: String(c.trigger.kind === 'human_request'),
    DENTITY_TRIGGER_ID: c.triggerId, DENTITY_SOURCE_EVENT_ID: c.sourceEventRef,
    DENTITY_INVOCATION_ID: c.invocationId, DENTITY_SESSION_ID: c.sessionId,
    DENTITY_CONFIG_REVISION: c.configRevision, DENTITY_CONTEXT_EXPIRES_AT: c.expiresAt,
  };
  if (c.trigger.kind === 'human_request') {
    env['DENTITY_REQUESTER_ID'] = c.trigger.requester.externalUserId;
    env['DENTITY_REQUESTER_NAMESPACE'] = c.trigger.requester.identityNamespace;
  } else if(c.trigger.kind==='configured_event')env['DENTITY_TRIGGER_BINDING_ID'] = c.trigger.triggerBindingId;
  else if(c.trigger.kind==='work_item_assignment'){env['DENTITY_WORK_ITEM_ID']=c.trigger.workItemId;env['DENTITY_ASSIGNMENT_ID']=c.trigger.assignmentId;}
  if (c.sourceChannel) Object.assign(env, { DENTITY_CHANNEL_TYPE: c.sourceChannel.channelType,
    DENTITY_CHANNEL_TENANT_ID: c.sourceChannel.tenantId, DENTITY_CHANNEL_INSTALLATION_ID: c.sourceChannel.installationId });
  if (c.conversation) { Object.assign(env, { DENTITY_CONVERSATION_ID: c.conversation.conversationId, DENTITY_CONVERSATION_KIND: c.conversation.kind });
    if (c.conversation.threadId) env['DENTITY_THREAD_ID'] = c.conversation.threadId; }
  if (c.target.kind === 'task_run') Object.assign(env, { DENTITY_TASK_ID: c.target.taskId, DENTITY_RUN_ID: c.target.runId });
  return env;
}
