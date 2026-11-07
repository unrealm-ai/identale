export type DirectoryProvider = 'feishu' | 'dingtalk' | 'wecom';
export type ConversationKind = 'private' | 'group' | 'meeting';
export interface DirectoryConnection {
  transport: { state: 'stopped' | 'connecting' | 'connected' | 'reconnecting' | 'failed'; changedAt: number; error?: string; lastConnectedAt?: number; lastDisconnectedAt?: number };
  id: string; sourceId: string; entityId: string; provider: DirectoryProvider; appId: string;
  tenantId: string; tenantIdNamespace: string; botId?: string; revision: number; authRevision: number;
  status: 'verified' | 'pending_verification' | 'invalid' | 'disabled';
  identityEvidence: 'provider_api' | 'authenticated_event_confirmed' | 'app_credentials_only' | 'admin_asserted'; inboundVerified: boolean;
  directoryBinding?: { credentialId: string; corpId: string; agentId: string; sourceRevision: number; credentialRevision: number; scopeRevision: string; status: 'confirmed' | 'reconfirmation_required'; assertion: { evidence: 'admin_asserted'; actorId: string; confirmedAt: number; botId: string; corpId: string; credentialRevision: number } };
  groupListeningStatus?: {enabled:boolean;permission:string;cachedMessages:number};
  context: { historyEnabled: boolean; groupListenEnabled?: boolean; groupTriggerKeywords?: string[]; meetingRefs: { kind: 'minutes'; externalId: string }[] };
  directoryStatus: 'available' | 'unavailable'; lastError?: string | null; enabled: boolean;
}
export interface DirectoryItem { externalId: string; subjectId: string; displayName: string; kind: 'channel_user' | 'department' }
export interface DirectoryPage { sourceId: string; provider: DirectoryProvider; appId: string; items: DirectoryItem[]; nextCursor?: string; exhausted: boolean }
export interface DirectorySubjects { sources: DirectoryConnection[]; users: never[]; departments: never[] }
export interface DirectoryAccessRule {
  sourceId: string; kind: 'channel_user' | 'department'; subjectId: string;
  includeDescendants?: boolean; conversationKinds: ConversationKind[];
}
export interface DirectoryAccess { allowGroupMembers?: boolean; allow: DirectoryAccessRule[]; deny: DirectoryAccessRule[]; revision: number }
export const providerLabel = (provider: DirectoryProvider): string => ({ feishu: '飞书', dingtalk: '钉钉', wecom: '企业微信' })[provider];
export const directoryStatusLabel = (connection: DirectoryConnection): string => ({ verified: '机器人已验证', pending_verification: '等待机器人身份验证', invalid: '连接失效', disabled: '已停用' })[connection.status];
