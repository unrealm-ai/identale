<!-- Modified for Identale; see the root NOTICE. -->

# 员工应用连接指南静态配图

图片随前端仓库本地提供，不使用第三方图片热链。

## 官方创建应用截图

- `dingtalk-create-app.jpg`：复用仓库已下载的钉钉官方教程原图，逐字节复制自 `../channel-guides/dingtalk-create-app.jpg`，未编辑。图像已检查；未发现可见明文凭据，账户区域由官方打码。
- 原图：https://open-dingtalk.github.io/developerpedia/assets/images/create-app-f585e510028ef5a38de891809ee40094.jpg
- 来源页面：[钉钉开发者百科：创建机器人应用](https://open-dingtalk.github.io/developerpedia/docs/explore/tutorials/stream/bot/nodejs/create-bot/)。这里只演示企业内部应用创建，不将机器人教程作为通讯录权限说明；不使用“启用机器人”配图。示例应用名称无需照填，图片为历史控制台版本。
- 官方仓库：https://github.com/open-dingtalk/developerpedia
- 许可：[MIT](./LICENSE.dingtalk.txt)，© 2023 钉钉开放平台团队；许可原文：https://github.com/open-dingtalk/developerpedia/blob/main/LICENSE 。许可随本地图片复制保留。

## 就近关联的官方文档

- [飞书：企业自建应用开发流程](https://open.feishu.cn/document/home/introduction-to-custom-app-development/self-built-application-development-process)
- [飞书：获取 tenant_access_token](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/tenant_access_token)
- [飞书：通讯录权限范围](https://open.feishu.cn/document/server-docs/contact-v3/scope/list)
- [飞书：部门信息](https://open.feishu.cn/document/server-docs/contact-v3/department/get)
- [飞书：用户信息](https://open.feishu.cn/document/server-docs/contact-v3/user/get)
- [钉钉：企业内部应用 accessToken](https://open.dingtalk.com/document/orgapp/obtain-orgapp-token)
- [钉钉：通讯录权限范围](https://open.dingtalk.com/document/orgapp-server/obtain-corpsecret-authorization-scope)
- [钉钉：通讯录权限配置](https://open.dingtalk.com/document/orgapp-server/address-book-permissions)
- [钉钉：部门列表](https://open.dingtalk.com/document/orgapp-server/obtain-the-department-list-v2)
- [钉钉：查询用户详情](https://open.dingtalk.com/document/orgapp-server/query-user-details)
- [钉钉官方组织同步示例](https://github.com/open-dingtalk/h5app-org-sync-demo)：仅引用部门信息、成员信息、部门成员三项读取权限；不要求示例另列的通讯录写权限。

指南不硬编码未经核实的权限 code；权限名称、菜单和租户可用范围以官方文档与控制台为准。每个员工使用独立应用和机器人，同应用提供消息和通讯录能力。钉钉 app_scoped 仅验证应用身份，不宣称已验证企业 corpId。飞书 open_id 受应用作用域限制，display_id 不作为 tenant_key。平台只动态查询当前应用范围，不保存全量组织或运行周期同步。
