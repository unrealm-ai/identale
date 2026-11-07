import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sanitizeModelDiagnostic} from '../../dist/model-diagnostics.js';

/** Test-only failure evidence: never copy the private journal, materials or session. */
export function preserveHumanBoundaryFailure(directory,destination,adapter){
 let journal;try{journal=JSON.parse(readFileSync(join(directory,'journal.json'),'utf8'));}catch{journal={executions:[]};}
 const runs=['r1','r2','r3'].map(executionId=>{
  const execution=journal.executions?.find(e=>e.request?.payload?.execution?.executionId===executionId);
  const monitored=adapter?.monitorExecution(executionId);
  const diagnostics=items=>(Array.isArray(items)?items:[]).map(d=>{const clean=sanitizeModelDiagnostic(d);if(clean)delete clean.providerRequestId;return clean;}).filter(Boolean);
  return{executionId,status:monitored?.status??execution?.status??'not_created',
   modelLifecycle:diagnostics(monitored?.modelLifecycle??execution?.modelLifecycle),
   modelDiagnostics:diagnostics(monitored?.modelDiagnostics??execution?.modelDiagnostics),
   events:(execution?.events??[]).map(e=>({sequence:e.sequence,eventType:e.eventType,occurredAt:e.occurredAt,
    ...(typeof e.payload?.status==='string'?{status:e.payload.status}:{}),
    ...(typeof e.payload?.safe==='boolean'?{humanSafe:e.payload.safe}:{}),
    ...(typeof e.payload?.error?.code==='string'?{errorCode:e.payload.error.code}:{})}))};
 });
 const report={version:1,at:new Date().toISOString(),scope:'Synthetic human-boundary test failure only; no prompts, outputs, credentials or private paths.',runs};
 mkdirSync(destination,{recursive:true,mode:0o700});
 const path=join(destination,`human-boundary-failure-${Date.now()}-${process.pid}.json`);writeFileSync(path,JSON.stringify(report,null,2)+'\n',{mode:0o600,flag:'wx'});return path;
}
