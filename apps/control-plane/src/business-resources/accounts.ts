import {randomUUID} from 'node:crypto';
import type {Store} from '../store.js';
import type {AssetSourceScope} from '../assets/service.js';
/** Host-owned OAuth token registry. A token must have been issued by this application's verified OAuth flow.
 * These values are neither an HTTP DTO nor model arguments; do not accept a user-supplied appId as provenance. */
export interface FeishuUserTokenRegistry {
 resolve(connectionId:string,requesterOpenId:string):Promise<{accessToken:string;applicationId:string;tenantId:string;expiresAt:number;authorizationRevision?:string}|undefined>;
}
export interface VerifiedBusinessAccount {provider:'feishu';accountId:string;authorizationRevision:string;verifiedAt:number;expiresAt:number}
/** Identity evidence only: never grants document ACL, API scope, task access or group output rights. */
export class BusinessAccountBindings {
 constructor(private readonly store:Store,private readonly registry:FeishuUserTokenRegistry,private readonly options:{fetch?:typeof fetch;now?:()=>number}={}){
  store.db.exec(`CREATE TABLE IF NOT EXISTS business_account_bindings(workspace_id TEXT NOT NULL,entity_id TEXT NOT NULL,connection_id TEXT NOT NULL,binding_version TEXT NOT NULL,requester_id TEXT NOT NULL,requester_namespace TEXT NOT NULL,provider TEXT NOT NULL,account_id TEXT NOT NULL,authorization_revision TEXT NOT NULL,verified_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(workspace_id,entity_id,connection_id,requester_id,requester_namespace));`);
 }
 private now(){return(this.options.now??Date.now)();}
 async verifyFeishu(source:AssetSourceScope):Promise<VerifiedBusinessAccount|undefined>{
  if(source.provider!=='feishu'||source.requesterNamespace!=='open_id'||!source.requesterId)return;
  const token=await this.registry.resolve(source.connectionId,source.requesterId);
  if(!token||token.applicationId!==source.applicationId||token.tenantId!==source.tenantId||token.expiresAt<=this.now())return;
  const response=await(this.options.fetch??fetch)('https://open.feishu.cn/open-apis/authen/v1/user_info',{redirect:'error',signal:AbortSignal.timeout(15000),headers:{authorization:`Bearer ${token.accessToken}`}});
  if(!response.ok)return;
  const result=await response.json()as{code?:unknown;data?:{open_id?:unknown;tenant_key?:unknown}};
  if(result.code!==0||result.data?.open_id!==source.requesterId||result.data.tenant_key!==source.tenantId)return;
  const old=this.store.one<{binding_version:string;account_id:string;authorization_revision:string;expires_at:number}>('SELECT binding_version,account_id,authorization_revision,expires_at FROM business_account_bindings WHERE workspace_id=? AND entity_id=? AND connection_id=? AND requester_id=? AND requester_namespace=?',source.workspaceId,source.entityId,source.connectionId,source.requesterId,source.requesterNamespace);
  const revision=old?.binding_version===source.bindingVersion&&old.account_id===source.requesterId?old.authorization_revision:randomUUID();
  const verifiedAt=this.now(),expiresAt=Math.min(token.expiresAt,verifiedAt+5*60000);
  this.store.run('INSERT INTO business_account_bindings VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,entity_id,connection_id,requester_id,requester_namespace) DO UPDATE SET binding_version=excluded.binding_version,account_id=excluded.account_id,authorization_revision=excluded.authorization_revision,verified_at=excluded.verified_at,expires_at=excluded.expires_at',source.workspaceId,source.entityId,source.connectionId,source.bindingVersion,source.requesterId,source.requesterNamespace,'feishu',source.requesterId,revision,verifiedAt,expiresAt);
  return{provider:'feishu',accountId:source.requesterId,authorizationRevision:revision,verifiedAt,expiresAt};
 }
 /** Explicit host revocation. Next successful verification obtains a new revision; cached grants cannot revive. */
 revoke(connectionId:string){this.store.run('DELETE FROM business_account_bindings WHERE connection_id=?',connectionId);}
}
