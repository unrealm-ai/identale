export type JobStatus='queued'|'running'|'succeeded'|'skipped'|'failed';
export interface ScheduledJob {id:string;key:string;handler:string;payload:unknown;status:JobStatus;attempt:number;leaseToken:string|null;leaseUntil:number;retryAt:number;error:string|null;createdAt:number;updatedAt:number}
export interface ScheduleRepository {
  enqueue(key:string,handler:string,payload:unknown,at:number,dueAt?:number):ScheduledJob;
  claim(at:number,leaseMs:number):ScheduledJob|undefined;
  owns(id:string,token:string,at:number):boolean;
  settle(id:string,token:string,status:JobStatus,retryAt:number,error:string|null,at:number):boolean;
}
export type JobHandler=(job:ScheduledJob)=>Promise<{status:'succeeded'|'skipped'|'retry'|'waiting'|'failed';reason?:string}>;
/** Durable queue mechanics only. Handlers own business/runtime semantics. */
export class Scheduler {
  private running:Promise<void>|undefined;
  private stopped=false;
  constructor(private readonly repository:ScheduleRepository,private readonly handlers:Readonly<Record<string,JobHandler>>,private readonly now:()=>number,private readonly options:{leaseMs?:number;maxAttempts?:number}={}){}
  enqueue(key:string,handler:string,payload:unknown){if(!this.handlers[handler])throw new Error('Unsupported scheduled handler');return this.repository.enqueue(key,handler,payload,this.now());}
  tick():Promise<void>{if(this.stopped)return Promise.resolve();if(this.running)return this.running;const work=this.run();this.running=work.finally(()=>{this.running=undefined;});return this.running;}
  private async run(){const job=this.repository.claim(this.now(),this.options.leaseMs??120_000);if(!job)return;const handler=this.handlers[job.handler];let result:Awaited<ReturnType<JobHandler>>;
    if(!handler)result={status:'failed',reason:'unsupported_handler'};
    else try{result=await handler(job);}catch{result={status:'retry',reason:'handler_unavailable'};}
    const waiting=result.status==='waiting',retry=result.status==='retry'||waiting,exhausted=!waiting&&job.attempt>=(this.options.maxAttempts??5);
    this.repository.settle(job.id,job.leaseToken!,retry?(exhausted?'failed':'queued'):result.status as JobStatus,retry?this.now()+Math.min(60_000,1000*2**Math.min(job.attempt-1,6)):0,result.reason??null,this.now());
  }
  async stop(){this.stopped=true;await this.running;}
}
