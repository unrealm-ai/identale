<script setup lang="ts">
import { computed } from 'vue';
import { NTabPane, NTabs } from 'naive-ui';
import type { Workspace } from '../../shared/api';
import ModelSettings from '../employees/ModelSettings.vue';
import DirectorySyncManagement from './DirectorySyncManagement.vue';
import ChannelDirectory from './ChannelDirectory.vue';
import WorkspaceDetails from './WorkspaceDetails.vue';
import ResourceManagement from './ResourceManagement.vue';
import MemberManagement from './MemberManagement.vue';
import PageHeader from '../../shared/ui/PageHeader.vue';
import SystemRuntimeStatus from '../workbench/SystemRuntimeStatus.vue';
import ConnectionOverview from './ConnectionOverview.vue';
import { useAccessibleTabs, vAccessibleTablist } from '../../shared/ui/useAccessibleTabs';
type Section = 'directory' | 'models' | 'skills' | 'mcp' | 'members' | 'workspace' | 'monitor';
const props = defineProps<{ workspace: Workspace; section: Section; busy: boolean; group?: 'resources' | 'workspace' | undefined }>();
const emit = defineEmits<{ sectionChanged: [Section]; busyChanged: [boolean]; sessionExpired: []; invite: []; openEmployeeChannels: [string]; workspaceRenamed: [Workspace] }>();
const admin = computed(() => ['owner', 'admin'].includes(props.workspace.role));
const sections = computed(() => props.group === 'resources' ? ['skills', 'mcp', 'models', 'directory'] : props.group === 'workspace' ? ['workspace', ...(admin.value ? ['members'] : []), 'monitor'] : ['mcp', 'skills', 'models', ...(admin.value ? ['members'] : []), 'directory']);
const resourceKinds = computed<('skills' | 'mcp')[]>(() => props.group === 'resources' ? ['skills', 'mcp'] : ['mcp', 'skills']);
const section = computed({ get: () => sections.value.includes(props.section) ? props.section : sections.value[0] as Section, set: (value: Section) => { if (!props.busy && sections.value.includes(value)) emit('sectionChanged', value); } });
const { tabProps, panelProps } = useAccessibleTabs(section, () => sections.value, () => props.busy);
</script>
<template><section class="workspace-management">
 <PageHeader :title="group === 'resources' ? '资源库' : group === 'workspace' ? '设置' : '管理'" :description="group === 'resources' ? '管理工作区可复用的能力、工具与资料。' : '管理工作区信息与成员。'"></PageHeader>
 <NTabs v-if="sections.length" v-accessible-tablist="'工作区管理分类'" v-model:value="section" type="line" :on-before-leave="() => !busy">
  <NTabPane v-if="sections.includes('workspace')" name="workspace" tab="工作区" :tab-props="tabProps('workspace')" v-bind="panelProps('workspace')" :disabled="busy" display-directive="if"><WorkspaceDetails :key="workspace.id" :workspace="workspace" @workspace-renamed="value => emit('workspaceRenamed', value)" @busy-changed="value => emit('busyChanged', value)" @session-expired="emit('sessionExpired')" /></NTabPane>
  <NTabPane v-for="kind in resourceKinds.filter(value => sections.includes(value))" :key="kind" :name="kind" :tab="kind === 'mcp' ? 'MCP' : 'Skills'" :tab-props="tabProps(kind)" v-bind="panelProps(kind)" :disabled="busy" display-directive="if"><ResourceManagement :key="`${workspace.id}:${kind}`" :workspace-id="workspace.id" :kind="kind" :disabled="false" @busy-changed="value => emit('busyChanged', value)" @session-expired="emit('sessionExpired')" /></NTabPane>
  <NTabPane v-if="sections.includes('models')" name="models" tab="模型" :tab-props="tabProps('models')" v-bind="panelProps('models')" :disabled="busy" display-directive="if"><ModelSettings :key="workspace.id" :base="`/workspaces/${encodeURIComponent(workspace.id)}`" scope="workspace" :can-manage="true" @busy-changed="value => emit('busyChanged', value)" @session-expired="emit('sessionExpired')" /></NTabPane>
  <NTabPane v-if="admin && sections.includes('members')" name="members" tab="成员" :tab-props="tabProps('members')" v-bind="panelProps('members')" :disabled="busy" display-directive="if"><MemberManagement :key="workspace.id" :workspace="workspace" :disabled="false" @invite="emit('invite')" @busy-changed="value => emit('busyChanged', value)" @session-expired="emit('sessionExpired')" /></NTabPane>
  <NTabPane v-if="sections.includes('monitor')" name="monitor" tab="运行监控" :tab-props="tabProps('monitor')" v-bind="panelProps('monitor')" :disabled="busy" display-directive="if"><SystemRuntimeStatus v-if="admin" :workspace-id="workspace.id" @session-expired="emit('sessionExpired')"/><ConnectionOverview :key="workspace.id" :workspace="workspace" @open="id => emit('openEmployeeChannels', id)" @session-expired="emit('sessionExpired')"/></NTabPane>
  <NTabPane v-if="sections.includes('directory')" name="directory" :tab="group === 'resources' ? '渠道通讯录' : '同步任务'" :tab-props="tabProps('directory')" v-bind="panelProps('directory')" :disabled="busy" display-directive="if"><ChannelDirectory v-if="group === 'resources'" :key="workspace.id" :workspace="workspace" @open-employee-channels="id => emit('openEmployeeChannels', id)" @busy-changed="value => emit('busyChanged', value)" @session-expired="emit('sessionExpired')" /><DirectorySyncManagement v-else :key="workspace.id" :workspace="workspace" @busy-changed="value => emit('busyChanged', value)" @session-expired="emit('sessionExpired')" /></NTabPane>
 </NTabs>
</section></template>
<style scoped>.workspace-management{display:grid;grid-template-columns:minmax(0,1fr);gap:0;min-width:0}.workspace-management>:deep(.n-tabs){min-width:0;max-width:100%}.workspace-management :deep(.n-tabs-pane-wrapper){padding-top:0}.workspace-management :deep(.n-tabs-nav){margin-bottom:.5rem}.workspace-management :deep(.n-tabs-tab){border-radius:999px;padding:.625rem 1rem;transition:background-color 120ms,color 120ms}.workspace-management :deep(.n-tabs-tab--active){background:var(--id-primary);color:var(--id-on-primary)}.workspace-management :deep(.n-tabs-tab--active .n-tabs-tab__label){color:var(--id-on-primary)}.workspace-management :deep(.n-tabs-bar){display:none}.workspace-management :deep(.n-tabs-tab-pad){width:.5rem}.workspace-management :deep(.n-tabs-tab:focus-visible){outline:2px solid var(--focus);outline-offset:2px}</style>
