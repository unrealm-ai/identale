import {createHash,randomBytes} from 'node:crypto';
import {DirectoryError} from '@dentity/application';
import {DirectoryHttp,object,providerFailure,string,type DirectoryAdapterOptions} from '../directory/http.js';

const origin='https://qyapi.weixin.qq.com';
export interface WeComHistoryRange {beginTime:string;endTime:string;cursor?:string}
export interface WeComHistoryGroup {chatId:string;name?:string;lastMessageTime?:string}
export interface WeComHistoryMessage {userId:string;userName:string;sendTime:string;type:string;text?:string}
export interface WeComHistoryPage<T> {items:T[];hasMore:boolean;nextCursor?:string}
/** Runtime-only official CLI HTTP transport. IDs and date strings are opaque:
 * never equate them with callback identities or infer a timezone here.
 * No synthetic provider message IDs or content-based deduplication.
 */
export class WeComBotGroupHistory {
 private readonly http:DirectoryHttp;
 private session:Promise<{token:string;groups:string;messages:string}>|undefined;
 private expires=0;
 constructor(private readonly options:DirectoryAdapterOptions){this.http=new DirectoryHttp({...options,timeoutMs:15000,maxResponseBytes:4*1024*1024});}
 private parse(value:unknown){if(typeof value!=='string'||value.length>4*1024*1024)throw new DirectoryError('invalid_response');try{return object(JSON.parse(value));}catch{throw new DirectoryError('invalid_response');}}
 private failure(value:Record<string,unknown>){const code=Number(value.errcode??value.code);if(code===853004||code===40001||code===40014)throw new DirectoryError('authentication_failed');throw providerFailure(value,[48002,850002,851008,853006].includes(code)?'authorization_denied':'unavailable');}
 private async call(path:string,payload:object,token:string){
  const raw=await this.http.request(origin,path,'POST',{payload:JSON.stringify(payload)},{authorization:`Bearer ${token}`});
  if(raw.errcode!==0)this.failure(raw);
  const wrapped=this.parse(raw.results_json);
  if(wrapped.error&&Number(object(wrapped.error).code)!==0)this.failure(object(wrapped.error));
  return this.parse(wrapped.result);
 }
 private async connect(){
  const time=Math.floor(this.http.now()/1000),nonce=`cli_${this.http.now()}_${randomBytes(4).toString('hex')}`;
  const signature=createHash('sha256').update(this.options.appSecret+this.options.appId+time+nonce).digest('hex');
  const auth=await this.http.request(origin,'/cgi-bin/aibot/cli/get_cli_config','POST',{bot_id:this.options.appId,time,nonce,signature,bind_source:1},{},true);
  if(auth.errcode!==0)this.failure(auth);
  const token=string(auth.token);if(/[\s\x7f]/.test(token))throw new DirectoryError('invalid_response');
  const schema=await this.call('/cli/service/discovery',{service:'chat'},token),resources=object(schema.resources);
  const route=(resource:'groups'|'messages')=>{
   const methods=object(object(resources[resource]).methods),method=object(methods.list);
   if(method.http_method!=='POST'||method.path!==`/chat/${resource}/list`)throw new DirectoryError('unsupported');
   const prefix=schema.base_url===undefined?origin+'/cli':string(schema.base_url);
   const url=new URL(prefix.replace(/\/$/,'')+method.path);
   if(url.origin!==origin||url.pathname!==`/cli/chat/${resource}/list`||url.search||url.hash||url.username||url.password)throw new DirectoryError('invalid_response');
   return url.pathname;
  };
  return {token,groups:route('groups'),messages:route('messages')};
 }
 private range(range:WeComHistoryRange){
  const valid=(s:string)=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s);
  if(!valid(range.beginTime)||!valid(range.endTime)||range.endTime<=range.beginTime||range.cursor!==undefined&&(typeof range.cursor!=='string'||!range.cursor||range.cursor.length>8192||/[\x00-\x1f\x7f]/.test(range.cursor)))throw new DirectoryError('invalid_response');
  return {begin_time:range.beginTime,end_time:range.endTime,...(range.cursor?{cursor:range.cursor}:{})};
 }
 private async request(kind:'groups'|'messages',payload:object){
  for(let attempt=0;attempt<2;attempt++){
   if(!this.session||this.expires<=this.http.now()){this.expires=this.http.now()+60_000;this.session=this.connect();}
   const pending=this.session;let session;
   try{session=await pending;}catch(error){if(this.session===pending)this.session=undefined;throw error;}
   try{return await this.call(session[kind],payload,session.token);}catch(error){
    if(!(error instanceof DirectoryError)||error.code!=='authentication_failed')throw error;
    if(this.session===pending)this.session=undefined;if(attempt)throw error;
   }
  }
  throw new DirectoryError('authentication_failed');
 }
 private page<T>(raw:Record<string,unknown>,items:T[]):WeComHistoryPage<T>{
  if(typeof raw.has_more!=='boolean')throw new DirectoryError('invalid_response');
  const cursor=raw.next_cursor;if(cursor!==undefined&&typeof cursor!=='string'||typeof cursor==='string'&&(cursor.length>8192||/[\x00-\x1f\x7f]/.test(cursor))||raw.has_more&&!cursor)throw new DirectoryError('invalid_response');
  return {items,hasMore:raw.has_more,...(raw.has_more?{nextCursor:cursor as string}:{})};
 }
 async listGroups(range:WeComHistoryRange){
  const raw=await this.request('groups',this.range(range));
  if(!Array.isArray(raw.chats)||raw.chats.length>10000)throw new DirectoryError('invalid_response');
  return this.page(raw,raw.chats.map(item=>{const group=object(item);return {chatId:string(group.chat_id),...(typeof group.chat_name==='string'&&group.chat_name?{name:group.chat_name}:{}),...(typeof group.last_msg_time==='string'?{lastMessageTime:group.last_msg_time}:{})};}));
 }
 async listMessages(chatId:string,range:WeComHistoryRange){
  const id=string(chatId);if(id.length>8192)throw new DirectoryError('invalid_response');
  const raw=await this.request('messages',{chat_id:id,...this.range(range)});
  if(!Array.isArray(raw.messages)||raw.messages.length>10000)throw new DirectoryError('invalid_response');
  return this.page(raw,raw.messages.map(item=>{
   const message=object(item),type=string(message.msg_type);
   const text=type==='text'?object(message.text).content:undefined;
   if(type==='text'&&typeof text!=='string')throw new DirectoryError('invalid_response');
   return {userId:string(message.userid),userName:typeof message.user_name==='string'?message.user_name:'',sendTime:string(message.send_time),type,...(typeof text==='string'?{text}:{})};
  }));
 }
}
