<!-- Modified for Identale; see the root NOTICE. -->

# 本地合成模型与 MCP

该应用只提供显式启用的测试服务，不是正常模型调用失败时的降级路径。规则模型按固定 messages / tools 构造合成响应，不执行工具、不调用真实模型，也不写平台配置。实际工具和文件操作仍由平台与 PI Host 完成。

构建后 `npm run start:mock-model` 启动模型，默认 `127.0.0.1:18302`；`npm run start:mock-mcp` 启动独立 MCP，默认 `127.0.0.1:18303`。本地完整试用入口是 `bash scripts/start.sh --mock`。

模型提供 Chat Completions JSON / SSE、模型列表和健康接口；公开默认合成 token 是 `identity-local-test-token`。仅用于本机测试，不能充当真实认证密钥。自定义合成值、兼容值与显式故障 model ID 的校验以 `src` 实现为准。未匹配规则明确失败，不返回预置成功兜底。

MCP 的 `/alpha` 和 `/beta` 分别提供闭合空参数 `lookup`，只返回合成结果。`/calls` 是有界内存元数据而非业务审计或调用方认证；重启清空。启动这些服务不代表给任何用户授权。

规则在 `src/scenarios`，协议、模型 HTTP 与 MCP 服务分开。新增规则应有明确匹配、工具范围、失败行为与测试方案，不使用全局“最近用户”推断身份。

测试入口为根目录 `npm run test:mock-model`，使用本地合成请求。人工工具回执不证明文件或 Bash 已执行，真实 PI 与端到端结果需单独验证。详细配置见 [Mock 指南](../../mock/README.md)和[开发指南](../../DEVELOPMENT.md)。
