import {useWorkItemBeta} from '../work-items/useWorkItemBeta';
import {computed, onUnmounted, ref, watch } from 'vue';
import { api, ApiError, errorMessage } from '../../shared/api';
import type { ApprovedResource, CapabilityPackage, ConfigMember } from '../../phase2';
import type { DirectoryAccess, DirectoryAccessRule, DirectorySubjects, ConversationKind } from '../directory/types';
type DirectoryPackage = CapabilityPackage & { directoryAccess?: { allow: DirectoryAccessRule[]; deny: DirectoryAccessRule[] } };
export type AccessSettingsProps = { base: string;section?:string|undefined };
export type AccessSettingsEmits = { (event: 'changed' | 'sessionExpired'): void; (event:'dirtyChanged',value:boolean):void;(event: 'busyChanged', value: boolean): void };
interface Access { allowMemberIds: string[]; denyMemberIds: string[]; allowWorkspaceMembers?:boolean; revision: number }
const copyRules = (rules: DirectoryAccessRule[]) => rules.map(rule => ({ ...rule, conversationKinds: [...rule.conversationKinds] }));
export function useAccessSettings(props: AccessSettingsProps, emit: AccessSettingsEmits) {
  const beta=useWorkItemBeta(()=>props.base,()=>emit('sessionExpired')),handoffOptions=ref<{id:string;name:string;enabled:boolean}[]>([]),packageHandoffMode=ref<import('@dentity/contracts').HandoffUsageMode|undefined>(),packageHandoffScope=ref<import('@dentity/contracts').HandoffUsageScope|undefined>();
  watch(beta.enabled,async enabled=>{if(!enabled)return;const base=props.base;try{const value=await api<{id:string;name:string;enabled:boolean}[]>(base+'/handoff-options',controller.signal);if(props.base===base)handoffOptions.value=value;}catch{/* Existing policy remains; unavailable candidates do not widen it. */}});
  const triggerOptions=ref<import('./trigger-types').TriggerOption[]>([]),packageTriggerScope=ref<import('./trigger-types').TriggerScope|undefined>();
  const members = ref<ConfigMember[]>([]), resources = ref<ApprovedResource[]>([]), packages = ref<DirectoryPackage[]>([]);
  const access = ref<Access>({ allowMemberIds: [], denyMemberIds: [], revision: 0 });
  const directoryAccess = ref<DirectoryAccess>({ allow: [], deny: [], revision: 0 });
  const subjects = ref<DirectorySubjects>({ sources: [], users: [], departments: [] });
  const packageDirectoryAllow = ref<DirectoryAccessRule[]>([]), packageDirectoryDeny = ref<DirectoryAccessRule[]>([]);
  const packageUserPolicyMode=ref<CapabilityPackage['userPolicyMode']>();
  const packageVersion=ref<number|undefined>();
  const packageConversationKinds=ref<ConversationKind[]|undefined>();
  const packageId = ref(''), name = ref(''), packageDescription = ref(''), enabled = ref(true), mode = ref<'inherit' | 'restrict'>('inherit');
  const allowMemberIds = ref<string[]>([]), denyMemberIds = ref<string[]>([]), resourceIds = ref<string[]>([]);
  const initialWeb=ref(''),initialDirectory=ref(''),reading=ref(false);
  const legacyWeb=computed(()=>access.value.denyMemberIds.length),legacyDirectory=computed(()=>directoryAccess.value.deny.length+directoryAccess.value.allow.filter(r=>r.conversationKinds.length!==2||!r.conversationKinds.includes('private')||!r.conversationKinds.includes('group')).length);
  const busy = ref(false), loaded = ref(false), error = ref(''), notice = ref('');
  let controller = new AbortController(), generation = 0;
  watch(()=>busy.value&&!reading.value, value => emit('busyChanged', value), { flush: 'sync' });
  async function run(action: (signal: AbortSignal, current: () => boolean) => Promise<void>) {
    if (busy.value) return;
    const version = generation, signal = controller.signal, current = () => version === generation && !signal.aborted;
    busy.value = true; error.value = '';
    try { await action(signal, current); }
    catch (cause) { if (current()) { error.value = errorMessage(cause); if (cause instanceof ApiError && cause.status === 401) emit('sessionExpired'); } }
    finally { if (current()) busy.value = false; }
  }
  const webDirty=computed(()=>loaded.value&&JSON.stringify(access.value)!==initialWeb.value),directoryDirty=computed(()=>loaded.value&&JSON.stringify(directoryAccess.value)!==initialDirectory.value);
  function resetWeb(){if(initialWeb.value)access.value=JSON.parse(initialWeb.value);}
  function resetDirectory(){if(initialDirectory.value)directoryAccess.value=JSON.parse(initialDirectory.value);}
  const dirty=computed(()=>loaded.value&&props.section!=='capabilities'&&(JSON.stringify(access.value)!==initialWeb.value||JSON.stringify(directoryAccess.value)!==initialDirectory.value));watch(dirty,v=>emit('dirtyChanged',v),{flush:'sync'});
  async function load() { reading.value=true;await run(async (signal, current) => {
    const [a, m, p, r, tr, d, s] = await Promise.all([
      props.section==='capabilities'?Promise.resolve<Access>({allowMemberIds:[],denyMemberIds:[],revision:0}):api<Access>(`${props.base}/web-access`, signal), api<ConfigMember[]>(`${props.base}/configuration-members`, signal),
      api<DirectoryPackage[]>(`${props.base}/capability-packages`, signal), api<ApprovedResource[]>(`${props.base}/resource-catalog`, signal),
      api<import('./trigger-types').TriggerOption[]>(`${props.base}/trigger-options`, signal),
      props.section==='capabilities'?Promise.resolve<DirectoryAccess>({allow:[],deny:[],revision:0}):api<DirectoryAccess>(`${props.base}/directory-access`, signal), api<DirectorySubjects>(`${props.base}/channels/subjects`, signal),
    ]);
    if (!current()) return;
    triggerOptions.value=tr; access.value = a; directoryAccess.value = {allowGroupMembers:false,...d}; subjects.value = s; members.value = m; packages.value = p; resources.value = r;initialWeb.value=JSON.stringify(a);initialDirectory.value=JSON.stringify(directoryAccess.value);loaded.value = true;
    if (packageId.value) edit(p.find(item => item.id === packageId.value));
  });reading.value=false; }
  function edit(p?: DirectoryPackage) {
    packageUserPolicyMode.value=p?.userPolicyMode;
    packageHandoffMode.value=p?.handoffUsageMode??(p?.handoffUsageScope?'custom':undefined);packageHandoffScope.value=p?.handoffUsageScope?JSON.parse(JSON.stringify(p.handoffUsageScope)):undefined;packageTriggerScope.value=p?.triggerUsageScope?JSON.parse(JSON.stringify(p.triggerUsageScope)):undefined;packageConversationKinds.value=p?.conversationKinds===undefined?undefined:[...p.conversationKinds];packageVersion.value=p?.version;packageId.value = p?.id ?? ''; name.value = p?.name ?? ''; packageDescription.value=p?.description??''; enabled.value = p?.enabled ?? true; mode.value = p?.mode ?? 'inherit';
    allowMemberIds.value = [...(p?.allowMemberIds ?? [])]; denyMemberIds.value = [...(p?.denyMemberIds ?? [])]; resourceIds.value = [...(p?.resourceIds ?? [])];
    packageDirectoryAllow.value = copyRules(p?.directoryAccess?.allow ?? []); packageDirectoryDeny.value = copyRules(p?.directoryAccess?.deny ?? []);
    notice.value = ''; error.value = '';
  }
  function validRules(rules: DirectoryAccessRule[]) {
    if (rules.some(rule => !rule.conversationKinds.length)) { error.value = '请为每条渠道规则至少选择一种适用会话。'; return false; }
    return true;
  }
  const skillOperations=new WeakMap<File,string>();
  async function uploadSkill(file:File|null){
    if(!file||busy.value||!loaded.value)return;
    if(!file.name.toLowerCase().endsWith('.md')||file.size>65536){error.value='请选择不超过64KiB的单个Markdown Skill文档。';return;}
    await run(async(signal,current)=>{
      const operationId=skillOperations.get(file)??crypto.randomUUID();skillOperations.set(file,operationId);
      const result=await api<{resource:ApprovedResource;name:string;version:number}>(`${props.base}/skill-resources`,signal,{operationId,filename:file.name,content:await file.text()});
      if(!current())return;
      resources.value=await api<ApprovedResource[]>(`${props.base}/resource-catalog`,signal);if(!current())return;
      resourceIds.value=[...new Set([...resourceIds.value,result.resource.id])];
      notice.value=`Skill ${result.name} v${result.version} 已上传并加入当前表单，尚未授权。请核对包的使用范围并保存能力包。`;emit('changed');
    });
  }
  async function saveDirectoryAccess() {
    if (!loaded.value || busy.value || !validRules([...directoryAccess.value.allow, ...directoryAccess.value.deny])) return;
    notice.value = '';
    await run(async (signal, current) => {
      const result = await api<DirectoryAccess>(`${props.base}/directory-access`, signal, { allow: directoryAccess.value.allow, deny: directoryAccess.value.deny, allowGroupMembers:directoryAccess.value.allowGroupMembers===true,expectedRevision:directoryAccess.value.revision }, 'PUT');
      if (!current()) return;
      directoryAccess.value = result;initialDirectory.value=JSON.stringify(result); notice.value = '已保存。'; emit('changed');
    });
  }
  async function saveAccess() {
    if (!loaded.value || busy.value) return; notice.value = '';
    await run(async (signal, current) => {
      const result = await api<Access>(`${props.base}/web-access`, signal, { allowMemberIds: access.value.allowMemberIds, denyMemberIds: access.value.denyMemberIds, ...(access.value.allowWorkspaceMembers===undefined?{}:{allowWorkspaceMembers:access.value.allowWorkspaceMembers}) }, 'PUT');
      if (!current()) return;
      access.value = result;initialWeb.value=JSON.stringify(result); notice.value = '已保存。'; emit('changed');
    });
  }
  async function savePackage() {
    if (!loaded.value || busy.value || !validRules([...packageDirectoryAllow.value, ...packageDirectoryDeny.value])) return;
    notice.value = ''; const submittedGeneration = generation;
    await run(async (signal, current) => {
      const body = { ...(packageUserPolicyMode.value?{userPolicyMode:packageUserPolicyMode.value}:{}),...(beta.enabled.value&&packageHandoffMode.value?{handoffUsageMode:packageHandoffMode.value}:{}),...(beta.enabled.value&&packageHandoffScope.value?{handoffUsageScope:packageHandoffScope.value}:{}),...(packageTriggerScope.value?{triggerUsageScope:packageTriggerScope.value}:{}),...(packageConversationKinds.value===undefined?{}:{conversationKinds:[...packageConversationKinds.value]}),...(packageId.value?{expectedVersion:packageVersion.value}:{}),name: name.value, description:packageDescription.value, enabled: enabled.value, mode: mode.value, allowMemberIds: allowMemberIds.value, denyMemberIds: denyMemberIds.value, resourceIds: resourceIds.value, directoryAccess: { allow: packageDirectoryAllow.value, deny: packageDirectoryDeny.value } };
      const result = await api<DirectoryPackage>(`${props.base}/capability-packages${packageId.value ? `/${encodeURIComponent(packageId.value)}` : ''}`, signal, body, packageId.value ? 'PUT' : 'POST');
      if (!current()) return;
      packages.value = [...packages.value.filter(p => p.id !== result.id), result]; edit(result);
      notice.value = '已保存。'; emit('changed');
    });
    if (submittedGeneration === generation && error.value) notice.value = '保存未确认时，请先重新读取配置核对，不要重复新建同名能力包。';
  }
  async function togglePackage(p:DirectoryPackage){if(!loaded.value||busy.value)return;await run(async(signal,current)=>{const result=await api<DirectoryPackage>(`${props.base}/capability-packages/${encodeURIComponent(p.id)}/status`,signal,{enabled:!p.enabled,expectedVersion:p.version},'PUT');if(!current())return;packages.value=packages.value.map(value=>value.id===p.id?result:value);notice.value=result.enabled?'已启用。':'已停用；正在执行的任务不受影响。';emit('changed');});}
  watch(() => props.base, () => {
    generation++; controller.abort(); controller = new AbortController(); busy.value = false; loaded.value = false; members.value = []; resources.value = []; packages.value = [];
    access.value = { allowMemberIds: [], denyMemberIds: [], revision: 0 }; directoryAccess.value = { allow: [], deny: [], revision: 0 }; subjects.value = { sources: [], users: [], departments: [] }; edit(); void load();
  }, { immediate: true });
  onUnmounted(() => { generation++; controller.abort(); emit('busyChanged', false);emit('dirtyChanged',false); });
  return {packageUserPolicyMode,beta,handoffOptions,packageHandoffMode,packageHandoffScope,legacyWeb,legacyDirectory,webDirty,directoryDirty,resetWeb,resetDirectory, triggerOptions,packageTriggerScope,packageConversationKinds,uploadSkill,directoryAccess, subjects, packageDirectoryAllow, packageDirectoryDeny, saveDirectoryAccess, members, resources, packages, access, packageId, name, packageDescription, enabled, mode, allowMemberIds, denyMemberIds, resourceIds, busy, loaded, error, notice, load, edit, saveAccess, savePackage, togglePackage };
}
