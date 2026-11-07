import {randomUUID} from 'node:crypto';
import type {RuntimeInteractionEvent} from '@dentity/contracts';
import type {ConversationRepository} from './ports.js';
import type {InteractionService} from './service.js';
import {scopeFromJson,type TaskRow,type TaskScope,type TaskService} from '../tasks/index.js';
import {nullDiagnostics,diagnosticFailure,type DiagnosticPort} from '../diagnostics.js';

export interface TaskCompletionNotification {
  id:string;taskId:string;runId:string;conversationId:string;scopeJson:string;attempts:number;turnId:string|null;status:string;
}
export interface TaskCompletionNotificationRepository {
  discover(at:number):void;
  claim(at:number,until:number,token:string):TaskCompletionNotification|undefined;
  owns(id:string,token:string):boolean;
  begin(id:string,token:string,turnId:string):void;
  defer(id:string,token:string,retryAt:number,error:string,resetTurn?:boolean):void;
  event(row:TaskCompletionNotification):RuntimeInteractionEvent;
  publish(row:TaskCompletionNotification,token:string,text:string,at:number,assertAllowed:()=>void):void;
  messageTask(id:string):string|undefined;
  suppressDelivery(id:string):boolean;
}

/** Notification retries cannot dispatch, mutate or restart a business task. */
export class TaskCompletionNotifications {
  private busy=false;
  private stopping=false;
  private idle:(()=>void)[]=[];
  constructor(private readonly repository:TaskCompletionNotificationRepository,_conversations:ConversationRepository,private readonly tasks:TaskService,private readonly interaction:InteractionService,private readonly now:()=>number,private readonly diagnostics:DiagnosticPort=nullDiagnostics){}
  private async authorize(row:TaskCompletionNotification):Promise<{scope:TaskScope;task:TaskRow}>{
    const scope=scopeFromJson(row.scopeJson),task=await this.tasks.refreshTaskContext({...scope,conversationId:row.conversationId},row.taskId);
    this.tasks.conversation(scope,row.conversationId);
    if(!['succeeded','failed'].includes(task.status)||task.run_id!==row.runId)throw Error('notification_result_changed');
    return{scope,task};
  }
  async visibleMessage(scope:TaskScope,conversationId:string,id:string){
    const taskId=this.repository.messageTask(id);if(!taskId)return true;
    try{await this.tasks.refreshTaskContext({...scope,conversationId},taskId);return true;}catch{return false;}
  }
  async tick(){
    if(this.busy||this.stopping)return;this.busy=true;
    try{
      this.repository.discover(this.now());
      for(let i=0;i<20&&!this.stopping;i++){
        const token=randomUUID(),row=this.repository.claim(this.now(),this.now()+120_000,token);if(!row)break;
        await this.diagnostics.run({traceId:row.id,messageId:`task-notification:${row.id}`,attemptId:token,taskId:row.taskId,conversationId:row.conversationId},async()=>{
        const started=this.now();
        this.diagnostics.event({stage:'notification',phase:'start'});
        try{
          const {scope}=await this.authorize(row);if(!this.repository.owns(row.id,token))return;
          const operationId=row.turnId??`task-event:${row.id}:${row.attempts+1}`;
          if(!row.turnId){row.turnId=operationId;this.repository.begin(row.id,token,operationId);row.attempts++;}
          const result=await this.interaction.acceptTaskEvent(scope,row.conversationId,operationId,this.repository.event(row));
          if(!this.repository.owns(row.id,token))return;
          if(result.receipt.status==='processed'){
            const current=await this.authorize(row);if(!this.repository.owns(row.id,token))return;
            this.repository.publish(row,token,result.text??'',this.now(),()=>{this.tasks.authorizeTask(current.task);this.tasks.conversation(current.scope,row.conversationId);});
          }else if(result.receipt.status==='failed')this.repository.defer(row.id,token,this.now()+Math.min(60_000,1000*2**Math.min(row.attempts,6)),'notification_generation_failed',true);
          else this.repository.defer(row.id,token,this.now()+1000,result.receipt.status==='unsupported'?'interaction_events_unsupported':'notification_waiting');
        }catch(error){
          this.diagnostics.event({stage:'notification',phase:'point',outcome:'failure',...diagnosticFailure(error)});
          // Busy/revoked/unconfigured notifications stay durable; no raw-result fallback.
          const code=error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'?error.code:'notification_unavailable';
          if(this.repository.owns(row.id,token))this.repository.defer(row.id,token,this.now()+1000,code);
        }finally{this.diagnostics.event({stage:'notification',phase:'end',durationMs:this.now()-started});}
        });
      }
    }finally{this.busy=false;for(const resolve of this.idle.splice(0))resolve();}
  }
  async stop(){this.stopping=true;if(this.busy)await new Promise<void>(resolve=>this.idle.push(resolve));}
}
