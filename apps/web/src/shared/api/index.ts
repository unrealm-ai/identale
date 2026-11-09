export type Role = 'owner' | 'admin' | 'member';
export interface User { id: string; username: string; displayName: string }
export interface Workspace { id: string; name: string; memberId: string; role: Role }
export interface Entity { avatarPreset?:string|null;
  channelProviders?:string[];webAllowed?:boolean;modelReady?:boolean;canChat?:boolean;reason?:string|null;modelName?:string|null;channels?:number;packages?:number;checkedAt?:number; enabled?: boolean; lifecycleRevision?: number;
  id: string; workspaceId: string; name: string; description: string;
  createdByMemberId: string; ownWebUse: boolean; webUseUserId: string | null;
  interactionRuntime: 'builtin-interaction' | 'local-pi';
  executionThinkingLevel: 'none' | 'low' | 'medium' | 'high';
  executionRuntime: 'local-pi'; readiness: string;
}
export interface Invitation { workspace: { id: string; name: string }; role: Role; expiresAt: number }
export class ApiError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}
export async function api<T>(path: string, signal: AbortSignal, body?: unknown, method?: 'POST' | 'PUT' | 'PATCH' | 'DELETE'): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    credentials: 'same-origin', cache: 'no-store', signal,
    headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data: unknown = response.status === 204 ? {} : await response.json();
  if (!response.ok) {
    const code = typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string' ? data.error : 'request_failed';
    if(response.status===403&&['workspace_forbidden','workspace_member_required'].includes(code)&&typeof window!=='undefined')window.dispatchEvent(new Event('identity:workspace-access-changed'));
    throw new ApiError(code, response.status);
  }
  return data as T;
}
const errors: Record<string, string> = {
  employee_configuration_pending:'员工配置正在同步，请稍后重试打开对话。',
  sharing_rules_changed:'共享规则已被其他操作修改，请刷新后重试。',
  sharing_binding_changed:'渠道应用或对象身份已变更，请重新选择共享来源和目标。',
  invalid_sharing_scope:'请为同一飞书应用明确选择共享群和目标；互通至少需要两个群。',
  sharing_candidates_unavailable:'暂时无法获取共享对象，请检查飞书连接和群列表权限后重试。',
  invalid_sharing_selection:'共享对象凭据已失效，请刷新列表并重新选择。',
  invalid_sharing_rules:'共享规则内容不正确，请检查后重试。',
  invalid_sharing_rule:'请填写规则名称并明确选择来源和目标。',
  human_notification_requires_reconciliation:'请求选择或送达结果仍待核对，请勿重复通知。',
  human_recipient_retry_unavailable:'当前请求不能重新选择确认人，请刷新查看状态。',
  human_request_changed:'人工确认状态已变化，请刷新后重试。',
  human_request_closed:'原任务已结束或进入新执行段，不能重发旧问题。',
  human_rules_changed:'确认设置已被其他操作更新，请刷新后重试。',
  invalid_human_recipient:'确认人或渠道身份已变化，请重新选择。',
  human_recipient_use_forbidden:'确认人须具备此员工的使用权。渠道确认人须能私聊使用；仅群内可使用不满足条件。请核对使用范围后重新保存。',
  human_recipient_permission_unavailable:'暂时无法验证确认人的使用权，本次未保存。请稍后重试。',
  human_recipient_permissions_changed:'确认人的使用权或渠道已变化，本次未保存。请刷新后核对。',
  human_response_required:'此任务等待指定人员的人工答复，请在对应对话中回答。',
  notification_groups_authorization_required:'当前应用无法读取群列表，请检查渠道授权。',
  invalid_notification_target:'通知群信息已失效，请刷新群列表后重新选择。',
  notification_target_stale:'渠道配置已变化，请刷新群列表并重新选择通知群。',
  invalid_group_cursor:'群列表已变化，请刷新后继续选择。',
  wecom_bot_reconfiguration_required:'此连接来自已移除的传统企微配置，请重新填写 BotID 和 Secret 并保存。旧目录授权不会迁移。',
  channel_directory_unsupported:'企微智能机器人仅支持搜索成员，不支持部门或全量通讯录。',
  channel_not_ready:'渠道尚未就绪，请先核对渠道配置。',
  notification_groups_unavailable:'暂时无法读取群列表，请稍后刷新。',
  group_listing_unsupported:'此渠道暂不支持查询群列表。',

  workspace_name_conflict:'工作区名称已被修改，请重新读取后核对。本次输入已保留。',
  historical_conversation_read_only:'这是历史会话，仅供查看。请返回对话列表发起与员工的当前对话。',
  invalid_avatar_preset:'请选择一个内置头像。',
  model_settings_conflict:'模型设置已被其他操作更新。请读取服务器配置核对后再保存，本页草稿保留。',
  invalid_model_settings:'请选择有效模型和思考强度后一起保存。',
  invalid_page_cursor:'分页条件已变化，请重新读取列表。',
  directory_sync_version_conflict:'同步计划已被更新，请读取最新版本后再操作。',
  directory_sync_task_not_found:'同步任务不存在或连接已失效，请刷新列表。',
  invalid_directory_sync_configuration:'同步周期或配置无效，周期须为1分钟至30天。',
  directory_sync_unavailable:'同步管理暂不可用，请刷新状态核对，勿重复提交同步请求。',
  invalid_directory_sync_cursor:'同步记录分页已失效，请重新读取记录。',
  employee_disabled:'员工已停用，不能发起新工作；历史仍按原权限可读。',
  employee_has_pending_work:'员工仍有在途或待发送工作，请先完成或核对后再停用。',
  employee_state_changed:'员工状态已变化，请刷新后重试。',
  capability_version_conflict:'能力包已被更新，请重新读取后操作。',
  channel_creation_draft_required: '渠道草稿缺失、过期或不属于当前账号与工作区，请返回渠道步骤重新验证。',
  channel_unbind_required: '更换渠道应用或机器人前，请先明确解除当前绑定。停用不会释放机器人身份。',
  channel_creation_draft_busy: '当前渠道正在验证或临时草稿容量已满，请稍后重试。',
  channel_directory_unavailable: '当前应用没有可用的通讯录读取权限，请核对厂商授权后重新验证，或跳过渠道连接。',
  channel_member_search_timeout: '企微成员搜索超时，请稍后重试。',
  invalid_member_verification_request: '核验目标或连接来源已变化，请刷新后重新选择。',
  member_verification_request_conflict: '这次核验请求与已有目标不一致，请重新查询状态。',
  member_verification_limit: '身份核验数量已达容量上限，请检查现有待验证人员和绑定记录。',
  member_verification_expired: '验证码已过期，页面将获取新码；旧码不再有效。',
  member_verification_receiver_not_ready: '机器人接收连接尚未就绪，未提供验证码。请确认连接在线后重试。',
  member_verification_unavailable: '身份核验暂不可用，请检查服务配置。',
  invalid_member_search_candidate: '成员选择已过期或来源已变化，请重新搜索并选择。',
  directory_scope_changed: '通讯录可见范围已变化，请重新验证渠道并选择使用者。',
  channel_connection_conflict: '此渠道应用或机器人已被关联，当前创建未保存，请核对已有连接。',
  same_corp_confirmation_required: '请明确确认机器人与通讯录应用属于同一企业。',
  invalid_channel_credentials: '请填写有效的渠道应用标识与密钥。',
  channel_secret_key_unconfigured: '服务器尚未配置渠道密钥加密存储，请联系管理员。',
  task_context_required: '请先选择已授权会话，再查看或操作任务。',
  task_conversation_forbidden: '此任务不属于当前获准会话，请返回对话重新选择。',
  task_not_found: '任务不存在或当前会话无权访问，请重新选择会话。',
  conversation_not_found: '会话不存在或未获授权，请返回对话重新选择。',
  context_unavailable: '所选会话原文已不可用，待办未启动；请核对引用。',
  already_started: '待办已启动，请刷新并核对当前任务状态。',
  model_connection_test_required: '联通测试凭证缺失、过期或配置已变更，请重新测试后保存。',
  model_connection_test_stale: '测试期间共享配置发生变化，请重新读取并测试。',
  model_connection_test_failed: '联通测试未通过。请核对地址、模型、密钥及接口兼容性后重试。',
  model_connection_test_invalid_response: '模型返回格式不符合要求，未保存配置。',
  model_connection_test_in_progress: '此模型配置正在测试，请等待完成，勿重复提交。',
  model_connection_test_capacity: '测试服务繁忙，请稍后重试。',
  model_selection_required: '工作区已有模型配置，请为员工选择共享模型或设置工作区默认模型。',
  invalid_execution_thinking_level: '执行思考强度必须为无、低、中或高。',
  model_thinking_configuration_removed: '模型配置已移除思考选项，请刷新页面并在员工基本信息中设置执行思考强度。',
  model_parameters_incompatible: '模型接口拒绝了请求参数，可能不支持双参数关闭思考；未自动删除参数或重试。请核对接口兼容性。',
  unsupported_thinking_level: '运行时不支持请求的思考强度，未自动降级。',
  execution_thinking_medium_unsupported: '无法确认此模型支持执行中等思考，请核对供应商参数映射。',

  capability_package_forbidden: '所选能力包当前无权使用，请刷新可用包后重新选择。',
  capability_configuration_changed: '能力包或使用授权已发生变化，任务需要按最新配置重新核对。',
  mcp_discovery_failed: 'MCP 连接或工具发现失败，未保存。请检查地址、认证和服务器兼容性。',
  mcp_origin_not_allowed: 'MCP 地址不在部署允许范围内，请检查允许的 Origin；本地测试仅允许明确启用的 loopback。',
  mcp_receipt_invalid: '工具发现结果已失效，请重新连接并确认工具。',
  skill_git_import_failed: 'Git 导入失败，未发布版本。请检查公开仓库、ref、子目录和网络连接。',
  unsafe_skill_path: 'Skill 包包含越界或不安全路径，未导入。',
  skill_link_forbidden: 'Skill 包包含链接或特殊文件，未导入。',
  directory_policy_changed: '渠道使用策略已被更新。你的修改已保留，请读取服务器配置核对后再保存。',
  directory_source_not_found: '渠道来源已解除或发生变更，请刷新渠道连接后重新选择。',
  invalid_workspace_member: '成员已失效或不属于当前工作区，请重新读取成员列表。',
  unknown_approved_resource: '资源不在部署管理员批准的目录中，请重新读取配置。',
  approved_resource_unavailable: '已绑定资源当前不可用，请联系管理员。',

  entity_use_forbidden: '你尚未获得此数字员工的 Web 使用权。管理权不能替代使用授权，请联系管理员。',
  model_profile_unavailable: '模型配置未启用或已发生变更，请在管理页面核对配置及员工模型选择后重试。',
  conversation_expired: '此会话已过保留期限，请新建会话，不会重新引入已过期内容。',
  configuration_changed: '配置已变更，当前回复结果未知。请核对任务后新建会话。',
  interaction_runtime_unsupported: '此交互 Runtime 尚不支持当前 Web 调用，不会自动切换成其他 Runtime。',
  demo_tools_forbidden: '历史演示记录仅供读取，请新建独立会话。',
  historical_demo_read_only: '历史演示记录仅供读取，不能发送消息或操作任务。请新建独立会话。',
  interaction_thinking_off_unsupported: '模型接口无法支持固定的交互关闭思考参数。请核对接口兼容性，不会自动降级。',
  invalid_interaction_thinking: '交互与摘要固定不思考（none），不支持其他档位。',
  invalid_interaction_thinking_control: '旧版思考配置已停用，请刷新页面。',
  model_not_configured: '模型尚未配置，暂不能对话、执行任务或生成摘要。请到资源库添加模型，再到员工设置中选择。',
  runtime_not_configured: '执行服务尚未配置，任务未启动。请联系管理员配置执行服务。',
  runtime_unavailable: '执行 Runtime 暂不可用，不能确认执行结果。请查询任务状态，不要重复提交。',
  version_conflict: '任务已更新，请刷新详情，核对最新状态后再次操作。',
  task_terminal: '任务已结束，不能继续修改或取消。',
  idempotency_conflict: '此创建操作已使用不同内容提交，请核对已有员工后重新开始创建。',
  operation_conflict: '操作标识与内容冲突，请刷新并核对已有记录。',
  CONFLICT: '会话运行状态冲突，本次发送已被拒绝。请保留输入并联系管理员检查会话状态；反复重试不能修复此冲突。',
  TIMEOUT_UNKNOWN: '本次发送结果尚不确定。请先核对已有消息和任务；重试将复用原操作标识。',
  builtin_test_context_reset_required: '旧测试上下文需要备份归档后重置；原历史保留，请联系管理员。',
  conversation_busy: '此会话正在生成回复，请稍后重试。',
  demo_tools_disabled: '历史演示记录不能调用工具或创建任务，请新建独立会话。',
  model_secret_store_unconfigured: '服务器未配置密钥加密存储，暂时不能保存模型密钥。请联系管理员完成初始化。',
  model_endpoint_requires_tls: '模型地址需要 HTTPS；本地 HTTP 仅支持 localhost、127.0.0.1 或 [::1]，且需部署管理员启用本地 HTTP 许可。',
  endpoint_change_requires_credential_replacement: '更换模型地址必须重新输入或清除 API Key，旧密钥不会转发到新地址。',
  endpoint_key_required: '更换模型地址必须重新输入 API Key，旧密钥不会自动转发到新地址。',

  unauthenticated: '登录已失效，请重新登录。',
  username_unavailable: '这个账号名已被使用。',
  common_password: '密码太常见，请选择更安全的长密码。',
  invitation_invalid: '邀请无效、已使用、已撤销或已过期，请向邀请者获取新链接。',
  workspace_forbidden: '你无法访问此工作区，请重新登录以刷新成员信息。',
  role_forbidden: '当前角色没有此管理权限。',
  membership_inactive: '你在目标工作区的成员身份已停用，请联系管理员。',
  invalid_expiry: '邀请有效期必须是 1 至 180 天的整数。',
  invalid_origin: '当前访问地址未获允许，请使用配置的本地开发地址。',
  invalid_credentials: '账号名或密码不正确。', username_taken: '这个账号名已被使用。',
  username_exists: '这个账号名已被使用。', invalid_username: '请使用符合要求的账号名。',
  invalid_password: '密码需至少 6 个字符，请勿使用常见密码。', weak_password: '密码太常见，请选择更安全的长密码。',
  password_too_short: '密码需至少 6 个字符。',
  invalid_invitation: '邀请无效、已使用或已过期，请向邀请者获取新链接。',
  invitation_expired: '邀请已过期，请向邀请者获取新链接。', invitation_used: '邀请已使用。',
  forbidden: '你没有执行此操作的权限。', unauthorized: '登录已失效，请重新登录。',
  rate_limited: '操作过于频繁，请稍后再试。', invalid_input: '请检查输入内容。', invalid_task_title: '任务标题最多60个可见字符，请缩短标题并将完整要求放在任务说明中。',
  not_found: '目标不存在或你无法访问。', origin_not_allowed: '当前访问地址未获允许，请使用配置的本地开发地址。',
};
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return errors[error.code] ?? `操作未完成（${error.code}）。请检查输入或稍后重试。`;
  return '无法连接服务或响应格式异常，请确认平台服务已启动后重试。';
}
