
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { api, ApiError, errorMessage } from '../shared/api';
import type { ChatMode } from '../phase2';
import type { Entity, Invitation, Role, User, Workspace } from '../shared/api';

export function useWorkbench() {
const user = ref<User | null>(null);
const workspaces = ref<Workspace[]>([]);
const selected = ref<Workspace | null>(null);
const entities = ref<Entity[]>([]);
const activeEntity = ref<Entity | null>(null);
const entitiesLoaded = ref(false),entityLoading=ref(false);let employeeReadController=new AbortController(),employeeReadVersion=0,searchTimer:ReturnType<typeof setTimeout>|undefined;
const booting = ref(true);
const busy = ref(false);
const error = ref('');
const notice = ref('');
const mode = ref<'login' | 'register'>('login');
const username = ref('');
const password = ref('');
const displayName = ref('');
const newWorkspaceName = ref('');
const inviteInput = ref('');
const invitationToken = ref('');
const invitation = ref<Invitation | null>(null);
const inviteRole = ref<'member' | 'admin'>('member');
const inviteHours = ref(48);
const generatedInvite = ref<{ link: string; expiresAt: number } | null>(null);
const canManage = computed(() => selected.value?.role === 'owner' || selected.value?.role === 'admin');
const roleLabel = (role: Role) => ({ owner: '所有者', admin: '管理员', member: '成员' })[role];
const formatTime = (value: number) => new Date(value).toLocaleString('zh-CN');

type View = 'home' | 'work-items' | 'workbench' | 'employees' | 'conversations' | 'tasks' | 'chat' | 'settings' | 'workspace-models' | 'management' | 'resources' | 'connections' | 'workspace-settings' | 'components';
const view = ref<View>('home');
const workItemId=ref<string|undefined>();
const workbenchSection=ref<'tasks'|'monitor'|'human'>('tasks');
const taskSection=ref<'tasks'|'human'>('tasks');
const employeeSection=ref('overview'),employeeQuery=ref(''),employeeCursor=ref<string|null>(null);
const managementSection = ref<'workspace'|'directory'|'models'|'skills'|'mcp'|'members'|'monitor'>('directory');
const isManagementRoute=(params:URLSearchParams)=>['management','workspace-models'].includes(params.get('view')??'');
const conversationId = ref<string | undefined>();
const initialMode = ref<ChatMode | undefined>();
const preferredModes = new Map<string, ChatMode>();
const wizardOpen = ref(false), wizardBusy = ref(false), settingsBusy = ref(false);
const navigationLocked = computed(() => busy.value || wizardOpen.value || settingsBusy.value);
const taskEntityId = ref('');
const taskEntity = computed(() => entities.value.find(entity => entity.id === taskEntityId.value));
const firstRoute = new URLSearchParams(location.search);
function preferredWorkspace(list: Workspace[]) {
  let saved: string | null = null;
  try { saved = localStorage.getItem(`identity:workspace:${user.value?.id}`); } catch { /* Storage can be unavailable. */ }
  return list.find(workspace => workspace.id === firstRoute.get('ws')) ?? list.find(workspace => workspace.id === saved) ?? list[0];
}
function updateRoute(replace = false) {
  const url = new URL(location.href);
  for (const key of ['ws', 'view', 'entity', 'conversation', 'section','q','item']) url.searchParams.delete(key);
  if (selected.value) url.searchParams.set('ws', selected.value.id);
  url.searchParams.set('view', view.value);
  if(!['workbench','tasks'].includes(view.value))url.searchParams.delete('task');
  if(view.value==='settings')url.searchParams.set('section',employeeSection.value);
  if(view.value==='workbench')url.searchParams.set('section',workbenchSection.value);
  if(view.value==='tasks')url.searchParams.set('section',taskSection.value);
  if(view.value==='work-items'&&workItemId.value)url.searchParams.set('item',workItemId.value);
  if(view.value==='employees'&&employeeQuery.value)url.searchParams.set('q',employeeQuery.value);
  if(['management','resources','connections','workspace-settings'].includes(view.value))url.searchParams.set('section',managementSection.value);
  const entityId = view.value === 'tasks'||view.value==='workbench' ? taskEntityId.value : activeEntity.value?.id;
  if (entityId) url.searchParams.set('entity', entityId);
  if ((['chat','tasks','workbench'].includes(view.value)||view.value==='settings'&&['chat','tasks'].includes(employeeSection.value)) && conversationId.value) url.searchParams.set('conversation', conversationId.value);
  history[replace ? 'replaceState' : 'pushState'](null, '', url.pathname + url.search);
}
function navigate(next: View, entity?: Entity, id?: string) {
  if (navigationLocked.value) return;
  if(next==='workspace-models'){next='management';managementSection.value='models';}
  if (next === 'tasks') {
    if (!entity && view.value === 'chat' && activeEntity.value) entity = activeEntity.value;
    if (entity) taskEntityId.value = entity.id;
  }
  if(next==='settings')employeeSection.value='overview';
  if(next==='chat'){next='settings';employeeSection.value='chat';}
  if(next==='tasks')taskSection.value='tasks';
  if(next==='connections'){next='workspace-settings';managementSection.value='monitor';} else if(next==='workspace-settings')managementSection.value='workspace';
  if(next==='resources')managementSection.value='models';
  view.value = next; activeEntity.value = entity ?? null; conversationId.value = id; initialMode.value = entity ? preferredModes.get(entity.id) : undefined;

  updateRoute();if(next==='employees')void run(loadEntities);
}
function selectManagementSection(section:'workspace'|'directory'|'models'|'skills'|'mcp'|'members'|'monitor'){
  if(navigationLocked.value||!['management','resources','workspace-settings'].includes(view.value)||section==='members'&&!canManage.value)return;
  managementSection.value=section;updateRoute();
}
function restoreView(params: URLSearchParams) {
  const target = params.get('view') as View;
  const entity = entities.value.find(item => item.id === params.get('entity'));
  const knownViews=['home','work-items','workbench','employees', 'conversations', 'tasks', 'chat', 'settings', 'workspace-models','management','resources','connections','workspace-settings','components'];
  view.value = knownViews.includes(target) ? target : target ? 'employees' : 'home';
  employeeSection.value=({chat:'chat',tasks:'tasks',model:'model',channels:'channels',access:'overview',identity:'identity',automation:'automation',capabilities:'capabilities',overview:'overview'} as Record<string,string>)[params.get('section')??'']??'overview';
  if(['resources','workspace-settings'].includes(target)){const part=params.get('section');managementSection.value=['workspace','directory','models','skills','mcp','members','monitor'].includes(part??'')?part as typeof managementSection.value:target==='resources'?'models':'workspace';}
  if(isManagementRoute(params)){view.value='management';const part=params.get('section');managementSection.value=target==='workspace-models'?'models':['workspace','directory','models','skills','mcp','members'].includes(part??'')?part as typeof managementSection.value:'directory';if(managementSection.value==='members'&&!canManage.value)managementSection.value='models';}
  if ((view.value === 'chat' || view.value === 'settings') && !entity) view.value = 'employees';
  activeEntity.value = view.value==='management'?null:entity ?? null;
  conversationId.value = (view.value === 'chat' || view.value === 'tasks'||view.value==='workbench'||view.value==='settings'&&['chat','tasks'].includes(employeeSection.value)) && entity ? params.get('conversation') ?? undefined : undefined;
  taskEntityId.value = entity?.id ?? '';
  if(view.value==='chat'){view.value='settings';employeeSection.value='chat';}
  if(view.value==='tasks')taskSection.value=params.get('section')==='human'?'human':'tasks';
  if(view.value==='connections'){view.value='workspace-settings';managementSection.value='monitor';}
  if(target==='workbench')workbenchSection.value=params.get('section')==='human'?'human':params.get('section')==='monitor'?'monitor':'tasks';
  workItemId.value=target==='work-items'?params.get('item')??undefined:undefined;
  updateRoute(true);
}
async function onPopState() {
  if (!user.value || navigationLocked.value || workspaceAction.value) { updateRoute(true); return; }
  const params = new URLSearchParams(location.search);
  const workspace = workspaces.value.find(item => item.id === params.get('ws'));
  if (workspace && workspace.id !== selected.value?.id) await run(() => activate(workspace, false));
  restoreView(params);
}
function canEdit(_entity: Entity) { return !!selected.value; }
function entityUpdated(updated: Entity) {
  if (updated.workspaceId !== selected.value?.id) return;
  entities.value = entities.value.some(item => item.id === updated.id) ? entities.value.map(item => item.id === updated.id ? {...item,...updated} : item) : [...entities.value, updated];
  if (activeEntity.value?.id === updated.id) activeEntity.value = updated;
}
function finishWizard(entity: Entity, chosen: ChatMode) {
  entityUpdated(entity); wizardOpen.value = false; view.value = 'settings';activeEntity.value=entity;employeeSection.value='chat';conversationId.value=undefined;updateRoute(true);
  preferredModes.set(entity.id, chosen);
  notice.value = `「${entity.name}」已创建。配置好模型后即可开始对话，能力与渠道可稍后添加。`;
}
async function closeWizard(next?: View) {
  wizardOpen.value = false;
  if (next) navigate(next);
  if (next !== 'employees') await run(loadEntities);
}

watch([wizardOpen, wizardBusy, settingsBusy], () => { if (!wizardOpen.value && !wizardBusy.value && !settingsBusy.value && pendingInvitation && !busy.value) queueMicrotask(applyPendingInvitation); });
const workspaceMenuOpen = ref(false);
const workspaceAction = ref<'create' | 'join' | 'invite' | null>(null);
const dialogTitle = computed(() => ({ create: '创建工作区', join: '加入工作区', invite: '邀请成员' })[workspaceAction.value ?? 'join']);
function closeWorkspaceMenu(_restoreFocus = false) { workspaceMenuOpen.value = false; }
function onBeforeUnload(event: BeforeUnloadEvent) {
  if (busy.value || wizardBusy.value || settingsBusy.value) { event.preventDefault(); event.returnValue = ''; }
}
function openWorkspaceDialog(action: 'create' | 'join' | 'invite') {
  if (busy.value || (action === 'invite' && !canManage.value)) return;
  closeWorkspaceMenu();
  error.value = '';
  workspaceAction.value = action;
}
function closeWorkspaceDialog(force = false) {
  // Do not dismiss an in-flight mutation: aborting transport does not undo a server commit.
  if (busy.value && !force) return;
  if (workspaceAction.value === 'join') {
    invitationToken.value = '';
    invitation.value = null;
    inviteInput.value = '';
  }
  generatedInvite.value = null;
  newWorkspaceName.value = '';
  error.value = '';
  workspaceAction.value = null;
}
// Fragment invitations keep their login/register context; authenticated users review them in the dialog.
watch([user, invitationToken, booting], () => {
  if (user.value && invitationToken.value && !booting.value) {
    closeWorkspaceMenu();
    generatedInvite.value = null;
    workspaceAction.value = 'join';
  }
});
let controller = new AbortController();
let generation = 0;
let pendingInvitation = '';
function handleFragment() {
  const token = consumeFragment();
  if (!token) return;
  pendingInvitation = token;
  if (!busy.value && !wizardOpen.value && !wizardBusy.value && !settingsBusy.value) applyPendingInvitation();
  else if (wizardOpen.value) notice.value = '收到一个工作区邀请。完成或退出员工创建后可查看。';
}
function applyPendingInvitation() {
  if (!pendingInvitation) return;
  invitationToken.value = pendingInvitation;
  pendingInvitation = '';
  void run(inspectInvitation);
}

// Invitation secrets stay only in memory, never in query strings or browser storage.
function consumeFragment(): string {
  const hash = location.hash;
  if (!hash) return '';
  history.replaceState(null, '', location.pathname + location.search);
  return new URLSearchParams(hash.slice(1)).get('invite') ?? '';
}
invitationToken.value = consumeFragment();

function resetScope() {employeeReadController.abort();employeeReadVersion++;entityLoading.value=false;clearTimeout(searchTimer);employeeCursor.value=null;
  generation++;
  controller.abort();
  controller = new AbortController();
  activeEntity.value = null;
  entities.value = [];
  entitiesLoaded.value = false;
  generatedInvite.value = null;
  wizardOpen.value = false; wizardBusy.value = false; settingsBusy.value = false; preferredModes.clear();
  workItemId.value=undefined;view.value = 'home'; managementSection.value='directory'; conversationId.value = undefined; initialMode.value = undefined; taskEntityId.value = '';
  inviteRole.value = 'member';
}
function clearSession() {
  // Preserve the invitation when authentication expires; it must not silently become ordinary registration.
  const token = invitationToken.value, context = invitation.value;
  resetScope();
  user.value = null;
  selected.value = null;
  workspaces.value = [];
  password.value = '';
  newWorkspaceName.value = '';
  closeWorkspaceMenu();
  closeWorkspaceDialog(true);
  invitationToken.value = token; invitation.value = context;
  updateRoute(true);
}
async function run(work: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try { await work(); }
  catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') return;
    if (cause instanceof ApiError && cause.status === 401 && user.value) clearSession();
    error.value = errorMessage(cause);
  } finally {
    busy.value = false;
    if (pendingInvitation && !wizardOpen.value && !wizardBusy.value && !settingsBusy.value) queueMicrotask(applyPendingInvitation);
  }
}
async function loadEntities(more=false) {
  const scope=selected.value;if(!scope||more&&(entityLoading.value||!employeeCursor.value))return;
  employeeReadController.abort();employeeReadController=new AbortController();const signal=employeeReadController.signal,readVersion=++employeeReadVersion,version=generation;entityLoading.value=true;
  const query=new URLSearchParams({limit:'25',...(employeeQuery.value?{q:employeeQuery.value}:{}),...(more&&employeeCursor.value?{cursor:employeeCursor.value}:{})});
  try{const result=await api<{records:Entity[];nextCursor:string|null}>(`/workspaces/${encodeURIComponent(scope.id)}/employee-summaries?${query}`,signal);
    if(!signal.aborted&&readVersion===employeeReadVersion&&version===generation&&scope.id===selected.value?.id){entities.value=more?[...entities.value,...result.records]:result.records;employeeCursor.value=result.nextCursor;entitiesLoaded.value=true;}
  }catch(cause){if(!signal.aborted&&readVersion===employeeReadVersion){error.value=errorMessage(cause);if(cause instanceof ApiError&&cause.status===401)clearSession();}}
  finally{if(readVersion===employeeReadVersion)entityLoading.value=false;}
}
function searchEmployees(value:string){employeeQuery.value=value;clearTimeout(searchTimer);employeeReadController.abort();searchTimer=setTimeout(()=>void loadEntities(),150);updateRoute(true);}
async function openEmployee(id:string,section='overview'){if(!selected.value||navigationLocked.value)return;try{let entity=entities.value.find(e=>e.id===id);if(!entity){const r=await api<{employee:Entity}>(`/workspaces/${encodeURIComponent(selected.value.id)}/entities/${encodeURIComponent(id)}/overview`,controller.signal);entity=r.employee;}navigate('settings',entity);selectEmployeeSection(section);}catch(cause){error.value=errorMessage(cause);}}
function selectWorkbenchSection(value:'tasks'|'monitor'|'human'){if(navigationLocked.value||value===workbenchSection.value)return;workbenchSection.value=value;updateRoute();}
function workspaceRenamed(value:Workspace){workspaces.value=workspaces.value.map(w=>w.id===value.id?{...w,...value}:w);if(selected.value?.id===value.id)selected.value={...selected.value,...value};}
function selectEmployeeSection(value:string){if(value===employeeSection.value)return;employeeSection.value=value;updateRoute();}
async function activate(workspace: Workspace, firstRun = true) {
  resetScope();
  selected.value = workspace;
  try { localStorage.setItem(`identity:workspace:${user.value?.id}`, workspace.id); } catch { /* Nonessential preference. */ }
  employeeQuery.value=firstRoute.get('q')??'';await loadEntities();
  const routeId=new URLSearchParams(location.search).get('entity');if(routeId&&!entities.value.some(e=>e.id===routeId)){try{const r=await api<{employee:Entity}>(`/workspaces/${encodeURIComponent(workspace.id)}/entities/${encodeURIComponent(routeId)}/overview`,controller.signal);entities.value.push(r.employee);}catch{/* Inaccessible or deleted routes resolve to the directory. */}}
  taskEntityId.value = '';
  if(firstRun&&entitiesLoaded.value&&!entities.value.length&&[null,'employees','home'].includes(new URLSearchParams(location.search).get('view')))wizardOpen.value=true;
}
async function inspectInvitation() {
  invitation.value = null;
  if (!invitationToken.value) return;
  invitation.value = await api<Invitation>('/invitations/inspect', controller.signal, { token: invitationToken.value });
}
function cancelInvitation() {
  if (busy.value) return;
  invitationToken.value = '';
  inviteInput.value = '';
  invitation.value = null;
  error.value = '';
}
async function inspectInput() {
  await run(async () => {
    let token = inviteInput.value.trim();
    if (token.includes('://')) {
      try { token = new URLSearchParams(new URL(token).hash.slice(1)).get('invite') ?? ''; }
      catch { token = ''; }
    }
    invitationToken.value = token;
    inviteInput.value = '';
    if (!token) throw new ApiError('invalid_invitation', 400);
    await inspectInvitation();
  });
}
async function authenticate() {
  await run(async () => {
    try {
      if (mode.value === 'register') {
        if (invitationToken.value && !invitation.value) throw new ApiError('invalid_invitation', 400);
        const result = await api<{ user: User; workspace: Workspace }>('/auth/register', controller.signal, {
          username: username.value, password: password.value,
          ...(displayName.value ? { displayName: displayName.value } : {}),
          ...(invitationToken.value ? { invitationToken: invitationToken.value } : {}),
        });
        user.value = result.user;
        workspaces.value = [result.workspace];
        invitationToken.value = '';
        invitation.value = null;
        await activate(result.workspace);
        updateRoute(true);
      } else {
        const result = await api<{ user: User; workspaces: Workspace[] }>('/auth/login', controller.signal, { username: username.value, password: password.value });
        user.value = result.user;
        workspaces.value = result.workspaces;
        const workspace = preferredWorkspace(result.workspaces);
        if (workspace) { await activate(workspace,!isManagementRoute(firstRoute)); restoreView(firstRoute); }
      }
    } finally { password.value = ''; }
  });
}
async function logout() {
  activeEntity.value = null;
  await run(async () => {
    await api('/auth/logout', controller.signal, {});
    clearSession();
    notice.value = '已退出登录。';
  });
}
async function switchWorkspace(id: string) {
  if (busy.value) return;
  closeWorkspaceMenu(true);
  if (id === selected.value?.id) return;
  const management=view.value==='management',section=managementSection.value;
  // Unmount the old entity view before the selection request, including on failure.
  resetScope();
  await run(async () => {
    const result = await api<{ workspace: Workspace }>(`/workspaces/${encodeURIComponent(id)}/select`, controller.signal, {});
    await activate(result.workspace,!management);
    if(management){view.value='management';managementSection.value=section;}
    updateRoute();
  });
}
async function createWorkspace() {
  await run(async () => {
    const result = await api<{ workspace: Workspace }>('/workspaces', controller.signal, { name: newWorkspaceName.value });
    workspaces.value.push(result.workspace);
    newWorkspaceName.value = '';
    await activate(result.workspace);
    closeWorkspaceDialog(true);
    updateRoute();
    notice.value = '工作区已创建。';
  });
}
async function createInvitation() {
  await run(async () => {
    if (!selected.value || !canManage.value) return;
    const version = generation;
    generatedInvite.value = null;
    const result = await api<{ token: string; expiresAt: number }>(`/workspaces/${encodeURIComponent(selected.value.id)}/invitations`, controller.signal, { role: inviteRole.value, expiresInHours: inviteHours.value });
    if (version !== generation) return;
    generatedInvite.value = { link: `${location.origin}${location.pathname}#invite=${encodeURIComponent(result.token)}`, expiresAt: result.expiresAt };
  });
}
async function acceptInvitation() {
  await run(async () => {
    if (!invitation.value || !user.value) return;
    const result = await api<{ workspace: Workspace }>('/invitations/accept', controller.signal, { token: invitationToken.value });
    workspaces.value = [...workspaces.value.filter(w => w.id !== result.workspace.id), result.workspace];
    invitationToken.value = '';
    invitation.value = null;
    await activate(result.workspace);
    closeWorkspaceDialog(true);
    updateRoute();
    notice.value = '已加入工作区；现有成员角色不会因邀请自动提升。';
  });
}
async function initialize() {
  await run(async () => {
    try {
      const result = await api<{ user: User; workspaces: Workspace[] }>('/auth/me', controller.signal);
      user.value = result.user;
      workspaces.value = result.workspaces;
      const workspace = preferredWorkspace(result.workspaces);
        if (workspace) { await activate(workspace,!isManagementRoute(firstRoute)); restoreView(firstRoute); }
    } catch (cause) {
      if (!(cause instanceof ApiError && cause.status === 401)) throw cause;
    }
    await inspectInvitation();
  });
  booting.value = false;
}
let refreshingAccess=false;
async function refreshAccess(){if(!user.value||refreshingAccess)return;refreshingAccess=true;try{const result=await api<{user:User;workspaces:Workspace[]}>('/auth/me',controller.signal);workspaces.value=result.workspaces;if(selected.value){const current=result.workspaces.find(w=>w.id===selected.value!.id);if(!current){resetScope();selected.value=null;error.value='当前工作区成员资格已停用，其他工作区仍可使用。';updateRoute(true);}else selected.value=current;}}catch{/* Existing endpoint checks remain authoritative. */}finally{refreshingAccess=false;}}
onMounted(() => {
  window.addEventListener('identity:workspace-access-changed',refreshAccess);
  window.addEventListener('focus',refreshAccess);
  window.addEventListener('hashchange', handleFragment);
  window.addEventListener('popstate', onPopState);
  window.addEventListener('beforeunload', onBeforeUnload);
  void initialize();
});
onUnmounted(() => {employeeReadController.abort();clearTimeout(searchTimer);
  window.removeEventListener('identity:workspace-access-changed',refreshAccess);
  window.removeEventListener('focus',refreshAccess);
  window.removeEventListener('hashchange', handleFragment);
  window.removeEventListener('popstate', onPopState);
  window.removeEventListener('beforeunload', onBeforeUnload);
  controller.abort(); password.value = '';
});
watch(canManage,allowed=>{if(!allowed&&view.value==='management'&&managementSection.value==='members'){managementSection.value='models';updateRoute(true);}});
return { workItemId,workbenchSection,taskSection,selectWorkbenchSection,workspaceRenamed,entityLoading,openEmployee,employeeSection,selectEmployeeSection,employeeQuery,employeeCursor,searchEmployees,managementSection,selectManagementSection,user, workspaces, selected, entities, activeEntity, entitiesLoaded, booting, busy, error, notice, mode, username, password, displayName, newWorkspaceName, inviteInput, invitationToken, invitation, inviteRole, inviteHours, generatedInvite, canManage, roleLabel, formatTime, view, conversationId, initialMode, wizardOpen, wizardBusy, settingsBusy, navigationLocked, taskEntityId, taskEntity, workspaceMenuOpen, workspaceAction, dialogTitle, navigate, updateRoute, canEdit, entityUpdated, finishWizard, closeWizard, closeWorkspaceMenu, openWorkspaceDialog, closeWorkspaceDialog, clearSession, run, loadEntities, inspectInvitation, cancelInvitation, inspectInput, authenticate, logout, switchWorkspace, createWorkspace, createInvitation, acceptInvitation };
}
