<script setup lang="ts">
import { ref } from 'vue';
import { NAlert, NButton, NCard, NCollapse, NCollapseItem, NSpace, NTabPane, NTabs, NTag } from 'naive-ui';
import PageHeader from '../../shared/ui/PageHeader.vue';
import { useAccessibleTabs, vAccessibleTablist } from '../../shared/ui/useAccessibleTabs';
import { setupGuides, setupChecks } from './setup-guides';
const emit = defineEmits<{ close: [] }>();
const provider = ref('feishu');
const { tabProps, panelProps } = useAccessibleTabs(provider, () => setupGuides.map(guide => guide.id), () => false);
</script>
<template>
<section class="channel-setup-guide" aria-label="渠道接入指南">
  <PageHeader title="渠道接入指南" eyebrow="CHANNEL SETUP" description="在工作台内查看步骤、权限和配图。实际创建、授权和发布仍在厂商控制台完成。"><NButton @click="emit('close')">返回数字员工</NButton></PageHeader>
  <NAlert type="info" title="先准备，再接线" class="guide-intro">
    这是接入准备指南，不是连接配置页。请在员工设置的渠道连接中保存应用凭据，使用飞书/企业微信 WebSocket 或钉钉 Stream 长连接；不需要平台公网域名或入站 URL，不提供自动 OAuth 安装。
    服务器负责维持长连接，无需保持本页打开。连接上线不等于使用授权已齐全；机器人身份、使用范围、Runtime 就绪和实际收发仍需分别验证。
  </NAlert>
  <NTabs v-accessible-tablist="'选择渠道平台'" v-model:value="provider" type="line" class="guide-tabs">
    <NTabPane v-for="guide in setupGuides" :key="guide.id" :name="guide.id" :tab="guide.title" :tab-props="tabProps(guide.id)" v-bind="panelProps(guide.id)" display-directive="if">
      <div class="guide-provider-heading"><div><h2>{{ guide.title }}应用机器人</h2><p class="muted">{{ guide.summary }}</p></div><NButton tag="a" :href="guide.consoleUrl" target="_blank" rel="noopener noreferrer" type="primary" secondary :aria-label="`打开${guide.title}官方控制台（新窗口）`">打开官方控制台 ↗</NButton></div>
      <NAlert type="warning" title="identity 当前接入边界" class="guide-current"><ul><li v-for="limitation in guide.currentLimitations" :key="limitation">{{ limitation }}</li></ul></NAlert>
      <p class="field-note">以下为厂商能力说明，不是 identity 当前连接的就绪状态。</p>
      <div class="guide-capability-grid"><NCard v-for="capability in guide.capabilities" :key="capability.title" :title="capability.title" size="small"><p>{{ capability.detail }}</p></NCard></div>
      <NCard title="配置步骤" class="guide-steps-card"><template #header-extra><NTag size="small" :bordered="false">只读指南</NTag></template>
        <NCollapse :default-expanded-names="['create']">
          <NCollapseItem v-for="(step, index) in guide.steps" :key="step.id" :name="step.id" :title="`${index + 1}. ${step.title}`">
            <p class="guide-location">{{ step.location }}</p>
            <p v-for="paragraph in step.paragraphs" :key="paragraph">{{ paragraph }}</p>
            <NAlert v-for="note in step.notes" :key="note" type="warning" class="guide-note">{{ note }}</NAlert>
            <figure v-for="figure in step.figures" :key="figure.src" class="guide-figure">
              <img :src="figure.src" :alt="figure.alt" loading="lazy" />
              <figcaption>{{ figure.caption }}<span v-if="figure.source"> 来源：<a :href="figure.source.url" target="_blank" rel="noopener noreferrer">{{ figure.source.title }} ↗</a></span></figcaption>
              <NButton tag="a" :href="figure.src" target="_blank" rel="noopener noreferrer" size="small" quaternary :aria-label="`查看大图：${figure.alt}（新窗口）`">查看大图 ↗</NButton>
            </figure>
          </NCollapseItem>
        </NCollapse>
      </NCard>
      <NCard title="接线完成后的验收清单" class="guide-checks-card"><p class="field-note">以下是部署维护者的核对事项，不是当前连接状态。本页不会执行测试、读取会议或发送群消息。</p><ol class="guide-checks"><li v-for="check in setupChecks" :key="check">{{ check }}</li></ol></NCard>
      <NCard title="常见问题" class="guide-faq-card" size="small"><NCollapse>
        <NCollapseItem title="为什么不能只复制一个 Webhook 地址？" name="webhook"><p>群自定义 Webhook 主要用于推送。数字员工需要收消息、识别来源、读取获准上下文及长期反馈，不能用推送地址代替应用身份和授权。</p></NCollapseItem>
        <NCollapseItem title="为什么能 @回复，却看不到刚才其他人的讨论？" name="context"><p>接收 @消息和读取普通群消息是不同能力。需要同时满足 adapter 实现、当前连接授权和目标群范围；缺少任一项都不能假装已有完整上下文。</p></NCollapseItem>
        <NCollapseItem title="配置完成就会自主参与群聊吗？" name="autonomy"><p>不会。渠道能力决定能收到什么，InteractionController 的策略决定何时唤起交互 agent 和安排输出。在员工设置中完成渠道连接、使用授权和 Runtime 配置后再核对实际收发；不要将“开放平台已配置”理解成“主动回复已启用”。</p></NCollapseItem>
        <NCollapseItem title="需要把密钥发给数字员工吗？" name="secrets"><p>不需要，也不应这样做。应用密钥与用户授权令牌由部署端的受控密钥管理保存，通过引用交给 adapter；不能放进人设、技能文本、聊天或截图。</p></NCollapseItem>
      </NCollapse></NCard>
      <div class="guide-sources"><p class="field-note">核对日期：2026-10-23。菜单、权限和租户开放范围可能调整。主要说明已内置，以下官方来源供复核。</p><NSpace vertical size="small"><a v-for="source in guide.sources" :key="source.url" :href="source.url" target="_blank" rel="noopener noreferrer">{{ source.title }} ↗</a></NSpace><p v-if="guide.id === 'dingtalk'" class="field-note">配置截图 © 2023 钉钉开放平台团队，按 <a href="/channel-guides/LICENSE.dingtalk.txt" target="_blank" rel="noopener noreferrer">MIT 许可</a>收录；图片为官方教程示例，不代表当前租户界面。</p></div>
    </NTabPane>
  </NTabs>
</section>
</template>
<style scoped>
.channel-setup-guide { min-width: 0; max-width: 70rem; }
.guide-intro { margin-bottom: 1.5rem; }
.guide-current { margin-bottom: 1.25rem; }
.guide-current ul { margin: 0; padding-left: 1.125rem; }
.guide-current li { margin: 0.25rem 0; line-height: 1.75; }
.guide-provider-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 1.5rem; margin: 0.75rem 0 1.5rem; }
.guide-provider-heading h2 { margin: 0 0 0.5rem; }
.guide-provider-heading p { margin: 0; max-width: 46.25rem; }
.guide-provider-heading > :last-child { flex-shrink: 0; }
.guide-capability-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
.guide-capability-grid p { margin: 0; color: var(--muted); font-size: 0.8125rem; }
.guide-steps-card, .guide-checks-card, .guide-faq-card { margin-bottom: 1.25rem; }
.guide-location { color: var(--muted); font-size: 0.8125rem; background: #f3f6f8; border-radius: 0.375rem; padding: 0.625rem 0.875rem; margin-top: 0.25rem; }
.guide-note { margin: 0.875rem 0; }
.guide-figure { margin: 1.25rem 0 0.25rem; padding: 1rem; border: 1px solid var(--subtle); background: #f8fafc; border-radius: 0.625rem; }
.guide-figure img { display: block; max-width: 100%; width: auto; height: auto; max-height: 27.5rem; margin: 0 auto 0.75rem; object-fit: contain; }
.guide-figure figcaption { color: var(--muted); font-size: 0.75rem; line-height: 1.7; margin-bottom: 0.5rem; overflow-wrap: anywhere; }
.guide-figure a, .guide-sources a { color: #167060; text-underline-offset: 0.1875rem; }
.guide-checks { padding-left: 1.375rem; margin-bottom: 0; }
.guide-checks li { margin: 0.625rem 0; line-height: 1.75; }
.guide-sources { padding: 0.25rem 0 0.75rem; font-size: 0.75rem; overflow-wrap: anywhere; }
:deep(.n-collapse-item__header-main) { line-height: 1.65; }
@media (max-width: 56.25rem) { .guide-capability-grid { grid-template-columns: 1fr; gap: 0.625rem; } }
@media (max-width: 36.25rem) { .guide-provider-heading { flex-direction: column; gap: 1rem; } .guide-figure { padding: 0.625rem; } .guide-figure img { max-height: none; width: 100%; } }
</style>
