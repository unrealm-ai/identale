<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { NAlert, NButton, NSpace } from 'naive-ui';
import { beginWeComRegistration, type WeComRegistrationCredentials, type WeComRegistrationStatus } from './wecom-registration';

const props = defineProps<{ context: string; disabled?: boolean; employeeName?: string; existingBinding?: boolean }>();
const emit = defineEmits<{ credentials: [WeComRegistrationCredentials]; busyChanged: [boolean] }>();
const copyNotice = ref('');
async function copyName() { try { await navigator.clipboard.writeText(props.employeeName ?? ''); copyNotice.value = '名称已复制'; } catch { copyNotice.value = '无法复制，请手动选取名称'; } }
const status = ref<WeComRegistrationStatus | null>(null);
const pending = computed(() => status.value === 'waiting' || status.value === 'ready');
let attempt: ReturnType<typeof beginWeComRegistration> | undefined;
let generation = 0;
watch(pending, value => emit('busyChanged', value), { flush: 'sync' });
function cancel() {
  generation++;
  attempt?.cancel();
  attempt = undefined;
  if (pending.value) status.value = 'cancelled';
}
function start() {
  if (props.disabled || pending.value) return;
  const current = ++generation;
  const context = props.context;
  attempt = beginWeComRegistration({
    host: window,
    onStatus(value) { if (current === generation && context === props.context) status.value = value; },
    onCredentials(value) {
      if (current === generation && context === props.context && !props.disabled) emit('credentials', value);
    },
  });
}
watch(() => props.context, () => { cancel(); status.value = null; });
watch(() => props.disabled, value => { if (value && pending.value) cancel(); });
onUnmounted(() => { cancel(); emit('busyChanged', false); });
</script>
<template>
  <section class="wecom-registration" aria-label="扫码创建企微机器人">
    <p class="field-note">在企业微信官方窗口扫码创建机器人。{{existingBinding ? '收到凭据后，请核对并确认换绑。' : '完成后自动保存并开始连接。'}}</p>
    <p v-if="employeeName" class="field-note">机器人名称：{{employeeName}} <NButton size="tiny" quaternary @click="copyName">复制名称</NButton>。请在企微创建页填写。<span role="status">{{copyNotice}}</span></p>
    <NSpace>
      <NButton type="primary" secondary :disabled="disabled || pending" @click="start">扫码创建机器人</NButton>
      <NButton v-if="pending" @click="cancel">取消扫码</NButton>
    </NSpace>
    <NAlert v-if="pending" type="info" role="status">请在企业微信官方窗口完成扫码。这里最多等待 5 分钟。取消只停止接收结果，不会删除已在企微创建的机器人。</NAlert>
    <NAlert v-else-if="status === 'received'" type="success" role="status">{{existingBinding ? '已收到机器人凭据，请在下方核对并确认保存；原绑定尚未变更。' : '已收到机器人凭据，正在处理保存。保存和长连接状态以页面结果为准。'}}</NAlert>
    <NAlert v-else-if="status === 'blocked'" type="warning" role="alert">弹窗被浏览器拦截。请允许本站弹窗后重试，或手动填写凭据。</NAlert>
    <NAlert v-else-if="status === 'expired'" type="warning" role="alert">扫码等待已超时，旧窗口的结果不再接收。若已创建机器人，请到企微后台取得凭据并手动填写。</NAlert>
    <NAlert v-else-if="status === 'failed'" type="warning" role="alert">未能安全取得机器人凭据。请检查企微窗口提示，或手动填写 BotID 和 Secret；不会自动重复创建。</NAlert>
    <NAlert v-else-if="status === 'cancelled'" type="info" role="status">已停止接收扫码结果，可以手动填写。若已在企微创建机器人，取消不会删除它。</NAlert>
  </section>
</template>
<style scoped>.wecom-registration{display:grid;gap:12px;min-width:0}.wecom-registration p{margin:0}</style>
