<script setup lang="ts">
import {onMounted,ref} from 'vue'
import {api} from '../api'
const emit=defineEmits<{error:[error:unknown]}>()
const props=defineProps<{username:string}>()
interface Account {id:string;username:string;role:'ADMIN'|'VIEWER';enabled:boolean;createdAt:string}
const accounts=ref<Account[]>([]),username=ref(''),password=ref(''),confirm=ref(''),role=ref<'ADMIN'|'VIEWER'>('VIEWER'),busy=ref(false),error=ref(''),message=ref('')
async function load(){try{accounts.value=await api<Account[]>('/admin/accounts')}catch(e){error.value=e instanceof Error?e.message:'账号读取失败';emit('error',e)}}
async function create(){
 if(password.value!==confirm.value){error.value='两次输入的密码不一致';return}
 busy.value=true;error.value='';message.value=''
 try{const account=await api<Account>('/admin/accounts',{method:'POST',body:JSON.stringify({username:username.value,password:password.value,role:role.value})});password.value='';confirm.value='';username.value='';message.value=`账号 ${account.username} 已创建，可以使用设置的密码登录。`;await load()}
 catch(e){error.value=e instanceof Error?e.message:'创建失败';emit('error',e)}finally{busy.value=false}
}
async function toggle(account:Account){
 if(!window.confirm(`${account.enabled?'停用':'启用'}账号 ${account.username}？${account.enabled?'停用后该账号的已有登录会失效。':''}`))return
 busy.value=true;error.value='';message.value=''
 try{await api(`/admin/accounts/${account.id}/enabled`,{method:'PUT',body:JSON.stringify({enabled:!account.enabled})});message.value=`账号已${account.enabled?'停用':'启用'}`;await load()}catch(e){error.value=e instanceof Error?e.message:'操作失败';emit('error',e)}finally{busy.value=false}
}
onMounted(load)
</script>
<template>
 <section class="panel accounts-view">
  <div class="panel-heading"><div><h2>后台账号</h2><p>账号只能由管理员创建，登录页不开放注册。</p></div><button class="secondary" :disabled="busy" @click="load">刷新列表</button></div>
  <p v-if="error" class="alert error" role="alert">{{error}}</p><p v-if="message" class="alert success" role="status">{{message}}</p>
  <form class="account-create" @submit.prevent="create">
   <h3>创建账号</h3>
   <label>账号名称<input v-model="username" required minlength="3" maxlength="40" pattern="[A-Za-z0-9][A-Za-z0-9_.-]{2,39}" autocomplete="off" placeholder="3–40 位字母、数字、点、横线或下划线"/></label>
   <label>账号权限<select v-model="role"><option value="VIEWER">只读账号</option><option value="ADMIN">管理员</option></select></label>
   <label>初始密码<input v-model="password" type="password" required minlength="12" maxlength="72" autocomplete="new-password"/></label>
   <label>确认初始密码<input v-model="confirm" type="password" required minlength="12" maxlength="72" autocomplete="new-password"/></label>
   <p class="muted">密码至少 12 位，建议混合字母、数字和符号。账号名称不区分大小写。</p>
   <p class="permission-note">{{role==='ADMIN'?'管理员拥有完整后台权限，可以控制服务器、管理备份和其他账号。':'只读账号可以查看全部服务器的统计、聊天记录、地图、施工工程、日报和运行状况，不能修改数据、操作控制台或下载备份与模型。'}}</p>
   <button class="primary" :disabled="busy">{{busy?'正在处理…':'创建账号'}}</button>
  </form>
  <h3>已有账号</h3><div class="account-list"><article v-for="account in accounts" :key="account.id" class="account-row"><div><strong>{{account.username}}</strong><span v-if="account.username===props.username" class="current-account">当前账号</span><p>{{account.role==='ADMIN'?'管理员':'只读账号'}} · {{account.enabled?'正常':'已停用'}} · 创建于 {{new Date(account.createdAt).toLocaleString()}}</p></div><button v-if="account.username!==props.username" class="secondary" :disabled="busy" @click="toggle(account)">{{account.enabled?'停用':'启用'}}</button></article></div>
 </section>
</template>
<style scoped>
.accounts-view{padding:24px}.account-create{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;padding:20px;margin:18px 0 24px;background:linear-gradient(120deg,#eff9f3,#f1f3ff);border:1px solid #d6e8dd;border-radius:14px}.account-create h3,.account-create p{grid-column:1/-1;margin:0}.account-create label{display:grid;gap:8px;font-size:14px;color:#355e4e}.account-create input,.account-create select{width:100%;min-width:0;border:1px solid #c8dccf;border-radius:9px;padding:11px;background:white;color:#174e3d;font:inherit}.account-create .primary{justify-self:start}.permission-note{font-size:13px;color:#355e4e;line-height:1.6}.account-list{display:grid;gap:12px}.account-row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:16px;border:1px solid #deebe3;border-radius:12px}.account-row p{font-size:12px;color:#698273;margin:8px 0 0}.current-account{font-size:11px;margin-left:10px;padding:3px 8px;background:#e4f5eb;color:#187c54;border-radius:12px}@media(max-width:600px){.accounts-view{padding:14px}.account-create{padding:14px;grid-template-columns:1fr}.account-row{align-items:flex-start}.account-row strong{overflow-wrap:anywhere}}
</style>
