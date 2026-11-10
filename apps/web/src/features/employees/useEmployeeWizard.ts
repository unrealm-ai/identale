import {PORTRAIT_EMPLOYEE_AVATAR_PRESETS} from '@dentity/contracts';
import type { ExecutionThinkingLevel } from './thinking-options';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api, ApiError, errorMessage } from '../../shared/api';
import type { Entity, Workspace } from '../../shared/api';
import type { ChatMode, CapabilityPackage } from '../../phase2';
import type { EmployeeModelDraft } from './useModelSettings';
import type { DirectoryAccessRule, DirectoryConnection } from '../directory/types';
export type EntityWizardProps = { workspace: Workspace };
export type EntityWizardEmits = { (event: 'created', entity: Entity): void; (event: 'done', entity: Entity, mode: ChatMode): void; (event: 'close' | 'closeCancelled' | 'sessionExpired'): void; (event: 'busyChanged', value: boolean): void };
type DirectoryRules = { allow: DirectoryAccessRule[]; deny: DirectoryAccessRule[] };
export type EmployeeAccessDraft = { packages: (Pick<CapabilityPackage, 'userPolicyMode' | 'name' | 'enabled' | 'mode' | 'allowMemberIds' | 'denyMemberIds' | 'resourceIds'|'conversationKinds'|'triggerUsageScope'|'handoffUsageScope'|'handoffUsageMode'> & { directoryAccess?: DirectoryRules })[]; webAccess?: { allowMemberIds: string[]; denyMemberIds: string[]; allowWorkspaceMembers?:boolean }; directoryAccess?: DirectoryRules & {allowGroupMembers?:boolean} };
export type EmployeeChannelDraft = { draftId: string; expiresAt: number; source: DirectoryConnection };
export function useEmployeeWizard(props: EntityWizardProps, emit: EntityWizardEmits) {
  const avatarPreset=ref<string|null>(PORTRAIT_EMPLOYEE_AVATAR_PRESETS[Math.floor(Math.random()*PORTRAIT_EMPLOYEE_AVATAR_PRESETS.length)]!);
  const initialAvatar=avatarPreset.value;
  const executionThinkingLevel = ref<ExecutionThinkingLevel>('medium');
  const name = ref(''), description = ref(''), ownWebUse = ref(true), mode = ref<ChatMode>('real');
  const modelBusy = ref(false), modelEditorDirty=ref(false), creating = ref(false);
  const busy = computed(() => creating.value || modelBusy.value);
  const modelDraft = ref<EmployeeModelDraft>(null), accessDraft = ref<EmployeeAccessDraft>({ packages: [], webAccess:{allowMemberIds:[props.workspace.memberId],denyMemberIds:[]},directoryAccess:{allow:[],deny:[],allowGroupMembers:true} });
  const scopeDirty=computed(()=>accessDraft.value.webAccess?.allowWorkspaceMembers===true||avatarPreset.value!==initialAvatar||executionThinkingLevel.value!=='medium');
  const created = ref<Entity | null>(null), error = ref(''), uncertain = ref(false), confirmClose = ref(false);
  const controller = new AbortController(), operationId = crypto.randomUUID();
  let finished = false, submitted: Record<string, unknown> | undefined;
  const base = computed(() => `/workspaces/${encodeURIComponent(props.workspace.id)}`);
  const valid = computed(() => !!name.value.trim());
  const modelDirty = computed(() => modelEditorDirty.value || modelDraft.value?.kind === 'existing');
  async function persist() {
    if (busy.value || created.value || !valid.value) return;
    if (!submitted && modelEditorDirty.value) { error.value = '请先保存新模型，或取消添加后再创建员工。'; return; }
    uncertain.value = false; creating.value = true; error.value = '';
    try {
      submitted ??= JSON.parse(JSON.stringify({ operationId,triggers:[],triggerHistoryPolicy:'isolated',avatarPreset:avatarPreset.value, name: name.value.trim(), description: description.value, ownWebUse: ownWebUse.value, interactionRuntime: 'builtin-interaction', executionThinkingLevel: executionThinkingLevel.value, model: modelDraft.value, ...accessDraft.value }));
      const result = await api<{ entity: Entity }>(`${base.value}/employee-creations`, controller.signal, submitted);
      if (controller.signal.aborted) return;
      created.value = result.entity; submitted = undefined; modelDraft.value = null; emit('created', result.entity);
    } catch (cause) {
      if (controller.signal.aborted) return;
      error.value = errorMessage(cause);
      // Freeze the full memory-only request until an uncertain operation is reconciled by replay.
      if (!(cause instanceof ApiError) || cause.status >= 500) uncertain.value = true;
      else submitted = undefined;
      if (cause instanceof ApiError && cause.status === 401) emit('sessionExpired');
    } finally { creating.value = false; }
  }
  async function finish() { if (busy.value || finished) return; await persist(); if (created.value && !finished) { finished = true; emit('done', created.value, mode.value); } }
  function requestClose() { if (busy.value) return; if (!scopeDirty.value && !name.value.trim() && !description.value.trim() && !modelDirty.value) emit('close'); else confirmClose.value = true; }
  function beforeUnload(event: BeforeUnloadEvent) {
    if (!created.value && (scopeDirty.value || name.value.trim() || description.value.trim() || modelDirty.value || busy.value)) { event.preventDefault(); event.returnValue = ''; }
  }
  onMounted(() => window.addEventListener('beforeunload', beforeUnload));
  onUnmounted(() => { controller.abort(); submitted = undefined; modelDraft.value = null; emit('busyChanged', false); window.removeEventListener('beforeunload', beforeUnload); });
  return { avatarPreset, name, description, executionThinkingLevel, ownWebUse, mode, modelBusy, modelEditorDirty, creating, busy, created, error, uncertain, confirmClose, base, valid, modelDraft, accessDraft, persist, finish, requestClose };
}
