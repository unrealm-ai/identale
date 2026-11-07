<!-- Modified for Identale; see the root NOTICE. -->

# 开发指南

本指南面向源码贡献者。先读 [CONTRIBUTING.md](CONTRIBUTING.md)、[当前实现范围](docs/STATUS.md)和[公开规格](docs/spec/README.md)，再选择相关模块。本页列出的命令为可用开发入口说明。

## 环境与安装

版本以 `package.json`、`package-lock.json` 和 `.nvmrc` 为准。Node.js 版本为 `>=24.19.0 <25`，npm 为 `11.9.0`，TypeScript 为 `6.0.3`。后端使用 Node 内置 SQLite 和 Argon2id。

推荐从仓库根目录运行：

```sh
bash scripts/start.sh
```

统一入口按需准备固定版本 Node、依赖和构建，然后初始化并启动本地实例。本地开发使用普通用户启动。遇到系统依赖或网络下载问题时，查看对应阶段的脚本输出。

本地启动默认输出 `[Identale]` 阶段提示，包含开始、完成 / 就绪、失败或中断及耗时。兼容 Node 和依赖复用、`--no-build` 复用产物会明确标记。Node 下载在交互终端显示 curl 进度条，重定向时使用普通文本；下载、依赖安装、编译和服务就绪等待每 10 秒输出一次 `still running` 及已耗时。校验、解压和配置检查也有阶段提示。完成、失败或中断后停止对应的定时提示。

`npm run build` 和 Web 工作区的构建入口同样显示后端 TypeScript 编译、前端类型检查及 Vite 打包的独立状态，保留编译器、npm 和 Vite 的原始输出与失败退出码。无法计算真实百分比的步骤只报告状态和耗时。服务就绪继续使用原有监听归属检查及可选健康检查，不代表真实模型连接通过。

Web 构建保留 Vite 参数透传，例如 `npm run build --workspace @dentity/web -- --base=/review/`。`--` 后的参数只传给 Vite 打包，前端类型检查仍执行 `vue-tsc --noEmit`；包含空格的参数值继续按独立参数传递。

Debian / Ubuntu、systemd 环境的服务器入口为：

```sh
sudo bash scripts/start.sh --host IP_OR_DOMAIN
```

该分支按需安装系统工具（含 `acl`）、Node 和项目依赖，构建并配置 systemd、Nginx 与 HTTPS。安装使用 root，应用服务与任务使用禁止登录的 `identity` 普通账号。代码留在原目录，安装器通过定向 ACL 授权运行文件及必要上级目录的遍历，支持 `/home/<用户>/identale` 与私有 home，不递归开放 home 或更换代码属主。源码仍需放在 `/root` 之外；root 的 nvm Node 会改用受管版本。文件系统需支持 ACL，更新后重新部署以检查新增文件；旧数据和密钥仍按原配置保留。参数、ACL 备份 / 回退和验证边界见[部署说明](docs/deployment.md)。

已有兼容 Node 和 npm 时，可分步执行；`npm run local:start` 与统一入口共用本地启动实现，新安装自动创建缺失的私有凭据，已有数据缺少原凭据时拒绝启动：

```sh
npm ci
npm run build
npm run local:start -- --no-install --no-build
```

上述命令会安装依赖、生成构建文件和持久数据，不是只读检查。执行前确认使用独立数据与获准的资源。Windows、额外发行版及 CPU 架构的兼容性需要对应环境验证。

仅需单独初始化本地凭据时，可选运行 `npm run local:init`；正常一键启动无需先执行它。

## 脚本用途

| 文件 / 目录 | 用途 |
| --- | --- |
| `scripts/start.sh` | 本地和 Linux `--host` 的统一安装 / 启动入口 |
| `scripts/local/` | 本地启动、初始化、环境加载、进程管理、恢复和诊断；`local-init.mjs` 为可选手动入口 |
| `scripts/deploy/` | Linux systemd 安装、服务身份、部署配置、证书和前端发布实现 |
| `scripts/deploy/templates/` | systemd、Nginx 与服务环境变量模板 |
| `scripts/shared/` | 两种模式共用的 Node 准备、凭据和路径 |
| `scripts/maintenance/` | 显式离线迁移 / 归档工具，不参与正常安装启动 |
| `scripts/test/` | 启动、停止、重启及部署配置测试，不参与正常启动 |

旧 `scripts/setup.sh` 已并入 `scripts/start.sh --host`；旧 `scripts/start-local.mjs` 已并入 `scripts/local/local-start.mjs`。日常命令 `bash scripts/start.sh`、`npm run local:start`、`npm run local:init` 保持不变；直接调用内部文件时使用新目录。内部模块由启动链路调用，不应按文件名逐个删除。恢复逻辑同时识别整理前后的本地启动 / 管理进程入口，仍核验用户、进程身份和工作目录。

## 按改动寻找代码

| 改动主题 | 优先阅读 | 主要落点 |
| --- | --- | --- |
| 领域准入与规则 | `packages/domain/src/authorization.ts` | `packages/domain`；不要引入供应商 SDK |
| Task / Run、输入和投递 | `packages/application/src/tasks/service.ts`、`ports.ts` | 应用层用例与 `apps/control-plane/src/adapters/sqlite` |
| HTTP / 服务装配 | `apps/control-plane/src/split/server.ts`、`bootstrap.ts` | 平台 / 运行入口、路由、配置同步 |
| builtin 交互与记录 | `packages/runtime-builtin/src/runtime.ts`、`journal.ts` | 模型 / 工具循环、输入队列、摘要及索引 |
| PI 执行与本地工具 | `apps/runtime-host-pi/src/adapter.ts`、`pi-worker.ts` | Host、worker、配置资源、事件与人工边界 |
| 渠道 / 身份 | `packages/application/src/channels/ports.ts` | `apps/control-plane/src/adapters/channels`、`channel-loop` |
| Web | `apps/web/src/App.vue`、`api.ts` | Vue 组件、工作台与样式；复用 Naive UI / 现有 token |

改契约先核对 `packages/contracts/src` 与两侧调用方；改持久化同时检查表归属、旧结构拒绝条件及备份 / 迁移方案。不是所有应用用例都已从控制平台完全抽离，按实际代码维护，不为目录整齐顺带重构。

新增 Runtime 先核对 `AgentProvisioningPort`、`AgentSessionPort`、`AgentExecutionPort` 与可选维护 / 交互事件能力，明确哪些不支持。新增渠道先看[渠道能力与扩展](docs/spec/26-channel-capabilities.md)，不要复制某个供应商的能力声明后假定可用。

## 服务与配置

| 服务 | 本地默认端口 | 入口 |
| --- | --- | --- |
| Web | 15173 | `apps/web` 的 Vite 服务 |
| 控制平台 | 18300 | `apps/control-plane/src/main.ts` |
| 交互 / 任务服务 | 18304 | `apps/control-plane/src/runtime-main.ts` |
| PI Host | 18301 | `apps/runtime-host-pi/src/main.ts` |
| 合成模型（显式启用） | 18302 | `apps/mock-model/src/main.ts` |
| 合成 MCP（显式启用） | 18303 | `apps/mock-model/src/mcp-main.ts` |

默认服务绑定 loopback。四个正常服务由本地管理进程启动；带 `--mock` 时增加两个合成服务。平台与 PI Host 是独立进程。查看参数可以运行 `bash scripts/start.sh --help`。

[.env.example](.env.example)提供可复制的本地默认配置。`bash scripts/start.sh`、`npm run local:start` 和 `npm run local:init` 在缺少 `.env` 时自动创建，并在每次运行时读取；已有 `.env` 不覆盖。优先级为进程环境变量 → `.env` → 代码默认值。首次生成的文件权限为 `0600`，路径来自显式环境配置或 `~/.identale` 默认目录，不探测旧目录。直接启动 Node 服务不会自动读 `.env`；systemd 继续读取 `/etc/identity/` 下的受保护环境文件。

`.env` 使用 Node 内置解析器，只加载 `DENTITY_*` 配置，不执行 Shell、不展开 `$HOME` 或命令替换。路径配置支持 `~/`，相对路径以仓库根为基准。空的可选配置使用程序默认值；明确的 `false` 不会被启动器改成 `true`。

- `DENTITY_DATABASE_PATH`：平台库，新安装默认 `~/.identale/platform/platform.sqlite`。
- `DENTITY_RUNTIME_DATABASE_PATH`：运行库，新安装默认 `~/.identale/runtime/runtime.sqlite`，必须与平台库分开。
- `DENTITY_BUILTIN_RECORD_ROOT`：内置会话记录根，默认位于运行库旁的 `builtin-records`。
- `DENTITY_LOCAL_SECRETS_PATH`：默认 `~/.identale/local-secrets.json`，必须位于仓库外。
- `DENTITY_RUNTIME_HOST_STATE_DIR`：新安装默认 `~/.identale/runtime-host-pi`。
- `DENTITY_MODEL_MASTER_KEY`：平台解密凭据用的规范 base64、32 字节主密钥，不得提交。
- `DENTITY_APP_ORIGIN`、`DENTITY_SECURE_COOKIES`：浏览器访问 Origin 与 Cookie 安全设置；非 loopback 必须 HTTPS 与安全 Cookie。
- `DENTITY_MODEL_ALLOW_LOOPBACK_HTTP`：仅显式开启本地 HTTP 模型连接；正式模型地址使用 HTTPS。
- `DENTITY_MCP_ALLOWED_ORIGINS`：按配置允许 MCP Origin，不代表外部业务授权。
- `DENTITY_SKILL_RESOURCE_ROOT`：Skill 源文件根，新安装默认 `~/.identale/resources/skills`。

本地服务端口可在 `.env` 中通过 `DENTITY_WEB_PORT`、`DENTITY_CONTROL_PLANE_PORT`、`DENTITY_RUNTIME_SERVICE_PORT`、`DENTITY_RUNTIME_HOST_PI_PORT` 配置；可选 Mock 使用 `DENTITY_MOCK_MODEL_PORT` 和 `DENTITY_MOCK_MCP_PORT`。启动器据此生成内部 URL、Web 代理目标和端口检查；显式配置的 Origin / 内部 URL 必须与本机端口一致，不匹配时明确报错。HTTPS 及远程地址使用服务器部署配置。

模型与渠道密钥通过已认证的配置页面保存。模型地址、model ID、协议与供应商支持需要实际验证，不因保存配置就视为联调成功。

## 私有凭据与本地状态

macOS / Linux 本地默认统一使用 `~/.identale`：凭据目录 / 文件权限为 `0700` / `0600`，按需下载的 Node 位于 `~/.identale/node`，启动锁、控制接口和诊断记录位于 `~/.identale/launchers/<仓库路径摘要>/`。兼容版本的 Node 与 npm 在 `PATH` 中可用时直接复用。

本地启动不再自动选择 `.dentity` 数据库与启动器目录、`var/runtime-host-pi`、`~/.identity/resources/skills`、旧用户级凭据或旧托管 Node 目录；启动器不会为切换默认路径搬迁、删除或改写这些文件。已有 `.env` 和进程环境变量显式指定的路径仍然生效，新旧凭据同时存在也只读取选中的路径。选中的平台库或运行库已存在但原密钥缺失时，拒绝生成替代密钥；目录权限、链接检查与数据库结构检查继续执行。

已有数据如需复用，须显式配置相互匹配的数据库、正文、PI 状态、Skill 根与原凭据，不能依靠目录自动发现。数据路径及数据库旁记录存在绑定，不能仅把 `.dentity` 改名为 `.identale` 就宣称迁移完成。启动器不读取旧 `.dentity/local-launcher` 的实例记录；切换前应先在旧实例终端停止服务。服务器部署目录与配置保持原规则。

这些位置以及默认 Skill 根在仓库外，同一用户的多个 checkout 可能共用数据。仅复制源码不会创建隔离实例；独立试用需显式配置独立数据库、记录、PI 状态、仓库外凭据、Skill 根及端口。不要以不同端口同时运行同一份数据库和状态。

端口预留失败会报告具体服务、`127.0.0.1:端口` 和系统错误码（例如 `EADDRINUSE`），释放本次已预留的端口，并在执行项目依赖安装 / 构建及启动业务服务前退出；Shell 层的 Node 准备和私有凭据初始化可能已完成。启动器仅接管同一仓库的已核验实例；其他目录的旧项目仍在运行时，请先在旧实例终端按 `Ctrl+C`，再启动新目录。

重复执行启动命令会自动停止并重启当前仓库的旧实例，无需先手动停止。正常情况通过已核验的控制接口退出；旧启动器返回清理未核验、状态文件缺失或留下已知入口进程时，按相同用户、进程身份、实际 Node 入口和工作目录核验后回收，必要时对已核验的进程升级终止信号。服务的中间恢复检查报错后，仍独立确认已登记进程组为空且子进程退出；只有确认完成才继续启动。未能确认归属的存活进程、其他目录的占用者和运行中的服务器实例仍会明确拒绝，不按端口号直接结束进程。

启动器复用已有数据和密钥。已有数据库但原密钥缺失时应停止并恢复原凭据，不能生成替代密钥尝试解密。不要把旧库、记录或凭据复制进公开仓库。

## 构建与测试

以下是仓库已有入口，列出命令不代表本次已运行：

| 命令 | 范围 |
| --- | --- |
| `npm run build` | TypeScript 工作区与 Web 构建 |
| `npm run typecheck` | 后端与 Web 类型检查 |
| `npm run test:domain` | 领域规则 |
| `npm run test:accounts` | 账号相关测试 |
| `npm run test:builtin` | 内置交互 Runtime |
| `npm run test:runtime-host` | PI Host、真实 SDK 与本地合成服务链路 |
| `npm run test:control-plane` | 平台及运行服务 |
| `npm run test:web` | 前端组件 / 页面模拟测试 |
| `npm run test:local` | 本地启动与部署脚本 |
| `npm run test:mock-model` | 合成模型及 MCP |
| `node --test scripts/test/web-licenses.test.mjs` | 真实 Web 构建、许可完整性、重建和发布目录复制 |
| `npm test` | 根脚本声明的后端与启动相关组合，不包含 `test:web` |

先根据改动确认技术与测试方案，再运行相关范围；不要默认执行全量回归。测试应使用独立临时数据库、文件和端口；现有 fixture 包含 MockRuntime、脚本模型和本地合成服务，部分测试实际执行 PI SDK、worker 和文件 / Bash 操作。环境跳过、未运行与失败必须分别报告。

真实模型可能收费；企业渠道、邮件或业务系统测试可能产生真实副作用，必须单独确认范围与账号。导入源码或运行 Mock 测试不构成这些授权。

### 定向运行与结果记录

已有 npm 模块入口会先构建对应 TypeScript 项目。需要只执行一个测试文件时，先检查其依赖和 fixture，再构建必要工作区，例如领域规则的定向检查：

```sh
./node_modules/.bin/tsc -b packages/domain
node --test packages/domain/test/authorization.test.mjs
```

以上只是可用命令示例，本轮文档更新没有执行它。其他测试可能还需要 Host、Mock 或平台构建，不能未经核查套用同一前置命令。项目当前没有根 `lint` 脚本，不要在贡献说明中虚构一个。

自动化与合成 Mock 测试默认保留；`test/manual` 中的合成浏览器脚本不会由根 `npm test` 自动执行，运行前仍需检查依赖和副作用。

纯文档变更只检查路径 / 链接、接口和状态命名、实现 / 规划区分、Markdown 结构及公开内容；不为文档调整运行无关业务测试。报告时分别写通过、失败、跳过和未运行，不能把静态链接检查称为集成通过。

部分现有故障诊断用例在失败时可能写入 `docs/verification/`，该目录已忽略，仅供本机排障。分享日志前仍需逐项脱敏。

## 数据与部署

备份、恢复和路径约束见[存储规格](docs/spec/17-conversation-storage-and-retention.md)。服务器脚本默认使用普通服务账号，仍无任务级 OS 沙箱，兼容与部署边界见[部署说明](docs/deployment.md)。不要为了文档整理或公开内容检查运行初始化、迁移或部署。
