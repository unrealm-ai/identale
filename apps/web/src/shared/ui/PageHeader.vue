<script setup lang="ts">
withDefaults(defineProps<{ title: string; description?: string; eyebrow?: string; titleId?: string; level?: 1 | 2 }>(), { level: 1 });
</script>
<template><header class="page-heading"><div class="page-heading-identity"><slot name="leading"/><div class="page-heading-copy"><p v-if="eyebrow" class="eyebrow">{{ eyebrow }}</p><component :is="level===2?'h2':'h1'" :id="titleId">{{ title }}</component><p v-if="description" class="muted">{{ description }}</p><slot name="meta"/></div></div><div v-if="$slots.default" class="page-actions"><slot /></div></header></template>
<style scoped>
.page-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:1.5rem;margin-bottom:1.25rem;min-width:0;flex-wrap:wrap}.page-heading-identity{display:flex;align-items:flex-start;gap:.75rem;min-width:0;flex:1}.page-heading-copy{min-width:0}.page-heading h1,.page-heading h2{margin:0 0 .375rem}.page-heading p{margin:0}.page-heading .eyebrow{margin-bottom:.4375rem}.page-actions{display:flex;flex-wrap:wrap;gap:.75rem;max-width:100%}@media(max-width:47.5rem){.page-heading{gap:1rem;margin-bottom:1rem}.page-actions{width:100%}}
</style>
