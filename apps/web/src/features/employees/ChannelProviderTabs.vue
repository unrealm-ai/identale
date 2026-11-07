<script setup lang="ts">
import ChannelBrand from './ChannelBrand.vue';
import AutomationBrand from './AutomationBrand.vue';
import { computed, ref, useSlots, watch } from 'vue';
import { NTab, NTabs } from 'naive-ui';
import { useAccessibleTabs, vAccessibleTablist } from '../../shared/ui/useAccessibleTabs';
import type { DirectoryProvider } from '../directory/types';
const props = defineProps<{ disabled?: boolean; hideNavigation?: boolean; beforeChange?:(provider:DirectoryProvider)=>boolean }>();
const provider = defineModel<DirectoryProvider>({ required: true });
const providers: DirectoryProvider[] = ['feishu', 'dingtalk', 'wecom'];
type WorkEntry = DirectoryProvider | 'automation';
const slots = useSlots();
const entry = ref<WorkEntry>(provider.value);
const entries = computed(() => slots.automation ? [...providers, 'automation'] : providers);
watch(provider, value => { if (entry.value !== 'automation') entry.value = value; });
function selectEntry(value: WorkEntry) {
  if (props.disabled || value!=='automation'&&props.beforeChange?.(value)===false) return;
  entry.value = value;
  // Automation only changes the visible panel; keep the channel and its draft intact.
  if (value !== 'automation') provider.value = value;
}
const { tabProps, panelProps } = useAccessibleTabs(entry, () => entries.value, () => !!props.disabled, true);
</script>
<template>
  <NTabs class="channel-provider-tabs" v-if="!hideNavigation" v-accessible-tablist="slots.automation ? '员工工作入口' : '员工渠道'" :value="entry" type="line" animated :on-before-leave="() => !disabled" @update:value="selectEntry">
    <NTab v-for="item in providers" :key="item" :name="item" v-bind="tabProps(item)" :disabled="disabled"><ChannelBrand :provider="item" /></NTab>
    <NTab v-if="slots.automation" name="automation" v-bind="tabProps('automation')" :disabled="disabled"><AutomationBrand /></NTab>
  </NTabs>
  <div v-bind="hideNavigation ? {} : panelProps(entry)" class="work-entry-panel">
    <div v-show="entry !== 'automation'" :inert="entry === 'automation'"><slot /></div>
    <div v-if="slots.automation" v-show="entry === 'automation'" :inert="entry !== 'automation'"><slot name="automation" /></div>
  </div>
</template>
<style scoped>.channel-provider-tabs{min-width:0;max-width:100%}.channel-provider-tabs :deep(.n-tabs-nav){width:100%;min-width:0}.channel-provider-tabs :deep(.n-tabs-tab){min-height:2.75rem;padding:.5rem 0}.channel-provider-tabs :deep(.n-tabs-nav-scroll-wrapper){min-width:0}.work-entry-panel{min-width:0}.work-entry-panel>div{display:grid;grid-template-columns:minmax(0,1fr);gap:1rem;min-width:0}</style>
