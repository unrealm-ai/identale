import type {ChannelActor,ChannelConnection,ChannelResourceRef,ConversationPort,MeetingArtifactsPort,DirectoryIdentity,DirectoryProvider,DirectoryPort} from '@dentity/application';
import type {SealedDirectoryCredential} from '../directory/secrets.js';
import type {ChannelValidation} from './validation.js';
export interface WeComMemberChallenge {requestId:string;userId:string;authRevision:number;phraseHash:string;createdAt:number;expiresAt:number;status:'pending'|'verified'|'failed';issuedAt:number;completedAt?:number;method:'administrator_relay';createdBy:string}
export interface WeComContactMapping {userId:string;callbackUserId:string;verifiedAt:number;requestId:string;method:'administrator_relay'}
export interface EmployeeChannelRecord {
 id:string; sourceId:string;workspaceId:string;entityId:string;provider:DirectoryProvider;appId:string;
 /** botId is provider-canonical: DingTalk robotCode, Feishu open_id, WeCom BotID. */
 identity:DirectoryIdentity;botId?:string;robotCode?:string;eventTenantId?:string;revision:number;authRevision:number;stateVersion:number;
 status:'verified'|'pending_verification'|'invalid'|'disabled';enabled:boolean;identityEvidence?:'provider_api'|'authenticated_event_confirmed'|'authenticated_first_message'|'app_credentials_only'|'admin_asserted';inboundVerified?:boolean;directoryStatus:'available'|'unavailable';lastError:string|null;
 credential:SealedDirectoryCredential;createdBy:string;updatedBy:string;
 /** Credential-scoped, per-person exact search/callback identity evidence. Legacy revision alone proves nobody. */
 wecomBindingRevision?:number;
 wecomContactIdentityRevision?:number;
 wecomVerifiedContactIds?:string[];
 wecomContactMappings?:WeComContactMapping[];
 wecomMemberChallenges?:WeComMemberChallenge[];
 previousInstallation?:{botId:string;tenantId:string};
 validation?:ChannelValidation;
 context?:{historyEnabled:boolean;groupTriggerKeywords?:readonly string[];groupListenEnabled?:boolean;listenGeneration?:number;wecomRecentGroupContextEnabled?:boolean;wecomRecentGroupContextGeneration?:number;meetingRefs:{kind:'minutes';externalId:string}[]};
 verification?:{challengeId:string;challengeText:string;expiresAt:number;candidate?:{id:string;appId:string;botId:string;tenantId:string;robotCode?:string;eventId:string;messageId:string}};
}
export interface ResolvedEmployeeChannelBinding {
 connectionId:string;workspaceId:string;entityId:string;provider:DirectoryProvider;appId:string;bindingVersion:string;enabled:boolean;
 identity:{tenantId:string;tenantIdNamespace:DirectoryIdentity['tenantIdNamespace']};connection:ChannelConnection;
 conversation:ConversationPort;meetingArtifacts?:MeetingArtifactsPort;
 policy:{entityMentionId:string;ownSenderIds:readonly string[];groupTriggerKeywords?:readonly string[]};previousInstallation?:{botId:string;tenantId:string};
 context?:{historyEnabled:boolean;groupTriggerKeywords?:readonly string[];groupListenEnabled?:boolean;listenGeneration?:number;wecomRecentGroupContextEnabled?:boolean;wecomRecentGroupContextGeneration?:number;meetingRefs:ChannelResourceRef[]};
}
export interface EmployeeChannelCredential {appSecret:string}
export interface VerifiedEmployeeApplication {identity:DirectoryIdentity;botId?:string;eventTenantId?:string;directoryStatus:'available'|'unavailable';validation?:ChannelValidation;authorizedScope?:import('@dentity/application').DirectoryAuthorizedScope}
export interface EmployeeChannelOptions {
 registerFeishuApp?:typeof import('@larksuiteoapi/node-sdk').registerApp;
 diagnostics?:import('@dentity/application').DiagnosticPort;
 masterKey?:Uint8Array;fetch?:typeof fetch;now?:()=>number;
 adapterFactory?:(provider:DirectoryProvider,credentials:{appId:string;appSecret:string})=>DirectoryPort;
 verifyApplication?:(provider:DirectoryProvider,appId:string,credentials:EmployeeChannelCredential)=>Promise<VerifiedEmployeeApplication>;
}
export type EmployeeChannelActor=ChannelActor;
