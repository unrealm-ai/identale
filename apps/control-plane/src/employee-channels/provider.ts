import {DirectoryError,type DirectoryProvider,type DirectoryPort} from '@dentity/application';
import {DirectoryHttp,object,string,tokenLifetime,feishuEnvelope} from '../adapters/directory/http.js';
import type {EmployeeChannelCredential,EmployeeChannelOptions,VerifiedEmployeeApplication} from './types.js';
import {channelChecks,validateDirectory,validationStep} from './validation.js';
import {inspectFeishuScopes} from './feishu-scopes.js';
/** Application-only credentials. The token is retained only in this server closure. */
export class EmployeeApplicationTransport {
 private readonly http:DirectoryHttp;
 private token:{value:string;expiresAt:number}|undefined;
 constructor(readonly provider:DirectoryProvider,readonly appId:string,readonly secret:EmployeeChannelCredential,options:EmployeeChannelOptions){if(provider==='wecom')throw new DirectoryError('unsupported');this.http=new DirectoryHttp({appId,appSecret:secret.appSecret,...(options.fetch?{fetch:options.fetch}:{}),...(options.now?{now:options.now}:{})});}
 async accessToken(){if(this.token&&this.token.expiresAt>this.http.now())return this.token.value;
  const r=this.provider==='feishu'?await this.http.request('https://open.feishu.cn','/open-apis/auth/v3/tenant_access_token/internal','POST',{app_id:this.appId,app_secret:this.secret.appSecret},{},true):await this.http.request('https://api.dingtalk.com','/v1.0/oauth2/accessToken','POST',{appKey:this.appId,appSecret:this.secret.appSecret},{},true);
  if(this.provider==='feishu'&&r.code!==0)feishuEnvelope(r);
  if(this.provider==='dingtalk'&&r.code!==undefined)throw new DirectoryError('authentication_failed');
  const value=string(this.provider==='feishu'?r.tenant_access_token:r.accessToken),ttl=tokenLifetime(this.provider==='feishu'?r.expire:r.expireIn);
  this.token={value,expiresAt:this.http.now()+ttl-Math.min(ttl/10,30000)};return value;
 }
 async verify(directory:DirectoryPort):Promise<VerifiedEmployeeApplication>{
  const checks=channelChecks(this.provider);
  const token=await validationStep(this.provider,checks,'credentials',()=>this.accessToken());
  let botId:string|undefined;
  if(this.provider==='feishu'){
   await inspectFeishuScopes(this.http,token,checks);
   botId=await validationStep(this.provider,checks,'bot_identity',async()=>{
    const response=await this.http.request('https://open.feishu.cn','/open-apis/bot/v3/info','GET',undefined,{authorization:`Bearer ${token}`});
    if(response.code!==0)feishuEnvelope(response);
    return string(object(response.bot).open_id);
   });
  }
  const {identity,scope,validation}=await validateDirectory(directory,this.provider,checks);
  return{identity,...(botId?{botId}:{}),...((identity.tenantIdNamespace==='tenant_key'||identity.tenantIdNamespace==='corp_id')?{eventTenantId:identity.tenantId}:{}),directoryStatus:'available',validation,authorizedScope:scope};
 }
}
