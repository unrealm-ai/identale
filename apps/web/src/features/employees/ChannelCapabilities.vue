<!-- Modified for Identale; see the root NOTICE. -->
<script setup lang="ts">
import { computed } from 'vue';
import { NTag } from 'naive-ui';
import BusinessResourceConfiguration from '../business-resources/BusinessResourceConfiguration.vue';
import type { DirectoryProvider } from '../directory/types';
import type { ChannelCapability, ChannelConfigurationCapabilities } from '../directory/types';
const props = defineProps<{ capabilities: ChannelConfigurationCapabilities | undefined; provider:DirectoryProvider }>();
const emit=defineEmits<{sessionExpired:[]}>();
const labels = { available: '配置可用', authorization_required: '需要授权或验证', unsupported: '当前未接入', unknown: '尚未核验' };
const rows = computed(() => {
  const c = props.capabilities;
  if (!c) return [];
  const rows: {label:string; capability:ChannelCapability | undefined}[] = [
    {label:'私聊消息',capability:c.privateMessages}, {label:'群聊 @ 消息',capability:c.groupMentions},
    {label:'群聊定向机器人消息',capability:c.directedGroupMessages},
    {label:'普通群消息',capability:c.ordinaryGroupMessages}, {label:'关键词触发',capability:c.keywordTriggers},
    {label:'近期群消息上下文',capability:c.recentGroupContext}, {label:'通讯录读取',capability:c.directoryRead},
  ];
  for (const direction of ['inbound','outbound'] as const) for (const scope of ['private','group'] as const) for (const kind of ['image','file'] as const)
    rows.push({label:`${scope==='private'?'私聊':'群聊'}${direction==='inbound'?'接收':'发送'}${kind==='image'?'图片':'文件'}`,capability:c.media?.[direction][scope][kind]});
  return rows.filter(row => row.label !== '群聊定向机器人消息' || row.capability?.supported);
});
</script>
<template>
  <section class="form-section capability-section" aria-label="渠道实际能力">
    <div class="form-section-heading"><h3>渠道能力与配置条件</h3></div>
    <p class="field-note">以下是后端声明的实现与授权状态，不代表长连接在线或真实收发已验收。使用范围仍由渠道策略约束。</p>
    <p v-if="!capabilities" role="status">尚未取得能力声明，暂不展示可启用的能力开关。请刷新渠道状态。</p>
    <dl v-else class="capability-list">
      <div v-for="row in rows" :key="row.label"><dt>{{row.label}}</dt><dd><NTag size="small" :type="row.capability?.availability==='available'?'success':'default'">{{labels[row.capability?.availability??'unknown']}}</NTag><span v-if="row.capability?.reason" class="field-note">{{row.capability.reason}}</span></dd></div>
    </dl>
    <section class="business-resources" aria-label="业务资料读取">
      <h4>业务资料读取（应用身份优先）</h4>
      <p class="field-note">只读取用户在会话中明确提供的资料，优先使用当前应用身份。应用 API 权限与具体资料访问权分别核验；机器人在线或通讯录可用不证明资料可读。个人 OAuth 不是前置条件，也不会在应用读取失败后自动切换身份。</p>
      <dl class="capability-list"><div v-for="row in [{label:'会议资料读取',capability:capabilities?.meetingRead},{label:'云文档读取',capability:capabilities?.documentRead}]" :key="row.label"><dt>{{row.label}}</dt><dd><NTag size="small">{{labels[row.capability?.availability??'unknown']}}</NTag><span v-if="row.capability?.reason" class="field-note">{{row.capability.reason}}</span></dd></div></dl>
      <p class="field-note">资料由运行层按授权预先下载，执行层读取本地文件或已获准的 HTTP 链接。搜索、创建、修改、日程和待办不包含在此读取授权中。</p>
      <BusinessResourceConfiguration :provider="provider" @session-expired="emit('sessionExpired')"/>
    </section>
  </section>
</template>
<style scoped>
.capability-section{display:grid;gap:12px}.capability-section p,.capability-section h4{margin:0}.capability-list{margin:0;display:grid;gap:10px}.capability-list>div{display:grid;grid-template-columns:minmax(120px,180px) 1fr;gap:12px}.capability-list dt{font-weight:500}.capability-list dd{margin:0;display:flex;gap:8px;align-items:center;flex-wrap:wrap}.business-resources{display:grid;gap:12px;padding-top:16px;border-top:1px solid var(--subtle)}
@media(max-width:600px){.capability-list>div{grid-template-columns:1fr;gap:4px}}
</style>
