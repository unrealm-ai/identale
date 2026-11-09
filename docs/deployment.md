# 服务器部署边界

当前建议先在受控本地环境评估 Identale。[README](../README.md)提供本地入口；本页说明保留的服务器脚本及其未解决限制。

## 当前实现

`sudo bash scripts/start.sh --host IP_OR_DOMAIN` 支持 Debian / Ubuntu、systemd、Nginx 与 HTTPS 配置。原 `scripts/setup.sh` 的安装逻辑已并入此入口。脚本按需准备系统工具、Node 和项目依赖，构建、写入 `/etc`、配置服务并启动进程，不能作为只读检查运行。

参数以 `bash scripts/start.sh --help` 和实际源码为准，包含访问主机、HTTPS 端口、证书 / 私钥、首次数据根与跳过安装 / 构建等设置。首次数据路径选择不意味着自动迁移旧数据。

## 同一代码目录的模式互斥

本地启动与 host 部署在 Node 就绪后、写入本地配置或安装项目依赖 / 构建之前，通过[代码目录互斥记录](../scripts/shared/checkout-mode.mjs)协调。记录位于真实仓库路径下的 `.identale-mode/`，短期原子转换门位于 `.identale-mode-transition/`，不随 `HOME` 或 sudo 改变位置。本地记录保持到服务清理结束，部署记录保持到部署及失败恢复结束；同用户的本地重启交接仍复用既有控制接口，不允许 host 接管或停止本地实例。Node 引导使用各模式独立的安装位置；本约束不覆盖手动执行 `npm ci` / `npm run build` 或绕过启动器直接运行服务。

普通用户已经本地启动时，再从同目录 sudo 部署会拒绝项目依赖安装与构建。部署端还会只读检查同目录的旧启动入口进程，避免旧版本缺少互斥记录且 HOME 不同造成漏检。部署完成后，本地入口会在取得互斥记录后再次检查同目录 systemd 服务，包括可选服务，避免早期检查与并发部署之间的窗口。

记录包含进程 PID、UID、进程组与启动身份，不包含凭据和业务数据。异常退出留下的跨模式记录不会因 PID 消失就自动放行；先用原模式重新启动并完成既有恢复 / 清理，再切换。无可验证属主的转换门、损坏记录或权限冲突会明确失败，需检查后处理；不自动放宽权限或停止另一模式的服务。这是启动器协调机制，不是安全沙箱，也不保证阻止管理员在 systemd 外部并发启动服务。

本地 SIGHUP 与 SIGINT / SIGTERM 共用停止流程，覆盖端口预留、准备命令及运行服务，清理已登记进程组、控制 socket 和实例状态；SIGHUP 正常清理后退出码为 129。SIGKILL、原生崩溃和外层观察进程单独丢失仍依赖下次启动核验恢复，不承诺捕获不可处理的信号。

本地 `--no-install` 与部署 `--skip-install` 都允许复用兼容 Node/npm 或已存在的脚本管理版本；服务器不会复用 `/root` 下的 Node，而会选择 `/opt/identity` 的受管版本。可用版本均缺少时直接报错，不下载 Node；部署的 `--skip-install` 还要求预装 `getfacl` / `setfacl`（Debian / Ubuntu 的 `acl` 包）。本地 `--no-install` 要求已有项目依赖，构建仍由 `--no-build` 单独控制。

前端发布复制整个 `apps/web/dist/`，包含项目许可、NOTICE、实际打包依赖许可与校验清单。安装器在修改服务配置前及复制后检查通知与产物摘要；`--skip-build` 也不能跳过许可完整性检查，缺文件或锁文件 / 许可变化时需先重建。来源证据和 `vdirs` 未确认版权通知的限制见[前端分发许可](frontend-distribution-licenses.md)。

## 服务账号与启动权限

安装器以 root 安装依赖、配置 systemd / Nginx 和 HTTPS；应用服务使用专用 `identity:identity` 系统账号，主目录为 `/var/lib/identity/service-home`，密码锁定且登录 shell 为 nologin。已有同名账号必须满足这些条件，并且没有额外组权限；否则报错，不自动修改已有账号。该账号不应配置 sudo、Docker 管理组或其他外部提权授权。

平台、运行服务、PI Host 及可选 Mock 服务使用同一模板；worker 和 Bash 继承服务账号。`NoNewPrivileges=true` 与空 `CapabilityBoundingSet` / `AmbientCapabilities` 阻止通过 setuid 和文件 capabilities 增加权限。独立进程、0700 目录和精简环境不构成沙箱；同账号服务和任务仍可能互访数据和进程，文件 / 网络访问没有按任务或租户隔离。

安装器通过真实降权子进程检查程序、Node、依赖、存储和自定义资源访问，启动前检查 systemd 有效身份及权限配置，服务就绪后读取实际进程的 UID / GID、NoNewPrivs 和 capabilities。不兼容的后置 drop-in 会导致部署失败及恢复，而不是静默以 root 启动。

上述配置语义参考 [systemd 官方执行环境文档](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml)和 [useradd 手册](https://man7.org/linux/man-pages/man8/useradd.8.html)；这是降权措施，不是完整多租户安全方案。不应直接用于不可信任务或公开多租户服务。

## 在用户 home 中原目录部署

用户可在 `/home/<用户>/identale` 下载代码，进入该目录后执行 `sudo bash scripts/start.sh --host IP_OR_DOMAIN`。即使 home 为 `0700`，安装器也会向 `identity` 添加必要的定向 ACL；代码不复制到 `/opt`，不递归更换源码属主。源码位于 `/root` 时仍会拒绝，不为该私有目录授权。

[ACL 实现](../scripts/deploy/checkout-access.mjs)仅处理以下范围：

- 代码目录及必要上级目录：home 上级只补遍历 `x`，代码根需要读和遍历；不会递归开放 home。`x` 允许访问已知路径，不等于 home 内其他文件完全不可读，原有文件权限仍生效。
- 运行入口所在应用的 `dist/` 与 manifest、各包 `dist/` 与 manifest、已安装的 `node_modules/`，以及访问检查模块和 Node 程序：补充必要的读取和执行 / 遍历，不额外授予写权限。保留现有文件属主。
- `.git`、`.env` / `.env.*`、`.ssh`、`.identale`、`.dentity` 与 `local-secrets.json` 不纳入额外授权；仓库源代码和 Web 源文件也不整树授权。这不撤销这些文件原本已有的可见性，不应将私人文件混放到获准的运行产物目录。
- npm workspace 链接仅解析到已知工作区的 manifest / 运行产物；依赖内的链接不得指向其他目录。需要修改 ACL 的普通文件不能有外部硬链接；不沿任意链接递归改权。

依赖安装 / 构建前先检查根路径、ACL 工具和旧存储范围，记录并授予基础访问；构建后重新枚举运行文件并授权。ACL mask 扩展时保持其他用户 / 组原先的有效权限，避免顺带开放被 mask 限制的授权。每个涉及的文件系统先用一次性文件验证具名 ACL 支持，失败会明确退出，不静默改为开放普通权限位。规则参考 [acl(5)](https://man7.org/linux/man-pages/man5/acl.5.html) 与 [setfacl(1)](https://man7.org/linux/man-pages/man1/setfacl.1.html)。

每次变更前，原访问 ACL、目标 inode 与拟写入的 ACL 会写入 `/etc/identity/backups/<本次部署>/checkout-acl.jsonl`（`0600`），同步到磁盘后再应用。不修改默认继承 ACL。普通部署失败会逆序尝试恢复；目标被替换、ACL 被其他操作修改或异常断电时可能需要管理员按备份处理，不覆盖新文件 / 外部权限变更。成功部署的 ACL 会保留供服务运行；删除部署或收回访问前应先停服务，再由管理员核对备份。

运行中的服务依赖原代码目录。更新代码后须重新执行部署命令，以验证新文件、依赖和 ACL；移动 / 删除目录或后续 `chmod` 改变 ACL mask 可能使服务不可用。私有存储与自定义外部资源不会因源码 ACL 授权而自动迁移或开放。

## 新安装和旧部署兼容

- 源码可以保留在 `/home/<用户>/identale` 等原下载目录，由上述定向 ACL 提供运行访问。源码位于 `/root` 仍拒绝；root 的 nvm Node 不会直接复用，缺少可用系统 Node 时按下载策略准备 `/opt/identity/` 下的 Node，不开放 `/root`。
- 部署时停止既有应用服务，再调整明确的数据目录、会话 / 执行目录、Skill 存储及 SQLite 数据库与 sidecar 的归属。目录使用 0700，普通文件使用 0600，文件原有的属主执行位保留。数据库父目录中的无关文件不会递归改权；源码、Node、`/etc/identity`、备份和证书不交给服务账号。默认 `/var/lib/identity` 作为 root 所有的 0711 遍历目录，其下服务数据仍为私有目录。
- 保留已有数据库、记录、PI 状态、自定义 Skill 路径及主密钥，不自动迁移数据或轮换密钥。新安装默认 Skill 路径为平台数据库目录下的 `skills/`。若旧部署隐式使用 root 家目录中的 Skill 存储，安装器保留该位置并拒绝自动改权，需先评审资源及其数据库路径的显式迁移，不能仅复制文件后切换为空目录。
- 从 npm Argon2 版本升级时，按正常流程重新构建后复用平台数据库。应用用 Node 内置 Argon2id 校验原密码哈希，旧账号继续使用原密码登录。部署在停止旧服务前以 `identity` 账号验证新构建的密码适配器。
- 数据路径中的符号链接、硬链接和特殊文件，以及系统目录或与源码 / 私有配置重叠的存储范围，需要管理员单独处理。安装器拒绝这些路径，不沿链接递归修改权限。自定义数据路径的私有祖先目录不会被自动放宽；自定义 Host registry 应允许 `identity` 读取，其中的执行根需预先归属 `identity` 并保持私有，或处于该账号可创建目录的位置。
- 正常模型调用、任务目录读写、脚本执行与网络请求仍按配置运行。系统软件安装、系统配置变更等提权操作默认失败，依赖由管理员预先准备。服务标准输出继续进入 systemd journal。

存储改权前在 `/etc/identity/backups/` 本次备份中写入 `permissions.json`，记录原 UID / GID、权限和文件身份；源码访问 ACL 单独使用上述 `checkout-acl.jsonl`。部署失败时尝试恢复配置、前端链接、原权限 / ACL 和先前运行的服务；不回滚任务副作用，不删除启动后新生成的业务数据。文件被替换等情况可能需要按备份人工处理。失败后保留专用系统账号和备份，不自动删除账号或业务数据。

## 配置与数据位置

| 默认位置 | 用途 |
| --- | --- |
| `/etc/identity/control-plane.env` | 平台配置和其作用域凭据 |
| `/etc/identity/runtime.env` | 运行服务配置及对应凭据 |
| `/etc/identity/runtime-host.env` | PI Host 配置及对应凭据 |
| `/etc/identity/local-secrets.json` | 私有凭据原件 |
| `/etc/identity/tls/` | TLS 证书与私钥 |
| `/var/lib/identity/platform/` | 平台数据库 |
| `/var/lib/identity/runtime/` | 运行数据库和相关记录 |
| `/var/lib/identity/platform/skills/` | 新安装默认 Skill 存储 |
| `/var/lib/identity/runtime-host-pi/` | PI 状态、会话及发布产物 |
| `/var/lib/identity/runtime-host-pi-execution/` | 默认任务工作目录 |
| `/var/lib/identity/service-home/` | 服务账号主目录与用户级缓存 |
| `/srv/identity/web` | 已构建前端发布链接 |

不要把上述目录、配置备份、TLS 私钥或生产记录提交到仓库。无证书时脚本可生成自签名证书，浏览器不会因此自动信任；公共证书、DNS、防火墙、备份和网络策略由部署者处理。

部署名称仍复用 `identity-*` 服务和上述路径。同机已有旧 Identity 部署时，安装脚本可能进入更新 / 停止现有服务的流程，而不是创建完全独立的 Identale 实例；部署前先核对现有服务、数据、凭据和备份，不把目录改名当作隔离。

## OAuth 回调与代理日志

随部署生成的 Nginx 配置使用专用访问日志 `/var/log/nginx/identity-access.log`，只记录客户端 IP、时间、请求方法、无查询参数的路径、协议、状态及响应字节数；HTTPS 服务及 HTTP / 443 重定向均不记录查询字符串或 Referer。飞书个人 OAuth 回调 `/api/business-resources/feishu/callback` 额外关闭访问日志，并将该位置的错误日志丢弃，避免上游连接失败时错误日志保存完整含 `code` / `state` 的请求 URL。代价是该回调没有 Nginx 请求级诊断，排查时使用应用返回的无凭据状态，不开启原始 URL 日志。

已有服务器需要重新部署配置后才生效，本次源码变更不会清理历史日志。自行配置的外层代理、CDN、Nginx 全局调试 / 请求解析错误日志和监控采集不在上述路由保护范围，部署者仍需确认它们不采集授权参数与 Referer，并按自身日志策略保留、轮转和处理旧记录。不要将真实 OAuth URL 放入工单或公开日志。

## HTTP 请求体限制

[Nginx 模板](../scripts/deploy/templates/nginx.conf.template)默认仍限制为 16 KiB，仅对后端明确接受更大 JSON 的路径设置例外：

| 路径范围 | 上限 |
| --- | --- |
| 工作区 `skills/imports` | 29 MiB，容纳最多 20 MiB ZIP 的 base64 JSON 包装 |
| 工作区 Skill / MCP 资源写入及发现 / 状态接口 | 400000 字节 |
| 员工 `group-sharing` | 1 MiB |
| 员工 Trigger 配置 / 凭据、历史策略 / 预览及公开 webhook / GitHub 入口 | 128000 字节 |

完整路径匹配以模板为准，不能将整站改为无限上传。后端独立校验继续生效；公开 webhook 上限按平台转发入口的 128000 字节对齐，不按运行侧独立入口的较大限额扩大。隐藏路径与 `/internal/` 仍拒绝公开访问。

这项修复已做模板匹配和后端定向测试；在目标 Linux 服务器部署时，建议执行 `nginx -t` 并验证合法、超限和不适用路径的大请求往返。

服务器部署前请在隔离 Linux 主机验证系统账号创建、systemd 服务启动、权限配置与失败恢复流程。
