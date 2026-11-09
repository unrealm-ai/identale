// Modified for Identale; see the root NOTICE.
import type { ChannelValidation } from './validation.js';

export interface FeishuPermissionGroup {
  id: string; label: string; required: boolean; identity: 'tenant' | 'user'; scopes: string[]; note?: string; scopeNotes?: Record<string, string>;
}
export interface FeishuRegistrationProfile {
  version: string; scopes: string[]; userScopes: string[]; events: string[]; groups: FeishuPermissionGroup[];
}
/** Preserve the exact already-confirmed v1 request for old saved registrations. */
export const LEGACY_FEISHU_REGISTRATION_PERMISSIONS = {
  version: 'conversation-directory-v1',
  scopes: [
    'tenant:tenant:readonly', 'contact:contact.base:readonly', 'contact:user.base:readonly',
    'contact:user.employee:readonly', 'contact:user.department:readonly',
    'contact:department.base:readonly', 'contact:department.organize:readonly',
    'contact:user.employee_id:readonly',
    'im:message.p2p_msg:readonly', 'im:message.group_at_msg:readonly', 'im:message:send_as_bot',
    'im:message:readonly', 'im:message.group_msg', 'im:chat:readonly',
  ],
  events: ['im.message.receive_v1', 'im.chat.member.bot.added_v1',
    'im.chat.member.bot.deleted_v1', 'im.chat.disbanded_v1'],
};
export const LEGACY_FEISHU_REGISTRATION_PROFILE: FeishuRegistrationProfile = {
  ...LEGACY_FEISHU_REGISTRATION_PERMISSIONS, userScopes: [],
  groups: [{ id: 'conversation-directory', label: '基础聊天与通讯录', required: true, identity: 'tenant',
    scopes: [...LEGACY_FEISHU_REGISTRATION_PERMISSIONS.scopes] }],
};
/** Confirmed initial application-permission requests. Permission approval is not
 * resource ACL, individual OAuth, or approval to perform a business operation.
 * Keep the exact user-named scopes, even when a broader requested scope overlaps. */
const extensionGroups: FeishuPermissionGroup[] = [
  {
    id: 'messages-groups', label: '消息、附件与群', required: false, identity: 'tenant',
    scopes: ['im:resource', 'im:chat:read', 'im:chat.access_event.bot_p2p_chat:read',
      'im:chat.announcement:read', 'im:chat.members:read',
      'im:message.group_at_msg.include_bot:readonly', 'im:message.group_msg.include_bot:read',
      'im:message.pins:read', 'im:message.reactions:read'],
    note: '附件收发已有实现；群公告、Pin、表情及其他机器人消息等权限预先申请，相关工具未全部接入。现有流程仍不会把其他机器人的消息当用户任务。',
  },
  {
    id: 'organization', label: '组织、部门与成员关系', required: false, identity: 'tenant',
    scopes: ['contact:user.basic_profile:readonly', 'contact:user.dotted_line_leader_info.read',
      'directory:department:search', 'directory:department:list', 'directory:department:read',
      'directory:department.base:read', 'directory:department.department_path:read',
      'directory:department.has_child:read', 'directory:department.name:read',
      'directory:department.organization:read', 'directory:department.parent_id:read',
      'directory:employee:list', 'directory:employee:read', 'directory:employee:search',
      'directory:employee.base.base:read', 'directory:employee.base.department:read',
      'directory:employee.base.department_path:read', 'directory:employee.base.leader:read'],
    note: '保留用户列出的字段权限。当前通讯录走 Contact v3；Directory 搜索与新接口尚未接入，开通权限不等于全公司资料可见。',
  },
  {
    id: 'documents', label: '文档与评论读写', required: false, identity: 'tenant',
    scopes: ['docx:document:readonly', 'docx:document:create', 'docx:document:write_only',
      'docs:document.comment:read', 'docs:document.comment:create',
      'docs:document.comment:update', 'docs:document.comment:delete'],
    note: '已实现指定 Docx 正文读取；创建、修改、评论与删除评论权限先申请，相关写入工具待接入。仍需具体文档的访问或编辑权限。',
  },
  {
    id: 'base', label: '多维表格读写', required: false, identity: 'tenant',
    scopes: ['base:app:read', 'base:app:create', 'base:app:update', 'base:app:copy',
      'base:table:read', 'base:table:create', 'base:table:update', 'base:table:delete',
      'base:field:read', 'base:field:create', 'base:field:update', 'base:field:delete',
      'base:record:retrieve', 'base:record:create', 'base:record:update', 'base:record:delete',
      'base:view:read', 'base:view:write_only'],
    note: '业务工具待接入；包含表、字段和记录删除权限。记录查询按 v1 records/search 的 retrieve 预申请，不把它当作 v3 read。仍受表格及行列访问范围限制。',
  },
  {
    id: 'calendar', label: '日程读写与邀请', required: false, identity: 'tenant',
    scopes: ['calendar:calendar:read', 'calendar:calendar.event:read',
      'calendar:calendar.event:create', 'calendar:calendar.event:update',
      'calendar:calendar.event:delete', 'calendar:calendar.event:reply',
      'calendar:calendar.free_busy:read'],
    note: '业务工具待接入；包含取消日程和回复邀请权限。应用仍需相应日历访问权；个人身份操作需要另外完成个人 OAuth。',
  },
  {
    id: 'tasks', label: '待办、清单与评论读写', required: false, identity: 'tenant',
    scopes: ['task:task:write', 'task:tasklist:write', 'task:comment:write'],
    note: '业务工具待接入；这三项 write 是包括读取、创建、修改、删除的宽权限。不能据此访问任意个人任务。',
  },
  {
    id: 'meetings-minutes', label: '会议纪要与妙记读取', required: false, identity: 'tenant',
    scopes: ['vc:meeting.search:read', 'vc:meeting.meetingevent:read', 'vc:note:read',
      'vc:record:readonly', 'vc:meeting.artifact.note:read', 'vc:meeting.artifact.verbatim:read',
      'minutes:minutes.search:read', 'minutes:minutes.basic:read',
      'minutes:minutes.artifacts:read', 'minutes:minutes.transcript:export'],
    note: '已接入指定会议及妙记资料读取，搜索工具待接入。应用身份的会议录制权限可能涉及企业范围；仍核验具体资料可见性和产物状态。',
    scopeNotes: {
      'vc:meeting.search:read': '当前官方 CLI 声明支持；未在本租户控制台验证可申请状态。',
      'vc:note:read': '当前官方 CLI 声明支持；独立官方接口文档证据未补齐，须以实际权限清单核验。',
      'minutes:minutes.search:read': '当前官方 CLI 声明支持；未在本租户控制台验证可申请状态。',
      'minutes:minutes.artifacts:read': '当前官方 CLI 声明支持；独立官方接口文档证据未补齐，须以实际权限清单核验。',
    },
  },
  {
    id: 'approvals', label: '审批读写（高影响）', required: false, identity: 'tenant',
    scopes: ['approval:approval.list:readonly', 'approval:instance', 'approval:task', 'approval:instance.comment'],
    note: '传统审批应用权限可能覆盖整个企业的审批数据，也包括同意、拒绝等审批决定。这里只预申请，业务工具尚未实现；实际使用仍需核验具体审批单、操作者和动作授权。不能把应用权限视为个人 OAuth。',
  },
];
const groups = [...structuredClone(LEGACY_FEISHU_REGISTRATION_PROFILE.groups), ...extensionGroups];
export const FEISHU_REGISTRATION_PERMISSIONS: FeishuRegistrationProfile = {
  version: 'conversation-business-v2',
  scopes: [...new Set(groups.filter(group => group.identity === 'tenant').flatMap(group => group.scopes))],
  userScopes: [...new Set(groups.filter(group => group.identity === 'user').flatMap(group => group.scopes))],
  events: [...LEGACY_FEISHU_REGISTRATION_PERMISSIONS.events], groups,
};

type ScopeStatus = 'granted' | 'missing' | 'unknown';
export function registrationPermissionGroups(profile: FeishuRegistrationProfile, report?: ChannelValidation) {
  const inventory = report?.checks.find(check => check.id === 'scope_inventory')?.scopeInventory ?? [];
  return profile.groups.map(group => {
    const scopeStates = group.scopes.map(scope => {
      const rows = inventory.filter(row => row.scope === scope && row.identity === group.identity);
      const status: ScopeStatus = !rows.length || rows.some(row => row.status === 'unverified') ? 'unknown'
        : rows.every(row => row.status === 'granted') ? 'granted' : 'missing';
      return { scope, status };
    });
    const status: ScopeStatus = scopeStates.length && scopeStates.every(row => row.status === 'granted') ? 'granted'
      : scopeStates.some(row => row.status === 'missing') ? 'missing' : 'unknown';
    return { ...group, status, scopeStates, missingScopes: scopeStates.filter(row => row.status !== 'granted').map(row => row.scope) };
  });
}
export function missingRegistrationPermissions(profile: FeishuRegistrationProfile, report?: ChannelValidation): string[] {
  return [...new Set(registrationPermissionGroups(profile, report).filter(group => group.required)
    .flatMap(group => group.identity === 'tenant' ? group.missingScopes : group.scopes))];
}
