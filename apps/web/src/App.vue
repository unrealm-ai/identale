<!-- Modified for Identale: add default source attribution; see NOTICE. -->
<script setup lang="ts">
import { computed, defineAsyncComponent, reactive, ref,watch,onUnmounted } from 'vue';
import { NAlert, NButton, NCard, NConfigProvider, NDropdown, NEmpty, NGlobalStyle, NSkeleton, NSpace, NDrawer,NDrawerContent,NTabs,NTabPane,darkTheme,zhCN, dateZhCN } from 'naive-ui';
import type { DropdownOption } from 'naive-ui';
import { themeOverrides,themeVariables } from './shared/theme';
import {useWorkItemBeta}from'./features/work-items/useWorkItemBeta';
import { useWorkbench } from './app/useWorkbench';
import AuthPage from './features/auth/AuthPage.vue';
import WorkspaceDialog from './features/workspaces/WorkspaceDialog.vue';
import EmployeeDirectory from './features/employees/EmployeeDirectory.vue';
import PageHeader from './shared/ui/PageHeader.vue';
import BrandLogo from './shared/ui/BrandLogo.vue';
import SourceAttribution from './shared/ui/SourceAttribution.vue';
import AccountMenu from './shared/ui/AccountMenu.vue';
import RailNav from './shared/ui/RailNav.vue';
import HomePage from './features/home/HomePage.vue';
import HumanRequestsPage from './features/work-items/HumanRequestsPage.vue';
const WorkbenchPage=defineAsyncComponent({loader:()=>import('./features/workbench/WorkbenchPage.vue').then(module=>module.default),loadingComponent:FeatureLoading,errorComponent:FeatureLoadError,delay:150,timeout:30000});
import FeatureLoading from './shared/ui/FeatureLoading.vue';
import FeatureLoadError from './shared/ui/FeatureLoadError.vue';
const WorkspaceManagement=defineAsyncComponent({loader:()=>import('./features/management/WorkspaceManagement.vue').then(module=>module.default),loadingComponent:FeatureLoading,errorComponent:FeatureLoadError,delay:150,timeout:30000});
const EntityWizard = defineAsyncComponent({ loader: () => import('./EntityWizard.vue').then(module => module.default), loadingComponent: FeatureLoading, errorComponent: FeatureLoadError, delay: 150, timeout: 30000 });
const EmployeeSettings = defineAsyncComponent({ loader: () => import('./EmployeeSettings.vue').then(module => module.default), loadingComponent: FeatureLoading, errorComponent: FeatureLoadError, delay: 150, timeout: 30000 });
const EntityWorkspace = defineAsyncComponent({ loader: () => import('./EntityWorkspace.vue').then(module => module.default), loadingComponent: FeatureLoading, errorComponent: FeatureLoadError, delay: 150, timeout: 30000 });
const ConversationList = defineAsyncComponent({ loader: () => import('./ConversationList.vue').then(module => module.default), loadingComponent: FeatureLoading, errorComponent: FeatureLoadError, delay: 150, timeout: 30000 });
const PlatformTasks = defineAsyncComponent({ loader: () => import('./features/tasks/PlatformTasks.vue').then(module => module.default), loadingComponent: FeatureLoading, errorComponent: FeatureLoadError, delay: 150, timeout: 30000 });
const w = reactive(useWorkbench());
const workItemBeta=useWorkItemBeta(()=>w.selected?'/workspaces/'+encodeURIComponent(w.selected.id):'',()=>w.clearSession());
const WorkItemsPage=defineAsyncComponent(()=>import('./features/work-items/WorkItemsPage.vue'));
function openWorkItem(id:string){w.workItemId=id;w.navigate('work-items');}
function openHomeTask(id:string){w.navigate('tasks');const url=new URL(location.href);url.searchParams.set('task',id);history.replaceState(null,'',url.pathname+url.search);}
function selectWorkItem(id:string|undefined){w.workItemId=id;w.updateRoute(true);}
const mobileNav=ref(false);
const employeeWizard=ref<{requestClose:()=>void}|null>(null);
const pendingNavigation=ref<Parameters<typeof w.navigate>[0]|null>(null);
const primaryNavigationLocked=computed(()=>w.busy||w.wizardBusy||w.settingsBusy);
function closeEmployeeWizard(){const next=pendingNavigation.value;pendingNavigation.value=null;void w.closeWizard(next??undefined);}
watch(()=>w.wizardOpen,open=>{if(!open)pendingNavigation.value=null;});
function storedTheme(){try{const value=localStorage.getItem('identity:theme');return value==='dark'||value==='light'?value:null;}catch{return null;}}
const themeChoice=ref<'light'|'dark'|null>(storedTheme());
const systemDark=ref(false);
try{const media=window.matchMedia('(prefers-color-scheme: dark)');systemDark.value=media.matches;const onScheme=(event:MediaQueryListEvent)=>{systemDark.value=event.matches;};media.addEventListener?.('change',onScheme);onUnmounted(()=>media.removeEventListener?.('change',onScheme));}catch{/* Preference media is optional. */}
const dark=computed(()=>themeChoice.value?themeChoice.value==='dark':systemDark.value);
function toggleTheme(){const next=dark.value?'light':'dark';themeChoice.value=next;try{localStorage.setItem('identity:theme',next);}catch{/* Optional display preference. */}}
watch(dark,value=>{for(const[k,v]of Object.entries(themeVariables(value?'dark':'light')))document.documentElement.style.setProperty(k,v);document.documentElement.dataset.theme=value?'dark':'light';},{immediate:true});
const mobileMedia=window.matchMedia('(max-width:760px)'),compact=ref(mobileMedia.matches);
const updateCompact=()=>compact.value=mobileMedia.matches;mobileMedia.addEventListener('change',updateCompact);onUnmounted(()=>mobileMedia.removeEventListener('change',updateCompact));
const examplesEnabled=import.meta.env?.DEV===true||import.meta.env?.MODE==='test';
const ComponentExamples=defineAsyncComponent(()=>import('./shared/ui/ComponentExamples.vue'));
const ConnectionOverview=defineAsyncComponent(()=>import('./features/management/ConnectionOverview.vue'));

const menuValue = computed(() => w.view==='home'?'home':w.view==='work-items'?'work-items':['workbench','tasks'].includes(w.view)?'tasks':['management','workspace-models','resources'].includes(w.view)?'resources':['workspace-settings','connections'].includes(w.view)?'workspace-settings':'employees');
function navigationHref(key:string){const url=new URL(location.href);for(const name of ['ws','view','entity','conversation','section','q'])url.searchParams.delete(name);if(w.selected)url.searchParams.set('ws',w.selected.id);url.searchParams.set('view',key);if(key==='employees'&&w.employeeQuery)url.searchParams.set('q',w.employeeQuery);if(key==='tasks'){const entity=w.view==='chat'?w.activeEntity?.id:w.taskEntityId;if(entity)url.searchParams.set('entity',entity);}const section=({resources:'models',connections:'directory','workspace-settings':'workspace'} as Record<string,string>)[key];if(section)url.searchParams.set('section',section);return url.pathname+url.search;}
function followNavigation(event:MouseEvent,key:string){event.stopPropagation();if(primaryNavigationLocked.value){event.preventDefault();return;}if(event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();selectView(key);}}
const railIcons:Record<string,string[]>={
  home:['M3 10.5 12 3l9 7.5','M5 9v11a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9'],
  'work-items':['M4 4h16v16H4z','M9 4v16','M15 4v16'],
  employees:['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2','M9 7a4 4 0 1 0 0 .01','M22 21v-2a4 4 0 0 0-3-3.87','M16 3.13a4 4 0 0 1 0 7.75'],
  tasks:['m3 17 2 2 4-4','m3 7 2 2 4-4','M13 6h8','M13 12h8','M13 18h8'],
  resources:['M16 6l4 14','M12 6v14','M8 8v12','M4 4v16'],
  'workspace-settings':['M20 7h-9','M14 17H5','M17 17a3 3 0 1 0 .01 0','M7 7a3 3 0 1 0 .01 0'],
};
const railItems=computed(()=>[
  ['首页','home'],
  ['数字员工','employees'],
  ['任务','tasks'],
  ...(workItemBeta.readable.value?[['事项看板','work-items']]:[]),
  ['资源库','resources'],
  ['设置','workspace-settings'],
].map(([label,key])=>({label:label!,key:key!,paths:railIcons[key!]??[]})));
const crumb=computed(()=>({home:'首页',employees:'数字员工',conversations:'对话',tasks:'任务',workbench:'任务',resources:'资源库',management:'资源库','workspace-settings':'设置','workspace-models':'资源库',settings:w.activeEntity?.name??'数字员工',chat:'对话','work-items':'事项看板',connections:'任务',components:'组件'} as Record<string,string>)[w.view]??'');
const pageTitle=computed(()=>{if(!w.user)return w.invitationToken?'加入':w.mode==='register'?'注册':'登录';return crumb.value||'首页';});
watch(pageTitle,title=>{document.title=`${title} · identale`;},{immediate:true});
const workspaceOptions = computed<DropdownOption[]>(() => [
  { label: '你的工作区', key: 'workspace-heading', type: 'group', children: w.workspaces.map(item => ({ label: `${item.name} · ${w.roleLabel(item.role)}${item.id === w.selected?.id ? ' ✓' : ''}`, key: `workspace:${item.id}`, disabled: w.navigationLocked, props: { role: 'menuitem', 'aria-disabled': w.navigationLocked ? 'true' : 'false' } })) },
  { key: 'divider', type: 'divider' }, { label: '＋ 创建工作区', key: 'create', props: { role: 'menuitem' } }, { label: '加入工作区', key: 'join', props: { role: 'menuitem' } },
]);
function selectWorkspace(key: string) { if (w.navigationLocked) return; if (key.startsWith('workspace:')) void w.switchWorkspace(key.slice(10)); else if (key === 'workspace-models') { if (!w.canManage) return; w.closeWorkspaceMenu(); w.navigate(key); } else w.openWorkspaceDialog(key as 'create' | 'join' | 'invite'); }
function selectView(key: string) {
  if(primaryNavigationLocked.value)return;
  mobileNav.value=false;
  if(w.wizardOpen){pendingNavigation.value=key as typeof w.view;employeeWizard.value?.requestClose();return;}
  w.navigate(key as typeof w.view);
}
</script>
<template>
<NConfigProvider :theme="dark?darkTheme:null" :theme-overrides="themeOverrides(dark?'dark':'light',compact)" :locale="zhCN" :date-locale="dateZhCN"><NGlobalStyle />
<div class="shell" :class="{ 'is-authenticated': !!w.user }" :style="themeVariables(dark?'dark':'light')" :data-theme="dark?'dark':'light'">
  <NButton v-if="!w.user" class="auth-theme-toggle" quaternary :aria-label="dark?'切换浅色主题':'切换深色主题'" @click="toggleTheme">{{dark?'浅色主题':'深色主题'}}</NButton><a class="skip-link" href="#main-content">跳至主要内容</a><header v-if="w.user" class="topbar"><NButton class="mobile-nav-trigger" aria-label="打开工作台导航" @click="mobileNav=true">☰</NButton><component :is="primaryNavigationLocked?'span':'a'" class="brand mobile-brand" :href="primaryNavigationLocked?undefined:navigationHref('home')" aria-label="identale 首页" @click="(event:MouseEvent)=>followNavigation(event,'home')"><BrandLogo compact/></component><div class="crumb" aria-label="当前位置"><span>{{w.selected?.name}}</span><span aria-hidden="true"> / </span><b>{{crumb}}</b></div>
    <div class="header-actions"><NButton v-if="w.selected" quaternary :disabled="w.navigationLocked" aria-label="待你处理" @click="w.navigate('tasks');w.taskSection='human';w.updateRoute(true)"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg></NButton><NButton class="theme-toggle" quaternary :aria-label="dark?'切换浅色主题':'切换深色主题'" @click="toggleTheme">{{dark?'浅色':'深色'}}</NButton><NDropdown :show="w.workspaceMenuOpen" trigger="click" :options="workspaceOptions" :menu-props="() => ({role:'menu','aria-label':'工作区选择与管理'})" placement="bottom-end" @update:show="value=>{w.workspaceMenuOpen=value}" @select="selectWorkspace"><NButton class="workspace-trigger" :disabled="w.navigationLocked||w.booting" :aria-expanded="w.workspaceMenuOpen" aria-label="工作区选择与管理"><span class="workspace-mark" aria-hidden="true">{{(w.selected?.name??'区').slice(0,1)}}</span><span class="workspace-trigger-copy">{{w.selected?.name??'选择工作区'}}</span><span class="dropdown-caret" aria-hidden="true">⌄</span></NButton></NDropdown></div>
  </header>
  <div class="workspace-body">
    <aside v-if="w.user&&w.selected&&!w.booting" class="app-nav" aria-label="主导航"><component :is="primaryNavigationLocked?'span':'a'" class="brand rail-brand" :href="primaryNavigationLocked?undefined:navigationHref('home')" aria-label="identale 首页" @click="(event:MouseEvent)=>followNavigation(event,'home')"><BrandLogo compact inverse/></component><RailNav :items="railItems" :locked="primaryNavigationLocked" :current="menuValue" :href="navigationHref" @select="(key,event)=>followNavigation(event,key)"/><div class="app-nav-footer"><AccountMenu :name="w.user.displayName||w.user.username" :username="w.user.username" :dark="dark" :disabled="w.navigationLocked" @theme="toggleTheme" @logout="w.logout"/></div></aside>
    <NDrawer v-model:show="mobileNav" placement="left" :width="'min(300px, 90vw)'" :auto-focus="true"><NDrawerContent title="工作台导航" closable><RailNav layout="drawer" :items="railItems" :locked="primaryNavigationLocked" :current="menuValue" :href="navigationHref" @select="(key,event)=>followNavigation(event,key)"/><template #footer><div v-if="w.user" style="width:100%"><p v-if="w.navigationLocked" class="field-note">请先保存或取消当前修改。</p><AccountMenu :name="w.user.displayName||w.user.username" :username="w.user.username" :dark="dark" :disabled="w.navigationLocked" @theme="toggleTheme" @logout="mobileNav=false;w.logout()"/></div></template></NDrawerContent></NDrawer><main id="main-content" tabindex="-1" class="app-content">
      <NAlert v-if="w.error && !w.workspaceAction" type="error" role="alert" class="section-feedback">{{ w.error }}</NAlert><NAlert v-if="w.notice" type="success" role="status" class="section-feedback success-feedback" closable @close="w.notice = ''">{{ w.notice }}</NAlert>
      <div v-if="w.booting" role="status"><p>正在连接工作台…</p><NSkeleton text :repeat="4" /></div>
      <template v-else>
        <NCard v-if="w.invitationToken && !w.user" class="invite-context" title="工作区邀请"><template #header-extra><NButton quaternary :disabled="w.busy" @click="w.cancelInvitation">放弃本次邀请</NButton></template><template v-if="w.invitation"><p>受邀加入 {{ w.invitation.workspace.name }}，角色：{{ w.roleLabel(w.invitation.role) }}。</p><p class="muted">有效期至 {{ w.formatTime(w.invitation.expiresAt) }}。邀请仅限一次使用，请勿公开传播链接。</p><p class="muted">已有账号请登录后确认加入；新账号注册后直接加入，不额外创建工作区。</p></template><template v-else><p>尚未确认邀请有效性，不会自动改为普通注册。</p><NButton :disabled="w.busy" @click="w.run(w.inspectInvitation)">重新检查邀请</NButton></template></NCard>
        <AuthPage v-if="!w.user" v-model:mode="w.mode" v-model:username="w.username" v-model:password="w.password" v-model:display-name="w.displayName" :busy="w.busy" :invitation-token="w.invitationToken" :invitation-valid="!!w.invitation" @submit="w.authenticate" />
        <template v-else-if="w.selected">
          <EntityWizard ref="employeeWizard" v-if="w.wizardOpen" :key="w.selected.id" :workspace="w.selected" @created="w.entityUpdated" @done="w.finishWizard" @close="closeEmployeeWizard" @close-cancelled="pendingNavigation=null" @busy-changed="value => { w.wizardBusy = value; }" @session-expired="w.clearSession" />
          <HomePage v-else-if="w.view==='home'" :name="w.user.displayName||w.user.username" :admin="w.canManage" :workspace-id="w.selected.id" :entities="w.entities" @create="w.wizardOpen=true" @conversations="w.navigate('conversations')" @employees="w.navigate('employees')" @tasks="w.navigate('tasks')" @human="w.navigate('tasks');w.taskSection='human';w.updateRoute(true)" @monitor="w.navigate('connections')" @open-task="openHomeTask" @open-conversation="(entity,id)=>w.navigate('chat',entity,id)" @open-employee="id=>w.openEmployee(id)" @session-expired="w.clearSession" /><WorkItemsPage v-else-if="w.view==='work-items'" :key="w.selected.id" :workspace="w.selected" :entities="w.entities" :enabled="workItemBeta.readable.value" :selected-id="w.workItemId" @selected="selectWorkItem" @session-expired="w.clearSession"/><WorkbenchPage v-else-if="w.view==='workbench'" :key="w.selected.id" :workspace="w.selected" :entities="w.entities" :section="w.workbenchSection" @open-work-item="openWorkItem" :entity-id="w.taskEntityId" :conversation-id="w.conversationId" :disabled="w.navigationLocked" @section-changed="w.selectWorkbenchSection" @filters-changed="(id,conversation)=>{w.taskEntityId=id;w.conversationId=conversation;w.updateRoute(true)}" @open-employee="(id,section)=>id?w.openEmployee(id,section):w.navigate('employees')" @open-conversation="(entity,id)=>w.navigate('chat',entity,id)" @session-expired="w.clearSession"/><ComponentExamples v-else-if="w.view==='components'&&examplesEnabled"/><NAlert v-else-if="w.view==='components'" type="info">组件样例仅在开发和测试环境开放。</NAlert><ConnectionOverview v-else-if="w.view==='connections'" :workspace="w.selected" @open="entityId=>w.openEmployee(entityId,'channels')" @session-expired="w.clearSession"/><WorkspaceManagement v-else-if="['management','resources','workspace-settings'].includes(w.view)" :group="w.view==='resources'?'resources':w.view==='workspace-settings'?'workspace':undefined" :key="w.selected.id" :workspace="w.selected" :section="w.managementSection" :busy="w.settingsBusy" @invite="w.openWorkspaceDialog('invite')" @section-changed="w.selectManagementSection" @workspace-renamed="w.workspaceRenamed" @open-employee-channels="id=>w.openEmployee(id,'channels')" @busy-changed="value=>{w.settingsBusy=value}" @session-expired="w.clearSession" />
          <EmployeeDirectory v-else-if="w.view === 'employees'" :entities="w.entities" :query="w.employeeQuery" :has-more="!!w.employeeCursor" @search="w.searchEmployees" @more="w.loadEntities(true)" :loaded="w.entitiesLoaded" :busy="w.entityLoading" :can-manage="true" :can-edit="w.canEdit" @refresh="w.loadEntities()" @create="w.wizardOpen = true" @chat="entity => w.navigate('chat', entity)" @settings="entity => w.navigate('settings', entity)" @recent-conversations="w.navigate('conversations')" />
          <ConversationList v-else-if="w.view === 'conversations'" :key="w.selected.id" :workspace="w.selected" :entities="w.entities" @open="(entity, id) => w.navigate('chat', entity, id)" @session-expired="w.clearSession" />
          <EmployeeSettings v-else-if="w.view === 'settings' && w.activeEntity" :key="`${w.selected.id}:${w.activeEntity.id}:settings`" :entity="w.activeEntity" :workspace="w.selected" :section="w.employeeSection" :conversation-id="w.conversationId" @conversation-selected="id=>{w.conversationId=id;w.updateRoute(true)}" @recent-conversations="w.navigate('conversations')" @section-changed="w.selectEmployeeSection" @chat="w.navigate('chat',w.activeEntity!)" @busy-changed="value => { w.settingsBusy = value; }" @entity-updated="w.entityUpdated" @close="w.navigate('employees')" @session-expired="w.clearSession" />
          <EntityWorkspace v-else-if="w.view === 'chat' && w.activeEntity" :key="`${w.selected.id}:${w.activeEntity.id}:chat`" :entity="w.activeEntity" :workspace="w.selected" v-bind="{ ...(w.conversationId ? { initialConversationId: w.conversationId } : {}), ...(w.initialMode ? { initialMode: w.initialMode } : {}) }" @conversation-selected="id => { w.conversationId = id; w.updateRoute(true); }" @open-tasks="id => w.navigate('tasks', w.activeEntity!, id)" @edit-settings="w.navigate('settings', w.activeEntity!)" @entity-updated="w.entityUpdated" @close="w.navigate('conversations')" @session-expired="w.clearSession" />
          <WorkbenchPage v-else-if="w.view==='tasks'&&!w.canManage" :workspace="w.selected" :entities="w.entities" :section="w.taskSection" :disabled="w.navigationLocked" :entity-id="w.taskEntityId" @section-changed="value=>{if(value==='monitor'){w.navigate('connections');}else{w.taskSection=value;w.updateRoute();}}" @filters-changed="(id,conversation)=>{w.taskEntityId=id;w.conversationId=conversation;w.updateRoute(true)}" @open-employee="(id,section)=>id?w.openEmployee(id,section):w.navigate('employees')" @open-conversation="(entity,id)=>w.navigate('chat',entity,id)" @open-work-item="openWorkItem" @session-expired="w.clearSession"/><section v-else-if="w.view === 'tasks' && w.canManage" class="tasks-page"><PageHeader title="任务" description="查看工作区任务。任务、执行和投递分开显示。仅管理员可见。" /><NTabs :value="w.taskSection" type="line" @update:value="value=>{w.taskSection=value;w.updateRoute();}"><NTabPane name="tasks" tab="任务"><PlatformTasks :key="w.selected.id" :workspace="w.selected" :entities="w.entities" :entity-id="w.taskEntityId || undefined" :conversation-id="w.conversationId" @filters-changed="(entityId, conversationId) => { w.taskEntityId = entityId; w.conversationId = conversationId; w.updateRoute(true); }" @session-expired="w.clearSession" /></NTabPane><NTabPane name="human" tab="待你处理"><HumanRequestsPage :workspace="w.selected" :entities="w.entities" @session-expired="w.clearSession" @open-conversation="(entity,id)=>w.navigate('chat',entity,id)" @open-work-item="openWorkItem"/></NTabPane></NTabs></section>
        </template>
        <NCard v-else class="empty-card"><NEmpty description="选择一个工作区"><template #extra><p>当前没有可访问的空间。创建自己的空间，或使用团队邀请加入。</p><NSpace justify="center"><NButton type="primary" @click="w.openWorkspaceDialog('create')">创建工作区</NButton><NButton @click="w.openWorkspaceDialog('join')">加入工作区</NButton></NSpace></template></NEmpty></NCard>
        <p v-if="!w.user && !w.invitationToken" class="auth-join"><NButton text :disabled="w.busy" @click="w.openWorkspaceDialog('join')">已有邀请？加入工作区</NButton></p>
      </template>
    </main>
  </div>
  <WorkspaceDialog :w="w" />
  <SourceAttribution />
</div>
</NConfigProvider>
</template>
