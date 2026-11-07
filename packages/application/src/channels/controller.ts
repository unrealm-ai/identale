import type { ChannelMessageEvent, ConversationCapabilities } from './ports.js';
import { ChannelError } from './ports.js';
export interface ChannelInteractionPolicy {
  mode: 'mentions_only' | 'observe' | 'participate';
  /** Channel bot ID, not the credential owner's ID. */
  entityMentionId: string;
  ownSenderIds: readonly string[];
  groupTriggerKeywords?: readonly string[];
}
export type ChannelInteractionDecision =
  | { action: 'ignore'; reason: 'self_message' | 'non_human_sender' | 'unverified_sender' | 'not_mentioned' }
  | { action: 'context_only'; reason: 'history_backfill' | 'not_mentioned' }
  | { action: 'invoke'; reason: 'mentioned' | 'private_message' | 'provider_directed_bot' | 'keyword' }
  | { action: 'consider_reply'; reason: 'participation_enabled' };
/** Only the authenticated new human message body participates; display/asset/mention metadata do not. */
export function matchesGroupKeyword(event:ChannelMessageEvent,keywords:readonly string[]=[]):boolean {
  const m=event.message;
  if(event.origin!=='live'||m.conversation.provider!=='feishu'||m.conversationKind!=='group'||m.author.kind!=='human')return false;
  const segments:string[]=[];
  if(m.content){for(const block of m.content.blocks){let text='';for(const node of block){if(['text','markdown','code','link'].includes(node.type)&&'text'in node)text+=node.text;else{if(text)segments.push(text);text='';}}if(text)segments.push(text);}}
  else segments.push(m.text);
  const words=keywords.map(word=>word.trim().toLowerCase()).filter(Boolean);
  return segments.some(text=>words.some(word=>text.toLowerCase().includes(word)));
}
/** Scheduling policy only. consider_reply asks a consumer to run its semantic decision, not another LLM loop here. */
export class ChannelInteractionController {
  decide(event: ChannelMessageEvent, policy: ChannelInteractionPolicy, capabilities: ConversationCapabilities): ChannelInteractionDecision {
    const author = event.message.author;
    if (author.externalId && policy.ownSenderIds.includes(author.externalId)) return { action: 'ignore', reason: 'self_message' };
    if (author.kind !== 'human' && author.kind !== 'bot') return { action: 'ignore', reason: 'non_human_sender' };
    if (author.identityEvidence !== 'channel_verified' || !author.externalId) return { action: 'ignore', reason: 'unverified_sender' };
    if (event.origin === 'history') return { action: 'context_only', reason: 'history_backfill' };
    if (event.message.conversationKind === 'private') {
      if (!capabilities.privateMessageEvents?.supported || capabilities.privateMessageEvents.availability !== 'available') throw new ChannelError('unsupported', 'private_message_events_required');
      return { action: 'invoke', reason: 'private_message' };
    }
    if (event.message.conversationKind === 'group' && event.message.conversation.provider === 'wecom' && event.message.providerDirectedBot === true) {
      if (!capabilities.directedBotMessageEvents?.supported || capabilities.directedBotMessageEvents.availability !== 'available') throw new ChannelError('unsupported', 'directed_bot_message_events_required');
      return { action: 'invoke', reason: 'provider_directed_bot' };
    }
    if (event.message.mentions.includes(policy.entityMentionId)) return { action: 'invoke', reason: 'mentioned' };
    if (matchesGroupKeyword(event,policy.groupTriggerKeywords)) return {action:'invoke',reason:'keyword'};
    if (policy.mode === 'participate') {
      if (!capabilities.ordinaryMessageEvents.supported || capabilities.ordinaryMessageEvents.availability !== 'available') throw new ChannelError('unsupported', 'ordinary_message_events_required');
      return { action: 'consider_reply', reason: 'participation_enabled' };
    }
    return policy.mode === 'mentions_only' ? { action: 'ignore', reason: 'not_mentioned' } : { action: 'context_only', reason: 'not_mentioned' };
  }
}
