<script setup lang="ts">
import { t } from '../i18n'

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
  MANUAL: t('m0432'),
  AUTOMATIC: t('m0433'),
  FINAL: t('m0434'),
}
const taskLabels: Record<string, string> = {
  QUEUED: t('m0231'),
  CLAIMED: t('m0232'),
  RUNNING: t('m1133'),
  UPLOADING: t('m1134'),
  SUCCEEDED: t('m1135'),
  FAILED: t('m0235'),
  UNCERTAIN: t('m0236'),
  CANCELLED: t('m0237'),
}
const diagnostics: Record<string, string> = {
  POLICY_CHANGED: t('m1136'),
  SERVER_ARCHIVED: t('m1137'),
  CAPTURE_FAILED: t('m1138'),
  UPLOAD_FAILED: t('m1139'),
  EXECUTION_INTERRUPTED: t('m1140'),
  LOCAL_ARCHIVE_INVALID: t('m1141'),
  EXECUTION_EXPIRED: t('m1142'),
  RUNNER_CHANGED: t('m1143'),
  CREDENTIAL_CHANGED: t('m1144'),
  ACCESS_REVOKED: t('m1145'),
  CLAIM_EXPIRED: t('m1146'),
  OPERATOR_RESOLVED: t('m0249'),
  OPERATOR_CANCELLED: t('m1147'),
}
const title = computed(() =>
  token.value
    ? t('m1148')
    : {
        host: t('m1149'),
        rotate: t('m1150'),
        revoke: t('m1151'),
        job: t('m1152'),
        cancel: t('m1153'),
        resolve: t('m1154'),
      }[action.value],
)
function serverName(id: string) {
  return props.servers.find((server) => server.id === id)?.name ?? t('m0044')
}
function hostStatus(host: Host) {
  if (host.revoked) return t('m0341')
  if (!host.heartbeatAt) return t('m0268')
  if (host.runtimeState === 'STOPPED')
    return host.online && host.restoreEnabled ? t('m1155') : t('m1156')
  if (!host.online) return t('m1157')
  return (
    (
      { RUNNING: t('m1158'), STARTING: t('m1159'), ERROR: t('m1160') } as Record<
        string,
        string
      >
    )[host.runtimeState ?? ''] ?? t('m1161')
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
          throw new Error(t('m1162'))
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
      message.value = t('m1164', [taskLabels[result.status] ?? t('m1163')])
      emit('changed')
    } else if (action.value === 'revoke') {
      await api(`/backup-hosts/${selectedHost.value!.id}`, {
        method: 'DELETE',
        signal: abort.signal,
      })
      message.value = t('m1165')
    } else if (action.value === 'cancel') {
      const result = await api<Job>(`/backup-jobs/${selectedJob.value!.id}/cancel`, {
        method: 'POST',
        signal: abort.signal,
      })
      message.value =
        result.status === 'CANCELLED'
          ? t('m1166')
          : result.cancelRequested
            ? t('m1167')
            : t('m1168')
    } else {
      await api(`/backup-jobs/${selectedJob.value!.id}/resolve`, {
        method: 'POST',
        signal: abort.signal,
        body: JSON.stringify({ outcome: outcome.value, note: note.value.trim() }),
      })
      message.value = t('m1169')
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
      formError.value = t('m1170')
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
    formError.value = t('m0610')
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
  <section class="remote-backups" :aria-label="t('m1171')">
    <article class="panel data-panel">
      <div class="data-panel-heading">
        <div>
          <h2><Monitor :size="20" />{{ t('m1171') }}</h2>
          <p>{{ t('m1172') }}</p>
        </div>
        <div class="remote-actions">
          <button class="secondary" :disabled="busy" @click="refresh">
            <RefreshCw :size="16" />{{ t('m1173') }}</button
          ><button
            class="secondary"
            data-create-backup-host
            :disabled="!ready || !unregistered.length"
            @click="open('host')"
          >
            <Plus :size="16" />{{ t('m1174') }}</button
          ><button
            class="primary"
            data-create-backup-task
            :disabled="!ready || !hosts.some((host) => !host.revoked)"
            @click="open('job')"
          >{{ t('m1175') }}</button>
        </div>
      </div>
      <p v-if="loadError" class="alert error" role="alert">
        {{ loadError }}<button class="text-button" @click="refresh">{{ t('m1176') }}</button>
      </p>
      <p v-else-if="busy && !ready" class="small-empty" role="status">{{ t('m1177') }}</p>
      <p v-else-if="!hosts.length" class="small-empty">
        {{
          !scopedServers.length
            ? t('m1178')
            : t('m1179')
        }}
      </p>
      <div v-for="host in hosts" :key="host.id" :data-backup-host="host.id" class="remote-host">
        <div>
          <strong>{{ host.name }}</strong>
          <p>{{ serverName(host.serverId) }}</p>
          <span class="neutral-badge">{{ hostStatus(host) }}</span>
          <p class="data-note">{{ t('m1181', [host.heartbeatAt ? displayTime(host.heartbeatAt) : t('m1180')]) }}<span v-if="host.version">{{ t('m1182', [host.version]) }}</span>
          </p>
        </div>
        <div class="remote-actions">
          <button class="secondary" :disabled="!ready" @click="open('rotate', host)">
            {{ host.revoked ? t('m0344') : t('m0345') }}</button
          ><button
            v-if="!host.revoked"
            class="text-button"
            :disabled="!ready"
            @click="open('revoke', host)"
          >{{ t('m1151') }}</button>
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
    <div v-if="pending" class="alert" role="status">{{ t('m1183') }}<button
        class="text-button"
        :disabled="!ready"
        @click="open('job', undefined, true)"
      >{{ t('m1184') }}</button>
    </div>
    <article v-for="job in jobs" :key="job.id" :data-backup-job="job.id" class="panel remote-job">
      <div class="remote-job-heading">
        <div>
          <h3>{{ serverName(job.serverId) }}</h3>
          <p>
            {{ kindLabels[job.kind] ?? t('m0420') }}
            · {{ displayTime(job.createdAt) }}
          </p>
        </div>
        <span class="neutral-badge" :class="{ 'remote-attention': job.status === 'UNCERTAIN' }">{{
          job.cancelRequested && !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(job.status)
            ? t('m1185')
            : job.status === 'SUCCEEDED' && job.archiveStatus !== 'READY'
              ? t('m1186')
              : (taskLabels[job.status] ?? t('m1187'))
        }}</span>
      </div>
      <p v-if="job.note" class="remote-note">{{ job.note }}</p>
      <p v-if="job.status === 'QUEUED'" class="data-note">{{ t('m1188') }}</p>
      <p v-if="job.status === 'UNCERTAIN'" class="data-note">{{ t('m1189') }}</p>
      <p v-if="job.errorCode" class="data-note">
        {{ diagnostics[job.errorCode] ?? t('m1190') }}
      </p>
      <p v-if="job.resolutionNote" class="data-note">{{ t('m1191', [job.resolutionNote]) }}</p>
      <div class="remote-actions">
        <a
          v-if="job.status === 'SUCCEEDED' && job.backupId && job.archiveStatus === 'READY'"
          class="secondary"
          :href="`/api/backups/${job.backupId}/content`"
          download
          ><Download :size="16" />{{ t('m1192') }}</a
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
          {{ ['QUEUED', 'CLAIMED'].includes(job.status) ? t('m1193') : t('m1194') }}
        </button>
        <button
          v-if="job.status === 'UNCERTAIN'"
          class="secondary"
          :disabled="!ready"
          @click="open('resolve', job)"
        >{{ t('m1195') }}</button>
      </div>
      <details class="remote-details">
        <summary>{{ t('m1196') }}</summary>
        <dl>
          <dt>{{ t('m1197') }}</dt>
          <dd>
            <code>{{ job.id }}</code>
          </dd>
          <dt>{{ t('m0595') }}</dt>
          <dd>{{ job.startedAt ? displayTime(job.startedAt) : t('m1198') }}</dd>
          <dt>{{ t('m1199') }}</dt>
          <dd>{{ job.completedAt ? displayTime(job.completedAt) : t('m0057') }}</dd>
          <dt>{{ t('m1200') }}</dt>
          <dd>{{ job.permanent ? t('m0481') : t('m1201') }}</dd>
        </dl>
        <p class="data-note">{{ t('m1202') }}</p>
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
            :aria-label="t('m1203')"
            :disabled="working"
            @click="close"
          >
            <X :size="19" />
          </button>
        </div>
        <template v-if="token">
          <p class="dialog-description">{{ t('m1204') }}</p>
          <label
            >{{ t('m1205') }}<textarea
              ref="tokenField"
              :value="token"
              readonly
              rows="3"
              spellcheck="false"
            /></label
          ><button type="button" class="secondary" @click="copyToken">
            <Copy :size="16" />{{ copied ? t('m0353') : t('m0351') }}
          </button>
          <p class="data-note">{{ t('m1206') }}</p>
          <label>{{ t('m1207') }}<input v-model="apiOrigin" type="url" autocomplete="off" /></label
          ><label
            >{{ t('m1208') }}<input
              v-model="rootPath"
              :placeholder="t('m1209')"
              autocomplete="off" /></label
          ><label
            >{{ t('m1210') }}<input
              v-model="outputPath"
              placeholder="D:\ArchiveBackups"
              autocomplete="off"
          /></label>
          <label v-if="originState.privateHttp" class="remote-check"
            ><input v-model="allowHttp" type="checkbox" />{{ t('m1211') }}</label
          >
          <label
            >{{ t('m1212') }}<input
              v-model="restorePath"
              placeholder="D:\MinecraftRestores"
              autocomplete="off"
          /></label>
          <p class="data-note">{{ t('m1213') }}</p>
          <p v-if="!originState.valid" class="data-note">{{ t('m1214') }}</p>
          <p class="data-note">{{ t('m1215') }}</p>
        </template>
        <template v-else-if="action === 'host'">
          <label
            >{{ t('m1216') }}<select ref="first" v-model="serverId" :disabled="working" required>
              <option v-for="server in unregistered" :key="server.id" :value="server.id">
                {{ server.name }}
              </option>
            </select></label
          >
          <label
            >{{ t('m1217') }}<input
              v-model="name"
              required
              maxlength="64"
              :disabled="working"
              :placeholder="t('m1218')"
              autocomplete="off"
          /></label>
          <p class="data-note">{{ t('m1219') }}</p>
        </template>
        <template v-else-if="action === 'job'">
          <label
            >{{ t('m1220') }}<select
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
                : t('m1221')
            }}
          </p>
          <label
            >{{ t('m0521') }}<select v-model="kind" :disabled="working || !!taskDraft">
              <option value="MANUAL">{{ t('m0432') }}</option>
              <option value="FINAL">{{ t('m1222') }}</option>
            </select></label
          >
          <label
            >{{ t('m1223') }}<textarea
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
            />{{ kind === 'FINAL' ? t('m0526') : t('m1224') }}</label
          >
          <p class="data-note">{{ t('m1225') }}</p>
        </template>
        <template v-else-if="action === 'resolve' && selectedJob">
          <p class="dialog-description">
            {{ t('m1226', [serverName(selectedJob!.serverId)]) }}</p>
          <label
            >{{ t('m1195') }}<select ref="first" v-model="outcome" :disabled="working">
              <option value="FAILED">{{ t('m1227') }}</option>
              <option value="CANCELLED">{{ t('m1228') }}</option>
            </select></label
          ><label
            >{{ t('m1229') }}<input
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
              ? t('m1230')
              : action === 'revoke'
                ? t('m1231')
                : t('m1232')
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
            >{{ t('m1233') }}</button
            ><button type="button" class="primary" @click="close">{{ t('m0362') }}</button></template
          >
          <template v-else
            ><button type="button" class="secondary" :disabled="working" @click="close">{{ t('m0416') }}</button
            ><button
              class="primary"
              :disabled="
                working || (action === 'job' && !taskDraft && (!targetHost || targetHost.revoked))
              "
            >
              {{
                working
                  ? t('m0303')
                  : {
                      host: t('m1174'),
                      rotate: t('m0367'),
                      revoke: t('m1151'),
                      job: taskDraft ? t('m1234') : t('m1235'),
                      cancel: t('m1236'),
                      resolve: t('m1237'),
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
