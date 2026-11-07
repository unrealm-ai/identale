<script setup lang="ts">
import { taskDisplayTitle } from '@dentity/contracts';
import { computed, h } from 'vue';
import { NAlert, NButton, NCard, NCheckbox, NCheckboxGroup, NCollapse, NCollapseItem, NDataTable, NEmpty, NInput, NSelect, NSkeleton, NTag } from 'naive-ui';
import type { DataTableColumns } from 'naive-ui';
import type { Task } from '../../phase2';
import { statusLabel, taskFilterOptions } from '../../phase2';
import { useTaskPanel } from './useTaskPanel';
const props = defineProps<{ base: string; conversationId: string; history: { id: string; role: string; text: string }[] }>();
const emit = defineEmits<{ (event: 'sessionExpired' | 'updated'): void }>();
const { contextUnavailable, selected, details, title, input, addition, contextMode, historyIds, busy, refreshing, error, notice, loaded, currentTasks, canStart, canSupplement, canCancel, filter, nextCursor, actionReason, refresh, select, create, mutate } = useTaskPanel(props, emit);
const milestones = computed(() => details.value?.updates.filter(update => update.type !== 'output_delta') ?? []);
const columns: DataTableColumns<Task> = [
  { title: '任务', key: 'title', minWidth: 140, render: task => h('span', { class: 'task-summary' }, taskDisplayTitle(task)) },
  { title: '状态', key: 'status', width: 110, render: task => h(NTag, { size: 'small', bordered: false, type: task.status === 'failed' ? 'error' : task.status === 'succeeded' ? 'success' : 'info' }, { default: () => statusLabel(task.status) }) },
  { title: '', key: 'actions', width: 70, render: task => h(NButton, { size: 'small', text: true, type: 'primary', disabled: busy.value, 'aria-label': `${task.id === selected.value?.id ? '已选' : '详情'}：${taskDisplayTitle(task)}`, onClick: () => select(task) }, { default: () => task.id === selected.value?.id ? '已选' : '详情' }) },
];
</script>
<template>
  <NCard class="task-panel" content-style="padding: 16px;">
    <div class="section-title"><h3>本会话任务</h3><NButton size="small" :loading="refreshing" :disabled="busy || refreshing || contextUnavailable" @click="refresh()">刷新状态</NButton></div>
    <NAlert type="warning" class="local-runtime-warning">本地执行工具可能访问本机文件和网络，请确认任务与授权范围。</NAlert>
    <p class="field-note">任务运行时仍可继续对话。</p><details class="execution-environment"><summary>执行环境说明</summary><p class="field-note">独立工作目录不是安全沙箱。请仅使用你信任的工具和资料。</p></details>
    <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert><NAlert v-if="notice" type="info" role="status">{{ notice }}</NAlert>
    <NCollapse v-if="!contextUnavailable" class="create-task"><NCollapseItem title="保存待办或立即执行" name="create"><form @submit.prevent="create()"><div class="task-form">
      <label>任务标题（可选）<NInput v-model:value="title" :input-props="{ 'aria-label': '任务标题（可选）' }" :disabled="busy" placeholder="例如：核对客户退款材料，建议20–30字，最多60字" /></label>
      <label>任务说明<NInput v-model:value="input" :input-props="{ 'aria-label': '任务说明' }" type="textarea" :disabled="busy" :maxlength="8000" :autosize="{ minRows: 3, maxRows: 8 }" placeholder="描述期望结果与约束" /></label>
      <label>执行上下文<NSelect v-model:value="contextMode" filterable aria-label="执行上下文" :input-props="{ 'aria-label': '执行上下文' }" :disabled="busy" :options="[{ label: '新上下文 · 仅任务说明', value: 'new' }, { label: '选择当前真实会话原文', value: 'fork' }]" /></label>
      <div v-if="contextMode === 'fork'" class="history-picker"><p class="field-note">只交付勾选的原文，服务端再次检查权限；不包含模型私有会话或演示内容。最多 40 条。</p><NCheckboxGroup v-model:value="historyIds" :disabled="busy"><NCheckbox v-for="message in history" :key="message.id" :value="message.id" :disabled="busy || (!historyIds.includes(message.id) && historyIds.length >= 40)">{{ message.role === 'user' ? '我' : '助手' }}：{{ message.text.slice(0, 180) }}</NCheckbox></NCheckboxGroup><p v-if="!history.length" class="muted">当前无可选原文。</p></div>
      <p class="field-note">平台按当前使用者和渠道自动装配全部获准业务能力，具体工具由执行 RT 选择。</p>
      <NButton block type="primary" attr-type="submit" :loading="busy" :disabled="busy || !input.trim()">保存为待办</NButton>
      <NButton block :disabled="busy || !input.trim()" @click="create('immediate')">立即执行任务</NButton>
    </div></form></NCollapseItem></NCollapse>
    <label v-if="!contextUnavailable" class="task-filter">筛选任务状态<NSelect filterable aria-label="筛选任务状态" v-model:value="filter" :options="taskFilterOptions" :disabled="busy" :input-props="{ 'aria-label': '筛选任务状态' }" /></label>
    <NDataTable :columns="columns" :data="currentTasks" :loading="refreshing && !loaded" :row-key="(task: Task) => task.id" :bordered="false" size="small" :scroll-x="320"><template #empty><NEmpty description="本会话暂无任务" /></template></NDataTable>
    <NButton v-if="nextCursor" block :loading="refreshing" :disabled="busy || refreshing" @click="refresh(true)">加载更多任务</NButton>
    <NCard v-if="selected" class="task-detail" size="small" title="任务详情">
<h4>{{ taskDisplayTitle(selected) }}</h4><p class="field-note selectable">{{ selected.id }}</p><details :key="selected.id" class="task-description"><summary>任务说明</summary><p class="prewrap">{{ selected.input }}</p></details>
      <dl><div><dt>任务状态</dt><dd>{{ statusLabel(selected.status) }}</dd></div><div><dt>执行状态</dt><dd>{{ selected.run ? statusLabel(selected.run.status) : '尚未创建执行记录' }}</dd></div><div><dt>任务版本 / 输入修订</dt><dd>{{ selected.version }} / {{ selected.inputRevision }}</dd></div></dl>
      <p v-if="selected.status === 'cancel_requested'" class="message error">取消仅已申请，执行仍可能继续。等待 Runtime 确认，不要将此状态视为已停止。</p>
      <p v-if="selected.run?.status === 'unknown'" class="message error">执行结果未知。请等待对账或联系管理员；不要直接重复创建同一任务。</p>
      <NSkeleton v-if="!details" text :repeat="3" /><template v-if="details"><NCollapse :default-expanded-names="['progress', 'results']"><NCollapseItem title="阶段进展与产物" name="progress"><p v-if="!milestones.length" class="muted">尚无执行器进展记录。</p><ol class="milestones"><li v-for="update in milestones" :key="update.id"><small>#{{ update.sequence }} · {{ update.type === 'final_result' ? '最终结果记录' : update.type === 'partial_result' ? '阶段产物' : update.type === 'progress' ? '进展' : update.type === 'input_receipt' ? '输入回执' : '状态' }}</small><p v-if="update.text" class="prewrap">{{ update.text }}</p><p v-if="update.status">{{ statusLabel(update.status) }}</p><p v-if="update.inputStatus">输入 r{{ update.inputRevision }}：{{ statusLabel(update.inputStatus) }}</p></li></ol>
        </NCollapseItem><NCollapseItem title="输入回执" name="inputs"><p class="field-note">已保存到平台、执行器已接收和已应用是不同事实；只有明确的 applied 回执表示已应用。</p><p v-if="!selected.run" class="field-note">待办要求已保存，尚无执行器输入回执；启动时使用最新输入修订。</p><p v-for="receipt in details.inputs" :key="receipt.revision" class="field-note">r{{ receipt.revision }}：{{ statusLabel(receipt.status) }}</p>
        </NCollapseItem><NCollapseItem title="结果与反馈" name="results"><p class="field-note">结果生成、任务终态与反馈保存分别记录，不能互相替代。</p><p v-if="selected.run && selected.run.result !== null" class="prewrap">{{ selected.run.result }}</p><p v-else class="muted">暂无最终结果记录。任务终态、结果记录与反馈投递分别显示。</p><p v-if="selected.run && selected.run.resultInputRevision !== null" class="field-note">结果采用输入 r{{ selected.run.resultInputRevision }}</p>
        <p v-if="selected.run && selected.run.resultInputRevision !== null && selected.run.resultInputRevision < selected.inputRevision" class="message error">该结果尚未覆盖最新输入修订，请核对回执与后续结果。</p><ul class="deliveries"><li v-for="delivery in details.deliveries" :key="delivery.id"><small>{{ statusLabel(delivery.status) }} · 不表示外部渠道送达</small><p class="prewrap">{{ delivery.text }}</p></li></ul>
      </NCollapseItem></NCollapse></template>
      <p class="field-note">操作依据平台实时返回的权限、任务状态与绑定执行器能力；不是根据 Runtime 名称猜测。{{ !selected.run ? '待办操作由平台保存，启动时重新校验权限和配置。' : selected.actionCapabilities?.status === 'known' ? '当前能力已有确认记录。' : '执行器能力未确认，必要操作将禁用。' }}</p>
      <p v-if="!canSupplement" class="field-note">补充 / 修改：{{ actionReason(selected.availableActions?.supplement.reason) }}</p>
      <p v-else-if="selected.availableActions?.supplement.application === 'on_start'" class="field-note">补充将保存到待办，启动时使用最新要求，当前不会发送到执行器。</p>
      <p v-else-if="selected.availableActions?.supplement.mode === 'platform_record_only'" class="message error">补充目前仅记录到平台，不能保证正在执行的 Agent 收到或应用；不要将提交成功理解为执行要求已改变。</p>
      <NButton v-if="selected.status === 'planned'" block type="primary" :loading="busy" :disabled="busy || !canStart" @click="mutate('start')">启动待办</NButton>
      <p v-if="selected.status === 'planned' && !canStart" class="field-note">启动：{{ actionReason(selected.availableActions?.start?.reason) }}</p>
      <p v-if="!canCancel" class="field-note">取消：{{ actionReason(selected.availableActions?.cancel.reason) }}</p>
      <p class="field-note">暂停 / 恢复：当前未实现，不会转换为取消。</p>
      <form @submit.prevent="mutate('input')" class="task-form"><label>补充 / 修改说明<NInput v-model:value="addition" :input-props="{ 'aria-label': '补充 / 修改说明' }" type="textarea" :disabled="busy || !canSupplement" :maxlength="8000" :autosize="{ minRows: 2, maxRows: 6 }" /></label><NButton block attr-type="submit" :loading="busy" :disabled="busy || !canSupplement || !addition.trim()">提交补充并查询回执</NButton></form>
      <NButton block type="error" secondary :loading="busy" :disabled="busy || !canCancel" @click="mutate('cancel')">{{ selected.status === 'cancel_requested' ? '正在等待取消确认' : selected.status === 'planned' ? '取消待办' : '申请取消此任务' }}</NButton>
    </NCard>
  </NCard>
</template>

<style scoped>
:deep(.task-summary){display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:1;overflow:hidden;overflow-wrap:anywhere;white-space:normal;line-height:1.6}.task-description{padding:.75rem;border:1px solid var(--subtle);border-radius:.5rem}.task-description summary{cursor:pointer}.task-description summary:focus-visible{outline:2px solid var(--primary);outline-offset:2px}.task-detail h4{margin:0 0 .75rem;overflow-wrap:anywhere}@media(max-width:47.5rem){:deep(.task-summary){-webkit-line-clamp:2}}
.task-panel { min-width: 0; }.task-filter { display: grid; gap: 0.4375rem; margin-bottom: 0.75rem; }
.section-title { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; margin-bottom: 0.75rem; }.section-title h3, .section-title h4 { margin: 0; }
.task-form { display: grid; gap: 0.875rem; }.task-form label { display: grid; gap: 0.4375rem; }
.create-task { margin: 1.25rem 0; padding: 1rem 0; border-top: 1px solid var(--subtle); border-bottom: 1px solid var(--subtle); }
.task-detail { margin-top: 1.25rem; }.task-detail :deep(.n-card__content) { display: grid; gap: 0.75rem; }
.task-detail p { margin: 0; }.task-detail dl { display: grid; gap: 0.625rem; margin: 0; padding: 0.875rem; border-radius: 0.5rem; background: var(--background); }.task-detail dl > div { display: flex; justify-content: space-between; gap: 0.625rem; }.task-detail dt { color: var(--muted); }.task-detail dd { margin: 0; }
.prewrap { white-space: pre-wrap; overflow-wrap: anywhere; }.selectable { overflow-wrap: anywhere; }.field-note { font-size: 0.875rem; line-height: 1.7; color: var(--muted); }
.history-picker, .capability-picker { padding: 0.75rem; border: 1px solid var(--subtle); border-radius: 0.5rem; }
:deep(.n-checkbox-group) { display: grid; gap: 0.625rem; }.resource-description { display: block; color: var(--muted); }
.milestones { padding-left: 1.25rem; }.milestones li { padding-bottom: 0.75rem; }.milestones small { color: var(--muted); }.deliveries { padding-left: 1.125rem; }
.message.error { padding: 0.625rem 0.75rem; background: var(--warningTint); color: var(--warning); border-radius: 0.4375rem; font-size: 0.875rem; }
</style>
