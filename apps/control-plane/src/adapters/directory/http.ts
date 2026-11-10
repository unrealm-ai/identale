import {directoryOperationMetadata} from './operation-metadata.js';
import type {DiagnosticFailure} from '@dentity/application';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { DirectoryError, type DirectoryIdentity, type DirectoryExternalId, type DirectoryAuthorizedScope } from '@dentity/application';

export interface DirectoryRequestDetails extends Partial<Omit<DiagnosticFailure,'category'>> {
  reason?: 'timeout' | 'network' | 'parse' | 'no_sample' | 'required_field';
  httpStatus?: number; providerCode?: number; requestId?: string; missingScopes?: string[];
  field?:DirectoryFieldDiagnostic;
}
export interface DirectoryFieldDiagnostic {path:string;expected:string;actualType:'missing'|'null'|'array'|'object'|'string'|'number'|'boolean'|'other';itemCount?:number}
/** Only whitelist diagnostics cross the adapter boundary; never retain a raw provider message. */
export class DirectoryRequestError extends DirectoryError {
  constructor(code: ConstructorParameters<typeof DirectoryError>[0], readonly details: DirectoryRequestDetails) { super(code); }
}
const responseDetails = new WeakMap<object, DirectoryRequestDetails>();
/** Callers provide constant schema paths; diagnostics never contain a returned value. */
export function fieldFailure(parent:object,path:string,value:unknown,expected:string,code:ConstructorParameters<typeof DirectoryError>[0]='invalid_response'):DirectoryRequestError{
  const actualType:DirectoryFieldDiagnostic['actualType']=value===undefined?'missing':value===null?'null':Array.isArray(value)?'array':['object','string','number','boolean'].includes(typeof value)?typeof value as 'object'|'string'|'number'|'boolean':'other';
  return new DirectoryRequestError(code,{...responseDetails.get(parent),...(code==='invalid_response'?{reason:'parse' as const}:{}),field:{path,expected,actualType,...(Array.isArray(value)?{itemCount:value.length}:{})}});
}
export const isScopeName=(value:unknown):value is string=>typeof value==='string'&&value.length<=160&&/^[a-z][a-z0-9_.-]*(?::[a-z0-9_.-]+)*$/.test(value);
const nameEvidence = new WeakMap<object, boolean>();
export function markDirectoryName<T extends { displayName: string }>(person: T, present: boolean): T { nameEvidence.set(person, present); return person; }
export const directoryNameIsVerified = (person: { displayName: string }): boolean => nameEvidence.get(person) !== false && typeof person.displayName === 'string' && !!person.displayName.trim();
export function providerFailure(row: Record<string, unknown>, code: ConstructorParameters<typeof DirectoryError>[0]): DirectoryRequestError {
  const details = { ...responseDetails.get(row) };
  const businessCode = row.code ?? row.errcode;
  if (typeof businessCode === 'number' && Number.isSafeInteger(businessCode)) details.providerCode = businessCode;
  const error = row.error && typeof row.error === 'object' && !Array.isArray(row.error) ? row.error as Record<string, unknown> : undefined;
  const requestId = row.log_id ?? error?.log_id;
  if (typeof requestId === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(requestId)) details.requestId = requestId;
  const violations = error?.permission_violations;
  if (code === 'authorization_denied' && Array.isArray(violations)) {
    const scopes = violations.flatMap(value => {
      if (!value || typeof value !== 'object') return [];
      const v = value as Record<string, unknown>;
      return v.type === 'action_privilege_required' && isScopeName(v.subject) ? [v.subject] : [];
    });
    if (scopes.length) details.missingScopes = [...new Set(scopes)].slice(0, 30);
  }
  return new DirectoryRequestError(code, details);
}

export interface DirectoryAdapterOptions {
  appId:string;
  appSecret:string;
  /** Trusted infrastructure injection only. Never accepted from an HTTP request. */
  fetch?:typeof fetch;
  now?:()=>number;
  timeoutMs?:number;
  maxResponseBytes?:number;
  maxScopePages?:number;
}
export const object=(value:unknown):Record<string,unknown>=>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new DirectoryError('invalid_response');
  return value as Record<string,unknown>;
};
export const string=(value:unknown):string=>{
  if(typeof value!=='string'||!value||value.length>8192||/[\x00-\x1f]/.test(value))throw new DirectoryError('invalid_response');
  return value;
};
export function pathId(value:unknown):string{const id=string(value);if(id==='.'||id==='..'||id.length>500)throw new DirectoryError('invalid_response');return encodeURIComponent(id);}
export const array=(value:unknown):unknown[]=>{if(!Array.isArray(value))throw new DirectoryError('invalid_response');return value;};
export const strings=(value:unknown):string[]=>array(value).map(string);
export const optionalStrings=(value:unknown):string[]=>value===undefined?[]:strings(value);
export function unique(values:readonly string[]):string[]{return [...new Set(values)].sort();}
export function scopeRevision(departmentIds:readonly string[],userIds:readonly DirectoryExternalId[],entireOrganization:boolean,disclosed?:DirectoryAuthorizedScope['disclosed']):DirectoryAuthorizedScope {
  const departments=unique(departmentIds);
  const users=[...new Map(userIds.map(id=>[JSON.stringify(id),id])).values()].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const scope={departmentIds:departments,userIds:users,entireOrganization,...(disclosed?{disclosed}:{})};
  return {...scope,revision:createHash('sha256').update(JSON.stringify(scope)).digest('hex')};
}
export type DirectoryOrigin='https://open.feishu.cn'|'https://api.dingtalk.com'|'https://oapi.dingtalk.com'|'https://qyapi.weixin.qq.com';
/** Bounded provider HTTP, including explicit setup writes. Errors never include URL, body, token or provider messages. */
export class DirectoryHttp {
  readonly now:()=>number;
  readonly maxScopePages:number;
  private readonly fetch:typeof fetch;
  private readonly timeoutMs:number;
  private readonly maxResponseBytes:number;
  constructor(options:DirectoryAdapterOptions){
    string(options.appId);string(options.appSecret);
    this.fetch=options.fetch??globalThis.fetch;this.now=options.now??Date.now;
    this.timeoutMs=options.timeoutMs??15000;this.maxResponseBytes=options.maxResponseBytes??4*1024*1024;this.maxScopePages=options.maxScopePages??100;
    if(!Number.isInteger(this.timeoutMs)||this.timeoutMs<1||this.timeoutMs>60000||!Number.isInteger(this.maxResponseBytes)||this.maxResponseBytes<1||this.maxResponseBytes>32*1024*1024||!Number.isInteger(this.maxScopePages)||this.maxScopePages<1||this.maxScopePages>1000)throw new DirectoryError('invalid_response');
  }
  async request(origin:DirectoryOrigin,path:string,method:'GET'|'POST'|'PATCH',body?:unknown,headers:Record<string,string>={},authentication=false):Promise<Record<string,unknown>>{
    const url=new URL(path,origin);
    if(url.origin!==origin||!path.startsWith('/')||path.startsWith('//')||url.username||url.password||url.hash)throw new DirectoryError('invalid_response');
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),this.timeoutMs);timer.unref();
    try{
      const response=await this.fetch(url,{method,headers:{accept:'application/json',...(body===undefined?{}:{'content-type':'application/json'}),...headers},redirect:'error',signal:controller.signal,...(body===undefined?{}:{body:JSON.stringify(body)})});
      const httpFailure = (code: ConstructorParameters<typeof DirectoryError>[0]) => new DirectoryRequestError(code, {httpStatus:response.status});
      if(authentication&&response.status===400)throw httpFailure('authentication_failed');
      if(response.status===401)throw httpFailure('authentication_failed');
      if(response.status===429)throw httpFailure('unavailable');
      // Contact APIs may report authorization failures in HTTP 400 JSON envelopes.
      if(!response.ok&&![400,403].includes(response.status))throw httpFailure('unavailable');
      const reader=response.body?.getReader();if(!reader)throw new DirectoryError('invalid_response');
      const chunks:Uint8Array[]=[];let size=0;
      try{while(true){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>this.maxResponseBytes){await reader.cancel();throw new DirectoryError('limit_exceeded');}chunks.push(item.value);}}finally{reader.releaseLock();}
      try{const result=object(JSON.parse(Buffer.concat(chunks).toString('utf8')));const requestId=response.headers.get('x-tt-logid')??response.headers.get('x-request-id');responseDetails.set(result,{httpStatus:response.status,...directoryOperationMetadata(url),...(requestId&&/^[A-Za-z0-9_-]{8,100}$/.test(requestId)?{requestId}:{})});if(response.status===403)throw providerFailure(result,'authorization_denied');if(!response.ok&&(result.code===undefined||result.code===0)&&(result.errcode===undefined||result.errcode===0))throw httpFailure('unavailable');return result;}catch(error){if(error instanceof DirectoryError)throw error;if(response.status===403)throw httpFailure('authorization_denied');throw new DirectoryRequestError('invalid_response',{httpStatus:response.status,reason:'parse'});}
    }catch(error){if(error instanceof DirectoryError)throw new DirectoryRequestError(error.code,{...(error instanceof DirectoryRequestError?error.details:{}),...directoryOperationMetadata(url)});throw new DirectoryRequestError('unavailable',{...directoryOperationMetadata(url),reason:controller.signal.aborted?'timeout':'network'});}finally{clearTimeout(timer);}
  }
}
export function feishuEnvelope(row:Record<string,unknown>):Record<string,unknown>{
  if(row.code!==0){
    if([10003,10014,20002,20036,20048,20069,20130,99991661,99991663,99991664,99991668].includes(Number(row.code)))throw providerFailure(row,'authentication_failed');
    if([40003,40004,41050,41056,1184001,99991672,99991676,99991679,99991680,99992361,99992362].includes(Number(row.code)))throw providerFailure(row,'authorization_denied');
    if(typeof row.code!=='number')throw new DirectoryError('invalid_response');
    throw providerFailure(row,'unavailable');
  }
  const details={...responseDetails.get(row),providerCode:0};responseDetails.set(row,details);
  if(!row.data||typeof row.data!=='object'||Array.isArray(row.data))throw fieldFailure(row,'data',row.data,'object');
  const data=row.data as Record<string,unknown>;responseDetails.set(data,details);return data;
}
export function dingTalkEnvelope(row:Record<string,unknown>):Record<string,unknown>{
  if(row.errcode!==0){
    if([40001,40014,42001,40082,40083,40084].includes(Number(row.errcode)))throw providerFailure(row,'authentication_failed');
    if([50001,50002,60011,60020,60021].includes(Number(row.errcode)))throw providerFailure(row,'authorization_denied');
    if(typeof row.errcode!=='number')throw new DirectoryError('invalid_response');
    throw providerFailure(row,'unavailable');
  }
  return row;
}
export function tokenLifetime(value:unknown):number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1||value>86400)throw new DirectoryError('invalid_response');return value*1000;}
export function sameIdentity(a:DirectoryIdentity,b:DirectoryIdentity):boolean{return a.appId===b.appId&&a.tenantId===b.tenantId&&a.tenantIdNamespace===b.tenantIdNamespace;}
/** Per-instance authenticated cursors cannot move across routes, departments or credential revisions. */
export class DirectoryCursors {
  private readonly key=randomBytes(32);
  encode(scope:string,token:string):string{string(token);const data=Buffer.from(JSON.stringify([scope,token])).toString('base64url');return `${data}.${this.sign(data).toString('base64url')}`;}
  decode(scope:string,cursor:string):string{
    try{
      if(cursor.length>16000)throw new Error();const [data,signature,...rest]=cursor.split('.');
      if(!data||!signature||rest.length||!/^[\w-]+$/.test(data)||!/^[\w-]{43}$/.test(signature))throw new Error();
      const mac=Buffer.from(signature,'base64url');if(!timingSafeEqual(mac,this.sign(data)))throw new Error();
      const payload:unknown=JSON.parse(Buffer.from(data,'base64url').toString('utf8'));
      if(!Array.isArray(payload)||payload.length!==2||payload[0]!==scope)throw new Error();return string(payload[1]);
    }catch{throw new DirectoryError('invalid_response');}
  }
  private sign(value:string):Buffer{return createHmac('sha256',this.key).update(value).digest();}
}
