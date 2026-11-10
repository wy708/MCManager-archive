<script setup lang="ts">
import { formatLocale, t } from '../i18n'

import {onMounted,ref} from 'vue'
import {api} from '../api'
const emit=defineEmits<{error:[error:unknown]}>()
const props=defineProps<{username:string}>()
interface Account {id:string;username:string;role:'ADMIN'|'VIEWER';enabled:boolean;createdAt:string}
const accounts=ref<Account[]>([]),username=ref(''),password=ref(''),confirm=ref(''),role=ref<'ADMIN'|'VIEWER'>('VIEWER'),busy=ref(false),error=ref(''),message=ref('')
async function load(){try{accounts.value=await api<Account[]>('/admin/accounts')}catch(e){error.value=e instanceof Error?e.message:t('m0280');emit('error',e)}}
async function create(){
 if(password.value!==confirm.value){error.value=t('m0281');return}
 busy.value=true;error.value='';message.value=''
 try{const account=await api<Account>('/admin/accounts',{method:'POST',body:JSON.stringify({username:username.value,password:password.value,role:role.value})});password.value='';confirm.value='';username.value='';message.value=t('m0282', [account.username]);await load()}
 catch(e){error.value=e instanceof Error?e.message:t('m0283');emit('error',e)}finally{busy.value=false}
}
async function toggle(account:Account){
 if(!window.confirm(t('m0286', [account.enabled?t('m0284'):t('m0264'), account.username, account.enabled?t('m0285'):''])))return
 busy.value=true;error.value='';message.value=''
 try{await api(`/admin/accounts/${account.id}/enabled`,{method:'PUT',body:JSON.stringify({enabled:!account.enabled})});message.value=t('m0287', [account.enabled?t('m0284'):t('m0264')]);await load()}catch(e){error.value=e instanceof Error?e.message:t('m0288');emit('error',e)}finally{busy.value=false}
}
onMounted(load)
</script>
<template>
 <section class="panel accounts-view">
  <div class="panel-heading"><div><h2>{{ t('m0289') }}</h2><p>{{ t('m0290') }}</p></div><button class="secondary" :disabled="busy" @click="load">{{ t('m0291') }}</button></div>
  <p v-if="error" class="alert error" role="alert">{{error}}</p><p v-if="message" class="alert success" role="status">{{message}}</p>
  <form class="account-create" @submit.prevent="create">
   <h3>{{ t('m0292') }}</h3>
   <label>{{ t('m0293') }}<input v-model="username" required minlength="3" maxlength="40" pattern="[A-Za-z0-9][A-Za-z0-9_.-]{2,39}" autocomplete="off" :placeholder="t('m0294')"/></label>
   <label>{{ t('m0295') }}<select v-model="role"><option value="VIEWER">{{ t('m0296') }}</option><option value="ADMIN">{{ t('m0297') }}</option></select></label>
   <label>{{ t('m0298') }}<input v-model="password" type="password" required minlength="12" maxlength="72" autocomplete="new-password"/></label>
   <label>{{ t('m0299') }}<input v-model="confirm" type="password" required minlength="12" maxlength="72" autocomplete="new-password"/></label>
   <p class="muted">{{ t('m0300') }}</p>
   <p class="permission-note">{{role==='ADMIN'?t('m0301'):t('m0302')}}</p>
   <button class="primary" :disabled="busy">{{busy?t('m0303'):t('m0292')}}</button>
  </form>
  <h3>{{ t('m0304') }}</h3><div class="account-list"><article v-for="account in accounts" :key="account.id" class="account-row"><div><strong>{{account.username}}</strong><span v-if="account.username===props.username" class="current-account">{{ t('m0305') }}</span><p>{{ t('m0307', [account.role==='ADMIN'?t('m0297'):t('m0296'), account.enabled?t('m0306'):t('m0265'), new Date(account.createdAt).toLocaleString(formatLocale)]) }}</p></div><button v-if="account.username!==props.username" class="secondary" :disabled="busy" @click="toggle(account)">{{account.enabled?t('m0284'):t('m0264')}}</button></article></div>
 </section>
</template>
<style scoped>
.accounts-view{padding:24px}.account-create{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;padding:20px;margin:18px 0 24px;background:linear-gradient(120deg,#eff9f3,#f1f3ff);border:1px solid #d6e8dd;border-radius:14px}.account-create h3,.account-create p{grid-column:1/-1;margin:0}.account-create label{display:grid;gap:8px;font-size:14px;color:#355e4e}.account-create input,.account-create select{width:100%;min-width:0;border:1px solid #c8dccf;border-radius:9px;padding:11px;background:white;color:#174e3d;font:inherit}.account-create .primary{justify-self:start}.permission-note{font-size:13px;color:#355e4e;line-height:1.6}.account-list{display:grid;gap:12px}.account-row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:16px;border:1px solid #deebe3;border-radius:12px}.account-row p{font-size:12px;color:#698273;margin:8px 0 0}.current-account{font-size:11px;margin-left:10px;padding:3px 8px;background:#e4f5eb;color:#187c54;border-radius:12px}@media(max-width:600px){.accounts-view{padding:14px}.account-create{padding:14px;grid-template-columns:1fr}.account-row{align-items:flex-start}.account-row strong{overflow-wrap:anywhere}}
</style>
