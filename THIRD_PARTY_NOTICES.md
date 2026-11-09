# 第三方软件与资源说明

项目自身源码采用 [Apache-2.0](LICENSE)。此许可不覆盖第三方依赖、商标或另有声明的资源。相关版权与许可应在源码、前端构建和其他再分发中保留；不能仅保留本页而删除原许可。

## npm 依赖

版本由 `package-lock.json` 固定。直接依赖与全部锁定依赖的许可元数据见[依赖清单](docs/dependency-licenses.md)。该清单是元数据盘点，不是兼容性或漏洞审计结论。

本仓库不提交 `node_modules` 或 Web 构建产物。Web 构建现在按 Rollup 实际保留模块与输出资源收集依赖，自动在 `dist/` 保留项目 `LICENSE`、`NOTICE`、本页、完整文本聚合 `THIRD_PARTY_NOTICES.txt` 及 `third-party-licenses.json`。仅在实际注入运行时辅助代码时纳入 Vite / Vue 插件，不把整个开发依赖树列作前端依赖。原始包的完整许可和独立 NOTICE 原文保留，静态资源原通知也继续随目录复制。

css-render 0.15.14 三个包的缺失许可由对应上游源码提交的原文补充。**vdirs 0.1.8 的版权证据仍待维护者确认**：发布包仅声明 MIT，未提供原始版权通知；构建包含完整标准 MIT 条款、真实作者元数据和明确警告，不臆造版权人或年份，不能据此宣称所有上游版权证据已完整。补充来源与限制见[版本限定许可补充](scripts/build/license-overrides/README.md)，构建及部署校验见[前端分发许可](docs/frontend-distribution-licenses.md)。其他二进制或容器分发仍应另行核对其实际内容。

## 随源码提供的图片和图标

| 资源 | 来源与许可说明 |
| --- | --- |
| 钉钉教程 JPG | 来自 `open-dingtalk/developerpedia`；保留 MIT 原文及版权，见 [渠道指南来源](apps/web/public/channel-guides/SOURCES.md)、[MIT 文本](apps/web/public/channel-guides/LICENSE.dingtalk.txt)与[目录指南来源](apps/web/public/directory-guides/SOURCES.md) |
| `thumbs-01.svg` 至 `thumbs-12.svg` | DiceBear Thumbs，CC0 1.0；见[头像许可](apps/web/public/employee-avatars/LICENSE.md) |
| `cn-v2-01.webp` 至 `cn-v2-27.webp` | 使用图像生成工具制作的预设，和 DiceBear 是不同资源；项目将可授权的权利按 Apache-2.0 提供，来源与权利说明见 [CN-V2.md](apps/web/public/employee-avatars/CN-V2.md) |
| 操作示意 SVG、自动化图标与品牌 SVG | 随项目提供；操作示意不是官方控制台截图。不据项目许可推定第三方商标权 |
| 飞书、钉钉、企业微信图标 | 官方资源，仅用于标识对应集成，商标权归各自所有者；见[图标来源](apps/web/public/channel-logos/SOURCES.md) |

## 外部资料

文档中的官方标准与产品说明链接仅供参考，不表示将其正文或图片整体纳入本项目许可。新增第三方素材时，应一并提交许可依据、原通知、版本 / 来源和适用范围。


### 钉钉扫码注册协议参考

钉钉扫码接入独立实现参照 [DingTalk-Real-AI/dingtalk-openclaw-connector 的 device-auth.ts](https://github.com/DingTalk-Real-AI/dingtalk-openclaw-connector/blob/main/src/device-auth.ts) 及 device-auth-config.ts 的公开协议，2026-11-09 核对。上游项目为 MIT，Copyright (c) 2026 DingTalk Real Team；[原许可](https://github.com/DingTalk-Real-AI/dingtalk-openclaw-connector/blob/main/LICENSE)。本项目未复制其实现、未打包该插件或 DWS，不复用其来源标识，也不因代码许可取得钉钉平台授权。
