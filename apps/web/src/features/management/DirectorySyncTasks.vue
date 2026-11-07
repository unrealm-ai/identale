<script setup lang="ts">
import InfoHint from '../../shared/ui/InfoHint.vue';
import {computed,ref,watch} from 'vue';
import {NAlert,NButton,NCard,NEmpty,NFormItem,NInputNumber,NSelect,NSkeleton,NSpace,NTag} from 'naive-ui';
import {syncStatusLabel,syncTime,type DirectorySyncTaskView,type DirectorySyncRunView,type SyncLoadState} from './directory-sync-view';
const props=defineProps<{canManage:boolean;loadState:SyncLoadState;tasks:DirectorySyncTaskView[];error:string;pendingTaskId:string|null;selectedTaskId:string|null;history:DirectorySyncRunView[];historyLoading:boolean;historyError:string;historyHasMore?:boolean}>();
const emit=defineEmits<{refresh:[];select:[id:string];toggle:[id:string,enabled:boolean];interval:[id:string,minutes:number];sync:[id:string];historyRefresh:[id:string];historyMore:[id:string]}>();
const employeeId=ref<string|null>(null),channel=ref<string|null>(null),intervals=ref<Record<string,number|null>>({});
const knownIntervals=new Map<string,number>();
watch(()=>props.tasks,tasks=>{const next:Record<string,number|null>={};for(const task of tasks){next[task.id]=!knownIntervals.has(task.id)||knownIntervals.get(task.id)!==task.intervalMinutes?task.intervalMinutes:intervals.value[task.id]??task.intervalMinutes;knownIntervals.set(task.id,task.intervalMinutes);}for(const id of knownIntervals.keys())if(!tasks.some(t=>t.id===id))knownIntervals.delete(id);intervals.value=next;},{immediate:true});
const employeeOptions=computed(()=>[...new Map(props.tasks.map(t=>[t.employeeId,{label:t.employeeName,value:t.employeeId}])).values()]);
const channelOptions=computed(()=>[...new Set(props.tasks.map(t=>t.channelName))].map(name=>({label:name,value:name})));
const rows=computed(()=>props.tasks.filter(t=>(!employeeId.value||t.employeeId===employeeId.value)&&(!channel.value||t.channelName===channel.value)));
const selected=computed(()=>props.tasks.find(t=>t.id===props.selectedTaskId));
const mutating=computed(()=>props.pendingTaskId!==null);
function validInterval(task:DirectorySyncTaskView){const v=intervals.value[task.id];return typeof v==='number'&&Number.isFinite(v)&&v>=1&&v<=43200;}
function saveInterval(task:DirectorySyncTaskView){if(mutating.value||!task.canSchedule||!validInterval(task))return;emit('interval',task.id,Number(intervals.value[task.id]));}
</script>
<template>
 <section class="directory-sync-tasks">
  <NAlert v-if="!canManage||loadState==='denied'" type="error">当前账号没有此工作区的管理权限，请联系所有者或管理员。</NAlert>
  <template v-else>
   <div class="sync-heading"><div><h2>通讯录同步</h2><p class="field-note">查看同步时间、结果并管理同步计划。</p><details class="sync-help"><summary>同步说明</summary><p class="field-note">暂停定时同步不会停止机器人连接。企微同一工作区的共享通讯录应用只同步一次，员工使用范围仍各自独立。同步失败不自动重试，下一次按正常周期执行。</p></details></div><NButton :disabled="loadState==='loading'||mutating" @click="emit('refresh')">刷新同步状态</NButton></div>
   <NAlert v-if="loadState==='error'" type="error" role="alert">{{ error || '同步记录读取失败，请刷新重试。' }}</NAlert>
   <div v-else-if="loadState==='loading'" role="status"><NSkeleton text :repeat="3" /><p>正在读取当前工作区的同步任务…</p></div>
   <template v-else>
    <div v-if="tasks.length" class="sync-filters"><NFormItem label="同步来源"><NSelect v-model:value="employeeId" aria-label="同步任务数字员工" clearable :options="employeeOptions" :disabled="mutating" placeholder="全部来源" /></NFormItem><NFormItem label="渠道"><NSelect v-model:value="channel" aria-label="同步任务渠道" clearable :options="channelOptions" :disabled="mutating" placeholder="全部渠道" /></NFormItem></div>
    <NEmpty v-if="!tasks.length" description="当前工作区暂无通讯录同步任务"><template #extra><p class="field-note">连接并验证渠道通讯录后，可在这里管理对应同步任务。</p></template></NEmpty>
    <NEmpty v-else-if="!rows.length" description="没有符合筛选条件的同步任务" />
    <div class="sync-task-list"><NCard v-for="task in rows" :key="task.id" class="sync-task" size="small" :aria-label="`${task.employeeName} · ${task.channelName}同步任务`">
     <div class="sync-task-title"><div><h3>{{ task.employeeName }}</h3><span class="field-note">{{ task.channelName }}<template v-if="task.connectionLabel"> · {{ task.connectionLabel }}</template></span></div><NSpace><NTag size="small" :type="task.running?'info':task.lastStatus==='failed'?'warning':task.lastStatus==='succeeded'?'success':'default'">{{ task.running?'同步中':syncStatusLabel(task.lastStatus) }}</NTag><NTag size="small" :type="task.scheduleEnabled?'success':'default'">{{ task.scheduleEnabled?'定时同步已启用':'定时同步已暂停' }}</NTag></NSpace></div>
     <dl class="sync-facts"><div><dt>最近成功</dt><dd>{{ syncTime(task.lastSuccessAt) }}</dd></div><div><dt>下次计划</dt><dd>{{ task.scheduleEnabled?syncTime(task.nextRunAt):'已暂停' }}</dd></div></dl>
     <NAlert v-if="task.snapshotState==='invalid'" type="warning">目录来源已解绑或失效；历史同步记录保留，原快照不再作为有效来源。</NAlert>
     <NAlert v-else-if="task.snapshotState==='none'" type="warning">尚无已同步的人员或部门。选择使用范围后可立即同步。</NAlert>
     <NAlert v-else-if="task.snapshotState==='stale'||task.latestError" type="warning">继续使用最近成功的目录快照。陈旧或同步失败仅提示，不因此阻断对话。</NAlert>
     <p v-if="task.latestError" class="sync-error" role="status">最近错误：{{ task.latestError }}</p>
     <div class="sync-actions"><div class="interval-edit"><NFormItem label="同步周期（分钟）"><template #label>同步周期（分钟）<InfoHint label="同步周期范围">1分钟至30天，默认60分钟。</InfoHint></template><NInputNumber :value="intervals[task.id]??null" :min="1" :max="43200" :step="1" :input-props="{'aria-label':`${task.employeeName}同步周期（分钟）`}" :disabled="mutating||!task.canSchedule" @update:value="value=>{intervals[task.id]=value}" /></NFormItem><NButton :disabled="mutating||!task.canSchedule||!validInterval(task)||intervals[task.id]===task.intervalMinutes" @click="saveInterval(task)">保存周期</NButton></div>
      <NSpace><NButton :disabled="mutating||!task.canSchedule" @click="emit('toggle',task.id,!task.scheduleEnabled)">{{ task.scheduleEnabled?'暂停定时同步':'启用定时同步' }}</NButton><NButton type="primary" secondary :loading="pendingTaskId===task.id" :disabled="mutating||task.running||!task.canRun" @click="emit('sync',task.id)">{{ task.running?'同步进行中':'立即同步' }}</NButton><NButton :disabled="mutating" @click="emit('select',task.id)">查看同步记录</NButton></NSpace>
     </div>
    </NCard></div>
    <NCard v-if="selected" class="sync-history" size="small" :title="`${selected.employeeName} · ${selected.channelName}同步记录`"><template #header-extra><NButton :disabled="historyLoading||mutating" @click="emit('historyRefresh',selected.id)">刷新记录</NButton></template>
     <p v-if="historyLoading" role="status">正在读取同步记录…</p><NAlert v-else-if="historyError" type="error">{{ historyError }}</NAlert><NEmpty v-else-if="!history.length" description="此连接暂无同步记录" />
     <div v-else class="history-scroll"><table><thead><tr><th>开始时间</th><th>结束时间</th><th>触发方式</th><th>结果</th><th>快照 / 读取数量</th><th>错误</th></tr></thead><tbody><tr v-for="run in history" :key="run.id"><td>{{ syncTime(run.startedAt) }}</td><td>{{ syncTime(run.completedAt) }}</td><td>{{ ({manual:'手动',scheduled:'定时',demand:'按需',configuration:'配置变更',unknown:'待核对'})[run.trigger] }}</td><td>{{ run.status==='succeeded'?'成功':run.status==='failed'?'失败':run.status==='running'?'同步中':run.status==='abandoned'?'已中断':'待核对' }}</td><td><template v-if="run.snapshotVersion!=null">v{{ run.snapshotVersion }}</template><template v-if="run.userCount!==undefined&&run.departmentCount!==undefined"> · 人员 {{ run.userCount }} / 部门 {{ run.departmentCount }}</template></td><td>{{ run.error||'—' }}</td></tr></tbody></table></div><NButton v-if="historyHasMore" :disabled="historyLoading||mutating" @click="emit('historyMore',selected.id)">加载更早记录</NButton>
    </NCard>
   </template>
  </template>
 </section>
</template>
<style scoped>
.directory-sync-tasks,.sync-task-list{display:grid;gap:1.25rem}.sync-heading,.sync-task-title,.sync-actions{display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap}h2,h3{margin:0}h2{font-size:1.25rem}h3{font-size:1rem}.sync-heading .field-note{max-width:47.5rem;margin-bottom:0}.sync-filters{display:grid;grid-template-columns:minmax(13.75rem,1fr) minmax(11.25rem,1fr);gap:1.125rem}.sync-facts{display:flex;gap:2.5rem;flex-wrap:wrap;margin:1.25rem 0}.sync-facts dt{font-size:0.75rem;color:var(--muted)}.sync-facts dd{margin:0.375rem 0 0}.sync-error{overflow-wrap:anywhere;color:var(--warning)}.sync-actions{margin-top:1.125rem}.interval-edit{display:flex;gap:0.75rem;align-items:end}.interval-edit :deep(.n-form-item){margin:0}.interval-edit :deep(.n-form-item-feedback-wrapper){display:none}.history-scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:0.8125rem}th,td{padding:0.75rem;text-align:left;border-bottom:1px solid var(--subtle);vertical-align:top}td:last-child{max-width:18.75rem;overflow-wrap:anywhere}@media(max-width:40.625rem){.sync-filters{grid-template-columns:1fr}.sync-facts{gap:1.25rem}.interval-edit{width:100%;flex-wrap:wrap}.sync-heading>.n-button{width:100%}}
</style>
