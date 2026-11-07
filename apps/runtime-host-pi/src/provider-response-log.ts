import {captureModelResponse} from '@dentity/application';
import {constants,openSync,closeSync,fstatSync,writeFileSync,fsyncSync,existsSync,lstatSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import type {DriverInvocation} from './types.js';
/** Exceptional responses only, outside SDK history/monitor APIs; safe header/structure capture excludes raw request text and credentials. */
export function logProviderResponse(input:DriverInvocation,raw:string,meta:{httpStatus?:number;requestId?:string;readComplete:boolean;attempt?:number;reason?:string;request?:{url:string;method:string;headers?:HeadersInit|undefined;body?:unknown};responseHeaders?:HeadersInit|undefined;error?:unknown}):void {
 if(!input.captureInvalidModelResponses)return;
 const dir=lstatSync(input.sessionDirectory);if(!dir.isDirectory()||dir.isSymbolicLink()||(dir.mode&0o077)!==0||dir.uid!==process.getuid?.())throw Error('Unsafe diagnostic directory');
 const path=join(input.sessionDirectory,'model-failure-response.jsonl'),previous=path+'.previous';
 const safe=(p:string)=>{if(existsSync(p)){const s=lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077)!==0||s.uid!==process.getuid?.())throw Error('Unsafe diagnostic file');}};safe(path);safe(previous);
 const response=captureModelResponse(raw,{model:input.profile.modelId,secrets:[input.profile.apiKey],sourceReadComplete:meta.readComplete,...(meta.requestId?{requestId:meta.requestId}:{}),stack:new Error('Execution model boundary failure').stack,http:{attempt:meta.attempt??1,maxAttempts:3,reason:meta.reason??'http_rejected',...(meta.request?{request:meta.request}:{}),...(meta.httpStatus?{response:{status:meta.httpStatus,headers:meta.responseHeaders}}:{}),...(meta.error?{error:meta.error}:{})}});
 const line=JSON.stringify({version:1,at:new Date().toISOString(),taskId:input.context.target?.kind==='task_run'?input.context.target.taskId:undefined,runId:input.context.authorizationRef,sessionId:input.context.sessionId,httpStatus:meta.httpStatus,response})+'\n';
 if(existsSync(path)&&lstatSync(path).size+Buffer.byteLength(line)>1024*1024)renameSync(path,previous);
 const fd=openSync(path,constants.O_CREAT|constants.O_APPEND|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);try{const s=fstatSync(fd);if(!s.isFile()||(s.mode&0o077)!==0||s.uid!==process.getuid?.())throw Error('Unsafe diagnostic file');writeFileSync(fd,line);fsyncSync(fd);}finally{closeSync(fd);}
}
