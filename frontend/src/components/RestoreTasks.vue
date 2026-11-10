<script setup lang="ts">
import { t } from '../i18n'

import { computed, nextTick, onMounted, onScopeDispose, ref, watch } from 'vue'
import { FolderOpen, RefreshCw, ShieldCheck, X } from '@lucide/vue'
import { api, ApiError, type ServerArchive } from '../api'
import { displayTime, failure, query } from '../statistics'
import { newRequestId } from '../ids'
import {
  restoreModes,
  supportsWorldBackup,
  restoreStates,
  restoreDiagnostics,
  validRestoreDraft,
  validRestoreFolder,
  formatRestoreBytes,
  type RestoreSource,
  type RestoreHost,
  type RestoreJob,
  type RestoreDraft,
} from '../restores'
import { useResource } from '../useResource'
import PaginationControl from './PaginationControl.vue'
const props = defineProps<{ servers: ServerArchive[]; scope: string; revision: number }>()
const emit = defineEmits<{ error: [error: unknown]; changed: []; archivesChanged: [] }>()
const page = ref(1),
  working = ref(false),
  opening = ref(false),
  modal = ref<HTMLDialogElement>(),
  heading = ref<HTMLElement>(),
  first = ref<HTMLElement>()
const action = ref<'create' | 'cancel' | 'resolve'>('create'),
  step = ref(1),
  source = ref<RestoreSource>(),
  selectedJob = ref<RestoreJob>()
const mode = ref<RestoreDraft['mode']>('DISABLED'),
  hostId = ref(''),
  folder = ref(''),
  note = ref(''),
  forkName = ref(''),
  forkDate = ref(''),
  outcome = ref('FAILED'),
  acknowledged = ref(false),
  delegated = ref(false),
  formError = ref(''),
  message = ref('')
const proposal = ref<RestoreDraft>(),
  pending = ref<RestoreDraft>()
const storageKey = 'mcmanager.pending-restore.v1'
let opener: HTMLElement | null = null,
  timer: ReturnType<typeof setInterval> | undefined,
  disposed = false
let refreshAfterMutation: Promise<void> | undefined
const { data, busy, error, refresh } = useResource(
  () => [props.scope, props.revision, page.value],
  async (signal) => {
    const [hosts, jobs] = await Promise.all([
      api<RestoreHost[]>('/backup-hosts', { signal }),
      api<{ items: RestoreJob[]; total: number }>(
        '/restores' + query(props.scope, undefined, { page: page.value - 1, size: 10 }),
        { signal },
      ),
    ])
    return { hosts, ...jobs }
  },
  (ex) => emit('error', ex),
)
watch(
  () => props.scope,
  () => {
    page.value = 1
  },
)
const sourceServer = computed(() =>
  props.servers.find((server) => server.id === source.value?.serverId),
)
const canContinue = computed(() => sourceServer.value?.status === 'RECORDING')
const eligible = computed(() =>
  (data.value?.hosts ?? []).filter(
    (host) =>
      !host.revoked &&
      host.restoreEnabled &&
      (source.value?.summary?.archiveScope !== 'WORLD' || supportsWorldBackup(host.version)) &&
      (mode.value !== 'CONTINUE' || host.serverId === source.value?.serverId),
  ),
)
const host = computed(() => data.value?.hosts.find((host) => host.id === hostId.value))
const crossHost = computed(() =>
  Boolean(host.value && source.value && host.value.serverId !== source.value.serverId),
)
const valid = computed(
  () =>
    source.value?.status === 'READY' &&
    eligible.value.some((host) => host.id === hostId.value) &&
    validRestoreFolder(folder.value) &&
    (mode.value !== 'CONTINUE' || canContinue.value) &&
    (mode.value !== 'FORK' || (forkName.value.trim().length > 0 && Boolean(forkDate.value))) &&
    (!crossHost.value || delegated.value),
)
const title = computed(() =>
  action.value === 'create'
    ? step.value === 1
      ? t('m0515')
      : t('m1238')
    : action.value === 'cancel'
      ? t('m1239')
      : t('m1240'),
)
function serverName(id: string) {
  return props.servers.find((server) => server.id === id)?.name ?? id
}
function hostName(id: string) {
  return data.value?.hosts.find((host) => host.id === id)?.name ?? id
}
function keep(value?: RestoreDraft) {
  if (value) {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(value))
    } catch {
      const error = new Error(t('m1241'))
      error.name = 'RestoreStorageError'
      throw error
    }
    pending.value = value
  } else {
    pending.value = undefined
    try {
      sessionStorage.removeItem(storageKey)
    } catch {
      /* A stale saved draft can only retry the original idempotent request. */
    }
  }
}
function readPending() {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null')
    if (validRestoreDraft(value))
      pending.value = {
        backupId: value.backupId,
        requestId: value.requestId,
        hostId: value.hostId,
        mode: value.mode,
        destinationName: value.destinationName,
        note: value.note,
        forkName: value.forkName,
        forkStartDate: value.forkStartDate,
      }
  } catch {
    /* Never submit invalid browser state. */
  }
}
function applyDraft(value: RestoreDraft) {
  proposal.value = { ...value }
  mode.value = value.mode
  hostId.value = value.hostId
  folder.value = value.destinationName
  note.value = value.note
  forkName.value = value.forkName ?? ''
  forkDate.value = value.forkStartDate ?? ''
}
async function open(backup?: RestoreSource) {
  if (working.value || opening.value) return
  opening.value = true
  opener = document.activeElement as HTMLElement
  formError.value = ''
  action.value = 'create'
  selectedJob.value = undefined
  acknowledged.value = false
  delegated.value = false
  proposal.value = undefined
  mode.value = 'DISABLED'
  folder.value = ''
  note.value = ''
  forkName.value = ''
  forkDate.value = new Date().toLocaleDateString('sv-SE')
  step.value = 1
  try {
    if (pending.value) {
      source.value = await api<RestoreSource>('/backups/' + pending.value.backupId)
      applyDraft(pending.value)
      step.value = 2
    } else {
      source.value = backup
      hostId.value = ''
    }
    await refresh()
    if (!proposal.value)
      hostId.value =
        eligible.value.find((host) => host.serverId === backup?.serverId)?.id ??
        eligible.value[0]?.id ??
        ''
    await nextTick()
    modal.value?.showModal()
    first.value?.focus()
  } catch (ex) {
    message.value = failure(ex)
    emit('error', ex)
  } finally {
    opening.value = false
  }
}
function changeMode() {
  delegated.value = false
  if (!eligible.value.some((host) => host.id === hostId.value))
    hostId.value = eligible.value[0]?.id ?? ''
}
function review() {
  if (!source.value || !valid.value) return
  proposal.value = {
    backupId: source.value.id,
    requestId: newRequestId(),
    hostId: hostId.value,
    mode: mode.value,
    destinationName: folder.value,
    note: note.value.trim(),
    forkName: mode.value === 'FORK' ? forkName.value.trim() : null,
    forkStartDate: mode.value === 'FORK' ? forkDate.value : null,
  }
  step.value = 2
  acknowledged.value = false
  nextTick(() => {
    modal.value?.scrollTo({ top: 0 })
    heading.value?.focus({ preventScroll: true })
  })
}
function back() {
  if (!pending.value) {
    step.value = 1
    proposal.value = undefined
    formError.value = ''
    nextTick(() => first.value?.focus())
  }
}
async function manage(kind: 'cancel' | 'resolve', job: RestoreJob) {
  opener = document.activeElement as HTMLElement
  action.value = kind
  selectedJob.value = job
  formError.value = ''
  note.value = ''
  outcome.value = 'FAILED'
  await nextTick()
  modal.value?.showModal()
  first.value?.focus()
}
function close() {
  if (!working.value) modal.value?.close()
}
async function afterClose() {
  if (disposed) return
  await refreshAfterMutation
  if (disposed) return
  await nextTick()
  if (opener?.isConnected && opener !== document.body && opener.getClientRects().length)
    opener.focus()
  else document.querySelector<HTMLButtonElement>('[data-refresh-restores]')?.focus()
}
async function perform() {
  if (working.value) return
  if (action.value === 'create' && step.value === 1) {
    review()
    return
  }
  if (action.value === 'create' && (!proposal.value || !acknowledged.value)) return
  if (action.value === 'resolve' && (!note.value.trim() || /[\p{Cc}]/u.test(note.value.trim())))
    return
  working.value = true
  formError.value = ''
  message.value = ''
  const abort = new AbortController(),
    timeout = setTimeout(() => abort.abort(), 20000)
  try {
    if (action.value === 'create') {
      const saved = proposal.value!
      keep(saved)
      const { backupId, ...body } = saved
      const result = await api<RestoreJob>('/backups/' + backupId + '/restores', {
        method: 'POST',
        signal: abort.signal,
        body: JSON.stringify(body),
      })
      keep()
      message.value = t('m1242') + (restoreStates[result.status] ?? t('m1187')) + '。'
      if (saved.mode === 'FORK') emit('archivesChanged')
    } else if (action.value === 'cancel') {
      const result = await api<RestoreJob>('/restores/' + selectedJob.value!.id + '/cancel', {
        method: 'POST',
        signal: abort.signal,
      })
      message.value =
        result.status === 'CANCELLED'
          ? t('m1243')
          : result.cancelRequested
            ? t('m1244')
            : t('m1168')
    } else {
      await api('/restores/' + selectedJob.value!.id + '/resolve', {
        method: 'POST',
        signal: abort.signal,
        body: JSON.stringify({ outcome: outcome.value, note: note.value.trim() }),
      })
      message.value = t('m1245')
    }
    refreshAfterMutation = refresh()
    modal.value?.close()
    emit('changed')
    await refreshAfterMutation
    refreshAfterMutation = undefined
  } catch (ex) {
    if (ex instanceof Error && ex.name === 'RestoreStorageError') formError.value = ex.message
    else if (
      action.value === 'create' &&
      proposal.value &&
      (!(ex instanceof ApiError) || [401, 403, 408, 429].includes(ex.status) || ex.status >= 500)
    )
      formError.value = t('m1246')
    else {
      formError.value = failure(ex)
      if (
        action.value === 'create' &&
        ex instanceof ApiError &&
        [400, 404, 409].includes(ex.status)
      ) {
        keep()
        proposal.value = undefined
        step.value = 1
      }
    }
    emit('error', ex)
    await refresh()
  } finally {
    clearTimeout(timeout)
    working.value = false
  }
}
onMounted(() => {
  readPending()
  timer = setInterval(() => {
    if (
      !busy.value &&
      !working.value &&
      !modal.value?.open &&
      document.visibilityState === 'visible'
    )
      void refresh()
  }, 5000)
})
onScopeDispose(() => {
  disposed = true
  clearInterval(timer)
  modal.value?.close()
})
defineExpose({ open })
</script>
<template>
  <section class="restore-workspace" :aria-label="t('m1247')">
    <article class="panel data-panel">
      <div class="data-panel-heading">
        <div>
          <h2>{{ t('m1248') }}</h2>
          <p>{{ t('m1249') }}</p>
        </div>
        <button data-refresh-restores class="secondary" :disabled="busy" @click="refresh">
          <RefreshCw :size="16" />{{ t('m1250') }}</button>
      </div>
      <p class="data-note">
        <ShieldCheck
          :size="16"
        />{{ t('m1251') }}</p>
    </article>
    <p v-if="pending" class="alert info">{{ t('m1252') }}<button class="text-button" @click="open()">{{ t('m1184') }}</button>
    </p>
    <p v-if="message" class="alert info" role="status">{{ message }}</p>
    <p v-if="error" class="alert error" role="alert">
      {{ error }}<button class="text-button" @click="refresh">{{ t('m1253') }}</button>
    </p>
    <p v-else-if="busy" class="data-note" role="status">{{ t('m1254') }}</p>
    <article
      v-for="job in data?.items ?? []"
      :key="job.id"
      class="panel restore-card"
      :data-restore="job.id"
    >
      <div class="data-panel-heading">
        <div>
          <h3>{{ serverName(job.sourceServerId) }} → {{ serverName(job.targetServerId) }}</h3>
          <p>
            {{ restoreModes[job.mode as keyof typeof restoreModes] }} ·
            {{ displayTime(job.createdAt) }}
          </p>
        </div>
        <span class="neutral-badge">{{
          job.cancelRequested && ['RUNNING', 'UNCERTAIN'].includes(job.status)
            ? t('m1255')
            : (restoreStates[job.status] ?? t('m0837'))
        }}</span>
      </div>
      <p class="data-note">
        <FolderOpen :size="16" />{{ t('m1256', [hostName(job.hostId), job.destinationName]) }}
      </p>
      <p v-if="job.note" class="restore-note">{{ job.note }}</p>
      <p v-if="job.status === 'READY'" class="alert info">{{ t('m1257') }}</p>
      <p v-else-if="job.status === 'UNCERTAIN'" class="alert info">{{ t('m1258') }}</p>
      <p v-else-if="job.status === 'QUEUED'" class="data-note">{{ t('m1259') }}</p>
      <p v-if="job.errorCode" class="data-note">
        {{ restoreDiagnostics[job.errorCode] ?? t('m1260') }}
      </p>
      <p v-if="job.resolutionNote" class="data-note">{{ t('m1261', [job.resolutionNote]) }}</p>
      <div class="restore-actions">
        <button
          v-if="['QUEUED', 'CLAIMED', 'RUNNING'].includes(job.status) && !job.cancelRequested"
          class="secondary"
          :disabled="busy || !!error"
          @click="manage('cancel', job)"
        >
          {{ job.status === 'RUNNING' ? t('m1262') : t('m1239') }}</button
        ><button
          v-if="job.status === 'UNCERTAIN'"
          class="secondary"
          :disabled="busy || !!error"
          @click="manage('resolve', job)"
        >{{ t('m1263') }}</button>
      </div>
      <details class="restore-proof">
        <summary>{{ t('m1264') }}</summary>
        <dl>
          <dt>{{ t('m1197') }}</dt>
          <dd>
            <code>{{ job.id }}</code>
          </dd>
          <dt>{{ t('m1265') }}</dt>
          <dd>
            <code>{{ job.sourceBackupId }}</code>
          </dd>
          <dt>{{ t('m1266') }}</dt>
          <dd>
            <code>{{ job.targetServerId }}</code>
          </dd>
          <dt>{{ t('m1267') }}</dt>
          <dd>
            <code>{{ job.archiveSha256 }}</code>
          </dd>
          <dt>{{ t('m1268') }}</dt>
          <dd>{{ job.fileCount }} / {{ formatRestoreBytes(job.archiveBytes) }}</dd>
          <dt>{{ t('m1269') }}</dt>
          <dd>
            <code>{{ job.restorationId ?? t('m0057') }}</code>
          </dd>
        </dl>
        <p class="data-note">{{ t('m1270') }}</p>
      </details>
    </article>
    <PaginationControl
      v-if="(data?.total ?? 0) > 10"
      :page="page"
      :total="data?.total ?? 0"
      :page-size="10"
      :busy="busy"
      @change="page = $event"
    />
    <dialog
      ref="modal"
      class="credential-dialog restore-dialog"
      aria-labelledby="restore-title"
      @cancel="working ? $event.preventDefault() : undefined"
      @close="afterClose"
    >
      <form @submit.prevent="perform">
        <div class="dialog-heading">
          <h2 id="restore-title" ref="heading" tabindex="-1">{{ title }}</h2>
          <button
            type="button"
            class="icon-button"
            :aria-label="t('m1271')"
            :disabled="working"
            @click="close"
          >
            <X :size="20" />
          </button>
        </div>
        <template v-if="action === 'create' && source">
          <p class="dialog-description">{{ t('m1272', [serverName(source.serverId), source.fileCount ?? t('m0227'), formatRestoreBytes(source.archiveBytes)]) }}
          </p>
          <template v-if="step === 1">
            <label
              >{{ t('m1273') }}<select
                ref="first"
                v-model="mode"
                :aria-label="t('m1273')"
                @change="changeMode"
              >
                <option value="DISABLED">{{ t('m1274') }}</option>
                <option
                  value="CONTINUE"
                  :disabled="!canContinue || source?.summary?.archiveScope === 'WORLD'"
                >{{ t('m1276', [canContinue ? '' : t('m1275')]) }}
                </option>
                <option value="FORK" :disabled="source?.summary?.archiveScope === 'WORLD'">{{ t('m0230') }}</option>
              </select></label
            >
            <p class="data-note">
              {{
                source?.summary?.archiveScope === 'WORLD'
                  ? t('m1277')
                  : mode === 'CONTINUE'
                    ? t('m1278')
                    : mode === 'FORK'
                      ? t('m1279')
                      : t('m1280')
              }}
            </p>
            <label
              >{{ t('m1281') }}<select
                v-model="hostId"
                :aria-label="t('m1281')"
                required
                @change="delegated = false"
              >
                <option value="" disabled>{{ t('m1282') }}</option>
                <option v-for="item in eligible" :key="item.id" :value="item.id">
                  {{ item.name }} · {{ serverName(item.serverId) }} ·
                  {{
                    item.online
                      ? item.runtimeState === 'STOPPED'
                        ? t('m1283')
                        : t('m1161')
                      : t('m1284')
                  }}
                </option>
              </select></label
            >
            <p v-if="!eligible.length" class="data-note">{{ t('m1285') }}</p>
            <label v-if="crossHost" class="restore-check"
              ><input v-model="delegated" type="checkbox" />{{ t('m1286', [host?.name]) }}</label
            >
            <label
              >{{ t('m1287') }}<input
                v-model="folder"
                required
                maxlength="64"
                :placeholder="t('m1288')"
                autocomplete="off"
            /></label>
            <p class="data-note">{{ t('m1289') }}</p>
            <template v-if="mode === 'FORK'"
              ><label
                >{{ t('m1290') }}<input
                  v-model="forkName"
                  required
                  maxlength="64"
                  autocomplete="off" /></label
              ><label>{{ t('m1291') }}<input v-model="forkDate" type="date" required /></label
            ></template>
            <label>{{ t('m1292') }}<textarea v-model="note" rows="2" maxlength="1000" /></label>
          </template>
          <template v-else-if="proposal">
            <dl class="restore-review">
              <dt>{{ t('m1293') }}</dt>
              <dd>{{ displayTime(source.snapshotAt ?? source.createdAt) }}</dd>
              <dt>{{ t('m1273') }}</dt>
              <dd>{{ restoreModes[proposal.mode] }}</dd>
              <dt>{{ t('m1294') }}</dt>
              <dd>{{ hostName(proposal.hostId) }} · {{ serverName(host?.serverId ?? '') }}</dd>
              <dt>{{ t('m1295') }}</dt>
              <dd>{{ proposal.destinationName }}</dd>
              <dt>{{ t('m1296') }}</dt>
              <dd>
                {{
                  proposal.mode === 'FORK'
                    ? proposal.forkName + ' · ' + proposal.forkStartDate
                    : serverName(source.serverId) + t('m1297')
                }}
              </dd>
              <dt>{{ t('m1298') }}</dt>
              <dd>
                <code>{{ source.sha256 ?? t('m0227') }}</code>
              </dd>
              <dt>{{ t('m1299') }}</dt>
              <dd>
                {{ t('m1300', [source.summary?.statistics?.cacheIntegrity === 'VERIFIED'
                    ? t('m0506')
                    : t('m0507'), source.summary?.statistics?.pendingEvents ?? t('m0508')]) }}
              </dd>
              <dt>{{ t('m0510') }}</dt>
              <dd>
                {{ displayTime(source.summary?.statistics?.latestAcknowledgedEventAt)
                }}<small class="data-note">{{ t('m1301') }}</small>
              </dd>
            </dl>
            <p class="alert info">{{ t('m1302') }}</p>
            <label class="restore-check"
              ><input
                ref="first"
                v-model="acknowledged"
                :disabled="working"
                type="checkbox"
              />{{ t('m1303') }}</label
            >
          </template>
        </template>
        <template v-else-if="selectedJob"
          ><p class="dialog-description">
            {{ hostName(selectedJob.hostId) }} · {{ selectedJob.destinationName }}
          </p>
          <p class="alert info">
            {{
              action === 'cancel'
                ? t('m1304')
                : t('m1305')
            }}
          </p>
          <template v-if="action === 'resolve'"
            ><label
              >{{ t('m1306') }}<select
                ref="first"
                v-model="outcome"
                :aria-label="t('m1306')"
                :disabled="working"
              >
                <option value="FAILED">{{ t('m1227') }}</option>
                <option value="CANCELLED">{{ t('m1228') }}</option>
              </select></label
            ><label
              >{{ t('m1307') }}<input
                v-model="note"
                :disabled="working"
                required
                maxlength="1000"
                autocomplete="off" /></label></template
        ></template>
        <p v-if="formError" class="alert error" role="alert">{{ formError }}</p>
        <div class="dialog-actions">
          <button type="button" class="secondary" :disabled="working" @click="close">{{ t('m0416') }}</button
          ><button
            v-if="action === 'create' && step === 2 && !pending"
            type="button"
            class="secondary"
            :disabled="working"
            @click="back"
          >{{ t('m1308') }}</button
          ><button
            class="primary"
            :disabled="
              working ||
              (action === 'create' && (step === 1 ? !valid : !acknowledged)) ||
              (action === 'resolve' && (!note.trim() || /[\p{Cc}]/u.test(note.trim())))
            "
          >
            {{
              working
                ? t('m0303')
                : action === 'create'
                  ? step === 1
                    ? t('m1309')
                    : pending
                      ? t('m1310')
                      : t('m1311')
                  : action === 'cancel'
                    ? t('m1312')
                    : t('m1313')
            }}
          </button>
        </div>
      </form>
    </dialog>
  </section>
</template>
<style scoped>
.restore-workspace {
  display: grid;
  gap: 16px;
  min-width: 0;
}
.restore-card {
  padding: 22px;
  min-width: 0;
}
.restore-card h3,
.restore-note {
  overflow-wrap: anywhere;
}
.restore-note {
  white-space: pre-wrap;
  font-size: 13px;
}
.restore-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 14px;
}
.restore-proof {
  margin-top: 16px;
  border-top: 1px solid #e2e9e5;
  padding-top: 12px;
}
.restore-proof summary {
  cursor: pointer;
  color: #527064;
  font-size: 12px;
}
.restore-proof dl,
.restore-review {
  display: grid;
  grid-template-columns: minmax(90px, 0.7fr) minmax(0, 2fr);
  gap: 12px;
  font-size: 12px;
  margin: 18px 0;
}
.restore-proof dt,
.restore-review dt {
  color: #6d7e74;
}
.restore-proof dd,
.restore-review dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.restore-check {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  gap: 10px;
  line-height: 1.7;
  font-size: 13px;
}
.restore-check input {
  width: 17px;
  height: 17px;
  margin-top: 3px;
  flex-shrink: 0;
}
@media (max-width: 560px) {
  .restore-card {
    padding: 18px;
  }
  .restore-proof dl,
  .restore-review {
    grid-template-columns: 1fr;
    gap: 7px;
  }
  .restore-review dd,
  .restore-proof dd {
    margin-bottom: 5px;
  }
}
</style>
