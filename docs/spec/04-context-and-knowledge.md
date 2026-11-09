# 上下文隔离与按需读取

## 场景

用户在群的话题中交办分析，任务可能需要本群或显式共享群的资料；结果仍回到原话题。获得资料读取权限不等于合并聊天 Session，也不等于把结果广播到所有被读取的来源。

## 归属与隔离

| 对象 | 基本范围 | 不自动继承 |
| --- | --- | --- |
| 交互 Conversation | 工作区、员工、渠道应用 / 租户，以及可信用户、群或话题 | 其他私聊、其他话题的交互原文、全工作区 Task |
| Task 上下文 | 固定输入、来源、授权配置和获准引用 | 任意会话历史、模型自行指定的路径或 URL |
| 人工继续 | 原 Task / Session 的新 Run | 新的全局权限、旧 Run 的活动写权 |
| Trigger 历史 | 工作区、员工及可信业务分组 | 自然人私聊、其他员工或其他分组 |
| 事项 Assignment | 该事项必要业务材料与明确获准引用 | 前任完整 Session、来源群或 Trigger grant |

`new` 从任务自身输入开始；`fork` 使用平台筛选和授权的上下文快照，不是复制 Runtime 私有内存或整个用户历史。`ContextBootstrap` 携带快照、引用、预算和来源信息；不同 Runtime 可用能力需分别核实。

当前执行主线每个普通 Task 使用独立逻辑 Session；补充输入更新原 Task 的修订，不另建 Session。人工继续沿原 Session 创建新 Run；事项交接则创建新的 Task / Session。

## 按需获取

运行侧根据可信 Task / Run / Host 绑定签发可读对象引用。模型只提交有限查询或不透明引用，不能替换工作区、调用人、授权范围、服务地址或凭据。

- 群 / 话题读取需验证来源、所属群、渠道应用与实际厂商权限；显式共享是直接授权，不因 A 读过 B 而允许 C 间接读 B。共享范围的固定与规则变更生效时点见[群历史与共享说明](26-channel-capabilities.md#授权群历史与实时群上下文)。
- Trigger 查询按原业务分组和冻结的选择边界返回已结束工作的详情与记录引用，不在每次执行准备时复制全部历史。
- 分页、时间、字节和 Run 预算限制读取范围；空集、部分覆盖、不可用和拒绝必须区分，不能换一个更宽来源凑答案。
- 执行内置历史工具经 Host 的可信父进程访问运行侧窄业务 API；这不是模型直查平台配置库，也不意味着所有 Host 网络绝对单向。
- 文件路径或引用出现在任务文本 / JSONL 中不等于文件读取授权。事项只传必要业务投影，显式产物另行校验来源与范围。

通知只带获准受众所需的结果和引用。收到通知不会开放原 Task、事项或完整执行记录。模型整理自然语言也不能保证内容已经确定性脱敏。

## 存储与摘要

平台拥有业务事实、Task 快照、记录索引与授权关系；Runtime 拥有自己的会话原文。builtin 使用 JSONL 与索引，PI 保存原生执行记录。摘要减少活跃推理上下文，不删除原文，也不是新的授权来源。

同组 Trigger 历史的受控执行记录可能含模型消息、工具参数 / 结果和本地路径，应评估是否适合该业务；当前本地执行不提供 OS 沙箱。备份必须考虑数据库、原文、文件、资源和原密钥，见[存储与恢复](17-conversation-storage-and-retention.md)。

## 源码入口与验证关注点

- [Session / bootstrap 契约](../../packages/contracts/src/runtime-session.ts)、[Task scope](../../packages/application/src/tasks/principal.ts)。
- [共享规则](../../packages/application/src/group-sharing.ts)、[群历史服务](../../apps/control-plane/src/group-sharing/history.ts)、[Trigger 历史](../../apps/control-plane/src/triggers/context-history.ts)。
- [执行侧群工具](../../apps/runtime-host-pi/src/group-history-tool.ts)、[Trigger 工具](../../apps/runtime-host-pi/src/trigger-history-tool.ts)、[原生记录](../../apps/runtime-host-pi/src/raw-records.ts)。
- [builtin journal](../../packages/runtime-builtin/src/journal.ts)、[索引](../../packages/runtime-builtin/src/journal-index.ts)、[维护](../../packages/runtime-builtin/src/maintenance.ts)。

修改时重点评审跨员工 / 租户 / 会话越权、伪造引用、游标换 scope、共享非传递、任务继续后旧凭据、缺失 / 过期原文、预算耗尽与部分分页。不把合成授权测试等同于真实渠道权限或宿主隔离验证。
