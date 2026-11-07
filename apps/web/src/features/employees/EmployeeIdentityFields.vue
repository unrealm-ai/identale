<script setup lang="ts">
import {ref,watch,nextTick,useId} from 'vue';
import type {InputInst} from 'naive-ui';
import { NFormItem, NInput } from 'naive-ui';
withDefaults(defineProps<{ disabled?: boolean; autofocus?: boolean; creation?:boolean; nameMaxlength?: number }>(), { nameMaxlength: 100 });
const name = defineModel<string>('name', { required: true });
const description = defineModel<string>('description', { required: true });
const invalid=ref(false),nameInput=ref<InputInst|null>(null),nameId=useId(),errorId=useId();
watch(name,value=>{if(value.trim())invalid.value=false;});
async function showNameError(){invalid.value=true;await nextTick();nameInput.value?.focus();}
defineExpose({showNameError});
</script>
<template>
  <NFormItem :label="creation?'名称':'员工名称'" v-bind="creation?{required:true,...(invalid?{validationStatus:'error' as const}:{})}:{path:'name'}" :label-props="{for:nameId}"><NInput ref="nameInput" v-model:value="name" :input-props="{id:nameId,'aria-label':'员工名称','aria-required':true,'aria-invalid':invalid,'aria-describedby':invalid?errorId:undefined}" :disabled="disabled" :maxlength="nameMaxlength" :show-count="creation" placeholder="例如 客户支持助手" :autofocus="autofocus" @blur="invalid=!name.trim()"/><template v-if="invalid" #feedback><span :id="errorId">请输入员工名称</span></template></NFormItem>
  <NFormItem :label="creation?'职责':'职责与表达风格'"><NInput v-model:value="description" :input-props="{ 'aria-label': '职责与表达风格' }" type="textarea" :disabled="disabled" :maxlength="4000" :show-count="creation" :autosize="{ minRows: 4, maxRows: 8 }" placeholder="例如：解答产品使用问题，回答简洁友好；不确定时明确说明。" /></NFormItem>
  <p v-if="!creation" class="field-note">描述员工负责什么、如何回答；职责说明不会增加使用权限，已有会话记录会保留。</p>
</template>
