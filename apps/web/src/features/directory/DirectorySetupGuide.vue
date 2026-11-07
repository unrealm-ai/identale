<script setup lang="ts">
import { computed } from 'vue';
import { NAlert, NButton, NCard, NCollapse, NCollapseItem, NSpace } from 'naive-ui';
import type { DirectoryProvider } from './types';
import { directorySetupGuides } from './directory-setup-guide';

const props = defineProps<{ provider: DirectoryProvider }>();
const guide = computed(() => directorySetupGuides[props.provider]);
</script>

<template>
  <NCard :title="`${guide.title}员工应用连接指南`" size="small" class="directory-setup-guide" :aria-label="`${guide.title}员工应用连接指南`">
    <div class="guide-provider-heading">
      <p v-if="provider === 'wecom'">每个员工配置独立智能机器人；传统自建应用只负责目录，可在本员工页配置一次并由同 Workspace 后续员工复用。</p>
      <p v-else>为此员工创建独立应用和可 @ 的机器人，同时开通必要消息及通讯录读取权限。已有应用必须由此员工独占；之后可再连接另一个渠道。</p>
      <NButton tag="a" :href="guide.consoleUrl" target="_blank" rel="noopener noreferrer" size="small" type="primary" secondary :aria-label="`打开${guide.title}官方控制台（新窗口）`">打开官方控制台 ↗</NButton>
    </div>
    <NAlert v-if="provider !== 'wecom'" type="info" class="guide-note" title="同一应用，能力分别验证">同一应用的凭据用于机器人与通讯录。每位员工每个渠道最多连接一个机器人，通讯录不可用时请先补齐读取权限。</NAlert>
    <NAlert :type="provider === 'dingtalk' ? 'warning' : 'info'" class="guide-note" title="核对身份来源">{{ guide.identityNote }}</NAlert>
    <NCollapse :key="provider" :default-expanded-names="['create']">
      <NCollapseItem v-for="(step, index) in guide.steps" :key="step.id" :name="step.id" :title="`${index + 1}. ${step.title}`">
        <p class="guide-location">{{ step.location }}</p>
        <p v-for="paragraph in step.paragraphs" :key="paragraph">{{ paragraph }}</p>
        <NAlert v-for="note in step.notes" :key="note" type="warning" class="guide-note">{{ note }}</NAlert>
        <figure v-for="figure in step.figures" :key="figure.src" class="guide-figure">
          <img :src="figure.src" :alt="figure.alt" loading="lazy" />
          <figcaption>{{ figure.caption }}<span v-if="figure.source"> 来源：<a :href="figure.source.url" target="_blank" rel="noopener noreferrer">{{ figure.source.title }} ↗</a></span></figcaption>
          <NButton tag="a" :href="figure.src" target="_blank" rel="noopener noreferrer" size="small" quaternary :aria-label="`查看大图：${figure.alt}（新窗口）`">查看大图 ↗</NButton>
        </figure>
        <NSpace v-if="step.sources?.length" vertical size="small" class="guide-sources" aria-label="本步骤官方文档">
          <a v-for="source in step.sources" :key="source.url" :href="source.url" target="_blank" rel="noopener noreferrer">{{ source.title }} ↗</a>
        </NSpace>
      </NCollapseItem>
    </NCollapse>
    <div class="guide-footer">
      <p class="field-note">权限和菜单以当前企业控制台为准。按步骤完成配置后，请查看渠道的连接状态。</p>
      <p v-if="provider === 'dingtalk'" class="field-note">应用创建截图 © 2023 钉钉开放平台团队，按 <a href="/directory-guides/LICENSE.dingtalk.txt" target="_blank" rel="noopener noreferrer">MIT 许可</a>收录，不代表当前租户界面。</p>
    </div>
  </NCard>
</template>

<style scoped>
.directory-setup-guide { min-width: 0; }
.guide-provider-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 1.25rem; }
.guide-provider-heading p { margin: 0; color: var(--muted); line-height: 1.75; }
.guide-provider-heading > :last-child { flex-shrink: 0; }
.guide-note { margin: 1rem 0; }
.guide-location { color: var(--muted); font-size: 0.8125rem; background: var(--background); border-radius: 0.375rem; padding: 0.625rem 0.875rem; margin-top: 0.25rem; }
:deep(.n-collapse-item__content-inner) > p { line-height: 1.8; }
:deep(.n-collapse-item__header-main) { line-height: 1.65; }
.guide-figure { margin: 1.25rem 0 0.25rem; padding: 1rem; border: 1px solid var(--subtle); background: var(--background); border-radius: 0.625rem; }
.guide-figure img { display: block; max-width: 100%; width: auto; height: auto; max-height: 27.5rem; margin: 0 auto 0.75rem; object-fit: contain; }
.guide-figure figcaption { color: var(--muted); font-size: 0.75rem; line-height: 1.7; margin-bottom: 0.5rem; overflow-wrap: anywhere; }
.guide-sources { margin-top: 1rem; font-size: 0.8125rem; overflow-wrap: anywhere; }
.guide-figure a, .guide-sources a, .guide-footer a { color: var(--focus); text-underline-offset: 0.1875rem; }
.guide-footer { margin-top: 1.25rem; border-top: 1px solid var(--subtle); padding-top: 0.625rem; }
.guide-footer p { line-height: 1.75; }
@media (max-width: 36.25rem) { .guide-provider-heading { flex-direction: column; gap: 0.75rem; } .guide-figure { padding: 0.625rem; } .guide-figure img { max-height: none; width: 100%; } }
</style>
