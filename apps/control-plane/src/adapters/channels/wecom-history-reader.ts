import {createHash} from 'node:crypto';
import {ChannelError,DirectoryError,assertChannelResource,type ChannelConnection,type ChannelResourceRef,type ChannelQuery,type ChannelPage,type ChannelMessage} from '@dentity/application';
import type {DirectoryAdapterOptions} from '../directory/http.js';
import {ChannelCursorCodec,channelCursorScope} from './cursor.js';
import {WeComBotGroupHistory} from './wecom-group-history.js';
// Explicit Beijing time, never the host timezone. See internal verification notes.
export function weComHistoryTime(ms:number){return new Date(ms+8*3600000).toISOString().slice(0,19).replace('T',' ');}
export function parseWeComHistoryTime(raw:string){
 if(!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw))throw new ChannelError('temporarily_unavailable','invalid_history_time');
 const time=Date.parse(raw.replace(' ','T')+'+08:00');if(!Number.isFinite(time)||weComHistoryTime(time)!==raw)throw new ChannelError('temporarily_unavailable','invalid_history_time');return time;
}
/** Runtime-only bridge. Whole provider pages go to GroupHistoryService, which
 * persists any remainder before exposing its own scoped continuation cursor. */
export class WeComHistoryReader {
 private readonly api:WeComBotGroupHistory;
 private readonly cursors=new ChannelCursorCodec();
 private readonly now:()=>number;
 constructor(private readonly connection:ChannelConnection,options:DirectoryAdapterOptions){this.api=new WeComBotGroupHistory(options);this.now=options.now??Date.now;}
 private async request<T>(work:()=>Promise<T>):Promise<T>{try{return await work();}catch(error){if(error instanceof DirectoryError)throw new ChannelError(error.code==='authorization_denied'?'forbidden':error.code==='unsupported'?'unsupported':error.code==='invalid_response'?'temporarily_unavailable':error.code==='authentication_failed'?'unauthenticated':'temporarily_unavailable');throw error;}}
 async listJoinedGroups(query:{cursor?:string}){
  const scope=JSON.stringify([this.connection,'wecom-recent-groups']);
  let range:{beginTime:string;endTime:string;cursor?:string};
  if(query.cursor){try{range=JSON.parse(this.cursors.decode(scope,query.cursor).token);}catch{throw new ChannelError('invalid_request','invalid_or_expired_channel_cursor');}}
  else {const end=Math.floor(this.now()/1000)*1000;range={beginTime:weComHistoryTime(end-7*86400000+60000),endTime:weComHistoryTime(end)};}
  const page=await this.request(()=>this.api.listGroups(range));
  return{items:page.items.map(g=>({id:g.chatId,...(g.name?{name:g.name}:{})})),...(page.hasMore?{nextCursor:this.cursors.encode(scope,{token:JSON.stringify({...range,cursor:page.nextCursor})})}:{})};
 }
 async listMessages(ref:ChannelResourceRef,query:ChannelQuery):Promise<ChannelPage<ChannelMessage>>{
  assertChannelResource(this.connection,ref);
  if(ref.kind!=='conversation'||ref.conversationKind!=='group'||query.threadId)throw new ChannelError('unsupported','wecom_group_history_only');
  if(query.order==='asc')throw new ChannelError('unsupported','wecom_history_descending_only');
  const end=query.endAt??Math.floor(this.now()/1000)*1000,start=query.startAt??end-86400000;
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start%1000||end%1000||end<=start||end>this.now()+1000||start<this.now()-7*86400000)throw new ChannelError('invalid_request','wecom_history_range_last_seven_days');
  const scope=channelCursorScope(this.connection,ref,{startAt:start,endAt:end,...(query.limit!==undefined?{limit:query.limit}:{}),order:'desc'}),cursor=query.cursor?this.cursors.decode(scope,query.cursor).token:undefined;
  const page=await this.request(()=>this.api.listMessages(ref.externalId,{beginTime:weComHistoryTime(start),endTime:weComHistoryTime(end),...(cursor?{cursor}:{})}));
  const fingerprint=createHash('sha256').update(JSON.stringify([scope,cursor??'first'])).digest('hex');
  const items=page.items.map((m,index):ChannelMessage=>({id:`wecom-history-record:${fingerprint}:${index}`,conversation:ref,conversationKind:'group',author:{kind:'unknown',identityEvidence:'unknown',externalId:m.userId,displayName:m.userName},occurredAt:parseWeComHistoryTime(m.sendTime),text:m.type==='text'?m.text??'':`[${m.type}消息，未读取附件内容]`,mentions:[]})).reverse();
  return{items,exhausted:!page.hasMore,...(page.hasMore?{nextCursor:this.cursors.encode(scope,{token:page.nextCursor!})}:{}),coverage:page.items.some(m=>m.type!=='text')?'partial':'authorized_query',fetchedAt:this.now(),warnings:[...(page.items.some(m=>m.type!=='text')?['Non-text content is represented by placeholders; attachments were not downloaded.']:[]),'WeCom history is a provider-authorized recent query, not a complete group archive.','Timestamps are interpreted as Beijing time (UTC+08:00).','Record IDs are query-local references, not provider message IDs; duplicate text is preserved.','Pages are returned newest first; group listening and keyword triggers are not enabled.']};
 }
}
