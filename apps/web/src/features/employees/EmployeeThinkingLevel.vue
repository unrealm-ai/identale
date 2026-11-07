<script setup lang="ts">
import { NFormItem, NSelect } from 'naive-ui';
import { executionThinkingOptions, type ExecutionThinkingLevel } from './thinking-options';
defineProps<{value:ExecutionThinkingLevel;disabled?:boolean}>();
const emit=defineEmits<{'update:value':[value:ExecutionThinkingLevel]}>();
</script>
<template><div class="employee-thinking"><NFormItem label="思考强度"><NSelect :value="value" :options="executionThinkingOptions" :virtual-scroll="false" aria-label="思考强度" :input-props="{'aria-label':'思考强度'}" :disabled="disabled" @update:value="value=>emit('update:value',value)" /></NFormItem></div></template>
