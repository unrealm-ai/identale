<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { NAlert, NButton, NCheckbox, NCheckboxGroup, NSelect, NSpace, NTag } from 'naive-ui';
import { api, errorMessage } from '../../shared/api';
import type { DirectoryAccessRule, DirectorySubjects, ConversationKind, DirectoryItem, DirectoryPage } from './types';
import { providerLabel } from './types';
const props = defineProps<{ base: string; rules: DirectoryAccessRule[]; subjects: DirectorySubjects; label: string; disabled?: boolean; readonly?: boolean; draft?: boolean; directoryBase?: string;hideUnavailableNotice?:boolean;defaultConversationKinds?:ConversationKind[];employeeScope?:boolean;fixedSource?:boolean;selectPeopleOnly?:boolean }>();
const emit = defineEmits<{ 'update:rules': [rules: DirectoryAccessRule[]]; busyChanged: [value: boolean] }>();
const sourceId = ref<string | null>(null), kind = ref<'departments' | 'users'>('departments');
class PickerError extends Error {}
const trail = ref<{ externalId: string; subjectId: string; displayName: string }[]>([]), items = ref<DirectoryItem[]>([]), cursor = ref<string | undefined>(), exhausted = ref(true), busy = ref(false), error = ref('');
const labels = ref<Record<string, string>>({});
let controller = new AbortController(); const seenCursors = new Set<string>();
const key = (rule: Pick<DirectoryAccessRule, 'kind' | 'sourceId' | 'subjectId'>) => JSON.stringify([rule.kind, rule.sourceId, rule.subjectId]);
const sources = computed(() => props.subjects.sources.filter(source => source.enabled && (props.draft || source.status === 'verified') && source.directoryStatus === 'available'));
watch(busy, value => emit('busyChanged', value), { flush: 'sync' });
const source = computed(() => sources.value.find(item => item.sourceId === sourceId.value));
const kinds: { value: ConversationKind; label: string }[] = [{ value: 'private', label: '私聊' }, { value: 'group', label: '群聊' }, { value: 'meeting', label: '会议' }];
function reset() { controller.abort(); controller = new AbortController(); busy.value = false; items.value = []; cursor.value = undefined; exhausted.value = true; error.value = ''; seenCursors.clear(); }
watch(() => [props.base, props.subjects.sources], () => { reset(); labels.value = {}; trail.value = []; if (!sources.value.some(item => item.sourceId === sourceId.value)) sourceId.value = sources.value[0]?.sourceId ?? null; }, { immediate: true });
watch(sourceId, () => { reset(); trail.value = []; });
watch(kind, reset);
async function load(more = false) {
  if (!source.value || busy.value || props.disabled || props.readonly) return;
  if (!more) reset(); else if (exhausted.value || !cursor.value) return;
  const current = source.value, signal = controller.signal;
  const query = new URLSearchParams({ kind: kind.value }); const parent = trail.value.at(-1);
  if (parent) query.set('parentId', parent.externalId); if (more && cursor.value) query.set('cursor', cursor.value);
  busy.value = true; error.value = '';
  try {
    const page = await api<DirectoryPage>(`${props.directoryBase ?? `${props.base}/channels/${current.provider}/directory`}?${query}`, signal);
    if (signal.aborted) return;
    if (page.sourceId !== current.sourceId || page.appId !== current.appId || page.provider !== current.provider) throw new PickerError('连接来源已改变，请刷新员工配置后重新选择。');
    if (!page.exhausted && (!page.nextCursor || seenCursors.has(page.nextCursor))) throw new PickerError('目录分页游标无效，请重新读取。');
    if (page.nextCursor) seenCursors.add(page.nextCursor);
    const next = more ? [...items.value] : [];
    for (const item of page.items) { if (!next.some(value => value.kind === item.kind && value.subjectId === item.subjectId)) next.push(item); labels.value[key({ ...item, sourceId: current.sourceId })] = item.displayName; }
    items.value = next; cursor.value = page.nextCursor; exhausted.value = page.exhausted;
  } catch (cause) { if (!signal.aborted) { error.value = cause instanceof PickerError ? cause.message : errorMessage(cause); items.value = []; cursor.value = undefined; exhausted.value = true; } }
  finally { if (!signal.aborted) busy.value = false; }
}
function select(item: DirectoryItem) { if (!source.value || props.disabled || props.readonly || props.rules.some(rule => key(rule) === key({ ...item, sourceId: source.value!.sourceId }))) return; emit('update:rules', [...props.rules, { sourceId: source.value.sourceId, kind: item.kind, subjectId: item.subjectId, ...(item.kind === 'department' ? { includeDescendants: false } : {}), conversationKinds: [...(props.employeeScope?['private','group'] as ConversationKind[]:props.defaultConversationKinds??['private'])] }]); }
function remove(index: number) { if (!props.disabled && !props.readonly) emit('update:rules', props.rules.filter((_, current) => current !== index)); }
function updateRule(index: number, patch: Partial<DirectoryAccessRule>) { if (!props.disabled && !props.readonly) emit('update:rules', props.rules.map((rule, current) => current === index ? { ...rule, ...patch } : rule)); }
function enter(item: DirectoryItem) { trail.value.push(item); void load(); }
function back() { trail.value.pop(); void load(); }
function displayLabel(rule: DirectoryAccessRule) { const available = sources.value.some(item => item.sourceId === rule.sourceId); return `${available ? '' : '来源不可用 · '}${rule.kind === 'department' ? '部门' : '渠道人员'} · ${labels.value[key(rule)] ?? rule.subjectId}`; }
onUnmounted(() => { controller.abort(); emit('busyChanged', false); });
</script>
<template>
  <div class="directory-rule-picker">
    <template v-if="!readonly">
      <NSelect v-if="!fixedSource" v-model:value="sourceId" :options="sources.map(item => ({label: `${providerLabel(item.provider)} · ${item.appId}`, value: item.sourceId}))" :disabled="disabled || busy" :aria-label="`${label}渠道来源`" placeholder="选择员工已验证渠道" />
      <NSpace class="picker-note"><NSelect v-model:value="kind" :options="[{label: '部门', value: 'departments'}, {label: '人员', value: 'users'}]" :disabled="disabled || busy" :aria-label="`${label}查询类型`" /><NButton :disabled="disabled || busy || !source" :loading="busy" @click="load(false)">查询当前目录</NButton><NButton v-if="trail.length" :disabled="disabled || busy" @click="back">返回上级部门</NButton></NSpace>
      <p class="field-note">按当前应用可见范围分页选择用户或部门，{{ trail.map(item => item.displayName).join(' / ') || '应用可见范围' }}</p>
      <NAlert v-if="!sources.length&&!hideUnavailableNotice" type="info">没有可用的员工渠道目录。请先在此员工的渠道连接中验证应用及通讯录权限；已有引用不会自动替换。</NAlert>
      <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
      <div v-for="item in items" :key="`${item.kind}:${item.subjectId}`" class="directory-option"><span>{{ item.displayName }}</span><NSpace><NButton v-if="!selectPeopleOnly||item.kind==='channel_user'" size="small" :disabled="disabled || busy || rules.some(rule => rule.sourceId === sourceId && rule.subjectId === item.subjectId && rule.kind === item.kind)" @click="select(item)">选择{{ item.kind === 'department' ? '部门' : '人员' }}</NButton><NButton v-if="item.kind === 'department'" size="small" :disabled="disabled || busy" @click="enter(item)">进入部门</NButton></NSpace></div>
      <NButton v-if="!exhausted" :disabled="disabled || busy" @click="load(true)">加载下一页</NButton>
    </template>
    <p v-if="!rules.length" class="field-note">尚未选择规则。</p>
    <div v-for="(rule, index) in rules" :key="key(rule)" class="directory-rule-detail">
      <NTag size="small">{{ displayLabel(rule) }}</NTag>
      <template v-if="readonly&&!employeeScope"><p>{{ rule.conversationKinds.map(kind => kinds.find(item => item.value === kind)?.label).join('、') || '不适用任何会话' }}<template v-if="rule.kind === 'department'"> · {{ rule.includeDescendants ? '包含子部门' : '仅直接部门成员' }}</template></p></template>
      <template v-else-if="!readonly"><NSpace vertical><NCheckbox v-if="rule.kind === 'department'" :checked="rule.includeDescendants === true" :disabled="disabled" @update:checked="value => updateRule(index, { includeDescendants: value })">包含子部门（默认不包含）</NCheckbox><NCheckboxGroup v-if="!employeeScope" :value="rule.conversationKinds" :disabled="disabled" @update:value="value => updateRule(index, { conversationKinds: value as ConversationKind[] })"><NSpace><NCheckbox v-for="kind in kinds" :key="kind.value" :value="kind.value" :disabled="kind.value === 'meeting' && subjects.sources.some(item => item.sourceId === rule.sourceId && item.provider === 'wecom')">{{ kind.label }}{{ kind.value === 'meeting' && subjects.sources.some(item => item.sourceId === rule.sourceId && item.provider === 'wecom') ? '（企微暂不支持）' : '' }}</NCheckbox></NSpace></NCheckboxGroup><NButton size="small" :disabled="disabled" @click="remove(index)">移除此规则</NButton><span v-if="!employeeScope&&!rule.conversationKinds.length" class="field-note">至少选择一种适用会话后才能保存。</span></NSpace></template>
    </div>
  </div>
</template>
<style scoped>.directory-rule-picker { width: 100%; min-width: 0; }.directory-rule-detail { display: grid; gap: 0.75rem; margin-top: 0.75rem; padding: 0.75rem; border: 1px solid var(--subtle); border-radius: var(--id-radius-control); }.directory-rule-detail :deep(.n-tag) { white-space: normal; height: auto; padding: 0.3125rem 0.4375rem; overflow-wrap: anywhere; }.picker-note { margin-top: 0.75rem; }.directory-option { display: flex; flex-wrap: wrap; gap: 0.75rem; justify-content: space-between; padding: 0.5rem 0; }</style>
