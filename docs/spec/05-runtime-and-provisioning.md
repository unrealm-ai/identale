# Runtime 与执行契约

## 用户如何配置

管理员先配置模型，再为员工选择有效模型与执行资源。交互主线使用 builtin；后台任务使用独立 local-pi。模型不可用、资源未获准或必要 Runtime 能力不足时明确失败，不静默换成 Mock 或其他执行方式。

local-pi 承载交互任务管理回调的完整平台链路尚未提供，不能因 Host 声明部分 interaction 能力就把它视为 builtin 的完整替代。

## 契约分层

`packages/contracts` 定义准备、Session 和执行相关契约。`packages/application` 承载相应应用接口与用例；具体 HTTP、模型和 SDK 行为留在 Adapter。

准备阶段核验实际 Runtime 能力、固定资源版本与工具范围；Session 绑定可信工作区、员工和上下文；提交、补充、取消、查询与结果分别保留操作身份和回执。能力声明不代替实际目标的就绪检查，transport ready 不等于供应商已验证。

### 代码中的 Port

- [AgentProvisioningPort](../../packages/application/src/runtime-ports.ts)：`capabilities`、`validateSpec`、`prepareAgent`、检查准备结果和释放；准备成功不应静默安装未获准资源。
- 同文件的 `AgentSessionPort`：创建、恢复和关闭 Session；旧 handle 本身不是授权，关闭也不证明副作用已停止。
- 同文件的 `AgentExecutionPort`：提交、事件订阅、查询状态、追加输入、取消和结果读取；不支持订阅应明确返回，流结束不代表完成。
- 可选维护和交互事件 Port 分别处理摘要维护、持久交互事件 / 回执。实现基本执行不代表同时支持这些扩展。

配置、Session 和执行 DTO 分别见[准备契约](../../packages/contracts/src/runtime-provisioning.ts)、[Session 契约](../../packages/contracts/src/runtime-session.ts)、[执行契约](../../packages/contracts/src/runtime-execution.ts)。当前业务派发还使用[TaskRuntimeClient](../../packages/application/src/tasks/runtime.ts)，新增 Adapter 须核对实际装配调用，不能只实现未被调用的类型。

## 内置交互

`packages/runtime-builtin` 管理自身 LLM + tools 循环、工具结果、预算和会话记录。平台注入可信身份与获准工具；模型不得通过工具参数自行指定调用人或扩大权限。工具与输出需经过业务授权和内容过滤。

内置交互的模型请求、摘要和私有状态不应迁入交互控制层。没有有效模型时不能正常对话或压缩摘要。

## PI Host

Host 监听 loopback 的认证接口，使用版本固定的 `@earendil-works/pi-coding-agent` 与 `@earendil-works/pi-mcp`。当前依赖为 `1.4.0`，具体接口以锁文件和实现为准。

Host 将执行放入独立 worker 和 Session 工作目录，持久记录执行事件与引用。基本文件 / Bash 工具以及获准 Skill / MCP 与可信上下文一起装配；业务资源授权不能替代操作系统隔离。模型凭据和服务凭据按作用域分配，不直接放进工具环境，但不保证同用户代码无法读取宿主其他文件。

## 失败、补充与人工继续

接收输入、实际采用、模型返回、业务终态和投递是不同事实。请求超时或回执丢失时，应按原操作身份核对，不能盲目重试有副作用的工作。取消不承诺回滚；Host 重启和执行结果未知时不自动重放。

人工请求必须绑定任务、版本、确认人及授权范围。执行安全停稳后，明确且获准的答复才能进入继续链路；重复答复不能重复创建继续执行。具体持久化和状态转换以当前 Host 与运行服务实现为准。

服务器部署默认以专用 `identity` 普通账号运行 Host 与执行子进程，禁止提权并清空 capabilities；本地启动仍使用当前用户。这不构成任务或租户隔离，现有限制见 [SECURITY.md](../../SECURITY.md)。
