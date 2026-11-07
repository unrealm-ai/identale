import {taskDisplayTitle} from '@dentity/contracts';
import { TaskError, type AdminTaskReadPort, type AdminReadCursor, type AdminConversation, type AdminTaskRecord } from '@dentity/application';
import type { Store } from '../../store.js';
import { SqliteTaskActivityRead } from './task-activity-read.js';
export class SqliteAdminTaskRead extends SqliteTaskActivityRead implements AdminTaskReadPort {
  constructor(store: Store) {
    super(store);
    store.db.exec('CREATE INDEX IF NOT EXISTS workbench_tasks_order ON tasks(workspace_id,created_at DESC,id DESC); CREATE INDEX IF NOT EXISTS workbench_tasks_entity_order ON tasks(workspace_id,entity_id,created_at DESC,id DESC)');
  }
  requireEntity(w: string, e: string) { if (!this.store.one('SELECT id FROM entities WHERE workspace_id=? AND id=?', w, e)) throw new TaskError(404, 'entity_not_found'); }
  requireConversation(w: string, e: string, c: string) { if (!this.store.one('SELECT id FROM conversations WHERE workspace_id=? AND entity_id=? AND id=?', w, e, c)) throw new TaskError(404, 'conversation_not_found'); }
  overview(w: string, e?: string) {
    const count = (table: 'entities' | 'conversations' | 'tasks', condition = '') => this.store.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id=? AND (? IS NULL OR ${table === 'entities' ? 'id' : 'entity_id'}=?) ${condition}`, w, e ?? null, e ?? null)!.n;
    return { employees: count('entities'), conversations: count('conversations'), activeTasks: count('tasks', "AND status IN ('queued','running','waiting_input','waiting_approval','waiting_human','cancel_requested','unknown')"), succeeded: count('tasks', "AND status='succeeded'"), failed: count('tasks', "AND status='failed'") };
  }
  ceiling(kind: 'conversations' | 'tasks', w: string) { return this.store.one<{ n: number }>(`SELECT COALESCE(MAX(rowid),0) AS n FROM ${kind} WHERE workspace_id=?`, w)!.n; }
  conversations(w: string, e: string, c: string | undefined, p: AdminReadCursor, limit: number) {
    return this.store.all<AdminConversation>(`SELECT c.id,c.entity_id AS entityId,c.channel,c.mode,c.created_at AS createdAt,(SELECT COUNT(*) FROM tasks t WHERE t.conversation_id=c.id AND t.workspace_id=c.workspace_id AND t.entity_id=c.entity_id) AS taskCount FROM conversations c WHERE c.workspace_id=? AND c.entity_id=? AND (? IS NULL OR c.id=?) AND c.rowid<=? AND (c.created_at<? OR (c.created_at=? AND c.id<?)) ORDER BY c.created_at DESC,c.id DESC LIMIT ?`, w, e, c ?? null, c ?? null, p.ceiling, p.createdAt, p.createdAt, p.id, limit);
  }
  taskList(w:string,f:{entityId?:string;conversationId?:string;channel?:string;status:string;taskId?:string},p:AdminReadCursor,limit:number):(AdminTaskRecord&{channel:string})[]{
    const conditions=['t.workspace_id=?','t.rowid<=?','(t.created_at<? OR (t.created_at=? AND t.id<?))'];const args:import('node:sqlite').SQLInputValue[]=[w,p.ceiling,p.createdAt,p.createdAt,p.id];
    if(f.taskId){conditions.push('t.id=?');args.push(f.taskId);}if(f.entityId){conditions.push('t.entity_id=?');args.push(f.entityId);}if(f.conversationId){conditions.push('t.conversation_id=?');args.push(f.conversationId);}if(f.channel){conditions.push("(CASE WHEN t.origin_kind='trigger' THEN 'trigger' ELSE COALESCE(c.channel,'unknown') END)=?");args.push(f.channel);}if(f.status==='active')conditions.push("t.status IN ('queued','running','waiting_input','waiting_approval','waiting_human','cancel_requested','unknown')");else if(f.status!=='all'){conditions.push('t.status=?');args.push(f.status);}
    const rows=this.store.all<Omit<AdminTaskRecord,'run'>&{channel:string;runId:string|null;runStatus:string|null;result:string|null;resultInputRevision:number|null}>(`SELECT t.id,t.entity_id AS entityId,t.conversation_id AS conversationId,t.input,t.title,t.status,t.created_at AS createdAt,t.updated_at AS updatedAt,t.input_revision AS inputRevision,CASE WHEN t.origin_kind='trigger' THEN 'trigger' ELSE COALESCE(c.channel,'unknown') END AS channel,e.name AS employeeName,r.id AS runId,r.status AS runStatus,r.result,r.result_revision AS resultInputRevision FROM tasks t LEFT JOIN conversations c ON c.id=t.conversation_id AND c.workspace_id=t.workspace_id AND c.entity_id=t.entity_id JOIN entities e ON e.id=t.entity_id AND e.workspace_id=t.workspace_id LEFT JOIN runs r ON r.id=t.run_id AND r.task_id=t.id WHERE ${conditions.join(' AND ')} ORDER BY t.created_at DESC,t.id DESC LIMIT ?`,...args,limit);
    return rows.map(({runId,runStatus,result,resultInputRevision,...row})=>({...row,title:taskDisplayTitle(row),run:runId?{id:runId,status:runStatus!,result,resultInputRevision}:null}));
  }
  taskDetail(w:string,id:string){const task=this.taskList(w,{status:'all',taskId:id},{ceiling:Number.MAX_SAFE_INTEGER,createdAt:Number.MAX_SAFE_INTEGER,id:'\uffff'},1)[0];if(!task)return undefined;
    return {...task,deliveries:this.store.all<{id:string;status:string;createdAt:number}>('SELECT id,status,created_at AS createdAt FROM deliveries WHERE task_id=? ORDER BY created_at,id',id)};
  }
  tasks(w: string, e: string, c: string, status: string, p: AdminReadCursor, limit: number): AdminTaskRecord[] {
    const rows = this.store.all<Omit<AdminTaskRecord, 'run'> & { runId: string | null; runStatus: string | null; result: string | null; resultInputRevision: number | null }>(`SELECT t.id,t.entity_id AS entityId,t.conversation_id AS conversationId,t.input,t.title,t.status,t.created_at AS createdAt,t.updated_at AS updatedAt,t.input_revision AS inputRevision,r.id AS runId,r.status AS runStatus,r.result,r.result_revision AS resultInputRevision FROM tasks t LEFT JOIN runs r ON r.id=t.run_id AND r.task_id=t.id WHERE t.workspace_id=? AND t.entity_id=? AND t.conversation_id=? AND t.rowid<=? AND (t.created_at<? OR (t.created_at=? AND t.id<?)) AND (?='all' OR t.status=? OR (?='active' AND t.status IN ('queued','running','waiting_input','waiting_approval','waiting_human','cancel_requested','unknown'))) ORDER BY t.created_at DESC,t.id DESC LIMIT ?`, w, e, c, p.ceiling, p.createdAt, p.createdAt, p.id, status, status, status, limit);
    return rows.map(({ runId, runStatus, result, resultInputRevision, ...row }) => ({ ...row, title:taskDisplayTitle(row), run: runId ? { id: runId, status: runStatus!, result, resultInputRevision } : null }));
  }
}
