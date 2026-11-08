# Identale 使用与配置指南

首次使用可从[快速上手](../../README.md#方式一本地启动配置自有模型推荐完整体验)开始。在服务器上运行时，参阅[部署说明](../deployment.md)。

## 配置员工与处理任务

| 你想做什么 | 参阅文档 |
| --- | --- |
| 创建数字员工，绑定模型、能力包和使用范围 | [03 数字员工、角色与配置](03-agents-and-profiles.md) |
| 查看执行进度、补充任务或处理人工确认 | [02 任务、人工继续与结果投递](02-tasks-events-and-delivery.md) |
| 配置交互和后台执行所需的模型与资源 | [05 Runtime 与执行](05-runtime-and-provisioning.md) |

## 接入渠道与管理会话权限

| 你想做什么 | 参阅文档 |
| --- | --- |
| 配置飞书、钉钉或企业微信，查看消息、附件及群历史能力 | [26 渠道配置与能力](26-channel-capabilities.md) |
| 确认谁能使用员工，以及渠道身份如何核验 | [06 渠道、权限与安全](06-channels-storage-and-security.md) |
| 确认员工能读取哪些会话、记录和共享上下文 | [04 上下文隔离与按需读取](04-context-and-knowledge.md) |

实际渠道能力取决于应用权限、租户配置和员工使用范围。

## 部署与数据管理

- 了解服务如何分工以及部署边界，见 [01 架构与模块边界](01-architecture-and-boundaries.md)。
- 查看数据如何保留、备份和恢复，见 [17 存储、保留与恢复](17-conversation-storage-and-retention.md)。
- 查看部署和执行的安全边界，见[安全说明](../../SECURITY.md)。

阅读源码或参与贡献时，参阅[当前实现与演进边界](../STATUS.md)、[开发指南](../../DEVELOPMENT.md)和[贡献指南](../../CONTRIBUTING.md)。
