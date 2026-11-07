<!-- Modified for Identale; see the root NOTICE. -->

# 本地合成模型与 MCP 试用

该目录包含合成 Skill 和静态资源清单，供隔离环境显式配置。启动服务不会创建模型、员工、Skill、MCP、能力包或使用授权；样例没有真实企业凭据。

## 启动

从仓库根运行 `bash scripts/start.sh --mock`。默认不启动两个 Mock 服务；带参数时在正常四服务之外启动规则模型和合成 MCP。

| 服务 | 地址 |
| --- | --- |
| Web | `http://127.0.0.1:15173` |
| 模型 base URL | `http://127.0.0.1:18302/v1` |
| MCP 甲 / 乙 | `http://127.0.0.1:18303/alpha` / `http://127.0.0.1:18303/beta` |
| MCP 就绪 / 内存审计 | `http://127.0.0.1:18303/readyz` / `http://127.0.0.1:18303/calls` |

使用单独测试账号、工作区和数据。规则模型不调用真实供应商，MCP 只返回合成文本；PI Host 仍执行真实文件和 Bash 工具，没有文件系统或网络沙箱。

## 配置

在工作区模型页新增配置：base URL 填上表地址，model ID 为 `mock`，API key 使用公开合成测试值 `identity-local-test-token`，连接测试后保存。该 token 不能保护真实业务。开启本地 HTTP 需在 `.env` 中明确配置 `DENTITY_MODEL_ALLOW_LOOPBACK_HTTP=true` 后重启；`--mock` 只启动合成服务，不覆盖该配置。

创建测试员工，为其选择模型并授权测试用户 Web 使用范围。精确输入 `你好` 可试用对话；`帮我写一个md文章` 触发基础任务，实际产物需通过工具过程与结果核对。未知输入可能返回 422，不伪造通用模型能力。步骤见[合成任务试用](../docs/local-mock-task-walkthrough.md)。

如需 MCP，在资源管理页面显式新增甲 / 乙端点并发现 `lookup` 工具；按测试用户、员工与能力包关联。导入 `skills/alpha/SKILL.md` 或 `skills/beta/SKILL.md` 也不自动授予工具权限。页面动态资源 ID 与历史静态清单 ID 不同，不要硬编码猜测真实工具名。

`registry.json` 与 `approved.json` 保留合成静态登记样例，不应直接替换已有部署资源目录或扩大真实用户范围。工具清单、身份 header 和调用审计不能代替业务服务自身认证，也不能阻止任意 Bash 直接访问网络。

## 核对与清理

按 Task / Run 查看真实工具事件与产物，不用模型口头结论证明执行或权限拦截。`/calls` 是有界内存元数据，重启清空；平台和 PI 的持久记录分别保留。

停止服务不会清理测试库、文件或凭据。删除、迁移和重置需单独明确范围；请勿把运行记录、截图或日志提交到代码仓库。
