<script setup lang="ts">

import ChannelPermissionBlocks from './ChannelPermissionBlocks.vue';
import { NAlert, NTag } from 'naive-ui';
import type { ChannelCheck, ChannelValidation } from './channel-validation';
import {checkTone,checkLabel,checkCategory,tagTone} from './channel-validation-state';
defineProps<{ report: ChannelValidation }>();
const labels: Record<ChannelCheck['id'], string> = { scope_inventory: '应用权限清单', credentials: '应用凭据', bot_identity: '机器人身份', directory_identity: '目录应用 / 企业身份', directory_scope: '通讯录可见范围', department_read: '部门读取', user_name: '成员姓名读取', group_history: '群历史资源读取', meeting_materials: '会议材料资源读取' };
const reasons: Record<string, string> = {
  prerequisite: '前置检查未通过，尚未验证', authentication: '凭据认证失败，请核对当前应用的凭据', denied: '厂商明确拒绝访问；同时核对权限与数据范围',
  scope_denied:'本次应用权限清单明确显示相关权限未授权，尚未执行具体资源读取。',
  timeout: '请求超时，无法确认权限状态，可重试', network: '网络或厂商服务异常，无法确认权限状态', parse: '响应缺少必要字段或格式异常，无法确认读取能力',
  limit: '达到读取预算，未能完成验证', empty_scope: '当前可见范围为空，请配置需要授权的人员或部门', no_sample: '未取得可读样本，无法确认本项能力',
  scope_not_disclosed:'厂商未披露可用的授权入口，尚不能验证目录读取；这不代表没有权限或空组织',
  required_field: '响应未提供真实姓名，ID 标签不能代替姓名验证', resource_required: '尚未验证具体资源权限；需授权目标群或明确 Minutes 材料后才能读取',
  after_creation: '最终保存后按渠道核对真实入站身份', adapter_unsupported: '当前渠道接入不支持此能力，无需为此申请额外权限',
  inventory_unavailable: '当前未查询完整权限清单；是否可继续以必要身份、目录及姓名的实际读取结果为准',
};
</script>
<template>
  <section class="channel-validation-report" aria-label="渠道分层验证结果" aria-live="polite">
    <NAlert :type="report.canContinue ? 'success' : 'error'" :role="report.canContinue ? 'status' : 'alert'">{{ report.canContinue ? (report.provider==='wecom'?'机器人配置检查通过。凭据认证以创建后长连接结果为准。':'必要读取已通过。') : '必要检查尚未全部通过，请处理后重试。' }}</NAlert>
    <ul v-if="!report.canContinue" class="validation-issues"><li v-for="check in report.checks.filter(c=>c.required && c.status!=='pass')" :key="check.id"><strong>{{labels[check.id]}}</strong>：{{reasons[check.reason ?? 'prerequisite']}}</li></ul>
    <details class="validation-diagnostics"><summary>查看验证明细</summary><ChannelPermissionBlocks v-if="report.provider!=='wecom'" :provider="report.provider" :report="report"/>
    <div v-for="check in report.checks.filter(c=>report.provider!=='wecom'||['credentials','bot_identity'].includes(c.id))" :key="check.id" class="validation-check channel-status-block" :data-check="check.id" :data-tone="checkTone(check)">
      <div class="check-title"><strong>{{ labels[check.id] }}</strong><span>{{ checkCategory(check) }}</span><NTag size="small" :type="tagTone(checkTone(check))" :data-tone="checkTone(check)">{{ checkLabel(check) }}</NTag></div>
      <p v-if="check.status !== 'pass'">{{ reasons[check.reason ?? 'prerequisite'] }}</p>
      <p v-if="check.scopeDisclosure?.departments === false">部门入口未披露，仅使用厂商明确返回的授权入口验证，不补猜根部门。</p>
      <p v-if="check.scopeDisclosure?.users === false">直接用户入口未披露；可从明确授权的部门验证成员姓名，不代表没有可见用户。</p>
      <small v-if="check.field">字段 {{ check.field.path }} · 预期 {{ check.field.expected }} · 实际 {{ check.field.actualType }}{{ check.field.itemCount === undefined ? '' : ` · ${check.field.itemCount} 项` }}</small>
      <p v-if="check.id === 'group_history' && check.status !== 'pass' && check.supported">影响：无法保证补充群内未 @机器人的讨论上下文。</p>
      <p v-if="check.id === 'meeting_materials' && check.status !== 'pass' && check.supported">影响：无法保证读取会议逐字稿或现成纪要；不会自动生成或发现会议材料。</p>
      <p v-if="check.id === 'scope_inventory' && check.status === 'pass'">清单查询和解析通过，不表示列表内所有权限都已授予。</p>
      <p v-if="check.inventoryDiagnostics">共 {{ check.inventoryDiagnostics.totalRows }} 条记录，有 {{ check.inventoryDiagnostics.issueCount }} 处条目异常；其他明确的权限结果已保留。</p>
      <p v-if="check.missingScopes?.length">厂商明确返回的权限项：{{ check.missingScopes.join('、') }}</p>
      <details v-if="check.scopeInventory?.length"><summary>查看本次 API 返回的全部权限（区分身份）</summary><p v-for="(scope, index) in check.scopeInventory" :key="index">{{ scope.scope }} · {{ scope.identity === 'tenant' ? '应用身份' : scope.identity === 'user' ? '用户身份' : '身份类型未提供' }}：{{ scope.status === 'granted' ? '已授权' : scope.status === 'denied' ? '未授权' : '状态未能确认' }}</p></details>
      <small v-if="check.httpStatus || check.providerCode !== undefined || check.requestId">{{ check.httpStatus ? `HTTP ${check.httpStatus}` : '' }}{{ check.providerCode !== undefined ? ` · code ${check.providerCode}` : '' }}{{ check.requestId ? ` · request ${check.requestId}` : '' }}</small>
    </div>
    </details>
  </section>
</template>
<style scoped>
.validation-diagnostics{color:var(--muted)}.validation-diagnostics>summary{cursor:pointer;padding:.5rem 0}.validation-issues{padding-left:1.25rem;margin:0;line-height:1.6}.validation-check{margin-top:.75rem}.channel-validation-report { display: grid; gap: 0.75rem; margin-top: 0.875rem; }.check-title { display: flex; align-items: center; gap: 0.625rem; flex-wrap:wrap; }.check-title span { font-size: 0.75rem; color: var(--muted); }.validation-check p { margin: 0.4375rem 0 0; line-height: 1.65; color: var(--muted); overflow-wrap: anywhere; }.validation-check small { display: block; margin-top: 0.375rem; color: var(--muted); overflow-wrap: anywhere; }
</style>
