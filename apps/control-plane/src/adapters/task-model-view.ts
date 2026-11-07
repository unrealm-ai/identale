import type { TaskService } from '@dentity/application';
import type { TaskActionAvailability, TaskActionReason } from '@dentity/contracts';

type Task = ReturnType<TaskService['dto']>;
type Updates = ReturnType<TaskService['getUpdates']>;
const reasons: Record<TaskActionReason, string> = {
  permission_denied: '没有操作权限', task_not_started: '任务尚未启动', task_terminal: '任务已结束',
  cancel_already_requested: '已申请取消', run_terminal: '执行已结束', runtime_not_bound: '尚未开始执行',
  runtime_state_unknown: '执行状态尚未确认', runtime_capability_unknown: '尚未确认支持此操作',
  runtime_action_unsupported: '当前不支持此操作', runtime_not_configured: '暂时无法执行',
  platform_action_unsupported: '当前不支持此操作',
};
const action = (value: TaskActionAvailability) => ({ available: value.available, ...(value.reason ? { reason: reasons[value.reason] } : {}) });

/** Explicit allowlist for model input. Internal DTOs and operation caches retain their full facts. */
export function taskModelView(task: Task, updates?: Updates) {
  const a = task.availableActions, receipt = task.actionReceipt;
  return {
    id: task.id, title: task.title, input: task.input, status: task.status, version: task.version, inputRevision: task.inputRevision,
    createdAt: task.createdAt, updatedAt: task.updatedAt,
    availableActions: {
      query: action(a.query), start: action(a.start),
      supplement: { ...action(a.supplement), effect: a.supplement.application === 'on_start' ? 'on_start' : a.supplement.mode === 'platform_record_only' ? 'recorded_only' : 'pending' },
      cancel: action(a.cancel),
      pause: action(a.pause), resume: action(a.resume),
    },
    ...(receipt ? { actionReceipt: { action: receipt.action, status: receipt.status, effectStatus: receipt.runtimeStatus,
      ...(receipt.inputRevision !== undefined ? { inputRevision: receipt.inputRevision } : {}) } } : {}),
    ...(task.run ? { executionStatus: task.run.status, result: task.run.result, resultInputRevision: task.run.resultInputRevision } : {}),
    ...(updates ? {
      // Token deltas remain in durable records; task queries expose semantic updates only.
      updates: updates.updates.filter(({type}) => type !== 'output_delta').map(({type, status, text, inputRevision, inputStatus}) => ({ type,
        ...(status !== undefined ? {status} : {}), ...(text !== undefined ? {text} : {}),
        ...(inputRevision !== undefined ? {inputRevision} : {}), ...(inputStatus !== undefined ? {inputStatus} : {}),
      })),
      inputs: updates.inputs.map(({revision, status}) => ({revision, status})),
      deliveries: updates.deliveries.map(({text, status, createdAt}) => ({text, status, createdAt})),
    } : {}),
  };
}
