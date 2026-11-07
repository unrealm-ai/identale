import {taskDisplayTitle} from '@dentity/contracts';
import { createHash } from 'node:crypto';
import { TaskError, taskBody, taskString } from './service.js';
import { readTaskActivity, type TaskActivityReadPort } from './activity.js';
import { executionRecordQuery, unavailableExecutionRecords, type TaskExecutionRecordsReadPort } from './execution-records.js';

export interface AdminTaskScope { userId: string; workspaceId: string }
export interface AdminReadCursor { ceiling: number; createdAt: number; id: string }
export interface AdminConversation { id: string; entityId: string; channel: string; mode: string; createdAt: number; taskCount: number }
export interface AdminTaskRecord { title?:string|null; id: string; entityId: string; conversationId: string | null; input: string; status: string; createdAt: number; updatedAt: number; inputRevision: number; run: { id: string; status: string; result: string | null; resultInputRevision: number | null } | null }
export interface AdminTaskReadPort extends TaskActivityReadPort {
  taskList(workspaceId:string, filters:{entityId?:string;conversationId?:string;channel?:string;status:string}, cursor:AdminReadCursor, limit:number): AdminTaskRecord[];
  taskDetail(workspaceId:string,id:string): (AdminTaskRecord & {channel:string;deliveries:{id:string;status:string;createdAt:number}[]}) | undefined;
  overview(workspaceId: string, entityId?: string): { employees: number; conversations: number; activeTasks: number; succeeded: number; failed: number };
  ceiling(kind: 'conversations' | 'tasks', workspaceId: string): number;
  conversations(workspaceId: string, entityId: string, conversationId: string | undefined, cursor: AdminReadCursor, limit: number): AdminConversation[];
  tasks(workspaceId: string, entityId: string, conversationId: string, status: string, cursor: AdminReadCursor, limit: number): AdminTaskRecord[];
  requireEntity(workspaceId: string, entityId: string): void;
  requireConversation(workspaceId: string, entityId: string, conversationId: string): void;
}
/** Explicit management read boundary. Never reused by conversation/LLM task tools. */
export class AdminTaskReadService {
  constructor(private readonly repository: AdminTaskReadPort, private readonly requireAdmin: (scope: AdminTaskScope) => void,private readonly humanView?:(taskId:string)=>unknown[]) {}
  overview(scope: AdminTaskScope, value: unknown = {}) {
    this.requireAdmin(scope);
    const query = taskBody(value, ['entityId']), entityId = query['entityId'] === undefined ? undefined : taskString(query['entityId'], 160);
    if (entityId) this.repository.requireEntity(scope.workspaceId, entityId);
    const stats = this.repository.overview(scope.workspaceId, entityId), denominator = stats.succeeded + stats.failed;
    return { ...stats, successRate: denominator ? stats.succeeded / denominator : null };
  }
  private query(scope: AdminTaskScope, kind: 'conversations' | 'tasks', value: unknown) {
    this.requireAdmin(scope);
    const query = taskBody(value, ['entityId', 'conversationId', 'status', 'limit', 'cursor']);
    const entityId = taskString(query['entityId'], 160), conversationId = query['conversationId'] === undefined ? undefined : taskString(query['conversationId'], 160);
    const status = query['status'] ?? 'all', limit = query['limit'] ?? 25;
    if (!['all', 'planned', 'active', 'queued', 'running', 'waiting_input', 'waiting_approval', 'waiting_human', 'cancel_requested', 'unknown', 'succeeded', 'failed', 'canceled'].includes(status as string) || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100 || (kind === 'conversations' && status !== 'all')) throw new TaskError(400, 'invalid_task_query');
    this.repository.requireEntity(scope.workspaceId, entityId);
    if (conversationId) this.repository.requireConversation(scope.workspaceId, entityId, conversationId);
    const fingerprint = createHash('sha256').update(JSON.stringify([scope.userId, scope.workspaceId, kind, entityId, conversationId, status])).digest('hex');
    let cursor: AdminReadCursor = { ceiling: this.repository.ceiling(kind, scope.workspaceId), createdAt: Number.MAX_SAFE_INTEGER, id: '\uffff' };
    if (query['cursor'] !== undefined) {
      try {
        if (typeof query['cursor'] !== 'string' || query['cursor'].length > 2000) throw Error();
        const parsed = JSON.parse(Buffer.from(query['cursor'], 'base64url').toString('utf8')) as AdminReadCursor & { fingerprint: string };
        if (parsed.fingerprint !== fingerprint || !Number.isSafeInteger(parsed.ceiling) || parsed.ceiling < 0 || !Number.isSafeInteger(parsed.createdAt) || parsed.createdAt < 0 || typeof parsed.id !== 'string' || !parsed.id || parsed.id.length > 160) throw Error();
        cursor = parsed;
      } catch { throw new TaskError(400, 'invalid_task_cursor'); }
    }
    return { entityId, conversationId, status: status as string, limit: limit as number, cursor, fingerprint };
  }
  conversations(scope: AdminTaskScope, value: unknown) {
    const q = this.query(scope, 'conversations', value), rows = this.repository.conversations(scope.workspaceId, q.entityId, q.conversationId, q.cursor, q.limit + 1);
    return this.page(rows, q);
  }
  tasks(scope: AdminTaskScope, value: unknown) {
    const q = this.query(scope, 'tasks', value);
    if (!q.conversationId) throw new TaskError(400, 'task_context_required');
    return this.page(this.repository.tasks(scope.workspaceId, q.entityId, q.conversationId, q.status, q.cursor, q.limit + 1), q);
  }
  taskList(scope:AdminTaskScope,value:unknown) {
    this.requireAdmin(scope);
    const q=taskBody(value,['entityId','conversationId','channel','status','limit','cursor','summary']);
    if(q['summary']!==undefined&&q['summary']!=='true')throw new TaskError(400,'invalid_task_query');
    const entityId=q['entityId']===undefined?undefined:taskString(q['entityId'],160),conversationId=q['conversationId']===undefined?undefined:taskString(q['conversationId'],160),channel=q['channel']===undefined?undefined:taskString(q['channel'],40);
    const status=q['status']??'all',limit=q['limit']??25;
    if(!['all','planned','active','queued','running','waiting_input','waiting_approval','waiting_human','cancel_requested','unknown','succeeded','failed','canceled'].includes(String(status))||!Number.isSafeInteger(limit)||Number(limit)<1||Number(limit)>100)throw new TaskError(400,'invalid_task_query');
    if(entityId)this.repository.requireEntity(scope.workspaceId,entityId);
    const filters={...(entityId?{entityId}:{}),...(conversationId?{conversationId}:{}),...(channel?{channel}:{}),status:String(status)};
    const fingerprint=createHash('sha256').update(JSON.stringify([scope.userId,scope.workspaceId,'task-list',filters])).digest('hex');
    let cursor:AdminReadCursor={ceiling:this.repository.ceiling('tasks',scope.workspaceId),createdAt:Number.MAX_SAFE_INTEGER,id:'\uffff'};
    if(q['cursor']!==undefined){try{if(typeof q['cursor']!=='string'||q['cursor'].length>2000)throw Error();const p=JSON.parse(Buffer.from(q['cursor'],'base64url').toString());if(p.fingerprint!==fingerprint||!Number.isSafeInteger(p.ceiling)||p.ceiling<0||!Number.isSafeInteger(p.createdAt)||p.createdAt<0||typeof p.id!=='string'||!p.id||p.id.length>160)throw Error();cursor=p;}catch{throw new TaskError(400,'invalid_task_cursor');}}
    const result=this.page(this.repository.taskList(scope.workspaceId,filters,cursor,Number(limit)+1),{limit:Number(limit),cursor,fingerprint});
    return q['summary']==='true'?{...result,records:result.records.map(task=>({...task,run:task.run?{...task.run,result:null}:null}))}:result;
  }
  taskDetail(scope:AdminTaskScope,id:string){this.requireAdmin(scope);const row=this.repository.taskDetail(scope.workspaceId,taskString(id,160));if(!row)throw new TaskError(404,'task_not_found');return row;}
  activity(scope:AdminTaskScope,id:string,query:unknown){const task=this.taskDetail(scope,id),humanRequests=this.humanView?.(id)??[],result=readTaskActivity(this.repository,task.id,query);return 'entries' in result?{...result,task:{...(humanRequests.length?{humanRequests}:{}),id:task.id,title:taskDisplayTitle(task),input:task.input,status:task.status,createdAt:task.createdAt,inputRevision:task.inputRevision}}:result;}
  async executionRecords(scope:AdminTaskScope,id:string,value:unknown,reader?:TaskExecutionRecordsReadPort){
    const task=this.taskDetail(scope,id),query=executionRecordQuery(value),body=value as Record<string,unknown>,runs=this.repository.activityRuns(task.id);
    const runId=body['runId']===undefined?runs[0]?.id:taskString(body['runId'],160);
    if(runId&&!runs.some(run=>run.id===runId))throw new TaskError(404,'run_not_found');
    if(!runId||!reader)return unavailableExecutionRecords();
    const result=await reader.readRecords(task.id,runId,{kind:'admin',workspaceId:scope.workspaceId,userId:scope.userId},query);
    this.taskDetail(scope,id);return result;
  }
  private page<T extends { id: string; createdAt: number }>(rows: T[], q: { limit: number; cursor: AdminReadCursor; fingerprint: string }) {
    const records = rows.slice(0, q.limit), last = records.at(-1);
    return { records, nextCursor: rows.length > q.limit && last ? Buffer.from(JSON.stringify({ ceiling: q.cursor.ceiling, createdAt: last.createdAt, id: last.id, fingerprint: q.fingerprint })).toString('base64url') : null };
  }
}
