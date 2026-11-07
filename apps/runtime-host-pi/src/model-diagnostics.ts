/** Bounded operational facts only. Never retain raw errors, stacks, URLs, headers or payloads. */
const names = ['Error','TypeError','AbortError','TimeoutError','AggregateError','APIError'] as const;
const codes = ['UND_ERR_SOCKET','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_CONNECT_TIMEOUT','ECONNRESET','ECONNREFUSED','ECONNABORTED','ENOTFOUND','ETIMEDOUT','EPIPE','EAI_AGAIN','ABORT_ERR','ERR_STREAM_PREMATURE_CLOSE','ERR_HTTP2_STREAM_ERROR'] as const;
const kinds = ['terminated','aborted','timeout','response_limit','other'] as const;
const events=['request_start','response_headers','first_chunk','first_output','stream_end','stream_cancel','worker_exit','cancel_requested','retry_wait']as const;
const abortSources=['host_cancel','host_timeout','sdk_signal','timeout_signal','stream_reader_cancel']as const;
export interface ModelFailureDiagnostic {
 attempt?:number;retryDelayMs?:number;event?:typeof events[number];abortSource?:typeof abortSources[number];exitCode?:number|null;exitSignal?:'SIGTERM'|'SIGKILL'|'SIGINT'|'SIGABRT'|'SIGSEGV'|'SIGHUP'|null;
 version:1;phase:'request'|'response'|'body';at:string;startedAt:string;elapsedMs:number;
 httpStatus?:number;providerRequestId?:string;lastChunkAt?:string;receivedBytes:number;
 abortObserved:boolean;timeoutObserved:boolean;
 causes:{name:typeof names[number]|'UnknownError';code?:typeof codes[number];kind:typeof kinds[number]}[];
}
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object';
const iso=(v:unknown)=>typeof v==='string'&&v.length<=32&&Number.isFinite(Date.parse(v))?new Date(v).toISOString():undefined;
/** Reconstruct the allowlist at both sides of worker IPC; unknown properties never pass through. */
export function sanitizeModelDiagnostic(value:unknown,secrets:readonly string[]=[]):ModelFailureDiagnostic|undefined{
 if(!record(value)||value.version!==1||!['request','response','body'].includes(String(value.phase))||!iso(value.at)||!iso(value.startedAt)||typeof value.abortObserved!=='boolean'||typeof value.timeoutObserved!=='boolean'||!Number.isSafeInteger(value.elapsedMs)||Number(value.elapsedMs)<0||Number(value.elapsedMs)>3600000||!Number.isSafeInteger(value.receivedBytes)||Number(value.receivedBytes)<0||Number(value.receivedBytes)>2147483647||!Array.isArray(value.causes)||value.causes.length>4)return;
 const causes:ModelFailureDiagnostic['causes']=[];
 for(const item of value.causes){if(!record(item)||![...names,'UnknownError'].includes(String(item.name))||!kinds.includes(item.kind as typeof kinds[number])||item.code!==undefined&&!codes.includes(item.code as typeof codes[number]))return;causes.push({name:item.name as ModelFailureDiagnostic['causes'][number]['name'],kind:item.kind as typeof kinds[number],...(item.code?{code:item.code as typeof codes[number]}:{})});}
 const id=value.providerRequestId,requestId=typeof id==='string'&&/^[A-Za-z0-9_.:-]{8,128}$/.test(id)&&!secrets.filter(Boolean).some(s=>id.includes(s)||s.includes(id)||id.includes(encodeURIComponent(s)))?id:undefined;
 if(value.event!==undefined&&!events.includes(value.event as typeof events[number])||value.abortSource!==undefined&&!abortSources.includes(value.abortSource as typeof abortSources[number]))return;
 return{...(Number.isInteger(value.attempt)&&Number(value.attempt)>=1&&Number(value.attempt)<=3?{attempt:Number(value.attempt)}:{}),...(Number.isInteger(value.retryDelayMs)&&Number(value.retryDelayMs)>=0&&Number(value.retryDelayMs)<=2147483647?{retryDelayMs:Number(value.retryDelayMs)}:{}),...(value.event?{event:value.event as typeof events[number]}:{}),...(value.abortSource?{abortSource:value.abortSource as typeof abortSources[number]}:{}),...(value.exitCode===null||Number.isInteger(value.exitCode)&&Number(value.exitCode)>=-1&&Number(value.exitCode)<=255?{exitCode:value.exitCode as number|null}:{}),...(value.exitSignal===null||['SIGTERM','SIGKILL','SIGINT','SIGABRT','SIGSEGV','SIGHUP'].includes(String(value.exitSignal))?{exitSignal:value.exitSignal as Exclude<ModelFailureDiagnostic['exitSignal'],undefined>}:{}),version:1,phase:value.phase as ModelFailureDiagnostic['phase'],at:iso(value.at)!,startedAt:iso(value.startedAt)!,elapsedMs:Number(value.elapsedMs),receivedBytes:Number(value.receivedBytes),abortObserved:value.abortObserved,timeoutObserved:value.timeoutObserved,causes,...(Number.isInteger(value.httpStatus)&&Number(value.httpStatus)>=100&&Number(value.httpStatus)<=599?{httpStatus:Number(value.httpStatus)}:{}),...(requestId?{providerRequestId:requestId}:{}),...(iso(value.lastChunkAt)?{lastChunkAt:iso(value.lastChunkAt)!}:{})};
}
export function modelFailureDiagnostic(error:unknown,facts:Omit<ModelFailureDiagnostic,'version'|'at'|'elapsedMs'|'causes'|'timeoutObserved'>,secrets:readonly string[]=[]):ModelFailureDiagnostic{
 const causes:ModelFailureDiagnostic['causes']=[],seen=new Set<unknown>(),pending=[error];
 while(pending.length&&causes.length<4){const e=pending.shift();if(!record(e)||seen.has(e))continue;seen.add(e);const name=names.includes(e.name as typeof names[number])?e.name as typeof names[number]:'UnknownError',code=codes.includes(e.code as typeof codes[number])?e.code as typeof codes[number]:undefined,message=typeof e.message==='string'?e.message:'';
  const kind=code?.includes('TIMEOUT')||code==='ETIMEDOUT'||name==='TimeoutError'?'timeout':name==='AbortError'||code==='ABORT_ERR'?'aborted':message==='terminated'?'terminated':message==='Model response limit exceeded'?'response_limit':'other';causes.push({name,kind,...(code?{code}:{})});if(e.cause)pending.push(e.cause);if(Array.isArray(e.errors))pending.push(...e.errors.slice(0,4));
 }
 const at=new Date().toISOString();return sanitizeModelDiagnostic({...facts,version:1,at,elapsedMs:Math.min(3600000,Math.max(0,Date.parse(at)-Date.parse(facts.startedAt))),causes,timeoutObserved:causes.some(e=>e.kind==='timeout')},secrets)!;
}

export function modelLifecycleDiagnostic(event:NonNullable<ModelFailureDiagnostic['event']>,facts:Partial<ModelFailureDiagnostic>&{startedAt:string},secrets:readonly string[]=[]):ModelFailureDiagnostic{const at=new Date().toISOString();return sanitizeModelDiagnostic({version:1,phase:'body',at,elapsedMs:Math.min(3600000,Math.max(0,Date.parse(at)-Date.parse(facts.startedAt))),receivedBytes:0,abortObserved:false,timeoutObserved:false,causes:[],...facts,event},secrets)!;}
