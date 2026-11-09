# 任务、事件、人工继续与结果投递

## 场景与对象

用户委派一项分析后仍能继续聊天。交互层通过任务应用用例创建业务工作，运行侧持久记录任务和派发意图，再调用执行 Runtime；执行进展和最终结果回到原来获准的目标。

| 对象 | 语义 | 不应混用的对象 |
| --- | --- | --- |
| Conversation | 某个可信渠道 / 用户 / 群 / 话题的交流范围 | 不是整个员工的共享记忆 |
| Task | 业务目标、输入修订、授权快照和当前业务状态 | 不是一次 HTTP 请求或一个 worker |
| Run | 一段执行，记录顺序、结果和与 Runtime 的映射 | 不是 Task 的永久身份 |
| Agent Session | Runtime 持有的上下文 / 原生记录 | 不直接授予业务任务读取权 |
| Delivery | 面向固定接收目标的输出 / 通知事实 | 不等于任务执行结果 |
| Work item / Assignment | 跨员工事项及当前处理环节 | 不通过复用原 Task / Session 跨员工执行 |

## 主链路与状态

1. 从认证后的来源构建可信 Task scope，解析获准资源与配置快照。
2. 在持久事务中保存 Task、Run、初始输入及 outbox；网络调用不跨越事务边界。
3. 派发时检查 Runtime 就绪与能力，使用稳定的操作 ID。受理、拒绝和未知结果分别记录。
4. 按 Run 消费持久事件，校验事件身份、序号和输入版本后更新运行事实。
5. 结果和业务终态满足条件后完成 Task，随后处理通知。通知失败不重新执行 Task。

未开始的待办为 `planned`，没有执行 Run；明确开始后进入派发链路。常见任务状态有 `queued`、`running`、`waiting_input`、`waiting_approval`、`waiting_human`、`cancel_requested`、`unknown`，终态为 `succeeded`、`failed` 或 `canceled`。这些是导航说明，不替代源码中带版本和权限检查的转移规则。Run 还包含 `preparing`、`needs_human` 等执行段状态，不要求与 Task 一一相同。

输入补充保留 `inputRevision`：`received` 是已收到，`applied` 才是已被 Runtime 采用的证据，均不保证业务目标完成。流式 `output_delta` 不是里程碑或最终结果。`final_result` 带所依据输入版本，不能把旧版本结果冒充最新输入已完成。

## 幂等、取消与未知结果

操作 ID、请求摘要、事件 ID、Run 序号和版本检查分别解决不同问题。相同操作 ID 的冲突内容应被拒绝；没有接收端持久去重保障时，不因为超时或进程重启自动重发副作用。游标是各来源自己的位置，不可混用。

取消请求和确认停止不同；取消不撤销已经发生的文件、网络或业务操作。`unknown` 表示证据不足，需要核对原执行 / 回执，不是自动失败，更不是创建新 Task 的理由。终态 Run 的迟到事件不得回写覆盖新的活动 Run。

## 人工协作

执行提出结构化人工请求和安全停稳是两个事实。安全检查点确认后，旧 Run 以 `needs_human` 结束该段，Task 等待人工。获准答复必须匹配请求、问题版本、任务范围和确认身份；提前到达的答复不能跳过安全停稳。

确认人按问题独立选择。只有一位已配置确认人时直接选定；多人时按问题从配置候选中选择，选择本身不授予权限。选定后再检查该人的身份和当前使用权，不能因为 B 尚未验证或已失去权限，就把 B 的问题改发 A。未绑定的企微确认人等待本人验证，期间保存已选目标；绑定后重验权限，再投递尚未发送的请求。规则改变、选定者无权或已发生结果未知的投递时，保持阻断或核对，不自动更换接收人。企微身份绑定与待验证展示见[渠道配置与能力](26-channel-capabilities.md#企业微信智能机器人与成员搜索)。

满足继续条件后，协调器创建唯一的新 Run，复用原 Task 和逻辑 Session，继承原配置 / 资源范围并保存继续派发意图。重复答复不应重复启动，冲突答复须报告冲突。普通补充消息、通用暂停 / 恢复和人工继续不是同一种操作。

## 事项协作

新建工作区（包括注册时创建的初始工作区）默认开启事项协作 Beta：工作区、成员与初始配置 `revision=1, enabled=true` 在同一事务内写入。管理员可通过现有事项设置关闭或重新开启；选择持久化，重启后保留。已有工作区配置不覆盖，缺少配置的旧工作区仍保持关闭，不在启动时补写或自动开启。数据库中的请求配置与运行侧实际应用状态分别查询，尚未同步或运行侧不可用时不能显示为已生效。

当前五个执行工具由[契约](../../packages/contracts/src/work-items.ts)定义：`work_item_get_current`、`work_item_list_handoff_employees`、`work_item_handoff`、`work_item_update_progress`、`work_item_finish`。

事项可以连续，但每次 Assignment 使用独立 Task / Session。交接 / 结束意图与 Runtime 安全检查点分别持久化，当前 Assignment 和活动 Run 共同限制谁能推进事项。Beta 门禁控制新任务工具快照及后续交接启动，不应中断已有 Task 的人工继续。收到事项通知不自动取得事项的所有原始记录或前任来源权限。

## 修改与验证入口

- [TaskService](../../packages/application/src/tasks/service.ts)、[TaskRepository](../../packages/application/src/tasks/ports.ts)：状态、事务、outbox、动作与版本。
- [执行回执 / 事件契约](../../packages/contracts/src/runtime-execution.ts)、[任务 Runtime 接口](../../packages/application/src/tasks/runtime.ts)：受理、采用、取消和未知语义。
- [人工协调](../../apps/control-plane/src/human-confirmation.ts)、[事项服务](../../apps/control-plane/src/work-items/service.ts)、[统一结果通知](../../apps/control-plane/src/notifications/business-results.ts)：跨段与投递。

修改时应评审重复输入、乱序 / 缺失事件、丢回执、取消与结果竞态、重启恢复、早到 / 重复人工答复、旧 Run 写入、通知失败和越权查询。当前已有实现不等于这些场景在本轮重新测试；运行方式见[开发指南](../../DEVELOPMENT.md)。
