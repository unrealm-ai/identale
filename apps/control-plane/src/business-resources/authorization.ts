import type {SharedMessageAsset} from '@dentity/application';
import type {AssetReadKind,AssetRunScope,AssetSourceScope,AssetUnavailable} from '../assets/service.js';
export interface BusinessResourceRef {kind:'document'|'minutes'|'meeting'|'note';externalId:string}
export interface ResourceAuthorizationRequest {
 source:Readonly<AssetSourceScope>;
 /** Trusted admitted task actor, separate from the immutable original sharing actor/operator. */
 invocationActor?:Readonly<{requesterId:string;requesterNamespace:string}>;
 run:Readonly<AssetRunScope>;
 resource:Readonly<BusinessResourceRef>;
 /** Immutable explicitly supplied root; derivative resources never change its task/source consent. */
 originResource?:Readonly<BusinessResourceRef>;
 operation:AssetReadKind;
 /** Fixed task destination, not a caller/model-selected recipient. Includes group/thread identity. */
 audience:string;
}
interface ResourceGrantBase {
 state:'authorized'; accountId:string; authorizationRevision:string; resourceVersion:string; expiresAt:number;
 apiScopeVerified:true; outputAudienceVerified:true;
}
export type ResourceGrant=ResourceGrantBase & ({identityKind:'application';resourceAclVerified:true;userAclVerified?:never}|{identityKind?:'user';userAclVerified:true;resourceAclVerified?:true});
export type ResourceDecision=ResourceGrant|{state:'authorization_required'|'unknown';reason?:string;readState?:AssetUnavailable['state']};
/** Trusted host checks live calling identity, API scope, actual resource ACL for that identity,
 * verified incoming source and fixed original audience. Application grants never claim user ACL.
 * Persisted grants are comparisons, never offline authority. No credentials may be returned here. */
export interface ResourceAuthorizationPort {authorize(request:ResourceAuthorizationRequest):Promise<ResourceDecision>}
export interface BusinessResourceReader {
 read(request:ResourceAuthorizationRequest,grant:ResourceGrant,descriptor:SharedMessageAsset,
  authorizeDerived:(resource:BusinessResourceRef)=>Promise<boolean>,alternative?:boolean):Promise<Response|AssetUnavailable>;
}
export interface BusinessResourceAccess {readonly identityKind?:'application'|'user';authorization:ResourceAuthorizationPort;reader:BusinessResourceReader}
export const isBusinessResource=(asset:SharedMessageAsset)=>asset.kind==='meeting'||!!asset.businessResource;
export function businessResource(asset:SharedMessageAsset):BusinessResourceRef {
 if(asset.businessResource)return asset.businessResource;
 return{kind:'meeting',externalId:JSON.stringify([asset.meetingNumber??'',asset.startAt??'',asset.endAt??''])};
}
export function validGrant(value:ResourceDecision,now:number):value is ResourceGrant {
 return value.state==='authorized'&&value.apiScopeVerified===true&&(value.identityKind==='application'?value.resourceAclVerified===true:(value.identityKind===undefined||value.identityKind==='user')&&value.userAclVerified===true)&&value.outputAudienceVerified===true&&
 [value.accountId,value.authorizationRevision,value.resourceVersion].every(x=>typeof x==='string'&&x.length>0&&x.length<=2048)&&Number.isFinite(value.expiresAt)&&value.expiresAt>now;
}
export function sameGrant(a:ResourceGrant,b:ResourceGrant){return (a.identityKind??'user')===(b.identityKind??'user')&&a.accountId===b.accountId&&a.authorizationRevision===b.authorizationRevision&&a.resourceVersion===b.resourceVersion;}
