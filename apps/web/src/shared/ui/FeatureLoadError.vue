<script setup lang="ts">
import { NAlert, NButton } from 'naive-ui';
function reload() { window.location.reload(); }
</script>
<template><NAlert type="error" title="页面资源未能载入" role="alert">请检查网络后重新加载。页面尚未开始新的业务操作。<p><NButton @click="reload">重新加载页面</NButton></p></NAlert></template>
