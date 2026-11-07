<script setup lang="ts">
import {resolveEmployeeAvatarPreset} from '@dentity/contracts';
import {computed,ref,watch} from 'vue';
const props=withDefaults(defineProps<{name:string;preset?:string|null|undefined;identityKey?:string;src?:string;size?:'directory'|'conversation'|'chat';decorative?:boolean}>(),{size:'directory',decorative:true});
const failed=ref(false);watch(()=>[props.src,props.preset],()=>failed.value=false);
const selected=computed(()=>resolveEmployeeAvatarPreset(props.preset,props.identityKey||props.name));
const portrait=computed(()=>selected.value.startsWith('cn-v2-'));
const image=computed(()=>props.src||'/employee-avatars/'+selected.value+(portrait.value?'.webp':'.svg'));
const initial=computed(()=>Array.from(props.name.trim())[0]||'员');
</script>
<template><span class="employee-avatar" :class="[`employee-avatar--${size}`,{'employee-avatar--portrait':portrait}]" :aria-hidden="decorative?'true':undefined" :role="decorative?undefined:'img'" :aria-label="decorative?undefined:`${name||'数字员工'}的头像`"><img v-if="image&&!failed" :src="image" alt="" @error="failed=true"/><span v-else>{{initial}}</span></span></template>
<style scoped>
.employee-avatar{display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;overflow:hidden;width:var(--employee-avatar-size);height:var(--employee-avatar-size);border-radius:50%;background:var(--tint);color:var(--brand);font-weight:600;font-size:calc(var(--employee-avatar-size) * .45);line-height:1;border:1px solid var(--subtle)}.employee-avatar--directory{--employee-avatar-size:var(--avatar-directory)}.employee-avatar--conversation{--employee-avatar-size:var(--avatar-conversation)}.employee-avatar--chat{--employee-avatar-size:var(--avatar-chat)}.employee-avatar--portrait{border-radius:50%}.employee-avatar img{width:100%;height:100%;object-fit:cover}
</style>
