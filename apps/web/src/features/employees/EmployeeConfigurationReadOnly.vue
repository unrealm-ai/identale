<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { NAlert, NButton, NCard, NDescriptions, NDescriptionsItem, NEmpty, NSpace, NTag } from 'naive-ui';
import ChannelConnections from './ChannelConnections.vue';
import { api, ApiError, errorMessage } from '../../shared/api';
import { thinkingLabel, type ExecutionThinkingLevel } from './thinking-options';
const props = defineProps<{base: string}>();
const emit = defineEmits<{sessionExpired: []}>();
type Member = {memberId: string; displayName: string};
type DirectoryRule = {sourceId: string; kind: 'channel_user' | 'department'; subjectId: string; includeDescendants: boolean; conversationKinds: string[]};
type DirectoryAccess = {allow: DirectoryRule[]; deny: DirectoryRule[]};
type Configuration = {
  entity: {name: string; description: string; interactionRuntime: string; executionRuntime: string; executionThinkingLevel: ExecutionThinkingLevel};
  model: {name: string; modelId: string; provider: string; source: string; enabled: boolean} | null;
  webAccess: {allow: Member[]; deny: Member[]};
  directoryAccess: DirectoryAccess;
  packages: {id: string; name: string; enabled: boolean; mode: string; allow: Member[]; deny: Member[]; resourceCount: number; directoryAccess: DirectoryAccess}[];
};
const configuration = ref<Configuration | null>(null), loading = ref(false), error = ref('');
let controller: AbortController | undefined;
const labels = (members: Member[]) => members.map(m => m.displayName).join('、') || '无';
const ruleLabel = (rule: DirectoryRule) => `${rule.kind === 'department' ? '部门' : '渠道用户'} ${rule.subjectId} · 来源 ${rule.sourceId}${rule.kind === 'department' ? (rule.includeDescendants ? ' · 包含子部门' : ' · 仅本部门') : ''} · ${rule.conversationKinds.map(kind => ({private: '私聊', group: '群聊', meeting: '会议'}[kind] ?? kind)).join('、')}`;
async function load() {
  controller?.abort(); const current = new AbortController(); controller = current;
  configuration.value = null; error.value = ''; loading.value = true;
  try { const result = await api<Configuration>(`${props.base}/configuration`, current.signal); if (!current.signal.aborted) configuration.value = result; }
  catch (e) { if (!current.signal.aborted) { error.value = errorMessage(e); if (e instanceof ApiError && e.status === 401) emit('sessionExpired'); } }
  finally { if (controller === current) loading.value = false; }
}
watch(() => props.base, load, {immediate: true});
onBeforeUnmount(() => controller?.abort());
</script>
<template>
  <div class="readonly-configuration">
    <NAlert type="info">当前为只读配置。只有工作区创建者和管理员可修改；查看配置不代表获得对话或任务使用权。连接地址、密钥及底层工具连接信息不展示。</NAlert>
    <ChannelConnections :base="base" :can-manage="false" @session-expired="emit('sessionExpired')" />
    <NButton :loading="loading" :disabled="loading" @click="load">刷新配置</NButton>
    <NAlert v-if="error" type="error">{{ error }}</NAlert>
    <template v-if="configuration">
      <NCard title="基本信息" size="small"><NDescriptions :column="1"><NDescriptionsItem label="名称">{{ configuration.entity.name }}</NDescriptionsItem><NDescriptionsItem label="职责">{{ configuration.entity.description || '未填写' }}</NDescriptionsItem><NDescriptionsItem label="交互 Runtime">{{ configuration.entity.interactionRuntime }}</NDescriptionsItem><NDescriptionsItem label="执行 Runtime">{{ configuration.entity.executionRuntime }}</NDescriptionsItem><NDescriptionsItem label="思考强度">{{ thinkingLabel(configuration.entity.executionThinkingLevel) }}</NDescriptionsItem></NDescriptions></NCard>
      <NCard title="模型配置" size="small"><NDescriptions v-if="configuration.model" :column="1"><NDescriptionsItem label="共享配置">{{ configuration.model.name }}</NDescriptionsItem><NDescriptionsItem label="模型">{{ configuration.model.modelId }}</NDescriptionsItem><NDescriptionsItem label="来源">{{ configuration.model.source === 'workspace_default' ? '工作区默认' : '员工选择' }}</NDescriptionsItem><NDescriptionsItem label="状态">{{ configuration.model.enabled ? '已启用' : '已停用' }}</NDescriptionsItem></NDescriptions><NEmpty v-else description="尚未配置有效模型" /></NCard>
      <NCard title="Web 使用规则" size="small"><p>允许：{{ labels(configuration.webAccess.allow) }}</p><p>拒绝：{{ labels(configuration.webAccess.deny) }}</p><p class="field-note">拒绝优先，实际使用仍由服务端按当前授权校验。</p></NCard>
      <NCard title="渠道用户与部门使用规则" size="small"><p class="field-note">规则引用目录主体，部门成员按当前应用实时查询校验；不会把目录用户变成平台管理员。以下显示稳定引用，不代表当前放行结果。</p><p>允许：{{ configuration.directoryAccess.allow.length }} 条</p><ul v-if="configuration.directoryAccess.allow.length"><li v-for="(rule, index) in configuration.directoryAccess.allow" :key="`allow:${index}`">{{ ruleLabel(rule) }}</li></ul><p>拒绝：{{ configuration.directoryAccess.deny.length }} 条</p><ul v-if="configuration.directoryAccess.deny.length"><li v-for="(rule, index) in configuration.directoryAccess.deny" :key="`deny:${index}`">{{ ruleLabel(rule) }}</li></ul></NCard>
      <NCard title="能力包" size="small"><NEmpty v-if="!configuration.packages.length" description="暂无能力包" /><NSpace v-else vertical><NCard v-for="item in configuration.packages" :key="item.id" size="small" :title="item.name"><NTag>{{ item.enabled ? '已启用' : '已停用' }}</NTag><p>授权：{{ item.mode === 'inherit' ? '继承员工规则' : '进一步限制' }} · {{ item.resourceCount }} 项资源</p><p>允许：{{ labels(item.allow) }}</p><p>拒绝：{{ labels(item.deny) }}</p><p>渠道允许：{{ item.directoryAccess.allow.length }} 条；拒绝：{{ item.directoryAccess.deny.length }} 条</p><ul><li v-for="(rule, index) in item.directoryAccess.allow" :key="`allow:${index}`">允许 · {{ ruleLabel(rule) }}</li><li v-for="(rule, index) in item.directoryAccess.deny" :key="`deny:${index}`">拒绝 · {{ ruleLabel(rule) }}</li></ul></NCard></NSpace></NCard>
    </template>
  </div>
</template>
<style scoped>
.readonly-configuration { display: grid; gap: 1rem; }
</style>
