# 渠道能力与 Adapter 扩展

## 不同能力分别声明

管理员配置一个机器人后，应用认证、消息入口在线、业务使用授权和实际收发必须分别核对。SDK 连接成功不证明可读历史、可见全部群消息或可读取会议资料。

[Channel Port](../../packages/application/src/channels/ports.ts)将会话、会议资料和 webhook 分开。能力同时有 `supported` 与 `availability`，后者区分 `available`、`authorization_required`、`unsupported` 和 `unknown`。没有声明的可选能力不能推断为可用。

## 当前企业机器人路线

下表反映代码分支和限制，不是对真实租户的联调结论。

| 渠道 | 入站 / 会话能力 | 历史与话题 | 出站 |
| --- | --- | --- | --- |
| 飞书 | WebSocket 接入；私聊、@ 与普通消息取决于应用和授权 | 有群 / 话题分页实现；话题降序明确不支持，时间过滤与覆盖范围需按结果处理 | 文本、回复以及原生图片 / 文件实现；实际权限与文件限制需验证 |
| 钉钉 | Stream 接入；私聊和 @ 依赖已授予能力 | 当前企业机器人 Adapter 不支持历史 / 话题 / 普通消息读取 | 配置授权的主动发送；不支持回复指定消息及原生附件 |
| 企业微信 | 智能机器人接收会话；使用厂商“发给机器人”的可信事件，不伪造 @ | 不支持会话查询、历史或话题 | 委托当前接收会话发送 / 回复；不支持原生附件 |

飞书 `open_id` 具有应用作用域，不能跨应用当作同一个全局用户 ID。企微智能机器人和传统目录应用使用不同凭据；目录同步成功也不是机器人消息权限。普通文本中的昵称、@ 字符或“我是管理员”不是身份依据。

仓库另有飞书会议资料和 DWS 类型的 Adapter，但不是企业机器人默认消息链路的自动扩展，不应在 README 或向导中暗示配置机器人即能获取这些资料。实际产品权限、API 和可用性需要独立集成验证。

## 接收、历史与发送事实

入站校验后才生成可信 `ChannelMessageEvent`，保留 event ID、连接、租户、来源和消息范围。历史消息的 `origin` 与实时事件不同；历史补读不能伪装成新的实时指令。

历史页必须说明分页游标、是否耗尽以及 `coverage`。`exhausted` 只针对该查询 / 身份，不表示获得了整个会话生命周期的全部消息。群列表中的话题根消息也不代表已展开全部回复。

出站固定获准目标与操作 ID，模型不能自选接收人或携带渠道凭据。`accepted`、`sent`、`unknown` 是不同回执；没有持久去重保障的未知发送不自动重试。附件按独立操作处理，以便部分成功后只核对未确定项，不重发整批。通知失败不重跑业务任务。

## 新增或修改渠道

1. 先列实际场景及厂商能力 / 权限资料，明确机器人、委托用户、目录应用与会议资料各自身份。
2. 实现所需 Port；不支持的能力明确返回，不用空列表假装成功。SDK 放在 Adapter，不流入领域 / 应用代码。
3. 经可信 Adapter 建立连接、应用、租户、用户与群 / 话题范围。不要从模型参数或显示名推断身份。
4. 评审游标、分页覆盖、重连、重复 / 乱序事件、凭据轮换、撤权、限流、部分发送与未知结果。
5. 先用合成输入验证契约，再单独确认真实测试账号、权限、数据和消息目标。真实测试结果按场景报告，不复用私有脚本中的账号或数据库。

## 源码导航

- [飞书](../../apps/control-plane/src/adapters/channels/feishu.ts)、[钉钉](../../apps/control-plane/src/adapters/channels/dingtalk.ts)、[企微](../../apps/control-plane/src/adapters/channels/wecom.ts)：具体会话能力。
- [SDK 入站](../../apps/control-plane/src/adapters/channels/ingress)、[入口监管](../../apps/control-plane/src/channel-loop/ingress-supervisor.ts)：连接生命周期和消息归一化。
- [业务消息循环](../../packages/application/src/channels/message-loop.ts)、[渠道授权](../../apps/control-plane/src/channel-loop/authorization.ts)：准入、调度和输出。
- [群历史授权](../../apps/control-plane/src/group-sharing/history.ts)、[目录 Adapter](../../apps/control-plane/src/adapters/directory)：不同权限域，不能互相替代。

通用权限边界见[渠道与安全](06-channels-storage-and-security.md)，上下文范围见[上下文隔离](04-context-and-knowledge.md)。
