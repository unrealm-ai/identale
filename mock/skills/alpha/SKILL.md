---
name: local-mock-alpha
description: 本地合成业务甲的MCP查询与结果核对，用于能力包授权试用。
---

# 本地业务甲查询

LOCAL_MOCK_SKILL_ALPHA

仅在用户明确要求本地测试业务甲时使用已注册的 `mcp__local_mock_alpha__lookup`，参数为 `{}`。
核对工具返回的 `LOCAL_MOCK_MCP_ALPHA_OK`，再用中文说明这是本地合成结果，不是正式业务数据。
若工具未装配或调用失败，说明实际情况，不猜测结果，不寻找另一账号或其他业务资源代替。
此Skill本身不授予权限，不改变平台的身份、能力包使用范围或工具清单。
