// Modified for Identale; see the root NOTICE.
import type { DirectoryProvider } from '../directory/types';
import { type GuideFigure } from '../channels/setup-guides';

interface Step { id: string; title: string; location: string; paragraphs: string[]; figures?: GuideFigure[]; action?: { title: string; url: string }; compatibility?: { title: string; paragraphs: string[] }[] }
interface WizardChannelGuide { title: string; consoleUrl: string; steps: Step[] }
const diagram = (name: string, alt: string): GuideFigure => ({ src: `/channel-guides/${name}.svg`, alt, caption: 'identity 操作示意；以当前管理后台为准。' });
const consoles = { feishu: 'https://open.feishu.cn/app', dingtalk: 'https://open-dev.dingtalk.com/', wecom: 'https://work.weixin.qq.com/wework_admin/frame' };
/** Documentation provenance stays in spec/27; cards contain only actionable console entries. */
export const wizardChannelGuides: Record<DirectoryProvider, WizardChannelGuide> = {
  feishu: { title: '飞书', consoleUrl: consoles.feishu, steps: [
    { id: 'credentials', title: '机器人连接凭据', location: '飞书智能体应用创建入口 / 应用后台 → 凭证与基础信息', paragraphs: [
      '使用有效的飞书官方智能体创建入口，创建独立应用后复制 App ID 和 App Secret。每位数字员工使用独立机器人。App ID 标识应用，机器人 open_id 是另一个标识，由官方 API 自动读取，无需手填。',
      '官方智能体模板已配置基础机器人和长连接。当前平台不生成短期创建链接；没有有效入口时，可在应用后台创建普通自建应用。',
    ], action: { title: '打开飞书应用后台', url: consoles.feishu }, figures: [{ src: '/channel-guides/feishu-setup-path.svg', alt: '飞书配置路径示意：创建自建应用、添加机器人、配置权限和事件、发布后验证。', caption: 'Identale 原创配置路径示意，非官方控制台截图；具体操作以当前应用后台为准。' }], compatibility: [
      { title: '普通自建应用', paragraphs: ['添加机器人能力，配置私聊和群 @消息、以机器人身份发送消息以及 im.message.receive_v1 事件。最终保存、长连接在线后选择“使用长连接接收事件”，按后台提示发布审批。'] },
    ] },
    { id: 'validate', title: '补权限、发布并验证', location: '权限管理 / 通讯录数据范围 → 版本发布 → 回到本卡验证', paragraphs: [
      '必需：可信机器人 open_id、通讯录范围、成员姓名，以及所选部门的基本信息。按对应读取接口开放所需权限并限定可见人员/部门，发布审批后验证。',
      '官方 API 同时取得机器人 open_id 和租户 tenant_key 时，身份直接验证通过。仅缺 tenant_key 时，最终创建并连接在线后，普通真人私聊或真实群 @ 消息会自动确认租户，并继续按现有使用范围处理同一条消息；首发者不会自动获得使用权。缺少可信 open_id 时仍阻断，先启用机器人能力再验证。',
      '可选：普通群历史涉及 im:message.group_msg；妙记材料涉及 minutes:minutes.transcript:export、minutes:minutes.artifacts:read 和具体材料访问权。未验证或缺失时会警告，基础接入仍可继续。',
    ], action: { title: '打开权限与发布后台', url: consoles.feishu }, figures: [diagram('feishu-permissions', '飞书权限示意：必要目录字段、群历史及会议材料分别配置。')] },
  ] },
  dingtalk: { title: '钉钉', consoleUrl: consoles.dingtalk, steps: [
    { id: 'credentials', title: '机器人连接凭据', location: '钉钉应用列表 → 一键自动创建 OpenClaw 机器人应用', paragraphs: [
      '在有开发者权限的组织中创建独立机器人，复制 Client ID（AppKey）和 Client Secret（AppSecret）。平台使用 Stream，不安装 CLI 或接管 OpenClaw。',
      '若后台没有一键入口，可创建企业内部应用并添加机器人能力，核对消息接收和事件订阅均使用 Stream。',
    ], action: { title: '打开钉钉开发者后台', url: consoles.dingtalk }, figures: [diagram('dingtalk-agent-create', '钉钉智能体应用创建示意：选择组织、一键创建独立机器人并回填凭据。')] },
    { id: 'validate', title: '补权限、发布并验证', location: '权限管理 / 通讯录范围 → 版本管理与发布', paragraphs: [
      '必需：当前应用可见范围内的部门、成员和姓名读取。按后台接口要求授权所需范围，并核对版本发布、审批和应用可用范围。',
      '当前员工 App Token 连接不支持普通群历史和会后材料，无需为这些能力申请额外权限。不能从 Stream 在线推断已经发布。',
    ], action: { title: '打开权限与发布后台', url: consoles.dingtalk }, figures: [diagram('credentials-to-draft', '应用凭据先在临时草稿验证，最后确认创建才保存。')] },
  ] },
  wecom: { title: '企业微信', consoleUrl: consoles.wecom, steps: [
    { id: 'credentials', title: '机器人连接凭据', location: '企业微信 → 智能机器人 → API / 长连接配置', paragraphs: [
      '为本员工创建独立智能机器人，复制 BotID 和 Secret。使用官方 WebSocket 长连接，无需公网回调或群 Webhook。',
      '创建后可在渠道使用范围中用机器人凭据搜索成员，配置允许或排除名单。',
    ], action: { title: '打开企业微信管理后台', url: consoles.wecom } },
    { id: 'validate', title: '检查机器人配置', location: '检查临时草稿 → 确认创建后启动长连接', paragraphs: [
      '新建数字员工首次接入默认全员 + 空黑名单，群内可用；换绑重置为空白名单。连接在线后，首条通过校验的真实消息会自动确认机器人身份。',
      '当前不支持群历史或会议材料。',
    ], figures: [diagram('credentials-to-draft', '机器人凭据先进入临时草稿，最后确认创建才保存。')] },
  ] },
};
