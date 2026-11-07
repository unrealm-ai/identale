/** UI projection only. The HTTP mapper is added after the backend contract is agreed. */
export type SyncLoadState = 'loading' | 'ready' | 'error' | 'denied';
export type SyncRunStatus = 'never' | 'running' | 'succeeded' | 'failed' | 'abandoned' | 'unknown';
export interface DirectorySyncTaskView {
  id: string;
  employeeId: string;
  employeeName: string;
  channelName: string;
  connectionLabel?: string;
  scheduleEnabled: boolean;
  intervalMinutes: number;
  running: boolean;
  lastStatus: SyncRunStatus;
  lastSuccessAt: number | null;
  nextRunAt: number | null;
  latestError: string | null;
  snapshotState: 'none' | 'available' | 'stale' | 'invalid';
  canRun: boolean;
  canSchedule: boolean;
}
export interface DirectorySyncRunView {
  id: string;
  trigger: 'manual' | 'scheduled' | 'demand' | 'configuration' | 'unknown';
  status: Exclude<SyncRunStatus, 'never'>;
  startedAt: number;
  completedAt: number | null;
  error: string | null;
  snapshotVersion?: number|null;
  userCount?: number;
  departmentCount?: number;
}
export const syncStatusLabel = (status: SyncRunStatus) => ({never:'尚未同步',running:'同步中',succeeded:'最近同步成功',failed:'最近同步失败',abandoned:'已中断',unknown:'状态待核对'})[status];
export const syncTime = (at: number | null) => at === null ? '—' : new Date(at).toLocaleString('zh-CN');
