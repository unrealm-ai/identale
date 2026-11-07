import{businessNotificationViews}from'../../notifications/business-results.js';
import type { TaskActivityEntry, TaskActivityReadPort, TaskActivityRun } from '@dentity/application';
import type { Store } from '../../store.js';

// Adjacent text deltas are one visible fragment. The existing protocol has no
// assistant-message boundary, so this projection does not invent one.
const activity = `WITH ordered AS (
  SELECT id,run_id,sequence,type,created_at,payload_json,
    SUM(CASE WHEN type='output_delta' THEN 0 ELSE 1 END) OVER (ORDER BY sequence) AS block
  FROM task_updates WHERE task_id=? AND run_id=?
), visible AS (
  SELECT CAST(MIN(id) AS TEXT) AS id,run_id AS runId,MIN(sequence) AS sequence,
    CASE WHEN type='output_delta' THEN 'reply' ELSE type END AS type,MIN(created_at) AS createdAt,
    group_concat(COALESCE(json_extract(payload_json,'$.text'),'') ,'' ORDER BY sequence) AS text,
    json_extract(payload_json,'$.status') AS status,json_extract(payload_json,'$.inputRevision') AS inputRevision,
    json_extract(payload_json,'$.inputStatus') AS inputStatus
  FROM ordered WHERE type IN ('status','progress','output_delta','partial_result','final_result','input_receipt')
  GROUP BY CASE WHEN type='output_delta' THEN 'reply:'||block ELSE 'event:'||id END
  UNION ALL
  SELECT 'result:'||id,id,sequence+1,'final_result',COALESCE(terminal_at,created_at),result,NULL,result_revision,NULL
  FROM runs WHERE task_id=? AND id=? AND result IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM task_updates WHERE run_id=runs.id AND type='final_result')
)`;

/** Defense in depth for credential-shaped text. Known secret values are already
 * removed at the Host response boundary; this is not a native-journal reader. */
function publicText(text: string): string {
  return text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[redacted]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1[redacted]')
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|secret|password|authorization)["']?\s*[:=]\s*)["']?[^\s,"'<>}]+["']?/gi, '$1[redacted]');
}
export class SqliteTaskActivityRead implements TaskActivityReadPort {
  constructor(protected readonly store: Store) {}
  activityNotifications(taskId:string){return businessNotificationViews(this.store,taskId);}
  activityRuns(taskId: string): TaskActivityRun[] {
    return this.store.all('SELECT id,status,attempt,kind,parent_run_id AS parentRunId,end_reason AS endReason,created_at AS createdAt,result_revision AS resultInputRevision FROM runs WHERE task_id=? ORDER BY attempt DESC,created_at DESC,id DESC', taskId);
  }
  activityEntries(taskId: string, runId: string, after: number, limit: number): TaskActivityEntry[] {
    // A bounded page of explicit public fields, never raw payloads. Redaction
    // precedes preview slicing, including credentials crossing the preview edge.
    const rows = this.store.all<TaskActivityEntry>(activity + ' SELECT id,runId,sequence,type,createdAt,text,0 AS textLength,status,inputRevision,inputStatus FROM visible WHERE sequence>? ORDER BY sequence LIMIT ?', taskId, runId, taskId, runId, after, limit);
    return rows.map(row => { const text = Array.from(publicText(row.text)); return { ...row, text: text.slice(0, 1200).join(''), textLength: text.length }; });
  }
  activityContent(taskId: string, runId: string, entryId: string, offset: number) {
    // Redact before slicing so a credential crossing a chunk boundary cannot leak.
    const row = this.store.one<{ text: string }>(activity + ' SELECT text FROM visible WHERE id=?', taskId, runId, taskId, runId, entryId);
    if (!row) return undefined;
    const text = publicText(row.text), characters = Array.from(text), end = offset + 8000;
    return { text: characters.slice(offset, end).join(''), nextOffset: characters.length > end ? end : null };
  }
  activityDeliveries(taskId: string): { id: string; status: string; createdAt: number }[] {
    return this.store.all('SELECT id,status,created_at AS createdAt FROM deliveries WHERE task_id=? ORDER BY created_at,id', taskId);
  }
}
