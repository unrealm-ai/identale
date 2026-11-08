<script setup lang="ts">
import type {DirectoryProvider} from '../directory/types';
import InfoHint from '../../shared/ui/InfoHint.vue';
defineProps<{provider:DirectoryProvider}>();
</script>
<template>
<section class="setup-requirements" aria-label="需要申请的权限">
  <h4>需要申请的权限<InfoHint label="权限与可用范围">请在对应应用中授权并限定数据范围。保存配置不代表已获权限；以下验证结果以实际读取为准。</InfoHint></h4>
  <template v-if="provider==='feishu'">
    <ul><li>接收私聊与群 @ 消息、以机器人身份发送消息：<code>im:message.p2p_msg:readonly</code>、<code>im:message.group_at_msg:readonly</code>、<code>im:message:send_as_bot</code></li><li>读取企业、人员姓名及部门：<code>tenant:tenant:readonly</code>、<code>contact:user.base:readonly</code>、<code>contact:user.department:readonly</code>、<code>contact:department.base:readonly</code>、<code>contact:department.organize:readonly</code><InfoHint label="通讯录权限覆盖">已有广义权限覆盖时无需重复申请细粒度项，同时配置可见人员和部门。</InfoHint></li></ul>
    <p class="field-note">订阅 <code>im.message.receive_v1</code>，使用长连接接收事件；权限修改后按官方要求发布应用。</p>
    <details><summary>可选：群上下文与会议材料权限</summary><p>普通群消息需 <code>im:message.group_msg</code>；群历史基础读取满足 <code>im:message:readonly</code>、<code>im:message</code>、<code>im:message.history:readonly</code> 任一，并确保机器人在目标群中。</p><p>妙记逐字稿：<code>minutes:minutes.transcript:export</code>；已有纪要：<code>minutes:minutes.artifacts:read</code>。需同时拥有具体材料访问权。</p></details>
  </template>
  <template v-else-if="provider==='dingtalk'">
    <ul><li>创建企业内部应用并启用机器人，使用 Stream 接收私聊和群 @ 消息，不使用群自定义 Webhook。</li><li>机器人主动发送：<code>qyapi_robot_sendmsg</code>。Stream 在线不代表已获发送权限。</li><li>读取部门、部门成员和成员详情：<code>qyapi_get_department_list</code>、<code>qyapi_get_department_member</code>、<code>qyapi_get_member</code>；同时设置应用可见部门/人员范围，核对必要的上级部门。</li><li>按官方要求完成审批和版本发布，再将机器人加入测试群；首条通过校验的真实消息自动确认机器人身份。</li></ul>
    <p class="field-note">权限名称以当前控制台为准，验证结果以实际读取为准。基础姓名/部门接入不要求手机号、邮箱或流式卡片权限。</p>
    <p class="field-note">普通群消息不在当前员工机器人接入能力内。群历史和会议材料不在当前接入能力内。</p>
  </template>
  <template v-else>
    <ul><li>启用智能机器人 API 长连接，仅需 BotID / Secret。同一机器人仅由一个服务维持连接，不与 URL 回调同时使用。</li><li>新建默认空白名单，群内可用；私聊需加入白名单或切换全员 + 黑名单。可独立设置仅允许名单或排除名单；成员搜索直接使用机器人凭据。</li></ul>
    <p class="field-note">长连接在线后，首条通过校验的真实消息自动确认身份。使用范围不代表公司全量员工，也不按内外部联系人身份排除。</p>
  </template>
</section>
</template>
<style scoped>.setup-requirements{font-size:var(--id-font-size-meta);line-height:1.6;max-width:var(--id-form-max-width)}h4{display:flex;align-items:center;margin:0;font-size:var(--id-font-size-body);font-weight:600}ul{padding-left:1.25rem;margin:.5rem 0}li+li{margin-top:.5rem}code{overflow-wrap:anywhere;font-size:.8125rem;color:var(--text)}summary{cursor:pointer;color:var(--text)}p{color:var(--muted);margin:.5rem 0}</style>
