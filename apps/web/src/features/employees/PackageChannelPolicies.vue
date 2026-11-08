<script setup lang="ts">
import {computed,onUnmounted,ref,watch} from 'vue';
import {NAlert,NButton,NRadio,NRadioGroup,NSpace} from 'naive-ui';
import DirectoryRulePicker from '../directory/DirectoryRulePicker.vue';
import {providerLabel,type DirectorySubjects,type PackageChannelPolicy} from '../directory/types';
const props=defineProps<{policies:PackageChannelPolicy[];subjects:DirectorySubjects;base:string;directoryBase?:string;draft?:boolean;disabled?:boolean}>();
const emit=defineEmits<{'update:policies':[PackageChannelPolicy[]];busyChanged:[boolean];pendingChanged:[boolean]}>();
const queries=ref<Record<string,boolean>>({});
const pending=ref<{sourceId:string;mode:PackageChannelPolicy['mode']}|null>(null);
watch(pending,value=>emit('pendingChanged',!!value),{flush:'sync'});
watch(()=>Object.values(queries.value).some(Boolean),value=>emit('busyChanged',value),{flush:'sync'});
onUnmounted(()=>{emit('busyChanged',false);emit('pendingChanged',false);});
const subjectSets=computed(()=>Object.fromEntries(props.subjects.sources.map(source=>[source.sourceId,{sources:[source],users:[] as never[],departments:[] as never[]}])));
const rows=computed(()=>props.subjects.sources.map(source=>({source,policy:props.policies.find(policy=>policy.sourceId===source.sourceId)??{sourceId:source.sourceId,mode:'inherit' as const,allow:[],deny:[]}})));
function update(policy:PackageChannelPolicy,patch:Partial<PackageChannelPolicy>){emit('update:policies',[...props.policies.filter(item=>item.sourceId!==policy.sourceId),{...policy,...patch}]);}
function changeMode(policy:PackageChannelPolicy,mode:PackageChannelPolicy['mode']){
  if(props.disabled)return;if(mode===policy.mode){pending.value=null;return;}
  if(policy.legacyAllowCheck){pending.value={sourceId:policy.sourceId,mode};return;}
  update(policy,{mode});
}
function confirmMode(policy:PackageChannelPolicy){
  if(props.disabled||pending.value?.sourceId!==policy.sourceId)return;
  const next={...policy,mode:pending.value.mode};delete next.legacyAllowCheck;
  emit('update:policies',[...props.policies.filter(item=>item.sourceId!==policy.sourceId),next]);pending.value=null;
}
</script>
<template>
<div class="package-channel-policies">
  <h4>渠道使用范围</h4><p class="field-note">每个渠道新建默认继承员工使用范围，包括已获准在群内使用的群成员。渠道身份分别授权；本包只能收窄，不能超出员工范围。黑名单始终优先，继承模式也不绕过已有黑名单。</p>
  <section v-for="{source,policy} in rows" :key="source.sourceId" :aria-label="providerLabel(source.provider)+'能力包使用范围'">
    <h4>{{providerLabel(source.provider)}}</h4>
    <NRadioGroup :value="policy.mode" :disabled="disabled" :aria-label="providerLabel(source.provider)+'能力包策略'" @update:value="mode=>changeMode(policy,mode as PackageChannelPolicy['mode'])"><NSpace vertical><NRadio value="inherit">继承员工使用范围</NRadio><NRadio value="allowlist">仅白名单</NRadio><NRadio value="denylist">员工范围内全员 + 黑名单</NRadio></NSpace></NRadioGroup>
    <NAlert v-if="policy.legacyAllowCheck" type="info">沿用旧名单校验：名单中的身份暂无法核实时，会暂停本渠道使用；确认不匹配时仍继承员工范围。仅修改名称、资源或网页策略不会改变这项保护。</NAlert>
    <NAlert v-if="pending?.sourceId===policy.sourceId" type="warning">切换本渠道策略后，不再沿用旧名单的身份待核验保护，将按新策略和黑名单判断，可能扩大授权。原名单保留，请核对后确认。<NSpace><NButton :disabled="disabled" @click="pending=null">保留渠道原策略</NButton><NButton :disabled="disabled" @click="confirmMode(policy)">确认切换渠道策略</NButton></NSpace></NAlert>
    <p v-if="policy.mode==='allowlist'" class="field-note">空白名单无人可用。员工的群内开放不会绕过本包白名单。</p>
    <DirectoryRulePicker v-if="policy.mode==='allowlist'" :rules="policy.allow" @update:rules="allow=>update(policy,{allow})" fixed-source :subjects="subjectSets[source.sourceId]!" :base="base" v-bind="directoryBase?{directoryBase}:{}" :draft="draft" :default-conversation-kinds="['private','group']" hide-unavailable-notice :label="providerLabel(source.provider)+'包内允许成员'" :disabled="disabled" @busy-changed="v=>queries[source.sourceId+':allow']=v"/>
    <DirectoryRulePicker v-if="policy.mode!=='inherit'||policy.deny.length" :rules="policy.deny" @update:rules="deny=>update(policy,{deny})" fixed-source :subjects="subjectSets[source.sourceId]!" :base="base" v-bind="directoryBase?{directoryBase}:{}" :draft="draft" :default-conversation-kinds="['private','group']" hide-unavailable-notice :label="providerLabel(source.provider)+'包内拒绝成员'" :disabled="disabled" @busy-changed="v=>queries[source.sourceId+':deny']=v"/>
  </section>
  <p v-if="!rows.length" class="field-note">尚未绑定渠道。新渠道绑定后，本包默认继承该渠道员工使用范围。</p>
</div>
</template>
<style scoped>.package-channel-policies{display:grid;gap:12px}.package-channel-policies section{display:grid;gap:12px;padding:16px;border:1px solid var(--subtle);border-radius:8px}.package-channel-policies h4,.package-channel-policies p{margin:0}</style>
