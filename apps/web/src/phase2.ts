/** Demo survives only as a read-only historical record discriminator. */
export type ChatMode = 'demo' | 'real';
export interface TaskAction { available: boolean; reason?: string }
export interface TaskActions {
  query: TaskAction & {mode: 'read'};
  start: TaskAction & {mode: 'start_planned'};
  supplement: TaskAction & {mode: 'platform_record_only' | 'runtime_input' | 'dispatch_input'; runtimeDelivery: {support: 'supported' | 'unsupported' | 'unknown'; reason?: string}; application: 'not_guaranteed' | 'on_start'};
  cancel: TaskAction & {mode: 'request_cancel' | 'cancel_planned'; confirmation: 'runtime_required' | 'platform_confirmed'};
  pause: TaskAction; resume: TaskAction;
}
export interface Task {
  id: string; entityId: string; conversationId: string; title?: string | null; input: string; contextMode: 'new' | 'fork';
  status: string; version: number; inputRevision: number; createdAt: number; updatedAt: number;
  availableActions?: TaskActions;
  actionCapabilities?: {runId: string | null; runtimeId?: string; runtimeVersion?: string; observedAt?: number; expiresAt?: number; bindingVersion?: string; status: 'known' | 'unknown'};
  actionReceipt?: {action: 'supplement' | 'cancel' | 'start'; operationId: string; status: 'recorded' | 'requested' | 'queued' | 'canceled' | 'already_started'; inputRevision?: number; deliveryMode?: string; runtimeStatus?: string};
  run: { id: string; status: string; sequence: number; result: string | null; resultInputRevision: number | null } | null;
}
export type TaskFilter = 'all' | 'planned' | 'active' | 'queued' | 'running' | 'waiting_input' | 'waiting_approval' | 'waiting_human' | 'cancel_requested' | 'unknown' | 'succeeded' | 'failed' | 'canceled';
export interface TaskPage { tasks: Task[]; nextCursor: string | null }
export const taskFilterOptions = [
  { label: '全部任务', value: 'all' }, { label: '待办', value: 'planned' },
  { label: '进行中 / 待核对', value: 'active' }, { label: '已排队', value: 'queued' },
  { label: '运行中', value: 'running' }, { label: '等待输入', value: 'waiting_input' }, { label: '等待审批', value: 'waiting_approval' }, { label: '等待人工', value: 'waiting_human' },
  { label: '取消待确认', value: 'cancel_requested' }, { label: '结果待核对', value: 'unknown' }, { label: '已成功', value: 'succeeded' },
  { label: '已失败', value: 'failed' }, { label: '已取消', value: 'canceled' },
];
export interface TaskUpdates {
  updates: { id: string | number; eventId: string; sequence: number; type: string; status?: string; text?: string; inputRevision?: number; inputStatus?: string }[];
  inputs: { revision: number; status: string }[];
  deliveries: { id: string; eventId: string; text: string; status: string }[];
}
export const statusLabel = (status: string): string => ({
  planned: '待办 · 尚未启动', recorded: '已保存到平台', preparing: '准备中', queued: '已排队，尚未确认运行', running: '运行中', waiting_input: '等待输入',
  waiting_approval: '等待审批', waiting_human:'等待人工确认', needs_human:'人工等待段已结束', cancel_requested: '已申请取消，尚未确认', canceled: '已确认取消',
  succeeded: '已成功结束', failed: '失败', unknown: '结果未知，需要对账', received: '执行器已接收',
  applied: '已应用', accepted: '已受理，尚未确认应用', rejected: '已拒绝', stored: '已存入 Web 会话反馈',
  pending: '待发送', confirmed: '已确认',
} as Record<string, string>)[status] ?? status;
export const terminalTask = (task: Task): boolean => ['succeeded', 'failed', 'canceled'].includes(task.status);
export interface ConfigMember { id: string; userId: string; displayName: string; role: string }
export type ApprovedResource = {enabled?:boolean;name?:string}&({ id: string; kind: 'skill'; resourceId: string; version: string; digest: string } | { id: string; kind: 'mcp'; serverRef: string; allowedTools: string[] } | { id: string; kind: 'execution'; resourceId: string; version: string; tools: ('read' | 'write' | 'edit' | 'bash')[] });
export interface CapabilityPackage {
  userPolicyMode?:'inherit'|'allowlist'|'denylist';
  id: string; workspaceId: string; entityId: string; name: string; description?: string; enabled: boolean; version: number;
  mode: 'inherit' | 'restrict'; allowMemberIds: string[]; denyMemberIds: string[]; resourceIds: string[];
  handoffUsageMode?:import('@dentity/contracts').HandoffUsageMode;handoffUsageScope?:import('@dentity/contracts').HandoffUsageScope;
  triggerUsageScope?:import('./features/employees/trigger-types').TriggerScope;
  conversationKinds?: ('private'|'group'|'meeting')[];
}
export interface UsableCapabilities { packages: CapabilityPackage[]; resources: ApprovedResource[] }
