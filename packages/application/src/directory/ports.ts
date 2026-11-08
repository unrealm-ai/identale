/** Read-only employee application directory queries; no organization snapshots. */
export type DirectoryProvider = 'feishu' | 'dingtalk' | 'wecom';
export type DirectoryFact<T> = {status:'known';value:T}|{status:'unknown'};
export interface DirectoryIdentity {
  tenantId:string;
  tenantIdNamespace:'tenant_key'|'display_id'|'corp_id'|'app_id';
  appId:string;
}
export interface DirectoryExternalId {id:string;namespace:'open_id'|'user_id'|'union_id';applicationId?:string}
export interface DirectoryPerson {
  id:DirectoryExternalId;
  displayName:string;
  /** Optional provider-supplied presentation metadata; never an authorization role. */
  jobTitle?:string;
  status:'active'|'inactive'|'unknown';
  departmentIds:readonly string[];
  departmentMembershipsKnown:boolean;
  primaryDepartmentId:DirectoryFact<string|null>;
  directManager:DirectoryFact<DirectoryExternalId|null>;
  dottedLineManagers:DirectoryFact<readonly DirectoryExternalId[]>;
  /** Only aliases returned and verified by the same provider API. */
  aliases:readonly DirectoryExternalId[];
}
export interface DirectoryDepartment {
  id:string;namespace:'open_department_id'|'department_id';displayName:string;
  parentId:DirectoryFact<string|null>;
  leaders:DirectoryFact<readonly DirectoryExternalId[]>;
}
export interface DirectoryPage<T> {items:readonly T[];nextCursor?:string;exhausted:boolean}
export interface DirectoryAuthorizedScope {
  departmentIds:readonly string[];
  userIds:readonly DirectoryExternalId[];
  /** Missing provider entry fields are undisclosed, not proof that no direct grants exist. */
  disclosed?:{departments:boolean;users:boolean};
  /** true only when the official scope explicitly grants the entire organization. */
  entireOrganization:boolean;
  /** Stable revision/digest of authorized scope, not a credential. */
  revision:string;
}
export interface DirectoryCapabilities {
  scopedQueries:boolean;
  incrementalEvents:false;
  directManager:boolean;dottedLineManagers:boolean;departmentLeaders:boolean;
}
/** Constructed only by trusted infrastructure; secrets never appear in application DTOs. */
export interface DirectoryPort {
  readonly provider:DirectoryProvider;
  readonly capabilities:DirectoryCapabilities;
  verify():Promise<DirectoryIdentity>;
  getAuthorizedScope():Promise<DirectoryAuthorizedScope>;
  getDepartment(id:string):Promise<DirectoryDepartment>;
  listChildDepartments(parentId:string,cursor?:string):Promise<DirectoryPage<DirectoryDepartment>>;
  listDepartmentMembers(departmentId:string,cursor?:string):Promise<DirectoryPage<DirectoryPerson>>;
  getUser(id:DirectoryExternalId):Promise<DirectoryPerson>;
}
export interface DirectoryMemberSearch {
  search(keywords: readonly string[]): Promise<{
    members: readonly {id:string;displayName:string;departmentPaths:readonly string[]}[];
    limited:boolean;
  }>;
}
export type DirectoryErrorCode='authentication_failed'|'authorization_denied'|'invalid_response'|'unavailable'|'unsupported'|'limit_exceeded';
export class DirectoryError extends Error {
  constructor(readonly code:DirectoryErrorCode){super(code);}
}
export interface DirectorySubjectRef {
  sourceId:string;
  kind:'channel_user'|'department';
  /** Opaque app-scoped external subject identifier, not a local directory row. */
  subjectId:string;
  includeDescendants?:boolean;
}
export interface DirectoryAccessRule extends DirectorySubjectRef {
  conversationKinds:readonly ('private'|'group'|'meeting')[];
}
export interface DirectoryChannelPolicy {sourceId:string;mode:'all'|'allowlist'|'denylist';allow:readonly DirectoryAccessRule[];deny:readonly DirectoryAccessRule[];allowGroupMembers?:boolean;revision:number}
/** Package rules only narrow this source's effective employee policy. */
export interface DirectoryPackageChannelPolicy {sourceId:string;mode:'inherit'|'allowlist'|'denylist';allow:readonly DirectoryAccessRule[];deny:readonly DirectoryAccessRule[];/** Preserve legacy inherited allow-list unknown-fact checks until the source mode is explicitly changed. */legacyAllowCheck?:true}
export interface DirectoryAccessConfig {channelPolicies?:readonly DirectoryChannelPolicy[];allowGroupMembers?:boolean;allow:readonly DirectoryAccessRule[];deny:readonly DirectoryAccessRule[];revision:number}

