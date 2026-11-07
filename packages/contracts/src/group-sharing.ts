/** Configuration references are application scoped. Labels never establish identity. */
export interface SharingIdentity {
  provider:'feishu'; connectionId:string; appId:string; tenantId:string; bindingVersion:string;
}
export interface SharingGroup extends SharingIdentity {kind:'group';id:string;label:string}
export interface SharingPerson extends SharingIdentity {kind:'person';id:string;namespace:'open_id';label:string}
export type SharingDestination=SharingGroup|SharingPerson;
export interface GroupSharingRule {
  id:string;revision:number;name:string;enabled:boolean;
  type:'mutual'|'directed';sources:SharingGroup[];targets:SharingDestination[];
}
export interface GroupSharingSnapshot {
  version:1;revision:number;workspaceId:string;entityId:string;destination:SharingDestination;
  /** Only direct sources for this destination. Never a transitive closure. */
  destinationThreadId?:string;
  /** Verified channel input binding. Absence preserves legacy topic grants. */
  topicRead?:{threadId:string;chatId:string;messageId:string};
  sources:{group:SharingGroup;rules:{id:string;revision:number}[]}[];
}
/** A narrowly scoped transport capability, held by trusted tool infrastructure only. */
export interface GroupHistoryAccess {version:1;endpoint:string;credential:string;runId:string;hostId:string}
export interface GroupHistoryQuery {groupRef:string;startAt?:number;endAt?:number;order?:'asc'|'desc';cursor?:string;limit?:number}

export type ContextHistoryOperation='list'|'read'|'contexts'|'trigger_list'|'trigger_record';
