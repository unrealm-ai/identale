<script setup lang="ts">
import { providerLabel, type DirectoryProvider } from '../directory/types';
defineProps<{ provider: DirectoryProvider }>();
</script>
<template><span class="provider-label"><img :src="`/channel-logos/${provider}.png`" alt="" aria-hidden="true" width="24" height="24" />{{ providerLabel(provider) }}</span></template>
<style scoped>.provider-label{display:inline-flex;align-items:center;gap:0.5rem}.provider-label img{object-fit:contain;flex:none}</style>
