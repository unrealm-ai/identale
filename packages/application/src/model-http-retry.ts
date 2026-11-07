/** One HTTP retry boundary only. Never retries a parsed model/tool invocation or a consumed response stream. */
export interface ModelHttpAttempt {readonly attempt:number;readonly maxAttempts:1|3;readonly outcome:'response'|'transport_error'|'retry_wait';readonly httpStatus?:number;readonly delayMs?:number;readonly error?:unknown;readonly response?:Response;readonly willRetry?:boolean}
export const MODEL_HTTP_RETRY_DELAYS=[1000,3000] as const;
const transientStatus=new Set([408,429,500,502,503,504]);
const transientCodes=new Set(['ECONNRESET','ECONNREFUSED','ECONNABORTED','ENOTFOUND','ETIMEDOUT','EPIPE','EAI_AGAIN','UND_ERR_SOCKET','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_CONNECT_TIMEOUT','ERR_STREAM_PREMATURE_CLOSE']);
export function retryableModelTransport(error:unknown):boolean {const seen=new Set<unknown>();let current=error;for(let n=0;n<5&&current&&typeof current==='object'&&!seen.has(current);n++){seen.add(current);const e=current as{name?:unknown;code?:unknown;cause?:unknown};if(typeof e.code==='string')return transientCodes.has(e.code);if(e.name==='TimeoutError')return true;if(e.name==='AbortError')return false;if(e.cause){current=e.cause;continue;}return e.name==='TypeError';}return false;}
/** Provider Retry-After is intentionally ignored: product-owned bounded schedules. */
export function modelRetryDelay(attempt:number,_retryAfter:string|null,_now=Date.now()):number|undefined{return MODEL_HTTP_RETRY_DELAYS[attempt-1];}
export function waitModelRetry(ms:number,signal?:AbortSignal|null):Promise<void>{return new Promise((resolve,reject)=>{if(signal?.aborted){reject(signal.reason??new DOMException('Aborted','AbortError'));return;}const timer=setTimeout(done,ms);function cleanup(){clearTimeout(timer);signal?.removeEventListener('abort',abort);}function done(){cleanup();resolve();}function abort(){cleanup();reject(signal?.reason??new DOMException('Aborted','AbortError'));}signal?.addEventListener('abort',abort,{once:true});});}
export async function requestModelWithRetry(send:(attempt:number)=>Promise<Response>,options:{signal?:AbortSignal|null|undefined;maxAttempts?:1|3;beforeAttempt?:(attempt:number)=>Promise<void>;observe?:(event:ModelHttpAttempt)=>void|Promise<void>}={}):Promise<Response>{
 const observe=async(event:ModelHttpAttempt)=>{try{await options.observe?.(event);}catch{/* Metadata never authorizes a retry or changes a provider outcome. */}};
 const maxAttempts=options.maxAttempts??3;
 for(let attempt=1;attempt<=maxAttempts;attempt++){
  options.signal?.throwIfAborted();await options.beforeAttempt?.(attempt);let response:Response;
  try{response=await send(attempt);}catch(error){await observe({attempt,maxAttempts,outcome:'transport_error',error});if(options.signal?.aborted||!retryableModelTransport(error)||attempt===maxAttempts)throw error;const delay=MODEL_HTTP_RETRY_DELAYS[attempt-1]!;await observe({attempt,maxAttempts,outcome:'retry_wait',delayMs:delay});await waitModelRetry(delay,options.signal);continue;}
  const delay=attempt<maxAttempts&&transientStatus.has(response.status)?modelRetryDelay(attempt,response.headers.get('retry-after')):undefined;
  await observe({attempt,maxAttempts,outcome:'response',httpStatus:response.status,response,willRetry:delay!==undefined});
  if(delay===undefined)return response;
  try{await response.body?.cancel();}catch{/* Response was already rejected; no stream is exposed to the model caller. */}
  await observe({attempt,maxAttempts,outcome:'retry_wait',httpStatus:response.status,delayMs:delay});await waitModelRetry(delay,options.signal);
 }
 throw new Error('Model HTTP retry budget exhausted');
}
/** Bounded diagnostic copy. Never awaits cancellation of a tee branch before its owner can cancel the original. */
export async function readModelFailureBody(response:Response,signal?:AbortSignal|null):Promise<{raw:string;complete:boolean}>{
 const reader=response.clone().body?.getReader();if(!reader)return{raw:'',complete:true};const chunks:Uint8Array[]=[];let size=0,complete=false,interrupted=false;
 const stop=()=>{interrupted=true;void reader.cancel().catch(()=>{});},timer=setTimeout(stop,2000);timer.unref();signal?.addEventListener('abort',stop,{once:true});
 try{if(signal?.aborted)stop();while(!interrupted&&size<1048576){const part=await reader.read();if(part.done){complete=!interrupted;break;}chunks.push(part.value.subarray(0,1048576-size));size+=part.value.byteLength;if(size>=1048576)stop();}}catch{complete=false;}finally{clearTimeout(timer);signal?.removeEventListener('abort',stop);reader.releaseLock();}return{raw:Buffer.concat(chunks).toString('utf8'),complete};
}
