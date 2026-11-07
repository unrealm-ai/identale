/** Internal outbox route, created only by the trusted Trigger result publisher.
 * It deliberately has no synthetic human or Conversation. Persistence policy must
 * verify it against the frozen task destination before every send. */
export interface TriggerResultScope {
 kind:'trigger_result_notification';workspaceId:string;entityId:string;taskId:string;runId:string;
 source:{connectionId:string;appId:string;bindingVersion:string;tenantId:string;conversationId:string;conversationKind:'group';channelType:'feishu'|'dingtalk'|'wecom';threadId?:never};
}
export function triggerResultScope(json:string):TriggerResultScope|undefined {
 try{const v=JSON.parse(json) as TriggerResultScope;if(v.kind!=='trigger_result_notification')return;
 if(![v.workspaceId,v.entityId,v.taskId,v.runId,v.source?.connectionId,v.source?.appId,v.source?.bindingVersion,v.source?.tenantId,v.source?.conversationId].every(x=>typeof x==='string'&&x.length>0)||v.source.conversationKind!=='group'||!['feishu','dingtalk','wecom'].includes(v.source.channelType)||v.source.threadId!==undefined)throw Error();return v;
 }catch{return;}
}
