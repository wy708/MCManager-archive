<script setup lang="ts">
import { t, formatLocale } from '../i18n'

import { computed, nextTick, ref, watch } from 'vue'
import {
  Download,
  HardDrive,
  RefreshCw,
  RotateCcw,
  Upload,
  X,
  Folder,
  ArrowLeft,
  Search,
  Server,
} from '@lucide/vue'
import { api, ApiError, uploadBackup, type ServerArchive } from '../api'
import { useResource } from '../useResource'
import { displayTime, failure } from '../statistics'
import PaginationControl from './PaginationControl.vue'
import RemoteBackupTasks from './RemoteBackupTasks.vue'
import BackupPolicies from './BackupPolicies.vue'
import RestoreTasks from './RestoreTasks.vue'
import { newRequestId } from '../ids'

interface Backup {
  id: string
  serverId: string
  sourceBackupId: string | null
  kind: 'MANUAL' | 'AUTOMATIC' | 'FINAL'
  status: string
  note: string
  permanent: boolean
  expectedBytes: string
  receivedBytes: string
  archiveBytes: string | null
  sourceBytes: string | null
  fileCount: number | null
  sha256: string | null
  failureCode: string | null
  interrupted: boolean
  snapshotAt: string | null
  createdAt: string
  summary: {
    snapshotMode?: 'STOPPED' | 'BDS_SAVE_QUERY'
    archiveScope?: 'FULL' | 'WORLD'
    worldDirectory?: string
    statistics?: {
      cacheIntegrity?: string
      pendingEvents?: string | null
      latestAcknowledgedEventAt?: string | null
    }
    runtime?: {
      bds?: { version?: string }
      plugins?: { name: string | null; version: string | null }[]
    }
  } | null
}
interface Catalog {
  items: Backup[]
  total: number
  maxUploadBytes: string
}
const props = defineProps<{ servers: ServerArchive[]; scope: string; revision: number }>()
const emit = defineEmits<{ error: [error: unknown]; archivesChanged: [] }>()
const restores = ref<InstanceType<typeof RestoreTasks>>()
interface Group {
  serverId: string
  total: number
  readyCount: number
  archiveBytes: string
  latestReadyAt: string | null
}
const tab = ref<'files' | 'tasks' | 'schedule' | 'restores'>('files')
const tabs = [
  { id: 'files', label: t('m0419') },
  { id: 'tasks', label: t('m0420') },
  { id: 'schedule', label: t('m0421') },
  { id: 'restores', label: t('m0422') },
] as const
const savedServer = () => {
  try {
    return localStorage.getItem('mcmanager.backups.server') ?? ''
  } catch {
    return ''
  }
}
const chosenServer = ref(savedServer())
const currentServer = computed(() => {
  const id = props.scope === 'all' ? chosenServer.value : props.scope
  return props.servers.some((server) => server.id === id) ? id : ''
})
const currentName = computed(
  () => props.servers.find((server) => server.id === currentServer.value)?.name ?? '',
)
const page = ref(1),
  pageSize = ref(10),
  stateFilter = ref(''),
  kindFilter = ref(''),
  fromDate = ref(''),
  toDate = ref('')
const folderSearch = ref(''),
  folderPage = ref(1)
const dateError = computed(() =>
  fromDate.value && toDate.value && fromDate.value > toDate.value ? t('m0423') : '',
)
watch(
  () => props.scope,
  () => {
    chosenServer.value = ''
    tab.value = 'files'
  },
)
watch(currentServer, () => {
  page.value = 1
  tab.value = 'files'
  clearFilters()
})
watch([pageSize, stateFilter, kindFilter, fromDate, toDate], () => {
  page.value = 1
})
watch(folderSearch, () => {
  folderPage.value = 1
})
function chooseServer(id: string) {
  chosenServer.value = id
  try {
    localStorage.setItem('mcmanager.backups.server', id)
  } catch {
    /* storage may be disabled */
  }
}
function clearFilters() {
  stateFilter.value = ''
  kindFilter.value = ''
  fromDate.value = ''
  toDate.value = ''
}
const groups = useResource(
  () => props.revision,
  (signal) => api<Group[]>('/backups/groups', { signal }),
  (ex) => emit('error', ex),
)
const groupMap = computed(
  () => new Map((groups.data.value ?? []).map((group) => [group.serverId, group])),
)
const currentGroup = computed(() => groupMap.value.get(currentServer.value))
const folders = computed(() =>
  props.servers.filter((server) =>
    server.name.toLocaleLowerCase().includes(folderSearch.value.trim().toLocaleLowerCase()),
  ),
)
const visibleFolders = computed(() =>
  folders.value.slice((folderPage.value - 1) * 12, folderPage.value * 12),
)
watch(
  () => folders.value.length,
  (total) => {
    folderPage.value = Math.min(folderPage.value, Math.max(1, Math.ceil(total / 12)))
  },
)
const hostList = useResource(
  () => [currentServer.value, props.revision],
  (signal) =>
    currentServer.value
      ? api<{ id: string; serverId: string; revoked: boolean }[]>(
          `/backup-hosts?serverId=${currentServer.value}`,
          { signal },
        )
      : Promise.resolve([]),
  (ex) => emit('error', ex),
)
const { data, busy, error, refresh } = useResource(
  () => [
    currentServer.value,
    props.revision,
    page.value,
    pageSize.value,
    stateFilter.value,
    kindFilter.value,
    fromDate.value,
    toDate.value,
    tab.value,
  ],
  (signal) => {
    if (!currentServer.value || tab.value !== 'files' || dateError.value)
      return Promise.resolve({ items: [], total: 0, maxUploadBytes: '17179869184' } as Catalog)
    const query = new URLSearchParams({
      serverId: currentServer.value,
      page: String(page.value - 1),
      size: String(pageSize.value),
    })
    if (stateFilter.value) query.set('state', stateFilter.value)
    if (kindFilter.value) query.set('kind', kindFilter.value)
    if (fromDate.value)
      query.set('from', new Date(fromDate.value + 'T00:00:00+08:00').toISOString())
    if (toDate.value)
      query.set(
        'to',
        new Date(new Date(toDate.value + 'T00:00:00+08:00').getTime() + 86400000).toISOString(),
      )
    return api<Catalog>(`/backups?${query}`, { signal })
  },
  (ex) => emit('error', ex),
)
watch(data, (value) => {
  if (value && tab.value === 'files')
    page.value = Math.min(page.value, Math.max(1, Math.ceil(value.total / pageSize.value)))
})
async function refreshAll() {
  await Promise.all([refresh(), groups.refresh(), hostList.refresh()])
}
async function restore(backup: Backup) {
  tab.value = 'restores'
  await nextTick()
  await restores.value?.open(backup)
}
function backupTime(value: string) {
  return new Intl.DateTimeFormat(formatLocale, {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value))
}
const labels: Record<string, string> = {
  AWAITING_UPLOAD: t('m0424'),
  RECEIVING: t('m0425'),
  VERIFYING: t('m0426'),
  READY: t('m0427'),
  FAILED: t('m0428'),
  MISSING: t('m0429'),
  DELETING: t('m0430'),
  DELETED: t('m0431'),
}
const kinds = { MANUAL: t('m0432'), AUTOMATIC: t('m0433'), FINAL: t('m0434') }
const modal = ref<HTMLDialogElement>(),
  firstField = ref<HTMLSelectElement>()
const action = ref<'upload' | 'edit' | 'delete'>('upload'),
  selected = ref<Backup>()
const serverId = ref(''),
  note = ref(''),
  kind = ref('MANUAL'),
  permanent = ref(false),
  file = ref<File>()
const working = ref(false),
  formError = ref(''),
  message = ref(''),
  fraction = ref(0),
  uploadId = ref(''),
  requestId = ref('')
let opener: HTMLElement | null = null
const title = computed(
  () => ({ upload: t('m0435'), edit: t('m0436'), delete: t('m0437') })[action.value],
)
const validUpload = computed(
  () =>
    serverId.value &&
    file.value &&
    (!data.value || file.value.size <= Number(data.value.maxUploadBytes)),
)
function serverName(id: string) {
  return props.servers.find((server) => server.id === id)?.name ?? id
}
function bytes(value: string | null | undefined) {
  if (value == null) return '—'
  let size = Number(value),
    unit = 0
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit++
  }
  return `${size.toLocaleString(formatLocale, { maximumFractionDigits: unit ? 1 : 0 })} ${units[unit]}`
}
async function open(mode: typeof action.value, backup?: Backup) {
  opener = document.activeElement as HTMLElement
  action.value = mode
  selected.value = backup
  serverId.value = backup?.serverId ?? (currentServer.value || props.servers[0]?.id || '')
  note.value = backup?.note ?? ''
  permanent.value = backup?.permanent ?? false
  kind.value = 'MANUAL'
  file.value = undefined
  uploadId.value = ''
  requestId.value = newRequestId()
  fraction.value = 0
  formError.value = ''
  await nextTick()
  modal.value?.showModal()
  firstField.value?.focus()
}
function chooseFile(event: Event) {
  file.value = (event.target as HTMLInputElement).files?.[0]
  uploadId.value = ''
  requestId.value = newRequestId()
}
function close() {
  if (!working.value) modal.value?.close()
}
function afterClose() {
  opener?.focus()
  file.value = undefined
  selected.value = undefined
}
async function submit() {
  if (working.value) return
  working.value = true
  formError.value = ''
  message.value = ''
  try {
    if (action.value === 'upload') {
      if (!file.value || !validUpload.value) return
      if (!uploadId.value) {
        const reservation = await api<Backup>(`/servers/${serverId.value}/backups`, {
          method: 'POST',
          body: JSON.stringify({
            requestId: requestId.value,
            kind: kind.value,
            note: note.value,
            permanent: permanent.value,
            expectedBytes: String(file.value.size),
          }),
        })
        uploadId.value = reservation.id
      } else {
        await api(`/backups/${uploadId.value}`, {
          method: 'PUT',
          body: JSON.stringify({
            note: note.value,
            permanent: permanent.value || kind.value === 'FINAL',
          }),
        })
      }
      fraction.value = 0
      await uploadBackup(uploadId.value, file.value, (value) => {
        fraction.value = value
      })
      message.value = t('m0438')
      chooseServer(serverId.value)
      tab.value = 'files'
    } else if (action.value === 'edit') {
      await api(`/backups/${selected.value!.id}`, {
        method: 'PUT',
        body: JSON.stringify({ note: note.value, permanent: permanent.value }),
      })
      message.value = t('m0439')
    } else {
      await api(`/backups/${selected.value!.id}`, { method: 'DELETE' })
      message.value = t('m0440')
    }
    modal.value?.close()
    await refreshAll()
  } catch (ex) {
    if (action.value === 'upload' && ex instanceof ApiError && ex.status === 409) {
      // A definitive refusal permits a different target; never reuse that
      // target-bound request ID for the corrected reservation.
      uploadId.value = ''
      requestId.value = newRequestId()
    }
    formError.value = failure(ex)
    emit('error', ex)
    await refreshAll()
  } finally {
    working.value = false
  }
}
</script>

<template>
  <section class="backup-workspace">
    <article v-if="!currentServer" class="panel data-panel backup-directory">
      <div class="data-panel-heading">
        <div>
          <h2>{{ t('m0441') }}</h2>
          <p>{{ t('m0442') }}</p>
        </div>
        <button class="secondary" :disabled="groups.busy.value" @click="refreshAll">
          <RefreshCw :size="16" />{{ t('m0331') }}</button>
      </div>
      <label class="folder-search"
        ><Search :size="18" /><input
          v-model="folderSearch"
          :aria-label="t('m0443')"
          :placeholder="t('m0444')"
      /></label>
      <p v-if="groups.error.value" class="alert error" role="alert">{{ groups.error.value }}</p>
      <div class="backup-folders">
        <button
          v-for="server in visibleFolders"
          :key="server.id"
          class="backup-folder"
          :data-backup-folder="server.id"
          @click="chooseServer(server.id)"
        >
          <span class="folder-icon"><Folder :size="28" /></span><strong>{{ server.name }}</strong>
          <span
            >{{
              groups.busy.value
                ? t('m0445')
                : t('m0446', [groupMap.get(server.id)?.readyCount ?? 0])
            }}
            <span aria-hidden="true">·</span>
            {{ bytes(groupMap.get(server.id)?.archiveBytes ?? '0') }}</span
          >
          <small>{{
            groupMap.get(server.id)?.latestReadyAt
              ? t('m0447', [backupTime(groupMap.get(server.id)!.latestReadyAt!)])
              : t('m0448')
          }}</small>
          <span class="folder-enter">{{ t('m0449') }}</span>
        </button>
      </div>
      <p v-if="!folders.length" class="small-empty">
        {{ servers.length ? t('m0450') : t('m0451') }}
      </p>
      <PaginationControl
        v-if="folders.length > 12"
        :page="folderPage"
        :total="folders.length"
        :page-size="12"
        @change="folderPage = $event"
      />
    </article>
    <template v-else>
      <article class="panel data-panel backup-server-heading">
        <button v-if="scope === 'all'" class="text-button backup-back" @click="chooseServer('')">
          <ArrowLeft :size="16" />{{ t('m0452') }}</button>
        <div class="data-panel-heading">
          <div>
            <p class="backup-server-caption"><Server :size="16" />{{ t('m0441') }}</p>
            <h2>{{ currentName }}</h2>
            <p>{{ t('m0453') }}</p>
          </div>
          <div class="backup-actions">
            <button class="secondary" :disabled="busy" @click="refreshAll">
              <RefreshCw :size="16" />{{ t('m0331') }}</button
            ><button class="secondary" data-upload-backup @click="open('upload')">
              <Upload :size="16" />{{ t('m0435') }}</button
            ><button class="primary" @click="tab = 'tasks'">{{ t('m0454') }}</button>
          </div>
        </div>
        <div class="backup-overview">
          <span
            ><strong>{{ currentGroup?.readyCount ?? 0 }}</strong>{{ t('m0455') }}</span
          ><span
            >{{ t('m0456') }}<strong>{{ bytes(currentGroup?.archiveBytes ?? '0') }}</strong></span
          ><span
            >{{ t('m0458', [currentGroup?.latestReadyAt ? backupTime(currentGroup.latestReadyAt) : t('m0457')]) }}</span
          >
        </div>
      </article>
      <nav class="backup-tabs" :aria-label="t('m0459')">
        <button
          v-for="item in tabs"
          :key="item.id"
          :class="{ active: tab === item.id }"
          :aria-current="tab === item.id ? 'page' : undefined"
          @click="tab = item.id"
        >
          {{ item.label }}
        </button>
      </nav>
      <p v-if="message" class="alert success" role="status">{{ message }}</p>
      <RemoteBackupTasks
        v-if="tab === 'tasks'"
        :key="currentServer"
        :servers="servers"
        :scope="currentServer"
        :revision="revision"
        :include-policies="false"
        @error="emit('error', $event)"
        @changed="refreshAll"
      />
      <BackupPolicies
        v-if="tab === 'schedule'"
        :key="currentServer"
        :servers="servers"
        :scope="currentServer"
        :revision="revision"
        :hosts="hostList.data.value ?? []"
        :ready="!hostList.busy.value && !hostList.error.value"
        @error="emit('error', $event)"
        @changed="refreshAll"
      />
      <p v-if="tab === 'schedule' && hostList.error.value" class="alert error">
        {{ hostList.error.value }}<button @click="hostList.refresh">{{ t('m0337') }}</button>
      </p>
      <RestoreTasks
        v-show="tab === 'restores'"
        :key="currentServer"
        ref="restores"
        :servers="servers"
        :scope="currentServer"
        :revision="revision"
        @error="emit('error', $event)"
        @changed="refreshAll"
        @archives-changed="emit('archivesChanged')"
      />
      <section v-if="tab === 'files'" class="backup-file-list" :aria-label="t('m0419')">
        <div class="panel backup-filters">
          <div class="backup-list-heading">
            <h3>{{ t('m0419') }}</h3>
            <span>{{ t('m0460') }}</span>
          </div>
          <div class="backup-filter-grid">
            <label
              >{{ t('m0461') }}<select v-model="stateFilter" :aria-label="t('m0461')">
                <option value="">{{ t('m0062') }}</option>
                <option value="READY">{{ t('m0427') }}</option>
                <option value="PENDING">{{ t('m0462') }}</option>
                <option value="ATTENTION">{{ t('m0463') }}</option>
              </select></label
            >
            <label
              >{{ t('m0464') }}<select v-model="kindFilter" :aria-label="t('m0464')">
                <option value="">{{ t('m0465') }}</option>
                <option value="AUTOMATIC">{{ t('m0433') }}</option>
                <option value="MANUAL">{{ t('m0432') }}</option>
                <option value="FINAL">{{ t('m0434') }}</option>
              </select></label
            >
            <label>{{ t('m0466') }}<input v-model="fromDate" type="date" /></label
            ><label>{{ t('m0095') }}<input v-model="toDate" type="date" /></label>
            <label
              >{{ t('m0467') }}<select v-model.number="pageSize" :aria-label="t('m0467')">
                <option :value="10">{{ t('m0468') }}</option>
                <option :value="25">{{ t('m0469') }}</option>
                <option :value="50">{{ t('m0470') }}</option>
              </select></label
            >
            <button class="text-button" @click="clearFilters">{{ t('m0471') }}</button>
          </div>
          <p v-if="dateError" class="alert error" role="alert">{{ dateError }}</p>
        </div>
        <p v-if="error" class="alert error" role="alert">
          {{ error }}<button class="text-button" @click="refresh">{{ t('m0337') }}</button>
        </p>
        <p v-else-if="busy" class="small-empty" role="status">{{ t('m0472') }}</p>
        <article v-else-if="!data?.items.length" class="panel small-empty">
          <HardDrive :size="32" />
          <h3>{{ currentGroup?.total ? t('m0473') : t('m0474') }}</h3>
          <p>{{ t('m0475') }}</p>
        </article>
        <article
          v-for="backup in data?.items ?? []"
          :key="backup.id"
          :data-backup="backup.id"
          class="panel backup-card"
        >
          <div class="data-panel-heading">
            <div>
              <h3>{{ backupTime(backup.snapshotAt ?? backup.createdAt) }}</h3>
              <p>
                {{ kinds[backup.kind] }} ·
                {{
                  backup.summary?.archiveScope === 'WORLD'
                    ? t('m0476')
                    : backup.summary
                      ? t('m0477')
                      : t('m0478')
                }}
                · {{ bytes(backup.archiveBytes ?? backup.expectedBytes) }}
              </p>
            </div>
            <div class="backup-badges">
              <span
                v-if="
                  backup.status === 'READY' &&
                  (backup.snapshotAt ?? backup.createdAt) === currentGroup?.latestReadyAt
                "
                class="latest-backup"
                >{{ t('m0479') }}</span
              >
              <span class="neutral-badge">{{
                backup.interrupted ? t('m0480') : (labels[backup.status] ?? backup.status)
              }}</span
              ><span v-if="backup.permanent" class="neutral-badge">{{ t('m0481') }}</span>
            </div>
          </div>
          <p v-if="backup.note" class="backup-note">{{ backup.note }}</p>
          <div class="backup-row-footer">
            <a
              v-if="backup.status === 'READY'"
              class="secondary backup-download"
              :href="`/api/backups/${backup.id}/content`"
              ><Download :size="16" />{{ t('m0482') }}</a
            ><small>{{ t('m0483', [backup.id.slice(0, 8)]) }}</small>
          </div>
          <details class="backup-management">
            <summary>{{ t('m0484') }}</summary>
            <dl class="collector-details">
              <div>
                <dt>{{ t('m0485') }}</dt>
                <dd>{{ bytes(backup.archiveBytes ?? backup.expectedBytes) }}</dd>
              </div>
              <div>
                <dt>{{ t('m0486') }}</dt>
                <dd>{{ bytes(backup.sourceBytes) }} / {{ backup.fileCount ?? '—' }}</dd>
              </div>
              <div>
                <dt>{{ t('m0487') }}</dt>
                <dd>
                  {{
                    backup.summary?.runtime?.bds?.version ??
                    (backup.status === 'READY' ? t('m0488') : t('m0489'))
                  }}
                </dd>
              </div>
              <div>
                <dt>{{ t('m0490') }}</dt>
                <dd>{{ t('m0491') }}</dd>
              </div>
            </dl>
            <p v-if="backup.status === 'RECEIVING'" class="data-note">{{ t('m0492', [bytes(backup.receivedBytes), bytes(backup.expectedBytes)]) }}
            </p>
            <p v-if="['FAILED', 'MISSING', 'DELETING'].includes(backup.status)" class="alert error">
              {{
                backup.status === 'MISSING'
                  ? t('m0493')
                  : backup.status === 'DELETING'
                    ? t('m0494')
                    : t('m0495')
              }}
            </p>
            <details v-if="backup.summary" class="collector-capabilities">
              <summary>{{ t('m0496') }}</summary>
              <dl class="backup-proof">
                <dt>{{ t('m0497') }}</dt>
                <dd>
                  {{ backup.summary.archiveScope === 'WORLD' ? t('m0498') : t('m0477') }}
                </dd>
                <dt>{{ t('m0499') }}</dt>
                <dd>
                  {{
                    backup.summary.snapshotMode === 'BDS_SAVE_QUERY'
                      ? t('m0500')
                      : backup.summary.snapshotMode === 'STOPPED'
                        ? t('m0501')
                        : t('m0502')
                  }}
                </dd>
                <dt>SHA-256</dt>
                <dd>
                  <code>{{ backup.sha256 }}</code>
                </dd>
                <dt>{{ t('m0503') }}</dt>
                <dd>
                  <code>{{ backup.sourceBackupId }}</code>
                </dd>
                <dt>{{ t('m0504') }}</dt>
                <dd>
                  {{
                    backup.summary.archiveScope === 'WORLD'
                      ? t('m0505')
                      : backup.summary.statistics?.cacheIntegrity === 'VERIFIED'
                        ? t('m0506')
                        : t('m0507')
                  }}
                  <span v-if="backup.summary.archiveScope !== 'WORLD'"
                    >{{ t('m0509', [backup.summary.statistics?.pendingEvents ?? t('m0508')]) }}</span
                  >
                </dd>
                <dt v-if="backup.summary.archiveScope !== 'WORLD'">{{ t('m0510') }}</dt>
                <dd v-if="backup.summary.archiveScope !== 'WORLD'">
                  {{ displayTime(backup.summary.statistics?.latestAcknowledgedEventAt) }}
                </dd>
              </dl>
              <p v-if="backup.summary.archiveScope !== 'WORLD'" class="data-note">{{ t('m0511') }}</p>
              <p class="data-note">{{ t('m0512') }}</p>
              <p
                v-if="
                  backup.summary.snapshotMode === 'BDS_SAVE_QUERY' &&
                  backup.summary.archiveScope !== 'WORLD'
                "
                class="data-note"
              >{{ t('m0513') }}</p>
            </details>
            <p v-if="backup.summary?.archiveScope === 'WORLD'" class="data-note">{{ t('m0514', [backup.summary.worldDirectory]) }}</p>
            <div class="backup-actions">
              <button v-if="backup.status === 'READY'" class="secondary" @click="restore(backup)">
                <RotateCcw :size="16" />{{ t('m0515') }}</button>
              <button
                class="secondary"
                :disabled="backup.status === 'DELETING'"
                @click="open('edit', backup)"
              >{{ t('m0516') }}</button>
              <button
                class="text-button danger-text"
                :disabled="
                  backup.permanent ||
                  (!backup.interrupted && ['RECEIVING', 'VERIFYING'].includes(backup.status))
                "
                @click="open('delete', backup)"
              >
                {{ backup.status === 'DELETING' ? t('m0517') : t('m0518') }}
              </button>
            </div>
          </details>
        </article>
        <PaginationControl
          v-if="data?.total"
          :page="page"
          :total="data.total"
          :page-size="pageSize"
          :busy="busy"
          @change="page = $event"
        />
      </section>
    </template>
    <dialog
      ref="modal"
      aria-labelledby="backup-dialog-title"
      @cancel="working ? $event.preventDefault() : undefined"
      @close="afterClose"
    >
      <form @submit.prevent="submit">
        <div class="dialog-heading">
          <h2 id="backup-dialog-title">{{ title }}</h2>
          <button
            type="button"
            class="icon-button"
            :aria-label="t('m0519')"
            :disabled="working"
            @click="close"
          >
            <X :size="20" />
          </button>
        </div>
        <template v-if="action === 'upload'">
          <label
            >{{ t('m0520') }}<select
              ref="firstField"
              v-model="serverId"
              :disabled="working || !!uploadId"
              required
            >
              <option v-for="server in servers" :key="server.id" :value="server.id">
                {{ server.name }}
              </option>
            </select></label
          >
          <label
            >{{ t('m0521') }}<select v-model="kind" :disabled="working || !!uploadId">
              <option value="MANUAL">{{ t('m0432') }}</option>
              <option value="FINAL">{{ t('m0522') }}</option>
            </select></label
          >
          <label
            >{{ t('m0523') }}<input
              type="file"
              accept=".tar.gz,.tgz,.tar"
              :disabled="working"
              required
              @change="chooseFile"
          /></label>
          <p class="data-note">{{ t('m0524', [bytes(data?.maxUploadBytes)]) }}</p>
        </template>
        <template v-if="action !== 'delete'">
          <label
            >{{ t('m0525') }}<textarea v-model="note" maxlength="1000" rows="3" :disabled="working" />
          </label>
          <label class="backup-check"
            ><input
              v-model="permanent"
              type="checkbox"
              :disabled="working || (action === 'upload' && kind === 'FINAL')"
            />{{
              action === 'upload' && kind === 'FINAL'
                ? t('m0526')
                : t('m0527')
            }}</label
          >
        </template>
        <p v-else class="alert info">{{ t('m0528', [selected ? serverName(selected.serverId) : '']) }}</p>
        <div v-if="working && action === 'upload'" role="status" class="backup-progress">
          <progress :value="fraction" max="1" />
          <p>
            {{
              fraction < 1
                ? t('m0529', [Math.round(fraction * 100)])
                : t('m0530')
            }}
          </p>
        </div>
        <p v-if="formError" class="alert error" role="alert">{{ formError }}</p>
        <div class="dialog-actions">
          <button type="button" class="secondary" :disabled="working" @click="close">{{ t('m0102') }}</button
          ><button
            :class="action === 'delete' ? 'danger' : 'primary'"
            :disabled="working || (action === 'upload' && !validUpload)"
          >
            {{
              working
                ? t('m0363')
                : action === 'upload'
                  ? t('m0531')
                  : action === 'delete'
                    ? t('m0532')
                    : t('m0533')
            }}
          </button>
        </div>
      </form>
    </dialog>
  </section>
</template>

<style scoped>
.backup-directory {
  padding: 24px;
}
.backup-directory > .data-panel-heading,
.backup-server-heading > .data-panel-heading,
.backup-card > .data-panel-heading {
  padding: 0;
}
.backup-server-heading {
  padding: 20px 24px;
}
.folder-search {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 10px;
  max-width: 420px;
  margin: 18px 0;
  color: var(--muted);
}
.folder-search input {
  min-width: 0;
  flex: 1;
}
.backup-folders {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr));
  gap: 16px;
}
.backup-folder {
  text-align: left;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  padding: 22px;
  border: 1px solid #d9e6df;
  border-radius: 16px;
  background: linear-gradient(135deg, #f0faf3, #fff);
  color: var(--text);
  min-width: 0;
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
}
.backup-folder:hover {
  border-color: #19825f;
  box-shadow: 0 5px 18px #17634515;
}
.backup-folder strong {
  font-size: 17px;
  overflow-wrap: anywhere;
}
.backup-folder small,
.backup-folder > span:not(.folder-icon) {
  font-size: 12px;
  color: var(--muted);
}
.folder-icon {
  color: #16835b;
  background: #dff2e4;
  border-radius: 12px;
  padding: 11px;
  display: flex;
}
.backup-folder .folder-enter {
  margin-top: 8px;
  color: #16835b !important;
  font-weight: 600;
}
.backup-back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 14px;
  padding-left: 0;
}
.backup-server-heading h2 {
  overflow-wrap: anywhere;
}
.backup-server-caption {
  display: flex;
  gap: 6px;
  align-items: center;
}
.backup-overview {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 24px;
  border-top: 1px solid var(--border, #e1e9e5);
  padding-top: 16px;
  margin-top: 12px;
  font-size: 13px;
  color: var(--muted);
}
.backup-overview strong {
  color: #16835b;
  font-size: 17px;
}
.backup-tabs {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  padding: 5px;
  gap: 5px;
  background: #eaf2ed;
  border-radius: 12px;
}
.backup-tabs button {
  flex: 1;
  padding: 12px;
  min-width: 100px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--muted);
}
.backup-tabs .active {
  background: #fff;
  color: #116f50;
  font-weight: 700;
  box-shadow: 0 2px 6px #17412c12;
}
.backup-file-list {
  display: grid;
  gap: 12px;
  min-width: 0;
}
.backup-filters {
  padding: 18px 20px;
}
.backup-list-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.backup-list-heading h3 {
  margin: 0;
}
.backup-list-heading span {
  color: var(--muted);
  font-size: 12px;
}
.backup-filter-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr)) auto;
  gap: 12px;
  align-items: end;
}
.backup-filter-grid label {
  display: grid;
  gap: 6px;
  font-size: 12px;
  min-width: 0;
  color: var(--muted);
}
.backup-filter-grid input,
.backup-filter-grid select {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
}
.backup-card h3 {
  margin: 0;
  font-size: 17px;
}
.backup-card .data-panel-heading {
  margin-bottom: 0;
}
.backup-card .data-panel-heading p {
  margin: 8px 0;
  font-size: 12px;
}
.backup-note {
  margin: 5px 0 12px;
  font-size: 13px;
}
.backup-row-footer {
  display: flex;
  align-items: center;
  gap: 14px;
  justify-content: space-between;
}
.backup-row-footer small {
  color: var(--muted);
  margin-left: auto;
}
.backup-management {
  margin-top: 12px;
  border-top: 1px solid var(--border, #e1e9e5);
  padding-top: 10px;
}
.backup-management > summary {
  cursor: pointer;
  color: #176f53;
  font-size: 13px;
  padding: 4px 0;
}
.latest-backup {
  background: #e4f6ea;
  color: #14744f;
  border-radius: 6px;
  padding: 5px 8px;
  font-size: 12px;
}
@media (max-width: 1000px) {
  .backup-filter-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
@media (max-width: 560px) {
  .backup-directory,
  .backup-server-heading,
  .backup-filters {
    padding: 16px;
  }
  .backup-filter-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .backup-tabs {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .backup-tabs button {
    min-width: 0;
  }
  .backup-card .data-panel-heading {
    align-items: flex-start;
  }
  .backup-overview {
    flex-direction: column;
    gap: 8px;
  }
}
.backup-workspace {
  display: grid;
  gap: 18px;
}
.backup-card {
  padding: 16px 20px;
  min-width: 0;
}
.backup-actions,
.backup-badges {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.backup-note {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--text);
}
.backup-download {
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 7px;
}
.backup-proof {
  display: grid;
  gap: 8px;
}
.backup-proof dt {
  color: var(--muted);
}
.backup-proof dd {
  margin: 0 0 8px;
  overflow-wrap: anywhere;
  font-size: 13px;
}
.backup-check {
  display: flex;
  align-items: center;
  gap: 8px;
}
.backup-check input {
  width: auto;
}
.backup-progress progress {
  width: 100%;
  accent-color: #4b9169;
}
@media (max-width: 560px) {
  .backup-card {
    padding: 18px;
  }
  .backup-actions {
    align-items: stretch;
  }
  .backup-actions > * {
    justify-content: center;
  }
}
</style>
