<script setup lang="ts">
import {nextTick,ref} from 'vue'
import {api} from '../api'
const emit=defineEmits<{changed:[];error:[error:unknown]}>()
const dialog=ref<HTMLDialogElement>(),currentInput=ref<HTMLInputElement>(),currentPassword=ref(''),newPassword=ref(''),confirm=ref(''),busy=ref(false),error=ref('')
let opener:HTMLElement|null=null
function clear(){currentPassword.value='';newPassword.value='';confirm.value='';error.value=''}
async function open(){opener=document.activeElement as HTMLElement;clear();dialog.value?.showModal();await nextTick();currentInput.value?.focus()}
function close(){if(busy.value)return;dialog.value?.close();clear();opener?.focus()}
async function save(){
 if(newPassword.value!==confirm.value){error.value='两次输入的新密码不一致';return}
 busy.value=true;error.value=''
 try{await api('/auth/password',{method:'POST',body:JSON.stringify({currentPassword:currentPassword.value,newPassword:newPassword.value})});busy.value=false;close();emit('changed')}
 catch(e){error.value=e instanceof Error?e.message:'密码修改失败';emit('error',e)}finally{busy.value=false}
}
defineExpose({open})
</script>
<template><dialog ref="dialog" class="password-dialog" aria-labelledby="password-title" @cancel.prevent="close"><form @submit.prevent="save"><h2 id="password-title">修改密码</h2><p class="muted">修改成功后，请用新密码重新登录。其他设备上的旧登录也会失效。</p><label>原密码<input ref="currentInput" v-model="currentPassword" type="password" autocomplete="current-password" required maxlength="72"/></label><label>新密码<input v-model="newPassword" type="password" autocomplete="new-password" required minlength="12" maxlength="72"/></label><label>确认新密码<input v-model="confirm" type="password" autocomplete="new-password" required minlength="12" maxlength="72"/></label><p class="muted">至少 12 位，不能与原密码相同。</p><p v-if="error" role="alert" class="alert error">{{error}}</p><div class="password-actions"><button type="button" class="secondary" :disabled="busy" @click="close">取消</button><button class="primary" :disabled="busy">{{busy?'正在修改…':'保存新密码'}}</button></div></form></dialog></template>
<style scoped>.password-dialog{width:min(440px,calc(100vw - 32px));max-height:90dvh;overflow:auto;padding:24px;border:1px solid #c8dccf;border-radius:16px;color:#174e3d;background:white}.password-dialog::backdrop{background:#102b2277}.password-dialog h2{margin:0 0 12px}.password-dialog label{display:grid;gap:7px;margin:14px 0;font-size:14px}.password-dialog input{font:inherit;width:100%;min-width:0;padding:11px;border:1px solid #c8dccf;border-radius:9px}.password-dialog .muted{font-size:13px;line-height:1.7}.password-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}</style>
