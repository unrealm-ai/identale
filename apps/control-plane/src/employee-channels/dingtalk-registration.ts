import {DirectoryCredentialVault,type SealedDirectoryCredential} from '../directory/secrets.js';
import {EmployeeChannelError,type EmployeeChannelService} from './service.js';
import {DingTalkRegistrationAdapter} from './dingtalk-registration-adapter.js';
export interface DingTalkRegistrationOptions {source?:string;fetch?:typeof fetch;now?:()=>number;masterKey?:Uint8Array}
type Scope = {workspaceId:string;entityId:string;actorId:string};
type Status = 'starting'|'waiting'|'ready'|'failed'|'expired'|'cancelled'|'consumed';
type Session = Scope & {id:string;expectedRevision:number;bindingId:string|null;status:Status;expiresAt:number;retainUntil:number;nextPollAt:number;intervalMs:number;controller:AbortController;busy:boolean;startedAt?:number;secret?:SealedDirectoryCredential;verificationUrl?:string;clientId?:string;error?:string};
const ttl = 600000, capacity = 500;
const fail = (status:number,code:string):never => {throw new EmployeeChannelError(status,code);};
const validId = (id:unknown):id is string => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
const sameScope = (a:Scope,b:Scope) => a.workspaceId===b.workspaceId&&a.entityId===b.entityId&&a.actorId===b.actorId;
const active = (s:Session) => ['starting','waiting','ready'].includes(s.status);
/** Process-local registration sessions, never synchronized to runtime or persisted.
 * Only encrypted device/app secrets are retained; terminal sessions are bounded
 * tombstones so cancellation and delayed duplicate starts cannot revive them. */
export class DingTalkRegistrations {
 private readonly sessions = new Map<string,Session>();
 private readonly vault:DirectoryCredentialVault;
 private readonly adapter:DingTalkRegistrationAdapter;
 private readonly now:()=>number;
 private readonly timer:ReturnType<typeof setInterval>;
 private closed=false;
 constructor(private readonly channels:EmployeeChannelService,private readonly options:DingTalkRegistrationOptions={}) {
  this.vault=new DirectoryCredentialVault(options.masterKey);this.adapter=new DingTalkRegistrationAdapter(options.fetch);this.now=options.now??Date.now;
  this.timer=setInterval(()=>this.prune(),30000);this.timer.unref();
 }
 close(){this.closed=true;clearInterval(this.timer);for(const s of this.sessions.values())this.finish(s,'cancelled');this.sessions.clear();}
 availability(scope?:Scope){
  const source=this.options.source?.trim();
  if(!source)return{available:false,reason:'source_unconfigured' as const};
  if(!/^[a-zA-Z][a-zA-Z0-9_-]{1,63}$/.test(source)||source.toUpperCase()==='DING_DWS_CLAW')return{available:false,reason:'source_invalid' as const};
  if(!this.vault.available)return{available:false,reason:'secret_key_unconfigured' as const};
  this.prune();
  const session=scope?[...this.sessions.values()].find(s=>sameScope(s,scope)&&active(s)):undefined;
  if(session){try{this.current(session);return{available:true,session:this.dto(session)};}catch{/* Changed bindings cannot be recovered. */}}
  return{available:true};
 }
 private aad(s:Session){return ['dingtalk-registration-v1',s.workspaceId,s.entityId,s.actorId,s.id,s.bindingId??'',s.expectedRevision];}
 private finish(s:Session,status:Status,error?:string){s.status=status;s.controller.abort();delete s.secret;delete s.verificationUrl;delete s.clientId;if(error)s.error=error;}
 private prune(){for(const [id,s]of this.sessions){if(active(s)&&s.expiresAt<=this.now())this.finish(s,'expired');if(s.retainUntil<=this.now())this.sessions.delete(id);}}
 private binding(scope:Scope){return this.channels.repository.byProvider(scope.workspaceId,scope.entityId,'dingtalk');}
 private current(s:Session){const c=this.binding(s);if((c?.revision??0)!==s.expectedRevision||(c?.id??null)!==s.bindingId){this.finish(s,'failed','channel_configuration_changed');fail(409,'channel_configuration_changed');}}
 private get(scope:Scope,id:string){this.prune();const s=this.sessions.get(id);if(!s||!sameScope(s,scope))return fail(404,'dingtalk_registration_not_found');return s;}
 private dto(s:Session){return {sessionId:s.id,status:s.status,expiresAt:s.expiresAt,pollAfterMs:Math.max(1000,s.nextPollAt-this.now()),...(s.verificationUrl?{verificationUrl:s.verificationUrl}:{}),...(s.clientId?{clientId:s.clientId}:{}),...(s.error?{error:s.error}:{})};}
 async start(scope:Scope,input:{sessionId?:unknown;expectedRevision?:unknown}){
  this.prune();if(this.closed)fail(503,'dingtalk_registration_unavailable');
  if(!validId(input.sessionId)||!Number.isSafeInteger(input.expectedRevision)||Number(input.expectedRevision)<0)fail(400,'invalid_dingtalk_registration_request');
  const id=input.sessionId as string,old=this.sessions.get(id);
  if(old){if(!sameScope(old,scope))fail(404,'dingtalk_registration_not_found');if(old.expectedRevision!==input.expectedRevision&&old.status!=='cancelled')fail(409,'channel_configuration_changed');return this.dto(old);}
  const availability=this.availability();if(!availability.available)fail(503,`dingtalk_registration_${availability.reason}`);
  if(this.sessions.size>=capacity||[...this.sessions.values()].some(s=>sameScope(s,scope)&&active(s))||[...this.sessions.values()].filter(s=>s.actorId===scope.actorId&&s.startedAt!==undefined&&s.startedAt>this.now()-60000).length>=5)fail(429,'dingtalk_registration_busy');
  const binding=this.binding(scope);if((binding?.revision??0)!==input.expectedRevision)fail(409,'channel_configuration_changed');
  const s:Session={...scope,id,expectedRevision:input.expectedRevision as number,bindingId:binding?.id??null,status:'starting',startedAt:this.now(),expiresAt:this.now()+ttl,retainUntil:this.now()+ttl*2,nextPollAt:this.now()+3000,intervalMs:3000,controller:new AbortController(),busy:true};
  this.sessions.set(id,s);
  try{
   const result=await this.adapter.begin(this.options.source!.trim(),s.controller.signal);
   this.prune();if(!active(s)||this.closed)return this.dto(s);this.current(s);
   s.secret=this.vault.seal(JSON.stringify({deviceCode:result.deviceCode}),this.aad(s));s.verificationUrl=result.verificationUrl;
   s.expiresAt=Math.min(s.expiresAt,this.now()+result.expiresMs);s.intervalMs=result.intervalMs;s.nextPollAt=this.now()+s.intervalMs;s.status='waiting';
  }catch(error){if(active(s))this.finish(s,'failed',error instanceof EmployeeChannelError?error.code:'dingtalk_registration_unavailable');}
  finally{s.busy=false;}
  return this.dto(s);
 }
 async poll(scope:Scope,id:string){
  const s=this.get(scope,id);if(!active(s))return this.dto(s);this.current(s);
  if(s.status!=='waiting'||s.busy||s.nextPollAt>this.now())return this.dto(s);
  s.busy=true;s.nextPollAt=this.now()+s.intervalMs;
  try{
   const {deviceCode}=JSON.parse(this.vault.open(s.secret!,this.aad(s))) as {deviceCode:string};
   const result=await this.adapter.poll(deviceCode,s.controller.signal);
   this.prune();if(!active(s)||this.closed)return this.dto(s);this.current(s);
   if(result.status==='SUCCESS'&&result.clientId&&result.clientSecret){s.secret=this.vault.seal(JSON.stringify({appId:result.clientId,appSecret:result.clientSecret}),this.aad(s));s.clientId=result.clientId;delete s.verificationUrl;s.status='ready';}
   else if(result.status==='EXPIRED')this.finish(s,'expired');
   else if(result.status!=='WAITING')this.finish(s,'failed','dingtalk_registration_rejected');
  }catch(error){if(active(s))this.finish(s,'failed',error instanceof EmployeeChannelError?error.code:'dingtalk_registration_unavailable');}
  finally{s.busy=false;}
  return this.dto(s);
 }
 cancel(scope:Scope,id:string){
  if(!validId(id))fail(400,'invalid_dingtalk_registration_request');this.prune();
  const old=this.sessions.get(id);if(old&&!sameScope(old,scope))fail(404,'dingtalk_registration_not_found');
  if(old){if(old.status!=='consumed')this.finish(old,'cancelled');return{status:old.status};}
  if(this.sessions.size>=capacity)fail(429,'dingtalk_registration_busy');
  const s:Session={...scope,id,expectedRevision:0,bindingId:null,status:'cancelled',expiresAt:this.now(),retainUntil:this.now()+ttl*2,nextPollAt:0,intervalMs:3000,controller:new AbortController(),busy:false};
  this.sessions.set(id,s);return{status:'cancelled'};
 }
 async bind(scope:Scope,id:string,replaceSource:unknown,assertAuthorized:()=>void){
  const s=this.get(scope,id);if(typeof replaceSource!=='boolean')fail(400,'invalid_dingtalk_registration_request');
  if(s.status!=='ready'||s.busy)fail(409,'dingtalk_registration_not_ready');this.current(s);
  const credentials=JSON.parse(this.vault.open(s.secret!,this.aad(s))) as {appId:string;appSecret:string};
  if(s.bindingId&&this.binding(s)?.appId!==credentials.appId&&!replaceSource)fail(409,'channel_unbind_required');
  s.busy=true;
  try{
   const result=await this.channels.save(scope.workspaceId,scope.entityId,'dingtalk',scope.actorId,{...credentials,expectedRevision:s.expectedRevision,replaceSource:replaceSource as boolean},()=>{
    this.prune();assertAuthorized();if(this.closed||s.status!=='ready')fail(409,'dingtalk_registration_not_ready');this.current(s);
   });
   this.finish(s,'consumed');return result;
  }catch(error){if(active(s))this.finish(s,'failed',error instanceof EmployeeChannelError?error.code:'dingtalk_registration_unavailable');throw error;}
  finally{s.busy=false;}
 }
}
