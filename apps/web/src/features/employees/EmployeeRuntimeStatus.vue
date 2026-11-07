<!-- Modified for Identale; see the root NOTICE. -->
<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { NButton, NCard } from 'naive-ui';
import { api, ApiError, errorMessage } from '../../shared/api';
import StatusBadge from '../../shared/ui/StatusBadge.vue';

const props = defineProps<{base: string; modelReady?: boolean | undefined; channelCount?: number | undefined; refreshKey?: string | number | undefined}>();
const emit = defineEmits<{sessionExpired: []}>();
type RuntimeStatus = {
  status: 'available' | 'unavailable' | 'not_ready'; observedAt: number | null;
  configuration: {ready: boolean; modules: {name: string; revision: string | null; observedAt: number | null; error: string | null}[]};
  employee: {execution?:{desired:string|null;fetched:string|null;prepared:string|null;reason:string|null;observedAt:number};interaction: {configured: boolean; available: boolean | null; reason: string | null}; channels: {provider: string; configured: boolean; state: string; reason: string | null}[]} | null;
  error: string | null;
};
const snapshot = ref<RuntimeStatus | null>(null), loading = ref(false), error = ref('');
let controller: AbortController | undefined;
const providerNames: Record<string, string> = {feishu: '飞书', dingtalk: '钉钉', wecom: '企业微信'};
const moduleNames: Record<string, string> = {channels: '渠道', identity: '身份与权限', authorization: '身份与权限', permissions: '使用权限', directory: '通讯录', capabilities: '能力包与资源', resources: '资源', models: '模型', triggers: '自动运行'};
const channelStates: Record<string, string> = {stopped: '未启动', reconnecting: '正在重新连接', connected: '已连接', connecting: '连接中', disconnected: '未连接', disabled: '已停用', failed: '连接失败', error: '连接异常', unknown: '尚未确认', unavailable: '暂不可用', not_ready: '尚未就绪'};
function reason(value: string | null): string {
  if (!value) return '';
  const messages: Record<string, string> = {
    model_selection_required: '请在员工设置中选择模型。', model_not_configured: '尚未配置模型。', model_profile_unavailable: '所选模型暂不可用，请核对模型设置。',
    employee_disabled: '员工已停用。', entity_disabled: '员工已停用。', configuration_not_ready: '配置尚未同步，请稍后刷新。',
    runtime_configuration_not_ready: '配置尚未同步，请稍后刷新。', runtime_unavailable: '暂时无法连接运行服务。',
    runtime_service_unavailable: '暂时无法连接运行服务。', runtime_not_configured: '运行服务尚未接入。',
    configuration_not_prepared:'执行资源等待准备。', runtime_preparation_unavailable:'执行资源暂时无法准备，请稍后刷新。',
    connection_disabled: '此连接已停用。', channel_disabled: '此连接已停用。',
  };
  // Service error codes belong in diagnostics, never make an unknown code a positive result.
  return messages[value] ?? '暂时无法确认具体原因，请刷新或联系管理员。';
}
function observedAt(value: number | null): string { return value === null ? '尚无观测记录' : new Date(value).toLocaleString('zh-CN'); }
async function load() {
  controller?.abort(); const current = new AbortController(); controller = current;
  snapshot.value = null; error.value = ''; loading.value = true;
  try {
    const result = await api<RuntimeStatus>(`${props.base}/runtime-status`, current.signal);
    if (!current.signal.aborted && controller === current) snapshot.value = result;
  } catch (e) {
    if (!current.signal.aborted && controller === current) {
      error.value = e instanceof ApiError && e.status >= 500 ? '运行服务暂时不可用，请稍后刷新。' : errorMessage(e);
      if (e instanceof ApiError && e.status === 401) emit('sessionExpired');
    }
  } finally { if (controller === current) loading.value = false; }
}
watch(() => [props.base, props.refreshKey], () => void load(), {immediate: true});
onBeforeUnmount(() => controller?.abort());
</script>
<template>
  <NCard class="employee-runtime-status" aria-label="运行状态">
    <div class="runtime-heading"><h2>运行状态</h2><NButton size="small" :loading="loading" :disabled="loading" @click="load">刷新状态</NButton></div>
    <div class="runtime-status-grid">
      <section aria-label="平台配置情况" class="runtime-status-block">
        <h3>平台配置</h3>
        <p>{{ modelReady === true ? '已选择模型' : modelReady === false ? '尚未选择模型，请先配置。' : '模型配置尚未确认。' }}</p>
        <p v-if="channelCount === 0">尚未接入渠道。</p>
        <p v-else-if="channelCount !== undefined">已配置 {{ channelCount }} 个渠道连接。</p>
        <p v-else>渠道配置尚未确认。</p>
      </section>
      <section aria-label="运行侧观测" class="runtime-status-block">
        <h3>当前运行情况</h3>
        <p v-if="loading" role="status">正在获取运行状态…</p>
        <div v-else-if="error" role="alert"><p>暂时无法获取运行状态，平台配置仍可查看。</p><p class="field-note">{{ error }}</p></div>
        <template v-else-if="snapshot">
          <StatusBadge :status="snapshot.status === 'available' ? 'unknown' : snapshot.status" :label="snapshot.status === 'available' ? '运行状态已更新' : snapshot.status === 'not_ready' ? '尚未就绪' : '运行服务暂不可用'" />
          <p v-if="snapshot.error">{{ reason(snapshot.error) }}</p>
          <p v-if="!snapshot.configuration.ready">部分配置尚未同步。</p>
          <template v-if="snapshot.employee">
            <p>对话：{{ !snapshot.employee.interaction.configured ? '对话配置尚未同步' : snapshot.employee.interaction.available === true ? '可接收对话' : snapshot.employee.interaction.available === false ? '暂不可接收对话' : '尚未确认是否可接收对话' }}<span v-if="snapshot.employee.interaction.reason"> · {{ reason(snapshot.employee.interaction.reason) }}</span></p>
            <p v-if="snapshot.employee.execution">执行材料：{{ snapshot.employee.execution.prepared ? '已准备' : snapshot.employee.execution.fetched ? '准备中' : '尚未准备' }}<span v-if="snapshot.employee.execution.reason"> · {{ reason(snapshot.employee.execution.reason) }}</span></p>
            <ul v-if="snapshot.employee.channels.length" class="runtime-channel-list">
              <li v-for="(channel, index) in snapshot.employee.channels" :key="`${channel.provider}:${index}`">{{ providerNames[channel.provider] ?? '渠道' }}：{{ channel.configured ? channelStates[channel.state] ?? '尚未确认' : '渠道配置尚未同步' }}<span v-if="channel.reason"> · {{ reason(channel.reason) }}</span></li>
            </ul>
            <p v-else>暂无渠道运行记录。</p>
          </template>
          <p v-else>暂时无法获取这位员工的运行情况。</p>
          <p class="field-note">更新于 {{ observedAt(snapshot.observedAt) }}</p>
          <details v-if="snapshot.configuration.modules.length" class="runtime-details"><summary>运行详情</summary><p>此处为最近获取的运行信息，配置不代表模型或渠道已验证连通。</p><ul><li v-for="module in snapshot.configuration.modules" :key="module.name">{{ moduleNames[module.name] ?? '配置模块' }} · 已应用版本 {{ module.revision ?? '尚未确认' }} · {{ observedAt(module.observedAt) }}<span v-if="module.error"> · 最近读取失败，需核对更新</span></li></ul></details>
        </template>
      </section>
    </div>
  </NCard>
</template>
<style scoped>
.employee-runtime-status{min-width:0;margin-top:0}
.runtime-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding-bottom:12px;border-bottom:1px solid var(--subtle)}
.runtime-heading h2{margin:0;font-size:16px;font-weight:600;line-height:24px}
.runtime-status-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-top:16px}
.runtime-status-block{min-width:0;overflow-wrap:anywhere;padding:14px;border-radius:8px;background:var(--id-bg-canvas,var(--background));border:1px solid var(--subtle)}
.runtime-status-block h3{margin:0 0 8px;font-size:13px;font-weight:600;color:var(--text)}
.runtime-status-block p{margin:6px 0;font-size:13px;line-height:20px}
.runtime-channel-list,.runtime-details ul{padding-left:18px;margin:8px 0;font-size:13px;line-height:20px}
.runtime-channel-list li+li,.runtime-details li+li{margin-top:4px}
.runtime-details{margin-top:10px;padding-top:10px;border-top:1px solid var(--subtle);font-size:12px;color:var(--muted)}
.runtime-details summary{cursor:pointer;font-weight:500;color:var(--text)}
@media(max-width:760px){.runtime-status-grid{grid-template-columns:1fr;gap:12px}}
</style>
