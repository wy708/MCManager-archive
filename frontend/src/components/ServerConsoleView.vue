<script setup lang="ts">
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
  RUNNING: '游戏运行中',
  STOPPED: '游戏已停止',
  STARTING: '正在启动',
  STOPPING: '正在保存并停服',
  ERROR: '需要检查',
  DISCONNECTED: '执行端已断开',
}
const statuses: Record<string, string> = {
  QUEUED: '等待领取',
  DELIVERED: '处理中',
  SUBMITTED: '已发送，请看日志',
  SUCCEEDED: '已完成',
  FAILED: '失败',
  UNCERTAIN: '结果待核对',
  EXPIRED: '已过期，未执行',
}
const actions: Record<string, string> = {
  START: '启动',
  STOP: '正常停服',
  RESTART: '重启',
  COMMAND: '游戏命令',
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
const time = (value: string) => new Date(value).toLocaleTimeString('zh-CN', { hour12: false })
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
    if (result.truncated) notice.value = '日志较多，已跳转到最近记录。平台保留最近 2000 行。'
    const seen = new Set(lines.value.map((l) => l.id))
    lines.value = [...lines.value, ...result.lines.filter((l) => !seen.has(l.id))].slice(-2000)
    if (following.value) {
      await nextTick()
      if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight
    }
  } catch (e) {
    if (epoch !== generation || controller.signal.aborted) return
    error.value = e instanceof Error ? e.message : '控制台连接失败'
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
    notice.value = '服务器连接已改变，请重新确认操作。'
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
    notice.value = '操作已排队，执行结果会显示在下方记录中。'
    if (action === 'COMMAND') input.value = ''
  } catch (e) {
    if (epoch !== generation) return
    notice.value = e instanceof Error ? e.message : '发送结果未确认'
    notice.value += '；请查看操作记录后再决定是否重试。'
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
      <h2 id="console-confirm-title">确认{{ actions[pendingControl?.action ?? 'STOP'] }}</h2>
      <p>
        目标服务器：<strong>{{ pendingControl?.name }}</strong>
      </p>
      <p>
        在线玩家会断开。执行端会先结束备份任务，再正常保存世界并停服。{{
          pendingControl?.action === 'RESTART' ? '保存完成后会重新启动游戏。' : ''
        }}
      </p>
      <div>
        <button
          class="secondary"
          autofocus
          @click="cancelControl"
        >
          取消</button
        ><button class="primary" @click="confirmControl">
          确认{{ actions[pendingControl?.action ?? 'STOP'] }}
        </button>
      </div>
    </dialog>
    <div class="console-heading">
      <div>
        <h2><Terminal :size="22" />{{ target?.name ?? '选择要管理的服务器' }}</h2>
        <p>这里发送的是游戏命令。运行状态和日志来自这台服务器的执行端。</p>
      </div>
      <select
        :value="target?.id ?? ''"
        aria-label="控制台服务器"
        @change="emit('select', ($event.target as HTMLSelectElement).value)"
      >
        <option disabled value="">请选择服务器</option>
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
                ? '执行端未连接'
                : '正在连接…'
          }}</span
        >
        <span v-if="snapshot?.console?.pid" class="console-muted"
          >游戏进程 {{ snapshot.console.pid }}</span
        >
        <div class="console-buttons">
          <button class="primary" :disabled="!available || !canStart" @click="submit('START')">
            <Play :size="16" />启动
          </button>
          <button class="secondary" :disabled="!available || !running" @click="submit('STOP')">
            <Square :size="16" />正常停服
          </button>
          <button class="secondary" :disabled="!available || !running" @click="submit('RESTART')">
            <RotateCw :size="16" />重启
          </button>
        </div>
      </div>
      <p v-if="target.status === 'ARCHIVED'" class="console-note">
        这是已封存的档案，仅可查看历史日志。
      </p>
      <div v-if="snapshot && !snapshot.console" class="console-connect">
        <h3>先连接这台游戏服务器</h3>
        <p>
          在备份中心添加对应执行端，再使用带网页控制台的启动程序启动游戏。已有备份执行端可沿用凭据。
        </p>
        <p>正在其他窗口运行的游戏需要先正常停服，再交给控制台启动；接入后不需要新增公网端口。</p>
      </div>
      <div class="log-heading">
        <span><ScrollText :size="16" />游戏日志</span
        ><label><input v-model="following" type="checkbox" />跟随最新日志</label
        ><button class="text-button" @click="lines = []">清空当前显示</button>
      </div>
      <div ref="logBox" class="console-log" role="region" aria-label="游戏控制台日志" tabindex="0">
        <p v-if="!lines.length" class="console-log-empty">
          {{
            snapshot?.online
              ? '等待游戏输出…'
              : '连接后将在这里显示日志。已有记录在执行端离线时仍可查看。'
          }}
        </p>
        <div v-for="line in lines" :key="line.id" class="console-line">
          <time>{{ time(line.observedAt) }}</time
          ><span>{{ line.line }}</span>
        </div>
      </div>
      <form class="command-form" @submit.prevent="submit('COMMAND')">
        <label for="game-command">游戏命令</label>
        <div>
          <input
            id="game-command"
            v-model="input"
            autocomplete="off"
            maxlength="1000"
            placeholder="例如 list，查看在线玩家"
            :disabled="!available || !running"
          /><button class="primary" :disabled="!available || !running || !input.trim()">
            <Send :size="16" />发送
          </button>
        </div>
      </form>
      <div class="console-shortcuts">
        <span>常用查询</span
        ><button
          class="secondary"
          :disabled="!available || !running"
          @click="submit('COMMAND', 'list')"
        >
          在线玩家</button
        ><button
          class="secondary"
          :disabled="!available || !running"
          @click="submit('COMMAND', 'time query daytime')"
        >
          游戏时间
        </button>
      </div>
      <p v-if="notice" class="console-note" role="status">{{ notice }}</p>
      <details class="console-help">
        <summary>连接方式与日志说明</summary>
        <p>
          在游戏主机运行项目中的
          console-host.mjs，使用原执行端配置。启动程序需要一直运行，游戏停止后网页才仍能再次启动它。
        </p>
        <code>node backup/src/console-host.mjs --config "你的执行端配置.json" --start</code>
        <p>
          页面每两秒更新；保留最近 2000 行日志与最近 500 次操作，下面显示最近 30
          次。日志只从接入后开始记录。游戏命令显示“已发送”仅表示已写入控制台，是否生效请看游戏输出。断线期间不会积压新的控制命令，结果不明的操作不会自动重发。
        </p>
      </details>
      <div class="console-history">
        <h3>最近操作</h3>
        <p v-if="!snapshot?.commands.length" class="console-muted">暂无操作记录</p>
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
