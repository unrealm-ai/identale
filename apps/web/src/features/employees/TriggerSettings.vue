<!-- Modified for Identale; see the root NOTICE. -->
<script setup lang="ts">
import{notificationStatus}from'../../shared/notification-status';
import InfoHint from '../../shared/ui/InfoHint.vue';
import GroupNotificationPicker,{type GroupTarget} from './GroupNotificationPicker.vue';
import {computed,nextTick,onUnmounted,ref,watch} from 'vue';
import {NAlert,NButton,NCard,NCheckbox,NCheckboxGroup,NDrawer,NDrawerContent,NEmpty,NForm,NFormItem,NInput,NInputNumber,NSelect,NSpace,NTag} from 'naive-ui';
import {api,ApiError,errorMessage} from '../../shared/api';
import {triggerPolicyLabel,triggerPolicyDescription,triggerTypeLabel,triggerActionLabel,triggerStatusLabel,type TriggerDraft,type TriggerPolicy,type TriggerRow} from './trigger-types';
const props=defineProps<{base:string;draft?:boolean;disabled?:boolean}>();
const emit=defineEmits<{change:[value:{triggers:TriggerDraft[];policy:TriggerPolicy}];busyChanged:[value:boolean];changed:[];sessionExpired:[]}>();
const rows=ref<TriggerRow[]>([]),drafts=ref<TriggerDraft[]>([]),policy=ref<TriggerPolicy>('isolated'),policyVersion=ref(1),loading=ref(false),saving=ref(false),error=ref(''),notice=ref(''),editor=ref(false),discard=ref(false),original=ref(''),editId=ref<string|null>(null),events=ref<Record<string,unknown>[]|null>(null);
const notificationFailure=(code:unknown,generation?:string)=>generation&&generation!=='published'?(generation==='unknown'?'生成结果待核对，请勿重复发起':'请检查员工配置与回告记录'):({forbidden:'没有发送权限或已离开群',unauthenticated:'渠道认证失败',rate_limited:'渠道限流',retry_budget_exhausted:'多次重试后仍未发送',delivery_unknown:'发送结果待核对，未自动重发',send_confirmation_timeout:'渠道未提供送达确认，未自动重发',notification_target_invalid:'通知群信息已失效',notification_task_changed:'任务状态已变化'}[String(code)]??'请核对渠道和群状态');
const submitting=ref(false),notificationTargets=ref<GroupTarget[]>([]);
const name=ref(''),kind=ref('generic'),enabled=ref(false),cron=ref('0 9 * * *'),zone=ref('Asia/Shanghai'),description=ref(''),keyMode=ref('empty'),keyValue=ref(''),period=ref('day'),repositoryId=ref<number|null>(null),installationId=ref<number|null>(null),actions=ref(['create_task']),keyId=ref(''),secret=ref(''),preview=ref('');
const busy=computed(()=>loading.value||saving.value),list=computed(()=>(props.draft?drafts.value.map(d=>({...d,id:d.draftId,version:0,credentials:[],nextScheduledAt:null})):rows.value));
const controller=new AbortController();let generation=0;
watch(()=>busy.value||editor.value||submitting.value,v=>emit('busyChanged',v),{flush:'sync'});
watch([drafts,policy],()=>{if(props.draft)emit('change',{triggers:drafts.value,policy:policy.value});},{deep:true});
async function request<T>(suffix:string,body?:unknown,method?:'POST'|'PUT'|'PATCH'|'DELETE'){return api<T>(props.base+suffix,controller.signal,body,method);}
async function run(fn:()=>Promise<void>){if(busy.value)return;const current=++generation;saving.value=true;error.value='';try{await fn();}catch(cause){if(!controller.signal.aborted&&current===generation){error.value=errorMessage(cause);if(cause instanceof ApiError&&cause.status===401)emit('sessionExpired');}}finally{if(current===generation)saving.value=false;}}
async function load(){if(props.draft)return;await run(async()=>{const v=await request<{triggers:TriggerRow[];policy:{policy:TriggerPolicy;version:number}}>('/triggers');if(controller.signal.aborted)return;rows.value=v.triggers;policy.value=v.policy.policy;policyVersion.value=v.policy.version;});}
function payload(){return{name:name.value.trim(),type:kind.value==='schedule'?'schedule' as const:'webhook' as const,enabled:enabled.value,allowedActions:kind.value==='generic'?actions.value:['create_task'],config:{...(!props.draft?{notificationTargets:notificationTargets.value}:{}),...(kind.value==='schedule'?{cron:cron.value,timezone:zone.value,description:description.value,businessKey:keyMode.value==='fixed'?{mode:'fixed',value:keyValue.value}:keyMode.value==='period'?{mode:'period',period:period.value}:{mode:'empty'}}:kind.value==='github_issue'?{adapter:'github_issue',repositoryId:repositoryId.value,...(installationId.value?{installationId:installationId.value}:{})}:{adapter:'generic'})},...(secret.value?{credential:{keyId:keyId.value,secret:secret.value}}:{})};}
function open(id?:string){if(busy.value||props.disabled)return;const row=list.value.find(r=>r.id===id);editId.value=id??null;notificationTargets.value=Array.isArray(row?.config.notificationTargets)?row.config.notificationTargets as GroupTarget[]:[];name.value=row?.name??'';enabled.value=row?.enabled??false;kind.value=row?.type==='schedule'?'schedule':String(row?.config.adapter??'generic');cron.value=String(row?.config.cron??'0 9 * * *');zone.value=String(row?.config.timezone??'Asia/Shanghai');description.value=String(row?.config.description??'');const key=row?.config.businessKey as{mode?:string;value?:string;period?:string}|undefined;keyMode.value=key?.mode??'empty';keyValue.value=key?.value??'';period.value=key?.period??'day';repositoryId.value=Number(row?.config.repositoryId)||null;installationId.value=Number(row?.config.installationId)||null;actions.value=[...(row?.allowedActions??['create_task'])];keyId.value=props.draft?drafts.value.find(d=>d.draftId===id)?.credential?.keyId??'':'';secret.value=props.draft?drafts.value.find(d=>d.draftId===id)?.credential?.secret??'':'';preview.value='';discard.value=false;editor.value=true;original.value=JSON.stringify(payload());}
function close(){if(busy.value||submitting.value)return;if(original.value!==JSON.stringify(payload())){discard.value=true;return;}leave();}
function leave(){editor.value=false;secret.value='';keyId.value='';discard.value=false;}
async function save(){if(!editor.value||props.disabled||busy.value||submitting.value)return;if(!name.value.trim()||kind.value==='schedule'&&!description.value.trim()){error.value='请填写名称和定时任务说明。';return;}if(secret.value&&(!keyId.value||new TextEncoder().encode(secret.value).length<32)){error.value='请填写密钥标识和至少 32 字节的密钥。';return;}const value=payload();submitting.value=true;try{if(props.draft){const id=editId.value??crypto.randomUUID();drafts.value=editId.value?drafts.value.map(d=>d.draftId===id?{...value,draftId:id}:d):[...drafts.value,{...value,draftId:id}];leave();return;}await run(async()=>{const row=rows.value.find(r=>r.id===editId.value);const result=await request<TriggerRow>('/triggers'+(row?'/'+encodeURIComponent(row.id):''),{...value,...(row?{expectedVersion:row.version}:{})},row?'PUT':'POST');rows.value=[...rows.value.filter(r=>r.id!==result.id),result];notice.value='自动化任务已保存。后续执行使用新配置，已开始的执行保留原配置。';leave();emit('changed');});}finally{await nextTick();submitting.value=false;}}
async function changePolicy(value:TriggerPolicy){if(props.draft){policy.value=value;return;}await run(async()=>{const result=await request<{policy:TriggerPolicy;version:number}>('/trigger-history-policy',{policy:value,expectedVersion:policyVersion.value},'PUT');policy.value=result.policy;policyVersion.value=result.version;emit('changed');});}
async function toggle(row:TriggerRow){if(props.draft){drafts.value=drafts.value.map(d=>d.draftId===row.id?{...d,enabled:!d.enabled}:d);return;}await run(async()=>{const result=await request<TriggerRow>('/triggers/'+row.id,{name:row.name,type:row.type,config:row.config,allowedActions:row.allowedActions,enabled:!row.enabled,expectedVersion:row.version},'PUT');rows.value=rows.value.map(r=>r.id===result.id?result:r);emit('changed');});}
async function showEvents(id:string){await run(async()=>{events.value=(await request<{events:Record<string,unknown>[]}>('/triggers/'+id+'/events')).events;});}
async function revoke(id:string,key:string){await run(async()=>{await request('/triggers/'+id+'/credentials/'+encodeURIComponent(key)+'/revoke',{});const value=await request<{triggers:TriggerRow[]}>('/triggers');rows.value=value.triggers;notice.value='密钥已吊销；绑定和历史保持。';});}
async function checkPreview(){await run(async()=>{const value=await request<{timezone:string;scheduledAt:number;key?:string;start:string|null;end:string|null}>('/trigger-preview',{cron:cron.value,timezone:zone.value,businessKey:(payload().config as Record<string,unknown>).businessKey});preview.value=`下次：${new Date(value.scheduledAt).toLocaleString('zh-CN',{timeZone:value.timezone})} (${value.timezone})；业务分组：${value.key??'未分组（各任务独立）'}${value.start?'；周期 '+value.start+' → '+value.end:''}`;});}
function escape(event:KeyboardEvent){if(event.defaultPrevented||event.isComposing||event.target instanceof Element&&event.target.closest('input,textarea,[role="combobox"],.n-select'))return;event.preventDefault();event.stopPropagation();close();}
void load();onUnmounted(()=>{generation++;controller.abort();secret.value='';drafts.value=[];emit('busyChanged',false);});
</script>
<template>
<section class="trigger-settings" aria-label="自动化任务">
  <div class="trigger-header"><div><h3>自动化任务<InfoHint label="自动化任务使用范围">以员工权限运行，仅可使用对本触发器开放的能力包，与个人私聊和群聊使用权分别配置。结果可在任务记录查看，也可通知所选群。</InfoHint></h3><p class="field-note">按时间或外部事件执行，新建后默认停用。</p></div><NSpace><NButton v-if="!draft" size="small" :disabled="busy||disabled||editor" @click="load">刷新自动化任务</NButton><NButton type="primary" :disabled="busy||disabled||editor||list.length>=50" @click="open()">新增自动化任务{{ draft?'草稿':'' }}</NButton></NSpace></div>

  <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert><NAlert v-if="notice" type="success">{{ notice }}</NAlert>
  <p v-if="busy" class="field-note" role="status">正在读取或保存自动化任务…</p>
  <div class="trigger-history"><NFormItem label="执行时参考哪些历史任务" class="trigger-history-select"><NSelect :virtual-scroll="false" :value="policy" :options="(['isolated','employee_shared','business_key'] as TriggerPolicy[]).map(value=>({value,label:triggerPolicyLabel(value)}))" :disabled="busy||disabled||editor" aria-label="执行时参考哪些历史任务" @update:value="changePolicy" /></NFormItem>
  <p class="field-note" data-testid="trigger-history-policy-help">{{ triggerPolicyDescription(policy) }}<InfoHint label="历史任务参考规则">每个新任务仍独立执行。仅参考启动时已结束的自动化任务（包括失败或取消），不读取聊天任务。更改策略只影响之后创建的任务，不会重新分组已有任务。</InfoHint></p>
  </div>
  <NCard v-if="!list.length&&!busy&&!error" size="small"><NEmpty description="还没有自动化任务。可以添加定时工作，或连接外部系统事件。" /></NCard>
  <NCard v-for="row in list" :key="row.id" size="small" class="trigger-card" :aria-label="'自动化任务 '+row.name">
    <div class="trigger-card-heading"><strong>{{ row.name }}</strong><NTag size="small" :type="row.enabled?'success':'default'">{{ row.enabled?'已启用':'已停用' }}</NTag></div>
    <div class="trigger-card-meta">
      <p><span>何时执行：</span>{{ triggerTypeLabel(row.type,row.config) }}<template v-if="row.type==='schedule'"> · {{ row.config.cron }} · {{ row.config.timezone }}</template></p>
      <p><span>执行内容：</span>{{ row.type==='schedule' ? row.config.description : row.config.adapter==='github_issue' ? '根据新 Issue 的标题和正文创建任务' : row.allowedActions.map(triggerActionLabel).join('、')+'；具体内容由通过签名验证的请求提供' }}</p>
      <p v-if="row.nextScheduledAt" class="field-note">下次计划：{{ new Date(row.nextScheduledAt).toLocaleString('zh-CN',{timeZone:String(row.config.timezone)}) }}</p>
    </div>
    <details v-if="!draft" class="integration-details"><summary>接入信息与签名密钥</summary><p class="field-note">配置 ID {{ row.id }} · 版本 {{ row.version }}</p><template v-if="row.type==='webhook'"><p>外部系统向以下地址发送经过签名验证的请求：</p><code class="endpoint">{{ '/api/triggers/'+(row.config.adapter==='github_issue'?'github/':'webhook/')+row.id }}</code><p v-for="key in row.credentials" :key="key.key_id" class="field-note">密钥标识 {{ key.key_id }} · {{ triggerStatusLabel(key.status) }} <NButton v-if="key.status==='active'" size="tiny" :disabled="busy||disabled||editor" @click="revoke(row.id,key.key_id)">撤销此密钥</NButton></p></template></details>
    <div class="trigger-card-actions"><NButton size="small" :disabled="busy||disabled||editor" @click="open(row.id)">编辑 {{ row.name }}</NButton><NButton size="small" :disabled="busy||disabled||editor" @click="toggle(row)">{{ row.enabled?'停用':'启用' }} {{ row.name }}</NButton><NButton v-if="!draft" size="small" :disabled="busy||disabled||editor" @click="showEvents(row.id)">查看触发记录</NButton><NButton v-else size="small" :disabled="busy||disabled||editor" @click="drafts=drafts.filter(d=>d.draftId!==row.id)">移除自动化任务草稿</NButton></div>
  </NCard>
  <NDrawer :show="editor" :width="'min(680px, 100vw)'" :mask-closable="false" :close-on-esc="false"><NDrawerContent :title="(editId?'编辑':'新增')+'自动化任务'+(draft?'草稿':'')" closable @close="close" @keydown.esc="escape">
    <NAlert v-if="error" type="error">{{ error }}</NAlert><NAlert v-if="discard" type="warning">丢弃本次未保存的修改？<NSpace><NButton @click="discard=false">继续编辑</NButton><NButton @click="leave">丢弃并返回</NButton></NSpace></NAlert>
    <NForm class="settings-form trigger-editor" @submit.prevent="save"><h4>基本信息</h4>
      <NFormItem label="任务标题"><NInput v-model:value="name" :input-props="{'aria-label':'自动化任务标题'}" :maxlength="120" :disabled="busy" placeholder="例如：每天整理客户问题" /></NFormItem>
      <p class="field-note">每次任务标题为“标题 + 首次运行记录创建时间”，例如“日报汇总 2611051557”。定时任务按所选时区，外部事件按北京时间；排队、重试和继续执行不改变标题。</p>
      <NFormItem label="何时执行"><NSelect :virtual-scroll="false" v-model:value="kind" :options="[{label:'收到外部系统请求时（Webhook）',value:'generic'},{label:'GitHub 新建 Issue 时',value:'github_issue'},{label:'按时间执行',value:'schedule'}]" :disabled="busy||!!editId" aria-label="何时执行" /></NFormItem>
      <NCheckbox v-model:checked="enabled" :disabled="busy">启用此自动化任务</NCheckbox>
      <template v-if="kind==='schedule'"><h4>执行计划</h4>
        <div class="settings-grid"><NFormItem label="执行时间（Cron 表达式）"><NInput v-model:value="cron" :input-props="{'aria-label':'执行时间（Cron 表达式）'}" :disabled="busy" placeholder="0 9 * * *" /><template #label>执行时间（Cron 表达式）<InfoHint label="Cron 表达式格式">按“分 时 日 月 周”填写，例如每天09:00为 0 9 * * *。</InfoHint></template></NFormItem>
        <NFormItem label="使用时区"><NInput v-model:value="zone" :input-props="{'aria-label':'使用时区'}" :disabled="busy" placeholder="Asia/Shanghai" /><template #label>使用时区<InfoHint label="执行时区说明">例如 Asia/Shanghai（北京时间）。执行时间按此时区计算。</InfoHint></template></NFormItem>
        </div><NFormItem label="让员工做什么"><NInput v-model:value="description" :input-props="{'aria-label':'自动化任务执行内容'}" type="textarea" :maxlength="8000" :disabled="busy" placeholder="说明每次执行需要完成的工作和期望结果" /></NFormItem>
        <template v-if="policy==='business_key'"><NFormItem label="如何分组历史任务"><NSelect :virtual-scroll="false" v-model:value="keyMode" :options="[{label:'不分组，每次独立',value:'empty'},{label:'填写固定分组名称',value:'fixed'},{label:'按日历周期分组',value:'period'}]" :disabled="busy" aria-label="如何分组历史任务" /></NFormItem><NInput v-if="keyMode==='fixed'" v-model:value="keyValue" :input-props="{'aria-label':'历史任务分组名称'}" placeholder="相同名称的任务可以参考彼此历史" :disabled="busy" /><NSelect :virtual-scroll="false" v-if="keyMode==='period'" v-model:value="period" :options="[{label:'每分钟一组',value:'minute'},{label:'每小时一组',value:'hour'},{label:'每天一组',value:'day'},{label:'每周一组（周一开始）',value:'week'},{label:'每月一组',value:'month'},{label:'每年一组',value:'year'}]" :disabled="busy" aria-label="历史任务分组周期" /><p class="field-note">分组决定可以参考哪些已结束任务，不改变执行频率。</p></template>
        <NButton :disabled="busy" @click="checkPreview">预览下次执行时间</NButton><p v-if="preview" role="status">{{ preview }}</p><p class="field-note">服务停机时错过的计划不会补跑；已经受理的任务会继续恢复处理。</p>
      </template>
      <template v-else>
        <template v-if="kind==='github_issue'"><NFormItem label="GitHub 仓库 ID"><NInputNumber v-model:value="repositoryId" :min="1" :precision="0" :disabled="busy" aria-label="GitHub仓库ID" /></NFormItem><NFormItem label="GitHub 应用安装 ID（可选）"><NInputNumber v-model:value="installationId" :min="1" :precision="0" :disabled="busy" aria-label="GitHub安装ID" /></NFormItem><p class="field-note">只处理此仓库新建的 Issue，以标题和正文作为任务内容；不自动处理评论或关闭事件。</p></template>
        <template v-else><NFormItem label="允许外部系统做什么"><NCheckboxGroup v-model:value="actions" :disabled="busy"><NSpace><NCheckbox value="create_task">创建任务</NCheckbox><NCheckbox value="supplement_task">补充任务</NCheckbox><NCheckbox value="cancel_task">取消任务</NCheckbox></NSpace></NCheckboxGroup></NFormItem><p class="field-note">通过签名验证的请求提供任务内容；补充、取消仅限由此入口创建的任务。</p></template>
        <h4>{{ editId&&!draft?'更新签名密钥（留空保留原密钥）':'外部系统签名验证' }}</h4><p class="field-note">请与外部系统配置相同签名密钥，用于验证请求来源。密钥只写入，不回显。</p>
        <NFormItem label="密钥标识"><NInput v-model:value="keyId" :input-props="{'aria-label':'自动化任务密钥标识'}" :disabled="busy" /></NFormItem><NFormItem label="签名密钥（至少 32 字节）"><NInput v-model:value="secret" type="password" show-password-on="click" :input-props="{'aria-label':'自动化任务签名密钥'}" :disabled="busy" /></NFormItem>
        <details class="integration-details"><summary>给接入开发者的签名说明</summary><p class="field-note">Webhook 使用 X-Key-Id、X-Timestamp、X-Signature。GitHub 使用官方 X-Hub-Signature-256；请求必须使用 HTTPS（本地显式开发模式除外）。</p></details>
      </template>
      <GroupNotificationPicker :base="base" v-model:value="notificationTargets" :disabled="busy||disabled" :draft="draft" />
      <NSpace class="actions"><NButton :disabled="busy" @click="close">返回自动化任务列表</NButton><NButton attr-type="submit" type="primary" :disabled="busy||submitting" :loading="busy||submitting">{{ draft?'保存自动化任务草稿':'保存自动化任务' }}</NButton></NSpace>
    </NForm>
  </NDrawerContent></NDrawer>
  <NDrawer :show="events!==null" :width="'min(720px, 100vw)'" @update:show="v=>{if(!v)events=null}"><NDrawerContent title="自动化任务触发记录" closable><p class="field-note">已受理表示已接收请求，不代表任务已完成。任务与执行状态分别展示。</p><NEmpty v-if="!events?.length" description="还没有触发记录。启用后，符合条件的请求或计划将在这里显示。" /><div v-for="event in events" :key="String(event.id)" class="event-row"><p>{{ triggerActionLabel(event.action) }} · 请求{{ triggerStatusLabel(event.status) }} · 任务{{ event.task_status?triggerStatusLabel(event.task_status):'尚未创建' }} · 执行{{ event.run_status?triggerStatusLabel(event.run_status):'尚未开始' }}</p><p class="field-note">{{ new Date(Number(event.received_at)).toLocaleString() }}</p><div v-for="n in (event.notifications as {id:string;status:string;error?:string;label:string;provider:string;groupId:string;providerAccepted?:boolean;generationState?:string;deliveryState?:string}[]||[])" :key="n.id" class="field-note">{{ ({feishu:'飞书',dingtalk:'钉钉',wecom:'企微'} as Record<string,string>)[n.provider]||'渠道' }} · {{ n.label||n.groupId?.slice(-8) }} · 通知{{ n.status==='unknown'&&n.providerAccepted?'已提交渠道，送达待核对':notificationStatus(n) }}<span v-if="n.error">（{{ notificationFailure(n.error,n.generationState) }}）</span></div><details><summary>查看记录标识{{ event.error_code?'与错误原因':'' }}</summary><p>事件 ID：{{ event.event_id }}</p><p>任务 ID：{{ event.task_id||'尚未创建' }}</p><p v-if="event.error_code">错误代码：{{ event.error_code }}</p></details></div></NDrawerContent></NDrawer>
</section>
</template>
<style scoped>
.trigger-settings{display:grid;gap:16px;min-width:0}
.trigger-header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:16px 20px;background:var(--surface);border:1px solid var(--subtle);border-radius:12px}
.trigger-header h3{margin:0;font-size:16px;font-weight:600;line-height:24px;display:flex;align-items:center;gap:6px}
.trigger-header .field-note{margin:4px 0 0}
.trigger-history{padding:16px 20px;border:1px solid var(--subtle);border-radius:12px;background:var(--surface)}
.trigger-history-select{max-width:32rem}
.trigger-history .field-note{margin:6px 0 0}
.trigger-history :deep(.n-form-item){margin-bottom:0}
.trigger-card-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-bottom:12px;border-bottom:1px solid var(--subtle);font-size:15px}
.trigger-card-meta{margin:12px 0;padding:12px 14px;border-radius:8px;background:var(--id-bg-canvas,var(--background));border:1px solid var(--subtle)}
.trigger-card-meta p{margin:4px 0;font-size:13px;line-height:20px}
.trigger-card-meta span{color:var(--muted)}
.trigger-card-actions{display:flex;justify-content:flex-end;align-items:center;gap:8px;flex-wrap:wrap;margin-top:12px;padding-top:12px;border-top:1px solid var(--subtle)}
.trigger-editor>h4:first-child{margin-top:0}
.trigger-settings p{overflow-wrap:anywhere}
.endpoint{display:block;overflow-wrap:anywhere;margin:0.75rem 0;padding:8px 10px;border-radius:6px;background:var(--id-bg-sunken)}
.integration-details{margin:10px 0;font-size:12px;color:var(--muted)}
.integration-details summary{cursor:pointer;font-weight:500;color:var(--text)}
.actions{position:sticky;bottom:-16px;padding:1rem 0;background:var(--surface);border-top:1px solid var(--subtle);justify-content:flex-end}
.event-row{padding:0.75rem 0;border-bottom:1px solid var(--subtle)}
.event-row p{overflow-wrap:anywhere}
@media(max-width:36.25rem){.trigger-header{flex-wrap:wrap;align-items:flex-start}}
</style>
