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
  <template v-else-if="provider==='dingtalk'"><ul><li>启用机器人，接收私聊和群 @ 消息，使用 Stream 模式。</li><li>开放应用可见范围内的部门、成员及姓名读取权限。</li><li>按官方要求完成应用发布和审批。</li></ul><p class="field-note">群历史和会议材料不在当前接入能力内。</p></template>
  <template v-else><p>启用智能机器人 API 长连接。目录读取权限在上方通讯录应用中单独配置；保存后需核对同企业关系和机器人身份。</p></template>
</section>
</template>
<style scoped>.setup-requirements{font-size:var(--id-font-size-meta);line-height:1.6;max-width:var(--id-form-max-width)}h4{display:flex;align-items:center;margin:0;font-size:var(--id-font-size-body);font-weight:600}ul{padding-left:1.25rem;margin:.5rem 0}li+li{margin-top:.5rem}code{overflow-wrap:anywhere;font-size:.8125rem;color:var(--text)}summary{cursor:pointer;color:var(--text)}p{color:var(--muted);margin:.5rem 0}</style>
