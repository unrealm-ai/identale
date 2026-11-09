import {directoryOperationMetadata} from './directory/operation-metadata.js';
import {redactMessageJson} from './message-json.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {DiagnosticFileWriter} from './diagnostic-file-writer.js';
import {diagnosticStages,diagnosticReasons,diagnosticCategories,diagnosticCodes,modelResponseIssues,isModelResponseCapture,safeModelProbeDiagnostic,safeModelRequestDiagnostic,safeDingtalkIdentityDiagnostic,diagnosticOperations,diagnosticEndpoints,diagnosticFailure,httpFailureCategory,type DiagnosticContext,type DiagnosticEvent,type DiagnosticPort,type DiagnosticStage} from '@dentity/application';

/** The bounded file sink is independent of business transactions and conversation journals. */
export class FileDiagnostics implements DiagnosticPort {
 private readonly local=new AsyncLocalStorage<DiagnosticContext>();
 private readonly instanceId=randomUUID();
 private readonly queue:{line:string;bytes:number;critical:boolean;at:number}[]=[];
 private queueBytes=0;private inFlight=0;private inFlightAt:number|undefined;private writing:Promise<void>|undefined;private scheduled=false;private stopped=false;private closing:Promise<void>|undefined;
 private readonly warnings=new Map<string,number>();
 private readonly aggregates=new Map<string,{safe:Record<string,unknown>;count:number;duration:number;at:number}>();
 private readonly counters={dropped:0,writeFailures:0,queueFull:0,queueBytes:0,serialization:0,afterClose:0,ioFailure:0,shutdownRemaining:0,shutdownDropped:0,evictedNormal:0,queuePeak:0,bytePeak:0,written:0,aggregated:0};
 private readonly writer:DiagnosticFileWriter;
 private monitor:ReturnType<typeof monitorEventLoopDelay>|undefined;private monitorTimer:ReturnType<typeof setInterval>|undefined;
 private readonly bootAt=new Date().toISOString();
 constructor(readonly root:string,private readonly options:{now?:()=>number;maxBytes?:number;maxTotalBytes?:number;retentionMs?:number;maxQueue?:number;maxQueueBytes?:number;warn?:(warning:Record<string,unknown>)=>void;aggregateMs?:number;closeTimeoutMs?:number;beforeWrite?:()=>Promise<void>}={}){
  this.writer=new DiagnosticFileWriter(root,{now:()=>this.now(),maxBytes:options.maxBytes??5*1024*1024,maxTotalBytes:options.maxTotalBytes??50*1024*1024,retentionMs:options.retentionMs??7*86400000,...(options.beforeWrite?{beforeWrite:options.beforeWrite}:{})});
 }
 get stats(){return{...this.counters,...this.writer.stats,queued:this.queue.length,queuedBytes:this.queueBytes,inFlight:this.inFlight,oldestWaitMs:Math.max(0,this.now()-(this.queue[0]?.at??this.inFlightAt??this.now()))};}
 startMonitoring(intervalMs=30000){if(this.monitor)return;this.monitor=monitorEventLoopDelay({resolution:20});this.monitor.enable();this.event({stage:'diagnostic.health',phase:'point',state:'started',metrics:this.stats});this.monitorTimer=setInterval(()=>{this.flushAggregates();this.event({stage:'diagnostic.health',phase:'point',state:'running',metrics:{...this.stats,eventLoopP99Ms:this.monitor!.percentile(99)/1e6,eventLoopMaxMs:this.monitor!.max/1e6}});this.monitor!.reset();},intervalMs);this.monitorTimer.unref();}
 private now(){return(this.options.now??Date.now)();}
 context(){return this.local.getStore();}
 run<T>(context:DiagnosticContext,work:()=>T):T{return this.local.run(context,work);}
 event(event:DiagnosticEvent){
  try{
   if(this.stopped){this.drop('afterClose');return;}
   if(!diagnosticStages.includes(event.stage)||!['start','end','point'].includes(event.phase))return;
   const raw={...this.context(),...event},safe:Record<string,unknown>={version:1,at:new Date(this.now()).toISOString(),instanceId:this.instanceId,pid:process.pid,processRole:'control-plane',loggerVersion:2,nodeVersion:process.version,bootAt:this.bootAt,stage:event.stage,phase:event.phase,...(this.stats.dropped?{droppedEvents:this.stats.dropped}:{}),...(this.stats.writeFailures?{logWriteFailures:this.stats.writeFailures}:{})};
   for(const key of ['traceId','messageId','attemptId','causationId','conversationId','taskId','runId','sessionId','turnId','providerEventRef'] as const){const v=raw[key];if(typeof v==='string'&&/^(?:(?:turn|task-delivery|task-notification):)?(?:[a-f0-9]{64}|[a-f0-9-]{36})$/.test(v))safe[key]=v;}
   if(event.outcome&&['success','failure','queued','duplicate','unknown'].includes(event.outcome))safe.outcome=event.outcome;
   const identityFailure=event.stage==='ingress.received'&&event.outcome==='failure'&&event.reason==='identity_invalid'&&event.ingressIdentity!==undefined;
   if(identityFailure){const metadata=safeDingtalkIdentityDiagnostic(event.ingressIdentity);if(metadata)safe.ingressIdentity=metadata;}
   if(['ingress.received','reply.generated','outbox.send','feishu.message'].includes(event.stage)){
    if(!identityFailure&&typeof event.text==='string'&&Buffer.byteLength(event.text)<=1024*1024)safe.text=event.text;
    if(event.status&&['received','generated','sent','accepted','blocked','failed','unknown','expired','ignored','duplicate'].includes(event.status))safe.status=event.status;
    if(event.reason&&(diagnosticReasons as readonly string[]).includes(event.reason))safe.reason=event.reason;
   }
   if(event.category&&diagnosticCategories.includes(event.category))safe.category=event.category;
   for(const key of ['durationMs','queueMs'] as const){const value=event[key];if(typeof value==='number'&&Number.isFinite(value)&&value>=0)safe[key]=Math.min(Math.round(value),86400000);}
   for(const key of ['sourceAt','receivedAt'] as const){const value=event[key];if(typeof value==='number'&&Number.isFinite(value)&&value>0&&value<=4102444800000)safe[key]=new Date(value).toISOString();}
   if(Number.isInteger(event.httpStatus)&&event.httpStatus!>=100&&event.httpStatus!<=599)safe.httpStatus=event.httpStatus;
   if(typeof event.providerCode==='number'&&Number.isSafeInteger(event.providerCode)||typeof event.providerCode==='string'&&(diagnosticCodes as readonly string[]).includes(event.providerCode))safe.providerCode=event.providerCode;
   if(event.modelResponseIssue&&(modelResponseIssues as readonly string[]).includes(event.modelResponseIssue))safe.modelResponseIssue=event.modelResponseIssue;
   if(event.stage==='model.http'&&event.operation==='model.request.metadata'){
    const metadata=safeModelRequestDiagnostic(event.modelRequest);if(metadata)safe.modelRequest=metadata;
   }else if(event.stage==='model.http'&&event.operation==='model.connection.test'){
    const probe=safeModelProbeDiagnostic(event.modelProbe);if(probe)safe.modelProbe=probe;
   }else if(event.stage==='model.http'&&event.phase==='point'&&event.outcome==='failure'&&isModelResponseCapture(event.modelResponse))safe.modelResponse=event.modelResponse;
   if(event.operation&&(diagnosticOperations as readonly string[]).includes(event.operation))safe.operation=event.operation;
   if(event.endpoint&&(diagnosticEndpoints as readonly string[]).includes(event.endpoint))safe.endpoint=event.endpoint;
   if(event.userIdType&&['open_id','user_id','union_id'].includes(event.userIdType))safe.userIdType=event.userIdType;
   if(event.departmentIdType&&['open_department_id','department_id'].includes(event.departmentIdType))safe.departmentIdType=event.departmentIdType;
   if(typeof event.rootDepartment==='boolean')safe.rootDepartment=event.rootDepartment;
   if(typeof event.requestId==='string'&&/^[A-Za-z0-9_-]{8,100}$/.test(event.requestId))safe.requestId=event.requestId;
   if(event.stage==='capability.filtered'){for(const key of ['resourceId','packageId','workspaceId','entityId'] as const){const value=event[key];if(typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.:@-]{0,199}$/.test(value))safe[key]=value;}if(event.resourceKind==='skill'||event.resourceKind==='mcp')safe.resourceKind=event.resourceKind;if(event.filterReason==='resource_disabled'||event.filterReason==='package_disabled')safe.filterReason=event.filterReason;}
   const messageKind=!identityFailure&&((event.stage==='ingress.received'&&event.messageKind==='receive')||(event.stage==='feishu.message'&&['send_request','send_response'].includes(event.messageKind??'')));
   if(messageKind)safe.messageKind=event.messageKind;
   const messageJson=messageKind&&event.json!==undefined;
   if(messageJson)safe.json=redactMessageJson(event.json);
   if(event.state&&['queued','accepted','running','waiting','succeeded','failed','canceled','unknown','started','stopping'].includes(event.state))safe.state=event.state;
   if(event.stage==='runtime'&&event.metrics){const metrics:Record<string,number>={};for(const key of ['requestedCursor','returnedThrough','count','sequence']){const value=event.metrics[key];if(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0)metrics[key]=value;}safe.metrics=metrics;}
   if(event.stage==='diagnostic.health'&&event.metrics){const metrics:Record<string,number>={};for(const key of [...Object.keys(this.stats),'eventLoopP99Ms','eventLoopMaxMs','diskAvailableBytes','diskLowWater']){const value=event.metrics[key];if(typeof value==='number'&&Number.isFinite(value)&&value>=0)metrics[key]=Math.round(value*100)/100;}safe.metrics=metrics;}
   if(this.aggregate(safe))return;
   this.encode(safe);
  }catch{this.drop('serialization');}
 }
 private encode(safe:Record<string,unknown>){
  try{const messageJson=safe.json!==undefined;const encoded=JSON.stringify(safe)+'\n',max=this.options.maxBytes??5*1024*1024;
   let lines=[encoded];
   if(messageJson&&Buffer.byteLength(encoded)>max){
    const json=JSON.stringify(safe.json);delete safe.json;
    const base={...safe,jsonId:randomUUID()},budget=Math.min(256*1024,Math.floor((max-Buffer.byteLength(JSON.stringify(base))-128)/4));
    if(budget<1)throw new Error();
    const chunks:string[]=[];let part='',bytes=0;
    for(const char of json){const size=Buffer.byteLength(char);if(bytes+size>budget&&part){chunks.push(part);part='';bytes=0;}part+=char;bytes+=size;}if(part)chunks.push(part);
    lines=chunks.map((jsonChunk,index)=>JSON.stringify({...base,part:index+1,parts:chunks.length,jsonChunk})+'\n');
   }
   this.enqueue(lines,!['interaction.poll','inbox.consume'].includes(String(safe.stage))||safe.outcome==='failure'||!!safe.category||['succeeded','failed','canceled','unknown'].includes(String(safe.state)));
  }catch{this.drop('serialization');}
 }
 private aggregate(safe:Record<string,unknown>){
  if(!['interaction.poll','inbox.consume'].includes(String(safe.stage))||!safe.messageId&&!safe.traceId&&!safe.turnId)return false;
  const key=JSON.stringify([safe.messageId??safe.traceId??safe.turnId,safe.stage,safe.phase]);const old=this.aggregates.get(key);
  const significant=safe.outcome==='failure'||!!safe.category||['succeeded','failed','canceled','unknown'].includes(String(safe.state));
  const changed=old&&(old.safe.state!==safe.state||old.safe.outcome!==safe.outcome);
  if(significant||changed){if(old){this.emitAggregate(old);this.aggregates.delete(key);}if(significant)return false;}
  const current=this.aggregates.get(key);
  if(current){current.count++;current.duration+=Number(safe.durationMs??0);current.safe=safe;this.counters.aggregated++;if(this.now()-current.at>=(this.options.aggregateMs??5000)){this.emitAggregate(current);current.count=0;current.duration=0;current.at=this.now();}return true;}
  if(this.aggregates.size>=1024){const [oldKey,value]=this.aggregates.entries().next().value!;this.emitAggregate(value);this.aggregates.delete(oldKey);}
  this.aggregates.set(key,{safe,count:0,duration:0,at:this.now()});return false;
 }
 private emitAggregate(a:{safe:Record<string,unknown>;count:number;duration:number;at:number}){if(a.count)this.encode({...a.safe,aggregateCount:a.count,aggregateWindowMs:Math.max(0,this.now()-a.at),aggregateDurationMs:a.duration});}
 private flushAggregates(){for(const a of this.aggregates.values()){this.emitAggregate(a);a.count=0;a.duration=0;a.at=this.now();}}
 private drop(reason:'queueFull'|'queueBytes'|'serialization'|'afterClose'|'ioFailure',count=1){this.counters.dropped+=count;this.counters[reason]+=count;this.warn(reason);}
 private enqueue(lines:string[],critical:boolean){
  const bytes=lines.reduce((n,s)=>n+Buffer.byteLength(s),0),max=this.options.maxQueue??2048,limit=this.options.maxQueueBytes??8*1024*1024;
  if(critical)while(this.queue.length+lines.length>max||this.queueBytes+bytes>limit){const index=this.queue.findIndex(r=>!r.critical);if(index<0)break;const [r]=this.queue.splice(index,1);this.queueBytes-=r!.bytes;this.counters.evictedNormal++;this.drop(this.queue.length+lines.length>=max?'queueFull':'queueBytes');}
  const normalMax=Math.max(1,Math.floor(max*.8));
  if(this.queue.length+lines.length>(critical?max:normalMax)){this.drop('queueFull',lines.length);return;}if(this.queueBytes+bytes>limit){this.drop('queueBytes',lines.length);return;}
  for(const line of lines)this.queue.push({line,bytes:Buffer.byteLength(line),critical,at:this.now()});this.queueBytes+=bytes;this.counters.queuePeak=Math.max(this.counters.queuePeak,this.queue.length);this.counters.bytePeak=Math.max(this.counters.bytePeak,this.queueBytes);this.start();
 }
 async span<T>(stage:DiagnosticStage,work:()=>Promise<T>):Promise<T>{const start=this.now();this.event({stage,phase:'start'});try{const result=await work();this.event({stage,phase:'end',outcome:'success',durationMs:this.now()-start});return result;}catch(error){this.event({stage,phase:'end',outcome:'failure',durationMs:this.now()-start,...diagnosticFailure(error)});throw error;}}
 private warn(reason:string){const last=this.warnings.get(reason)??-Infinity;if(this.now()-last<60000)return;this.warnings.set(reason,this.now());const warning={event:'diagnostic_loss',reason,instanceId:this.instanceId,pid:process.pid,processRole:'control-plane',loggerVersion:2,...this.stats};try{if(this.options.warn)this.options.warn(warning);else process.stderr.write(JSON.stringify(warning)+'\n');}catch{/* Logging cannot fail business work. */}}
 private start(){if(this.writing||this.scheduled)return;this.scheduled=true;setImmediate(()=>{this.scheduled=false;if(!this.writing){this.writing=this.drain().finally(()=>{this.writing=undefined;if(this.queue.length)this.start();});}});}
 private async drain(){
  try{while(this.queue.length){const batch=this.queue.splice(0,64);const bytes=batch.reduce((n,r)=>n+r.bytes,0);this.queueBytes-=bytes;this.inFlight=batch.length;this.inFlightAt=batch[0]?.at;await this.writer.append(batch.map(r=>r.line));this.counters.written+=batch.length;this.inFlight=0;this.inFlightAt=undefined;}}
  catch{this.counters.writeFailures++;this.drop('ioFailure',this.queue.length+this.inFlight);this.queue.length=0;this.queueBytes=0;this.inFlight=0;this.inFlightAt=undefined;await this.writer.reset().catch(()=>{});}
 }
 async flush(){this.flushAggregates();while(this.scheduled||this.writing||this.queue.length){if(this.writing)await this.writing;else await new Promise<void>(resolve=>setImmediate(resolve));}}
 async close(){return this.closing??=this.finishClose();}
 private async finishClose(){
  if(this.monitorTimer)clearInterval(this.monitorTimer);this.monitor?.disable();this.flushAggregates();this.aggregates.clear();if(this.monitor)this.event({stage:'diagnostic.health',phase:'point',state:'stopping',metrics:this.stats});this.stopped=true;
  let timer:ReturnType<typeof setTimeout>|undefined;const draining=(async()=>{await this.flush();if(this.monitor){this.encode({version:1,at:new Date(this.now()).toISOString(),instanceId:this.instanceId,pid:process.pid,processRole:'control-plane',loggerVersion:2,nodeVersion:process.version,bootAt:this.bootAt,stage:'diagnostic.health',phase:'point',state:'stopped',metrics:this.stats});await this.flush();}await this.writer.close().catch(()=>{this.counters.writeFailures++;this.warn('ioFailure');});})();const completed=await Promise.race([draining.then(()=>true),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),this.options.closeTimeoutMs??5000);})]);if(timer)clearTimeout(timer);
  if(!completed){this.counters.shutdownRemaining=this.queue.length+this.inFlight;this.counters.shutdownDropped+=this.queue.length;this.counters.dropped+=this.queue.length;this.queue.length=0;this.queueBytes=0;this.warn('shutdown_timeout');void draining.catch(()=>{});}
 }

}

/** HTTP metadata only: never serialize URL, headers, bodies, or a thrown transport message. */
export function diagnosticFetch(diagnostics:DiagnosticPort,transport:typeof fetch=fetch,model=false):typeof fetch {
 return async(input,init)=>{
  let stage:DiagnosticStage='channel.http';
  try{const path=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url).pathname;stage=model?'model.http':path.includes('/contact/')||path.includes('/department')||path.includes('/user/')?'directory.http':path.includes('/auth')||path.includes('gettoken')?'credential.http':path.includes('/im/')?'outbox.http':'channel.http';}catch{/* Only the fixed stage is retained. */}
  const metadata=directoryOperationMetadata(typeof input==='string'||input instanceof URL?input:input.url);
  const start=Date.now();diagnostics.event({stage,phase:'start',...metadata});
  try{const response=await transport(input,init);diagnostics.event({stage,phase:'end',durationMs:Date.now()-start,httpStatus:response.status,...metadata,...((response.headers.get('x-tt-logid')??response.headers.get('x-request-id'))?{requestId:(response.headers.get('x-tt-logid')??response.headers.get('x-request-id'))!}:{}),outcome:response.ok?'success':'failure',...(!response.ok?{category:httpFailureCategory(response.status)}:{})});return response;}
  catch(error){diagnostics.event({stage,phase:'end',outcome:'failure',durationMs:Date.now()-start,...metadata,category:init?.signal?.aborted?'timeout':'network'});throw error;}
 };
}
