# 当前实现与演进边界

本页提供各核心领域的源码导航与当前架构边界说明，帮助开发者快速定位模块职责。

## 已有实现入口

| 领域 | 源码入口 | 当前边界 |
| --- | --- | --- |
| 账号、工作区、员工与配置 | [平台装配](../apps/control-plane/src/split/server.ts)、[账号应用层](../packages/application/src/accounts) | 平台配置与运行数据分库；内部包名保留 `@dentity/*` |
| 持续交互 | [交互用例](../packages/application/src/interaction/service.ts)、[builtin Runtime](../packages/runtime-builtin/src/runtime.ts) | 交互主线为 builtin；需要有效模型，不自动用 Mock 代替 |
| 任务、补充输入、取消和回告 | [任务服务](../packages/application/src/tasks/service.ts)、[通知](../apps/control-plane/src/notifications) | Task、Run、输入版本与 Delivery 分开；未知结果须按回执处理 |
| 本地执行与人工继续 | [PI Host](../apps/runtime-host-pi/src/adapter.ts)、[人工协调](../apps/control-plane/src/human-confirmation.ts) | 独立 Host / worker；人工继续是同 Task / Session 的新 Run；没有 OS 沙箱 |
| 事项协作 | [事项服务](../apps/control-plane/src/work-items/service.ts)、[事项契约](../packages/contracts/src/work-items.ts) | Beta 门禁、五个执行工具和独立 Assignment；不是通用审批 / 多 Agent 调度平台 |
| Webhook / 定时触发 | [触发服务](../apps/control-plane/src/triggers/service.ts)、[调度](../packages/application/src/scheduling) | 使用明确的触发绑定与业务身份，不伪造真人；外部业务操作需单独授权 |
| 渠道消息 | [渠道 Adapter](../apps/control-plane/src/adapters/channels)、[消息循环](../packages/application/src/channels/message-loop.ts) | 飞书、钉钉与企微能力不同，详见[渠道规格](spec/26-channel-capabilities.md) |
| 上下文与存储 | [JSONL journal](../packages/runtime-builtin/src/journal.ts)、[存储配置](../apps/control-plane/src/storage-config.ts) | Runtime 保存原文，SQLite 保存业务事实 / 索引；摘要不等于删除原文 |
| 模型协议 | [builtin 协议适配](../packages/runtime-builtin/src/model-protocol.ts)、[Host 模型边界](../apps/runtime-host-pi/src/model-fetch.ts) | 存在 Chat Completions、Responses、Anthropic Messages 分支；具体供应商兼容性需按实际配置验证 |

## 架构边界与演进方向

- **外部 Runtime 扩展**：通用 Port 已定义，当前交互主线为 `builtin`、后台执行主线为 `local-pi`。接入新的远端 Runtime 时需按契约完整对接事件与回调链路。
- **单机模块化存储**：当前采用本地 HTTP、配置同步和双 SQLite + JSONL 存储链路；分布式多节点调度、跨机器全量同步或关系型数据库 / 对象存储替换需另行扩展。
- **执行环境隔离**：PI 本地工具没有 OS 级文件系统或网络沙箱；服务器部署默认使用专用 `identity` 普通账号并禁止提权，但各服务与任务仍共享该系统账号，不用于公开托管不可信多租户任务。
- **渠道与模型集成**：不同企业租户、权限集和模型供应商协议存在差异，接入生产使用前应针对实际配置独立验证。
- **故障恢复与幂等**：取消请求不等于已发生外部副作用的自动回滚；丢回执或 `unknown` 状态需核对原操作身份，避免盲目重放副作用。

构建、本地启动与测试命令见 [开发指南](../DEVELOPMENT.md)。
