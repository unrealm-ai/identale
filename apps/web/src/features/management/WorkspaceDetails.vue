<script setup lang="ts">
import WorkItemBetaSettings from '../work-items/WorkItemBetaSettings.vue';
import { computed, onUnmounted, ref, watch } from 'vue';
import { NAlert, NButton, NCard, NForm, NFormItem, NInput, NSpace } from 'naive-ui';
import { api, ApiError, errorMessage, type Workspace } from '../../shared/api';
const props = defineProps<{ workspace: Workspace }>();
const emit = defineEmits<{ busyChanged: [boolean]; sessionExpired: []; workspaceRenamed: [Workspace] }>();
const betaBusy=ref(false);
const editing = ref(false), name = ref(props.workspace.name), expectedName = ref(props.workspace.name), busy = ref(false), error = ref(''), notice = ref(''), uncertain = ref(false), conflict = ref(false);
const canEdit = computed(() => ['owner', 'admin'].includes(props.workspace.role));
const dirty = computed(() => editing.value && name.value !== expectedName.value);
const valid = computed(() => !!name.value.trim() && name.value.trim().length <= 120);
let controller = new AbortController(), generation = 0;
watch([busy, dirty,betaBusy], () => emit('busyChanged', busy.value || dirty.value||betaBusy.value), { flush: 'sync' });
watch(() => props.workspace.id, () => { generation++; controller.abort(); controller = new AbortController(); editing.value = false; busy.value = false;betaBusy.value=false; error.value = ''; notice.value = ''; uncertain.value = false; conflict.value = false; name.value = props.workspace.name; expectedName.value = props.workspace.name; });
watch(() => props.workspace.name, value => { if (!editing.value) { name.value = value; expectedName.value = value; } });
function edit() { if (!canEdit.value || busy.value) return; name.value = props.workspace.name; expectedName.value = props.workspace.name; editing.value = true; error.value = ''; notice.value = ''; }
function cancel() { if (busy.value) return; editing.value = false; name.value = props.workspace.name; expectedName.value = props.workspace.name; error.value = ''; uncertain.value = false; conflict.value = false; }
async function save() {
  if (!canEdit.value || busy.value || !dirty.value || !valid.value || uncertain.value) return;
  const version = generation, id = props.workspace.id, signal = controller.signal; busy.value = true; error.value = ''; notice.value = '';
  try {
    const result = await api<{ workspace: Workspace }>(`/workspaces/${encodeURIComponent(id)}`, signal, { name: name.value.trim(), expectedName: expectedName.value }, 'PATCH');
    if (signal.aborted || version !== generation || id !== props.workspace.id) return;
    if (result.workspace.id !== id) throw new Error('工作区更新结果无法确认');
    emit('workspaceRenamed', result.workspace); name.value = result.workspace.name; expectedName.value = result.workspace.name; editing.value = false; conflict.value = false; notice.value = '已保存';
  } catch (cause) {
    if (signal.aborted || version !== generation) return;
    error.value = errorMessage(cause); conflict.value = cause instanceof ApiError && cause.status === 409;
    uncertain.value = !(cause instanceof ApiError) || cause.status >= 500;
    if (uncertain.value) error.value = '保存结果尚未确认，请核对后再继续。';
    if (cause instanceof ApiError && cause.status === 401) emit('sessionExpired');
  } finally { if (version === generation && !signal.aborted) busy.value = false; }
}
async function reconcile() {
  if (busy.value) return;
  const version = generation, id = props.workspace.id, signal = controller.signal; busy.value = true;
  try {
    const result = await api<{ workspaces: Workspace[] }>('/workspaces', signal);
    if (signal.aborted || version !== generation || id !== props.workspace.id) return;
    const current = result.workspaces.find(item => item.id === id); if (!current) throw new Error('当前工作区已不可访问');
    emit('workspaceRenamed', current);
    if (uncertain.value && current.name === name.value.trim()) { editing.value = false; name.value = current.name; notice.value = '已保存'; error.value = ''; }
    else { error.value = `当前名称为“${current.name}”。你的输入已保留，请确认后保存。`; }
    expectedName.value = current.name; uncertain.value = false; conflict.value = false;
  } catch (cause) { if (!signal.aborted && version === generation) { error.value = errorMessage(cause); if (cause instanceof ApiError && cause.status === 401) emit('sessionExpired'); } }
  finally { if (version === generation && !signal.aborted) busy.value = false; }
}
onUnmounted(() => { generation++; controller.abort(); emit('busyChanged', false); });
</script>
<template><NCard class="workspace-details" size="small"><template #header>工作区信息</template>
 <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert><NAlert v-if="notice" type="success" role="status">{{ notice }}</NAlert>
 <NForm v-if="editing && canEdit" @submit.prevent="save"><NFormItem label="工作区名称" v-bind="name.length && !valid ? { validationStatus: 'error' as const, feedback: '请输入1–120个字符的名称' } : {}"><NInput v-model:value="name" :disabled="busy || uncertain" :maxlength="120" :input-props="{ 'aria-label': '工作区名称' }" /></NFormItem><NSpace><NButton :disabled="busy" @click="cancel">取消</NButton><NButton type="primary" attr-type="submit" :loading="busy" :disabled="busy || !dirty || !valid || uncertain">保存</NButton><NButton v-if="uncertain || conflict" :disabled="busy" @click="reconcile">核对最新名称</NButton></NSpace></NForm>
 <div v-else class="workspace-summary"><div><p class="workspace-name">{{ workspace.name }}</p><p class="field-note">{{ workspace.role === 'owner' ? '所有者' : workspace.role === 'admin' ? '管理员' : '成员' }}</p></div><NButton v-if="canEdit" :disabled="busy" @click="edit">编辑名称</NButton></div>
</NCard><WorkItemBetaSettings :workspace="workspace" @busy-changed="v=>{betaBusy=v}" @session-expired="emit('sessionExpired')"/></template>
<style scoped>.workspace-details{max-width:56rem}.workspace-summary{display:flex;justify-content:space-between;align-items:center;gap:1rem}.workspace-name{font-size:1.125rem;font-weight:600;margin:0}.field-note{margin:.5rem 0 0}.n-alert{margin-bottom:1rem}form{max-width:32rem}</style>
