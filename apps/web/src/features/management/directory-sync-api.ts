import type {DirectoryProvider} from '../directory/types';
import type {DirectorySyncTaskView,DirectorySyncRunView} from './directory-sync-view';

export interface DirectorySyncError {code:string;category:'authentication'|'permission'|'timeout'|'network'|'parse'|'limit'|'source'|'unknown';httpStatus?:number;providerCode?:number}
export interface DirectorySyncTask {
  id:string;workspaceId:string;entityId:string;entityName:string;connectionId:string;provider:DirectoryProvider;appId:string;
  memberConnectionIds?:readonly string[];version:number;enabled:boolean;periodMs:number;nextScheduledAt:number|null;running:boolean;
  lastStartedAt:number|null;lastFinishedAt:number|null;lastSuccessAt:number|null;
  lastResult:'never'|'success'|'failure'|'invalidated';lastError:DirectorySyncError|null;
  snapshotVersion:number;hasSnapshot:boolean;stale:boolean;
}
export interface DirectorySyncHistory {
  id:string;taskId:string;trigger:'scheduled'|'manual'|'demand'|'configuration';startedAt:number;finishedAt:number|null;
  status:'running'|'success'|'failure'|'abandoned';snapshotVersion:number|null;userCount:number;departmentCount:number;error:DirectorySyncError|null;
}
export interface DirectorySyncHistoryPage {items:DirectorySyncHistory[];nextCursor:string|null}
export interface DirectorySyncPatch {expectedVersion:number;enabled?:boolean;periodMs?:number}
export const MIN_SYNC_PERIOD_MS=60000,MAX_SYNC_PERIOD_MS=2592000000;
const labels={authentication:'认证失败',permission:'权限不足',timeout:'读取超时',network:'网络异常',parse:'响应格式异常',limit:'达到同步限制',source:'来源已变化',unknown:'同步未完成'};
export function syncError(error:DirectorySyncError|null):string|null {
  if(!error)return null;
  return `${labels[error.category]??labels.unknown}（${error.code}${error.httpStatus?`，HTTP ${error.httpStatus}`:''}${error.providerCode!==undefined?`，厂商代码 ${error.providerCode}`:''}）`;
}
export function taskView(task:DirectorySyncTask):DirectorySyncTaskView {
  return {id:task.id,employeeId:task.entityId,employeeName:task.entityName,channelName:({feishu:'飞书',dingtalk:'钉钉',wecom:'企业微信'})[task.provider],connectionLabel:task.appId,
    scheduleEnabled:task.enabled,intervalMinutes:task.periodMs/60000,running:task.running,
    lastStatus:task.running?'running':({never:'never',success:'succeeded',failure:'failed',invalidated:'unknown'} as const)[task.lastResult],
    lastSuccessAt:task.lastSuccessAt,nextRunAt:task.nextScheduledAt,latestError:syncError(task.lastError),
    snapshotState:task.lastResult==='invalidated'?'invalid':!task.hasSnapshot?'none':task.stale?'stale':'available',
    canRun:task.lastResult!=='invalidated',canSchedule:task.lastResult!=='invalidated'};
}
export function historyView(run:DirectorySyncHistory):DirectorySyncRunView {
  return {id:run.id,trigger:run.trigger,status:({running:'running',success:'succeeded',failure:'failed',abandoned:'abandoned'} as const)[run.status],startedAt:run.startedAt,completedAt:run.finishedAt,error:syncError(run.error),snapshotVersion:run.snapshotVersion,userCount:run.userCount,departmentCount:run.departmentCount};
}
function record(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function timestamp(value:unknown){return value===null||Number.isSafeInteger(value)&&Number(value)>=0;}
function errorShape(value:unknown){return value===null||record(value)&&typeof value.code==='string'&&value.code.length<=100&&Object.hasOwn(labels,String(value.category))&&(value.httpStatus===undefined||Number.isSafeInteger(value.httpStatus))&&(value.providerCode===undefined||Number.isSafeInteger(value.providerCode));}
/** Reject cross-scope or malformed projections instead of retaining another workspace's rows. */
export function readTask(value:unknown,workspaceId:string):DirectorySyncTask {
  if(!record(value)||value.memberConnectionIds!==undefined&&(!Array.isArray(value.memberConnectionIds)||value.memberConnectionIds.some(id=>typeof id!=='string'||!id))||value.workspaceId!==workspaceId||!['id','entityId','entityName','connectionId','appId'].every(k=>typeof value[k]==='string'&&String(value[k]).length>0)||!['feishu','dingtalk','wecom'].includes(String(value.provider))||!Number.isSafeInteger(value.version)||Number(value.version)<1||typeof value.enabled!=='boolean'||typeof value.running!=='boolean'||typeof value.hasSnapshot!=='boolean'||typeof value.stale!=='boolean'||!Number.isSafeInteger(value.periodMs)||Number(value.periodMs)<MIN_SYNC_PERIOD_MS||Number(value.periodMs)>MAX_SYNC_PERIOD_MS||!['nextScheduledAt','lastStartedAt','lastFinishedAt','lastSuccessAt'].every(k=>timestamp(value[k]))||!['never','success','failure','invalidated'].includes(String(value.lastResult))||!errorShape(value.lastError)||!Number.isSafeInteger(value.snapshotVersion)||Number(value.snapshotVersion)<0)throw new Error('invalid_directory_sync_response');
  return value as unknown as DirectorySyncTask;
}
export function readTasks(value:unknown,workspaceId:string):DirectorySyncTask[]{
  if(!record(value)||!Array.isArray(value.tasks))throw new Error('invalid_directory_sync_response');
  const tasks=value.tasks.map(t=>readTask(t,workspaceId));if(new Set(tasks.map(t=>t.id)).size!==tasks.length)throw new Error('duplicate_directory_sync_task');return tasks;
}
export function readHistory(value:unknown,taskId:string):DirectorySyncHistoryPage {
  if(!record(value)||!Array.isArray(value.items)||!(value.nextCursor===null||typeof value.nextCursor==='string'&&value.nextCursor.length>0))throw new Error('invalid_directory_sync_history');
  const items=value.items.map(item=>{
    if(!record(item)||typeof item.id!=='string'||!item.id||item.taskId!==taskId||!['scheduled','manual','demand','configuration'].includes(String(item.trigger))||!['running','success','failure','abandoned'].includes(String(item.status))||!timestamp(item.startedAt)||item.startedAt===null||!timestamp(item.finishedAt)||!timestamp(item.snapshotVersion)||!Number.isSafeInteger(item.userCount)||Number(item.userCount)<0||!Number.isSafeInteger(item.departmentCount)||Number(item.departmentCount)<0||!errorShape(item.error))throw new Error('invalid_directory_sync_history');return item as unknown as DirectorySyncHistory;
  });if(new Set(items.map(item=>item.id)).size!==items.length)throw new Error('duplicate_directory_sync_history');return {items,nextCursor:value.nextCursor as string|null};
}
