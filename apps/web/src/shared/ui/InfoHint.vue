<script setup lang="ts">
import { computed, ref, useId, onBeforeUnmount } from 'vue';
import { NPopover } from 'naive-ui';
defineProps<{ label: string }>();
const tooltipId=useId();
const hovered=ref(false),focused=ref(false),pinned=ref(false),dismissed=ref(false);
const show=computed(()=>!dismissed.value&&(hovered.value||focused.value||pinned.value));
let leaveTimer:ReturnType<typeof setTimeout>|undefined;
function enter(){if(leaveTimer)clearTimeout(leaveTimer);hovered.value=true;dismissed.value=false;}
function leave(){if(leaveTimer)clearTimeout(leaveTimer);leaveTimer=setTimeout(()=>hovered.value=false,120);}
onBeforeUnmount(()=>{if(leaveTimer)clearTimeout(leaveTimer);});
function close(){pinned.value=false;dismissed.value=true;}
function toggle(){if(pinned.value)close();else{pinned.value=true;dismissed.value=false;}}
</script>
<template>
  <NPopover trigger="manual" :show="show" placement="bottom-start" :show-arrow="false" :style="{maxWidth:'min(20rem, calc(100vw - 2rem))'}" @clickoutside="close" @esc="close">
    <template #trigger><button type="button" class="info-hint" :aria-label="label" :aria-expanded="show" :aria-describedby="show?tooltipId:undefined" @mouseenter="enter" @mouseleave="leave" @focus="focused=true;dismissed=false" @blur="focused=false;pinned=false" @click="toggle" @keydown.esc.stop="close"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="7.5"/><path d="M10 9v5M10 6v.5"/></svg></button></template>
    <div class="info-hint-content" role="tooltip" :id="tooltipId" @mouseenter="enter" @mouseleave="leave"><slot/></div>
  </NPopover>
</template>
<style scoped>
.info-hint{display:inline-grid;place-items:center;flex:none;vertical-align:middle;width:2rem;height:2rem;padding:.375rem;border:0;border-radius:50%;background:transparent;color:var(--muted);cursor:pointer}.info-hint:hover{background:var(--hoverTint);color:var(--text)}.info-hint svg{width:1.125rem;height:1.125rem;stroke:currentColor;stroke-width:1.5;stroke-linecap:round}.info-hint-content{font-size:.875rem;line-height:1.6;overflow-wrap:anywhere}.info-hint-content :deep(p){margin:.25rem 0}@media(max-width:47.5rem){.info-hint{width:2.75rem;height:2.75rem}}
</style>
