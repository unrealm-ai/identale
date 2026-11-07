<script setup lang="ts">
import { computed } from 'vue';
import { NAvatar, NButton, NDropdown, type DropdownOption } from 'naive-ui';
const props=defineProps<{name:string;username:string;dark:boolean;disabled:boolean}>();
const emit=defineEmits<{theme:[];logout:[]}>();
const options=computed<DropdownOption[]>(()=>[{key:'account',label:props.username,disabled:true},{key:'theme',props:{role:'menuitem'},label:props.dark?'切换浅色主题':'切换深色主题'},{key:'logout',props:{role:'menuitem','aria-disabled':props.disabled?'true':'false'},label:'退出登录',disabled:props.disabled}]);
function select(key:string){if(key==='theme')emit('theme');else if(key==='logout'&&!props.disabled)emit('logout');}
</script>
<template><NDropdown :menu-props="()=>({role:'menu','aria-label':'账号菜单'})" trigger="click" :options="options" placement="top-start" @select="select"><NButton quaternary block class="account-trigger" aria-label="我的账号"><NAvatar round :size="32">{{Array.from(name||username)[0]}}</NAvatar><span class="account-copy"><strong>{{name||username}}</strong><small>我的账号</small></span></NButton></NDropdown></template>
<style scoped>.account-trigger{height:auto;min-height:3.5rem;padding:.5rem;text-align:left}.account-trigger :deep(.n-button__content){width:100%;justify-content:flex-start;gap:.625rem}.account-copy{display:grid;gap:.125rem;min-width:0;flex:1}.account-copy strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.875rem;font-weight:500}.account-copy small{font-size:.75rem;color:var(--muted)}</style>
