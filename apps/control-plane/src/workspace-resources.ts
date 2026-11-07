import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {SkillResources} from './skill-resources.js';
import type {McpResources} from './mcp-resources.js';
import {CapabilityConfigError} from './capability-config.js';
export function registerWorkspaceResources(app:FastifyInstance,skills:SkillResources,mcp:McpResources,member:(request:FastifyRequest,w:string)=>string){
 const base='/api/workspaces/:workspaceId';
 const route=(method:'GET'|'POST'|'PUT',path:string,work:(w:string,id:string,actor:string,r:FastifyRequest)=>unknown,bodyLimit=400000)=>app.route({method,url:base+path,bodyLimit,handler:async(request,reply)=>{const p=request.params as {workspaceId:string;resourceId?:string},actor=member(request,p.workspaceId);try{const value=await work(p.workspaceId,p.resourceId??'',actor,request);member(request,p.workspaceId);return value;}catch(error){if(error instanceof CapabilityConfigError)return reply.code(error.status).send({error:error.code});throw error;}}});
 route('GET','/skills',w=>({skills:skills.list(w)}));
 route('GET','/skills/:resourceId/versions',(w,id)=>({versions:skills.versions(w,id)}));
 route('POST','/skills/imports',(w,_id,_actor,r)=>skills.import(w,r.body,()=>{member(r,w);}),29*1024*1024);
 route('PUT','/skills/:resourceId/status',(w,id,_actor,r)=>skills.status(w,id,r.body));
 route('GET','/mcp-resources',w=>({servers:mcp.list(w)}));
 route('POST','/mcp-resources/discover',(w,_id,actor,r)=>mcp.discover(w,actor,r.body));
 route('POST','/mcp-resources',(w,_id,actor,r)=>mcp.save(w,actor,r.body));
 route('PUT','/mcp-resources/:resourceId/status',(w,id,_actor,r)=>mcp.status(w,id,r.body));
}
