<!-- Modified for Identale; see the root NOTICE. -->
<script setup lang="ts">
import {triggerScopeLabel} from './trigger-types';
import {computed} from 'vue';
import {NButton,NCard,NCollapse,NCollapseItem,NEmpty,NSpace,NTag} from 'naive-ui';
import {conversationLabels,policyLabel,packageUserMode,resourceName,selectedResources,type PackageEditorValue,type NamedResource} from './capability-package-view';
import {memberNames} from './capability-package-view';
import type {ConfigMember} from '../../phase2';
type Row=PackageEditorValue&{key:string;version?:number};
const props=defineProps<{packages:Row[];triggerOptions?:import('./trigger-types').TriggerOption[];resources:NamedResource[];members?:ConfigMember[];disabled:boolean;draft?:boolean;readonly?:boolean}>();
const emit=defineEmits<{edit:[key:string];toggle:[key:string];remove:[key:string];create:[]}>();
const entries=computed(()=>props.packages.map(p=>({...p,skills:selectedResources(p.resourceIds,props.resources,'skill'),mcp:selectedResources(p.resourceIds,props.resources,'mcp'),execution:selectedResources(p.resourceIds,props.resources,'execution'),missing:p.resourceIds.filter(id=>!props.resources.some(r=>r.id===id))})));
</script>
<template><section class="capability-package-list" aria-label="能力包列表"><div class="package-list-heading"><div><h3>能力包 · {{ packages.length }}</h3><p class="field-note">每个包可包含多个Skill和MCP，使用范围独立，且不能超过员工整体范围。</p></div><NButton v-if="!readonly" type="primary" :disabled="disabled||packages.length>=50" @click="emit('create')">{{ draft?'新建能力包草稿':'新建能力包' }}</NButton></div>
 <NCard v-if="!packages.length" size="small"><NEmpty description="尚无能力包"><template #extra><p class="field-note">按需添加，空列表不会提供业务Skill或MCP。</p></template></NEmpty></NCard>
 <div v-else class="package-cards-grid">
  <NCard v-for="p in entries" :key="p.key" class="capability-package-card" size="small" :aria-label="`能力包 ${p.name||'未命名草稿'}`"><div class="package-card-heading"><div><h4>{{ p.name||'未命名草稿' }}</h4><p v-if="p.description" class="package-description">{{ p.description }}</p></div><NSpace align="center" :size="8"><NTag :type="p.enabled?'success':'default'" size="small">{{ p.enabled?'启用':'停用' }}</NTag><span v-if="p.version" class="field-note">v{{ p.version }}</span></NSpace></div>
   <div class="package-meta-panels">
    <div class="package-resource-summary"><p><strong>Skill · {{ p.skills.length }}</strong><span>{{ p.skills.map(resourceName).join('、')||'未选择' }}</span></p><p><strong>MCP · {{ p.mcp.length }}</strong><span>{{ p.mcp.map(resourceName).join('、')||'未选择' }}</span></p></div>
    <dl class="package-policy-summary"><div><dt>使用者</dt><dd>{{ policyLabel(p) }}</dd></div><div><dt>会话类型</dt><dd>{{ conversationLabels(p.conversationKinds) }}</dd></div><div><dt>自动化任务</dt><dd>{{ triggerScopeLabel(p.triggerUsageScope,triggerOptions) }}</dd></div></dl>
   </div>
   <p v-if="p.allowMemberIds.length&&(!p.userPolicyMode||packageUserMode(p)==='allowlist')" class="field-note">允许平台用户：{{ memberNames(p.allowMemberIds,members??[]).join('、') }}</p><p v-if="p.denyMemberIds.length&&(!p.userPolicyMode||packageUserMode(p)==='denylist')" class="field-note">拒绝平台用户：{{ memberNames(p.denyMemberIds,members??[]).join('、') }}</p><p v-if="p.directoryAccess.allow.length||p.directoryAccess.deny.length" class="field-note">渠道用户/部门：生效允许 {{ !p.userPolicyMode||p.userPolicyMode==='allowlist'?p.directoryAccess.allow.length:0 }} 项、生效拒绝 {{ !p.userPolicyMode||p.userPolicyMode==='denylist'?p.directoryAccess.deny.length:0 }} 项；每条规则仍可进一步收窄会话范围。</p>
   <NCollapse v-if="p.skills.length||p.mcp.length||p.execution.length||p.missing.length"><NCollapseItem title="查看资源明细" name="resources"><ul><li v-for="r in p.skills" :key="r.id">Skill · {{ resourceName(r) }} · {{ r.kind==='skill'?r.version:'' }}</li><li v-for="r in p.mcp" :key="r.id">MCP · {{ resourceName(r) }}<template v-if="r.kind==='mcp'"> · 获准工具：{{ r.allowedTools.join('、')||'无' }}</template></li><li v-for="r in p.execution" :key="r.id">执行工具 · {{ resourceName(r) }}<template v-if="r.kind==='execution'"> · {{ r.tools.join('、') }}</template></li><li v-for="id in p.missing" :key="id">资源暂不可用 · {{ id }}（原引用保留）</li></ul></NCollapseItem></NCollapse>
   <div v-if="!readonly" class="package-card-actions"><NButton size="small" :disabled="disabled" @click="emit('edit',p.key)">编辑 {{ p.name||'能力包' }}</NButton><NButton size="small" :disabled="disabled" @click="emit('toggle',p.key)">{{ p.enabled?'停用':'启用' }}</NButton><NButton v-if="draft" size="small" :disabled="disabled" @click="emit('remove',p.key)">移除草稿</NButton></div>
  </NCard>
 </div></section></template>
<style scoped>
.capability-package-list{display:grid;gap:16px}
.package-list-heading{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;padding:16px 20px;background:var(--surface);border:1px solid var(--subtle);border-radius:12px}
.package-list-heading .field-note{margin:4px 0 0}
.package-cards-grid{display:grid;gap:16px}
.package-card-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;padding-bottom:12px;border-bottom:1px solid var(--subtle)}
.package-card-actions{display:flex;justify-content:flex-end;align-items:center;gap:8px;flex-wrap:wrap;margin-top:14px;padding-top:12px;border-top:1px solid var(--subtle)}
h3,h4{margin:0;font-weight:600}
h3{font-size:16px;line-height:24px}
h4{font-size:15px;line-height:22px}
.package-description{margin:4px 0 0;color:var(--muted);font-size:13px;white-space:pre-wrap;overflow-wrap:anywhere}
.package-meta-panels{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin:14px 0;padding:12px 14px;border-radius:8px;background:var(--id-bg-canvas,var(--background));border:1px solid var(--subtle)}
.package-resource-summary,.package-policy-summary{display:grid;gap:8px;margin:0;align-content:start}
.package-resource-summary p,.package-policy-summary>div{margin:0;display:grid;grid-template-columns:5.5rem minmax(0,1fr);gap:8px;font-size:13px;line-height:20px}
.package-resource-summary strong,.package-policy-summary dt{color:var(--muted);font-weight:500}
.package-resource-summary span,.package-policy-summary dd{margin:0;color:var(--text);overflow-wrap:anywhere}
li{margin:6px 0;overflow-wrap:anywhere;font-size:13px}
@media(max-width:52rem){.package-meta-panels{grid-template-columns:1fr;gap:12px}}
@media(max-width:36.25rem){.package-resource-summary p,.package-policy-summary>div{grid-template-columns:1fr;gap:2px}.package-list-heading>.n-button{width:100%}}
</style>
