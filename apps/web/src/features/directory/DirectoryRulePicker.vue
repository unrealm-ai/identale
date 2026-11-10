<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { NAlert, NButton, NCheckbox, NCheckboxGroup, NInput, NSelect, NSpace, NTag } from 'naive-ui';
import { api, errorMessage } from '../../shared/api';
import type { DirectoryAccessRule, DirectorySubjects, ConversationKind, DirectoryItem, DirectoryPage, DirectoryIdentityEvidence, DirectorySyncStatus as SyncStatus } from './types';
import { providerLabel } from './types';
import WecomMemberVerification from './WecomMemberVerification.vue';
import DirectorySyncStatus from './DirectorySyncStatus.vue';
const props = defineProps<{ base: string; rules: DirectoryAccessRule[]; subjects: DirectorySubjects; label: string; disabled?: boolean; readonly?: boolean; draft?: boolean; directoryBase?: string;hideUnavailableNotice?:boolean;defaultConversationKinds?:ConversationKind[];employeeScope?:boolean;fixedSource?:boolean;selectPeopleOnly?:boolean }>();
const emit = defineEmits<{ 'update:rules': [rules: DirectoryAccessRule[]]; busyChanged: [value: boolean]; identityVerified: [evidence: DirectoryIdentityEvidence] }>();
const sourceId = ref<string | null>(null), kind = ref<'departments' | 'users'>(props.selectPeopleOnly ? 'users' : 'departments');
class PickerError extends Error {}
const trail = ref<{ externalId: string; subjectId: string; displayName: string }[]>([]), items = ref<DirectoryItem[]>([]), cursor = ref<string | undefined>(), exhausted = ref(true), busy = ref(false), error = ref('');
const labels = ref<Record<string, string>>({});
let controller = new AbortController(); const seenCursors = new Set<string>();
const key = (rule: Pick<DirectoryAccessRule, 'kind' | 'sourceId' | 'subjectId'>) => JSON.stringify([rule.kind, rule.sourceId, rule.subjectId]);
const sources = computed(() => props.subjects.sources.filter(source => source.enabled && (
  source.provider==='wecom'&&!props.draft&&['verified','pending_verification'].includes(source.status) ||
  (props.draft||source.status==='verified'||source.provider==='dingtalk'&&source.status==='pending_verification')&&source.directoryStatus==='available'
)));
watch(busy, value => emit('busyChanged', value), { flush: 'sync' });
const source = computed(() => sources.value.find(item => item.sourceId === sourceId.value));
const memberSearch=computed(()=>source.value?.provider==='wecom');
const searchText=ref(''),searched=ref(false),limited=ref(false);
const sync = ref<SyncStatus>(), snapshotVersion=ref<number>();
const snapshotMode=computed(()=>!!source.value&&!memberSearch.value&&!props.draft&&!props.directoryBase);
const directoryEndpoint=computed(()=>`${props.base}/channels/${source.value?.provider}/directory`);
const keywords=computed(()=>[...new Set(searchText.value.split(/[,，\n]/).map(value=>value.trim()).filter(Boolean))]);
const kinds: { value: ConversationKind; label: string }[] = [{ value: 'private', label: '私聊' }, { value: 'group', label: '群聊' }, { value: 'meeting', label: '会议' }];
const verifiedMembers = ref<Record<string, boolean>>({});
function reset() { controller.abort(); controller = new AbortController(); busy.value = false; items.value = []; cursor.value = undefined; exhausted.value = true; error.value = ''; searched.value=false;limited.value=false;seenCursors.clear(); }
watch(() => JSON.stringify([props.base, props.directoryBase, props.draft, props.subjects.sources.map(value => [value.id, value.sourceId, value.provider, value.appId, value.authRevision, value.enabled, value.directoryStatus])]), () => { reset(); sync.value=undefined; snapshotVersion.value=undefined; labels.value = {}; verifiedMembers.value = {}; trail.value = []; if (!sources.value.some(item => item.sourceId === sourceId.value)) sourceId.value = sources.value[0]?.sourceId ?? null; }, { immediate: true });
watch(sourceId, () => { reset(); trail.value = []; searchText.value=''; sync.value=undefined;snapshotVersion.value=undefined; });
watch(kind, () => { reset(); });
async function load(more = false) {
  if (!source.value || busy.value || props.disabled || props.readonly) return;
  if(memberSearch.value&&keywords.value.length>10)return;
  if (!more) reset(); else if (exhausted.value || !cursor.value) return;
  const current = source.value, signal = controller.signal;
  const query = new URLSearchParams({ kind: kind.value }); const parent = trail.value.at(-1);
  if (parent && !searchText.value.trim()) query.set('parentId', parent.externalId); if (more && cursor.value) query.set('cursor', cursor.value);
  if(snapshotMode.value && searchText.value.trim())query.set('q',searchText.value.trim());
  busy.value = true; error.value = '';
  try {
    const page = memberSearch.value
      ? await api<DirectoryPage>(props.base+'/channels/wecom/member-search',signal,{keywords:keywords.value,...(more&&cursor.value?{cursor:cursor.value}:{})},'POST')
      : await api<DirectoryPage>(`${props.directoryBase ?? `${props.base}/channels/${current.provider}/directory`}?${query}`, signal);
    if (signal.aborted) return;
    if(more && snapshotVersion.value!==undefined && page.snapshotVersion!==snapshotVersion.value)throw new PickerError('通讯录已更新，请重新查询后继续选择。');
    if (page.sourceId !== current.sourceId || page.appId !== current.appId || page.provider !== current.provider) throw new PickerError('连接来源已改变，请刷新员工配置后重新选择。');
    if (!page.exhausted && (!page.nextCursor || seenCursors.has(page.nextCursor))) throw new PickerError('目录分页游标无效，请重新读取。');
    if (page.nextCursor) seenCursors.add(page.nextCursor);
    const next = more ? [...items.value] : [];
    for (const item of page.items) { if (!next.some(value => value.kind === item.kind && value.subjectId === item.subjectId)) next.push(item); labels.value[key({ ...item, sourceId: current.sourceId })] = item.displayName; }
    if(page.sync)sync.value=page.sync; snapshotVersion.value=page.snapshotVersion;
    items.value = next; cursor.value = page.nextCursor; exhausted.value = page.exhausted;searched.value=true;limited.value=page.limited===true;
  } catch (cause) { if (!signal.aborted) { error.value = cause instanceof PickerError ? cause.message : errorMessage(cause); items.value = []; cursor.value = undefined; exhausted.value = true; } }
  finally { if (!signal.aborted) busy.value = false; }
}
async function select(item: DirectoryItem) {
  const current=source.value;
  if (!current || busy.value || props.disabled || props.readonly || props.rules.some(rule => key(rule) === key({ ...item, sourceId: current.sourceId }))) return;
  const signal=controller.signal;
  if(current.provider==='wecom'){
    busy.value=true;error.value='';
    try{await api(props.base+'/channels/wecom/member-selection',signal,{sourceId:current.sourceId,userId:item.externalId,...(item.selectionToken?{selectionToken:item.selectionToken}:{})},'POST');}
    catch(cause){if(!signal.aborted)error.value=errorMessage(cause);return;}
    finally{if(!signal.aborted)busy.value=false;}
    if(signal.aborted||source.value?.sourceId!==current.sourceId||source.value?.authRevision!==current.authRevision)return;
  }
  emit('update:rules', [...props.rules, { sourceId: current.sourceId, kind: item.kind, subjectId: item.subjectId, ...(item.kind === 'department' ? { includeDescendants: false } : {}), conversationKinds: [...(props.employeeScope?['private','group'] as ConversationKind[]:props.defaultConversationKinds??['private'])] }]);
}
function ruleMember(rule: DirectoryAccessRule) {
  const connection = props.subjects.sources.find(value => value.sourceId === rule.sourceId && value.provider === 'wecom');
  if (!connection || rule.kind !== 'channel_user') return;
  try { const parts = JSON.parse(rule.subjectId); if (Array.isArray(parts) && typeof parts[3] === 'string') return { connection, userId: parts[3] as string }; } catch { /* Unavailable legacy reference stays removable. */ }
}
function identityVerified(rule: DirectoryAccessRule) { const member = ruleMember(rule); return !!member && (verifiedMembers.value[key(rule)] === true || member.connection.memberSearchVerifiedUserIds?.includes(member.userId) === true || (sourceId.value === rule.sourceId && items.value.some(item => item.subjectId === rule.subjectId && item.identityVerified))); }
function markVerified(rule: DirectoryAccessRule, evidence: DirectoryIdentityEvidence) {
  const member = ruleMember(rule);
  if (!member || member.connection.sourceId !== evidence.sourceId || member.connection.authRevision !== evidence.authRevision || member.userId !== evidence.userId) return;
  verifiedMembers.value[key(rule)] = true;
  if (sourceId.value === evidence.sourceId) for (const item of items.value) if (item.externalId === evidence.userId) item.identityVerified = true;
  emit('identityVerified', evidence);
}
function itemVerified(item: DirectoryItem) { return item.identityVerified === true || !!source.value && (source.value.memberSearchVerifiedUserIds?.includes(item.externalId) === true || verifiedMembers.value[key({ ...item, sourceId: source.value.sourceId })] === true); }
function remove(index: number) { if (!props.disabled && !props.readonly) emit('update:rules', props.rules.filter((_, current) => current !== index)); }
function updateRule(index: number, patch: Partial<DirectoryAccessRule>) { if (!props.disabled && !props.readonly) emit('update:rules', props.rules.map((rule, current) => current === index ? { ...rule, ...patch } : rule)); }
function enter(item: DirectoryItem) { searchText.value='';trail.value.push(item); void load(); }
function back() { trail.value.pop(); void load(); }
function displayLabel(rule: DirectoryAccessRule) { const available = sources.value.some(item => item.sourceId === rule.sourceId); return `${available ? '' : '来源不可用 · '}${rule.kind === 'department' ? '部门' : '渠道人员'} · ${labels.value[key(rule)] ?? rule.subjectId}`; }
watch(()=>[source.value?.id,source.value?.sourceId,source.value?.authRevision,kind.value,props.base],()=>{if((snapshotMode.value||memberSearch.value)&&!props.disabled&&!props.readonly)void load();},{immediate:true,flush:'post'});
onUnmounted(() => { controller.abort(); emit('busyChanged', false); });
</script>
<template>
  <div class="directory-rule-picker">
    <template v-if="!readonly">
      <NSelect v-if="!fixedSource" v-model:value="sourceId" :options="sources.map(item => ({label: `${providerLabel(item.provider)} · ${item.appId}`, value: item.sourceId}))" :disabled="disabled || busy" :aria-label="`${label}渠道来源`" placeholder="选择员工已验证渠道" />
      <template v-if="memberSearch">
        <NSpace class="picker-note"><NInput v-model:value="searchText" :disabled="disabled || busy" :maxlength="650" :input-props="{'aria-label':label+'成员关键词'}" placeholder="输入姓名、拼音或别名" @keydown.enter.prevent="load(false)" /><NButton :disabled="disabled || busy || keywords.length>10" :loading="busy" @click="load(false)">搜索企微成员</NButton></NSpace>
        <p class="field-note">{{keywords.length?'用逗号分隔关键词，一次最多 10 个。':'已知人员来自本机器人连接；输入姓名可实时搜索。'}}</p>
        <p v-if="limited" class="field-note" role="status">结果可能不完整，请用更具体的关键词搜索。</p>
        <p v-if="searched && !items.length" class="field-note" role="status">未找到匹配成员。</p>
      </template>
      <template v-else>
        <NSpace class="picker-note"><NSelect v-if="!selectPeopleOnly" v-model:value="kind" :options="[{label: '部门', value: 'departments'}, {label: '人员', value: 'users'}]" :disabled="disabled || busy" :aria-label="`${label}查询类型`" /><NInput v-if="snapshotMode" v-model:value="searchText" :maxlength="100" :disabled="disabled || busy" :input-props="{'aria-label':label+'目录关键词'}" :placeholder="kind==='users'?'搜索姓名':'搜索部门名称'" @keydown.enter.prevent="load(false)"/><NButton :disabled="disabled || busy || !source" :loading="busy" @click="load(false)">{{snapshotMode?'搜索':'查询当前目录'}}</NButton><NButton v-if="trail.length" :disabled="disabled || busy" @click="back">返回上级部门</NButton></NSpace>
        <DirectorySyncStatus v-if="snapshotMode && source" :key="source.sourceId+':'+source.authRevision" :endpoint="directoryEndpoint" :connection-id="source.id" :initial="sync" :disabled="disabled" @updated="value=>sync=value" @completed="load(false)"/>
        <p class="field-note">{{snapshotMode?'在已授权通讯录中选择':'按当前应用可见范围分页选择'}}{{ kind==='users'?'人员':'部门' }} · {{ trail.map(item => item.displayName).join(' / ') || '全部授权范围' }}</p>
        <p v-if="searched && !items.length && !busy" class="field-note" role="status">{{sync?.running?'同步完成后将更新结果。':'未找到匹配结果，可尝试同步通讯录。'}}</p>
      </template>
      <NAlert v-if="!sources.length&&!hideUnavailableNotice" type="info">没有可用的员工渠道目录。请先在此员工的渠道连接中验证应用及通讯录权限；已有引用不会自动替换。</NAlert>
      <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
      <div v-for="item in items" :key="`${item.kind}:${item.subjectId}`" class="directory-option"><div>{{ item.displayName }}<NTag v-if="memberSearch && itemVerified(item)" size="small" type="success">身份已核验</NTag><p v-if="item.departmentPaths?.length" class="field-note">{{item.departmentPaths.join(' · ')}}</p></div><NSpace><NButton v-if="!selectPeopleOnly||item.kind==='channel_user'" size="small" :disabled="disabled || busy || rules.some(rule => rule.sourceId === sourceId && rule.subjectId === item.subjectId && rule.kind === item.kind)" @click="select(item)">选择{{ item.kind === 'department' ? '部门' : '人员' }}</NButton><NButton v-if="item.kind === 'department'" size="small" :disabled="disabled || busy" @click="enter(item)">进入部门</NButton></NSpace></div>
      <NButton v-if="!exhausted" :disabled="disabled || busy" @click="load(true)">加载下一页</NButton>
    </template>
    <p v-if="!rules.length" class="field-note">尚未选择规则。</p>
    <div v-for="(rule, index) in rules" :key="key(rule)" class="directory-rule-detail">
      <NTag size="small">{{ displayLabel(rule) }}</NTag>
      <WecomMemberVerification v-if="!draft && ruleMember(rule)" :key="`${key(rule)}:${ruleMember(rule)!.connection.authRevision}`" :base="base" :source-id="rule.sourceId" :user-id="ruleMember(rule)!.userId" :auth-revision="ruleMember(rule)!.connection.authRevision" :label="labels[key(rule)] ?? ruleMember(rule)!.userId" :identity-verified="identityVerified(rule)" :disabled="disabled" :readonly="readonly" @verified="evidence => markVerified(rule, evidence)" />
      <template v-if="readonly&&!employeeScope"><p>{{ rule.conversationKinds.map(kind => kinds.find(item => item.value === kind)?.label).join('、') || '不适用任何会话' }}<template v-if="rule.kind === 'department'"> · {{ rule.includeDescendants ? '包含子部门' : '仅直接部门成员' }}</template></p></template>
      <template v-else-if="!readonly"><NSpace vertical><NCheckbox v-if="rule.kind === 'department'" :checked="rule.includeDescendants === true" :disabled="disabled" @update:checked="value => updateRule(index, { includeDescendants: value })">包含子部门（默认不包含）</NCheckbox><NCheckboxGroup v-if="!employeeScope" :value="rule.conversationKinds" :disabled="disabled" @update:value="value => updateRule(index, { conversationKinds: value as ConversationKind[] })"><NSpace><NCheckbox v-for="kind in kinds" :key="kind.value" :value="kind.value" :disabled="kind.value === 'meeting' && subjects.sources.some(item => item.sourceId === rule.sourceId && item.provider === 'wecom')">{{ kind.label }}{{ kind.value === 'meeting' && subjects.sources.some(item => item.sourceId === rule.sourceId && item.provider === 'wecom') ? '（企微暂不支持）' : '' }}</NCheckbox></NSpace></NCheckboxGroup><NButton size="small" :disabled="disabled" @click="remove(index)">移除此规则</NButton><span v-if="!employeeScope&&!rule.conversationKinds.length" class="field-note">至少选择一种适用会话后才能保存。</span></NSpace></template>
    </div>
  </div>
</template>
<style scoped>.directory-rule-picker { width: 100%; min-width: 0; }.directory-rule-detail { display: grid; gap: 0.75rem; margin-top: 0.75rem; padding: 0.75rem; border: 1px solid var(--subtle); border-radius: var(--id-radius-control); }.directory-rule-detail :deep(.n-tag) { white-space: normal; height: auto; padding: 0.3125rem 0.4375rem; overflow-wrap: anywhere; }.picker-note { margin-top: 0.75rem; }.directory-option { display: flex; flex-wrap: wrap; gap: 0.75rem; justify-content: space-between; padding: 0.5rem 0; }</style>
