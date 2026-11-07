import {randomUUID} from 'node:crypto';
import {httpFailureCategory,modelProbeEndpoints,type DiagnosticPort,type DiagnosticCategory,type ModelProbeDiagnostic} from '@dentity/application';
import type {ModelProtocol} from '@dentity/contracts';

/** Never receives a key, request body, response body, arbitrary error text or headers. */
export class ModelProbeDiagnostics {
 private readonly metadata:ModelProbeDiagnostic;
 private readonly started=Date.now();
 private status:number|undefined;
 private finished=false;
 private issue:NonNullable<ModelProbeDiagnostic['issue']>='transport';
 constructor(private readonly diagnostics:DiagnosticPort,modality:'text'|'image',protocol:ModelProtocol,url:string,id:string=randomUUID()) {
  let path='';try{path=new URL(url).pathname;}catch{/* Invalid destinations retain the original transport failure behavior. */}
  this.metadata={id,modality,protocol,endpoint:(modelProbeEndpoints as readonly string[]).includes(path)?path as ModelProbeDiagnostic['endpoint']:'other'};
  this.emit('start');
 }
 response(status:number,contentType:string|null) {
  this.status=status;
  const mime=contentType?.split(';')[0]?.trim().toLowerCase();
  this.metadata.contentType=!mime?'missing':mime==='application/json'||/^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(mime)?'json':mime==='text/html'?'html':mime==='text/event-stream'?'event_stream':mime==='text/plain'?'plain':'other';
 }
 mark(issue:NonNullable<ModelProbeDiagnostic['issue']>){if(!this.finished)this.issue=issue;}
 finish(){if(this.finished)return;this.finished=true;this.emit('end');}
 private emit(phase:'start'|'end') {
  const category:DiagnosticCategory|undefined=this.status!==undefined&&(this.status<200||this.status>=300)?httpFailureCategory(this.status):this.issue==='timeout'?'timeout':this.issue==='transport'?'network':this.issue==='passed'?undefined:'parse';
  try{this.diagnostics.event({stage:'model.http',operation:'model.connection.test',phase,modelProbe:{...this.metadata,...(phase==='end'?{issue:this.issue}:{})},...(phase==='end'?{outcome:this.issue==='passed'?'success':'failure',durationMs:Date.now()-this.started,...(category?{category}:{})}:{}),...(this.status!==undefined?{httpStatus:this.status}:{})});}catch{/* Observability cannot change the test receipt or failure. */}
 }
}

export function responseShapeIssue(protocol:ModelProtocol,body:unknown):NonNullable<ModelProbeDiagnostic['issue']> {
 if(!body||typeof body!=='object'||Array.isArray(body))return'protocol_shape';
 if(protocol==='openai_responses'){
  const status=(body as Record<string,unknown>)['status'];
  if(status===undefined)return'response_status_missing';
  if(!['completed','incomplete'].includes(String(status)))return'response_status_invalid';
 }
 return'finish_reason';
}
