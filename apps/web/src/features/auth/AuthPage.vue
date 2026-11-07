<script setup lang="ts">
import PageHeader from '../../shared/ui/PageHeader.vue';
import BrandLogo from '../../shared/ui/BrandLogo.vue';
import { computed, nextTick, ref, watch } from 'vue';
import { NButton, NCard, NForm, NFormItem, NInput, NTab, NTabs, type FormInst, type FormRules } from 'naive-ui';
import { useAccessibleTabs, vAccessibleTablist } from '../../shared/ui/useAccessibleTabs';
const props = defineProps<{ busy: boolean; invitationToken: string; invitationValid: boolean }>();
const emit = defineEmits<{ submit: [] }>();
const mode = defineModel<'login' | 'register'>('mode', { required: true });
const username = defineModel<string>('username', { required: true });
const password = defineModel<string>('password', { required: true });
const displayName = defineModel<string>('displayName', { required: true });
const form = ref<FormInst | null>(null), formHost = ref<HTMLElement | null>(null), validating = ref(false);
const validUsername = (value: string) => /^[A-Za-z0-9][A-Za-z0-9_.\-]{2,31}$/.test(value);
const submitLabel = computed(() => mode.value === 'login' ? '登录工作台' : props.invitationToken ? '注册并加入受邀工作区' : '注册并创建工作区');
const model = computed(() => ({ username: username.value, password: password.value }));
const rules = computed<FormRules>(() => ({
  username: { required: true, validator: (_rule, value: string) => validUsername(value) || new Error('请输入 3–32 位字母、数字、点、下划线或短横线'), trigger: ['blur', 'input'] },
  password: { required: true, validator: (_rule, value: string) => value.length > 0 && (mode.value === 'login' || [...value].length >= 6) || new Error(mode.value === 'register' ? '密码至少 6 个字符' : '请输入密码'), trigger: 'blur' },
}));
async function submit() {
  if (validating.value || props.busy || (mode.value === 'register' && !!props.invitationToken && !props.invitationValid)) return;
  validating.value = true;
  try {
    try { await form.value?.validate(); } catch {
      await nextTick();
      const name = validUsername(username.value) ? 'password' : 'username';
      formHost.value?.querySelector<HTMLInputElement>(`input[name="${name}"]`)?.focus();
      return;
    }
    if (!props.busy && !(mode.value === 'register' && !!props.invitationToken && !props.invitationValid)) emit('submit');
  } finally { await nextTick(); validating.value = false; }
}
const { tabProps, panelProps } = useAccessibleTabs(mode, () => ['login', 'register'], () => props.busy || validating.value, true);
watch(mode, () => { password.value = ''; form.value?.restoreValidation(); });
function switchMode(value: string) { mode.value = value as 'login' | 'register'; password.value = ''; form.value?.restoreValidation(); }
</script>
<template>
  <div class="auth-layout">
    <aside class="landing-hero" data-theme="dark">
      <div class="auth-brand"><BrandLogo lockup /></div>
      <h2>像给团队添了一位同事</h2>
      <p class="lead">数字员工有工牌、有岗位、有边界；TA 做的每件事都能看到进度、能被确认、能被叫停。</p>
      <ul>
        <li>在对话里直接交代工作，像和同事沟通一样</li>
        <li>谁能用、在哪儿用、能做什么，一目了然</li>
        <li>任务、执行、投递分开追踪，结果不靠猜</li>
      </ul>
      <ol>
        <li><b>注册账号</b><span>只需账号名和密码</span></li>
        <li><b>获得工作区</b><span>注册后自动创建，或凭邀请加入团队</span></li>
        <li><b>创建数字员工</b><span>设定岗位、入口与使用范围</span></li>
      </ol>
    </aside>
    <div class="landing-form">
    <p v-if="mode==='login'" class="landing-switch">还没有账号？<NButton text type="primary" :disabled="busy" @click="switchMode('register')">注册账号</NButton></p>
    <NCard class="auth-panel" size="large" :aria-busy="busy">
      <PageHeader :title="mode === 'login' ? '欢迎回来' : invitationToken ? '加入你的团队' : '创建账号'" :description="mode === 'login' ? '登录你的数字员工工作区' : '开始与你的数字员工协作'" />
      <NTabs v-accessible-tablist="'登录或注册'" :value="mode" type="line" size="large" @update:value="switchMode">
        <NTab name="login" v-bind="tabProps('login')" :disabled="busy">登录</NTab>
        <NTab name="register" v-bind="tabProps('register')" :disabled="busy">注册账号</NTab>
      </NTabs>
      <div ref="formHost" v-bind="panelProps(mode)">
        <NForm ref="form" :model="model" :rules="rules" :disabled="busy" @submit.prevent="submit">
          <NFormItem label="账号名" path="username"><NInput v-model:value="username" :disabled="busy" :input-props="{ name: 'username', autocomplete: 'username', 'aria-label': '账号名' }" :maxlength="32" placeholder="输入你的账号名" /></NFormItem>
          <NFormItem v-if="mode === 'register'" label="显示名（可选）"><NInput v-model:value="displayName" :disabled="busy" :input-props="{ name: 'displayName', autocomplete: 'nickname', 'aria-label': '显示名' }" :maxlength="100" placeholder="团队如何称呼你" /></NFormItem>
          <NFormItem label="密码" path="password"><NInput v-model:value="password" :disabled="busy" type="password" show-password-on="click" v-bind="mode === 'register' ? { minlength: 6 } : {}" :maxlength="1024" :input-props="{ name: 'password', autocomplete: mode === 'register' ? 'new-password' : 'current-password', minlength: mode === 'register' ? 6 : undefined, 'aria-label': '密码' }" placeholder="输入密码" /></NFormItem>
          <p v-if="mode === 'register'" class="field-note auth-password-note">密码至少 6 个字符。</p>
          <p v-if="mode === 'register' && !invitationToken" class="field-note auth-scope-note">注册后会为你创建一个工作区。</p>
          <p v-if="mode === 'register' && invitationToken" class="field-note auth-scope-note">{{ invitationValid ? '注册后加入受邀工作区。' : '请先确认邀请有效，再继续注册。' }}</p>
          <NButton block size="large" type="primary" attr-type="submit" :aria-label="submitLabel" :loading="busy || validating" :disabled="busy || validating || (mode === 'register' && !!invitationToken && !invitationValid)">{{ mode === 'login' ? '登录' : invitationToken ? '注册并加入' : '注册' }}</NButton>
        </NForm>
      </div>
      <p class="field-note auth-footnote">请妥善保管账号和密码。</p>
    </NCard>
    </div>
  </div>
</template>
<style scoped>
.auth-layout{display:contents}
.landing-hero{display:none}
.landing-form{display:flex;flex-direction:column;align-items:center;gap:1rem;width:min(440px,100%);margin:0 auto}
.landing-switch{align-self:flex-end;margin:0;color:var(--id-text-secondary);font-size:13px}
.auth-panel{width:100%;min-width:0;border-radius:16px}.auth-panel :deep(.n-card__content){padding:2rem}.auth-panel :deep(.page-heading){margin-bottom:1.5rem}.auth-panel :deep(.page-heading h1){font-size:1.75rem;line-height:2.25rem}.auth-panel :deep(.n-tabs){margin-bottom:1.5rem}.auth-password-note{margin:-.25rem 0 1rem}.auth-scope-note{margin:0 0 1.25rem}.auth-footnote{margin:1.25rem 0 0;text-align:center}
@media(min-width:960px){
 .landing-hero{display:flex;flex-direction:column;gap:16px;grid-column:1;grid-row:1 / span 6;min-height:100dvh;padding:48px 40px;background:var(--id-bg-rail,#0F1A1D);color:#E8EDEF}
 .landing-hero h2{margin:8px 0 0;font-size:30px;line-height:38px;font-weight:650;color:#fff}
 .landing-hero .lead,.landing-hero li,.landing-hero span{color:#C9D6D9}
 .landing-hero ul,.landing-hero ol{margin:0;padding:0;display:grid;gap:12px;list-style:none}
 .landing-hero li{display:grid;gap:2px}
 .auth-brand :deep(.brand-logo--lockup img){height:36px;width:auto}
}
@media(max-width:959.98px){.landing-form{margin-top:1.5rem}.auth-panel :deep(.n-card__content){padding:1.25rem}.auth-panel :deep(.page-heading h1){font-size:1.5rem;line-height:2rem}}
</style>
