<script setup lang="ts">
import { t, formatLocale } from '../i18n'

import { computed, nextTick, onScopeDispose, ref, watch } from 'vue'
import { Play, Square, RotateCw, Terminal, Send, ScrollText } from '@lucide/vue'
import { api, ApiError, type ServerArchive } from '../api'
interface Line {
  id: string
  runId: string
  sequence: number
  observedAt: string
  line: string
}
interface Command {
  id: string
  action: string
  command: string
  status: string
  createdAt: string
  message: string
  requestedBy: string
}
interface Snapshot {
  serverId: string
  serverName: string
  hostId: string | null
  online: boolean
  console: { runId: string; state: string; pid: number | null; heartbeatAt: string } | null
  lines: Line[]
  cursor: string
  truncated: boolean
  commands: Command[]
}
const props = defineProps<{ scope: string; servers: ServerArchive[] }>()
const emit = defineEmits<{ select: [serverId: string]; error: [error: unknown] }>()
const snapshot = ref<Snapshot | null>(null),
  lines = ref<Line[]>([]),
  input = ref(''),
  error = ref(''),
  notice = ref(''),
  sending = ref(false),
  following = ref(true),
  logBox = ref<HTMLElement>()
const confirmation = ref<HTMLDialogElement>(),
  pendingControl = ref<{ action: string; serverId: string; runId: string; name: string } | null>(
    null,
  )
let cursor = '0',
  timer: ReturnType<typeof setTimeout> | undefined,
  controller: AbortController | undefined,
  generation = 0,
  disposed = false
const target = computed(() => props.servers.find((s) => s.id === props.scope))
const states: Record<string, string> = {
  RUNNING: t('m1158'),
  STOPPED: t('m1314'),
  STARTING: t('m1159'),
  STOPPING: t('m1315'),
  ERROR: t('m1316'),
  DISCONNECTED: t('m1317'),
}
const statuses: Record<string, string> = {
  QUEUED: t('m1318'),
  DELIVERED: t('m0462'),
  SUBMITTED: t('m1319'),
  SUCCEEDED: t('m1320'),
  FAILED: t('m1321'),
  UNCERTAIN: t('m1322'),
  EXPIRED: t('m1323'),
}
const actions: Record<string, string> = {
  START: t('m1324'),
  STOP: t('m1325'),
  RESTART: t('m1326'),
  COMMAND: t('m1327'),
}
const available = computed(() =>
  Boolean(
    snapshot.value?.online &&
    !error.value &&
    target.value?.status === 'RECORDING' &&
    !sending.value &&
    !snapshot.value.commands.some((c) => ['QUEUED', 'DELIVERED'].includes(c.status)),
  ),
)
const running = computed(() => snapshot.value?.console?.state === 'RUNNING')
const canStart = computed(() => ['STOPPED', 'ERROR'].includes(snapshot.value?.console?.state ?? ''))
const time = (value: string) => new Date(value).toLocaleTimeString(formatLocale, { hour12: false })
async function refresh(epoch = generation) {
  if (disposed || epoch !== generation || !target.value) return
  const server = target.value.id
  controller = new AbortController()
  try {
    const result = await api<Snapshot>(`/servers/${server}/console?after=${cursor}`, {
      signal: controller.signal,
    })
    if (disposed || epoch !== generation || server !== props.scope) return
    snapshot.value = result
    error.value = ''
    cursor = result.cursor
    if (result.truncated) notice.value = t('m1328')
    const seen = new Set(lines.value.map((l) => l.id))
    lines.value = [...lines.value, ...result.lines.filter((l) => !seen.has(l.id))].slice(-2000)
    if (following.value) {
      await nextTick()
      if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight
    }
  } catch (e) {
    if (epoch !== generation || controller.signal.aborted) return
    error.value = e instanceof Error ? e.message : t('m1329')
    if (e instanceof ApiError && e.status === 401) emit('error', e)
  } finally {
    if (!disposed && epoch === generation) timer = setTimeout(() => void refresh(epoch), 2000)
  }
}
watch(
  () => [props.scope, props.servers.length],
  () => {
    generation++
    clearTimeout(timer)
    controller?.abort()
    confirmation.value?.close()
    pendingControl.value = null
    cursor = '0'
    snapshot.value = null
    lines.value = []
    input.value = ''
    error.value = ''
    notice.value = ''
    void refresh()
  },
  { immediate: true },
)
onScopeDispose(() => {
  disposed = true
  generation++
  clearTimeout(timer)
  controller?.abort()
})
function cancelControl() {
  confirmation.value?.close()
  pendingControl.value = null
}
async function confirmControl() {
  const pending = pendingControl.value
  confirmation.value?.close()
  pendingControl.value = null
  if (
    !pending ||
    pending.serverId !== props.scope ||
    pending.runId !== snapshot.value?.console?.runId
  ) {
    notice.value = t('m1330')
    return
  }
  await submit(pending.action, undefined, true)
}
async function submit(action: string, quick?: string, confirmed = false) {
  const current = snapshot.value,
    server = target.value
  if (!available.value || !current?.hostId || !current.console || !server) return
  const command = action === 'COMMAND' ? (quick ?? input.value).trim() : ''
  if (action === 'COMMAND' && !command) return
  if (['STOP', 'RESTART'].includes(action) && !confirmed) {
    pendingControl.value = {
      action,
      serverId: server.id,
      runId: current.console.runId,
      name: server.name,
    }
    confirmation.value?.showModal()
    return
  }
  const epoch = generation
  sending.value = true
  notice.value = ''
  try {
    const result = await api<Command>(`/servers/${server.id}/console/commands`, {
      method: 'POST',
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        hostId: current.hostId,
        runId: current.console.runId,
        action,
        command,
      }),
    })
    if (epoch !== generation) return
    current.commands = [result, ...current.commands.filter((c) => c.id !== result.id)].slice(0, 30)
    notice.value = t('m1331')
    if (action === 'COMMAND') input.value = ''
  } catch (e) {
    if (epoch !== generation) return
    notice.value = e instanceof Error ? e.message : t('m1332')
    notice.value += t('m1333')
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <section class="panel console-workspace">
    <dialog
      ref="confirmation"
      class="console-confirm"
      aria-labelledby="console-confirm-title"
      @cancel="pendingControl = null"
    >
      <h2 id="console-confirm-title">{{ t('m1334', [actions[pendingControl?.action ?? 'STOP']]) }}</h2>
      <p>{{ t('m1335') }}<strong>{{ pendingControl?.name }}</strong>
      </p>
      <p>{{ t('m1337', [pendingControl?.action === 'RESTART' ? t('m1336') : '']) }}
      </p>
      <div>
        <button
          class="secondary"
          autofocus
          @click="cancelControl"
        >{{ t('m0102') }}</button
        ><button class="primary" @click="confirmControl">{{ t('m1334', [actions[pendingControl?.action ?? 'STOP']]) }}
        </button>
      </div>
    </dialog>
    <div class="console-heading">
      <div>
        <h2><Terminal :size="22" />{{ target?.name ?? t('m1338') }}</h2>
        <p>{{ t('m1339') }}</p>
      </div>
      <select
        :value="target?.id ?? ''"
        :aria-label="t('m1340')"
        @change="emit('select', ($event.target as HTMLSelectElement).value)"
      >
        <option disabled value="">{{ t('m1341') }}</option>
        <option v-for="server in servers" :key="server.id" :value="server.id">
          {{ server.name }}
        </option>
      </select>
    </div>
    <p v-if="error" class="alert error" role="alert">{{ error }}</p>
    <template v-if="target">
      <div class="console-toolbar">
        <span class="console-state" :class="{ live: snapshot?.online && running }"
          ><span class="status-dot" />{{
            snapshot?.online
              ? states[snapshot.console?.state ?? '']
              : snapshot
                ? t('m1342')
                : t('m1343')
          }}</span
        >
        <span v-if="snapshot?.console?.pid" class="console-muted"
          >{{ t('m1344', [snapshot.console.pid]) }}</span
        >
        <div class="console-buttons">
          <button class="primary" :disabled="!available || !canStart" @click="submit('START')">
            <Play :size="16" />{{ t('m1324') }}</button>
          <button class="secondary" :disabled="!available || !running" @click="submit('STOP')">
            <Square :size="16" />{{ t('m1325') }}</button>
          <button class="secondary" :disabled="!available || !running" @click="submit('RESTART')">
            <RotateCw :size="16" />{{ t('m1326') }}</button>
        </div>
      </div>
      <p v-if="target.status === 'ARCHIVED'" class="console-note">{{ t('m1345') }}</p>
      <div v-if="snapshot && !snapshot.console" class="console-connect">
        <h3>{{ t('m1346') }}</h3>
        <p>{{ t('m1347') }}</p>
        <p>{{ t('m1348') }}</p>
      </div>
      <div class="log-heading">
        <span><ScrollText :size="16" />{{ t('m1349') }}</span
        ><label><input v-model="following" type="checkbox" />{{ t('m1350') }}</label
        ><button class="text-button" @click="lines = []">{{ t('m1351') }}</button>
      </div>
      <div ref="logBox" class="console-log" role="region" :aria-label="t('m1352')" tabindex="0">
        <p v-if="!lines.length" class="console-log-empty">
          {{
            snapshot?.online
              ? t('m1353')
              : t('m1354')
          }}
        </p>
        <div v-for="line in lines" :key="line.id" class="console-line">
          <time>{{ time(line.observedAt) }}</time
          ><span>{{ line.line }}</span>
        </div>
      </div>
      <form class="command-form" @submit.prevent="submit('COMMAND')">
        <label for="game-command">{{ t('m1327') }}</label>
        <div>
          <input
            id="game-command"
            v-model="input"
            autocomplete="off"
            maxlength="1000"
            :placeholder="t('m1355')"
            :disabled="!available || !running"
          /><button class="primary" :disabled="!available || !running || !input.trim()">
            <Send :size="16" />{{ t('m1356') }}</button>
        </div>
      </form>
      <div class="console-shortcuts">
        <span>{{ t('m1357') }}</span
        ><button
          class="secondary"
          :disabled="!available || !running"
          @click="submit('COMMAND', 'list')"
        >{{ t('m1358') }}</button
        ><button
          class="secondary"
          :disabled="!available || !running"
          @click="submit('COMMAND', 'time query daytime')"
        >{{ t('m1359') }}</button>
      </div>
      <p v-if="notice" class="console-note" role="status">{{ notice }}</p>
      <details class="console-help">
        <summary>{{ t('m1360') }}</summary>
        <p>{{ t('m1361') }}</p>
        <code>{{ t('m1362') }}</code>
        <p>{{ t('m1363') }}</p>
      </details>
      <div class="console-history">
        <h3>{{ t('m1364') }}</h3>
        <p v-if="!snapshot?.commands.length" class="console-muted">{{ t('m1365') }}</p>
        <article v-for="command in snapshot?.commands" :key="command.id">
          <div>
            <strong>{{ actions[command.action] }}</strong
            ><code v-if="command.command">{{ command.command }}</code
            ><small>{{ time(command.createdAt) }} · {{ command.requestedBy }}</small>
          </div>
          <span>{{ statuses[command.status] ?? command.status }}</span>
          <p v-if="command.message">{{ command.message }}</p>
        </article>
      </div>
    </template>
  </section>
</template>

<style scoped>
.console-confirm {
  max-width: 460px;
  width: calc(100% - 32px);
  padding: 24px;
  border: 1px solid #dbe7e2;
  border-radius: 16px;
  box-sizing: border-box;
}
.console-confirm::backdrop {
  background: #122b3b80;
}
.console-confirm p {
  line-height: 1.8;
  font-size: 14px;
}
.console-confirm > div {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 20px;
}
.console-workspace {
  padding: 24px;
  min-width: 0;
}
.console-heading,
.console-toolbar,
.console-buttons,
.log-heading,
.log-heading > span,
.console-shortcuts,
h2 {
  display: flex;
  align-items: center;
  gap: 12px;
}
.console-heading {
  justify-content: space-between;
  align-items: flex-start;
  flex-wrap: wrap;
}
.console-heading h2 {
  margin: 0;
  font-size: 20px;
}
.console-heading p,
.console-muted {
  color: #718580;
  font-size: 13px;
}
.console-heading select {
  max-width: 100%;
  width: 290px;
}
.console-toolbar {
  flex-wrap: wrap;
  margin: 20px 0;
}
.console-buttons {
  margin-left: auto;
  flex-wrap: wrap;
}
.console-state {
  display: flex;
  align-items: center;
  gap: 8px;
  background: #f0f3f5;
  padding: 9px 12px;
  border-radius: 20px;
  font-size: 14px;
  font-weight: 600;
}
.console-state.live {
  background: #e5f6ed;
  color: #087847;
}
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #94a3b8;
}
.live .status-dot {
  background: #16a86d;
}
.log-heading {
  background: #eaf0f7;
  padding: 12px 14px;
  border-radius: 12px 12px 0 0;
  font-size: 13px;
  flex-wrap: wrap;
}
.log-heading label {
  margin-left: auto;
  display: flex;
  gap: 6px;
  align-items: center;
}
.log-heading input {
  width: auto;
}
.console-log {
  height: 420px;
  overflow: auto;
  background: #111d2d;
  color: #d8e7ed;
  padding: 16px;
  border-radius: 0 0 12px 12px;
  font:
    13px/1.7 Consolas,
    monospace;
  overflow-wrap: anywhere;
}
.console-line {
  display: flex;
  gap: 16px;
  white-space: pre-wrap;
}
.console-line time {
  color: #8297b1;
  flex-shrink: 0;
}
.console-line > span {
  min-width: 0;
}
.console-log-empty {
  color: #9badc3;
}
.command-form {
  margin-top: 16px;
}
.command-form > label {
  display: block;
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 8px;
}
.command-form > div {
  display: flex;
  gap: 10px;
}
.command-form input {
  flex: 1;
  min-width: 0;
  font-family: Consolas, monospace;
}
.console-shortcuts {
  margin-top: 12px;
  flex-wrap: wrap;
  font-size: 13px;
}
.console-shortcuts button {
  font-size: 12px;
  padding: 6px 12px;
}
.console-note {
  background: #fff6e3;
  color: #77541d;
  padding: 12px;
  border-radius: 8px;
  font-size: 13px;
}
.console-connect {
  background: #edf7f2;
  padding: 16px;
  border-radius: 12px;
  margin-bottom: 16px;
}
.console-connect h3 {
  margin-top: 0;
}
.console-connect p,
.console-help p {
  font-size: 13px;
  line-height: 1.8;
}
.console-help {
  margin-top: 20px;
}
.console-help code {
  display: block;
  overflow-wrap: anywhere;
  font-size: 12px;
}
.console-history {
  margin-top: 24px;
}
.console-history article {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
  padding: 12px 0;
  border-top: 1px solid #e8edf2;
  font-size: 13px;
}
.console-history article > div {
  display: flex;
  flex: 1;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
  min-width: 0;
}
.console-history code {
  overflow-wrap: anywhere;
}
.console-history small {
  color: #718580;
}
.console-history article > p {
  width: 100%;
  margin: 0;
  color: #718580;
  font-size: 12px;
}
@media (max-width: 650px) {
  .console-workspace {
    padding: 14px;
  }
  .console-buttons {
    margin-left: 0;
    width: 100%;
    gap: 6px;
  }
  .console-buttons button {
    flex: 1;
    padding: 10px 8px;
  }
  .console-log {
    height: 360px;
    padding: 10px;
    font-size: 12px;
  }
  .console-line {
    gap: 8px;
  }
  .console-heading h2 {
    font-size: 17px;
  }
  .console-heading select {
    width: 100%;
  }
  .log-heading label {
    margin-left: 0;
  }
  .console-history article {
    align-items: flex-start;
  }
  .console-history article > div {
    flex-basis: 100%;
  }
}
</style>
