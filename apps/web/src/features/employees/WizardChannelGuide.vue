<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';
import { NAlert, NButton, NCard } from 'naive-ui';
import type { DirectoryProvider } from '../directory/types';
import ChannelPermissionBlocks from './ChannelPermissionBlocks.vue';
import type { ChannelValidation } from './channel-validation';
import { wizardChannelGuides } from './wizard-channel-guides';
const props = defineProps<{ provider: DirectoryProvider; ready: boolean; busy: boolean; skipped: boolean; locked: boolean; editing?: boolean; report?: ChannelValidation | null }>();
const guide = computed(() => wizardChannelGuides[props.provider]);
const current = ref(props.editing ? guide.value.steps.findIndex(item => item.id === 'credentials') : 0), root = ref<HTMLElement | null>(null);
const prefix = `channel-steps-${useId()}`;
async function go(index: number, focusDot = false) {
  if (props.locked || index < 0 || index >= guide.value.steps.length) return;
  current.value = index;
  if (focusDot) { await nextTick(); root.value?.querySelector<HTMLElement>(`.channel-guide-dots button[data-index="${index}"]`)?.focus({ preventScroll: true }); }
}
function keys(event: KeyboardEvent) {
  const target = event.target as HTMLElement;
  if (props.locked || target.closest('input, textarea, .n-select')) return;
  let index: number | undefined;
  if (event.key === 'ArrowRight') index = (current.value + 1) % guide.value.steps.length;
  else if (event.key === 'ArrowLeft') index = (current.value + guide.value.steps.length - 1) % guide.value.steps.length;
  else if (event.key === 'Home') index = 0;
  else if (event.key === 'End') index = guide.value.steps.length - 1;
  if (index !== undefined) { event.preventDefault(); event.stopPropagation(); void go(index, true); }
}
let pointer: { x: number; y: number } | undefined;
function pointerDown(event: PointerEvent) { if (props.locked || (event.target as HTMLElement).closest('input, textarea, button, a, [role="combobox"], .n-select')) return; pointer = { x: event.clientX, y: event.clientY }; }
function pointerUp(event: PointerEvent) {
  if (!pointer) return; const dx = event.clientX - pointer.x, dy = event.clientY - pointer.y; pointer = undefined;
  if (Math.abs(dx) < 60 || Math.abs(dx) <= Math.abs(dy)) return;
  // Browsing is free; the main wizard still validates fields and short-lived receipts before commit.
  void go(current.value + (dx < 0 ? 1 : -1));
}
watch(() => props.provider, () => { current.value = props.editing ? guide.value.steps.findIndex(item => item.id === 'credentials') : 0; pointer = undefined; });

</script>
<template>
<NCard class="wizard-channel-guide" size="small" :title="`${guide.title}接入步骤`" :aria-label="`${guide.title}接入步骤与凭据`">
  <NAlert v-if="editing" type="info">编辑当前员工：验证通过后保存当前员工配置；首次创建在最后确认时统一保存。</NAlert>
  <div class="official-entry"><p>按圆点切换步骤，表单保留，不自动播放。</p><NButton tag="a" :href="guide.consoleUrl" target="_blank" rel="noopener noreferrer" secondary type="primary" :aria-label="`打开${guide.title}官方控制台（新窗口）`">打开官方控制台 ↗</NButton></div>

  <div class="step-viewport" role="region" aria-roledescription="轮播式步骤" :aria-label="`${guide.title}接入子步骤，无自动播放，可左右切换`" tabindex="0" @keydown="keys" @pointerdown="pointerDown" @pointerup="pointerUp" @pointercancel="pointer = undefined">
    <div class="step-track" :style="{ transform: `translateX(-${current * 100}%)` }">
      <section v-for="(item, index) in guide.steps" :id="`${prefix}-${index}`" :key="item.id" class="slide" :class="{ 'is-current': current === index }" :inert="current !== index" :aria-hidden="current !== index" role="tabpanel" :aria-labelledby="`${prefix}-dot-${index}`">
        <h3 :id="`${prefix}-heading-${index}`" tabindex="-1">{{ index + 1 }}. {{ item.title }}</h3>
        <p class="guide-location">{{ item.location }}</p>
        <p v-for="paragraph in item.paragraphs" :key="paragraph">{{ paragraph }}</p>
        <NButton v-if="item.action" tag="a" :href="item.action.url" target="_blank" rel="noopener noreferrer" secondary>{{ item.action.title }} ↗</NButton>
        <div v-if="item.id === 'directory'" class="credential-fields"><slot name="directory" /></div>
        <div v-if="item.id === 'credentials'" class="credential-fields"><slot name="credentials" /></div>
        <ChannelPermissionBlocks v-if="item.id === 'validate' && !report" :provider="provider" />
        <div v-if="item.id === 'validate'" class="credential-fields"><slot name="validation" /></div>
        <figure v-for="figure in item.figures" :key="figure.src" class="guide-figure">
          <img :src="figure.src" :alt="figure.alt" loading="lazy" />
          <figcaption>{{ figure.caption }}</figcaption>
          <NButton tag="a" :href="figure.src" target="_blank" rel="noopener noreferrer" size="small" quaternary :aria-label="`查看大图：${figure.alt}（新窗口）`">查看大图 ↗</NButton>
        </figure>
        <details v-if="item.compatibility" class="ordinary-application-guide"><summary>已有普通应用 / 没有智能体创建入口？展开兼容配置</summary><section v-for="step in item.compatibility" :key="step.title"><h4>{{ step.title }}</h4><p v-for="paragraph in step.paragraphs" :key="paragraph">{{ paragraph }}</p></section></details>
      </section>
    </div>
  </div>
  <div ref="root" class="carousel-navigation" @keydown="keys"><p role="status" aria-live="polite">第 {{ current + 1 }} / {{ guide.steps.length }} 张{{ skipped ? ' · 已明确跳过渠道连接' : '' }}</p>
    <div class="channel-guide-dots" role="tablist" :aria-label="`${guide.title}接入说明卡片`"><button v-for="(item, index) in guide.steps" :id="`${prefix}-dot-${index}`" :key="item.id" type="button" role="tab" class="guide-dot" :class="{ 'is-current': current === index }" :data-index="index" :data-step="item.id" :aria-label="`第${index + 1}张：${item.title}`" :aria-selected="current === index" :aria-controls="`${prefix}-${index}`" :tabindex="current === index ? 0 : -1" :disabled="locked" @click="go(index)"><span aria-hidden="true" /></button></div>
  </div>
  <p class="field-note guide-provenance">说明核对于 2026-10-24；图片为本地静态资源，示意图不代表当前验证结果。</p>
</NCard>
</template>
<style scoped>
.wizard-channel-guide { min-width: 0; }.official-entry { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 1rem; }.official-entry p { margin: 0; line-height: 1.7; }.official-entry > :last-child { flex-shrink: 0; }.step-viewport { overflow: hidden; touch-action: pan-y; outline-offset: 0.25rem; }.step-track { display: flex; align-items: flex-start; transition: transform 180ms ease; }.slide { flex: 0 0 100%; min-width: 0; box-sizing: border-box; height: 0; overflow: hidden; visibility: hidden; }.slide.is-current { height: auto; visibility: visible; }.slide h3 { margin: 0.5rem 0 1rem; outline-offset: 0.25rem; }.slide > p { line-height: 1.8; }.guide-location { padding: 0.625rem 0.75rem; background: #f3f6f8; border-radius: 0.375rem; color: var(--muted); font-size: 0.8125rem; }.guide-figure { margin: 1rem 0; padding: 0.75rem; border: 1px solid var(--subtle); border-radius: 0.5rem; background: #f8fafc; }.guide-figure img { display: block; max-width: 100%; width: auto; height: auto; max-height: 21.875rem; margin: 0 auto 0.75rem; object-fit: contain; }.guide-figure figcaption { font-size: 0.75rem; line-height: 1.7; color: var(--muted); overflow-wrap: anywhere; }.guide-sources { font-size: 0.8125rem; margin-top: 0.75rem; overflow-wrap: anywhere; }.credential-fields { margin-top: 1.25rem; }.carousel-navigation { display: grid; justify-items: center; gap: 0.25rem; margin-top: 1rem; }.carousel-navigation p { margin: 0; color: var(--muted); font-size: 0.8125rem; }.channel-guide-dots { display: flex; justify-content: center; gap: 0.375rem; }.guide-dot { display: grid; place-items: center; width: 2.125rem; height: 2.125rem; padding: 0; border: 0; background: transparent; cursor: pointer; }.guide-dot span { display: block; width: 0.625rem; height: 0.625rem; border-radius: 0.5rem; background: #b7c7c2; transition: width 160ms ease; }.guide-dot.is-current span { width: 1.5rem; background: #167060; }.guide-dot:focus-visible { outline: 2px solid #167060; outline-offset: 2px; border-radius: 0.375rem; }.guide-provenance { border-top: 1px solid var(--subtle); margin-top: 1.25rem; padding-top: 0.75rem; line-height: 1.75; }a { color: #167060; text-underline-offset: 0.1875rem; }@media (prefers-reduced-motion: reduce) { .step-track { transition: none; } }@media (max-width: 36.25rem) { .official-entry { flex-direction: column; align-items: flex-start; }.guide-figure { padding: 0.5rem; }.guide-figure img { width: 100%; max-height: none; } }
</style>
