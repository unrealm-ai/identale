# Identale 架构与模块规格索引

这组文档说明 Identale 的核心设计原则、实际源码入口与当前实现边界，建议结合对应源码一起阅读。

## 阅读顺序

| 文档 | 解决的问题 |
| --- | --- |
| [当前实现与演进边界](../STATUS.md) | 各领域核心源码入口与当前架构边界 |
| [01：架构与模块边界](01-architecture-and-boundaries.md) | 服务、包、权威数据和依赖方向 |
| [02：任务、事件与投递](02-tasks-events-and-delivery.md) | Task / Run、输入、人工继续、事项与未知结果 |
| [03：员工、角色与配置](03-agents-and-profiles.md) | 员工配置、能力包、版本和职责 |
| [04：上下文与按需读取](04-context-and-knowledge.md) | 会话隔离、fork / new、共享和记录权限 |
| [05：Runtime 与执行契约](05-runtime-and-provisioning.md) | Port、builtin、PI Host 与失败语义 |
| [06：渠道、权限与安全](06-channels-storage-and-security.md) | 可信身份、使用授权和执行限制 |
| [17：存储、保留与恢复](17-conversation-storage-and-retention.md) | 双库、原文、资源与恢复边界 |
| [26：渠道能力与扩展](26-channel-capabilities.md) | 各渠道实际差异和 Adapter 接入流程 |
| [27：读取会议资料与云文档](27-business-resource-reads.md) | 应用身份读取、任务材料状态与明确选择的事项交接 |

## 维护方式

- 先写具体场景、配置步骤和观察结果，再说明模块、契约、权限与失败路径。
- 区分已实现能力与演进方向；新增外部模型协议或渠道 Adapter 时，需结合具体配置与目标环境验证。
- 复杂变更先对齐技术和测试方案，并同步更新对应规格文档与源码链接。
- 运行时代码不依赖 `docs/` 目录。

实际开发与测试入口见 [DEVELOPMENT.md](../../DEVELOPMENT.md) 和 [CONTRIBUTING.md](../../CONTRIBUTING.md)，安全边界见 [SECURITY.md](../../SECURITY.md)。
