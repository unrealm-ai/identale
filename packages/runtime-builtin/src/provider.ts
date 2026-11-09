import {randomUUID} from 'node:crypto';
import {modelRequestDiagnostic} from './model-request-diagnostics.js';
import{MODEL_PROTOCOLS,type ModelProtocol}from'@dentity/contracts';
import{modelProtocolEndpoint,modelProtocolHeaders,modelProtocolRequest,modelProtocolResponse}from'./model-protocol.js';
import {validateModelToolNames} from './tool-names.js';
import type { ModelClientPort, ModelMessage,ModelImageRef } from './types.js';
import {retryableModelTransport,waitModelRetry,requestModelWithRetry,readModelFailureBody,captureModelResponse,DiagnosticError,diagnosticCodes,diagnosticFailure,httpFailureCategory,nullDiagnostics,type DiagnosticPort,type modelResponseIssues} from '@dentity/application';
/** Retained only for decoding legacy connection rows; never a user-selectable policy. */
export const interactionThinkingControls = ['unconfigured', 'openai_reasoning_effort_none', 'qwen_enable_thinking_false', 'not_applicable'] as const;
export type InteractionThinkingControl = typeof interactionThinkingControls[number];
export interface ModelConfig {
  readonly protocol?:ModelProtocol;
  readonly endpoint: string; readonly model: string; readonly secretRef: string;
  readonly thinkingLevel?: 'none';
  /** Explicit deployment/debug opt-in. Exceptional response bodies stay in the private diagnostic sink. */
  readonly captureInvalidResponses?:boolean;
  readonly imageInput?:boolean;
  /** Trusted scope-bound asset reader. References are revalidated, never arbitrary paths/URLs. */
  readonly readImage?:(ref:ModelImageRef,signal:AbortSignal)=>Promise<{data:string;mediaType:string}>;
  /** Deployment policy only. HTTP requires this flag and a literal loopback host. */
  readonly allowLoopbackHttp?: boolean;
}
export const BUILTIN_THINKING_POLICY_VERSION = 'builtin-dual-none-v1';
/** Default builtin wire policy. Rejection is explicit; never drop flags and retry. */
export function interactionThinkingParameters(config: Pick<ModelConfig, 'thinkingLevel'> = {}): Readonly<Record<string, unknown>> {
  if (config.thinkingLevel !== undefined && config.thinkingLevel !== 'none') throw new Error('unsupported_thinking_level');
  return { reasoning_effort: 'none', enable_thinking: false };
}
/** Resolver must verify exact endpoint binding before returning credentials. Never inherit environment keys. */
export type ModelSecretResolver = (secretRef: string, approvedEndpoint: string) => Promise<string>;
/** Endpoint is the configured API base URL (e.g. https://api.openai.com/v1).
 * OpenAI Chat Completions-compatible wire adapter. Does not imply every provider/model supports tools. */
export class OpenAICompatibleModelClient implements ModelClientPort {
  private readonly endpoint: string;
  private readonly thinkingParameters: Readonly<Record<string, unknown>>;
  constructor(private readonly config: ModelConfig, private readonly resolveSecret: ModelSecretResolver, private readonly transport: typeof fetch = fetch,private readonly diagnostics:DiagnosticPort=nullDiagnostics) {
    if(config.protocol!==undefined&&!(MODEL_PROTOCOLS as readonly unknown[]).includes(config.protocol))throw Error('Unsupported model protocol');
    const endpoint=new URL(config.endpoint);
    const local=['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname);
    const httpAllowed=endpoint.protocol==='http:'&&local&&config.allowLoopbackHttp===true;
    if((endpoint.protocol!=='https:'&&!httpAllowed) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !config.model.trim() || !config.secretRef.trim()) throw new Error('HTTPS or explicitly enabled loopback HTTP model endpoint and secret reference required');
    // Match the saved/probed API base before the resolver checks its exact binding.
    // URL.href adds '/' to a bare origin; this must not look like a new destination.
    this.endpoint=endpoint.href.replace(/\/+$/,'');
    this.thinkingParameters=interactionThinkingParameters(config);
  }
  async complete(input: Parameters<ModelClientPort['complete']>[0],control?:Parameters<ModelClientPort['complete']>[1]): ReturnType<ModelClientPort['complete']> {
    const delays=input.retryPurpose==='summary'?[3000,10000]:[1000,3000];
    for(let attempt=1;attempt<=3;attempt++){
      input.signal.throwIfAborted();await control?.beforeAttempt?.();input.signal.throwIfAborted();
      try{return await this.diagnostics.span('model.http',async()=>{let httpStatus:number|undefined;try{return await this.request(input,status=>{httpStatus=status;},attempt);}catch(error){if(error instanceof DiagnosticError)throw httpStatus&&error.diagnostic.httpStatus===undefined?new DiagnosticError({...error.diagnostic,httpStatus}):error;throw new DiagnosticError({category:input.signal.aborted?'timeout':error instanceof SyntaxError?'parse':'unknown',...(httpStatus?{httpStatus}:{})});}});}
      catch(error){input.signal.throwIfAborted();const d=diagnosticFailure(error),nonretry=d.providerCode==='model_credential_unavailable'||d.providerCode==='model_parameters_incompatible'||['authentication','permission','parameters','configuration','canceled'].includes(d.category)||d.httpStatus!==undefined&&d.httpStatus>=400&&d.httpStatus<500&&![408,429].includes(d.httpStatus)||d.modelResponseIssue==='finish_length'||d.modelResponseIssue==='payload_size';if(nonretry||attempt===3)throw error;this.diagnostics.event({stage:'model.http',phase:'point',outcome:'failure',...d,metrics:{attempt,maxAttempts:3,retryDelayMs:delays[attempt-1]!}});await waitModelRetry(delays[attempt-1]!,input.signal);}
    }
    throw new Error('Model local attempt budget exhausted');
  }

  private async request(input: Parameters<ModelClientPort['complete']>[0],observed:(status:number)=>void,localAttempt:number): ReturnType<ModelClientPort['complete']> {
    let secret:string;try{secret=await this.resolveSecret(this.config.secretRef,this.endpoint);}catch(error){const detail=diagnosticFailure(error);throw new DiagnosticError({...detail,providerCode:'model_credential_unavailable'});}if(!secret)throw new DiagnosticError({category:'configuration',providerCode:'model_credential_unavailable'});
    // One validated tool name is used for declaration, history, response and dispatch.
    const declarations=input.protocolTools??input.tools;
    try{validateModelToolNames(declarations,input.messages);}catch{throw new DiagnosticError({category:'configuration',providerCode:'model_parameters_incompatible'});}
    let readImages=0,imageBytes=0;
    const message=async(m:ModelMessage):Promise<unknown>=>{
      if(m.role==='tool')return{role:'tool',tool_call_id:m.toolCallId,content:m.content};
      if(m.role==='assistant')return{role:'assistant',content:m.content,...(m.toolCalls?{tool_calls:m.toolCalls.map(c=>({id:c.id,type:'function',function:{name:c.name,arguments:JSON.stringify(c.arguments)}}))}:{})};
      if(m.role!=='user'||!m.images?.length||!this.config.imageInput)return{role:m.role,content:m.content};
      if(!this.config.readImage)throw Error('Authorized image reader missing');
      const images=[];for(const ref of m.images){if(input.signal.aborted)throw Error('Image request canceled');const value=await this.config.readImage(ref,input.signal);if(!['image/png','image/jpeg','image/webp','image/gif'].includes(value.mediaType))throw Error('Image format unsupported by model transport');readImages++;imageBytes+=Buffer.byteLength(value.data,'base64');images.push({type:'image_url',image_url:{url:`data:${value.mediaType};base64,${value.data}`}});}
      return{role:'user',content:[{type:'text',text:m.content},...images]};
    };
    const wireMessages=await Promise.all(input.messages.map(message));

    const url=modelProtocolEndpoint(this.endpoint,this.config.protocol),wireRequest=modelProtocolRequest({...this.thinkingParameters,model:this.config.model,messages:wireMessages,max_completion_tokens:input.maxOutputTokens,stream:false,...(declarations.length?{tools:declarations.map(tool=>({type:'function',function:{name:tool.name,description:`${tool.name}: ${tool.description}`,parameters:tool.parameters}})),parallel_tool_calls:false,...(input.protocolTools?{tool_choice:'none'}:{})}:{})},this.config.protocol),requestInit={method:'POST',headers:modelProtocolHeaders(secret,this.config.protocol),redirect:'error' as const,signal:input.signal,body:JSON.stringify(wireRequest)};
    // Observability must not change transport, model input, retries or business results.
    try{this.diagnostics.event({stage:'model.http',phase:'point',operation:'model.request.metadata',modelRequest:modelRequestDiagnostic({id:randomUUID(),protocol:this.config.protocol??'chat_completions',imageInputEnabled:this.config.imageInput===true,referencedImages:input.messages.reduce((count,m)=>count+(m.role==='user'?(m.images?.length??0):0),0),readImages,imageBytes,requestBytes:Buffer.byteLength(requestInit.body)},wireRequest)});}catch{}
    let currentAttempt=localAttempt;let response:Response;
    const captured=(raw:string,reason:string,readComplete:boolean,httpResponse?:Response,error?:unknown)=>captureModelResponse(raw,{model:this.config.model,secrets:[secret],sourceReadComplete:readComplete,stack:new Error('Model boundary failure').stack,http:{attempt:currentAttempt,maxAttempts:3,reason,request:{url,method:'POST',headers:requestInit.headers,body:this.config.imageInput?'[multimodal request omitted]':requestInit.body},...(httpResponse?{response:{status:httpResponse.status,headers:httpResponse.headers}}:{}),...(error?{error}:{})}});
    try{response=await requestModelWithRetry(attempt=>{void attempt;return this.transport(url,requestInit).then(async original=>{observed(original.status);if(!original.ok||!original.body)return original;const reader=original.body.getReader(),parts:Uint8Array[]=[];let size=0;try{while(true){const part=await reader.read();if(part.done)break;parts.push(part.value.subarray(0,Math.max(0,1000001-size)));size+=part.value.byteLength;if(size>1000000){void reader.cancel().catch(()=>{});const raw=Buffer.concat(parts).toString('utf8');if(this.config.captureInvalidResponses)this.diagnostics.event({stage:'model.http',phase:'point',outcome:'failure',httpStatus:original.status,modelResponseIssue:'payload_size',modelResponse:captured(raw,'payload_size',false,original)});throw new DiagnosticError({category:'parse',providerCode:'model_response_invalid',modelResponseIssue:'payload_size'});}}}catch(error){if(!(error instanceof DiagnosticError)&&this.config.captureInvalidResponses)this.diagnostics.event({stage:'model.http',phase:'point',outcome:'failure',httpStatus:original.status,modelResponse:captured(Buffer.concat(parts).toString('utf8'),'response_body_read_failed',false,original,error)});throw error;}finally{reader.releaseLock();}return new Response(Buffer.concat(parts),{status:original.status,headers:original.headers});});},{signal:input.signal,maxAttempts:1,observe:async event=>{this.diagnostics.event({stage:'model.http',phase:'point',...(event.httpStatus?{httpStatus:event.httpStatus}:{}),metrics:{attempt:localAttempt,maxAttempts:3,...(event.delayMs?{retryDelayMs:event.delayMs}:{})}});if(this.config.captureInvalidResponses){if(event.outcome==='transport_error')this.diagnostics.event({stage:'model.http',phase:'point',outcome:'failure',modelResponse:captured('','transport_error',false,undefined,event.error)});if(event.response&&!event.response.ok&&event.willRetry){const body=await readModelFailureBody(event.response,input.signal);this.diagnostics.event({stage:'model.http',phase:'point',outcome:'failure',httpStatus:event.response.status,modelResponse:captured(body.raw,'http_retry',body.complete,event.response)});}}}});}catch(error){if(error instanceof DiagnosticError)throw error;throw new DiagnosticError({category:input.signal.aborted?'timeout':retryableModelTransport(error)?'network':'configuration'});}
    observed(response.status);this.diagnostics.event({stage:'model.http',phase:'point',httpStatus:response.status});
    if(!response.ok){
      let providerCode:typeof diagnosticCodes[number]|undefined;
      const failedBody=await readModelFailureBody(response,input.signal),errorRaw=failedBody.raw,readComplete=failedBody.complete;try{await response.body?.cancel();}catch{}try{const code=JSON.parse(errorRaw)?.error?.code;if(typeof code==='string'&&(diagnosticCodes as readonly string[]).includes(code))providerCode=code as typeof diagnosticCodes[number];}catch{}
      if(!providerCode&&[400,422].includes(response.status))providerCode='model_parameters_incompatible';
      const error=new DiagnosticError({category:httpFailureCategory(response.status),httpStatus:response.status,...(providerCode?{providerCode}:{})});
      if(this.config.captureInvalidResponses)this.diagnostics.event({stage:'model.http',phase:'point',outcome:'failure',httpStatus:response.status,modelResponse:captured(errorRaw,'http_rejected',readComplete,response)});
      throw error;
    }
    let raw='',finishReason:unknown;
    const invalid=(issue:typeof modelResponseIssues[number])=>{const error=new DiagnosticError({category:'parse',providerCode:'model_response_invalid',modelResponseIssue:issue});if(this.config.captureInvalidResponses)this.diagnostics.event({stage:'model.http',phase:'point',outcome:'failure',httpStatus:response.status,modelResponseIssue:issue,modelResponse:captureModelResponse(raw,{model:this.config.model,secrets:[secret],finishReason,requestId:response.headers.get('x-request-id')??response.headers.get('request-id')??undefined,stack:error.stack,http:{attempt:currentAttempt,maxAttempts:3,reason:issue,request:{url,method:'POST',headers:requestInit.headers,body:this.config.imageInput?'[multimodal request omitted]':requestInit.body},response:{status:response.status,headers:response.headers}}})});return error;};
    try{raw=await response.text();}catch(error){throw new DiagnosticError({category:input.signal.aborted?'timeout':retryableModelTransport(error)?'network':'configuration'});}if(Buffer.byteLength(raw)>1_000_000)throw invalid('payload_size');
    const scrub=(value:unknown):unknown=>typeof value==='string'?value.split(secret).join('[REDACTED]'):Array.isArray(value)?value.map(scrub):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,child])=>[key,scrub(child)])):value;
    let parsed:unknown;try{parsed=JSON.parse(raw);}catch{throw invalid('payload_json');}
    const data=scrub(modelProtocolResponse(parsed,this.config.protocol)) as {choices?:{finish_reason?:string;message?:{content?:unknown;tool_calls?:{id?:unknown;type?:unknown;function?:{name?:unknown;arguments?:unknown}}[]}}[];usage?:{prompt_tokens?:unknown;completion_tokens?:unknown}};
    const choice=data?.choices?.[0],m=choice?.message;finishReason=choice?.finish_reason;if(!m)throw invalid('choice_missing');
    if(!['stop','tool_calls'].includes(choice?.finish_reason??''))throw invalid(choice?.finish_reason==='length'?'finish_length':'finish_reason');
    if(m.content!==null&&m.content!==undefined&&typeof m.content!=='string')throw invalid('content_type');
    if(m.tool_calls!==undefined&&!Array.isArray(m.tool_calls))throw invalid('tool_calls_type');
    const toolCalls=(m.tool_calls??[]).map(call=>{if(!call||typeof call.id!=='string'||call.type!=='function'||typeof call.function?.name!=='string'||typeof call.function.arguments!=='string')throw invalid('tool_call_shape');
      const name=call.function.name;
      if(!declarations.some(t=>t.name===name))throw invalid('tool_name_unknown');
      if(!declarations.some(t=>t.name===name)||!input.tools.some(t=>t.name===name))throw invalid('tool_not_available');let args:unknown;try{args=JSON.parse(call.function.arguments);}catch{throw invalid('tool_arguments_json');}return{id:call.id,name,arguments:args};});
    if(!toolCalls.length&&!(typeof m.content==='string'&&m.content.trim()))throw invalid('empty_reply');
    const inputTokens=data.usage?.prompt_tokens,outputTokens=data.usage?.completion_tokens;
    if(typeof inputTokens!=='number'||typeof outputTokens!=='number')throw invalid('usage');
    return{finishReason:choice!.finish_reason!,text:typeof m.content==='string'?m.content:'',toolCalls,usage:{inputTokens,outputTokens}};
  }
}
