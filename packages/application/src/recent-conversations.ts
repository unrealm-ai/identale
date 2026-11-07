import {createHash} from 'node:crypto';
import {TaskError,taskBody,type TaskScope,type TaskService} from './tasks/index.js';
import type {Conversation} from './interaction/ports.js';
import type {EntityService} from './accounts/entity-service.js';
export interface RecentConversationCursor {conversationCeiling:number;messageCeiling:number;activityAt:number;id:string}
export interface RecentConversationFact extends Conversation {messageId:string|null;activityAt:number;canonical?:number}
export interface RecentConversationReadPort {
 ceiling(scope:{workspaceId:string;userId:string}):{conversationCeiling:number;messageCeiling:number};
 page(scope:{workspaceId:string;userId:string},cursor:RecentConversationCursor,limit:number,at:number):RecentConversationFact[];
 get(id:string):Conversation|undefined;
 canonicalId(scope:{workspaceId:string;userId:string;entityId:string}):string|undefined;
 preview(conversationId:string,messageId:string,at:number):{text:string}|undefined;
}
export class RecentConversationReadService {
 constructor(private readonly port:RecentConversationReadPort,private readonly tasks:TaskService,private readonly membership:(u:string,w:string)=>unknown,private readonly employee:(u:string,w:string,e:string)=>ReturnType<EntityService['requireReader']>,private readonly continuation:(s:TaskScope)=>{canSend:boolean;reason:string|null},private readonly visible:(s:TaskScope,c:string,m:string)=>Promise<boolean>,private readonly now:()=>number){}
 detail(userId:string,workspaceId:string,id:string){this.membership(userId,workspaceId);const row=this.port.get(id);if(!row||row.workspace_id!==workspaceId||row.channel!=='web')throw new TaskError(404,'conversation_not_found');const scope={userId,workspaceId,entityId:row.entity_id};this.tasks.conversation(scope,id);return{conversation:{id:row.id,mode:row.mode,simulated:row.mode==='demo',createdAt:row.created_at},...(row.mode==='demo'?{canSend:false,reason:'historical_demo_read_only'}:this.port.canonicalId(scope)!==row.id?{canSend:false,reason:'historical_conversation_read_only'}:this.continuation(scope))};}
 async list(userId:string,workspaceId:string,value:unknown){
  this.membership(userId,workspaceId);const q=taskBody(value,['limit','cursor']),limit=q['limit']===undefined?25:Number(q['limit']);if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new TaskError(400,'invalid_page_limit');
  const fingerprint=createHash('sha256').update(JSON.stringify([userId,workspaceId,'recent-web-v1'])).digest('hex');let cursor:RecentConversationCursor={...this.port.ceiling({userId,workspaceId}),activityAt:Number.MAX_SAFE_INTEGER,id:'\uffff'};
  if(q['cursor']!==undefined){try{if(typeof q['cursor']!=='string'||q['cursor'].length>2000)throw Error();const c=JSON.parse(Buffer.from(q['cursor'],'base64url').toString());if(c.fingerprint!==fingerprint||!['conversationCeiling','messageCeiling','activityAt'].every(k=>Number.isSafeInteger(c[k])&&c[k]>=0)||typeof c.id!=='string'||!c.id||c.id.length>160)throw Error();cursor=c;}catch{throw new TaskError(400,'invalid_page_cursor');}}
  const now=this.now(),rows=this.port.page({userId,workspaceId},cursor,limit+1,now),page=rows.slice(0,limit),records=[];
  for(const row of page){const scope={userId,workspaceId,entityId:row.entity_id};this.tasks.conversation(scope,row.id);const entity=this.employee(userId,workspaceId,row.entity_id);let preview:string|null=null,previewUnavailable=false;
   if(row.messageId){try{if(await this.visible(scope,row.id,row.messageId)){const result=this.port.preview(row.id,row.messageId,now);if(result)preview=Array.from(result.text).slice(0,160).join('');else previewUnavailable=true;}}catch{previewUnavailable=true;}}
   const available=this.continuation(scope);records.push({entity,conversation:{id:row.id,mode:row.mode,simulated:row.mode==='demo',createdAt:row.created_at},activityAt:row.activityAt,preview,previewUnavailable,...(row.mode==='demo'?{canSend:false,reason:'historical_demo_read_only'}:row.canonical!==1?{canSend:false,reason:'historical_conversation_read_only'}:available)});
  }
  const last=page.at(-1);return{records,nextCursor:rows.length>limit&&last?Buffer.from(JSON.stringify({...cursor,activityAt:last.activityAt,id:last.id,fingerprint})).toString('base64url'):null};
 }
}
