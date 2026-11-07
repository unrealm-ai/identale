<script setup lang="ts">
import {computed,onUnmounted,ref,watch} from 'vue';
import {NAlert,NButton,NCheckbox,NEmpty,NSelect,NSpace,NTag} from 'naive-ui';
import {api,errorMessage} from '../../shared/api';
export interface GroupTarget {kind:'group';provider:string;connectionId:string;appId:string;tenantId:string;bindingVersion:string;id:string;label:string;proof:string}
type Group=GroupTarget&{name:string|null;preview:string|null;lastMessageAt:number|null;available:boolean};
type Page={connections:{id:string;provider:string;appId:string;label:string}[];items:Group[];nextCursor:string|null;coverage:string};
const props=defineProps<{base:string;value:GroupTarget[];disabled?:boolean;draft?:boolean}>();
const emit=defineEmits<{'update:value':[value:GroupTarget[]]}>();
const key=(g:GroupTarget)=>JSON.stringify([g.provider,g.tenantId,g.appId,g.kind,g.id]);
const connection=ref<string|null>(null),connections=ref<Page['connections']>([]),items=ref<Group[]>([]),next=ref<string|null>(null),loading=ref(false),error=ref(''),coverage=ref('');
const selected=computed(()=>new Set(props.value.map(key)));
const controller=new AbortController();let generation=0;
async function load(more=false){if(props.draft)return;const current=++generation;loading.value=true;error.value='';try{
 const query=new URLSearchParams();if(connection.value)query.set('connectionId',connection.value);if(more&&next.value)query.set('cursor',next.value);
 const page=await api<Page>(props.base+'/notification-groups'+(query.size?'?'+query:''),controller.signal);
 if(controller.signal.aborted||current!==generation)return;connections.value=page.connections;items.value=more?[...new Map([...items.value,...page.items].map(g=>[key(g),g])).values()]:page.items;next.value=page.nextCursor;coverage.value=page.coverage;
 if(!connection.value&&page.connections[0])connection.value=page.connections[0].id;
 }catch(cause){if(current===generation&&!controller.signal.aborted)error.value=errorMessage(cause);}finally{if(current===generation)loading.value=false;}}
function choose(g:Group,checked:boolean){if(props.disabled||!g.available)return;emit('update:value',checked?[...props.value.filter(v=>key(v)!==key(g)),g]:props.value.filter(v=>key(v)!==key(g)));}
function remove(g:GroupTarget){emit('update:value',props.value.filter(v=>key(v)!==key(g)));}
watch(connection,()=>{items.value=[];next.value=null;void load();});
watch(()=>props.base,()=>{generation++;items.value=[];next.value=null;connection.value=null;void load();});
void load();onUnmounted(()=>{generation++;controller.abort();});
</script>
<template>
 <section class="group-picker" aria-label="结果通知群">
  <h4>结果通知群</h4><p class="field-note">任务结束后通知所选群，可多选。不选择时仅保存在任务记录中。</p>
  <p v-if="draft" class="field-note">创建员工并接入渠道后，可以选择通知群。</p>
  <template v-else>
   <NSpace v-if="value.length" class="group-selected" aria-label="已选通知群"><NTag v-for="g in value" :key="key(g)" :closable="!disabled" :title="g.label" @close="remove(g)">{{ g.label }} · {{ g.provider==='feishu'?'飞书':g.provider==='dingtalk'?'钉钉':'企微' }}</NTag></NSpace>
   <div class="group-toolbar"><NSelect v-model:value="connection" :disabled="disabled||loading" :options="connections.map(c=>({value:c.id,label:c.label+' · '+c.appId}))" placeholder="选择渠道应用" aria-label="通知渠道应用"/><NButton :disabled="disabled||loading" :loading="loading" @click="load()">刷新</NButton></div>
   <NAlert v-if="error" type="error" role="alert">{{ error }}<NButton size="small" :disabled="loading" @click="load()">重试</NButton></NAlert>
   <p v-if="loading" role="status" class="field-note">正在查找群…</p>
   <NEmpty v-else-if="!connections.length&&!error" description="请先在渠道中接入数字员工。"/>
   <template v-if="connection">
    <p v-if="coverage==='mentions_only'" class="field-note">没有找到群？请在目标群 @这个数字员工，然后刷新。</p>
    <NEmpty v-if="!items.length&&!loading&&!error" description="还没有找到群"/>
    <div class="group-options" role="group" aria-label="可选通知群">
     <NCheckbox v-for="g in items" :key="key(g)" :checked="selected.has(key(g))" :disabled="disabled||!g.available" @update:checked="v=>choose(g,v)">
      <span class="group-label">{{ g.provider==='wecom'?g.preview||g.label:g.name||g.label }}</span>
      <span class="group-meta">{{ g.id.slice(-8) }}<template v-if="g.lastMessageAt"> · {{ new Date(g.lastMessageAt).toLocaleString() }}</template><template v-if="!g.available"> · 已离开，无法发送</template></span>
     </NCheckbox>
    </div>
    <NButton v-if="next" :disabled="disabled||loading" @click="load(true)">加载更多群</NButton>
   </template>
  </template>
 </section>
</template>
<style scoped>
.group-picker{min-width:0;display:grid;gap:var(--id-space-3);margin:var(--id-space-4) 0}.group-picker h4,.group-picker p{margin:0}.group-toolbar{display:flex;gap:var(--id-space-2)}.group-toolbar>.n-select{flex:1;min-width:0}.group-options{min-width:0;display:grid;max-height:17.5rem;overflow:auto;gap:var(--id-space-3);padding:var(--id-space-1)}.group-options .n-checkbox{align-items:flex-start;min-width:0;max-width:100%;width:100%}.group-label{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;line-height:1.5}.group-meta{display:block;color:var(--muted);font-size:var(--id-font-size-caption);margin-top:.125rem}.group-picker :deep(.n-checkbox__label){min-width:0}
.group-selected{max-width:100%;min-width:0}.group-selected :deep(>div){max-width:100%;min-width:0}.group-selected :deep(.n-tag){max-width:100%;min-width:0}.group-selected :deep(.n-tag__content){min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
</style>

