import type { FastifyInstance, FastifyRequest } from 'fastify';
import { TaskService, TaskError, taskBody, taskString, type TaskScope, type TaskRequestContext, type TaskExecutionRecordsReadPort } from '@dentity/application';
export { TaskService, TaskError, taskBody, taskString, type TaskScope, type TaskRequestContext, type TaskRow } from '@dentity/application';

export function registerTasks(server: FastifyInstance, service: TaskService, auth: (request:FastifyRequest) => {id:string}) {
  const scope = (request:FastifyRequest): TaskScope => { const params=request.params as Record<string,string>; return {userId:auth(request).id,workspaceId:params['workspaceId']!,entityId:params['entityId']!}; };
  const base='/api/workspaces/:workspaceId/entities/:entityId';
  const context=(request:FastifyRequest,creating=false,activity=false):TaskRequestContext=>{
    const s=scope(request),p=request.params as Record<string,string>,query=taskBody(request.query,['conversationId','status','limit','cursor','summary',...(activity?['runId','after','entryId','offset']:[])]);
    const body=creating?taskBody(request.body,['operationId','conversationId','input','title','contextMode','historyMessageIds','capabilityPackageIds']):undefined;
    const locator=p['conversationId']??query['conversationId']??body?.['conversationId'];
    if(locator===undefined)throw new TaskError(400,'task_context_required');
    const conversationId=taskString(locator,160);
    if([query['conversationId'],body?.['conversationId']].some(v=>v!==undefined&&v!==conversationId))throw new TaskError(403,'task_conversation_forbidden');
    service.conversation(s,conversationId);
    return {...s,conversationId};
  };
  const taskId=(request:FastifyRequest)=>(request.params as {taskId:string}).taskId;
  // Legacy capabilityPackageIds is accepted only for compatibility; TaskService ignores it.
  const createKeys=['operationId','conversationId','input','title','contextMode','historyMessageIds','capabilityPackageIds'];
  for(const root of [`${base}/tasks`,`${base}/conversations/:conversationId/tasks`]){
    server.post(root,async(request,reply)=>reply.code(202).send({task:await service.create(context(request,true),taskBody(request.body,createKeys))}));
    server.get(root,request=>{
      const query=taskBody(request.query,['conversationId','status','limit','cursor','summary']);
      const {conversationId,...filters}=query;void conversationId;
      if(filters['limit']!==undefined){if(typeof filters['limit']!=='string'||!/^\d+$/.test(filters['limit']))throw new TaskError(400,'invalid_task_query');filters['limit']=Number(filters['limit']);}
      return service.listPage(context(request),filters);
    });
    server.get(`${root}/:taskId`,async request=>{const c=context(request);return {task:service.dto(await service.refreshTaskContext(c,taskId(request)))};});
    server.get(`${root}/:taskId/context`,async request=>{const c=context(request);await service.refreshTaskContext(c,taskId(request));return service.getContext(c,taskId(request));});
    server.get(`${root}/:taskId/updates`,async request=>{const c=context(request);await service.refreshTaskContext(c,taskId(request));return service.getUpdates(c,taskId(request));});
    server.get(`${root}/:taskId/activity`,request=>{const c=context(request,false,true);const {conversationId,...query}=request.query as Record<string,unknown>;void conversationId;return service.activity(c,taskId(request),query);});
    server.get(`${root}/:taskId/records`,request=>{const c=context(request,false,true);const {conversationId,...query}=request.query as Record<string,unknown>;void conversationId;return service.executionRecords(c,taskId(request),query,server.hasDecorator('taskExecutionRecordsReader')?server.getDecorator<TaskExecutionRecordsReadPort>('taskExecutionRecordsReader'):undefined);});
    for(const kind of ['input','cancel','start'] as const)server.post(`${root}/:taskId/${kind}`,async request=>{
      const c=context(request),body=taskBody(request.body,kind==='input'?['operationId','expectedVersion','input']:['operationId','expectedVersion']);
      return {task:kind==='start'?await service.startTodo(c,taskId(request),body):await service.mutate(c,taskId(request),kind,body)};
    });
  }
  for(const root of [`${base}/todos`,`${base}/conversations/:conversationId/todos`]){
    server.post(root,async(request,reply)=>{const c=context(request,true);await service.refreshAuthorization(c);return reply.code(201).send({task:service.createTodo(c,taskBody(request.body,createKeys))});});
    server.get(root,request=>{
      const query=taskBody(request.query,['conversationId','status','limit','cursor']);
      if(query['status']!==undefined&&query['status']!=='planned')throw new TaskError(400,'invalid_task_query');
      const limit=query['limit'];if(limit!==undefined&&(typeof limit!=='string'||!/^\d+$/.test(limit)))throw new TaskError(400,'invalid_task_query');
      return service.listPage(context(request),{status:'planned',...(limit!==undefined?{limit:Number(limit)}:{}),...(query['cursor']!==undefined?{cursor:query['cursor']}:{})});
    });
    server.post(`${root}/:taskId/start`,async request=>({task:await service.startTodo(context(request),taskId(request),taskBody(request.body,['operationId','expectedVersion']))}));
    server.post(`${root}/:taskId/cancel`,async request=>({task:await service.cancelTodo(context(request),taskId(request),taskBody(request.body,['operationId','expectedVersion']))}));
  }
  return {service,scope,base};
}
