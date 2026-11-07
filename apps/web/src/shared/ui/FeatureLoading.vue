<script setup lang="ts">
import { NSkeleton } from 'naive-ui';
</script>
<template><section role="status" aria-live="polite"><p class="muted">正在载入页面…</p><NSkeleton text :repeat="4" /></section></template>
