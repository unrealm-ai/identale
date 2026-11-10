<!-- Modified for Identale; see the root NOTICE. -->
<script setup lang="ts">
import { computed, onErrorCaptured, ref, watch } from 'vue';
import { NQrCode } from 'naive-ui';
const props = defineProps<{ value: string }>();
const failed = ref(false);
// Reserve a margin below QR byte-mode M capacity; increase the rendered size
// for longer official links before falling back to a full, unchanged link.
// Preserve the full official URL; use its link rather than truncate application data.
const tooDense = computed(() => new TextEncoder().encode(props.value).length > 2200);
const size = computed(() => props.value.length > 1200 ? 320 : props.value.length > 500 ? 256 : 192);
watch(() => props.value, () => { failed.value = false; });
onErrorCaptured(() => { failed.value = true; return false; });
</script>
<template>
  <div v-if="failed || tooDense" class="qr-fallback" role="status">{{ tooDense ? '确认链接较长，二维码可能难以扫描。' : '二维码生成失败。' }}<br/>请使用旁边的官方确认链接继续，应用资料保持完整。</div>
  <NQrCode v-else :value="value" :size="size" error-correction-level="M"/>
</template>
<style scoped>
.qr-fallback{width:192px;min-height:192px;box-sizing:border-box;display:flex;flex-direction:column;justify-content:center;padding:18px;color:#536481;font-size:13px;line-height:1.7;text-align:center}
</style>
