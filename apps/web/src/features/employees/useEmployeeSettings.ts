import type { ExecutionThinkingLevel } from './thinking-options';
import { computed, onUnmounted, ref, watch } from 'vue';
import { api, ApiError, errorMessage } from '../../shared/api';
import type { Entity, Workspace } from '../../shared/api';
export type EmployeeSettingsProps = { entity: Entity; workspace: Workspace; section?:string|undefined; conversationId?:string|undefined; embedded?: boolean };
export type EmployeeSettingsEmits = { (event: 'close' | 'sessionExpired' | 'configurationChanged' | 'chat' | 'recentConversations'): void; (event: 'entityUpdated', entity: Entity): void; (event:'sectionChanged', value:string):void; (event:'conversationSelected', value:string):void; (event: 'busyChanged', value: boolean): void };
export function useEmployeeSettings(props: EmployeeSettingsProps, emit: EmployeeSettingsEmits) {
  const canManage = computed(() => ['owner', 'admin','member'].includes(props.workspace.role));
  const base = computed(() => `/workspaces/${encodeURIComponent(props.workspace.id)}/entities/${encodeURIComponent(props.entity.id)}`);
  const name = ref(props.entity.name), description = ref(props.entity.description ?? ''), executionThinkingLevel = ref<ExecutionThinkingLevel>(props.entity.executionThinkingLevel ?? 'medium');
  const avatarPreset=ref<string|null>(props.entity.avatarPreset??null);
  const unknownBasic=ref(false);let pendingBasics:{name:string;description:string;avatarPreset?:string|null}|undefined;
  const saving = ref(false), error = ref(''), notice = ref('');
  const modelBusy = ref(false), accessBusy = ref(false), channelBusy = ref(false);
  const busy = computed(() => saving.value || modelBusy.value || accessBusy.value || channelBusy.value);
  let controller = new AbortController();
  watch([() => props.workspace.id, () => props.entity.id], () => {
    controller.abort(); controller = new AbortController(); unknownBasic.value=false; pendingBasics=undefined;
    avatarPreset.value=props.entity.avatarPreset??null;name.value = props.entity.name; description.value = props.entity.description ?? ''; executionThinkingLevel.value = props.entity.executionThinkingLevel ?? 'medium'; saving.value = false; error.value = ''; notice.value = '';
  });
  async function saveBasics() {
    if (!canManage.value || busy.value || unknownBasic.value || !name.value.trim()) return;
    const signal = controller.signal; saving.value = true; error.value = ''; notice.value = '';
    try {
      pendingBasics={name:name.value.trim(),description:description.value,...(avatarPreset.value!==(props.entity.avatarPreset??null)?{avatarPreset:avatarPreset.value}:{})};
      const result = await api<{ entity: Entity }>(base.value, signal, pendingBasics, 'PATCH');
      if (signal.aborted) return;
      name.value=result.entity.name;description.value=result.entity.description;pendingBasics=undefined;unknownBasic.value=false;emit('entityUpdated', result.entity); emit('configurationChanged');
      notice.value = '已保存。';
    } catch (cause) {
      if (signal.aborted) return;
      unknownBasic.value=!(cause instanceof ApiError)||cause.status>=500;error.value = errorMessage(cause);
      if (cause instanceof ApiError && cause.status === 401) emit('sessionExpired');
    } finally { if (!signal.aborted) saving.value = false; }
  }
  async function verifyBasics(){if(busy.value)return;const signal=controller.signal;saving.value=true;error.value='';try{const result=await api<{employee:Entity}>(base.value+'/overview',signal);if(signal.aborted)return;const matches=pendingBasics&&result.employee.name===pendingBasics.name&&result.employee.description===pendingBasics.description&&(pendingBasics.avatarPreset===undefined||result.employee.avatarPreset===pendingBasics.avatarPreset);emit('entityUpdated',{...props.entity,...result.employee});notice.value=matches?'已核对：基本信息已经保存。':'已读取当前基本信息，你的修改已保留，请核对后保存。';unknownBasic.value=false;pendingBasics=undefined;}catch(cause){if(!signal.aborted){error.value=errorMessage(cause);if(cause instanceof ApiError&&cause.status===401)emit('sessionExpired');}}finally{if(!signal.aborted)saving.value=false;}}
  async function saveThinking(){if(!canManage.value||busy.value)return;const signal=controller.signal;saving.value=true;error.value='';notice.value='';try{const result=await api<{entity:Entity}>(base.value,signal,{executionThinkingLevel:executionThinkingLevel.value},'PATCH');if(!signal.aborted){emit('entityUpdated',result.entity);emit('configurationChanged');notice.value='思考强度已保存。';}}catch(cause){if(!signal.aborted){error.value=errorMessage(cause);if(cause instanceof ApiError&&cause.status===401)emit('sessionExpired');}}finally{if(!signal.aborted)saving.value=false;}}
  async function setEnabled(){if(!canManage.value||busy.value)return;const signal=controller.signal;saving.value=true;error.value='';notice.value='';try{const result=await api<{entity:Entity}>(`${base.value}/status`,signal,{enabled:props.entity.enabled===false,expectedRevision:props.entity.lifecycleRevision??1},'PUT');if(!signal.aborted){emit('entityUpdated',result.entity);emit('configurationChanged');notice.value=result.entity.enabled?'员工已恢复；渠道需逐项启用并重新验证。':'员工已停用；历史和机器人绑定保留。';}}catch(cause){if(!signal.aborted){error.value=errorMessage(cause);if(cause instanceof ApiError&&cause.status===401)emit('sessionExpired');}}finally{if(!signal.aborted)saving.value=false;}}
  onUnmounted(() => { controller.abort(); emit('busyChanged', false); });
  return { avatarPreset,canManage, base, name, description, executionThinkingLevel, saving, error, notice, modelBusy, accessBusy, channelBusy, busy, saveBasics,verifyBasics,unknownBasic,saveThinking, setEnabled };
}
