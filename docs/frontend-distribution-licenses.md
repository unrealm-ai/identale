<!-- Modified for Identale; see the root NOTICE. -->

# 前端分发许可

## 构建与发布

在仓库根运行 `npm run build`，或仅运行
`npm run build --workspace @dentity/web`，都会生成以下 `apps/web/dist/` 文件：

- `LICENSE`、`NOTICE`、`THIRD_PARTY_NOTICES.md`：从仓库根逐字节复制。
- `THIRD_PARTY_NOTICES.txt`：实际前端依赖随包提供的完整许可、版权与独立 NOTICE，版本限定补充及未决归属说明，和静态资源的原通知。
- `third-party-licenses.json`：包名、版本、许可元数据、实际保留模块、通知来源与 SHA-256，以及构建 JS / CSS / HTML 的 SHA-256。
- `public/` 中已有的资源目录、LICENSE 和来源说明继续按 Vite 默认行为复制到产物根目录。

不要单独复制 `assets/` 发布，应保留整个 `dist/`。服务器部署入口在配置服务前校验这些材料和当前锁文件；即使使用 `--skip-build`，缺失 / 不一致也会拒绝继续。发布复制使用同一个校验函数在复制前后核验，不会因部署只复制静态文件而丢失许可。这里的完整性校验防止意外漏文件，不是签名或恶意篡改防护。

`scripts/build/web-licenses.mjs` 接入 Vite build 的最后阶段，按 Rollup 输出 chunk 的非空 rendered modules 及输出资源 `originalFileNames` 判断依赖。构建工具不因安装就被纳入，但 Vite 的 modulepreload / preload 辅助代码与 Vue 插件的 export helper 确实随浏览器产物分发，因此保留其完整上游许可文件。上游许可文件可能同时描述未进入本应用的工具内部依赖；这些说明原样保留，不据此把它们误列为独立打包包。

模块相对各自 package 根记录，不公开本机绝对路径。生产构建只读取本地锁定依赖和已核实补充材料，不在线下载许可，不读取应用凭据。缺少许可、版本与锁文件不符、补充文本校验和变化时构建失败。依赖升级、新的虚拟运行时模块或另外注入的预打包资源需要重新核对收集范围；该清单不是通用许可证兼容性审计或法律保证。

## 当前核验边界

当前输出包含 19 个 npm 应用依赖包，以及 Vite / Vue 插件的运行时辅助代码，共 21 个包记录。准确清单以每次构建生成的 JSON 为准，不维护另一份手工包列表。

- css-render、`@css-render/plugin-bem`、`@css-render/vue3-ssr` 的 0.15.14 发布包漏带根 LICENSE，已核对上游同一源码提交的三个 package.json 和完整 MIT 原文，补充文件按版本、锁文件 integrity 和 SHA-256 限定。
- `@juggle/resize-observer@3.4.0` 保留完整 Apache-2.0 及 `Copyright 2019 JUGGLE LTD`；实际安装包没有独立 NOTICE，不创建虚构 NOTICE。
- `vdirs@0.1.8` 仅有 MIT 声明和作者元数据，没有原始版权 / LICENSE。完整标准 MIT 条款已随包保留，构建与产物会明确警告，不推定作者就是版权人。**公开再分发前仍需取得上游版权通知或选择获准的替代依赖，当前不能声称版权证据完整。** 这不阻断本地构建运行。
- 静态素材现有权利待确认项仍见根第三方说明，本次自动携带通知不等于新增素材授权。

原始来源、版本证据和标准条款的处理见
[许可补充说明](../scripts/build/license-overrides/README.md)。

## 定向验证

运行 `node --test scripts/test/web-licenses.test.mjs`。测试使用真实项目与已安装依赖，在独立临时目录构建两次，核对实际模块集合、逐字节原文、静态资源通知、确定性重建、生产发布复制函数，以及缺失通知 / 产物变化时拒绝复制。它不启动现有实例，不接触真实数据库，也不执行 Linux systemd / Nginx 部署。

构建后可直接检查 `dist/` 的五份许可材料。测试入口的存在不代表任何 Linux 实机或真实业务集成已通过。
