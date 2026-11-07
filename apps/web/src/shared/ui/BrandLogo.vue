<script setup lang="ts">
/** Swap point for the product mark. Files live in public/brand and mirror docs/design/logo/. */
const brandAssets = {
  mark: '/brand/mark.svg',
  markDark: '/brand/mark-dark.svg',
  markSmall: '/brand/mark-small.svg',
  markMono: '/brand/mark-mono.svg',
  lockup: '/brand/lockup-horizontal.svg',
  lockupDark: '/brand/lockup-horizontal-dark.svg',
  wordmark: '/brand/wordmark.svg',
  wordmarkDark: '/brand/wordmark-dark.svg',
};
withDefaults(defineProps<{ compact?: boolean; inverse?: boolean; monochrome?: boolean; lockup?: boolean }>(), { compact: false, inverse: false, monochrome: false, lockup: false });
</script>
<template>
  <span class="brand-logo" :class="{ 'brand-logo--compact': compact, 'brand-logo--inverse': inverse, 'brand-logo--color': !inverse && !monochrome && !lockup, 'brand-logo--lockup': lockup }" role="img" aria-label="identale">
    <img v-if="lockup" class="brand-logo-default" :src="brandAssets.lockup" alt="" aria-hidden="true" />
    <img v-if="lockup" class="brand-logo-dark" :src="brandAssets.lockupDark" alt="" aria-hidden="true" />
    <img v-else-if="compact" :src="inverse ? brandAssets.markDark : brandAssets.markSmall" alt="" aria-hidden="true" />
    <img v-else-if="monochrome" :src="brandAssets.markMono" alt="" aria-hidden="true" />
    <img v-else-if="inverse" :src="brandAssets.markDark" alt="" aria-hidden="true" />
    <template v-else>
      <img class="brand-logo-default" :src="brandAssets.mark" alt="" aria-hidden="true" />
      <img class="brand-logo-dark" :src="brandAssets.markDark" alt="" aria-hidden="true" />
    </template>
    <img v-if="!compact && !lockup && !inverse" class="brand-logo-wordmark brand-logo-wordmark-default" :src="brandAssets.wordmark" alt="" aria-hidden="true" />
    <img v-if="!compact && !lockup && !monochrome" class="brand-logo-wordmark brand-logo-wordmark-dark" :src="brandAssets.wordmarkDark" alt="" aria-hidden="true" />
  </span>
</template>
<style scoped>
.brand-logo{display:inline-flex;align-items:center;gap:.625rem;max-width:100%;color:var(--id-text-primary,#1A1D1F);line-height:1;vertical-align:middle}
.brand-logo img{display:block;width:2rem;height:2rem;flex-shrink:0;object-fit:contain}
.brand-logo--lockup img{width:auto;height:2rem;max-width:12rem}
.brand-logo-wordmark{width:auto;height:1.25rem}
.brand-logo--inverse{color:#fff}
.brand-logo--compact{gap:0}
.brand-logo--compact img{width:24px;height:24px}
.brand-logo .brand-logo-dark,.brand-logo .brand-logo-wordmark-dark{display:none}
.brand-logo--inverse .brand-logo-wordmark-dark{display:block}
:global([data-theme="dark"] .brand-logo--color .brand-logo-default),
:global([data-theme="dark"] .brand-logo--lockup .brand-logo-default),
:global([data-theme="dark"] .brand-logo--color .brand-logo-wordmark-default){display:none}
:global([data-theme="dark"] .brand-logo--color .brand-logo-dark),
:global([data-theme="dark"] .brand-logo--lockup .brand-logo-dark),
:global([data-theme="dark"] .brand-logo--color .brand-logo-wordmark-dark){display:block}
</style>
