import { computed, onUnmounted, ref, watch } from 'vue';
import { api, ApiError, errorMessage } from '../../shared/api';
export type EmployeeModelDraft = null | { kind: 'existing'; profileId: string } | { kind: 'new'; configuration: Record<string, unknown> };
export type ModelSettingsProps = { base: string; canManage: boolean; scope?: 'workspace' | 'employee' | undefined; canManageWorkspace?: boolean | undefined; draft?: boolean;initialProfileId?:string|null|undefined; createOnly?:boolean; creation?:boolean; disabled?:boolean };
export type ModelSettingsEmits = { (event: 'sessionExpired'): void; (event: 'busyChanged', value: boolean): void; (event: 'draftChanged', value: EmployeeModelDraft): void; (event: 'dirtyChanged', value: boolean): void; (event:'profileCreated', value:string):void };
type Protocol='chat_completions'|'openai_responses'|'anthropic_messages';
interface Profile { protocol?:Protocol;id: string; name: string; provider: 'openai-compatible'; endpoint: string; modelId: string; secretRef: string | null; configRevision: number; referenceCount: number; enabled: boolean }
interface Effective { selectedProfileId: string | null; effectiveProfile: Profile | null; source: 'selection' | 'workspace_default' | 'none' }
export function useModelSettings(props: ModelSettingsProps, emit: ModelSettingsEmits) {
  const isWorkspace = computed(() => props.scope === 'workspace');
  const canEditCatalog = computed(() => isWorkspace.value && props.canManage);
  const workspaceBase = computed(() => props.base.split('/entities/')[0]!);
  const profiles = ref<Profile[]>([]), defaultProfileId = ref<string | null>(null), selectedProfileId = ref<string | null>(null), effective = ref<Effective | null>(null);
  const profile = ref<Profile | null>(null), editing = ref(false);
  const loaded = ref(false), busy = ref(false), error = ref(''), notice = ref('');
  const selectionDirty = computed(() => !isWorkspace.value && !props.draft && loaded.value && selectedProfileId.value !== effective.value?.selectedProfileId);
  watch(selectionDirty, value => emit('dirtyChanged', value), { flush: 'sync' });
  const protocol=ref<Protocol>('chat_completions');
  const name = ref(''), endpoint = ref(''), modelId = ref(''), apiKey = ref(''), enabled = ref(true), setAsDefault = ref(false);
  const receipt = ref(''), receiptExpiresAt = ref(0), tested = computed(() => !!receipt.value);
  let controller = new AbortController(), generation = 0, expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const catalogDirty=computed(()=>isWorkspace.value&&editing.value&&(protocol.value!==(profile.value?.protocol??'chat_completions')||name.value!==(profile.value?.name??'')||endpoint.value!==(profile.value?.endpoint??'')||modelId.value!==(profile.value?.modelId??'')||!!apiKey.value||enabled.value!==(profile.value?.enabled??true)||setAsDefault.value));
  watch([busy,catalogDirty],()=>emit('busyChanged',busy.value||(!props.creation&&catalogDirty.value)),{flush:'sync'});
  watch(catalogDirty,value=>{if(props.creation)emit('dirtyChanged',value);},{flush:'sync'});
  watch(selectedProfileId,value=>{if(props.creation)emit('draftChanged',value?{kind:'existing',profileId:value}:null);},{flush:'sync'});
  function invalidate() { receipt.value = ''; receiptExpiresAt.value = 0; clearTimeout(expiryTimer); }
  watch([protocol,name, endpoint, modelId, apiKey, enabled, setAsDefault], invalidate, { flush: 'sync' });
  const endpointChanged = computed(() => !!profile.value?.secretRef && endpoint.value.trim() !== profile.value.endpoint);
  const sourceLabel = computed(() => effective.value?.source === 'selection' ? '员工选择的共享模型' : effective.value?.source === 'workspace_default' ? '继承工作区默认模型' : profiles.value.length ? '模型库已有配置：请为员工选择模型或设置工作区默认模型' : '未配置模型：不能开始对话、执行任务或生成摘要');
  function fill(value: Profile | null) {
    invalidate(); profile.value = value;protocol.value=value?.protocol??'chat_completions'; name.value = value?.name ?? ''; endpoint.value = value?.endpoint ?? ''; modelId.value = value?.modelId ?? '';
    enabled.value = value?.enabled ?? true; apiKey.value = ''; setAsDefault.value = false;
  }
  function edit(value: Profile | null) { if (busy.value || props.disabled || !canEditCatalog.value) return; fill(value); editing.value = true; notice.value = ''; error.value = ''; }
  function cancelEdit() { if (busy.value) return; fill(null); editing.value = false; }
  function payload() { return { ...(!props.draft && !profile.value && !isWorkspace.value ? { bindEntityId: props.base.split('/entities/')[1] } : {}), ...(!profile.value && isWorkspace.value ? { setAsDefault: setAsDefault.value } : {}), name: name.value.trim(), provider: 'openai-compatible',protocol:protocol.value, endpoint: endpoint.value.trim(), modelId: modelId.value.trim(), enabled: enabled.value, ...(apiKey.value ? { apiKey: apiKey.value } : {}) }; }
  watch([editing, selectedProfileId, protocol,name, endpoint, modelId, apiKey, enabled, receipt], () => {
    if (props.draft) emit('draftChanged', editing.value ? { kind: 'new', configuration: { ...payload(), connectionTestReceipt: receipt.value } } : selectedProfileId.value ? { kind: 'existing', profileId: selectedProfileId.value } : null);
  }, { flush: 'sync' });
  async function run(action: (signal: AbortSignal, current: () => boolean) => Promise<void>) {
    if (busy.value || props.disabled || !props.canManage) return;
    const version = generation, signal = controller.signal; const current = () => version === generation && !signal.aborted;
    busy.value = true; error.value = '';
    try { await action(signal, current); } catch (cause) { if (current()) { error.value = errorMessage(cause); if (cause instanceof ApiError && cause.status === 401) emit('sessionExpired'); } }
    finally { if (current()) busy.value = false; }
  }
  async function read(signal: AbortSignal, current: () => boolean) {
    const catalog = await api<{ profiles: Profile[]; defaultProfileId: string | null }>(`${workspaceBase.value}/model-profiles`, signal);
    const selection = isWorkspace.value || props.draft ? null : await api<Effective>(`${props.base}/model-profile`, signal);
    if (!current()) return;
    profiles.value = catalog.profiles; defaultProfileId.value = catalog.defaultProfileId; effective.value = selection; selectedProfileId.value = props.creation ? selectedProfileId.value : selection?.selectedProfileId ?? (props.draft?props.initialProfileId??null:null); loaded.value = true;
  }
  async function load() { await run(async (signal, current) => { await read(signal, current); if (current()) { cancelEditor(); if (canEditCatalog.value && (props.creation ? !profiles.value.some(p=>p.enabled) : props.createOnly || !profiles.value.length)) editing.value = true; } }); }
  function cancelEditor() { fill(null); editing.value = false; }
  async function selectModel() { if (props.draft) return; await run(async (signal, current) => {
    await api(isWorkspace.value ? `${workspaceBase.value}/model-default` : `${props.base}/model-profile`, signal, { profileId: isWorkspace.value ? defaultProfileId.value : selectedProfileId.value }, 'PUT');
    if (!current()) return; await read(signal, current); if (current()) notice.value = isWorkspace.value ? '工作区默认模型已更新。' : '员工模型选择已更新。';
  }); }
  async function toggle(value:Profile){if(!isWorkspace.value)return;await run(async(signal,current)=>{await api(`${workspaceBase.value}/model-profiles/${encodeURIComponent(value.id)}/status`,signal,{enabled:!value.enabled,expectedVersion:value.configRevision},'PUT');if(current())await read(signal,current);});}
  async function revoke(value: Profile) { if (!canEditCatalog.value) return; await run(async (signal, current) => {
    await api(`${workspaceBase.value}/model-profiles/${encodeURIComponent(value.id)}/revoke`, signal, {});
    if (!current()) return; cancelEditor(); notice.value = '共享模型已停用，凭据已撤销。引用此模型的员工无法发起新模型调用。'; await read(signal, current);
  }); }
  function checkCredentials() { if (endpointChanged.value && !apiKey.value) { error.value = '模型地址已改变，请重新输入 API Key，旧密钥不会发送到新地址。'; return false; } return true; }
  async function testConnection() {
    if (busy.value || !canEditCatalog.value || !checkCredentials()) return;
    invalidate(); notice.value = '';
    await run(async (signal, current) => {
      const submitted = JSON.stringify(payload());
      const path = `${workspaceBase.value}/model-profiles${profile.value ? `/${encodeURIComponent(profile.value.id)}` : ''}/test-connection`;
      const result = await api<{ connectionTestReceipt: string; expiresAt: string;inputCapabilities?:{image:'passed'|'unsupported'|'unknown'} }>(path, signal, JSON.parse(submitted));
      if (!current() || submitted !== JSON.stringify(payload())) return;
      const expiry = Date.parse(result.expiresAt);
      if (!result.connectionTestReceipt || !Number.isFinite(expiry) || expiry <= Date.now()) { error.value = '联通测试凭证已失效，请重新测试。'; return; }
      receipt.value = result.connectionTestReceipt; receiptExpiresAt.value = expiry;
      expiryTimer = setTimeout(invalidate, Math.max(0, receiptExpiresAt.value - Date.now()));
      notice.value = `文字连接通过；图片输入${result.inputCapabilities?.image==='passed'?'通过':result.inputCapabilities?.image==='unsupported'?'明确不支持':'尚未确认'}。可保存当前配置；修改后需重新测试。`;
    });
  }
  async function save() {
    if (props.draft) return;
    if (!canEditCatalog.value || !checkCredentials() || busy.value) return;
    if (!receipt.value || receiptExpiresAt.value <= Date.now()) { invalidate(); error.value = '请先通过联通测试，再保存当前配置。'; return; }
    await run(async (signal, current) => {
      const wasNew=!profile.value; const saved=await api<Profile>(`${workspaceBase.value}/model-profiles${profile.value ? `/${encodeURIComponent(profile.value.id)}` : ''}`, signal, { ...payload(), connectionTestReceipt: receipt.value }, profile.value ? 'PUT' : 'POST');
      if (!current()) return;
      cancelEditor(); notice.value = isWorkspace.value ? '共享模型已保存。请核对工作区默认模型选择。' : '模型已加入工作区模型库，并已为此员工选中。';
      if(props.creation){profiles.value=[...profiles.value.filter(p=>p.id!==saved.id),saved];selectedProfileId.value=saved.id;notice.value='共享模型已保存，并已为新员工选中。';emit('profileCreated',saved.id);}
      else {await read(signal, current);if(current()&&wasNew)emit('profileCreated',saved.id);}
    });
  }
  watch(() => [props.base, props.canManage, props.canManageWorkspace, props.scope], () => {
    generation++; controller.abort(); controller = new AbortController(); busy.value = false; loaded.value = false; profiles.value = []; effective.value = null; notice.value = ''; error.value = ''; cancelEditor(); void load();
  }, { immediate: true });
  onUnmounted(() => { generation++; controller.abort(); invalidate(); apiKey.value = ''; emit('busyChanged', false); });
  return { isWorkspace, canEditCatalog, profiles, defaultProfileId, selectedProfileId, effective, sourceLabel, profile, editing, loaded, busy, catalogDirty, error, notice, protocol,name, endpoint, modelId, apiKey, enabled, setAsDefault, endpointChanged, tested, edit, cancelEdit, load, revoke,toggle, selectModel, testConnection, save };
}
