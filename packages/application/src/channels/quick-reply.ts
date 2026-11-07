import {createHash} from 'node:crypto';
import type {ChannelResourceRef} from './ports.js';

export const channelQuickReplies = {
  identity: '抱歉，无法验证身份',
  permission: '抱歉，您没有使用权限，请联系管理员',
  service: '抱歉，我暂时无法提供服务',
} as const;
export type ChannelQuickReplyKind = keyof typeof channelQuickReplies;
/** Routing facts from the current authenticated channel, never a model-supplied destination. */
export interface ChannelReplyRoute {
  workspaceId:string;entityId:string;connectionId:string;bindingVersion:string;appId:string;
  conversation:ChannelResourceRef;messageId:string;eventId:string;threadId?:string;lane?:string;sourceKey?:string;payloadHash?:string;
}
export interface ChannelQuickReplyScope {
  kind:'channel_quick_reply';route:ChannelReplyRoute;replyKind:ChannelQuickReplyKind;
  source:{connectionId:string};
}
/** Same group delivery lane as ordinary replies; a failed identity is never forged into a TaskScope. */
export function channelReplyLane(route:ChannelReplyRoute):string {
  if(route.lane)return route.lane;
  const c=route.conversation;
  const owner=c.conversationKind==='group'
    ?JSON.stringify(['group',c.provider,c.tenantId,route.connectionId,route.appId,route.connectionId,route.bindingVersion,c.externalId,route.threadId??''])
    :JSON.stringify(['quick-private',c.provider,c.tenantId,route.connectionId,c.externalId]);
  return createHash('sha256').update(JSON.stringify([route.workspaceId,route.entityId,owner])).digest('hex');
}
export function quickReplyScope(json:string):ChannelQuickReplyScope|undefined {
  const value=JSON.parse(json) as ChannelQuickReplyScope;
  if(value.kind!=='channel_quick_reply')return;
  if(!Object.hasOwn(channelQuickReplies,value.replyKind)||!value.route||value.source?.connectionId!==value.route.connectionId)throw Error('invalid_quick_reply');
  return value;
}
