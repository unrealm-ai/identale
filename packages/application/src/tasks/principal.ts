import type {AssignmentTaskSource} from '@dentity/contracts';
import type { ChannelPrincipalRef } from '@dentity/domain';
export interface BusinessTaskSource {triggerId:string;bindingVersion:number;eventRecordId:string;sourceKind:'webhook'|'github_issue'|'schedule'}
export type Principal = {kind:'platform';userId:string} | ({kind:'channel'} & ChannelPrincipalRef) | {kind:'business_event';triggerId:string;eventRecordId:string} | {kind:'work_item_assignment';assignment:AssignmentTaskSource};
export interface ChannelTaskSource {channelType:string;tenantId:string;installationId:string;applicationId:string;connectionId:string;bindingVersion:string;conversationId:string;conversationKind:'private'|'group';threadId?:string;sourceEventId?:string;replyToMessageId?:string}
export type TaskScope = {workspaceId:string;entityId:string} & (
  {userId:string;principal?:never;source?:never;business?:never;assignment?:never} |
  {userId?:never;principal:Extract<Principal,{kind:'channel'}>;source:ChannelTaskSource;business?:never;assignment?:never} |
  {userId?:never;principal?:never;source?:never;business:BusinessTaskSource;assignment?:never} |
  {userId?:never;principal?:never;source?:never;business?:never;assignment:AssignmentTaskSource}
);
/** Trigger tasks have no human conversation. Null is persisted, never a fabricated conversation ID. */
export type TaskRequestContext = TaskScope & {conversationId:string|null};
export function scopePrincipal(scope:TaskScope):Principal{if(scope.assignment)return{kind:'work_item_assignment',assignment:scope.assignment};if(scope.business)return{kind:'business_event',triggerId:scope.business.triggerId,eventRecordId:scope.business.eventRecordId};return scope.principal??{kind:'platform',userId:scope.userId};}
export function platformUserId(scope:TaskScope):string|null{return scope.principal||scope.business||scope.assignment?null:scope.userId;}
export function scopeActorKey(scope:TaskScope):string {const p=scopePrincipal(scope);return JSON.stringify(p.kind==='work_item_assignment'?['work_item_assignment',p.assignment.workItemId,p.assignment.assignmentId,p.assignment.grantId]:p.kind==='platform'?['platform',p.userId]:p.kind==='business_event'?['business_event',p.triggerId]:['channel',p.channelType,p.tenantId,p.identityNamespace,p.externalUserId,scope.source!.applicationId,scope.source!.connectionId]);}
export function scopeRequester(scope:TaskScope):ChannelPrincipalRef{if(scope.business||scope.assignment)throw new Error('business_event_has_no_human_requester');if(scope.principal){const {kind,...requester}=scope.principal;void kind;return requester;}return {channelType:'web',tenantId:scope.workspaceId,identityNamespace:'platform-user',externalUserId:scope.userId};}
export function scopeSource(scope:TaskScope){if(scope.business||scope.assignment)throw new Error('business_event_has_no_channel');return scope.source??{channelType:'web',tenantId:scope.workspaceId,installationId:'web',conversationKind:'private' as const};}
export function conversationOwnerKey(scope:TaskScope):string {if(scope.business||scope.assignment||!scope.source)return scopeActorKey(scope);const s=scope.source;return JSON.stringify([s.conversationKind,s.channelType,s.tenantId,s.installationId,s.applicationId,s.connectionId,s.bindingVersion,s.conversationId,s.threadId??'',...(s.conversationKind==='private'?[scopeActorKey(scope)]:[])]);}
export function scopeFromJson(json:string|null|undefined,legacy?:{workspaceId:string;entityId:string;userId:string|null}):TaskScope {
  const value:unknown=json?JSON.parse(json):null;
  if(value&&typeof value==='object'){
    const s=value as TaskScope;
    if(typeof s.workspaceId==='string'&&s.workspaceId&&typeof s.entityId==='string'&&s.entityId){
      if(s.assignment){const a=s.assignment;if(s.userId!==undefined||s.principal||s.source||s.business||Object.keys(a).some(k=>!['workItemId','assignmentId','grantId','rootTaskId','sourceEmployeeId','targetEmployeeId'].includes(k))||!['workItemId','assignmentId','grantId','rootTaskId','sourceEmployeeId','targetEmployeeId'].every(k=>typeof a[k as keyof AssignmentTaskSource]==='string'&&a[k as keyof AssignmentTaskSource].length>0)||a.targetEmployeeId!==s.entityId)throw new Error('invalid_persisted_task_scope');return s;}
      if(s.business){const b=s.business;if(s.userId!==undefined||s.principal||s.source||![b.triggerId,b.eventRecordId].every(v=>typeof v==='string'&&v.length>0)||!Number.isSafeInteger(b.bindingVersion)||b.bindingVersion<1||!['webhook','github_issue','schedule'].includes(b.sourceKind))throw new Error('invalid_persisted_task_scope');return s;}
      if(typeof s.userId==='string'&&s.userId&&!s.principal&&!s.source&&!s.assignment)return {workspaceId:s.workspaceId,entityId:s.entityId,userId:s.userId};
      const p=s.principal,source=s.source;
      if(p?.kind==='channel'&&s.userId===undefined&&source&&[p.channelType,p.tenantId,p.identityNamespace,p.externalUserId,source.channelType,source.tenantId,source.installationId,source.applicationId,source.connectionId,source.bindingVersion,source.conversationId].every(v=>typeof v==='string'&&v.length>0)&&p.channelType!=='web'&&p.channelType===source.channelType&&p.tenantId===source.tenantId&&['private','group'].includes(source.conversationKind)&& [source.threadId,source.sourceEventId,source.replyToMessageId].every(v=>v===undefined||typeof v==='string'))return s;
      throw new Error('invalid_persisted_task_scope');
    }
  }
  if(value&&typeof value==='object'&&('assignment' in value||'business' in value||'principal' in value||'source' in value||('channelType' in value&&value.channelType!=='web')))throw new Error('invalid_persisted_task_scope');
  if(legacy?.userId)return {workspaceId:legacy.workspaceId,entityId:legacy.entityId,userId:legacy.userId};
  throw new Error('missing_persisted_task_scope');
}
