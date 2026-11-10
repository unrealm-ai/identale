import type { DirectoryProvider } from './types';

interface GuideSource { title: string; url: string }
interface GuideFigure { src: string; alt: string; caption: string; source?: GuideSource }
interface DirectoryGuideStep {
  id: string; title: string; location: string; paragraphs: string[];
  notes?: string[]; sources?: GuideSource[]; figures?: GuideFigure[];
}
interface DirectorySetupGuide {
  title: string; consoleUrl: string; identityNote: string; steps: DirectoryGuideStep[];
}

const feishuSources = {
  create: { title: '飞书：企业自建应用开发流程', url: 'https://open.feishu.cn/document/home/introduction-to-custom-app-development/self-built-application-development-process' },
  token: { title: '飞书：获取 tenant_access_token', url: 'https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/tenant_access_token' },
  scope: { title: '飞书：获取通讯录权限范围', url: 'https://open.feishu.cn/document/server-docs/contact-v3/scope/list' },
  department: { title: '飞书：获取部门信息', url: 'https://open.feishu.cn/document/server-docs/contact-v3/department/get' },
  user: { title: '飞书：获取用户信息', url: 'https://open.feishu.cn/document/server-docs/contact-v3/user/get' },
};
const dingtalkSources = {
  create: { title: '钉钉官方 Stream 教程：创建应用与接收模式', url: 'https://open-dingtalk.github.io/developerpedia/docs/explore/tutorials/stream/bot/nodejs/create-bot/' },
  token: { title: '钉钉：获取企业内部应用 accessToken', url: 'https://open.dingtalk.com/document/orgapp/obtain-orgapp-token' },
  scope: { title: '钉钉：获取通讯录权限范围', url: 'https://open.dingtalk.com/document/orgapp-server/obtain-corpsecret-authorization-scope' },
  permissions: { title: '钉钉：通讯录权限配置', url: 'https://open.dingtalk.com/document/orgapp-server/address-book-permissions' },
  department: { title: '钉钉：获取部门列表', url: 'https://open.dingtalk.com/document/orgapp-server/obtain-the-department-list-v2' },
  user: { title: '钉钉：查询用户详情', url: 'https://open.dingtalk.com/document/orgapp-server/query-user-details' },
  demo: { title: '钉钉官方组织同步示例：所需读取权限', url: 'https://github.com/open-dingtalk/h5app-org-sync-demo' },
};

const selectionStep: DirectoryGuideStep = {
  id: 'selection', title: '从通讯录快照选择人员和部门', location: '员工设置 → 使用授权与能力包',
  paragraphs: ['飞书和钉钉从当前应用获准的通讯录同步部门与人员，页面从最近成功快照搜索、分页选择。找不到新人员时，可点击同步并查看进度；同步失败不覆盖最近成功的有效快照。', '部门默认仅包含直接成员；可显式勾选包含子部门。消息进入后按已保存的人员配置与本地部门快照判断，不实时请求厂商通讯录；无法确定部门关系或授权已撤销时不据此放行。', '平台成员的 Web 使用权独立配置；飞书身份不授予钉钉权限，同名人员不合并。'],
};
const rotateStep: DirectoryGuideStep = {
  id: 'rotate', title: '轮换、重新验证与停用', location: '员工设置 → 渠道连接',
  paragraphs: ['渠道凭据同样需要平台加密主密钥。部署管理员可按 DEVELOPMENT.md 使用现有 local:init 初始化，或提供 DENTITY_MODEL_MASTER_KEY；不需要模型供应商 API key 才能绑定渠道。主密钥未配置时无法保存凭据，不要通过关闭加密绕过。', '轮换凭据时填写相同机器人或应用 ID 和新的密钥；重新验证、重连或轮换密钥均保留使用范围、能力包、群共享、上下文设置与停用状态。企微保存后由长连接认证，待验证不等于连接成功。', '更换应用或机器人时，须确认换绑提醒并保存后才生效；转绑其他员工前仍须解除原绑定。换绑恢复当前渠道新建默认值，旧人员、能力包渠道限制和群共享不迁移；群内可用和能力包继承可能扩大授权。其他渠道、网页权限与资源绑定不变。', '可随时停用本员工的渠道，服务器停止长连接。启用后需重新验证凭据；连接由服务器维持，不要求页面常开。每个员工每个渠道最多一条连接，一个机器人只属于一个员工。'],
};

/** Local, read-only help. Official links are references, never image hotlinks. */
export const directorySetupGuides: Record<DirectoryProvider, DirectorySetupGuide> = {
  wecom: {
    title: '企业微信', consoleUrl: 'https://work.weixin.qq.com/',
    identityNote: '使用独立智能机器人的 BotID / Secret。使用范围按机器人来源独立，不代表公司全量员工。',
    steps: [
      { id: 'create', title: '机器人连接凭据', location: '企业微信智能机器人 → API / 长连接配置', paragraphs: [
        '为每位数字员工创建独立机器人，填写 BotID 和 Secret。服务器使用官方 SDK 主动建立唯一 WebSocket，同一连接收发，无需公网回调地址。',
      ], sources: [{ title: '企业微信官方智能机器人 SDK', url: 'https://github.com/WecomTeam/aibot-node-sdk' }] },
      { id: 'confirm', title: '保存配置并发送首条消息', location: '本员工 → 渠道连接 / 使用范围', paragraphs: [
        '新建数字员工首次接入默认全员 + 空黑名单，群内可用；换绑重置为空白名单。连接在线后，首条通过校验的真实私聊或群定向消息自动确认机器人身份。',
        '可按本渠道设置全部使用者、仅允许名单或排除名单。名单使用机器人成员搜索，按姓名、拼音或别名查询，一次最多 10 个关键词。部门路径仅供区分同名人员。',
        '能力包权限只会进一步收窄员工使用范围，不会扩大本渠道授权。',
      ] },
    ],
  },
  feishu: {
    title: '飞书', consoleUrl: 'https://open.feishu.cn/app',
    identityNote: 'App ID 标识应用，机器人 open_id 标识该应用内的机器人，二者不同；机器人 open_id 由官方 API 自动读取，无需手填。飞书 open_id 受应用命名空间限制。每个员工使用独立应用和机器人，同一应用同时提供机器人与通讯录能力。display_id 不是 tenant_key；不同应用的人员引用不能互认，应用 token 不代表平台登录用户。',
    steps: [
      {
        id: 'create', title: '创建企业自建应用', location: '飞书开放平台 → 开发者后台 → 企业自建应用',
        paragraphs: ['由具有相应企业权限的管理员确认目标企业并创建自建应用，填写名称和用途。为此员工创建独立应用与机器人，连接属于当前员工。', '若已有此员工独占的机器人应用，可填写同一 App ID，同时开通机器人和通讯录读取能力，分别完成消息与目录权限配置。已有应用必须单独检查通讯录权限，不能由机器人已启用推定可读。'],
        sources: [feishuSources.create],
      },
      { id: 'messages', title: '启用机器人与长连接接收', location: '应用能力 → 机器人；事件与回调', paragraphs: ['启用此应用的机器人能力，按官方机器人教程配置接收消息、发送消息及必要的事件订阅。配置应用可见范围并由企业管理员审批或发布。', '本页仅填写 App ID 和 App Secret 并保存，等待服务器长连接显示已连接后，在飞书控制台选择“使用长连接接收事件”并保存，再添加 im.message.receive_v1 消息事件。控制台保存需要检测到在线客户端；不需要平台公网域名或入站 URL，无 HTTP 入站兜底。', '通讯录授权与机器人消息权限分别配置。官方 API 已取得可信机器人 open_id 与租户 tenant_key 时，身份直接验证通过。仅缺 tenant_key 才等待首条消息：当前长连接在线后发送普通真人私聊或真实群 @ 消息，系统自动确认租户，并按现有使用范围处理同一条消息，首发者不会自动获得使用权。缺少可信机器人 open_id 时，先启用机器人能力并重新验证，不能靠消息补齐。连接上线不等于使用授权已齐全。'], sources: [{ title: '飞书配置长连接事件订阅', url: 'https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case' }, { title: '机器人接入官方教程', url: 'https://open.feishu.cn/document/client-docs/bot-v3/obtain-bot-info' }] },
      {
        id: 'permissions', title: '最小化授权通讯录与组织关系', location: '应用 → 权限管理 / 通讯录权限范围；版本管理与发布',
        paragraphs: ['按官方部门和用户接口要求，开放读取必要人员基本信息、部门信息与成员所属部门的权限。若需要上级、部门负责人等组织字段，再检查对应字段权限及接口支持；不要为本功能申请无关手机号、证件信息或通讯录写入权限。', '为应用设定必要的通讯录可见范围，由企业管理员按控制台要求审批、发布并确认生效。应用可用范围与通讯录数据授权不能相互替代；界面菜单及权限名称以当前控制台为准。'],
        notes: ['工作区管理员不等于飞书企业管理员。无法看到目标部门或人员时，先在飞书核对通讯录授权，再重新验证连接；不要把“应用已发布”当作全企业可读。'],
        sources: [feishuSources.scope, feishuSources.department, feishuSources.user],
      },
      {
        id: 'credentials', title: '机器人连接凭据', location: '飞书应用 → 凭证与基础信息；本页 → 渠道连接',
        paragraphs: ['从官方应用管理获取 App ID 和 App Secret，仅在本页专用凭据表单填写，点击“验证并保存渠道连接”。密钥只写入、不回显，提交后输入框清空；不要放进聊天、员工人设、截图或代码仓库。', '服务端使用应用凭据验证访问身份及授权范围，不接受手填企业标识。应用 token 不是个人登录凭据，不能用于证明某位渠道人员已登录平台。机器人验证成功后，在员工使用授权中按需查询目录并选择引用。'],
        sources: [feishuSources.token],
      }, selectionStep, rotateStep,
    ],
  },
  dingtalk: {
    title: '钉钉', consoleUrl: 'https://open-dev.dingtalk.com/',
    identityNote: '钉钉每个员工使用独立企业内部应用与机器人，同一应用共用通讯录凭据。app_scoped 仅证明应用身份，不代表已验证企业 corpId。只有应用 token 时真实机器人身份可能仍待验证，不能伪称绑定成功。senderStaffId 使用 user_id 命名空间。',
    steps: [
      {
        id: 'create', title: '创建企业内部应用', location: '钉钉开放平台 → 应用开发 → 企业内部应用',
        paragraphs: ['由具有相应企业权限的管理员确认组织，创建企业内部应用并填写名称与用途。当前目录连接使用自建应用身份，不是个人 OAuth，也不是群自定义 Webhook。', '若已有此员工独占的应用，可填写 AppKey / Client ID，同时配置机器人能力、Stream 接收和通讯录读取权限。新增员工需要独立应用和机器人。下图仅帮助定位创建应用入口，不是通讯录权限配置图；消息接收模式遵循官方教程选择 Stream。'],
        sources: [dingtalkSources.create],
        figures: [{ src: '/directory-guides/dingtalk-create-app.jpg', alt: '钉钉官方教程的企业内部应用创建入口和应用信息表单，仅用于说明创建应用。', caption: '钉钉官方教程历史界面，仅演示应用创建，不是通讯录权限截图；示例名称“聊天机器人”无需照填。具体菜单以当前控制台为准。', source: dingtalkSources.create }],
      },
      { id: 'messages', title: '启用机器人与长连接接收', location: '应用能力 → 机器人；事件与回调', paragraphs: ['启用此应用的机器人能力，按官方机器人教程配置接收消息、发送消息及必要的事件订阅。配置应用可见范围并由企业管理员审批或发布。', '在“机器人与消息推送”启用机器人配置，消息接收模式选择 Stream 并发布。本页仅填写 AppKey / Client ID 与 AppSecret / Client Secret，保存后由服务器启动长连接；不需要平台公网域名或入站 URL，无 HTTP 入站兜底。', '通讯录授权与机器人消息权限分别配置。凭据保存后的待验证状态表示真实机器人身份仍未确认。连接在线后发送普通私聊或群 @ 消息，首条通过校验的消息会自动确认身份。连接上线不等于使用授权已齐全。'], sources: [{ title: '应用机器人接收消息', url: 'https://open-dingtalk.github.io/developerpedia/docs/learn/bot/appbot/receive/' }] },
      {
        id: 'permissions', title: '配置通讯录读取权限与可见范围', location: '应用 → 权限管理 / 通讯录权限范围',
        paragraphs: ['官方组织同步示例列出的读取权限包括“通讯录部门信息读权限”“成员信息读权限”“通讯录部门成员读权限”。按当前接口要求申请必要读取能力；本功能不需要示例中另外列出的维护通讯录写权限。', '需要负责人、上级等组织字段时再核对接口支持及对应权限。不要为目录查询申请手机号、证件信息等无关敏感字段。由企业管理员设置应用可见的部门与人员，按控制台要求审批或发布并确认生效；令牌获取成功不等于通讯录权限齐全，也不代表全企业可读。'],
        notes: ['机器人启用、群消息权限和会议权限都不能替代通讯录授权。目录查询只读取应用实际获准的范围。'],
        sources: [dingtalkSources.permissions, dingtalkSources.scope, dingtalkSources.department, dingtalkSources.user, dingtalkSources.demo],
      },
      {
        id: 'credentials', title: '机器人连接凭据', location: '钉钉应用 → 应用信息；本页 → 渠道连接',
        paragraphs: ['从官方应用信息获取 AppKey / Client ID 与 AppSecret / Client Secret，在本页应用 ID 和应用密钥表单填写，点击“验证并保存渠道连接”。密钥只写入、不回显，提交后清空；不要分享密钥或长期 token。', '应用 accessToken 不代表当前平台用户或任意个人。当前返回来源为 app_scoped 或 app_id 时仅验证该应用，不能把它标作“corpId 已验证”，也不能自行填写企业 ID 来绕过来源验证。'],
        notes: ['同一企业的不同应用也不能直接共用本应用的人员引用。更换应用会产生新来源并使旧规则失效；本期不做跨应用身份共享，不由名称、企业声明或客户端自报 ID 推定。'],
        sources: [dingtalkSources.token],
      }, selectionStep, rotateStep,
    ],
  },
};
