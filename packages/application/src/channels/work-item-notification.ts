/** Trusted origin-employee notification. It conveys no human or Trigger impersonation. */
export interface WorkItemNotificationScope{
 kind:'work_item_notification';workspaceId:string;entityId:string;workItemId:string;rootTaskId:string;noticeId:string;
 source:{connectionId:string;appId:string;bindingVersion:string;tenantId:string;conversationId:string;conversationKind:'private'|'group';channelType:'feishu'|'dingtalk'|'wecom';threadId?:string};
}
export function workItemNotificationScope(json:string):WorkItemNotificationScope|undefined{
 try{const v=JSON.parse(json)as WorkItemNotificationScope;if(v.kind!=='work_item_notification')return;
  if(![v.workspaceId,v.entityId,v.workItemId,v.rootTaskId,v.noticeId,v.source?.connectionId,v.source?.appId,v.source?.bindingVersion,v.source?.tenantId,v.source?.conversationId].every(x=>typeof x==='string'&&x.length>0)||!['private','group'].includes(v.source.conversationKind)||!['feishu','dingtalk','wecom'].includes(v.source.channelType)||v.source.threadId!==undefined&&typeof v.source.threadId!=='string')return;return v;
 }catch{return;}
}
