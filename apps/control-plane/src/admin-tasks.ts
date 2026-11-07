import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AdminTaskReadService, TaskError, taskBody, type AdminTaskScope, type TaskExecutionRecordsReadPort } from '@dentity/application';
import { SqliteAdminTaskRead } from './adapters/sqlite/admin-task-read.js';
import type { Store } from './store.js';
export function registerAdminTasks(server: FastifyInstance, options: { store: Store; auth: (request: FastifyRequest) => { id: string }; requireAdmin: (scope: AdminTaskScope) => void;humanView?:(taskId:string)=>unknown[] }) {
  const service = new AdminTaskReadService(new SqliteAdminTaskRead(options.store), options.requireAdmin,options.humanView);
  server.decorate('authorizeManagedTaskRecordRead',(s:AdminTaskScope,id:string)=>{service.taskDetail(s,id);});
  const scope = (request: FastifyRequest) => { const s={ userId: options.auth(request).id, workspaceId: (request.params as { workspaceId: string }).workspaceId }; options.requireAdmin(s);return s; };
  const query = (request: FastifyRequest) => {
    const q = taskBody(request.query, ['entityId', 'conversationId', 'status', 'channel', 'limit', 'cursor', 'summary']);
    if (q['limit'] !== undefined) { if (typeof q['limit'] !== 'string' || !/^\d+$/.test(q['limit'])) throw new TaskError(400, 'invalid_task_query'); q['limit'] = Number(q['limit']); }
    return q;
  };
  const base = '/api/workspaces/:workspaceId/task-management';
  server.get(`${base}/task-list`, request => service.taskList(scope(request), query(request)));
  server.get(`${base}/task-list/:taskId`, request => service.taskDetail(scope(request),(request.params as {taskId:string}).taskId));
  server.get(`${base}/task-list/:taskId/activity`, request => service.activity(scope(request),(request.params as {taskId:string}).taskId,request.query));
  server.get(`${base}/task-list/:taskId/records`,request=>service.executionRecords(scope(request),(request.params as {taskId:string}).taskId,request.query,server.hasDecorator('taskExecutionRecordsReader')?server.getDecorator<TaskExecutionRecordsReadPort>('taskExecutionRecordsReader'):undefined));
  server.get(`${base}/overview`, request => service.overview(scope(request), request.query));
  server.get(`${base}/conversations`, request => service.conversations(scope(request), query(request)));
  server.get(`${base}/tasks`, request => service.tasks(scope(request), query(request)));
}
