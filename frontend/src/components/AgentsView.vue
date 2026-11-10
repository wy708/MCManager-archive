<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { Bot, Copy, Plus, RefreshCw, ShieldCheck, X } from '@lucide/vue'
import { api, type ServerArchive } from '../api'
import { useResource } from '../useResource'
import { failure } from '../statistics'

type Scope = 'STATS_READ' | 'CHAT_READ' | 'CHAT_SEND' | 'QQ_BIND' | 'WORLD_READ' | 'PROJECT_WRITE'
interface Grant {
  serverId: string
  scopes: Scope[]
}
interface Account {
  id: string
  name: string
  revoked: boolean
  createdAt: string
  grants: Grant[]
}
interface Issued {
  account: Account
  token: string
}
const props = defineProps<{ servers: ServerArchive[]; scope: string; revision: number }>()
const emit = defineEmits<{ error: [error: unknown] }>()
const { data, busy, error, refresh } = useResource(
  () => props.revision,
  (signal) => api<Account[]>('/agents', { signal }),
  (ex) => emit('error', ex),
)
const visible = computed(
  () =>
    data.value?.filter(
      (agent) =>
        props.scope === 'all' || agent.grants.some((grant) => grant.serverId === props.scope),
    ) ?? [],
)
const scopeLabels: Record<Scope, string> = {
  STATS_READ: '读取统计',
  CHAT_READ: '读取聊天',
  CHAT_SEND: '发送回复',
  QQ_BIND: '管理 QQ 绑定',
  WORLD_READ: '查询世界状态',
  PROJECT_WRITE: '管理绑定玩家的施工工程',
}
const backendOrigin = window.location.origin
const scopes = Object.keys(scopeLabels) as Scope[]
const modal = ref<HTMLDialogElement>(),
  tokenField = ref<HTMLTextAreaElement>(),
  nameField = ref<HTMLInputElement>()
const action = ref<'create' | 'edit' | 'rotate' | 'revoke'>('create'),
  selected = ref<Account>()
const name = ref(''),
  grants = ref<Record<string, Scope[]>>({}),
  token = ref(''),
  working = ref(false),
  formError = ref(''),
  message = ref(''),
  copied = ref(false)
const title = computed(() =>
  token.value
    ? '保存 助手连接密钥'
    : {
        create: '添加助手',
        edit: '编辑服务器授权',
        rotate: '轮换 助手连接密钥',
        revoke: '停用助手',
      }[action.value],
)
const validGrants = computed(() =>
  Object.entries(grants.value)
    .filter(([, rights]) => rights.length)
    .map(([serverId, rights]) => ({ serverId, scopes: rights })),
)
const mcpConfig = computed(() =>
  JSON.stringify(
    {
      mcpServers: {
        'mcmanager-archive': {
          command: 'node',
          args: ['请替换为本机 mcp/src/server.mjs 的绝对路径'],
          env: {
            MCM_MCP_API_URL: window.location.origin,
            MCM_AGENT_TOKEN: token.value,
            ...(!['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname) &&
            window.location.protocol === 'http:'
              ? { MCM_MCP_ALLOW_HTTP: 'true' }
              : {}),
          },
        },
      },
    },
    null,
    2,
  ),
)
let opener: HTMLElement | null = null,
  mutated = false
async function open(kind: typeof action.value, account?: Account) {
  opener = document.activeElement as HTMLElement
  action.value = kind
  selected.value = account
  name.value = account?.name ?? ''
  token.value = ''
  copied.value = false
  formError.value = ''
  mutated = false
  grants.value = Object.fromEntries(
    props.servers.map((server) => [
      server.id,
      [...(account?.grants.find((grant) => grant.serverId === server.id)?.scopes ?? [])],
    ]),
  )
  await nextTick()
  modal.value?.showModal()
  if (kind === 'create') nameField.value?.focus()
}
function close() {
  if (!working.value) modal.value?.close()
}
async function onClose() {
  const id = selected.value?.id
  token.value = ''
  selected.value = undefined
  if (mutated) {
    await refresh()
    await nextTick()
    const replacement = id
      ? document.querySelector<HTMLButtonElement>(`[data-agent="${id}"] button`)
      : undefined
    if (replacement) replacement.focus()
    else document.querySelector<HTMLButtonElement>('[data-create-agent]')?.focus()
  } else opener?.focus()
}
async function perform() {
  if (working.value) return
  working.value = true
  formError.value = ''
  message.value = ''
  try {
    if (action.value === 'create' || action.value === 'rotate') {
      const issued = await api<Issued>(
        action.value === 'create' ? '/agents' : `/agents/${selected.value!.id}/rotate`,
        {
          method: 'POST',
          ...(action.value === 'create'
            ? { body: JSON.stringify({ name: name.value.trim(), grants: validGrants.value }) }
            : {}),
        },
      )
      selected.value = issued.account
      token.value = issued.token
      mutated = true
      await nextTick()
      tokenField.value?.focus()
      tokenField.value?.select()
    } else {
      const editing = action.value === 'edit'
      await api(`/agents/${selected.value!.id}${editing ? '/grants' : ''}`, {
        method: editing ? 'PUT' : 'DELETE',
        ...(editing ? { body: JSON.stringify({ grants: validGrants.value }) } : {}),
      })
      mutated = true
      message.value = editing ? 'Agent 授权已更新' : '助手连接密钥已撤销'
      modal.value?.close()
    }
  } catch (ex) {
    formError.value = failure(ex)
    emit('error', ex)
  } finally {
    working.value = false
  }
}
async function copy(config = false) {
  try {
    await navigator.clipboard.writeText(config ? mcpConfig.value : token.value)
    copied.value = true
  } catch {
    tokenField.value?.focus()
    tokenField.value?.select()
    formError.value = '自动复制不可用，请选中内容后手动复制。'
  }
}
function serverName(id: string) {
  return props.servers.find((server) => server.id === id)?.name ?? id
}
</script>

<template>
  <section class="agents-workspace">
    <ol class="connection-steps" aria-label="AI 接入步骤">
      <li>
        <b>1</b><span><strong>添加助手</strong><small>给小伙伴起个名字</small></span>
      </li>
      <li>
        <b>2</b><span><strong>选择能力</strong><small>授权服务器和操作</small></span>
      </li>
      <li>
        <b>3</b><span><strong>连接 AI 软件</strong><small>复制生成的 MCP 配置</small></span>
      </li>
    </ol>
    <article class="panel data-panel">
      <div class="data-panel-heading">
        <div>
          <h2>连接 AI 助手</h2>
          <p>先添加助手，再选择它能查看的服务器和能做的事情。</p>
        </div>
        <div class="agent-actions">
          <button class="secondary" :disabled="busy" @click="refresh">
            <RefreshCw :size="16" />刷新</button
          ><button
            class="primary"
            data-create-agent
            :disabled="!servers.length || busy"
            @click="open('create')"
          >
            <Plus :size="16" />添加助手
          </button>
        </div>
      </div>
      <p class="data-note">
        <ShieldCheck
          :size="16"
        />只监控时授权读取统计和聊天；需要自动回复时再启用发送。玩家聊天不会授予额外权限。
      </p>
      <p class="data-note">
        助手通过 MCP 连接本平台，由你使用的 AI
        软件负责思考和自动回复。游戏内回复需要插件在线，排队中的消息不代表已经送达。
      </p>
      <details class="agent-help">
        <summary>如何连接 AI 软件？（MCP 配置）</summary>
        <p>
          在项目 mcp 目录执行 npm ci --ignore-scripts，再把本机 server.mjs
          绝对路径和独立凭据填入主机的 mcpServers 配置。创建或轮换后可复制配置。
        </p>
        <p>
          主机负责自动回复规则、模型调用、保存游标和 requestId。默认不把 Agent
          回复作为玩家输入，避免循环。
        </p>
      </details>
    </article>
    <p v-if="message" class="alert success" role="status">{{ message }}</p>
    <p v-if="error" class="alert error" role="alert">
      {{ error }}<button class="text-button" @click="refresh">重试</button>
    </p>
    <p v-else-if="busy" class="small-empty" role="status">正在加载 Agent…</p>
    <p v-else-if="!visible.length" class="small-empty">
      {{ !servers.length ? '先添加服务器档案，再添加助手。' : '当前范围还没有 Agent 授权。' }}
    </p>
    <article
      v-for="agent in visible"
      :key="agent.id"
      class="panel agent-card"
      :data-agent="agent.id"
    >
      <div class="data-panel-heading">
        <div>
          <h2><Bot :size="20" />{{ agent.name }}</h2>
          <p>{{ agent.revoked ? '连接密钥已停用' : '连接密钥已启用' }}</p>
        </div>
        <div class="agent-actions">
          <button class="secondary" @click="open('edit', agent)">编辑授权</button
          ><button class="secondary" @click="open('rotate', agent)">
            {{ agent.revoked ? '重新启用' : '更换连接密钥' }}</button
          ><button v-if="!agent.revoked" class="text-button" @click="open('revoke', agent)">
            停用助手
          </button>
        </div>
      </div>
      <ul class="agent-grants">
        <li v-for="grant in agent.grants" :key="grant.serverId">
          <strong>{{ serverName(grant.serverId) }}</strong
          ><span
            v-for="right in scopes.filter((right) => grant.scopes.includes(right))"
            :key="right"
            class="neutral-badge"
            >{{ scopeLabels[right] }}</span
          >
        </li>
      </ul>
      <p v-if="!agent.grants.length" class="data-note">未授权任何服务器。</p>
      <details class="plain-details">
        <summary>查看助手编号</summary>
        <code>{{ agent.id }}</code>
      </details>
    </article>
    <dialog
      ref="modal"
      class="credential-dialog agent-dialog"
      aria-labelledby="agent-title"
      @cancel="working ? $event.preventDefault() : undefined"
      @close="onClose"
    >
      <form @submit.prevent="perform">
        <div class="dialog-heading">
          <div>
            <p class="eyebrow">AGENT ACCESS</p>
            <h2 id="agent-title">{{ title }}</h2>
          </div>
          <button
            type="button"
            class="icon-button"
            aria-label="关闭 Agent 对话框"
            :disabled="working"
            @click="close"
          >
            <X :size="20" />
          </button>
        </div>
        <template v-if="token"
          ><p class="alert info">凭据只显示一次。关闭后无法读取；请保存到可信的 MCP 主机配置。</p>
          <label
            >助手连接密钥<textarea
              ref="tokenField"
              :value="token"
              readonly
              rows="3"
              spellcheck="false"
            />
          </label>
          <div class="agent-actions">
            <button type="button" class="secondary" @click="copy()">
              <Copy :size="16" />复制连接密钥</button
            ><button type="button" class="secondary" @click="copy(true)">
              <Copy :size="16" />复制 MCP 配置</button
            ><span v-if="copied" role="status">已复制</span>
          </div>
          <details>
            <summary>查看 MCP 配置</summary>
            <label
              >MCP 配置<textarea :value="mcpConfig" readonly rows="9" spellcheck="false" />
            </label>
            <p class="data-note">替换 server.mjs 绝对路径。当前服务地址：{{ backendOrigin }}</p>
          </details></template
        >
        <template v-else-if="action === 'create' || action === 'edit'"
          ><label v-if="action === 'create'"
            >助手名称<input
              ref="nameField"
              v-model="name"
              required
              maxlength="64"
              autocomplete="off"
          /></label>
          <p v-else class="dialog-description">{{ selected?.name }}</p>
          <fieldset v-for="server in servers" :key="server.id" class="server-grant">
            <legend>{{ server.name }}</legend>
            <label v-for="right in scopes" :key="right"
              ><input
                v-model="grants[server.id]"
                type="checkbox"
                :value="right"
                :aria-label="`${server.name}：${scopeLabels[right]}`"
              />{{ scopeLabels[right] }}</label
            >
          </fieldset>
          <p class="data-note">
            取消发言授权会取消尚未执行的回复；执行中的回复保留为结果未知，等待真实回执。
          </p></template
        >
        <template v-else
          ><p class="dialog-description">{{ selected?.name }}</p>
          <p class="alert info">
            {{
              action === 'revoke'
                ? '撤销后该 Agent 立即失去访问权限，尚未执行的回复会取消。历史统计和消息保留。'
                : selected?.revoked
                  ? '生成新连接密钥后重新启用现有服务器授权。旧凭据仍然无效。'
                  : '新凭据立即替换旧凭据。请同步更新 MCP 主机配置。'
            }}
          </p></template
        >
        <p v-if="formError" class="alert error" role="alert">{{ formError }}</p>
        <div class="dialog-actions">
          <button type="button" class="secondary" :disabled="working" @click="close">
            {{ token ? '已保存，关闭' : '取消' }}</button
          ><button
            v-if="!token"
            class="primary"
            :disabled="working || (action === 'create' && !validGrants.length)"
          >
            {{
              working
                ? '处理中…'
                : action === 'create'
                  ? '生成助手连接密钥'
                  : action === 'edit'
                    ? '保存授权'
                    : action === 'revoke'
                      ? '确认撤销'
                      : '生成新连接密钥'
            }}
          </button>
        </div>
      </form>
    </dialog>
  </section>
</template>

<style scoped>
.agents-workspace {
  display: grid;
  gap: 18px;
}
.agent-actions {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}
.agent-card {
  padding: 22px;
  min-width: 0;
}
.agent-card h2 {
  display: flex;
  align-items: center;
  gap: 9px;
  overflow-wrap: anywhere;
}
.agent-card .data-panel-heading {
  padding: 0;
}
.agent-grants {
  list-style: none;
  margin: 20px 0;
  padding: 0;
  display: grid;
  gap: 12px;
}
.agent-grants li {
  display: flex;
  align-items: center;
  gap: 9px;
  flex-wrap: wrap;
  font-size: 12px;
}
.agent-grants strong {
  overflow-wrap: anywhere;
}
.agent-card code {
  overflow-wrap: anywhere;
}
.agent-help {
  margin: 16px 22px 20px;
  font-size: 12px;
  color: #657b6a;
  line-height: 1.8;
}
.agent-help summary {
  cursor: pointer;
}
.agent-dialog details {
  margin: 18px 0;
  font-size: 12px;
}
.agent-dialog details > label {
  margin-top: 14px;
}
.server-grant {
  padding: 13px;
  border: 1px solid #dce8de;
  border-radius: 9px;
  margin: 14px 0;
}
.server-grant legend {
  font-size: 12px;
  overflow-wrap: anywhere;
  max-width: 100%;
  padding: 0 6px;
}
.server-grant label {
  display: inline-flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  margin: 5px 16px 5px 0;
}
.server-grant input {
  width: 16px;
  height: 16px;
  padding: 0;
  margin: 0;
}
@media (max-width: 680px) {
  .agent-card {
    padding: 17px 15px;
  }
  .agent-card .data-panel-heading {
    align-items: start;
    flex-direction: column;
    gap: 17px;
  }
  .agent-actions {
    gap: 8px;
  }
}
</style>
