<!-- Modified for Identale; see the root NOTICE. -->
<script setup lang="ts">
import {computed,onUnmounted,ref,watch} from 'vue';
import InfoHint from '../../shared/ui/InfoHint.vue';
import {NButton,NCard} from 'naive-ui';
import {api,errorMessage} from '../../shared/api';
import AsyncState from '../../shared/ui/AsyncState.vue';
import HumanConfirmationSettings from './HumanConfirmationSettings.vue';
import EmployeeRuntimeStatus from './EmployeeRuntimeStatus.vue';
import {employeeRecommendation,type EmployeeUseFacts} from './employee-recommendation';
const props=withDefaults(defineProps<{base:string;canManage?:boolean;refreshKey?:number|string}>(),{canManage:false});
const emit=defineEmits<{dirtyChanged:[boolean];busyChanged:[boolean];section:[string];chat:[];status:[];statusRead:[{enabled:boolean;lifecycleRevision:number}]}>();
type OverviewEmployee=EmployeeUseFacts&{description:string;lifecycleRevision?:number;channels:number;packages:number;checkedAt:number};
// Collapse must preserve unsaved rules and in-flight saves without eager loading.
const showHuman=ref(false),humanMounted=ref(false);
function toggleHuman(){showHuman.value=!showHuman.value;if(showHuman.value)humanMounted.value=true;}
const employee=ref<OverviewEmployee|null>(null),loading=ref(false),error=ref(''),partial=ref(false);
const recommendation=computed(()=>employee.value?employeeRecommendation(employee.value,props.canManage):null);
let controller:AbortController|undefined;let request=0;
async function load(){controller?.abort();const c=new AbortController();controller=c;const current=++request;employee.value=null;partial.value=false;loading.value=true;error.value='';try{const r=await api<{employee:OverviewEmployee;partialFailures:string[]}>(props.base+'/overview',c.signal);if(!c.signal.aborted&&current===request){employee.value=r.employee;partial.value=r.partialFailures.length>0;if(typeof r.employee.enabled==='boolean'&&typeof r.employee.lifecycleRevision==='number')emit('statusRead',{enabled:r.employee.enabled,lifecycleRevision:r.employee.lifecycleRevision});}}catch(e){if(!c.signal.aborted&&current===request)error.value=errorMessage(e);}finally{if(current===request)loading.value=false;}}
function act(){const action=recommendation.value?.action;if(action==='chat')emit('chat');else if(action==='status')emit('status');else if(action==='access'||action==='identity')emit('section',action);else if(action==='refresh')void load();}
watch(()=>props.base,()=>{showHuman.value=false;humanMounted.value=false;});
watch(()=>[props.base,props.refreshKey],()=>void load(),{immediate:true});onUnmounted(()=>controller?.abort());
</script>
<template><div class="overview-layout"><AsyncState class="overview-summary" :loading="loading" :error="error" @retry="load"><p v-if="partial" class="overview-partial" role="status">渠道信息暂时读取失败，不影响查看员工资料。<NButton size="small" @click="load">重试渠道摘要</NButton></p><div v-if="employee&&recommendation" class="overview-grid"><NCard class="employee-purpose"><h2>可以交给它什么</h2><p class="prewrap employee-purpose-desc">{{employee.description||'尚未填写职责，先说明这位员工负责的工作。'}}</p><div class="overview-card-footer"><span class="overview-stat-meta">{{employee.packages}} 个能力包 · {{employee.channels}} 个渠道连接</span><NButton size="small" secondary @click="emit('section','capabilities')">{{employee.packages?'查看能力包':'配置能力包'}}</NButton></div></NCard><NCard class="employee-next-step"><h2>下一步</h2><p v-if="employee.modelName" class="overview-model-meta">所选模型：<strong>{{employee.modelName}}</strong></p><ul v-if="recommendation.blockers.length" class="employee-blockers"><li v-for="reason in recommendation.blockers" :key="reason">{{reason}}</li></ul><p v-else class="overview-ready-note">你已获得对话使用权，可以从一条消息开始。</p><div v-if="recommendation.action!=='none'" class="overview-card-footer"><NButton type="primary" size="small" @click="act">{{recommendation.label}}</NButton></div></NCard><NCard class="employee-extensions"><h2>扩展使用方式（可选）</h2><p>需要在其他应用中使用，或让员工按时执行工作时，再添加相应设置。</p><div v-if="canManage" class="overview-extensions"><NButton size="small" secondary @click="emit('section','channels')">{{employee.channels?'查看渠道':'接入渠道'}}</NButton><NButton size="small" secondary @click="emit('section','automation')">触发器</NButton><NButton size="small" secondary :aria-expanded="showHuman" @click="toggleHuman">人工确认</NButton></div><div class="overview-checked"><span class="field-note">更新于 {{new Date(employee.checkedAt).toLocaleString('zh-CN')}}</span><InfoHint label="配置检查说明">以上为平台配置检查结果，运行情况见下方运行状态。</InfoHint></div></NCard></div></AsyncState><div class="overview-panels" :class="{'overview-panels--split':$slots['web-access']||(canManage&&showHuman)}"><div v-if="$slots['web-access']||(canManage&&humanMounted)" v-show="$slots['web-access']||(canManage&&showHuman)" class="overview-access-stack"><slot name="web-access"/><HumanConfirmationSettings v-if="canManage&&humanMounted" v-show="showHuman" :base="base" @dirty-changed="v=>emit('dirtyChanged',v)" @busy-changed="v=>emit('busyChanged',v)"/></div><EmployeeRuntimeStatus :base="base" :refresh-key="refreshKey" :model-ready="employee?.modelReady" :channel-count="partial?undefined:employee?.channels"/></div></div></template>
<style scoped>
.overview-layout{display:grid;gap:16px;min-width:0}
.overview-partial{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;margin:0 0 16px;border:1px solid var(--id-status-warning-border,var(--subtle));border-radius:10px;background:var(--id-status-warning-bg,var(--surface));color:var(--id-status-warning-fg,var(--text))}
.overview-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;align-items:stretch}
.overview-grid :deep(.n-card__content){display:flex;flex-direction:column;height:100%;padding:20px}
.overview-grid h2{font-size:15px;font-weight:600;line-height:22px;margin:0 0 10px}
.overview-grid p{margin:0 0 12px;color:var(--muted);font-size:13px;line-height:22px}
.employee-purpose-desc{color:var(--text)!important}
.overview-model-meta strong{color:var(--text);font-weight:500}
.overview-card-footer{margin-top:auto;padding-top:12px;border-top:1px solid var(--subtle);display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.overview-stat-meta{font-size:12px;color:var(--muted)}
.employee-blockers{margin:0 0 12px;padding-left:18px;font-size:13px;line-height:20px;color:var(--id-status-warning-fg,var(--text))}
.employee-blockers li+li{margin-top:6px}
.overview-extensions{display:flex;flex-wrap:wrap;gap:8px;margin-top:auto;padding-top:4px}
.overview-checked{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-top:12px;padding-top:12px;border-top:1px solid var(--subtle)}
.overview-checked .field-note{font-size:12px}
.overview-panels{display:grid;grid-template-columns:minmax(0,1fr);gap:16px;align-items:start}
.overview-panels--split{grid-template-columns:minmax(0,1.15fr) minmax(0,1fr)}
.overview-access-stack,.overview-access-stack :deep(.overview-web-access){display:grid;gap:16px;min-width:0}
@media(max-width:1180px){.overview-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.employee-extensions{grid-column:1/-1}.overview-panels--split{grid-template-columns:1fr}}
@media(max-width:760px){.overview-grid{grid-template-columns:1fr}.employee-next-step{order:-1}}
</style>
