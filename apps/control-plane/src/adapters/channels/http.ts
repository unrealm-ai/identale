import {redactMessageJson} from '../message-json.js';
import { ChannelError,diagnosticFailure,httpFailureCategory, type DiagnosticPort,type ChannelConnection } from '@dentity/application';

export type CredentialResolver = (connection: ChannelConnection, purpose: 'access_token' | 'webhook_encrypt_key' | 'webhook_verification_token' | 'webhook_app_secret') => Promise<string>;
export interface ProviderHttpOptions {
  resolveCredential: CredentialResolver;
  /** Host-only injection for local contract tests, never an API request field. */
  fetch?: typeof fetch;
  diagnostics?:DiagnosticPort;
  now?: () => number;
  timeoutMs?: number;
  maxResponseBytes?: number;
}
export const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ChannelError('temporarily_unavailable', 'provider_response_shape_invalid');
  return value as Record<string, unknown>;
};
export const string = (value: unknown): string => {
  if (typeof value !== 'string') throw new ChannelError('temporarily_unavailable', 'provider_response_shape_invalid');
  return value;
};
export const optionalString = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined;
export const array = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new ChannelError('temporarily_unavailable', 'provider_response_shape_invalid');
  return value;
};
export const timestamp = (value: unknown): number => {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0) throw new ChannelError('temporarily_unavailable', 'provider_timestamp_invalid');
  return number;
};
export function validateText(text: string): void {
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 16000) throw new ChannelError('invalid_request', 'invalid_outbound_text');
}
export class ProviderHttp {
  readonly now: () => number;
  private readonly fetch: typeof fetch;
  private readonly timeout: number;
  private readonly maxBytes: number;
  private readonly origin: string;
  constructor(readonly connection: ChannelConnection, private readonly options: ProviderHttpOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.timeout = options.timeoutMs ?? 15000;
    this.maxBytes = options.maxResponseBytes ?? 8 * 1024 * 1024;
    this.origin = connection.provider === 'feishu' ? 'https://open.feishu.cn' : 'https://api.dingtalk.com';
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 1 || this.timeout > 60000 || !Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > 32 * 1024 * 1024) throw new ChannelError('invalid_request', 'invalid_provider_http_limits');
  }
  async credential(purpose: Parameters<CredentialResolver>[1]): Promise<string> {
    let secret: string;
    try { secret = await this.options.resolveCredential(this.connection, purpose); }
    catch { throw new ChannelError('unauthenticated', 'channel_credential_unavailable'); }
    if (typeof secret !== 'string' || !secret || secret.length > 32768 || /[\r\n]/.test(secret)) throw new ChannelError('unauthenticated', 'channel_credential_invalid');
    return secret;
  }
  private async readResponse(response:Response):Promise<string>{
    const reader = response.body?.getReader();
    if (!reader) throw new ChannelError('temporarily_unavailable', 'provider_empty_response');
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const item = await reader.read(); if (item.done) break;
        size += item.value.byteLength;
        if (size > this.maxBytes) { await reader.cancel(); throw new ChannelError('temporarily_unavailable', 'provider_response_too_large'); }
        chunks.push(item.value);
      }
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks).toString('utf8');
  }
  /** Dedicated official upload endpoint. Never accepts a URL or model media key. Upload is not message delivery. */
  async uploadDingTalkMedia(attachment: import('./native-media.js').NativeAttachment, assertSendAllowed?:()=>void):Promise<string> {
    if(this.connection.provider!=='dingtalk')throw new ChannelError('invalid_request');
    const token=await this.credential('access_token');
    assertSendAllowed?.();
    const url=new URL('https://oapi.dingtalk.com/media/upload');
    url.searchParams.set('access_token',token);
    const form=new FormData();form.append('type',attachment.kind);
    form.append('media',new Blob([new Uint8Array(attachment.bytes)],{type:attachment.mediaType}),attachment.name);
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.timeout);timer.unref();
    try {
      const response=await this.fetch(url,{method:'POST',body:form,redirect:'error',signal:controller.signal,headers:{accept:'application/json'}});
      if(response.status===401)throw new ChannelError('unauthenticated');
      if(response.status===403)throw new ChannelError('forbidden');
      if(response.status===429)throw new ChannelError('rate_limited');
      if(!response.ok)throw new ChannelError('temporarily_unavailable','native_upload_failed');
      const data=object(JSON.parse(await this.readResponse(response)));
      if(data.errcode!==0||data.type!==attachment.kind||typeof data.media_id!=='string'||!data.media_id||data.media_id.length>2048)throw new ChannelError('temporarily_unavailable','native_upload_unconfirmed');
      return data.media_id;
    }catch(error){
      if(error instanceof ChannelError)throw error;
      // Never surface token-bearing URLs/raw errors, and never classify an upload as a sent message.
      throw new ChannelError('temporarily_unavailable','native_upload_failed');
    }finally{clearTimeout(timer);}
  }
  async request(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown, responseKind: 'json' | 'text' = 'json', assertSendAllowed?: () => void): Promise<unknown> {
    if (!path.startsWith('/') || path.startsWith('//')) throw new ChannelError('invalid_request');
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin) throw new ChannelError('invalid_request');
    const logMessage=this.connection.provider==='feishu'&&method==='POST'&&(url.pathname==='/open-apis/im/v1/messages'||/^\/open-apis\/im\/v1\/messages\/[^/]+\/reply$/.test(url.pathname));
    const started=this.now();let responseLogged=false,observedStatus:number|undefined,token:string|undefined;
    const messageRequest={method,path:url.pathname,query:[...url.searchParams],body};
    const observe=(event:import('@dentity/application').DiagnosticEvent)=>{if(!logMessage)return;try{this.options.diagnostics?.event({...event,...(event.json!==undefined?{json:redactMessageJson(event.json,token?[token]:[])}:{})});}catch{/* Logging cannot alter transport, response parsing or dispatch. */}};
    try{token=await this.credential('access_token');assertSendAllowed?.();}
    catch(error){observe({stage:'feishu.message',phase:'end',messageKind:'send_request',json:messageRequest,outcome:'failure',status:'failed',reason:'send_failed',...diagnosticFailure(error)});throw error;}
    const headers:Record<string,string>={'accept':'application/json'};
    if(this.connection.provider==='feishu')headers.authorization=`Bearer ${token}`;
    else headers['x-acs-dingtalk-access-token']=token;
    if(body!==undefined&&!(body instanceof FormData))headers['content-type']='application/json';
    const rejectStatus=(response:Response)=>{
      if(response.status===401)throw new ChannelError('unauthenticated');
      if(response.status===403)throw new ChannelError('forbidden');
      if(response.status===404)throw new ChannelError('not_found');
      if(response.status===429){const seconds=Number(response.headers.get('retry-after'));throw new ChannelError('rate_limited','rate_limited',Number.isFinite(seconds)&&seconds>0?Math.min(seconds*1000,3600000):undefined);}
      if(!response.ok)throw new ChannelError('temporarily_unavailable','provider_http_error');
    };
    let response: Response;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout); timer.unref();
    try {
      observe({stage:'feishu.message',phase:'start',messageKind:'send_request',json:messageRequest});
      response = await this.fetch(url, {method, headers, redirect:'error', signal:controller.signal, ...(body === undefined ? {} : {body:body instanceof FormData?body:JSON.stringify(body)})});
      observedStatus=response.status;
      if(logMessage){
        let parsed:unknown,decodeError:unknown;
        try{
          const raw=await this.readResponse(response);
          try{parsed=JSON.parse(raw);}catch{decodeError=new ChannelError('delivery_unknown','provider_response_not_json');parsed={responseFormat:'text',rawBody:raw};}
          const code=parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?(parsed as Record<string,unknown>)['code']:undefined;
          const success=response.ok&&!decodeError&&code===0;
          observe({stage:'feishu.message',phase:'end',messageKind:'send_response',json:parsed,httpStatus:response.status,outcome:success?'success':'failure',durationMs:this.now()-started,...(!success?{category:response.ok?(decodeError?'parse':'provider'):httpFailureCategory(response.status)}:{}),...(typeof code==='number'&&Number.isSafeInteger(code)?{providerCode:code}:{})});
          responseLogged=true;
        }catch(error){decodeError=error;}
        // A known HTTP rejection stays a rejection even if its error body cannot be read.
        rejectStatus(response);
        if(decodeError)throw decodeError;
        return parsed;
      }
      rejectStatus(response);
      const text=await this.readResponse(response);
      if (responseKind === 'text') return text;
      try { return JSON.parse(text); }
      catch { throw new ChannelError(method === 'POST' ? 'delivery_unknown' : 'temporarily_unavailable', 'provider_response_not_json'); }
    } catch (error) {
      if(logMessage&&!responseLogged){const rejected=observedStatus!==undefined&&[401,403,404,429].includes(observedStatus);observe({stage:'feishu.message',phase:'end',messageKind:'send_response',outcome:rejected?'failure':'unknown',status:rejected?'failed':'unknown',reason:rejected?'send_failed':'delivery_unknown',durationMs:this.now()-started,...diagnosticFailure(error),...(observedStatus!==undefined?{httpStatus:observedStatus,category:httpFailureCategory(observedStatus)}:{category:controller.signal.aborted?'timeout':'network'})});}
      if (error instanceof ChannelError) {
        if (method === 'POST' && error.code === 'temporarily_unavailable') throw new ChannelError('delivery_unknown', error.message);
        throw error;
      }
      // A request may have reached the provider. Never automatically retry writes.
      throw new ChannelError(method === 'POST' ? 'delivery_unknown' : 'temporarily_unavailable');
    } finally { clearTimeout(timer); }
  }
  async feishuUpload(path:'/open-apis/im/v1/images'|'/open-apis/im/v1/files',body:FormData,assertSendAllowed?:()=>void):Promise<Record<string,unknown>> {
    try{return await this.feishu(path,'POST',body,assertSendAllowed);}
    catch(error){if(error instanceof ChannelError&&error.code==='delivery_unknown')throw new ChannelError('temporarily_unavailable','native_upload_unconfirmed');throw error;}
  }
  async feishuText(path: string): Promise<string> {
    const text = string(await this.request(path, 'GET', undefined, 'text'));
    // Export errors can be JSON even though successful responses are text streams.
    let possible: unknown; try { possible = JSON.parse(text); } catch { return text; }
    if (possible && typeof possible === 'object' && 'code' in possible) {
      const code = (possible as Record<string,unknown>).code;
      if (code === 2091003) throw new ChannelError('not_ready');
      if (code === 2091005 || code === 99991672) throw new ChannelError('forbidden');
      if (code === 99991663 || code === 99991664 || code === 99991668) throw new ChannelError('unauthenticated');
      throw new ChannelError('temporarily_unavailable','unexpected_export_envelope');
    }
    return text;
  }
  async feishu(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown, assertSendAllowed?: () => void): Promise<Record<string, unknown>> {
    const response = await this.request(path, method, body, 'json', assertSendAllowed);
    let envelope: Record<string,unknown>;
    try { envelope = object(response); } catch { throw new ChannelError(method === 'POST' ? 'delivery_unknown' : 'temporarily_unavailable','provider_response_shape_invalid'); }
    if (method === 'POST' && typeof envelope.code !== 'number') throw new ChannelError('delivery_unknown','provider_response_shape_invalid');
    if (envelope.code !== 0) {
      const code = envelope.code;
      if (code === 2091003) throw new ChannelError('not_ready');
      if (code === 2091005 || code === 99991672) throw new ChannelError('forbidden');
      if (code === 99991663 || code === 99991664 || code === 99991668) throw new ChannelError('unauthenticated');
      throw new ChannelError(method === 'POST' ? 'delivery_unknown' : 'temporarily_unavailable', 'provider_business_error');
    }
    try { return object(envelope.data); } catch { throw new ChannelError(method === 'POST' ? 'delivery_unknown' : 'temporarily_unavailable','provider_response_shape_invalid'); }
  }
}
