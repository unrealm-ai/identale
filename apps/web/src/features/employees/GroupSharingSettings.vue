<!-- Modified for Identale; see the root NOTICE. -->
<script setup lang="ts">
import{computed,onBeforeUnmount,ref,watch}from'vue';
import{NAlert,NButton,NCheckbox,NDrawer,NDrawerContent,NEmpty,NFormItem,NInput,NSelect,NSwitch,NTag}from'naive-ui';
import{api,ApiError,errorMessage}from'../../shared/api';
import InfoHint from'../../shared/ui/InfoHint.vue';
import ActionBar from'../../shared/ui/ActionBar.vue';
type Ref={kind:'group'|'person';provider:'feishu';connectionId:string;appId:string;tenantId:string;bindingVersion:string;id:string;label:string;namespace?:'open_id'};
type Selection={ref:Ref;proof:string};
type Rule={id?:string;revision?:number;name:string;enabled:boolean;type:'mutual'|'directed';sources:Selection[];targets:Selection[];available?:boolean;historyReady?:boolean;overlappingRules?:{id:string;name:string}[]};
type Config={revision:number;rules:Rule[]};
type Candidates={connections:{id:string;appId:string;label:string}[];groups:Selection[];people:Selection[];nextCursor:string|null;peopleTruncated?:boolean};
const props=defineProps<{base:string;disabled?:boolean}>();
const emit=defineEmits<{'busyChanged':[boolean];'dirtyChanged':[boolean];changed:[];sessionExpired:[]}>();
const config=ref<Config>({revision:0,rules:[]}),loading=ref(false),saving=ref(false),error=ref(''),notice=ref(''),applied=ref<number|null>(null),statusError=ref(false),unknown=ref(false),loaded=ref(false);
const edit=ref<Rule|null>(null),editingIndex=ref(-1),confirmDiscard=ref(false),connections=ref<Candidates['connections']>([]),connection=ref<string|null>(null),groups=ref<Selection[]>([]),people=ref<Selection[]>([]),next=ref<string|null>(null),search=ref(''),candidateLoading=ref(false),candidateError=ref(''),peopleTruncated=ref(false);
const abort=new AbortController();let generation=0,candidateGeneration=0;
const clone=<T,>(v:T):T=>JSON.parse(JSON.stringify(v));
const key=(s:Selection)=>JSON.stringify([s.ref.connectionId,s.ref.appId,s.ref.tenantId,s.ref.bindingVersion,s.ref.kind,s.ref.id,s.ref.namespace??'']);
const pending=computed(()=>loaded.value&&applied.value!==null&&config.value.revision!==applied.value);
const busy=computed(()=>loading.value||saving.value||candidateLoading.value);
watch(busy,v=>emit('busyChanged',v));watch(edit,v=>emit('dirtyChanged',!!v),{flush:'sync'});
const valid=computed(()=>!!edit.value?.name.trim()&&(edit.value.type==='mutual'?edit.value.sources.length>=2:edit.value.sources.length>=1&&edit.value.targets.length>=1));
const selectedSources=computed(()=>new Set(edit.value?.sources.map(key))),selectedTargets=computed(()=>new Set(edit.value?.targets.map(key)));
const visibleGroups=computed(()=>groups.value.filter(s=>s.ref.label.includes(search.value)||s.ref.id.includes(search.value)));
const visiblePeople=computed(()=>people.value.filter(s=>s.ref.label.includes(search.value)));
async function status(){try{const value=await api<{appliedRevision:number}>(props.base+'/group-sharing/status',abort.signal);applied.value=value.appliedRevision;statusError.value=false;}catch{statusError.value=true;applied.value=null;}}
async function load(){const g=++generation;loading.value=true;error.value='';try{const value=await api<Config>(props.base+'/group-sharing',abort.signal);if(g!==generation||abort.signal.aborted)return;config.value=value;loaded.value=true;if(unknown.value){edit.value=null;confirmDiscard.value=false;}unknown.value=false;await status();}catch(cause){if(g===generation&&!abort.signal.aborted){error.value=errorMessage(cause);if(cause instanceof ApiError&&cause.status===401)emit('sessionExpired');}}finally{if(g===generation)loading.value=false;}}
async function save(rules:Rule[]){saving.value=true;error.value='';notice.value='';try{const value=await api<Config>(props.base+'/group-sharing',abort.signal,{expectedRevision:config.value.revision,rules:rules.map(r=>({...r,id:r.id,name:r.name,enabled:r.enabled,type:r.type,sources:r.sources,targets:r.type==='mutual'?[]:r.targets,revision:undefined,available:undefined,historyReady:undefined,overlappingRules:undefined}))},'PUT');if(abort.signal.aborted)return;config.value=value;edit.value=null;unknown.value=false;notice.value='共享规则已保存。';emit('changed');await status();}catch(cause){if(!abort.signal.aborted){error.value=errorMessage(cause);unknown.value=!(cause instanceof ApiError)||cause.status>=500;if(cause instanceof ApiError&&cause.status===401)emit('sessionExpired');}}finally{saving.value=false;}}
async function candidates(more=false){const g=++candidateGeneration;candidateLoading.value=true;candidateError.value='';try{const q=new URLSearchParams();if(connection.value)q.set('connectionId',connection.value);if(more&&next.value)q.set('cursor',next.value);if(search.value)q.set('q',search.value);const value=await api<Candidates>(props.base+'/group-sharing/candidates'+(q.size?'?'+q:''),abort.signal);if(g!==candidateGeneration||abort.signal.aborted)return;connections.value=value.connections;groups.value=more?[...new Map([...groups.value,...value.groups].map(s=>[key(s),s])).values()]:value.groups;people.value=value.people;next.value=value.nextCursor;peopleTruncated.value=!!value.peopleTruncated;if(!connection.value&&value.connections[0]){connection.value=value.connections[0].id;await candidates();}}catch(cause){if(g===candidateGeneration&&!abort.signal.aborted)candidateError.value=errorMessage(cause);}finally{if(g===candidateGeneration)candidateLoading.value=false;}}
function open(index=-1){if(busy.value||props.disabled||unknown.value)return;editingIndex.value=index;edit.value=index<0?{name:'',enabled:true,type:'mutual',sources:[],targets:[]}:clone(config.value.rules[index]!);connection.value=edit.value.sources[0]?.ref.connectionId??null;search.value='';groups.value=[];people.value=[];next.value=null;void candidates();}
function choose(s:Selection,target:boolean,checked:boolean){if(!edit.value||busy.value||props.disabled)return;const refs=[...edit.value.sources,...edit.value.targets];if(checked&&refs.some(r=>r.ref.connectionId!==s.ref.connectionId))return;const field=target?'targets':'sources';edit.value[field]=checked?[...edit.value[field].filter(v=>key(v)!==key(s)),s]:edit.value[field].filter(v=>key(v)!==key(s));}
function otherApp(s:Selection){return[...(edit.value?.sources??[]),...(edit.value?.targets??[])].some(r=>r.ref.connectionId!==s.ref.connectionId);}
function close(){if(busy.value||unknown.value)return;confirmDiscard.value=true;}
function discard(){edit.value=null;confirmDiscard.value=false;candidateGeneration++;}
function commit(){if(!valid.value||!edit.value||busy.value||unknown.value)return;const rules=clone(config.value.rules);if(editingIndex.value<0)rules.push(edit.value);else rules[editingIndex.value]=edit.value;void save(rules);}
function toggle(index:number,enabled:boolean){if(busy.value||edit.value||unknown.value||props.disabled)return;const rules=clone(config.value.rules);rules[index]!.enabled=enabled;void save(rules);}
watch(()=>props.base,()=>{generation++;candidateGeneration++;edit.value=null;loaded.value=false;applied.value=null;void load();});
onBeforeUnmount(()=>{generation++;candidateGeneration++;abort.abort();emit('dirtyChanged',false);emit('busyChanged',false);});void load();
</script>
<template>
 <section class="group-sharing form-section" aria-label="群消息共享">
  <header class="sharing-heading"><div><h3>群消息共享<InfoHint label="群共享规则说明">默认不同群和私聊隔离。仅选定的群互通，或将选定源群提供给指定群或个人私聊。共享用于按需读取，不自动转发；不传递授权。仅支持同一飞书应用的文本历史。</InfoHint></h3><p class="field-note">按需配置同一飞书应用内的跨群或定向消息历史共享规则。</p></div><NButton :disabled="disabled||busy||!loaded||unknown" type="primary" @click="open()">新增共享规则</NButton></header>
  <NAlert v-if="error" type="error" role="alert">{{error}}<NButton :disabled="busy" @click="load">刷新并核对</NButton></NAlert>
  <NAlert v-if="unknown" type="warning" role="status">保存结果尚未确认，请先刷新核对，不要重复提交。</NAlert>
  <p v-if="notice" role="status">{{notice}}</p>
  <p v-if="loading" role="status">正在读取共享规则…</p>
  <template v-else-if="loaded">
   <div class="sharing-observation"><span v-if="statusError">运行侧应用状态暂不可用</span><span v-else-if="pending">已保存，等待运行侧应用</span><span v-else>运行侧已应用 · 配置版本 {{config.revision}}</span><NButton size="small" :disabled="busy" @click="status">核对应用状态</NButton></div>
   <NEmpty v-if="!config.rules.length" description="尚未配置跨群共享"><template #extra>同群按原授权读取，不同群和私聊保持隔离。</template></NEmpty>
   <div v-for="(rule,index) in config.rules" :key="rule.id" class="sharing-rule">
    <div class="sharing-rule-content"><h4>{{rule.name}} <NTag size="small" :bordered="false">{{rule.type==='mutual'?'选定群互通':'定向共享'}}</NTag></h4><p>{{rule.sources.map(s=>s.ref.label).join('、')}}{{rule.type==='mutual'?'之间互相共享':' → '+rule.targets.map(s=>s.ref.label+(s.ref.kind==='person'?'（私聊）':'')).join('、')}}</p><p v-if="rule.available===false" class="sharing-invalid">应用或对象身份已失效，请重新选择来源和目标。</p><p v-else-if="rule.historyReady===false" class="field-note">飞书历史读取权限尚未确认，请在连接诊断中核对。</p><p v-if="rule.overlappingRules?.length" class="field-note">部分共享方向仍由规则「{{rule.overlappingRules.map(r=>r.name).join('、')}}」允许。</p><span class="field-note">规则版本 {{rule.revision}}</span></div>
    <div class="sharing-rule-actions"><NSwitch :value="rule.enabled" :disabled="disabled||busy||!!edit||unknown||rule.available===false&&!rule.enabled" :aria-label="'启用共享规则 '+rule.name" @update:value="v=>toggle(index,v)"/><NButton size="small" :disabled="disabled||busy||unknown" @click="open(index)">编辑</NButton></div>
   </div>
   <p v-if="config.rules.length" class="field-note">多个启用规则合并生效。停用一条不影响其他规则；改动只影响新任务，已运行任务保留接纳时范围。</p>
  </template>
  <NDrawer :show="!!edit" :width="'min(48rem,100vw)'" :mask-closable="false" @update:show="v=>{if(!v)close()}"><NDrawerContent :title="editingIndex<0?'新增共享规则':'编辑共享规则'" closable>
   <template v-if="edit">
    <NAlert v-if="confirmDiscard" type="warning">放弃本次编辑？<NButton @click="confirmDiscard=false">继续编辑</NButton><NButton @click="discard">放弃编辑</NButton></NAlert>
    <NAlert v-if="error" type="error" role="alert">{{error}}</NAlert>
    <NAlert v-if="unknown" type="warning">保存结果待核对。<NButton :disabled="busy" @click="load">读取服务器配置</NButton></NAlert>
    <form class="settings-form" @submit.prevent="commit">
     <NFormItem label="规则名称"><NInput v-model:value="edit.name" :maxlength="100" :disabled="busy||unknown"  :input-props="{'aria-label':'共享规则名称'}"/></NFormItem>
     <NFormItem label="共享方式"><NSelect v-model:value="edit.type" :disabled="busy||unknown" :options="[{value:'mutual',label:'选定的群之间互通'},{value:'directed',label:'源群共享给指定群或个人'}]" aria-label="共享方式" @update:value="()=>{if(edit)edit.targets=[]}"/></NFormItem>
     <NFormItem label="飞书应用"><NSelect :value="connection" :disabled="busy||unknown" :options="connections.map(c=>({value:c.id,label:c.label}))" placeholder="选择已接入的飞书应用" aria-label="共享飞书应用" @update:value="v=>{connection=v;void candidates()}"/></NFormItem>
     <p v-if="!connections.length&&!candidateLoading&&!candidateError" class="field-note">请先接入并验证飞书应用。钉钉和企业微信暂不支持历史共享。</p>
     <div class="sharing-search"><NInput v-model:value="search" :disabled="busy||unknown" placeholder="搜索已加载群或目录人员" :input-props="{'aria-label':'搜索共享对象'}"/><NButton :disabled="busy||unknown" @click="candidates()">刷新</NButton></div>
     <NAlert v-if="candidateError" type="error" role="alert">{{candidateError}}<NButton :disabled="busy" @click="candidates()">重试</NButton></NAlert>
     <p v-if="candidateLoading" role="status">正在查询可选对象…</p>
     <h4>{{edit.type==='mutual'?'互通群（至少两个）':'源群'}}</h4>
     <div class="sharing-selected"><NTag v-for="s in edit.sources" :key="key(s)" :closable="!busy&&!unknown" @close="choose(s,false,false)">{{s.ref.label}}</NTag></div>
     <div class="sharing-options" role="group" aria-label="共享源群"><NCheckbox v-for="s in visibleGroups" :key="key(s)" :checked="selectedSources.has(key(s))" :disabled="busy||unknown||otherApp(s)" @update:checked="v=>choose(s,false,v)">{{s.ref.label}}<span class="field-note"> · {{s.ref.id.slice(-8)}}</span></NCheckbox></div>
     <NEmpty v-if="!visibleGroups.length&&!candidateLoading" description="没有找到可选群"/>
     <NButton v-if="next" :disabled="busy||unknown" @click="candidates(true)">加载更多群</NButton>
     <template v-if="edit.type==='directed'"><h4>目标群或指定个人私聊</h4><div class="sharing-selected"><NTag v-for="s in edit.targets" :key="key(s)" :closable="!busy&&!unknown" @close="choose(s,true,false)">{{s.ref.label}}{{s.ref.kind==='person'?' · 私聊':''}}</NTag></div>
      <div class="sharing-options" role="group" aria-label="共享目标"><NCheckbox v-for="s in [...visibleGroups,...visiblePeople]" :key="key(s)" :checked="selectedTargets.has(key(s))" :disabled="busy||unknown||otherApp(s)" @update:checked="v=>choose(s,true,v)">{{s.ref.label}}<span class="field-note"> · {{s.ref.kind==='person'?'私聊':'群'}} · {{s.ref.id.slice(-8)}}</span></NCheckbox></div><p v-if="peopleTruncated" class="field-note">人员列表未完全加载，请输入姓名后刷新缩小范围。</p>
     </template>
     <p class="field-note">已加入群不等于历史可读。应用仍须具备消息读取权限；个人授权仅用于该私聊，不扩展到其参加的群。</p>
     <ActionBar><NButton :disabled="busy||unknown" @click="close">取消</NButton><NButton attr-type="submit" type="primary" :loading="saving" :disabled="busy||unknown||!valid">保存共享规则</NButton></ActionBar>
    </form>
   </template>
  </NDrawerContent></NDrawer>
 </section>
</template>
<style scoped>
.group-sharing{display:grid;gap:14px;min-width:0}
.sharing-heading,.sharing-rule,.sharing-observation,.sharing-rule-actions,.sharing-search{display:flex;align-items:center;gap:12px}
.sharing-heading,.sharing-rule{justify-content:space-between}
.sharing-heading{padding-bottom:12px;border-bottom:1px solid var(--subtle)}
.sharing-heading h3,.sharing-rule h4{margin:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:16px;font-weight:600}
.sharing-heading .field-note{margin:4px 0 0}
.sharing-rule{padding:14px 16px;border:1px solid var(--subtle);border-radius:8px;background:var(--id-bg-canvas,var(--background));align-items:flex-start}
.sharing-rule-content{min-width:0}
.sharing-rule p{overflow-wrap:anywhere;margin:6px 0;font-size:13px}
.sharing-rule-actions{flex:none}
.sharing-observation{color:var(--muted);font-size:var(--id-font-size-meta);flex-wrap:wrap;justify-content:space-between;padding:8px 12px;border-radius:8px;background:var(--id-bg-canvas,var(--background))}
.sharing-invalid{color:var(--danger)}
.sharing-selected{display:flex;flex-wrap:wrap;gap:.5rem;margin-bottom:.75rem}
.sharing-options{display:grid;max-height:15rem;overflow:auto;gap:.75rem;padding:.25rem}
.sharing-options :deep(.n-checkbox__label){overflow-wrap:anywhere;min-width:0}
.sharing-search{margin-bottom:1rem}
.sharing-selected :deep(.n-tag){max-width:100%}
.sharing-selected :deep(.n-tag__content){overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media(max-width:36.25rem){.sharing-heading{align-items:flex-start;flex-wrap:wrap}.sharing-rule{display:grid}.sharing-rule-actions{justify-content:flex-end}.sharing-search{flex-wrap:wrap}}
</style>
