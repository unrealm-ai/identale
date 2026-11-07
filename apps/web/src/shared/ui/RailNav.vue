<script setup lang="ts">
defineProps<{ items: { key: string; label: string; paths: string[] }[]; locked: boolean; current: string; href: (key: string) => string; layout?: 'rail' | 'drawer' }>();
const emit = defineEmits<{ select: [key: string, event: MouseEvent] }>();
</script>
<template>
  <nav class="rail-nav" :class="{ 'rail-nav--drawer': layout === 'drawer' }" aria-label="主导航项">
    <component :is="locked ? 'span' : 'a'" v-for="item in items" :key="item.key" class="nav-link" role="menuitem" :aria-disabled="locked ? 'true' : undefined" :aria-current="current === item.key ? 'page' : undefined" :href="locked ? undefined : href(item.key)" @click="emit('select', item.key, $event)">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path v-for="(d, index) in item.paths" :key="index" :d="d" /></svg><span class="nav-label">{{ item.label }}</span>
    </component>
  </nav>
</template>
<style scoped>
.rail-nav{display:flex;flex-direction:column;align-items:center;gap:4px;width:100%;min-width:0}
.nav-link{width:56px;height:54px;border-radius:12px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;color:var(--id-text-on-rail,#C9D6D9);text-decoration:none;font-size:11px;line-height:14px;position:relative;cursor:pointer}
.nav-link[aria-current="page"]{color:var(--id-text-on-rail-active,#fff);background:rgb(59 189 155 / 16%)}
.nav-link[aria-current="page"]::before{content:"";position:absolute;left:-8px;top:14px;bottom:14px;width:3px;border-radius:2px;background:var(--id-brand-400,#3BBD9B)}
.nav-link[aria-disabled="true"]{cursor:default;opacity:.55}
.nav-label{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rail-nav--drawer{align-items:stretch;gap:2px}
.rail-nav--drawer .nav-link{width:100%;height:44px;flex-direction:row;justify-content:flex-start;gap:10px;padding:0 12px;color:var(--id-text-primary,#182024);font-size:14px}
.rail-nav--drawer .nav-link[aria-current="page"]{color:var(--id-brand-text,#0B6A55);background:var(--id-bg-selected,#EAF8F3)}
.rail-nav--drawer .nav-link[aria-current="page"]::before{left:0;top:10px;bottom:10px}
</style>
