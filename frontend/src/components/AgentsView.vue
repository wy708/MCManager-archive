<script setup lang="ts">
import { t } from '../i18n'

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
  STATS_READ: t('m0308'),
  CHAT_READ: t('m0309'),
  CHAT_SEND: t('m0310'),
  QQ_BIND: t('m0311'),
  WORLD_READ: t('m0312'),
  PROJECT_WRITE: t('m0313'),
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
    ? t('m0314')
    : {
        create: t('m0315'),
        edit: t('m0316'),
        rotate: t('m0317'),
        revoke: t('m0318'),
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
          args: [t('m0319')],
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
      message.value = editing ? t('m0320') : t('m0321')
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
    formError.value = t('m0322')
  }
}
function serverName(id: string) {
  return props.servers.find((server) => server.id === id)?.name ?? id
}
</script>

<template>
  <section class="agents-workspace">
    <ol class="connection-steps" :aria-label="t('m0323')">
      <li>
        <b>1</b><span><strong>{{ t('m0315') }}</strong><small>{{ t('m0324') }}</small></span>
      </li>
      <li>
        <b>2</b><span><strong>{{ t('m0325') }}</strong><small>{{ t('m0326') }}</small></span>
      </li>
      <li>
        <b>3</b><span><strong>{{ t('m0327') }}</strong><small>{{ t('m0328') }}</small></span>
      </li>
    </ol>
    <article class="panel data-panel">
      <div class="data-panel-heading">
        <div>
          <h2>{{ t('m0329') }}</h2>
          <p>{{ t('m0330') }}</p>
        </div>
        <div class="agent-actions">
          <button class="secondary" :disabled="busy" @click="refresh">
            <RefreshCw :size="16" />{{ t('m0331') }}</button
          ><button
            class="primary"
            data-create-agent
            :disabled="!servers.length || busy"
            @click="open('create')"
          >
            <Plus :size="16" />{{ t('m0315') }}</button>
        </div>
      </div>
      <p class="data-note">
        <ShieldCheck
          :size="16"
        />{{ t('m0332') }}</p>
      <p class="data-note">{{ t('m0333') }}</p>
      <details class="agent-help">
        <summary>{{ t('m0334') }}</summary>
        <p>{{ t('m0335') }}</p>
        <p>{{ t('m0336') }}</p>
      </details>
    </article>
    <p v-if="message" class="alert success" role="status">{{ message }}</p>
    <p v-if="error" class="alert error" role="alert">
      {{ error }}<button class="text-button" @click="refresh">{{ t('m0337') }}</button>
    </p>
    <p v-else-if="busy" class="small-empty" role="status">{{ t('m0338') }}</p>
    <p v-else-if="!visible.length" class="small-empty">
      {{ !servers.length ? t('m0339') : t('m0340') }}
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
          <p>{{ agent.revoked ? t('m0341') : t('m0342') }}</p>
        </div>
        <div class="agent-actions">
          <button class="secondary" @click="open('edit', agent)">{{ t('m0343') }}</button
          ><button class="secondary" @click="open('rotate', agent)">
            {{ agent.revoked ? t('m0344') : t('m0345') }}</button
          ><button v-if="!agent.revoked" class="text-button" @click="open('revoke', agent)">{{ t('m0318') }}</button>
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
      <p v-if="!agent.grants.length" class="data-note">{{ t('m0346') }}</p>
      <details class="plain-details">
        <summary>{{ t('m0347') }}</summary>
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
            :aria-label="t('m0348')"
            :disabled="working"
            @click="close"
          >
            <X :size="20" />
          </button>
        </div>
        <template v-if="token"
          ><p class="alert info">{{ t('m0349') }}</p>
          <label
            >{{ t('m0350') }}<textarea
              ref="tokenField"
              :value="token"
              readonly
              rows="3"
              spellcheck="false"
            />
          </label>
          <div class="agent-actions">
            <button type="button" class="secondary" @click="copy()">
              <Copy :size="16" />{{ t('m0351') }}</button
            ><button type="button" class="secondary" @click="copy(true)">
              <Copy :size="16" />{{ t('m0352') }}</button
            ><span v-if="copied" role="status">{{ t('m0353') }}</span>
          </div>
          <details>
            <summary>{{ t('m0354') }}</summary>
            <label
              >{{ t('m0355') }}<textarea :value="mcpConfig" readonly rows="9" spellcheck="false" />
            </label>
            <p class="data-note">{{ t('m0356', [backendOrigin]) }}</p>
          </details></template
        >
        <template v-else-if="action === 'create' || action === 'edit'"
          ><label v-if="action === 'create'"
            >{{ t('m0357') }}<input
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
          <p class="data-note">{{ t('m0358') }}</p></template
        >
        <template v-else
          ><p class="dialog-description">{{ selected?.name }}</p>
          <p class="alert info">
            {{
              action === 'revoke'
                ? t('m0359')
                : selected?.revoked
                  ? t('m0360')
                  : t('m0361')
            }}
          </p></template
        >
        <p v-if="formError" class="alert error" role="alert">{{ formError }}</p>
        <div class="dialog-actions">
          <button type="button" class="secondary" :disabled="working" @click="close">
            {{ token ? t('m0362') : t('m0102') }}</button
          ><button
            v-if="!token"
            class="primary"
            :disabled="working || (action === 'create' && !validGrants.length)"
          >
            {{
              working
                ? t('m0363')
                : action === 'create'
                  ? t('m0364')
                  : action === 'edit'
                    ? t('m0365')
                    : action === 'revoke'
                      ? t('m0366')
                      : t('m0367')
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
