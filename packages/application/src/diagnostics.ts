/** Message text and explicitly authorized Feishu message JSON share the bounded diagnostic sink. */
export const diagnosticStages = ['diagnostic.health','capability.filtered','ingress.received','feishu.message','ingress','inbox.queued','inbox.consume','authorization','directory.http','directory.sync','credential.http','channel.http','interaction.submit','interaction.poll','interaction.events','notification','runtime','model.http','reply.generated','reply.persist','outbox.queued','outbox.send','outbox.http'] as const;
export type DiagnosticStage = typeof diagnosticStages[number];
export const diagnosticCategories = ['authentication','configuration','permission','not_found','parameters','rate_limit','provider','network','timeout','parse','storage','conflict','canceled','unknown'] as const;
export type DiagnosticCategory = typeof diagnosticCategories[number];
export const diagnosticCodes = ['mock_authentication_failed','invalid_api_key','mock_model_not_found','model_not_found','mock_rule_not_matched','rate_limit_exceeded','unsupported_thinking','unsupported_reasoning_effort','invalid_completion_request','model_parameters_incompatible','model_response_invalid','model_credential_unavailable'] as const;
/** Response shape only: never provider text, arguments, tool names, or credentials. */
export const modelResponseIssues = ['empty_reply','payload_size','payload_json','choice_missing','finish_length','finish_reason','content_type','tool_calls_type','tool_call_shape','tool_name_canonical','tool_name_unknown','tool_not_available','tool_arguments_json','usage'] as const;
export interface DiagnosticContext {traceId:string;messageId:string;attemptId?:string;causationId?:string;conversationId?:string;taskId?:string;runId?:string;sessionId?:string;turnId?:string;providerEventRef?:string}
export const diagnosticOperations=['runtime.events.read','runtime.events.commit','model.connection.test','model.request.metadata','feishu.contact.scopes','feishu.contact.user','feishu.contact.department','feishu.contact.members','feishu.contact.children'] as const;
/** Fixed metadata only. Probe responses must never use the optional model body capture. */
export const modelProbeIssues=['passed','http_status','empty_body','body_limit','body_read','payload_json','protocol_shape','choice_missing','finish_reason','response_status_missing','response_status_invalid','transport','timeout','answer_json','answer_mismatch','unsupported_image'] as const;
export const modelProbeContentTypes=['json','html','event_stream','plain','other','missing'] as const;
export const modelProbeEndpoints=['/responses','/v1/responses','/chat/completions','/v1/chat/completions','/v1/messages','other'] as const;
export interface ModelProbeDiagnostic {
 id:string;modality:'text'|'image';protocol:'chat_completions'|'openai_responses'|'anthropic_messages';
 endpoint:typeof modelProbeEndpoints[number];contentType?:typeof modelProbeContentTypes[number];issue?:typeof modelProbeIssues[number];
}
/** Reconstruct rather than spread, including when a caller passes untyped provider data. */
export function safeModelProbeDiagnostic(value:unknown):ModelProbeDiagnostic|undefined {
 if(!value||typeof value!=='object'||Array.isArray(value))return;
 const v=value as Record<string,unknown>;
 if(typeof v['id']!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v['id'])||!['text','image'].includes(String(v['modality']))||!['chat_completions','openai_responses','anthropic_messages'].includes(String(v['protocol']))||!(modelProbeEndpoints as readonly unknown[]).includes(v['endpoint']))return;
 return{id:v['id'],modality:v['modality'] as ModelProbeDiagnostic['modality'],protocol:v['protocol'] as ModelProbeDiagnostic['protocol'],endpoint:v['endpoint'] as ModelProbeDiagnostic['endpoint'],...((modelProbeContentTypes as readonly unknown[]).includes(v['contentType'])?{contentType:v['contentType'] as NonNullable<ModelProbeDiagnostic['contentType']>}:{ }),...((modelProbeIssues as readonly unknown[]).includes(v['issue'])?{issue:v['issue'] as NonNullable<ModelProbeDiagnostic['issue']>}:{ })};
}
/** Counts from the final serialized request. Never accepts model names, URLs, content or headers. */
export interface ModelRequestDiagnostic {
 id:string;protocol:'chat_completions'|'openai_responses'|'anthropic_messages';imageInputEnabled:boolean;
 referencedImages:number;readImages:number;imageBlocks:number;imageBytes:number;requestBytes:number;
}
export function safeModelRequestDiagnostic(value:unknown):ModelRequestDiagnostic|undefined {
 if(!value||typeof value!=='object'||Array.isArray(value))return;
 const v=value as Record<string,unknown>;
 if(typeof v['id']!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v['id'])||!['chat_completions','openai_responses','anthropic_messages'].includes(String(v['protocol']))||typeof v['imageInputEnabled']!=='boolean')return;
 const counts=['referencedImages','readImages','imageBlocks','imageBytes','requestBytes'] as const;
 for(const key of counts)if(typeof v[key]!=='number'||!Number.isSafeInteger(v[key])||(v[key] as number)<0)return;
 return{id:v['id'],protocol:v['protocol'] as ModelRequestDiagnostic['protocol'],imageInputEnabled:v['imageInputEnabled'],referencedImages:v['referencedImages'] as number,readImages:v['readImages'] as number,imageBlocks:v['imageBlocks'] as number,imageBytes:v['imageBytes'] as number,requestBytes:v['requestBytes'] as number};
}
export const diagnosticEndpoints=['/open-apis/contact/v3/scopes','/open-apis/contact/v3/users/{userId}','/open-apis/contact/v3/departments/{departmentId}','/open-apis/contact/v3/users/find_by_department','/open-apis/contact/v3/departments/{departmentId}/children'] as const;
export interface DiagnosticFailure {modelResponseIssue?:typeof modelResponseIssues[number];operation?:typeof diagnosticOperations[number];endpoint?:typeof diagnosticEndpoints[number];userIdType?:'open_id'|'user_id'|'union_id';departmentIdType?:'open_department_id'|'department_id';rootDepartment?:boolean;requestId?:string;category:DiagnosticCategory;httpStatus?:number;providerCode?:number|typeof diagnosticCodes[number]}
export const diagnosticReasons=['identity_invalid','usage_denied','platform_failure','reply_target_unavailable','connection_changed','generation_failed','send_failed','delivery_unknown','queue_expired','queue_restarted','lease_lost','shutdown','not_mentioned','self_message','unsupported_message','duplicate'] as const;
export interface DiagnosticEvent {modelRequest?:ModelRequestDiagnostic;modelProbe?:ModelProbeDiagnostic;modelResponse?:import('./model-response-diagnostic.js').ModelResponseCapture;state?:string;metrics?:Readonly<Record<string,number>>;resourceId?:string;resourceKind?:'skill'|'mcp';packageId?:string;workspaceId?:string;entityId?:string;filterReason?:'resource_disabled'|'package_disabled'}
export interface DiagnosticEvent extends Partial<DiagnosticContext>,Partial<DiagnosticFailure> {stage:DiagnosticStage;phase:'start'|'end'|'point';outcome?:'success'|'failure'|'queued'|'duplicate'|'unknown';durationMs?:number;queueMs?:number;sourceAt?:number;receivedAt?:number;text?:string;status?:'received'|'generated'|'sent'|'accepted'|'blocked'|'failed'|'unknown'|'expired'|'ignored'|'duplicate';reason?:typeof diagnosticReasons[number]}
export interface DiagnosticEvent {
 /** Only Feishu receive / actual message send request and response may carry complete message JSON. */
 messageKind?:'receive'|'send_request'|'send_response';
 json?:unknown;
}
export interface DiagnosticPort {
 context():DiagnosticContext|undefined;
 run<T>(context:DiagnosticContext,work:()=>T):T;
 event(event:DiagnosticEvent):void;
 span<T>(stage:DiagnosticStage,work:()=>Promise<T>):Promise<T>;
}
export class DiagnosticError extends Error {
 constructor(readonly diagnostic:DiagnosticFailure){super(`Operation failed: ${diagnostic.category}${diagnostic.httpStatus?` (HTTP ${diagnostic.httpStatus})`:''}${diagnostic.providerCode?` [${diagnostic.providerCode}]`:''}`);this.name='DiagnosticError';}
}
export const httpFailureCategory=(status:number):DiagnosticCategory=>status===401?'authentication':status===403?'permission':status===404?'not_found':status===429?'rate_limit':[400,422].includes(status)?'parameters':'provider';
/** Deliberately excludes arbitrary error messages/codes. */
export function diagnosticFailure(error:unknown):DiagnosticFailure {
 try{
 if(error instanceof DiagnosticError)return error.diagnostic;
 if(error&&typeof error==='object'){
  const e=error as {name?:unknown;code?:unknown;details?:{httpStatus?:unknown;providerCode?:unknown;reason?:unknown;operation?:unknown;endpoint?:unknown;userIdType?:unknown;departmentIdType?:unknown;rootDepartment?:unknown;requestId?:unknown}};
  const d=e.details,code=typeof e.code==='string'?e.code:'',category:DiagnosticCategory=e.name==='AbortError'||d?.reason==='timeout'?'timeout':d?.reason==='network'?'network':d?.reason==='parse'||['invalid_response','provider_response_shape_invalid'].includes(code)?'parse':['authentication_failed','unauthenticated'].includes(code)?'authentication':['model_not_configured','model_selection_required','model_secret_store_unconfigured','model_credential_missing'].includes(code)?'configuration':['authorization_denied','forbidden','POLICY_DENIED','entity_use_forbidden','employee_disabled','channel_authorization_required','channel_use_forbidden'].includes(code)?'permission':['CONFLICT','conflict','model_configuration_changed','model_endpoint_changed'].includes(code)?'conflict':/^SQLITE_/.test(code)||['model_credential_unavailable','EACCES','EPERM','ENOENT','ENOSPC','EIO','EROFS','EMFILE'].includes(code)?'storage':'unknown';
  return{category,...(typeof d?.operation==='string'&&(diagnosticOperations as readonly string[]).includes(d.operation)?{operation:d.operation as NonNullable<DiagnosticFailure['operation']>}:{}),...(typeof d?.endpoint==='string'&&(diagnosticEndpoints as readonly string[]).includes(d.endpoint)?{endpoint:d.endpoint as NonNullable<DiagnosticFailure['endpoint']>}:{}),...(typeof d?.userIdType==='string'&&['open_id','user_id','union_id'].includes(d.userIdType)?{userIdType:d.userIdType as NonNullable<DiagnosticFailure['userIdType']>}:{}),...(typeof d?.departmentIdType==='string'&&['open_department_id','department_id'].includes(d.departmentIdType)?{departmentIdType:d.departmentIdType as NonNullable<DiagnosticFailure['departmentIdType']>}:{}),...(typeof d?.rootDepartment==='boolean'?{rootDepartment:d.rootDepartment}:{}),...(typeof d?.requestId==='string'&&/^[A-Za-z0-9_-]{8,100}$/.test(d.requestId)?{requestId:d.requestId}:{}),...(typeof d?.httpStatus==='number'&&Number.isInteger(d.httpStatus)&&d.httpStatus>=100&&d.httpStatus<=599?{httpStatus:d.httpStatus}:{}),...(typeof d?.providerCode==='number'&&Number.isSafeInteger(d.providerCode)?{providerCode:d.providerCode}:{})};
 }
 return{category:'unknown'};
 }catch{return{category:'unknown'};}
}
export const nullDiagnostics:DiagnosticPort={context:()=>undefined,run:(_context,work)=>work(),event:()=>{},span:(_stage,work)=>work()};
