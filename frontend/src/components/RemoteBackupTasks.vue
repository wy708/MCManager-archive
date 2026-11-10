<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, ref, watch } from 'vue'
import { Copy, Download, Monitor, Plus, RefreshCw, X } from '@lucide/vue'
import { api, ApiError, type ServerArchive } from '../api'
import { newRequestId } from '../ids'
import { displayTime, failure } from '../statistics'
import PaginationControl from './PaginationControl.vue'
import BackupPolicies from './BackupPolicies.vue'

interface Host {
  id: string
  serverId: string
  name: string
  revoked: boolean
  online: boolean
  heartbeatAt: string | null
  runtimeState: string | null
  version: string | null
  restoreEnabled?: boolean
}
interface Job {
  id: string
  hostId: string
  serverId: string
  kind: string
  note: string
  permanent: boolean
  status: string
  cancelRequested: boolean
  backupId: string | null
  archiveStatus: string | null
  errorCode: string | null
  resolutionNote: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}
interface TaskDraft {
  requestId: string
  serverId: string
  hostId: string
  kind: string
  note: string
  permanent: boolean
}
const props = defineProps<{
  servers: ServerArchive[]
  scope: string
  revision: number
  includePolicies?: boolean
}>()
const emit = defineEmits<{ error: [error: unknown]; changed: [] }>()
const hosts = ref<Host[]>([]),
  jobs = ref<Job[]>([]),
  total = ref(0),
  page = ref(1)
const busy = ref(false),
  loadError = ref(''),
  loadedScope = ref(''),
  message = ref('')
let sequence = 0,
  controller: AbortController | undefined,
  timer: ReturnType<typeof setInterval> | undefined
const modal = ref<HTMLDialogElement>(),
  first = ref<HTMLElement>(),
  tokenField = ref<HTMLTextAreaElement>()
const action = ref<'host' | 'rotate' | 'revoke' | 'job' | 'cancel' | 'resolve'>('job')
const selectedHost = ref<Host>(),
  selectedJob = ref<Job>(),
  serverId = ref(''),
  name = ref(''),
  note = ref('')
const kind = ref('MANUAL'),
  permanent = ref(false),
  outcome = ref('FAILED')
const token = ref(''),
  copied = ref(false),
  working = ref(false),
  formError = ref(''),
  taskDraft = ref<TaskDraft>()
const rootPath = ref(''),
  outputPath = ref(''),
  restorePath = ref(''),
  apiOrigin = ref(window.location.origin),
  allowHttp = ref(false)
const storageKey = 'mcmanager.pending-backup-task.v1',
  pending = ref<TaskDraft>()
let opener: HTMLElement | null = null,
  mutated = false,
  disposed = false
const scopedServers = computed(() =>
  props.servers.filter((server) => props.scope === 'all' || server.id === props.scope),
)
const targetHost = computed(() => hosts.value.find((host) => host.serverId === serverId.value))
const unregistered = computed(() =>
  scopedServers.value.filter((server) => !hosts.value.some((host) => host.serverId === server.id)),
)
const ready = computed(() => loadedScope.value === props.scope && !loadError.value)
const jobServers = computed(() =>
  taskDraft.value
    ? props.servers.filter((server) => server.id === taskDraft.value!.serverId)
    : scopedServers.value,
)
const kindLabels: Record<string, string> = {
  MANUAL: '手动备份',
  AUTOMATIC: '自动备份',
  FINAL: '最终封存',
}
const taskLabels: Record<string, string> = {
  QUEUED: '等待执行',
  CLAIMED: '已领取',
  RUNNING: '正在制作',
  UPLOADING: '正在上传校验',
  SUCCEEDED: '归档已保存',
  FAILED: '已失败',
  UNCERTAIN: '结果待核实',
  CANCELLED: '已取消',
}
const diagnostics: Record<string, string> = {
  POLICY_CHANGED: '策略已关闭或重新安排，尚未开始的旧任务已取消。',
  SERVER_ARCHIVED: '服务器已封存，自动任务已取消。',
  CAPTURE_FAILED: '制作未完成，请检查游戏主机上的诊断。',
  UPLOAD_FAILED: '上传未确认，原文件保留在游戏主机。',
  EXECUTION_INTERRUPTED: '执行进程中断，需核对原任务。',
  LOCAL_ARCHIVE_INVALID: '原归档校验未通过，文件仍保留在主机。',
  EXECUTION_EXPIRED: '执行租约已过期，不能自动重做。',
  RUNNER_CHANGED: '运行实例已改变，需核对原任务。',
  CREDENTIAL_CHANGED: '凭据已轮换，需核对原任务。',
  ACCESS_REVOKED: '执行端连接密钥已停用。',
  CLAIM_EXPIRED: '尚未开始的领取已过期，任务重新等待。',
  OPERATOR_RESOLVED: '已保存人工处理结果。',
  OPERATOR_CANCELLED: '执行程序已确认取消。',
}
const title = computed(() =>
  token.value
    ? '保存游戏主机配置'
    : {
        host: '添加备份执行端',
        rotate: '轮换备份程序连接密钥',
        revoke: '停用备份程序',
        job: '创建在线备份任务',
        cancel: '取消备份任务',
        resolve: '处理不确定任务',
      }[action.value],
)
function serverName(id: string) {
  return props.servers.find((server) => server.id === id)?.name ?? '服务器档案'
}
function hostStatus(host: Host) {
  if (host.revoked) return '连接密钥已停用'
  if (!host.heartbeatAt) return '尚未连接'
  if (host.runtimeState === 'STOPPED')
    return host.online && host.restoreEnabled ? '恢复维护中' : '执行程序已停止'
  if (!host.online) return '暂无近期心跳'
  return (
    (
      { RUNNING: '游戏运行中', STARTING: '正在启动', ERROR: '需要检查主机' } as Record<
        string,
        string
      >
    )[host.runtimeState ?? ''] ?? '已连接'
  )
}
function storePending(value?: TaskDraft) {
  pending.value = value
  try {
    if (value) sessionStorage.setItem(storageKey, JSON.stringify(value))
    else sessionStorage.removeItem(storageKey)
  } catch {
    /* The current modal still retains its stable request. */
  }
}
function readPending() {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null')
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    if (
      value &&
      ['requestId', 'serverId', 'hostId'].every(
        (key) => typeof value[key] === 'string' && uuid.test(value[key]),
      ) &&
      ['MANUAL', 'FINAL'].includes(value.kind) &&
      typeof value.note === 'string' &&
      value.note.length <= 1000 &&
      typeof value.permanent === 'boolean'
    )
      pending.value = {
        requestId: value.requestId,
        serverId: value.serverId,
        hostId: value.hostId,
        kind: value.kind,
        note: value.note,
        permanent: value.permanent,
      }
  } catch {
    /* Invalid local state never becomes a task request. */
  }
}
async function refresh() {
  if (disposed) return
  const current = ++sequence,
    scope = props.scope,
    currentPage = page.value
  controller?.abort()
  controller = new AbortController()
  busy.value = true
  if (loadedScope.value !== scope) {
    hosts.value = []
    jobs.value = []
    total.value = 0
  }
  try {
    const filter = scope === 'all' ? '' : `serverId=${scope}`
    const [hostRows, jobPage] = await Promise.all([
      api<Host[]>(`/backup-hosts${filter ? '?' + filter : ''}`, { signal: controller.signal }),
      api<{ items: Job[]; total: number }>(
        `/backup-jobs?page=${currentPage - 1}&size=10${filter ? '&' + filter : ''}`,
        { signal: controller.signal },
      ),
    ])
    if (current !== sequence) return
    if (
      jobPage.items.some(
        (job) =>
          job.status === 'SUCCEEDED' &&
          !jobs.value.some((previous) => previous.id === job.id && previous.status === 'SUCCEEDED'),
      )
    )
      emit('changed')
    hosts.value = hostRows
    jobs.value = jobPage.items
    total.value = jobPage.total
    loadedScope.value = scope
    loadError.value = ''
  } catch (error) {
    if (current === sequence && !(error instanceof DOMException && error.name === 'AbortError')) {
      loadError.value = failure(error)
      emit('error', error)
    }
  } finally {
    if (current === sequence) busy.value = false
  }
}
watch(
  () => [props.scope, props.revision],
  () => {
    page.value = 1
    void refresh()
  },
  { immediate: true },
)
watch(page, () => void refresh())
onMounted(() => {
  readPending()
  timer = setInterval(() => {
    if (
      !working.value &&
      !modal.value?.open &&
      document.visibilityState === 'visible' &&
      !busy.value
    )
      void refresh()
  }, 5000)
})
onScopeDispose(() => {
  disposed = true
  sequence++
  controller?.abort()
  clearInterval(timer)
  token.value = ''
  modal.value?.close()
})
async function open(mode: typeof action.value, entity?: Host | Job, recovery = false) {
  if (mode === 'job' && pending.value) recovery = true
  opener = document.activeElement as HTMLElement
  action.value = mode
  selectedHost.value = undefined
  selectedJob.value = undefined
  token.value = ''
  copied.value = false
  formError.value = ''
  mutated = false
  taskDraft.value = undefined
  name.value = ''
  note.value = ''
  kind.value = 'MANUAL'
  permanent.value = false
  outcome.value = 'FAILED'
  rootPath.value = ''
  outputPath.value = ''
  restorePath.value = ''
  apiOrigin.value = window.location.origin
  allowHttp.value = false
  if (mode === 'rotate' || mode === 'revoke') selectedHost.value = entity as Host
  if (mode === 'cancel' || mode === 'resolve') selectedJob.value = entity as Job
  serverId.value =
    selectedHost.value?.serverId ??
    selectedJob.value?.serverId ??
    (mode === 'host'
      ? unregistered.value[0]?.id
      : scopedServers.value.find((server) =>
          hosts.value.some((host) => host.serverId === server.id && !host.revoked),
        )?.id) ??
    scopedServers.value[0]?.id ??
    ''
  if (recovery && pending.value) {
    taskDraft.value = { ...pending.value }
    serverId.value = pending.value.serverId
    note.value = pending.value.note
    kind.value = pending.value.kind
    permanent.value = pending.value.permanent
  }
  await nextTick()
  modal.value?.showModal()
  first.value?.focus()
}
function close() {
  if (!working.value) modal.value?.close()
}
async function afterClose() {
  token.value = ''
  copied.value = false
  selectedHost.value = undefined
  selectedJob.value = undefined
  if (disposed) return
  if (mutated) await refresh()
  await nextTick()
  if (opener?.isConnected) opener.focus()
  else document.querySelector<HTMLButtonElement>('[data-create-backup-task]')?.focus()
}
async function perform() {
  if (working.value) return
  working.value = true
  formError.value = ''
  message.value = ''
  const abort = new AbortController(),
    timeout = setTimeout(() => abort.abort(), 20000)
  try {
    if (action.value === 'host' || action.value === 'rotate') {
      const issued = await api<{ host: Host; token: string }>(
        action.value === 'host'
          ? '/backup-hosts'
          : `/backup-hosts/${selectedHost.value!.id}/rotate`,
        {
          method: 'POST',
          signal: abort.signal,
          ...(action.value === 'host'
            ? { body: JSON.stringify({ serverId: serverId.value, name: name.value.trim() }) }
            : {}),
        },
      )
      selectedHost.value = issued.host
      serverId.value = issued.host.serverId
      token.value = issued.token
      mutated = true
      await nextTick()
      tokenField.value?.focus()
      tokenField.value?.select()
      return
    }
    if (action.value === 'job') {
      if (!taskDraft.value) {
        if (!targetHost.value || targetHost.value.revoked)
          throw new Error('请先连接或重新启用该服务器的执行端。')
        taskDraft.value = {
          requestId: newRequestId(),
          serverId: serverId.value,
          hostId: targetHost.value.id,
          kind: kind.value,
          note: note.value,
          permanent: permanent.value || kind.value === 'FINAL',
        }
      }
      storePending(taskDraft.value)
      const { serverId: target, ...body } = taskDraft.value
      const result = await api<Job>(`/servers/${target}/backup-jobs`, {
        method: 'POST',
        signal: abort.signal,
        body: JSON.stringify(body),
      })
      storePending()
      message.value = `任务已确认：${taskLabels[result.status] ?? '请查看任务列表'}。`
      emit('changed')
    } else if (action.value === 'revoke') {
      await api(`/backup-hosts/${selectedHost.value!.id}`, {
        method: 'DELETE',
        signal: abort.signal,
      })
      message.value = '执行端连接密钥已停用，历史记录仍保留。'
    } else if (action.value === 'cancel') {
      const result = await api<Job>(`/backup-jobs/${selectedJob.value!.id}/cancel`, {
        method: 'POST',
        signal: abort.signal,
      })
      message.value =
        result.status === 'CANCELLED'
          ? '任务已取消。'
          : result.cancelRequested
            ? '已请求取消，等待执行程序确认。'
            : '任务状态已更新，请查看结果。'
    } else {
      await api(`/backup-jobs/${selectedJob.value!.id}/resolve`, {
        method: 'POST',
        signal: abort.signal,
        body: JSON.stringify({ outcome: outcome.value, note: note.value.trim() }),
      })
      message.value = '处理结果已保存，原文件和诊断仍保留。'
    }
    mutated = true
    modal.value?.close()
    await refresh()
  } catch (error) {
    if (
      action.value === 'job' &&
      taskDraft.value &&
      (!(error instanceof ApiError) || [408, 429].includes(error.status) || error.status >= 500)
    ) {
      formError.value = '提交结果尚未确认。重试会核实同一个任务，不会重复下发。'
    } else {
      formError.value = failure(error)
      if (
        action.value === 'job' &&
        error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 401
      ) {
        taskDraft.value = undefined
        storePending()
      }
    }
    emit('error', error)
    await refresh()
  } finally {
    clearTimeout(timeout)
    working.value = false
  }
}
async function copyToken() {
  try {
    await navigator.clipboard.writeText(token.value)
    copied.value = true
  } catch {
    tokenField.value?.focus()
    tokenField.value?.select()
    formError.value = '自动复制不可用，请选中凭据后手动复制。'
  }
}
const originState = computed(() => {
  try {
    const url = new URL(apiOrigin.value)
    const valid =
      ['http:', 'https:'].includes(url.protocol) &&
      url.pathname === '/' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    return {
      valid,
      privateHttp:
        url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
      origin: url.origin,
    }
  } catch {
    return { valid: false, privateHttp: false, origin: '' }
  }
})
const configReady = computed(
  () =>
    token.value &&
    rootPath.value.trim() &&
    outputPath.value.trim() &&
    originState.value.valid &&
    (!originState.value.privateHttp || allowHttp.value),
)
function downloadConfig() {
  if (!configReady.value) return
  const blob = new Blob(
    [
      JSON.stringify(
        {
          apiUrl: originState.value.origin,
          token: token.value,
          root: rootPath.value.trim(),
          outputDirectory: outputPath.value.trim(),
          ...(restorePath.value.trim() ? { restoreDirectory: restorePath.value.trim() } : {}),
          serverId: serverId.value,
          ...(allowHttp.value ? { allowHttp: true } : {}),
        },
        null,
        2,
      ) + '\n',
    ],
    { type: 'application/json' },
  )
  const url = URL.createObjectURL(blob),
    link = document.createElement('a')
  link.href = url
  link.download = 'host.json'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
</script>

<template>
  <section class="remote-backups" aria-label="游戏主机与备份任务">
    <article class="panel data-panel">
      <div class="data-panel-heading">
        <div>
          <h2><Monitor :size="20" />游戏主机与备份任务</h2>
          <p>在这里开始备份，查看游戏主机是否完成了任务</p>
        </div>
        <div class="remote-actions">
          <button class="secondary" :disabled="busy" @click="refresh">
            <RefreshCw :size="16" />刷新任务</button
          ><button
            class="secondary"
            data-create-backup-host
            :disabled="!ready || !unregistered.length"
            @click="open('host')"
          >
            <Plus :size="16" />连接备份程序</button
          ><button
            class="primary"
            data-create-backup-task
            :disabled="!ready || !hosts.some((host) => !host.revoked)"
            @click="open('job')"
          >
            新建备份任务
          </button>
        </div>
      </div>
      <p v-if="loadError" class="alert error" role="alert">
        {{ loadError }}<button class="text-button" @click="refresh">重试任务列表</button>
      </p>
      <p v-else-if="busy && !ready" class="small-empty" role="status">正在加载执行端与任务…</p>
      <p v-else-if="!hosts.length" class="small-empty">
        {{
          !scopedServers.length
            ? '先添加服务器档案，再连接游戏主机。'
            : '当前范围尚未连接备份程序。安装宿主程序后即可接收任务。'
        }}
      </p>
      <div v-for="host in hosts" :key="host.id" :data-backup-host="host.id" class="remote-host">
        <div>
          <strong>{{ host.name }}</strong>
          <p>{{ serverName(host.serverId) }}</p>
          <span class="neutral-badge">{{ hostStatus(host) }}</span>
          <p class="data-note">
            最近联系：{{ host.heartbeatAt ? displayTime(host.heartbeatAt) : '尚未收到'
            }}<span v-if="host.version"> · 程序 {{ host.version }}</span>
          </p>
        </div>
        <div class="remote-actions">
          <button class="secondary" :disabled="!ready" @click="open('rotate', host)">
            {{ host.revoked ? '重新启用' : '更换连接密钥' }}</button
          ><button
            v-if="!host.revoked"
            class="text-button"
            :disabled="!ready"
            @click="open('revoke', host)"
          >
            停用备份程序
          </button>
        </div>
      </div>
    </article>
    <BackupPolicies
      v-if="includePolicies !== false"
      :servers="servers"
      :scope="scope"
      :revision="revision"
      :hosts="hosts"
      :ready="ready"
      @error="emit('error', $event)"
      @changed="refresh"
    />
    <p v-if="message" class="alert success" role="status">{{ message }}</p>
    <div v-if="pending" class="alert" role="status">
      上次任务提交尚未确认。<button
        class="text-button"
        :disabled="!ready"
        @click="open('job', undefined, true)"
      >
        核实上次提交
      </button>
    </div>
    <article v-for="job in jobs" :key="job.id" :data-backup-job="job.id" class="panel remote-job">
      <div class="remote-job-heading">
        <div>
          <h3>{{ serverName(job.serverId) }}</h3>
          <p>
            {{ kindLabels[job.kind] ?? '备份任务' }}
            · {{ displayTime(job.createdAt) }}
          </p>
        </div>
        <span class="neutral-badge" :class="{ 'remote-attention': job.status === 'UNCERTAIN' }">{{
          job.cancelRequested && !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(job.status)
            ? '正在请求取消'
            : job.status === 'SUCCEEDED' && job.archiveStatus !== 'READY'
              ? '已完成，归档已轮换或不可用'
              : (taskLabels[job.status] ?? '等待状态更新')
        }}</span>
      </div>
      <p v-if="job.note" class="remote-note">{{ job.note }}</p>
      <p v-if="job.status === 'QUEUED'" class="data-note">
        游戏主机连接并运行后领取，离线期间任务会等待。
      </p>
      <p v-if="job.status === 'UNCERTAIN'" class="data-note">
        先核对主机上的原归档。执行程序可续传已完成文件，没有完整文件时不会自动重做。
      </p>
      <p v-if="job.errorCode" class="data-note">
        {{ diagnostics[job.errorCode] ?? '请检查执行程序上的原始诊断。' }}
      </p>
      <p v-if="job.resolutionNote" class="data-note">处理说明：{{ job.resolutionNote }}</p>
      <div class="remote-actions">
        <a
          v-if="job.status === 'SUCCEEDED' && job.backupId && job.archiveStatus === 'READY'"
          class="secondary"
          :href="`/api/backups/${job.backupId}/content`"
          download
          ><Download :size="16" />下载任务归档</a
        >
        <button
          v-if="
            ['QUEUED', 'CLAIMED', 'RUNNING', 'UPLOADING'].includes(job.status) &&
            !job.cancelRequested
          "
          class="secondary"
          :disabled="!ready"
          @click="open('cancel', job)"
        >
          {{ ['QUEUED', 'CLAIMED'].includes(job.status) ? '取消任务' : '请求取消' }}
        </button>
        <button
          v-if="job.status === 'UNCERTAIN'"
          class="secondary"
          :disabled="!ready"
          @click="open('resolve', job)"
        >
          处理结果
        </button>
      </div>
      <details class="remote-details">
        <summary>查看任务记录</summary>
        <dl>
          <dt>任务编号</dt>
          <dd>
            <code>{{ job.id }}</code>
          </dd>
          <dt>开始时间</dt>
          <dd>{{ job.startedAt ? displayTime(job.startedAt) : '尚未开始' }}</dd>
          <dt>完成时间</dt>
          <dd>{{ job.completedAt ? displayTime(job.completedAt) : '尚未确认' }}</dd>
          <dt>保留设置</dt>
          <dd>{{ job.permanent ? '永久保留' : '按备份管理设置' }}</dd>
        </dl>
        <p class="data-note">任务完成表示归档已校验，实际恢复游玩仍需单独验证。</p>
      </details>
    </article>
    <PaginationControl
      v-if="total > 10"
      :page="page"
      :total="total"
      :page-size="10"
      :busy="busy"
      @change="page = $event"
    />
    <dialog
      ref="modal"
      class="credential-dialog remote-dialog"
      aria-labelledby="remote-dialog-title"
      @cancel="working ? $event.preventDefault() : undefined"
      @close="afterClose"
    >
      <form @submit.prevent="perform">
        <div class="dialog-heading">
          <div>
            <p class="eyebrow">GAME BACKUP</p>
            <h2 id="remote-dialog-title">{{ title }}</h2>
          </div>
          <button
            type="button"
            class="icon-button"
            aria-label="关闭执行端对话框"
            :disabled="working"
            @click="close"
          >
            <X :size="19" />
          </button>
        </div>
        <template v-if="token">
          <p class="dialog-description">
            凭据只显示这一次。保存到游戏目录之外，并仅交给这台游戏主机。
          </p>
          <label
            >备份程序连接密钥<textarea
              ref="tokenField"
              :value="token"
              readonly
              rows="3"
              spellcheck="false"
            /></label
          ><button type="button" class="secondary" @click="copyToken">
            <Copy :size="16" />{{ copied ? '已复制' : '复制连接密钥' }}
          </button>
          <p class="data-note">
            已有配置时更新 token 后，在游戏主机终端输入 host restart；需要新配置时填写下方路径。
          </p>
          <label>中央服务地址<input v-model="apiOrigin" type="url" autocomplete="off" /></label
          ><label
            >游戏目录<input
              v-model="rootPath"
              placeholder="D:\Minecraft\一期"
              autocomplete="off" /></label
          ><label
            >备份保存目录<input
              v-model="outputPath"
              placeholder="D:\ArchiveBackups"
              autocomplete="off"
          /></label>
          <label v-if="originState.privateHttp" class="remote-check"
            ><input v-model="allowHttp" type="checkbox" />确认使用可信局域网 HTTP</label
          >
          <label
            >恢复父目录（可选）<input
              v-model="restorePath"
              placeholder="D:\MinecraftRestores"
              autocomplete="off"
          /></label>
          <p class="data-note">
            启用恢复时，父目录须已创建，并与原游戏及宿主状态目录分开。先停服，再使用宿主 0.4.0
            或更新版本加 --maintenance 启动维护，不自动启动恢复出的游戏。
          </p>
          <p v-if="!originState.valid" class="data-note">
            填写不带路径、账号密码或查询参数的中央服务地址。
          </p>
          <p class="data-note">
            将下载的 host.json 放在游戏目录之外，使用宿主工具 remote.mjs 启动。
          </p>
        </template>
        <template v-else-if="action === 'host'">
          <label
            >关联服务器<select ref="first" v-model="serverId" :disabled="working" required>
              <option v-for="server in unregistered" :key="server.id" :value="server.id">
                {{ server.name }}
              </option>
            </select></label
          >
          <label
            >备份程序名称<input
              v-model="name"
              required
              maxlength="64"
              :disabled="working"
              placeholder="例如：一期生存服主机"
              autocomplete="off"
          /></label>
          <p class="data-note">
            每期服务器有一个独立执行端。添加后保存配置，安装并启动游戏主机上的宿主工具。
          </p>
        </template>
        <template v-else-if="action === 'job'">
          <label
            >备份服务器<select
              ref="first"
              v-model="serverId"
              :disabled="working || !!taskDraft"
              required
            >
              <option v-for="server in jobServers" :key="server.id" :value="server.id">
                {{ server.name }}
              </option>
            </select></label
          >
          <p class="data-note">
            {{
              targetHost
                ? `${targetHost.name} · ${hostStatus(targetHost)}`
                : '此服务器尚未连接备份程序。'
            }}
          </p>
          <label
            >备份用途<select v-model="kind" :disabled="working || !!taskDraft">
              <option value="MANUAL">手动备份</option>
              <option value="FINAL">最终封存备份</option>
            </select></label
          >
          <label
            >任务备注<textarea
              v-model="note"
              maxlength="1000"
              rows="3"
              :disabled="working || !!taskDraft"
            />
          </label>
          <label class="remote-check"
            ><input
              v-model="permanent"
              type="checkbox"
              :disabled="working || !!taskDraft || kind === 'FINAL'"
            />{{ kind === 'FINAL' ? '最终封存默认永久保留' : '永久保留这份备份' }}</label
          >
          <p class="data-note">
            离线任务会等待主机连接。最终封存是归档用途分类，不会自动停服或封存服务器档案。
          </p>
        </template>
        <template v-else-if="action === 'resolve' && selectedJob">
          <p class="dialog-description">
            {{
              serverName(selectedJob!.serverId)
            }}：先核对主机上的原归档和运行状态。处理会结束旧尝试，原文件和诊断仍保留；重新制作须另建任务。
          </p>
          <label
            >处理结果<select ref="first" v-model="outcome" :disabled="working">
              <option value="FAILED">标记失败</option>
              <option value="CANCELLED">标记取消</option>
            </select></label
          ><label
            >处理说明<input
              v-model="note"
              required
              maxlength="1000"
              :disabled="working"
              autocomplete="off"
          /></label>
        </template>
        <p v-else-if="selectedHost || selectedJob" class="dialog-description">
          {{
            selectedHost
              ? `${selectedHost.name} · ${serverName(selectedHost.serverId)}`
              : serverName(selectedJob!.serverId)
          }}。{{
            action === 'rotate'
              ? '旧凭据会立即失效，请更新游戏主机配置；已经开始的任务需要核对原结果。'
              : action === 'revoke'
                ? '执行端将失去任务访问权限。已开始的任务可能需要核对，历史记录仍保留。'
                : '尚未开始的任务可直接取消；已经开始的任务会等待执行程序安全收尾。'
          }}
        </p>
        <p v-if="formError" class="alert error" role="alert">{{ formError }}</p>
        <div class="dialog-actions">
          <template v-if="token"
            ><button
              type="button"
              class="secondary"
              :disabled="!configReady"
              @click="downloadConfig"
            >
              下载主机配置</button
            ><button type="button" class="primary" @click="close">已保存，关闭</button></template
          >
          <template v-else
            ><button type="button" class="secondary" :disabled="working" @click="close">返回</button
            ><button
              class="primary"
              :disabled="
                working || (action === 'job' && !taskDraft && (!targetHost || targetHost.revoked))
              "
            >
              {{
                working
                  ? '正在处理…'
                  : {
                      host: '连接备份程序',
                      rotate: '生成新连接密钥',
                      revoke: '停用备份程序',
                      job: taskDraft ? '重试并核实任务' : '创建任务',
                      cancel: '确认取消',
                      resolve: '保存处理结果',
                    }[action]
              }}
            </button></template
          >
        </div>
      </form>
    </dialog>
  </section>
</template>

<style scoped>
.remote-backups {
  display: grid;
  gap: 16px;
  min-width: 0;
}
.remote-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  align-items: center;
}
.remote-host {
  padding: 20px 24px;
  border-top: 1px solid #edf1ec;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  overflow-wrap: anywhere;
}
.remote-host p {
  font-size: 12px;
  line-height: 1.8;
  color: #728176;
  margin: 6px 0;
}
.remote-host .neutral-badge {
  display: inline-flex;
}
.remote-job {
  padding: 24px;
  min-width: 0;
}
.remote-job-heading {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  justify-content: space-between;
}
.remote-job-heading h3 {
  font-size: 16px;
  overflow-wrap: anywhere;
}
.remote-job-heading p {
  font-size: 11px;
  color: #728176;
  margin-top: 7px;
}
.remote-note {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 13px;
  line-height: 1.8;
  margin: 18px 0;
}
.remote-attention {
  background: #fff3d8;
  color: #896421;
}
.remote-details {
  margin-top: 18px;
  border-top: 1px solid #edf1ec;
  padding-top: 14px;
}
.remote-details summary {
  font-size: 11px;
  color: #607968;
  cursor: pointer;
}
.remote-details dl {
  display: grid;
  grid-template-columns: 86px minmax(0, 1fr);
  gap: 10px;
  font-size: 12px;
  margin-top: 15px;
  line-height: 1.8;
}
.remote-details dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.remote-dialog {
  width: min(620px, calc(100% - 32px));
}
.remote-dialog textarea {
  width: 100%;
  resize: vertical;
}
.remote-check {
  display: flex;
  align-items: center;
  gap: 10px;
}
.remote-check input {
  width: 16px;
  min-height: 16px;
  flex: none;
}
.remote-dialog .secondary {
  margin-top: 8px;
}
.remote-dialog .dialog-actions .secondary {
  margin-top: 0;
}
.remote-job .remote-actions {
  margin-top: 18px;
}
@media (max-width: 560px) {
  .remote-host {
    padding: 18px;
    align-items: stretch;
    flex-direction: column;
  }
  .remote-actions {
    align-items: stretch;
  }
  .remote-actions > * {
    justify-content: center;
  }
  .remote-job {
    padding: 18px;
  }
  .remote-job-heading {
    flex-wrap: wrap;
  }
  .remote-dialog .dialog-actions {
    position: sticky;
    bottom: -22px;
    background: #fff;
    padding-bottom: 8px;
    z-index: 1;
    flex-wrap: wrap;
  }
  .remote-dialog .dialog-actions > * {
    flex: 1;
    justify-content: center;
  }
  .remote-details dl {
    grid-template-columns: 1fr;
    gap: 4px;
  }
  .remote-details dd {
    margin-bottom: 9px;
  }
}
</style>
