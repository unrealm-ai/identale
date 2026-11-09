import type {FastifyInstance,FastifyRequest} from 'fastify';
import {EmployeeChannelError} from './service.js';
import type {DingTalkRegistrations} from './dingtalk-registration.js';
export function registerDingTalkRegistrationRoutes(app:FastifyInstance,service:DingTalkRegistrations,manager:(request:FastifyRequest,workspaceId:string,entityId:string)=>string){
 const base='/api/workspaces/:workspaceId/entities/:entityId/channels/dingtalk/registration';
 function route(method:'GET'|'POST'|'DELETE',path:string,keys:string[],fn:(scope:{workspaceId:string;entityId:string;actorId:string},id:string,input:Record<string,unknown>,check:()=>void)=>unknown){
  app.route({method,url:base+path,logLevel:'silent',handler:async(request,reply)=>{
   reply.header('cache-control','no-store').header('referrer-policy','no-referrer');
   const p=request.params as {workspaceId:string;entityId:string;sessionId?:string},actorId=manager(request,p.workspaceId,p.entityId);
   const input=request.body??{};if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!keys.includes(key)))return reply.code(400).send({error:'invalid_dingtalk_registration_request'});
   try{return await fn({...p,actorId},p.sessionId??'',input as Record<string,unknown>,()=>{if(manager(request,p.workspaceId,p.entityId)!==actorId)throw new EmployeeChannelError(403,'role_forbidden');});}
   catch(error){if(error instanceof EmployeeChannelError)return reply.code(error.status).send({error:error.code});return reply.code(503).send({error:'dingtalk_registration_unavailable'});}
  }});
 }
 route('GET','',[],scope=>service.availability(scope));
 route('POST','/start',['sessionId','expectedRevision'],(scope,_id,input)=>service.start(scope,input));
 route('POST','/:sessionId/poll',[],(scope,id)=>service.poll(scope,id));
 route('POST','/:sessionId/bind',['replaceSource'],(scope,id,input,check)=>service.bind(scope,id,input['replaceSource'],check));
 route('DELETE','/:sessionId',[],(scope,id)=>service.cancel(scope,id));
}
