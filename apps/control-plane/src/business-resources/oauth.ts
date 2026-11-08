import {createCipheriv,createDecipheriv,createHash,randomBytes,randomUUID} from 'node:crypto';
import {Client,type HttpInstance} from '@larksuiteoapi/node-sdk';
import type {Store} from '../store.js';
import type {FeishuUserTokenRegistry} from './accounts.js';
import type {ResourceAuthorizationRequest} from './authorization.js';
import {resourceOAuthScopes,validateBusinessOAuthConfiguration,type BusinessOAuthConfiguration,type FeishuOAuthApplication} from './configuration.js';
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const requestKey=(r:ResourceAuthorizationRequest)=>hash(JSON.stringify([r.source.workspaceId,r.source.entityId,r.source.connectionId,r.source.bindingVersion,r.source.applicationId,r.source.tenantId,r.source.requesterNamespace,r.source.requesterId,r.source.chatId,r.source.threadId??'',r.source.messageId,r.run.workspaceId,r.run.entityId,r.run.taskId,(r as ResourceAuthorizationRequest&{originResource?:ResourceAuthorizationRequest['resource']}).originResource??r.resource,r.audience]));
type Token={authorizationRevision:string;accessToken:string;applicationId:string;tenantId:string;expiresAt:number};
export interface ScopedFeishuUserTokenRegistry extends FeishuUserTokenRegistry {resolveForRequest(request:ResourceAuthorizationRequest):Promise<Token|undefined>}
/** AES-GCM with distinct purpose and complete immutable consent context in AAD. No plaintext token/PKCE persistence. */
class BusinessTokenVault{
 constructor(private readonly key:Uint8Array){if(key.byteLength!==32)throw Error('business_oauth_key_invalid');}
 seal(value:unknown,aad:string){const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,nonce);cipher.setAAD(Buffer.from('business-oauth-v1:'+aad));return JSON.stringify({nonce:nonce.toString('base64'),ciphertext:Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]).toString('base64'),tag:cipher.getAuthTag().toString('base64')});}
 open<T>(value:string,aad:string):T{const v=JSON.parse(value),cipher=createDecipheriv('aes-256-gcm',this.key,Buffer.from(v.nonce,'base64'));cipher.setAAD(Buffer.from('business-oauth-v1:'+aad));cipher.setAuthTag(Buffer.from(v.tag,'base64'));return JSON.parse(Buffer.concat([cipher.update(Buffer.from(v.ciphertext,'base64')),cipher.final()]).toString('utf8'))as T;}
}
export interface FeishuOAuthTransport{
 exchange(app:FeishuOAuthApplication,input:{code:string;redirectUri:string;verifier:string;scopes:string[]}):Promise<{accessToken:string;expiresIn?:number;scope?:string}>;
 identity(accessToken:string):Promise<{openId?:string;tenantId?:string}>;
}
/** Locked SDK owns the exchange protocol. Fixed transport refuses redirects and never logs request/response bodies. */
export function feishuOAuthTransport(fetcher:typeof fetch=fetch):FeishuOAuthTransport{
 const unsupported=async():Promise<never>=>{throw Error('business_oauth_method_unsupported');};
 const http:HttpInstance={get:unsupported,post:unsupported,put:unsupported,patch:unsupported,delete:unsupported,head:unsupported,options:unsupported,request:async<T,R=T,D=unknown>(opts:import('@larksuiteoapi/node-sdk').HttpRequestOptions<D>):Promise<R>=>{
  if(opts.url!=='https://accounts.feishu.cn/oauth/v3/token'||opts.method!=='post')throw Error('business_oauth_endpoint_invalid');
  const response=await fetcher(opts.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(opts.data),redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error('business_oauth_exchange_failed');return await response.json()as R;
 }};
 return{exchange:async(app,input)=>{
  const silent=()=>{};
  const sdk=new Client({appId:app.applicationId,appSecret:app.clientSecret,domain:'https://open.feishu.cn',httpInstance:http,logger:{debug:silent,info:silent,warn:silent,error:silent,trace:silent}});
  try{return await sdk.accessToken.retrieveByAuthorizationCode({code:input.code,redirectUri:input.redirectUri,codeVerifier:input.verifier,scope:input.scopes.join(' ')});}catch{throw Error('business_oauth_exchange_failed');}
 },identity:async token=>{
  const response=await fetcher('https://open.feishu.cn/open-apis/authen/v1/user_info',{headers:{authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error('business_oauth_identity_failed');const data=await response.json()as{code?:number;data?:{open_id?:string;tenant_key?:string}};
  if(data.code!==0||!data.data?.open_id||!data.data.tenant_key)throw Error('business_oauth_identity_failed');return{openId:data.data.open_id,tenantId:data.data.tenant_key};
 }};
}
export class BusinessOAuthService implements ScopedFeishuUserTokenRegistry{
 private readonly vault:BusinessTokenVault;
 constructor(private readonly store:Store,key:Uint8Array,private readonly config:BusinessOAuthConfiguration,private readonly transport:FeishuOAuthTransport=feishuOAuthTransport(),private readonly now:()=>number=Date.now){
  validateBusinessOAuthConfiguration(config);this.vault=new BusinessTokenVault(key);
  store.db.exec(`CREATE TABLE IF NOT EXISTS business_oauth_states(state_hash TEXT PRIMARY KEY,principal_hash TEXT NOT NULL,connection_id TEXT NOT NULL,expires_at INTEGER NOT NULL,sealed TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS business_oauth_tokens(consent_key TEXT PRIMARY KEY,connection_id TEXT NOT NULL,requester_id TEXT NOT NULL,expires_at INTEGER NOT NULL,sealed TEXT NOT NULL);`);
 }
 configuration(){return{configured:true,redirectUri:this.config.redirectUri,providers:[{provider:'feishu',supportedResources:['document'],scopes:['docx:document:readonly']},{provider:'dingtalk',supportedResources:[],reason:'verified_user_oauth_mapping_required'},{provider:'wecom',supportedResources:[],reason:'verified_human_identity_contract_required'}]};}
 async begin(principalId:string,request:ResourceAuthorizationRequest){
  if(!principalId||request.run.workspaceId!==request.source.workspaceId||request.run.entityId!==request.source.entityId||!request.audience)throw Error('business_oauth_context_invalid');
  const scopes=resourceOAuthScopes(request);await this.config.assertSource(request.source);const app=await this.config.application(request.source);
  if(app.applicationId!==request.source.applicationId||!app.clientSecret)throw Error('business_oauth_application_mismatch');
  const state=randomBytes(32).toString('base64url'),stateHash=hash(state),verifier=randomBytes(32).toString('base64url'),principalHash=hash(principalId),expiresAt=this.now()+10*60000;
  this.store.run('DELETE FROM business_oauth_states WHERE expires_at<=?',this.now());
  this.store.run('INSERT INTO business_oauth_states VALUES(?,?,?,?,?)',stateHash,principalHash,request.source.connectionId,expiresAt,this.vault.seal({request,verifier,scopes},`state:${stateHash}:${principalHash}:${expiresAt}`));
  const uri=new URL('https://accounts.feishu.cn/open-apis/authen/v1/authorize');
  for(const[k,v]of Object.entries({client_id:app.applicationId,response_type:'code',redirect_uri:this.config.redirectUri,scope:scopes.join(' '),state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}))uri.searchParams.set(k,v);
  return{authorizationUrl:uri.toString(),expiresAt};
 }
 async complete(principalId:string,state:string,code:string){
  if(!principalId||!/^[A-Za-z0-9_-]{43}$/.test(state)||!code||code.length>4096)throw Error('business_oauth_callback_invalid');
  const stateHash=hash(state),row=this.store.one<{principal_hash:string;expires_at:number;sealed:string}>('SELECT * FROM business_oauth_states WHERE state_hash=?',stateHash);
  if(!row||!row.sealed||row.principal_hash!==hash(principalId)||row.expires_at<=this.now())throw Error('business_oauth_state_invalid');
  // Consume before network I/O: no code replay, including failed or ambiguous exchanges.
  this.store.run("UPDATE business_oauth_states SET sealed='' WHERE state_hash=?",stateHash);
  const pending=this.vault.open<{request:ResourceAuthorizationRequest;verifier:string;scopes:string[]}>(row.sealed,`state:${stateHash}:${row.principal_hash}:${row.expires_at}`),r=pending.request;
  await this.config.assertSource(r.source);const app=await this.config.application(r.source);
  if(app.applicationId!==r.source.applicationId)throw Error('business_oauth_application_mismatch');
  const issuedAt=this.now();
  const token=await this.transport.exchange(app,{code,redirectUri:this.config.redirectUri,verifier:pending.verifier,scopes:pending.scopes});
  if(!token.accessToken||!Number.isFinite(token.expiresIn)||token.expiresIn!<=0||typeof token.scope!=='string'||pending.scopes.some(s=>!token.scope!.split(/\s+/).includes(s)))throw Error('business_oauth_scope_missing');
  const identity=await this.transport.identity(token.accessToken);
  if(identity.openId!==r.source.requesterId||identity.tenantId!==r.source.tenantId)throw Error('business_oauth_actor_mismatch');
  await this.config.assertSource(r.source);
  // A revoke during the external exchange deletes the consumed state tombstone.
  if(!this.store.one("SELECT state_hash FROM business_oauth_states WHERE state_hash=? AND sealed='' AND expires_at>?",stateHash,this.now()))throw Error('business_oauth_state_revoked');
  const expiresAt=issuedAt+Math.min(token.expiresIn!,7200)*1000,key=requestKey(r);
  if(expiresAt<=this.now())throw Error('business_oauth_token_expired');
  const stored:Token={authorizationRevision:randomUUID(),accessToken:token.accessToken,applicationId:app.applicationId,tenantId:r.source.tenantId,expiresAt};
  this.store.run('INSERT INTO business_oauth_tokens VALUES(?,?,?,?,?) ON CONFLICT(consent_key) DO UPDATE SET expires_at=excluded.expires_at,sealed=excluded.sealed',key,r.source.connectionId,r.source.requesterId!,expiresAt,this.vault.seal({token:stored,request:r},`token:${key}:${r.source.connectionId}:${r.source.requesterId}:${expiresAt}`));
  this.store.run('DELETE FROM business_oauth_states WHERE state_hash=?',stateHash);
  return{state:'authorized' as const,provider:'feishu' as const,expiresAt};
 }
 private async read(row:{consent_key:string;connection_id:string;requester_id:string;expires_at:number;sealed:string}|undefined){
  if(!row||row.expires_at<=this.now())return;
  try{const value=this.vault.open<{token:Token;request:ResourceAuthorizationRequest}>(row.sealed,`token:${row.consent_key}:${row.connection_id}:${row.requester_id}:${row.expires_at}`);await this.config.assertSource(value.request.source);return value.token;}catch{return;}
 }
 async resolve(connectionId:string,requesterOpenId:string){return this.read(this.store.one('SELECT * FROM business_oauth_tokens WHERE connection_id=? AND requester_id=? AND expires_at>? ORDER BY expires_at DESC LIMIT 1',connectionId,requesterOpenId,this.now()));}
 async resolveForRequest(request:ResourceAuthorizationRequest){await this.config.assertSource(request.source);return this.read(this.store.one('SELECT * FROM business_oauth_tokens WHERE consent_key=?',requestKey(request)));}
 revoke(connectionId:string){this.store.run('DELETE FROM business_oauth_tokens WHERE connection_id=?',connectionId);/* Pending requests are also cancelled so a late callback cannot restore access. */this.store.run('DELETE FROM business_oauth_states WHERE connection_id=?',connectionId);}
}
