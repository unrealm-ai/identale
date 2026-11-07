# 安全说明

## 当前支持边界

Identale 当前为开发预览版本。请在受控环境中部署与评估，注意区分业务层面的权限控制与操作系统层面的安全隔离。

## 私下报告

请优先使用仓库的 [Private vulnerability reporting](https://github.com/unrealm-ai/identale/security/advisories/new) 入口私下提交安全问题。

若该入口暂不可用，可先在普通 Issue 中请求私下联系渠道（仅留下联系请求，请勿在公开 Issue 中包含漏洞细节、利用载荷、真实数据或凭据）。取得私下联系后，再提供受影响版本、最小复现步骤、影响范围和缓解建议。

## 已知执行与部署限制

- `local-pi` 的 `read/write/edit/bash` 工具以 Host 的操作系统身份运行，没有额外的文件系统或网络沙箱。独立 `cwd`、worker、工具白名单和业务授权不能限制原生 Bash 的底层系统访问行为。
- 服务器部署模板 `scripts/deploy/templates/identity.service.template` 使用专用 `identity:identity` 普通账号，配置 `NoNewPrivileges=true` 并清空 capabilities；执行子进程继承该身份和限制。安装器仍需 `root` 配置系统，Nginx 沿用系统服务身份。本地开发启动使用当前操作系统用户，不自动创建系统账号或降权。
- 平台、运行服务、PI Host 及可选 Mock 服务共享 `identity` 账号，没有服务、任务或租户间的系统级隔离；任务可能访问同账号下的业务数据和进程。服务账号降权不能作为凭据隔离或多租户安全保证，不应直接用于承载不可信任务或公开多租户服务。
- `/etc/identity` 配置、凭据原件和 TLS 私钥保持 `root` 私有，systemd 读取对应环境文件后传给服务；工具环境不直接注入模型或 Host 凭据，但这不阻止同操作系统用户运行的代码访问该用户可读的文件。主密钥、配置和执行环境应分开保护。
- 原目录部署通过定向 ACL 授予 `identity` 运行文件访问及必要 home 祖先的遍历，不递归开放 home 或额外授权 `.env` / `.git` 等私有路径。遍历权限仍允许按已知名称访问原本可读的其他文件，不是 home 隔离；部署者需信任代码目录的维护者，并保护同账号可读的所有资源。原 ACL 与 inode 记录在 root 私有部署备份中，失败时尝试核对回退，后续外部改权与文件替换可能需要人工恢复。
- 任意自行脱离进程组的后台 daemon 清理不受保证；任务取消不等于副作用回滚，未知副作用不会自动重放。
- HTTPS、Origin 校验、Cookie 和应用权限不替代模型 / MCP / 本地工具的网络出站控制。部署者需根据实际环境配置防火墙与内网访问策略。

## 敏感数据保护

平台库、运行库、会话 JSONL、执行产物、渠道目录 / 消息标识、模型响应诊断及日志可能含私有业务内容。请仅在受控目录中保存，并在备份时保留严格的目录与文件权限（如 `0700` / `0600`）。

密钥只通过受保护的私有配置或认证页面提供，切勿写入员工人设、聊天记录、Skill、Issue、截图或测试样例中。公开的 Mock token 仅供本地合成测试使用，不能用于真实服务认证。

`.gitignore` 仅防止未跟踪文件被意外添加，不影响已跟踪文件，也不能清理 Git 历史。若真实凭据不慎泄露，请立即撤销或轮换凭据，并参考 [GitHub 官方说明](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository) 清理仓库历史。
