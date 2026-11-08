import { directorySetupGuides } from '../directory/directory-setup-guide';
/** Curated local help content. No credentials, remote HTML or executable commands. */
export interface GuideFigure { src: string; alt: string; caption: string; source?: { title: string; url: string } }
export interface GuideStep { id: string; title: string; location: string; paragraphs: string[]; notes?: string[]; figures?: GuideFigure[] }
export interface GuideSource { title: string; url: string }
export interface SetupGuide {
  id: 'feishu' | 'dingtalk' | 'wecom'; title: string; summary: string; consoleUrl: string;
  currentLimitations: string[];
  capabilities: { title: string; detail: string }[];
  steps: GuideStep[]; sources: GuideSource[];
}
const dingtalkTutorial = 'https://open-dingtalk.github.io/developerpedia/docs/explore/tutorials/stream/bot/nodejs/create-bot/';
export const setupGuides: readonly SetupGuide[] = [
  {
    id: 'feishu', title: '飞书', consoleUrl: 'https://open.feishu.cn/app',
    summary: '选择企业自建应用，并添加机器人能力。普通群消息和会后材料均需要单独确认授权，不能由“机器人已入群”推定可读取。',
    currentLimitations: ['已提供员工渠道配置、WebSocket 私聊/群文本入站与 RT 消息处理路径；非文本及话题历史暂不处理，真实租户尚未联调。', '会后仅按明确授权的飞书妙记材料 ID 读取导出逐字稿及摘要，不会自动发现会议或 Note 文档。', '飞书仅使用 WebSocket 长连接入站，由服务器维持连接，不依赖本页常开，不需要平台公网域名。', '应用凭据、长连接状态、使用授权及 RT 就绪分别检查；厂商开放权限或身份 API 成功不等于真实收发已验证。'],
    capabilities: [
      { title: '群聊 @ 与回复', detail: '应用机器人 + 消息事件 + 发送权限；还需长连接在线、员工使用授权及交互 Runtime 配置。' },
      { title: '普通群消息与历史', detail: '额外权限及目标群可见范围决定是否可用；收到消息不代表自动发言。' },
      { title: '会后逐字稿与纪要', detail: '妙记与智能纪要是不同来源，材料需要已生成且当前连接有访问权。' },
    ],
    steps: [
      { id: 'create', title: '创建应用并启用机器人', location: '飞书开放平台 → 开发者后台', paragraphs: [
        '使用有权限的企业账号登录，确认当前企业，创建“企业自建应用”，填写员工对应的应用名称、描述和图标。不要选择只向群里推送通知的自定义 Webhook 机器人。',
        '进入应用，在“添加应用能力”中添加“机器人”。菜单名称可能随控制台版本调整，按应用能力入口查找。',
      ], figures: [{ src: '/channel-guides/feishu-setup-path.svg', alt: '飞书配置路径示意：创建企业自建应用、添加机器人、配置权限和事件、审核发布、加入指定群并联调。', caption: 'identity 原创配置路径示意，非飞书控制台截图。具体菜单以当前租户控制台为准。' }] },
      { id: 'permissions', title: '按需申请权限和订阅事件', location: '应用 → 权限管理 / 事件与回调', paragraphs: [
        '基础群交互需要“以应用身份发消息”（im:message:send_as_bot）和“接收群聊中 @机器人消息”（im:message.group_at_msg:readonly）。需要私聊时再申请“获取用户发给机器人的单聊消息”（im:message.p2p_msg:readonly）。',
        '准备订阅“接收消息”事件 im.message.receive_v1，按下一步先建立长连接，再保存订阅方式并添加事件。仅增加发送权限不会让平台收到消息；仅订阅事件也不会自动取得消息读取权限。',
        '若希望接收非 @群消息或查询群历史，另行确认“获取群组中所有消息”等相应权限（当前群消息权限涉及 im:message.group_msg），并由管理员批准。只开放需要接入的群和使用范围。',
      ], notes: ['不要一次申请全部权限。权限名称和开放范围以当前应用控制台为准；外部群、跨企业场景可能存在额外限制。'] },
      { id: 'credentials', title: '准备凭据与部署端接线', location: '应用 → 凭证与基础信息 / 事件与回调', paragraphs: [
        '在员工设置的渠道连接表单仅填写 App ID 和 App Secret。密钥只写入不回显，提交后清空。不要将密钥填进员工人设、聊天消息或 Git 仓库。',
        '先保存员工连接，让平台服务器建立长连接；确认本页长连接状态为已连接后，在飞书控制台“事件与回调”选择“使用长连接接收事件”并保存，再添加接收消息事件 im.message.receive_v1。控制台保存时需检测到在线客户端，因此不要先停用连接。身份 API 成功仍不代表实际收发通过。',
      ], notes: ['连接由官方 SDK 使用应用凭据认证，无 HTTP 入站兜底；服务器需可出站访问官方 HTTPS/WSS 服务。连接上线不等于使用授权已齐全。'] },
      { id: 'publish', title: '发布版本并加入目标群', location: '应用 → 版本管理与发布；飞书客户端 → 群设置', paragraphs: [
        '配置应用可用范围，创建版本并申请企业管理员审核。变更权限或事件后检查是否需要重新发布；后台保存不等于权限已经对当前版本生效。',
        '发布并启用后，在目标群的群机器人入口搜索并添加应用机器人。搜不到时先检查应用状态、可用范围和当前企业，不要反复创建多个机器人。',
      ] },
      { id: 'meetings', title: '为会后材料单独准备访问权', location: '飞书会议 / 妙记 / 智能纪要', paragraphs: [
        '先确认会议实际生成了逐字稿或纪要，并保留会议、妙记或纪要的真实链接。没有录制或转写生成的内容，不能在会后凭空补回。',
        '妙记逐字稿可按来源提供说话人和时间信息；智能纪要可能关联独立文档或另一种逐字稿入口。读取需要对应材料的访问、导出权限，机器人入群权限不能代替。',
        '不同入口支持的授权身份不同。遇到仅允许用户身份读取的材料，应单独配置明确授权的用户连接，不能让 adapter 悄悄从机器人身份切换成个人身份。',
      ], notes: ['一场会议可能有多段材料；“会议结束”不等于所有材料生成完成。说话人标签并不自动等于可用于执行任务的可信身份。'] },
    ],
    sources: [
      { title: '飞书配置长连接事件订阅', url: 'https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case' },
      { title: '飞书企业自建应用开发流程', url: 'https://open.feishu.cn/document/home/introduction-to-custom-app-development/self-built-application-development-process' },
      { title: '飞书接收消息事件', url: 'https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/events/receive' },
      { title: '飞书官方 CLI：群历史与权限', url: 'https://github.com/larksuite/cli/blob/main/shortcuts/im/im_chat_messages_list.go' },
      { title: '飞书官方 CLI：会后材料与身份边界', url: 'https://github.com/larksuite/cli/blob/main/skills/lark-meeting/scenes/query-note-and-artifacts.md' },
      { title: '飞书官方 CLI：妙记详情', url: 'https://github.com/larksuite/cli/blob/main/skills/lark-meeting/references/lark-minutes-detail.md' },
    ],
  },
  {
    id: 'dingtalk', title: '钉钉', consoleUrl: 'https://open.dingtalk.com',
    summary: '创建应用内机器人，而非群自定义 Webhook。机器人负责收发；更广的群历史、听记材料可需要独立的用户授权连接。',
    currentLimitations: ['已提供员工渠道配置、Stream 私聊/群 @文本入站及消息处理路径；仅同企业且校验通过的 staffId 可作为可信使用者。', 'Stream 使用应用凭据认证，在线不等于真实机器人身份已确认；出站受理不等于已送达。', '仅使用 Stream 入站，由服务器维持连接，无 HTTP 入站兜底，不需要平台公网域名。需要完成机器人身份确认、使用授权与 Runtime 配置后再测试收发。', '员工渠道当前使用 App Token，不接入 DWS 用户授权历史/会议能力。独立 DWS adapter 不等于本页可配置；没有自动 OAuth 或普通群消息常驻监听，真实租户尚未联调。'],
    capabilities: [
      { title: '群聊 @ 与回复', detail: '普通应用机器人的群消息接收范围是 @消息。切换成 Stream 不会扩大数据权限。' },
      { title: '普通群消息与历史', detail: '不属于普通机器人默认能力；DWS 用户授权能力应作为独立连接，不与机器人权限混用。' },
      { title: '会后逐字稿与纪要', detail: '先有云录制 / 听记产物，再检查读取权限；DWS 连接固定到获授权的组织和用户。' },
    ],
    steps: [
      { id: 'create', title: '创建企业内部应用', location: '钉钉开放平台 → 应用开发', paragraphs: [
        '选择当前组织，进入企业内部应用的“钉钉应用”，创建应用并填写名称、描述和图标。应先创建应用，再启用应用内机器人，不使用历史遗留的并列“机器人”入口。',
      ], figures: [{ src: '/channel-guides/dingtalk-create-app.jpg', alt: '钉钉官方教程截图：应用开发中选择钉钉应用，点击创建应用，填写应用名称和描述。', caption: '钉钉官方教程示例截图。图片展示历史控制台版本，当前菜单位置可能调整。', source: { title: '钉钉开发者百科 · 创建机器人应用', url: dingtalkTutorial } }] },
      { id: 'robot', title: '启用应用内机器人', location: '应用详情 → 应用功能 → 机器人与消息推送', paragraphs: [
        '开启机器人配置，填写名称、简介等字段，并按控制台要求保存或发布。确认配置的是应用内机器人，不是仅提供群 Webhook 的自定义机器人。',
      ], figures: [{ src: '/channel-guides/dingtalk-enable-bot.jpg', alt: '钉钉官方教程截图：应用功能中的机器人与消息推送页面，开启机器人配置开关。', caption: '钉钉官方教程示例截图。此截图展示启用入口，不表示 identity 已连接。', source: { title: '钉钉开发者百科 · 创建机器人应用', url: dingtalkTutorial } }] },
      { id: 'credentials', title: '确认凭据和消息接收方式', location: '应用详情 → 应用信息 / 机器人配置', paragraphs: [
        '在应用信息中获取 Client ID（AppKey）和 Client Secret（AppSecret），到员工渠道连接表单保存。密钥只写入不回显。首条通过校验的消息会确认机器人与企业身份。',
        '在“机器人与消息推送”中开启机器人配置，消息接收模式选择 Stream，按控制台要求发布。下方本地图片保留官方教程出处，界面以当前控制台为准。',
        '保存员工连接后等待服务器 Stream 在线；向目标机器人发送普通私聊或群 @ 消息，首条通过校验的消息会自动确认机器人身份。无需保持页面打开，也不填写入站 URL。',
      ], notes: ['普通机器人只收到群内 @消息。Stream 是传输方式，不是全群监听权限。临时 SessionWebhook 会过期，长期任务回报不能只依赖它。'] },
      { id: 'publish', title: '检查权限、发布和可用范围', location: '应用 → 权限管理 / 版本发布；钉钉客户端 → 目标群', paragraphs: [
        '仅申请当前用途需要的机器人发送和相关读取权限；管理员审批与发布流程以企业控制台要求为准。设置可用范围后，将应用机器人添加到明确选择的群。',
        '主动发送采用机器人 OpenAPI 与目标会话标识。收消息的 Stream 连接本身不能替代发送 API；部署维护者还需验证出站身份及群范围。',
      ] },
      { id: 'meetings', title: '为历史和会后材料配置独立授权', location: '钉钉 Workspace CLI / 会议云录制 / AI 听记', paragraphs: [
        '本期员工渠道不提供 DWS 用户授权配置，不支持群历史或听记读取。独立 DWS adapter 仍需单独的明确用户授权和部署集成；此处仅解释能力边界，不引导安装 CLI 或自动授权。',
        '确认会议已有云录制转写或 AI 听记材料，保留真实材料链接或 ID。逐字稿、AI 摘要可分别生成；分页未读完或部分失败时，不能当作完整材料导入。',
        '机器人凭据与 DWS 用户授权凭据是两套身份。将来源范围限定为批准的群与会议，不能默认共享个人私聊或所有会议。当前没有自动 OAuth 安装或全部群监听页面。',
      ], notes: ['材料生成完成后仍可能没有可识别的实名说话人；保留原始标签，不猜测姓名。缺少官方摘要时要明确说明，不把平台生成内容冒充官方纪要。'] },
    ],
    sources: [
      { title: '钉钉官方 Stream 教程：创建应用与接收模式', url: dingtalkTutorial },
      { title: '钉钉应用机器人接收消息', url: 'https://open-dingtalk.github.io/developerpedia/docs/learn/bot/appbot/receive/' },
      { title: '钉钉机器人回复与主动发送', url: 'https://open-dingtalk.github.io/developerpedia/docs/learn/bot/appbot/reply/' },
      { title: '钉钉官方 DWS CLI', url: 'https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli' },
      { title: 'DWS 群历史读取与完整性', url: 'https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/main/skills/multi/dingtalk-chat/references/chat/message-query.md' },
      { title: 'DWS 会后听记材料', url: 'https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/main/skills/multi/dingtalk-minutes/SKILL.md' },
    ],
  },
  {
    id: 'wecom', title: '企业微信', consoleUrl: 'https://work.weixin.qq.com/',
    summary: '仅填写独立智能机器人的 BotID 和 Secret，保存后等待连接与首条真实消息。',
    currentLimitations: ['智能机器人使用官方 SDK 主动 WebSocket，同一连接收发，无 HTTP 回调 URL。', '首条通过校验的真实消息自动确认机器人，无需人工验证。', '当前不支持群历史、话题历史或会议材料；本地验证不代表企业租户真实收发已通过。'],
    capabilities: [
      { title: '智能机器人消息', detail: '每员工独立 BotID / Secret；传输在线、身份验证与使用授权分别检查。' },
      { title: '成员搜索与使用范围', detail: '新建默认空白名单、群内可用；可搜索成员设置白名单或黑名单。' },
      { title: '群历史与会议材料', detail: '当前不支持，不提供相应开关。' },
    ],
    steps: directorySetupGuides.wecom.steps,
    sources: [{ title: '企业微信官方智能机器人 Node SDK', url: 'https://github.com/WecomTeam/aibot-node-sdk' }, { title: '企业微信应用与可见范围', url: 'https://developer.work.weixin.qq.com/document/path/90227' }],
  },
];
export const setupChecks = [
  '保存渠道凭据前，部署管理员须按 DEVELOPMENT.md 使用现有 local:init 初始化主密钥，或提供 DENTITY_MODEL_MASTER_KEY；不需要模型供应商 API key 才能绑定渠道。主密钥未配置时不能保存，不能关闭加密。',
  '确认外部企业、应用、机器人和目标群一致，连接授权人不冒充群消息发送者。',
  '由获授权测试人员在测试群 @机器人，检查消息身份与固定回复目标；不要在真实业务群制造测试消息。',
  '只有声明并实际获准接收普通群消息的连接，才验证非 @消息；监听能力不等于每条都要回答。',
  '拉取已批准的历史范围，检查分页与话题回复覆盖；补拉旧消息不重复触发旧任务。',
  '使用获准测试会议材料核对逐字稿说话人、缺失段、全部分页与摘要来源；生成中不伪装成功。',
  '撤销授权后确认读取和发送停止；重启和重放不重复执行业务任务。',
] as const;
