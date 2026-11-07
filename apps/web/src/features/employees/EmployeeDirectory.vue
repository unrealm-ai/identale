<!-- Modified for Identale; see the root NOTICE. -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { NButton, NCard, NEmpty, NSkeleton, NInput } from 'naive-ui';
import EmployeeAvatar from '../../shared/ui/EmployeeAvatar.vue';
import {employeeRecommendation} from './employee-recommendation';
import PageHeader from '../../shared/ui/PageHeader.vue';
import type { Entity } from '../../shared/api';
import {providerLabel,type DirectoryProvider} from '../directory/types';
const props=defineProps<{ query?:string;hasMore?:boolean;entities: Entity[]; loaded: boolean; busy: boolean; canManage: boolean; canEdit: (entity: Entity) => boolean }>();
const emit = defineEmits<{ search:[string];more:[];refresh: []; create: []; chat: [entity: Entity]; settings: [entity: Entity];recentConversations:[] }>();
function providers(entity:Entity){return [...new Set(entity.channelProviders??[])].filter((value):value is DirectoryProvider=>['feishu','dingtalk','wecom'].includes(value));}
const filter=ref('all');
const needsAttention=(e:Entity)=>employeeRecommendation(e,props.canEdit(e)).blockers.length>0;
const filters=computed(()=>[{key:'all',label:'全部',count:props.entities.length},{key:'enabled',label:'已启用',count:props.entities.filter(e=>e.enabled===true).length},{key:'attention',label:'需关注',count:props.entities.filter(needsAttention).length},{key:'disabled',label:'已停用',count:props.entities.filter(e=>e.enabled===false).length}]);
const filtered=computed(()=>props.entities.filter(e=>filter.value==='all'||(filter.value==='attention'?needsAttention(e):filter.value==='enabled'?e.enabled===true:e.enabled===false)));
</script>
<template>
<section class="employee-directory">
 <PageHeader title="数字员工" description="每位数字员工都有明确的职责、工作入口和使用边界。选择一位，开始交付工作。"><NButton :disabled="busy" @click="emit('recentConversations')">最近对话</NButton><NButton :disabled="busy" @click="emit('refresh')">刷新</NButton><NButton v-if="canManage" type="primary" :disabled="busy" @click="emit('create')">创建数字员工</NButton></PageHeader>
 <div class="directory-main">
 <div class="directory-toolbar"><nav class="directory-filters" aria-label="当前列表状态筛选"><button v-for="item in filters" :key="item.key" type="button" :aria-pressed="filter===item.key" @click="filter=item.key">{{item.label}} <small>{{loaded?item.count:'—'}}</small></button></nav><NInput :value="query??''" :input-props="{'aria-label':'搜索数字员工'}" placeholder="搜索名称或职责" :loading="busy" clearable @update:value="value=>$emit('search',value)" class="employee-search"/></div>
 <NCard v-if="loaded&&!entities.length" class="empty-card"><NEmpty :description="query?'没有符合条件的数字员工':canManage?'创建你的第一位数字员工':'工作区还没有数字员工'"><template #extra><p class="muted">{{query?'试试其他名称或职责。':canManage?'填写职责、选择模型，就能开始试用。':'请联系有管理权限的成员。'}}</p><NButton v-if="canManage&&!query" type="primary" @click="emit('create')">创建第一位数字员工</NButton></template></NEmpty></NCard>
 <div v-else-if="!loaded" class="employee-grid" role="status"><NSkeleton v-for="n in 3" :key="n" height="240px"/><p class="muted">{{busy?'正在读取数字员工…':'暂时无法读取，请刷新重试。'}}</p></div>
 <NEmpty v-else-if="!filtered.length" description="当前筛选下没有员工"><template #extra><NButton @click="filter='all'">查看全部员工</NButton></template></NEmpty>
 <div v-else class="employee-grid">
  <article v-for="entity in filtered" :key="entity.id" class="employee-card" :class="{'is-disabled':entity.enabled===false}">
   <div class="employee-card-body">
    <div class="employee-card-heading"><EmployeeAvatar :name="entity.name" :preset="entity.avatarPreset" :identity-key="entity.id" size="directory"/><div class="employee-name"><h2>{{entity.name}} <span class="ai-label">AI</span></h2></div><span class="employee-enabled" :class="{'is-active':entity.enabled===true,'is-off':entity.enabled===false}">{{entity.enabled===false?'已停用':entity.enabled===true?'已启用':'状态未提供'}}</span></div>
    <p class="employee-description">{{entity.description||'尚未填写职责'}}</p>
    <div class="employee-resources"><span class="employee-channel-icons" :title="providers(entity).length?'已配置渠道，不代表在线状态':''"><span v-if="entity.canChat" class="web-channel" title="Web 对话">W</span><img v-for="provider in providers(entity)" :key="provider" :src="`/channel-logos/${provider}.png`" :alt="providerLabel(provider)" width="18" height="18"/><span v-if="!providers(entity).length&&!entity.canChat" class="field-note">{{entity.channelProviders?'未接入渠道':'渠道信息未提供'}}</span></span><span class="employee-package-count">{{typeof entity.packages==='number'?`${entity.packages} 个能力包`:'能力包信息未提供'}}</span></div>
   </div>
   <div class="employee-card-footer">
    <p class="employee-context" :class="{'is-attention':needsAttention(entity)}"><span aria-hidden="true">{{needsAttention(entity)?'•':'◇'}}</span> {{employeeRecommendation(entity,canEdit(entity)).blockers[0]||(entity.canChat?'你可以与该员工对话':'使用范围请查看员工配置')}}</p>
    <div class="employee-card-actions"><NButton v-if="entity.canChat===true||entity.enabled===false" size="small" :type="entity.canChat===true?'primary':'default'" @click="emit('chat',entity)">{{entity.enabled===false?'查看历史对话':'开始对话'}}</NButton><NButton size="small" secondary @click="emit('settings',entity)">{{canEdit(entity)?'管理':'查看员工'}}</NButton></div>
   </div>
  </article>
 </div><NButton v-if="hasMore" class="load-employees" :disabled="busy" @click="$emit('more')">加载更多员工</NButton>
 </div>
</section>
</template>
<style scoped>
.directory-main{min-width:0}
.directory-toolbar{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:20px;flex-wrap:wrap}
.directory-filters{display:flex;gap:4px;background:var(--id-bg-sunken);padding:4px;border-radius:8px;flex-wrap:wrap}
.directory-filters button{display:inline-flex;align-items:center;gap:6px;border:0;background:transparent;color:var(--muted);font:inherit;font-size:13px;font-weight:500;padding:6px 12px;border-radius:6px;cursor:pointer;transition:background var(--id-motion-fast,120ms),color var(--id-motion-fast,120ms)}
.directory-filters button:hover{color:var(--text)}
.directory-filters button[aria-pressed=true]{background:var(--surface);color:var(--text);box-shadow:var(--id-shadow-xs,0 1px 2px #0000000d)}
.directory-filters small{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
.directory-filters button[aria-pressed=true] small{color:var(--selectedText);font-weight:600}
.employee-search{width:260px;max-width:100%}
.employee-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px;--avatar-directory:44px}
.employee-card{min-width:0;border:1px solid var(--subtle);border-radius:12px;background:var(--surface);overflow:hidden;box-shadow:var(--id-shadow-xs,0 1px 2px #00000008);display:flex;flex-direction:column;transition:border-color var(--id-motion-normal,200ms),box-shadow var(--id-motion-normal,200ms)}
.employee-card:hover{border-color:var(--id-border-default,var(--border));box-shadow:var(--id-shadow-sm,0 2px 6px #00000010)}
.employee-card.is-disabled{opacity:.82}
.employee-card-body{padding:20px 20px 16px;flex:1;display:flex;flex-direction:column}
.employee-card-heading{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.employee-name{min-width:0;flex:1}
.employee-name h2{font-size:16px;line-height:24px;font-weight:600;margin:0;overflow-wrap:anywhere;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ai-label{font-size:11px;line-height:16px;font-weight:600;border-radius:4px;background:var(--tint);color:var(--selectedText);padding:1px 5px}
.employee-enabled{font-size:12px;line-height:18px;font-weight:500;padding:2px 8px;border-radius:999px;background:var(--id-bg-sunken);color:var(--muted);white-space:nowrap;flex-shrink:0}
.employee-enabled.is-active{background:var(--id-status-success-bg,var(--tint));color:var(--id-status-success-fg,var(--selectedText))}
.employee-enabled.is-off{background:var(--id-status-neutral-bg,var(--id-bg-sunken));color:var(--muted)}
.employee-description{min-height:44px;margin:0 0 16px;color:var(--muted);font-size:13px;line-height:22px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap}
.employee-resources{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-top:auto;padding-top:12px;border-top:1px solid var(--subtle);font-size:12px;color:var(--muted)}
.employee-channel-icons{display:inline-flex;gap:6px;align-items:center}
.employee-channel-icons img{object-fit:contain;border-radius:4px}
.employee-channel-icons .field-note{font-size:12px}
.web-channel{display:inline-grid;place-items:center;width:18px;height:18px;border-radius:4px;background:var(--id-bg-sunken);color:var(--text);font-size:11px;font-weight:700;border:1px solid var(--subtle)}
.employee-package-count{background:var(--id-bg-sunken);border-radius:6px;padding:2px 8px;font-variant-numeric:tabular-nums}
.employee-card-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 20px;background:var(--id-bg-canvas,var(--background));border-top:1px solid var(--subtle);flex-wrap:wrap}
.employee-context{margin:0;color:var(--muted);font-size:12px;line-height:18px;flex:1;min-width:140px}
.employee-context.is-attention{color:var(--id-status-warning-fg,var(--warning))}
.employee-card-actions{display:flex;align-items:center;gap:8px;margin-left:auto}
.load-employees{margin-top:20px}
.empty-card{padding:32px 16px}
@media(max-width:1200px){.employee-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:760px){.employee-grid{grid-template-columns:1fr}.employee-search{width:100%}.directory-filters{width:100%;justify-content:space-between}.employee-name h2{font-size:17px}}
</style>
