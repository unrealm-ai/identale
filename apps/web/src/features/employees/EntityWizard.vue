<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NAlert, NButton, NForm, NSpace } from 'naive-ui';
import AvatarPicker from '../../shared/ui/AvatarPicker.vue';
import PageHeader from '../../shared/ui/PageHeader.vue';
import EmployeeAvatar from '../../shared/ui/EmployeeAvatar.vue';
import ModelSettings from './ModelSettings.vue';
import EmployeeThinkingLevel from './EmployeeThinkingLevel.vue';
import EmployeeIdentityFields from './EmployeeIdentityFields.vue';
import WizardEmployeeAccess from './WizardEmployeeAccess.vue';
import { useEmployeeWizard } from './useEmployeeWizard';
import type { EntityWizardProps, EntityWizardEmits } from './useEmployeeWizard';
const props = defineProps<EntityWizardProps>();
const emit = defineEmits<EntityWizardEmits>();
const { avatarPreset, name, description, executionThinkingLevel, ownWebUse, modelBusy, modelEditorDirty, creating, busy, created, error, uncertain, confirmClose, base, valid, modelDraft, accessDraft, finish, requestClose } = useEmployeeWizard(props, emit);
const savedModel = ref(false), advanced = ref(false);
watch(busy, value => emit('busyChanged', value), { flush: 'sync' });
const locked = computed(() => busy.value || uncertain.value);
const identityFields = ref<InstanceType<typeof EmployeeIdentityFields>|null>(null);
async function submitCreation() {
  if (locked.value || modelEditorDirty.value) return;
  if (!name.value.trim()) { await identityFields.value?.showNameError(); return; }
  await finish();
}
function closeWizard() { if (!busy.value) { emit('closeCancelled'); requestClose(); } }
defineExpose({ requestClose });
function onEscape(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || (event.target instanceof Element && event.target.closest('input,textarea,select,[role="combobox"],[role="listbox"],.n-select'))) return;
  event.stopPropagation(); event.preventDefault(); closeWizard();
}
</script>
<template>
<section class="employee-wizard" aria-labelledby="wizard-heading" :aria-busy="busy" @keydown.esc="onEscape">
  <NButton class="wizard-back" aria-label="返回数字员工" text :disabled="busy" @click="closeWizard"><span aria-hidden="true">←</span> 返回数字员工</NButton>
  <PageHeader title="新建数字员工" title-id="wizard-heading" description="先创建，再按需补充能力与渠道。" />
  <div v-if="error||uncertain||confirmClose" class="feedback">
    <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
    <NAlert v-if="uncertain" type="warning">创建结果暂时无法确认。请先核对，或安全重试；重试不会重复创建员工。<NSpace><NButton :disabled="busy" @click="finish">安全重试</NButton><NButton :disabled="busy" @click="closeWizard">返回核对</NButton></NSpace></NAlert>
    <NAlert v-if="confirmClose" type="warning">{{ uncertain ? '创建结果尚未确认，员工可能已经创建。退出不会撤销创建，请先核对。' : '退出将丢弃尚未保存的员工资料与模型表单。' }}<span v-if="savedModel">已保存的共享模型会保留。</span><NSpace><NButton :disabled="busy" @click="confirmClose=false;emit('closeCancelled')">继续填写</NButton><NButton type="error" :disabled="busy" @click="emit('close')">丢弃草稿并退出</NButton></NSpace></NAlert>
  </div>
  <div class="wizard-layout">
    <div class="wizard-basics">
      <NForm class="wizard-section" data-wizard-step="identity" @submit.prevent="submitCreation">
        <h2><span class="section-number" aria-hidden="true">1</span>基本信息</h2>
        <div class="wizard-identity"><AvatarPicker v-model:value="avatarPreset" creation :disabled="locked"/><div class="wizard-identity-fields"><EmployeeIdentityFields ref="identityFields" v-model:name="name" v-model:description="description" creation :disabled="locked||!!created" autofocus /></div></div>
      </NForm>
      <section class="wizard-section" data-wizard-step="model">
        <h2><span class="section-number" aria-hidden="true">2</span>模型</h2>
        <ModelSettings :base="base" scope="workspace" can-manage creation :disabled="creating||uncertain" @draft-changed="value=>modelDraft=value" @busy-changed="value=>modelBusy=value" @dirty-changed="value=>modelEditorDirty=value" @profile-created="savedModel=true" @session-expired="emit('sessionExpired')" />
        <details class="wizard-advanced" :open="advanced" @toggle="advanced=($event.target as HTMLDetailsElement).open"><summary>高级设置</summary><EmployeeThinkingLevel v-model:value="executionThinkingLevel" :disabled="locked"/></details>
        <p v-if="modelEditorDirty" class="field-note" role="status">请先保存新模型，或取消添加后再创建员工。</p>
      </section>
      <section class="wizard-section" data-wizard-step="access"><h2><span class="section-number" aria-hidden="true">3</span>使用范围</h2><WizardEmployeeAccess :base="base" :disabled="locked" :channel="null" :self-member-id="workspace.memberId" @change="value=>{accessDraft={...accessDraft,...value};ownWebUse=value.webAccess.allowWorkspaceMembers||value.webAccess.allowMemberIds.includes(workspace.memberId)&&!value.webAccess.denyMemberIds.includes(workspace.memberId)}" /></section>
    </div>
    <aside class="wizard-preview" aria-label="员工预览"><h2>员工预览</h2><div class="preview-content"><EmployeeAvatar :name="name" :preset="avatarPreset" size="chat"/><h3>{{name.trim()||'新数字员工'}}</h3><p class="preview-description">{{description.trim()||'填写职责，让团队知道什么时候找它。'}}</p><span class="preview-scope"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="7" r="4"/><path d="M4 22v-3a8 8 0 0 1 16 0v3Z"/></svg>{{accessDraft.webAccess?.allowWorkspaceMembers?'工作区':'仅自己'}}</span><div class="preview-next"><svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M21 11a9 9 0 0 1-9 9H5l-4 3V11a10 10 0 0 1 20 0Z"/><path d="M7 11h.01M12 11h.01M17 11h.01"/></svg>创建后进入持续对话</div></div></aside>
  </div>
  <footer class="wizard-footer"><div class="wizard-footer-note"><span class="wizard-info-icon" aria-hidden="true">i</span><span>创建后进入与该员工的持续对话；能力包、渠道和触发器可稍后配置。</span></div><div class="wizard-actions"><NButton round :disabled="busy" @click="closeWizard">取消</NButton><NButton round type="primary" aria-label="确认创建数字员工" :disabled="locked||!valid||modelEditorDirty" :loading="creating" @click="submitCreation">创建数字员工</NButton></div></footer>
</section>
</template>
<style scoped>
.employee-wizard{max-width:80rem;margin:0 auto}.employee-wizard :deep(.page-heading){margin-bottom:1rem}.wizard-back{margin:0 0 .75rem;gap:.5rem}.wizard-back :deep(.n-button__content){gap:.5rem}.feedback{display:grid;gap:.75rem;margin-bottom:1rem}.wizard-layout{display:grid;grid-template-columns:minmax(0,7fr) minmax(18rem,3fr);gap:1rem;align-items:start}.wizard-basics{display:grid;gap:.875rem;min-width:0}.wizard-section,.wizard-preview{padding:1.25rem;border:1px solid var(--subtle);border-radius:var(--id-radius-card,.75rem);background:var(--surface);min-width:0}.wizard-section h2{font-size:1.25rem;display:flex;align-items:center;gap:1rem;margin:0 0 .5rem}.section-number{display:inline-flex;align-items:center;justify-content:center;width:2.25rem;height:2.25rem;flex:none;border-radius:50%;background:var(--background);color:var(--heading);font-size:1.25rem}.wizard-identity{display:grid;grid-template-columns:11rem minmax(0,1fr);gap:1.5rem;align-items:start}.wizard-identity-fields{min-width:0}.wizard-identity :deep(.avatar-picker){margin:0}.wizard-identity :deep(.n-form-item:last-child .n-form-item-feedback-wrapper){min-height:0}.wizard-preview{position:sticky;top:1rem}.wizard-preview h2{font-size:1.25rem;margin:0 0 1.25rem}.preview-content{padding:1.75rem 1.25rem 1.5rem;background:var(--tint);border:1px solid var(--subtle);border-radius:.75rem;text-align:center;overflow-wrap:anywhere}.preview-content :deep(.employee-avatar){width:8rem;height:8rem;margin:auto}.preview-content h3{font-size:1.5rem;line-height:1.4;margin:1rem 0 .5rem}.preview-description{margin:.5rem 0 1rem;white-space:pre-wrap;max-height:14rem;overflow:auto}.preview-scope{display:inline-flex;align-items:center;gap:.5rem;padding:.375rem .875rem;color:var(--selectedText);background:var(--surface);border-radius:999px}.preview-next{display:flex;align-items:center;justify-content:center;gap:.5rem;border-top:1px solid var(--subtle);padding-top:1.5rem;margin-top:1.5rem;color:var(--muted);font-size:.875rem}.preview-next svg{flex:none}.wizard-advanced{margin-top:.25rem}.wizard-advanced summary{cursor:pointer;color:var(--muted);width:fit-content;padding:.5rem 0;font-size:.8125rem}.wizard-advanced :deep(.employee-thinking){margin-top:.75rem}[data-wizard-step=access] :deep(.field-note){margin:.5rem 0 0}[data-wizard-step=access] h2{margin-bottom:.5rem}.wizard-footer{display:grid;grid-template-columns:minmax(0,7fr) minmax(18rem,3fr);align-items:center;gap:1rem;padding:0;margin-top:.875rem;border:0;background:transparent}.wizard-footer-note{display:flex;align-items:center;gap:.75rem;background:var(--tint);color:var(--selectedText);border:1px solid var(--focus);border-radius:var(--id-radius-card);padding:.875rem 1rem;font-size:.875rem;line-height:1.6}.wizard-info-icon{border:2px solid currentColor;border-radius:50%;width:1.125rem;height:1.125rem;display:inline-flex;align-items:center;justify-content:center;flex:none;font-weight:600;line-height:1}.wizard-actions{display:flex;justify-content:flex-end;gap:.75rem}.wizard-actions .n-button{min-height:2.75rem;padding:0 1.5rem}.wizard-actions .n-button--primary-type{min-width:10rem}
@media(max-width:68.75rem){.wizard-layout{grid-template-columns:minmax(0,1fr)}.wizard-preview{position:static}.preview-content{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:.5rem 1rem;text-align:left}.preview-content :deep(.employee-avatar){grid-row:1/4;width:6rem;height:6rem}.preview-content h3,.preview-description{margin:0}.preview-scope{justify-self:start}.preview-next{grid-column:1/-1;margin-top:.5rem;padding-top:1rem}.wizard-footer{grid-template-columns:minmax(0,1fr)}.wizard-actions{justify-content:flex-end}}
@media(max-width:47.5rem){.wizard-identity{grid-template-columns:minmax(0,1fr);gap:1.25rem}.wizard-identity :deep(.avatar-picker){justify-self:center}.wizard-section,.wizard-preview{padding:1rem}.wizard-section h2{font-size:1.125rem;gap:.75rem}.preview-content{padding:1rem}.preview-content h3{font-size:1.25rem}.preview-content :deep(.employee-avatar){width:4rem;height:4rem}.wizard-actions .n-button{padding:0 1rem}.wizard-actions .n-button--primary-type{flex:1}}
</style>
