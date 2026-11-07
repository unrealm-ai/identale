<script setup lang="ts">
import { computed } from 'vue';
import type { DirectoryProvider } from '../directory/types';
import { setupGuides, setupChecks } from '../channels/setup-guides';
const props = defineProps<{ provider: DirectoryProvider }>();
const guide = computed(() => setupGuides.find(item => item.id === props.provider)!);
</script>
<template>
<details class="channel-guide-details"><summary>更多说明：手动配置、能力边界、排错与验收</summary>
  <p>以下是兼容配置与部署核对说明；优先使用上方最新三卡。不会执行测试或发送消息，不能将说明当作当前连接状态。</p>
  <ul><li v-for="item in guide.currentLimitations" :key="item">{{ item }}</li></ul>
  <section v-for="item in guide.capabilities" :key="item.title"><h4>{{ item.title }}</h4><p>{{ item.detail }}</p></section>
  <details v-for="step in guide.steps" :key="step.id"><summary>{{ step.title }}（手动兼容路径）</summary><p>{{ step.location }}</p><p v-for="paragraph in step.paragraphs" :key="paragraph">{{ paragraph }}</p><p v-for="note in step.notes" :key="note">{{ note }}</p><figure v-for="figure in step.figures" :key="figure.src"><img :src="figure.src" :alt="figure.alt" loading="lazy" /><figcaption>{{ figure.caption }}<a v-if="figure.source" :href="figure.source.url" target="_blank" rel="noopener noreferrer">{{ figure.source.title }} ↗</a></figcaption><a :href="figure.src" target="_blank" rel="noopener noreferrer">查看大图 ↗</a></figure></details>
  <h4>接入后验收</h4><ol><li v-for="check in setupChecks" :key="check">{{ check }}</li></ol>
  <h4>常见问题</h4><details><summary>为什么不能只复制 Webhook？</summary><p>群自定义 Webhook 主要用于推送，不能代替应用身份、收消息、来源识别与授权。</p></details><details><summary>为什么能 @回复，却看不到其他讨论？</summary><p>接收 @消息与读取普通群消息是不同能力，必须同时满足 adapter 实现、当前连接权限和目标群范围。</p></details><details><summary>配置完成就会自主参与群聊吗？</summary><p>不会。渠道能力决定能接收什么，InteractionController 策略决定何时唤起与输出。身份、授权、Runtime 和真实收发分别检查。</p></details><details><summary>需要把密钥发给数字员工吗？</summary><p>不需要。密钥仅在专用配置表单填写，不进入人设、Skill、聊天、截图或日志。</p></details>
  <div class="official-sources"><a v-for="source in guide.sources" :key="source.url" :href="source.url" target="_blank" rel="noopener noreferrer">{{ source.title }} ↗</a></div>
</details>
</template>
<style scoped>
.channel-guide-details { margin-top: 1rem; line-height: 1.8; overflow-wrap: anywhere; }details { margin: 0.75rem 0; }summary { cursor: pointer; color: #167060; }figure { margin: 0.75rem 0; }img { display: block; max-width: 100%; max-height: 21.875rem; object-fit: contain; }.official-sources { display: grid; gap: 0.5rem; }a { color: #167060; }
</style>
