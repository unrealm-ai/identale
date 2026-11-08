import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {DirectoryProvider} from '@dentity/application';
import {EmployeeChannelService,EmployeeChannelError} from './service.js';
export async function registerEmployeeChannelRoutes(app:FastifyInstance,service:EmployeeChannelService,auth:{requireReader?:(request:FastifyRequest,workspaceId:string,entityId:string)=>void|{canManage:boolean}|Promise<void|{canManage:boolean}>;requireManager:(request:FastifyRequest,workspaceId:string,entityId:string)=>string|Promise<string>}){
 const base='/api/workspaces/:workspaceId/entities/:entityId/channels';
 function route(method:'GET'|'PUT'|'POST'|'DELETE',path:string,keys:string[],fn:(w:string,e:string,p:DirectoryProvider,a:string,r:FastifyRequest,canManage:boolean)=>unknown){app.route({method,url:base+path,handler:async(request,reply)=>{const p=request.params as {workspaceId:string;entityId:string;provider?:string};let actor='',canManage=false;if(method==='GET'&&path===''&&auth.requireReader){const access=await auth.requireReader(request,p.workspaceId,p.entityId);canManage=access?.canManage===true;}else{actor=await auth.requireManager(request,p.workspaceId,p.entityId);canManage=true;}if(p.provider&&!['feishu','dingtalk','wecom'].includes(p.provider))return reply.code(400).send({error:'invalid_channel_provider'});const b=request.body??{};if(method!=='GET'&&(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!keys.includes(k))))return reply.code(400).send({error:'invalid_channel_request'});try{return await fn(p.workspaceId,p.entityId,p.provider as DirectoryProvider,actor,request,canManage);}catch(error){if(error instanceof EmployeeChannelError)return reply.code(error.status).send({error:error.code,...(error.validation?{validation:error.validation}:{})});return reply.code(503).send({error:'channel_connection_unavailable'});}}});}
 route('GET','',[],(w,e,_p,_a,_r,canManage)=>service.list(w,e,canManage));
 route('GET','/subjects',[],(w,e)=>service.subjects(w,e));
 route('PUT','/:provider',['appId','appSecret','expectedRevision','replaceSource'],(w,e,p,a,r)=>service.save(w,e,p,a,r.body as any));
 route('POST','/:provider/revalidate',['expectedRevision'],(w,e,p,a,r)=>service.revalidate(w,e,p,a,(r.body as {expectedRevision?:number}|undefined)?.expectedRevision));
 route('PUT','/:provider/settings',['enabled','expectedRevision','historyEnabled','groupListenEnabled','groupTriggerKeywords','meetingRefs'],(w,e,p,a,r)=>service.settings(w,e,p,a,r.body as any));
 route('DELETE','/:provider',['expectedRevision'],(w,e,p,a,r)=>service.unbind(w,e,p,a,r.body as {expectedRevision:number}));
 route('POST','/:provider/verification/start',['expectedRevision'],(w,e,p,a,r)=>{
  if(p!=='feishu')throw new EmployeeChannelError(409,'channel_verification_automatic');
  return service.startVerification(w,e,p,a,r.body as any);
 });
 route('GET','/:provider/verification',[],(w,e,p)=>service.verification(w,e,p));
 route('POST','/:provider/verification/confirm',['expectedRevision','candidateId'],(w,e,p,a,r)=>{
  if(p!=='feishu')throw new EmployeeChannelError(409,'channel_verification_automatic');
  return service.confirmVerification(w,e,p,a,r.body as any);
 });
 route('GET','/:provider/directory',[],(w,e,p,_a,r)=>service.discovery(w,e,p,r.query as any));
 route('POST','/wecom/member-search',['keywords'],(w,e,_p,_a,r)=>service.searchWeComMembers(w,e,(r.body as {keywords?:unknown}|undefined)?.keywords));
}
