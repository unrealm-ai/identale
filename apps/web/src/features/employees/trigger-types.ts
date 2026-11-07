export type TriggerPolicy='isolated'|'employee_shared'|'business_key';
export type TriggerScope={mode:'all'|'allowlist';selectionMode?:'all'|'allowlist'|'denylist';allowTriggerIds:string[];denyTriggerIds:string[]};
export type TriggerOption={id:string;name:string;enabled:boolean};
export type TriggerDraft={draftId:string;name:string;type:'webhook'|'schedule';enabled:boolean;allowedActions:string[];config:Record<string,unknown>;credential?:{keyId:string;secret:string}};
export type TriggerRow=Omit<TriggerDraft,'draftId'|'credential'>&{id:string;version:number;nextScheduledAt:number|null;credentials:{key_id:string;status:string;credential_version:number}[]};
export const triggerPolicyLabel=(p:TriggerPolicy)=>({isolated:'独立处理：不参考其他任务',employee_shared:'员工内共享：参考其他自动化任务',business_key:'按业务分组：只参考同组任务'})[p];
export const triggerScopeLabel=(s:TriggerScope|undefined,options:TriggerOption[]=[])=>{const names=(ids:string[])=>ids.map(id=>options.find(o=>o.id===id)?.name??id).join('、');const mode=s?.selectionMode??s?.mode;return(!s||mode==='all'||mode==='denylist'?'当前员工全部自动化任务':s.allowTriggerIds.length?'仅 '+names(s.allowTriggerIds):'允许名单为空（无自动化任务可用）')+(s?.denyTriggerIds.length&&(!s.selectionMode||mode==='denylist')?'；排除 '+names(s.denyTriggerIds):'');};

export const triggerTypeLabel = (type: string, config: Record<string, unknown>) => type === 'schedule' ? '按时间执行' : config.adapter === 'github_issue' ? 'GitHub 新建 Issue 时执行' : '收到外部系统请求时执行（Webhook）';
export const triggerActionLabel = (action: unknown) => ({ create_task: '创建任务', supplement_task: '补充任务', cancel_task: '取消任务' }[String(action)] ?? '未知操作');
export const triggerStatusLabel = (status: unknown) => ({ accepted: '已受理', failed: '失败', queued: '排队中', running: '执行中', succeeded: '已完成', canceled: '已取消', cancel_requested: '取消处理中', waiting_input: '等待补充', waiting_approval: '等待审批', unknown: '待核对', pending: '等待处理', dispatched: '已派发', active: '有效', revoked: '已撤销' }[String(status)] ?? '暂无状态');

export const triggerPolicyDescription = (policy: TriggerPolicy) => ({
  isolated: '每个新任务单独处理，不参考其他自动化任务的执行历史。',
  employee_shared: '本员工不同自动化任务入口可以互相参考历史，例如“客户日报”参考“客户周报”的执行记录。仅包含创建时归入“员工内共享”的任务。',
  business_key: '只参考本员工业务标识相同的任务，可来自不同自动化任务入口。例如标识都是“客户日报”时共享历史；不同标识分开，未填写标识的任务各自独立。',
})[policy];
