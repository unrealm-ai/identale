<!-- Modified for Identale; see the root NOTICE. -->

# Local PI Runtime Host

独立 loopback 服务，使用固定版本 `@earendil-works/pi-coding-agent@1.4.0` 与 `@earendil-works/pi-mcp@1.4.0`。准备、Session、提交、输入、取消、事件和结果契约定义于 `packages/contracts`，实际 HTTP 路由与能力声明以 Host 源码为准。

## 配置

| 变量 | 用途 |
| --- | --- |
| `DENTITY_RUNTIME_HOST_PI_PORT` | 默认 loopback 端口 18301 |
| `DENTITY_RUNTIME_HOST_TOKEN` | 执行 / 管理入口认证，不能与其他作用域令牌混用 |
| `DENTITY_PI_MONITOR_TOKEN` | 独立只读监控认证 |
| `DENTITY_RUNTIME_HOST_STATE_DIR` | 本地默认 `~/.identale/runtime-host-pi`，显式配置优先 |
| `DENTITY_RUNTIME_HOST_RESOURCE_REGISTRY` | 可选的部署资源清单路径 |

由正式本地启动器装配相关凭据与端点；变量总览见 [.env.example](../../.env.example)。不要在公开文件填写真实值。transport ready 不表示模型供应商已经联通或 SDK 已完成某次任务准备。

本地启动器在缺少 `.env` 时自动创建，并在每次启动时读取，按进程环境变量 → `.env` → 代码默认值取值；不再自动探测 `.dentity` 数据或 `var/runtime-host-pi` 状态，复用自定义状态需显式配置；已有文件不自动搬迁或删除。服务器仍使用原部署目录和配置，详见[部署说明](../../docs/deployment.md)。

## 执行与授权

Host 接收获准的版本化配置、Session 与任务输入，在独立 worker 中使用真实 PI SDK。可信业务元数据在模型参数外绑定，额外 Skill / MCP 按任务授权范围装配。交互角色不拥有业务文件和 Bash 工具；local-pi 交互回调不是 builtin 主线的完整替代。

原生工具在各执行目录内使用 `.identale-tmp` 作为临时目录，并通过 `TMPDIR` 传给工具子进程；已有 `.dentity-tmp` 不自动删除或搬迁。

**独立工作目录和进程不是安全沙箱。** 原生 read / write / edit / bash 仍按 Host 的操作系统身份访问文件和网络。工具环境不直接继承秘密，并不能防止同用户代码读取其他用户文件；本地使用当前用户，服务器模板使用专用 `identity` 普通账号，各任务仍共享该账号的系统权限。

取消不承诺回滚。未知结果、进程重启与中断写入需要核对，不能自动重放。任意脱离后台进程的清理不受保证；工具清单和进程组管理不提供完整生命周期隔离。

运行侧和 Host 分别持久记录业务与执行事实，人工请求、停稳检查点和继续 Run 需按绑定与版本校验。具体边界见[Runtime 规格](../../docs/spec/05-runtime-and-provisioning.md)和[安全说明](../../SECURITY.md)。

## 开发验证

根目录已有 `npm run test:runtime-host`，包含真实 SDK / worker 与本地合成模型、MCP 或测试 driver；不等于真实供应商、企业渠道、受保护 MCP 或生产隔离验证。

[PI 官方源码与 SDK 文档](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)可用于对照；以仓库锁定版本的实际类型和行为为准。
