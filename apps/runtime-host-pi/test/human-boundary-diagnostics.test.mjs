import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {preserveHumanBoundaryFailure} from './helpers/human-boundary-diagnostics.mjs';

test('human boundary failure evidence retains status and worker/stream facts without private journal content',async t=>{
 const root=await mkdtemp(join(tmpdir(),'human-diagnostic-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const at='2026-11-01T15:00:00.000Z',diagnostic={version:1,at,startedAt:at,phase:'body',elapsedMs:1,receivedBytes:4,abortObserved:false,timeoutObserved:false,causes:[{name:'TypeError',code:'UND_ERR_SOCKET',kind:'terminated'}],event:'worker_exit',exitCode:1,providerRequestId:'private-request-id',raw:'DO_NOT_RETAIN'};
 await writeFile(join(root,'journal.json'),JSON.stringify({prepared:[{apiKey:'DO_NOT_RETAIN'}],sessions:[{path:'DO_NOT_RETAIN'}],executions:[{request:{payload:{execution:{executionId:'r3'},input:'DO_NOT_RETAIN'}},status:'unknown',modelDiagnostics:[diagnostic],modelLifecycle:[diagnostic],events:[{eventType:'status_changed',sequence:7,occurredAt:at,payload:{status:'unknown',error:{code:'RUNTIME_UNAVAILABLE',safeMessage:'DO_NOT_RETAIN'},text:'DO_NOT_RETAIN'}}]}]}));
 const path=preserveHumanBoundaryFailure(root,join(root,'reports')),text=await readFile(path,'utf8'),report=JSON.parse(text);
 assert.equal(text.includes('DO_NOT_RETAIN'),false);assert.equal(text.includes('private-request-id'),false);assert.equal(text.includes(root),false);
 assert.equal(report.runs[0].status,'not_created');assert.equal(report.runs[2].status,'unknown');assert.equal(report.runs[2].modelLifecycle[0].exitCode,1);assert.equal(report.runs[2].modelDiagnostics[0].causes[0].code,'UND_ERR_SOCKET');assert.equal(report.runs[2].events[0].errorCode,'RUNTIME_UNAVAILABLE');
});
