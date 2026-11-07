import type {FastifyInstance,FastifyRequest} from 'fastify';
import {DirectorySnapshots,DirectorySyncApiError} from './service.js';
import type {DirectorySyncTaskPatch} from './types.js';
export function registerDirectorySyncRoutes(app:FastifyInstance,service:DirectorySnapshots,requireAdmin:(r:FastifyRequest,w:string)=>void|Promise<void>){
 const base='/api/workspaces/:workspaceId/directory-sync/tasks';
 const route=(method:'GET'|'PATCH'|'POST',suffix:string,work:(w:string,id:string,r:FastifyRequest)=>unknown)=>app.route({method,url:base+suffix,handler:async(request,reply)=>{const p=request.params as{workspaceId:string;taskId?:string};await requireAdmin(request,p.workspaceId);try{if(method!=='GET'&&(!request.body||typeof request.body!=='object'||Array.isArray(request.body)))return reply.code(400).send({error:'invalid_directory_sync_request'});const result=await work(p.workspaceId,p.taskId??'',request);return reply.code(method==='POST'?202:200).send(result);}catch(error){if(error instanceof DirectorySyncApiError)return reply.code(error.status).send({error:error.code});return reply.code(503).send({error:'directory_sync_unavailable'});}}});
 route('GET','',(w)=>service.list(w));route('GET','/:taskId/history',(w,id,r)=>service.history(w,id,r.query as{limit?:unknown;cursor?:unknown}));route('PATCH','/:taskId',(w,id,r)=>service.patch(w,id,r.body as DirectorySyncTaskPatch));route('POST','/:taskId/run',(w,id,r)=>{if(Object.keys(r.body as object).length)throw new DirectorySyncApiError(400,'invalid_directory_sync_request');return service.manual(w,id);});
}
