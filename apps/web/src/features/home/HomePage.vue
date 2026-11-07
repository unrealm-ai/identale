<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { NButton, NSkeleton } from 'naive-ui';
import { taskDisplayTitle } from '@dentity/contracts';
import { api, ApiError, type Entity } from '../../shared/api';
import PageHeader from '../../shared/ui/PageHeader.vue';
import EmployeeAvatar from '../../shared/ui/EmployeeAvatar.vue';
import StatusBadge from '../../shared/ui/StatusBadge.vue';
import TaskOverview from '../workbench/TaskOverview.vue';
import type { ActivityTask } from '../tasks/task-activity';
import type { RecentConversation } from '../conversations/useConversationList';
import { conversationPreview } from '../conversations/conversation-preview';
const props=defineProps<{name:string;admin:boolean;workspaceId:string;entities:Entity[]}>();
const emit=defineEmits<{create:[];conversations:[];employees:[];tasks:[];human:[];monitor:[];openEmployee:[id:string];openConversation:[entity:Entity,id:string];openTask:[id:string];sessionExpired:[]}>();
interface Pending {requestId:string;title:string;proposerEmployeeId:string;recipientLabel:string;notificationStatus:string;canOpenConversation:boolean;conversationId?:string;status:string}
const tasks=ref<ActivityTask[]>([]), conversations=ref<RecentConversation[]>([]), requests=ref<Pending[]>([]);
const employees=ref<Entity[]>([]), employeesLoaded=ref(false);
const overview=ref<{refresh:()=>Promise<void>}|null>(null);
const loading=ref(false), failures=ref<string[]>([]);
let controller=new AbortController();
async function load(){
 if(loading.value)return;
 const signal=controller.signal;
 loading.value=true;failures.value=[];
 const base=`/workspaces/${encodeURIComponent(props.workspaceId)}`;
 async function read<T>(name:string,path:string,accept:(value:T)=>void,clear:()=>void){
  try{const value=await api<T>(base+path,signal);if(!signal.aborted)accept(value);}
  catch(e){if(!signal.aborted){failures.value.push(name);if(e instanceof ApiError&&[401,403].includes(e.status))clear();if(e instanceof ApiError&&e.status===401)emit('sessionExpired');}}
 }
 await Promise.all([
  read<{records:Entity[]}>('数字员工','/employee-summaries?limit=4',r=>{employees.value=r.records;employeesLoaded.value=true;},()=>{employees.value=[];employeesLoaded.value=false;}),
  read<{records:RecentConversation[]}>('最近对话','/recent-conversations',r=>conversations.value=r.records.slice(0,4),()=>conversations.value=[]),
  read<{items:Pending[]}>('待人工确认','/work-items/pending-human',r=>requests.value=r.items,()=>requests.value=[]),
  ...(props.admin?[read<{records:ActivityTask[]}>('最近任务','/task-management/task-list?limit=5&summary=true&status=all',r=>tasks.value=r.records,()=>tasks.value=[])]:[]),
  props.admin?overview.value?.refresh():undefined,
 ]);
 if(!signal.aborted)loading.value=false;
}
watch(()=>[props.workspaceId,props.admin],()=>{
 controller.abort();controller=new AbortController();loading.value=false;
 employees.value=[];employeesLoaded.value=false;tasks.value=[];requests.value=[];conversations.value=[];
 void load();
},{immediate:true});
function refreshVisible(){if(!document.hidden)void load();}
const timer=setInterval(refreshVisible,30_000);
window.addEventListener('focus',refreshVisible);
document.addEventListener('visibilitychange',refreshVisible);
onUnmounted(()=>{controller.abort();clearInterval(timer);window.removeEventListener('focus',refreshVisible);document.removeEventListener('visibilitychange',refreshVisible);});
const greeting=computed(()=>{const h=new Date().getHours();return h<12?'上午好':h<18?'下午好':'晚上好';});
const today=computed(()=>new Date().toLocaleDateString('zh-CN',{weekday:'long',month:'long',day:'numeric'}));
const preview=computed(()=>employees.value);
const name=(id:string)=>employees.value.find(e=>e.id===id)?.name??props.entities.find(e=>e.id===id)?.name??'数字员工';
const time=(n:number)=>new Date(n).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
function openRequest(r:Pending){const entity=employees.value.find(e=>e.id===r.proposerEmployeeId)??props.entities.find(e=>e.id===r.proposerEmployeeId);if(entity&&r.canOpenConversation&&r.conversationId)emit('openConversation',entity,r.conversationId);else emit('human');}
</script>
<template><section class="home-page">
<PageHeader :title="`${greeting}${props.name ? '，'+props.name : ''}`" :description="`${today} · 从这里了解团队的工作进展。`"><NButton :loading="loading" :disabled="loading" @click="load">刷新首页</NButton><NButton @click="emit('conversations')">发起对话</NButton><NButton type="primary" @click="emit('create')">新建数字员工</NButton></PageHeader>
<TaskOverview ref="overview" v-if="admin" :workspace-id="workspaceId" @session-expired="emit('sessionExpired')"/>
<p v-if="failures.length" class="home-error" role="alert">{{failures.join('、')}}暂时无法更新，已有内容可能不是最新。<NButton text type="primary" :disabled="loading" @click="load">重试</NButton></p>
<div class="home-columns"><div class="home-primary">
<section class="home-panel"><header><h2>我的数字员工 <small>{{preview.length?`展示 ${preview.length} 位`:''}}</small></h2><NButton text type="primary" @click="emit('employees')">查看全部 →</NButton></header><div v-if="loading&&!employeesLoaded" class="home-empty" role="status"><NSkeleton text :repeat="3"/>正在读取数字员工…</div><p v-else-if="failures.includes('数字员工')&&!employeesLoaded" class="home-empty" role="alert">数字员工暂不可用，请重试。</p><div v-else-if="preview.length" class="home-employees"><button v-for="entity in preview" :key="entity.id" class="home-employee" @click="emit('openEmployee',entity.id)"><div class="mini-badge"><span>数字员工</span><code :title="entity.id">{{entity.id}}</code></div><div class="mini-identity"><EmployeeAvatar :name="entity.name" :preset="entity.avatarPreset" :identity-key="entity.id" size="conversation"/><span><strong>{{entity.name}} <i class="ai-tag">AI</i></strong><small>{{entity.description||'尚未填写职责'}}</small></span></div><div class="mini-state"><StatusBadge domain="configuration" :status="entity.enabled===false?'disabled':entity.enabled===true?'enabled':'unknown'"/></div></button></div><p v-else class="home-empty">工作区还没有数字员工。<NButton text type="primary" @click="emit('create')">创建第一位员工</NButton></p></section>
<section v-if="admin" class="home-panel"><header><h2>最近任务 <small>完成与送达分别核对</small></h2><NButton text type="primary" @click="emit('tasks')">前往任务 →</NButton></header><div v-if="loading&&!tasks.length" class="home-empty"><NSkeleton text :repeat="4"/></div><p v-else-if="!tasks.length" class="home-empty">{{failures.includes('最近任务')?'任务暂不可用，请重试。':'还没有任务。与数字员工对话，交付第一项工作。'}}</p><div v-else class="home-task-table"><div class="home-task-head"><span>任务</span><span>执行员工</span><span>任务状态</span><span>创建时间</span></div><button v-for="task in tasks" :key="task.id" class="home-task-row" @click="emit('openTask',task.id)"><span><strong>{{taskDisplayTitle(task)}}</strong><code>{{task.id}}</code></span><span>{{task.employeeName??name(task.entityId??'')}}</span><StatusBadge :status="task.status"/><time>{{time(task.createdAt)}}</time></button></div></section>
<section v-if="admin" class="home-panel home-runtime"><span>⌘ <strong>运行监控</strong></span><p>查看服务状态、渠道连接与配置同步。</p><NButton text type="primary" @click="emit('monitor')">查看状态 →</NButton></section>
<section v-else class="home-panel home-runtime"><span><strong>开始协作</strong></span><p>选择可使用的员工，在持续对话中交代目标、跟进任务。</p><NButton text type="primary" @click="emit('conversations')">前往对话 →</NButton></section>
</div><div class="home-secondary"><section class="home-panel"><header><h2>待人工确认 <small v-if="!loading&&!failures.includes('待人工确认')">{{requests.length}} 项</small></h2><NButton text type="primary" @click="emit('human')">查看全部</NButton></header><div v-if="loading&&!requests.length" class="home-empty"><NSkeleton text :repeat="3"/></div><p v-else-if="!requests.length" class="home-empty">{{failures.includes('待人工确认')?'待确认请求暂不可用。':'暂无待人工确认的问题。'}}</p><button v-for="r in requests.slice(0,5)" :key="r.requestId" class="home-request" @click="openRequest(r)"><EmployeeAvatar :name="name(r.proposerEmployeeId)" :identity-key="r.proposerEmployeeId" size="conversation"/><span><strong>{{name(r.proposerEmployeeId)}}</strong> {{r.title}}<small>确认人：{{r.recipientLabel}}</small><small><StatusBadge :label="r.status==='confirmed'?'已确认，等待继续':'等待确认'" :status="r.status==='confirmed'?'confirmed':'waiting_approval'"/><StatusBadge v-if="['failed','blocked','unknown'].includes(r.notificationStatus)" domain="delivery" :status="r.notificationStatus"/></small></span><span aria-hidden="true">›</span></button></section>
<section class="home-panel"><header><h2>最近对话</h2><NButton text type="primary" @click="emit('conversations')">全部对话 →</NButton></header><div v-if="loading&&!conversations.length" class="home-empty"><NSkeleton text :repeat="3"/></div><p v-else-if="!conversations.length" class="home-empty">{{failures.includes('最近对话')?'对话暂不可用，请重试。':'还没有最近对话。选择一位数字员工开始交流。'}}</p><button v-for="row in conversations" :key="row.entity.id" class="home-conversation" @click="emit('openConversation',row.entity,row.conversation.id)"><EmployeeAvatar :name="row.entity.name" :preset="row.entity.avatarPreset" :identity-key="row.entity.id" size="conversation"/><span><strong>{{row.entity.name}}</strong><small>{{row.previewUnavailable?'打开对话查看消息':conversationPreview(row.preview)||'打开查看对话'}}</small></span><time>{{time(row.activityAt)}}</time></button></section></div></div>
</section></template>
<style scoped>
.home-page{display:grid;gap:16px}.home-page :deep(.page-heading){margin-bottom:0}.home-columns{display:grid;grid-template-columns:minmax(0,1.8fr) minmax(300px,1fr);gap:20px;align-items:start}.home-primary,.home-secondary{display:grid;gap:16px;min-width:0}.home-panel{background:var(--surface);border:1px solid var(--subtle);border-radius:12px;overflow:hidden;min-width:0}.home-panel>header{display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid var(--subtle);padding:14px 16px}.home-panel h2{font-size:16px;line-height:24px;margin:0}.home-panel h2 small{font-size:12px;font-weight:400;color:var(--muted);margin-left:8px}.home-employees{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;padding:16px}.home-employee{background:var(--surface);border:1px solid var(--subtle);border-radius:12px;padding:0;text-align:left;overflow:hidden;color:var(--text);font:inherit;cursor:pointer;min-width:0}.home-employee:hover{border-color:var(--brand)}.mini-badge{display:flex;gap:8px;justify-content:space-between;padding:6px 10px;background:var(--tint);color:var(--selectedText);font-size:10px}.mini-badge code{max-width:45%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.mini-identity{display:flex;gap:8px;align-items:center;padding:12px 10px}.mini-identity>span{min-width:0}.mini-identity strong{font-size:14px}.mini-identity small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:12px}.mini-state{padding:0 10px 12px}.ai-tag{font-style:normal;font-size:10px;color:var(--selectedText);background:var(--tint);padding:1px 3px;border-radius:3px}.home-empty{padding:24px 16px;color:var(--muted);margin:0}.home-task-head,.home-task-row{display:grid;grid-template-columns:minmax(0,1fr) 100px 100px 100px;gap:12px;padding:12px 16px;align-items:center}.home-task-head{font-size:12px;color:var(--muted);background:var(--background)}.home-task-row{width:100%;font:inherit;color:var(--text);text-align:left;border:0;border-top:1px solid var(--subtle);background:transparent;cursor:pointer;font-size:13px}.home-task-row:hover,.home-request:hover,.home-conversation:hover{background:var(--hoverTint)}.home-task-row>span:first-child{min-width:0}.home-task-row strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}.home-task-row code{display:block;font-size:10px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.home-task-row .status-badge{justify-self:start}.home-task-row time{font-size:12px;color:var(--muted)}.home-runtime{display:flex;gap:16px;align-items:center;padding:12px 16px;flex-wrap:wrap;font-size:12px}.home-runtime p{flex:1;margin:0;color:var(--muted)}.home-request,.home-conversation{display:flex;align-items:center;gap:10px;background:transparent;border:0;border-bottom:1px solid var(--subtle);width:100%;padding:16px;text-align:left;font:inherit;color:var(--text);cursor:pointer}.home-request>span:nth-child(2),.home-conversation>span:nth-child(2){flex:1;min-width:0;font-size:13px}.home-request small{display:flex;gap:4px;flex-wrap:wrap;margin-top:6px}.home-conversation small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--muted);font-size:12px;margin-top:4px}.home-conversation time{font-size:10px;color:var(--muted)}.home-error{margin:0;color:var(--danger)}
@media(max-width:1300px){.home-employees{grid-template-columns:repeat(2,minmax(0,1fr))}.home-task-head,.home-task-row{grid-template-columns:minmax(0,1fr) 80px 100px}.home-task-head>span:last-child,.home-task-row>time{display:none}}
@media(max-width:1050px){.home-columns{grid-template-columns:1fr}.home-secondary{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:760px){.home-secondary{grid-template-columns:1fr}.home-task-head{display:none}.home-task-row{grid-template-columns:1fr auto}.home-task-row>span:nth-child(2){display:none}.home-panel h2 small{display:none}.home-panel>header{padding:12px}.home-employees{padding:12px;gap:8px}}
</style>
