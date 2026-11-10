export type DirectoryProvider = 'feishu' | 'dingtalk' | 'wecom';
export type ConversationKind = 'private' | 'group' | 'meeting';
export interface ChannelCapability { supported: boolean; availability: 'available' | 'authorization_required' | 'unsupported' | 'unknown'; reason?: string }
export interface ChannelConfigurationCapabilities {
  privateMessages: ChannelCapability; groupMentions: ChannelCapability; directedGroupMessages?: ChannelCapability;
  ordinaryGroupMessages: ChannelCapability; keywordTriggers: ChannelCapability; recentGroupContext: ChannelCapability;
  directoryRead: ChannelCapability; meetingRead: ChannelCapability; documentRead: ChannelCapability;
  media?: { inbound: Record<'private' | 'group', Record<'image' | 'file', ChannelCapability>>; outbound: Record<'private' | 'group', Record<'image' | 'file', ChannelCapability>> };
}
export interface DirectoryConnection {
  capabilities?: ChannelConfigurationCapabilities;
  transport: { state: 'stopped' | 'connecting' | 'connected' | 'reconnecting' | 'failed'; changedAt: number; error?: string; lastConnectedAt?: number; lastDisconnectedAt?: number };
  id: string; sourceId: string; entityId: string; provider: DirectoryProvider; appId: string;
  tenantId: string; tenantIdNamespace: string; botId?: string; revision: number; authRevision: number;
  status: 'verified' | 'pending_verification' | 'invalid' | 'disabled';
  identityEvidence: 'provider_api' | 'authenticated_event_confirmed' | 'authenticated_first_message' | 'app_credentials_only' | 'admin_asserted'; inboundVerified: boolean;
  groupListeningStatus?: {enabled:boolean;permission:string;cachedMessages:number};
  context: { historyEnabled: boolean; groupListenEnabled?: boolean; groupTriggerKeywords?: string[]; meetingRefs: { kind: 'minutes'; externalId: string }[] };
  directoryStatus: 'available' | 'unavailable'; lastError?: string | null; enabled: boolean;
  directoryMode?:'member_search';
  memberSearchIdentityVerified?:boolean;
  memberSearchVerifiedUserIds?:string[];
}
export interface DirectoryItem { identityVerified?: boolean; externalId: string; subjectId: string; displayName: string; kind: 'channel_user' | 'department'; departmentPaths?:string[] }
export interface DirectoryPage { sourceId: string; provider: DirectoryProvider; appId: string; items: DirectoryItem[]; nextCursor?: string; exhausted: boolean; limited?:boolean; snapshotVersion?:number; sync?:DirectorySyncStatus }
export interface DirectorySubjects { sources: DirectoryConnection[]; users: never[]; departments: never[] }
export interface DirectoryAccessRule {
  sourceId: string; kind: 'channel_user' | 'department'; subjectId: string;
  includeDescendants?: boolean; conversationKinds: ConversationKind[];
}
export type ChannelAccessMode = 'all' | 'allowlist' | 'denylist';
export interface ChannelAccessPolicy { sourceId: string; mode: ChannelAccessMode; allowGroupMembers?: boolean; allow: DirectoryAccessRule[]; deny: DirectoryAccessRule[]; revision: number }
export interface DirectoryAccess { channelPolicies?: ChannelAccessPolicy[]; allowGroupMembers?: boolean; allow: DirectoryAccessRule[]; deny: DirectoryAccessRule[]; revision: number }
export const providerLabel = (provider: DirectoryProvider): string => ({ feishu: '飞书', dingtalk: '钉钉', wecom: '企业微信' })[provider];
export const directoryStatusLabel = (connection: DirectoryConnection): string => ({
  verified:'机器人已验证',pending_verification:connection.provider==='feishu'?(connection.botId?'等待首条消息确认租户':'机器人身份不完整'):'等待首条消息',invalid:'连接失效',disabled:'已停用',
})[connection.status];

export interface PackageChannelPolicy { sourceId: string; legacyAllowCheck?: true; mode: 'inherit' | 'allowlist' | 'denylist'; allow: DirectoryAccessRule[]; deny: DirectoryAccessRule[] }
export interface PackageDirectoryAccess { allow: DirectoryAccessRule[]; deny: DirectoryAccessRule[]; channelPolicies?: PackageChannelPolicy[] }

export interface DirectoryIdentityEvidence { sourceId: string; authRevision: number; userId: string }

export interface DirectorySyncStatus {
 connectionId:string; snapshotVersion:number; running:boolean; hasSnapshot:boolean; stale:boolean;
 lastSuccessAt:number|null; lastResult:'never'|'success'|'failure'|'invalidated';
 progress?:{userCount:number;departmentCount:number}; partSummary?:{total:number;succeeded:number;failed:number;blocked:number;running:number};
}
