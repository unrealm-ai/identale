<!-- Modified for Identale; see the root NOTICE. -->

# Builtin interaction Runtime

该包实现内置交互 Adapter，管理受限模型 / 工具循环和自身会话状态。它不承担通用业务执行 Harness，也不替代平台的交互触发、任务和投递逻辑。

运行服务注入有效模型客户端、持久 Session / 操作状态、JSONL journal、获准工具、可信上下文、授权及内容读取 / 输出回调。缺失必要模型配置时报告不可用，不使用生产 Mock 或宽松授权默认值。

模型不能通过工具参数自行设置工作区、调用人、授权或接收人。实际工具注册、schema、预算与调用时机以平台装配和源码为准；接口声明不表示已有业务知识后端或所有外部 Runtime 兼容。

正文与元数据分别持久保存。摘要、归档和输入调度要区分已接收、实际采用与最终回复；不能通过恢复盲目重放有副作用工具。详见[Runtime 规格](../../docs/spec/05-runtime-and-provisioning.md)与[存储规格](../../docs/spec/17-conversation-storage-and-retention.md)。

已有验证入口为根目录 `npm run test:builtin`。合成模型与内存 test store 不能证明真实供应商质量或生产持久性。
