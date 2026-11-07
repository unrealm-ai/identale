<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { NAlert, NButton, NCard, NEmpty, NFormItem, NSelect, NSpace, NTab, NTabs } from 'naive-ui';
import { api, ApiError, errorMessage, type Workspace } from '../../shared/api';
import { useAccessibleTabs, vAccessibleTablist } from '../../shared/ui/useAccessibleTabs';
import ChannelBrand from '../employees/ChannelBrand.vue';
import DirectorySyncManagement from './DirectorySyncManagement.vue';
type Provider = 'feishu' | 'dingtalk' | 'wecom';
type Connection = { directoryConnectionId?: string | null; directoryLabel?: string; id: string; entityId: string; employeeName: string; provider: Provider; enabled: boolean; identity: string; directory: string; inboundVerified: boolean };
const props = defineProps<{ workspace: Workspace }>();
const emit = defineEmits<{ openEmployeeChannels: [string]; busyChanged: [boolean]; sessionExpired: [] }>();
const providers: Provider[] = ['feishu', 'dingtalk', 'wecom'];
const provider = ref<Provider>('feishu'), connections = ref<Connection[]>([]), connectionId = ref<string | null>(null), loading = ref(false), loaded = ref(false), cursor = ref<string | null>(null), error = ref(''), busy = ref(false);
const options = computed(() => { const seen = new Set<string>(); return connections.value.filter(row => row.provider === provider.value).filter(row => { const key = row.directoryConnectionId ?? row.id; if (seen.has(key)) return false; seen.add(key); return true; }).map(row => ({ label: row.directoryLabel ?? `${row.employeeName}的应用`, value: row.id })); });
const selected = computed(() => connections.value.find(row => row.id === connectionId.value && row.provider === provider.value));
const { tabProps, panelProps } = useAccessibleTabs(provider, () => providers, () => busy.value, true);
let controller = new AbortController(), generation = 0;
function resetApp() { connectionId.value = null; }
watch(provider, () => { connections.value = []; cursor.value = null; loaded.value = false; resetApp(); void read(); }, { flush: 'sync' });
watch(busy, value => emit('busyChanged', value), { flush: 'sync' });
async function read(more = false) {
  if (busy.value || more && (!cursor.value || loading.value)) return;
  controller.abort(); controller = new AbortController(); const signal = controller.signal, version = ++generation, id = props.workspace.id;
  loading.value = true; error.value = ''; if (!more) resetApp();
  try {
    const query = new URLSearchParams({ limit: '25' }); if (more && cursor.value) query.set('cursor', cursor.value);
    const page = await api<{ records: Connection[]; nextCursor: string | null }>(`/workspaces/${encodeURIComponent(id)}/connections?${query}`, signal);
    if (signal.aborted || version !== generation || id !== props.workspace.id) return;
    if (more && page.nextCursor && page.nextCursor === cursor.value) throw new Error('应用列表分页无法继续，请刷新重试');
    connections.value = more ? [...connections.value, ...page.records.filter(row => !connections.value.some(old => old.id === row.id))] : page.records;
    cursor.value = page.nextCursor; loaded.value = true;
  } catch (cause) { if (!signal.aborted && version === generation) { error.value = errorMessage(cause); if (cause instanceof ApiError && cause.status === 401) emit('sessionExpired'); if (cause instanceof ApiError && cause.status === 403) connections.value = []; } }
  finally { if (!signal.aborted && version === generation) loading.value = false; }
}
watch(() => props.workspace.id, () => { connections.value = []; cursor.value = null; loaded.value = false; busy.value = false; provider.value = 'feishu'; void read(); }, { immediate: true });
onUnmounted(() => { generation++; controller.abort(); emit('busyChanged', false); });
</script>
<template><section class="channel-directory">
 <div class="directory-heading"><p class="field-note">选择渠道和应用，管理通讯录来源与同步。</p><NButton :disabled="loading || busy" @click="read()">刷新</NButton></div>
 <NTabs v-accessible-tablist="'通讯录渠道'" v-model:value="provider" type="line" :on-before-leave="() => !busy"><NTab v-for="item in providers" :key="item" :name="item" v-bind="tabProps(item)" :disabled="busy"><ChannelBrand :provider="item" /></NTab></NTabs>
 <div v-bind="panelProps(provider)"><NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert><p v-if="loading && !loaded" role="status">正在读取应用…</p>
  <template v-else-if="loaded && !error"><NFormItem label="应用"><NSelect :virtual-scroll="false" v-model:value="connectionId" aria-label="通讯录应用" :options="options" :disabled="busy || !options.length" clearable placeholder="选择应用" /></NFormItem><NButton v-if="cursor" :loading="loading" :disabled="busy || loading" @click="read(true)">加载更多应用</NButton>
   <NEmpty v-if="!options.length" :description="cursor ? '当前已读取的应用中暂无此渠道' : '尚未接入此渠道的应用'"><template #extra><p class="field-note">可在数字员工的渠道中添加应用。</p></template></NEmpty>
   <NEmpty v-else-if="!selected" description="选择一个应用查看通讯录" />
   <template v-else><NCard size="small" class="application-summary"><h2>{{ selected.directoryLabel ?? `${selected.employeeName}的应用` }}</h2><p class="field-note"><template v-if="selected.directoryConnectionId">工作区共享通讯录 · </template><template v-else>{{ selected.enabled ? '应用已启用' : '应用已停用' }} · </template>{{ selected.directory === 'available' ? '目录可用' : '目录尚不可用' }}</p><NSpace><NButton @click="emit('openEmployeeChannels', selected.entityId)">管理应用</NButton></NSpace></NCard>
    <DirectorySyncManagement :key="`${workspace.id}:${selected.id}`" :workspace="workspace" :connection-id="selected.id" @busy-changed="value => { busy = value }" @session-expired="emit('sessionExpired')" />
   </template>
  </template>
 </div>
</section></template>
<style scoped>.channel-directory{display:grid;gap:1.25rem;min-width:0}.directory-heading{display:flex;justify-content:space-between;align-items:center;gap:1rem}.directory-heading p{margin:0}.application-summary{margin-bottom:1rem}.application-summary h2{font-size:1rem;line-height:1.5;margin:0}.application-summary p{margin:.5rem 0 1rem}.n-form-item{max-width:32rem}@media(max-width:47.5rem){.directory-heading{align-items:flex-start}.provider-label{font-size:.875rem}}</style>
