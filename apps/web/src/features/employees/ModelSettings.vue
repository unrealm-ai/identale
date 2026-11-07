<script setup lang="ts">
import ModelSelector from './ModelSelector.vue';
import { computed, ref } from 'vue';
import { NAlert, NButton, NCard, NCheckbox, NDescriptions, NDescriptionsItem, NForm, NFormItem, NInput, NSelect, NSpace, NPopconfirm, NRadioGroup, NRadio, NEmpty } from 'naive-ui';
import type { FormInst, FormRules } from 'naive-ui';
import { useModelSettings } from './useModelSettings';
import type { ModelSettingsProps, ModelSettingsEmits } from './useModelSettings';
const props = defineProps<ModelSettingsProps>();
const emit = defineEmits<ModelSettingsEmits>();
const { isWorkspace, canEditCatalog, profiles, defaultProfileId, selectedProfileId, effective, sourceLabel, profile, editing, loaded, busy, catalogDirty, error, notice, protocol,name, endpoint, modelId, apiKey, enabled, setAsDefault, endpointChanged, tested, edit, cancelEdit, load, revoke,toggle, selectModel, testConnection, save } = useModelSettings(props, emit);
const locked = computed(() => busy.value || !!props.disabled);
const creationOptions = computed(() => [{label:'继承工作区默认模型',value:''},...profiles.value.map(p=>({label:`${p.name} · ${p.modelId}${p.enabled?'':'（已停用）'}`,value:p.id,disabled:!p.enabled}))]);
const selectedReady = computed(() => profiles.value.some(p=>p.id===(selectedProfileId.value??defaultProfileId.value)&&p.enabled));
const formRef = ref<FormInst | null>(null);
const formModel = computed(() => ({ name: name.value, endpoint: endpoint.value, modelId: modelId.value }));
const rules: FormRules = {
  name: { required: true, validator: (_rule, value: string) => !!value?.trim() || new Error('请输入配置名称'), trigger: ['input', 'blur'] },
  endpoint: { required: true, validator: (_rule, value: string) => { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) || new Error('请输入有效的模型 API 地址'); } catch { return new Error('请输入有效的模型 API 地址'); } }, trigger: ['input', 'blur'] },
  modelId: { required: true, validator: (_rule, value: string) => !!value?.trim() || new Error('请输入模型名称'), trigger: ['input', 'blur'] },
};
async function validateAnd(action: () => Promise<void>) { if (busy.value || !canEditCatalog.value) return; try { await formRef.value?.validate(); await action(); } catch { /* NForm displays validation errors. */ } }
</script>
<template>
<NCard class="model-settings" :class="{'creation-model':creation}" :title="isWorkspace && !creation ? '工作区共享模型库' : ''" :bordered="isWorkspace && !creation" v-bind="creation?{contentStyle:'padding:0'}:{}" :inert="disabled" size="small">
  <p v-if="isWorkspace && !creation" class="field-note">在这里管理团队共用的模型，员工可分别选择。</p>

  <NAlert v-if="!canManage" type="warning">你没有此配置的管理权限，请联系工作区创建者或管理员。</NAlert>
  <template v-else>
    <NSpace vertical><NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert><NAlert v-if="notice" type="success" role="status">{{ notice }}</NAlert></NSpace>
    <p v-if="!loaded && busy" role="status">正在读取工作区模型…</p>
    <NButton v-if="!loaded && !busy" @click="load">重新读取</NButton>
    <template v-if="loaded">
      <NDescriptions v-if="!isWorkspace && !draft" bordered :column="1"><NDescriptionsItem label="当前来源">{{ sourceLabel }}</NDescriptionsItem><NDescriptionsItem label="当前模型">{{ effective?.effectiveProfile?.name ?? '无' }}<span v-if="effective?.effectiveProfile"> · {{ effective.effectiveProfile.modelId }}{{ effective.effectiveProfile.enabled ? '' : '（已停用，请更换模型）' }}</span></NDescriptionsItem></NDescriptions>
      <template v-if="creation">
        <div class="creation-model-choice"><NFormItem label="选择工作区模型" label-placement="left" :show-feedback="false"><NSelect aria-label="员工使用的模型" :value="selectedProfileId??''" :options="creationOptions" :disabled="locked||catalogDirty" :input-props="{'aria-label':'员工使用的模型'}" :virtual-scroll="false" @update:value="v=>selectedProfileId=String(v)||null" /></NFormItem><span class="model-selection-status" :class="{'model-selected':selectedReady}">{{selectedReady?'已选择':'未配置可用模型'}}</span></div>
        <p class="field-note model-choice-note">默认使用已有模型，无需重复填写密钥。</p>
        <p v-if="!selectedReady" class="field-note" role="status">没有可用模型时仍可创建员工；配置前暂不能对话、执行任务或生成摘要。</p>
        <NButton class="add-model-toggle" aria-label="添加新模型" :disabled="locked" :aria-expanded="editing" aria-controls="creation-model-form" @click="editing?cancelEdit():edit(null)"><span>＋　添加新模型</span><span class="model-toggle-note">{{editing?'收起配置':'名称、服务地址、API Key'}}　{{editing?'⌃':'⌄'}}</span></NButton>
      </template>
      <template v-else-if="!editing">
        <div v-if="isWorkspace||canEditCatalog" class="model-list-header"><span>{{ isWorkspace ? '工作区模型' : '选择员工使用的模型' }}</span><NButton v-if="canEditCatalog" aria-label="新增共享模型" title="新增共享模型" :disabled="locked" @click="edit(null)">＋</NButton></div>
        <NForm v-if="profiles.length" class="selection-form settings-form" @submit.prevent="selectModel">
          <ModelSelector v-if="!isWorkspace" v-model:value="selectedProfileId" :profiles="profiles" :disabled="locked"/><NFormItem v-else :label="isWorkspace ? '工作区默认模型' : '员工使用的模型'">
            <NRadioGroup :value="(isWorkspace ? defaultProfileId : selectedProfileId) ?? ''" :disabled="locked" :aria-label="isWorkspace ? '工作区默认模型' : '员工使用的模型'" @update:value="value => { if (isWorkspace) defaultProfileId = String(value) || null; else selectedProfileId = String(value) || null; }">
              <div class="model-choice"><NRadio value="">{{ isWorkspace ? '不设置默认模型' : '继承工作区默认模型' }}</NRadio></div>
              <div v-for="item in profiles" :key="item.id" class="model-choice">
                <NRadio :value="item.id" :disabled="!item.enabled"><span>{{ item.name }}</span><small>model ID：{{ item.modelId }}{{ item.enabled ? '' : ' · 已停用' }}</small><small v-if="isWorkspace">直接引用：{{ item.referenceCount }}处（含工作区默认项）；继承默认的员工也会受影响。</small></NRadio>
                <NSpace v-if="isWorkspace && canEditCatalog && !draft"><NButton :disabled="locked" @click="edit(item)">编辑 {{ item.name }}</NButton><NButton :disabled="locked || (!item.enabled && !item.secretRef)" @click="toggle(item)">{{ item.enabled?'停用':'启用' }}</NButton><NPopconfirm :disabled="locked" positive-text="确认停用并撤销" negative-text="取消" @positive-click="revoke(item)"><template #trigger><NButton :disabled="locked || (!item.enabled && !item.secretRef)">停用并撤销凭据</NButton></template>确认停用「{{ item.name }}」并清除其已保存的密钥？所有引用它的员工将无法发起新的模型调用。</NPopconfirm></NSpace>
              </div>
            </NRadioGroup>
          </NFormItem>
          <p v-if="isWorkspace" class="field-note">默认模型供未单独选择模型的员工使用。</p><p v-else-if="!selectedProfileId&&(!defaultProfileId||!profiles.some(p=>p.id===defaultProfileId&&p.enabled))" class="field-note" role="status">当前没有可用的默认模型。请选择模型，也可以先创建员工，稍后配置。</p>
          <NSpace v-if="!draft"><NButton attr-type="submit" :disabled="locked" :loading="busy">{{ isWorkspace ? '保存默认模型' : '保存模型选择' }}</NButton><NButton v-if="!isWorkspace" :disabled="locked" @click="selectedProfileId = effective?.selectedProfileId ?? null">取消模型选择修改</NButton><NButton v-if="!isWorkspace" :disabled="locked || !effective?.selectedProfileId" @click="selectedProfileId = null; selectModel()">恢复继承默认模型</NButton><NButton :disabled="locked" @click="load">重新读取</NButton></NSpace>
        </NForm>
        <slot name="employee-options"/><NEmpty v-if="!profiles.length" description="尚无可用模型。可先创建员工，再到资源库添加模型并返回选择；配置前暂不能对话、执行任务或生成摘要。" />
        <p v-if="!canEditCatalog" class="field-note">需要新增或修改模型？请到资源库的「模型」中操作。</p>
      </template>
    </template>
    <NForm v-if="editing && canEditCatalog" :id="creation?'creation-model-form':undefined" ref="formRef" class="config-form settings-form" :model="formModel" :rules="rules" @submit.prevent="validateAnd(save)">
      <NAlert v-if="profile" type="warning">正在修改共享模型，当前有 {{ profile.referenceCount }} 处配置引用（员工直接选择及工作区默认项），继承工作区默认配置的员工也会受影响。修改后需重新测试并保存。</NAlert>
      <p v-else class="field-note">{{ draft ? '确认创建时才会保存此模型，退出将丢弃未保存的内容。' : creation ? '测试通过后保存到工作区模型库，并自动为新员工选中。退出员工创建时，已保存的共享模型会保留。' : isWorkspace ? '新增配置将保存在本工作区模型库。保存后可设置为默认模型。' : '新增配置将同步到本工作区模型库，保存成功后自动为此员工选中。' }}</p>
      <NFormItem label="配置显示名称" path="name"><NInput v-model:value="name" :input-props="{ 'aria-label': '配置名称' }" :disabled="locked" :maxlength="100" placeholder="便于团队识别的名称" /></NFormItem>
      <NFormItem label="接口协议"><NSelect v-model:value="protocol" :disabled="locked" :options="[{label:'Chat Completions',value:'chat_completions'},{label:'Responses',value:'openai_responses'},{label:'Anthropic Messages',value:'anthropic_messages'}]" :virtual-scroll="false" :input-props="{'aria-label':'接口协议'}" /></NFormItem>
      <NFormItem label="模型地址" path="endpoint"><NInput v-model:value="endpoint" :input-props="{ 'aria-label': '模型地址' }" :disabled="locked" :maxlength="2048" autocomplete="off" placeholder="模型 API 基础地址，例如 https://api.example.com/v1" /></NFormItem>
      <NFormItem label="模型名称（model ID）" path="modelId"><NInput v-model:value="modelId" :input-props="{ 'aria-label': '模型名称' }" :disabled="locked" :maxlength="200" autocomplete="off" placeholder="供应商要求的实际 model ID，不是显示名称" /></NFormItem>
      <NFormItem label="API Key · 只写，不回显"><NInput v-model:value="apiKey" :input-props="{ 'aria-label': 'API Key · 只写，不回显' }" :disabled="locked" type="password" show-password-on="click" autocomplete="new-password" :maxlength="8192" :placeholder="profile?.secretRef ? '留空保留已保存密钥' : '输入新的密钥'" /></NFormItem>
      <NAlert v-if="endpointChanged" type="warning">地址变更：必须重新输入密钥。不会自动把旧密钥发送给新地址。</NAlert>
      <NSpace vertical><NCheckbox v-if="isWorkspace && !profile && !creation" v-model:checked="setAsDefault" :disabled="locked">同时设为工作区默认模型</NCheckbox><NCheckbox v-model:checked="enabled" :disabled="locked">启用此模型配置</NCheckbox>
      <NAlert type="info">联通测试会将填写的模型和密钥发送到此模型地址，可能产生少量费用，不会执行工具。测试通过后才能保存。</NAlert>
      <p class="field-note">取消会丢弃当前未保存表单，保留已有模型选择。</p><NSpace><NButton :disabled="locked" :loading="busy" @click="validateAnd(testConnection)">联通测试</NButton><NButton v-if="!draft" type="primary" attr-type="submit" :disabled="locked || !tested">保存</NButton><NButton :disabled="locked" @click="cancelEdit">{{ creation?'取消添加模型':'取消' }}</NButton><span v-if="draft && tested" role="status">当前草稿已验证，最后一步统一保存。</span></NSpace></NSpace>
    </NForm>
  </template>
</NCard>
</template>
<style scoped>
.creation-model{background:transparent}.creation-model-choice{display:flex;align-items:center;gap:1rem;margin-top:0}.creation-model-choice :deep(.n-form-item){flex:1;min-width:0;display:grid;grid-template-columns:auto minmax(0,1fr);grid-template-areas:"label blank";align-items:start;gap:0 1rem}.creation-model-choice :deep(.n-form-item-label){padding:7px 0 0;justify-content:flex-start;text-align:left}.model-selection-status{flex:none;align-self:flex-start;padding-top:7px;color:var(--muted);font-size:.875rem}.model-selected::before{content:'●';margin-right:.5rem}.model-choice-note{margin:.5rem 0 1rem}.add-model-toggle{width:100%;height:auto;min-height:3.5rem;padding:.75rem 1rem;background:var(--background)}.add-model-toggle :deep(.n-button__content){width:100%;justify-content:space-between;gap:1rem}.model-toggle-note{font-size:.8125rem;color:var(--muted);font-weight:400}.creation-model :deep(.n-form-item-blank){min-width:0}.creation-model .config-form{padding:1rem;border:1px solid var(--subtle);border-radius:var(--id-radius-control);background:var(--background)}@media(max-width:47.5rem){.creation-model-choice{display:block}.creation-model-choice :deep(.n-form-item){display:block}.model-selection-status{display:block;margin-bottom:.75rem;padding:0}.model-toggle-note{display:none}}
.config-form, .selection-form { margin-top: 1.25rem; } .model-list-header { display:flex; align-items:center; justify-content:space-between; gap:0.75rem; margin-top:1rem; font-weight:600; } .selection-form :deep(.n-radio-group) { width:100%; } .model-choice { display:flex; justify-content:space-between; align-items:center; gap:0.75rem; padding:0.875rem 0; border-bottom:1px solid var(--subtle); flex-wrap:wrap; } .model-choice small { display:block; margin-top:0.25rem; color:var(--muted); }
</style>
