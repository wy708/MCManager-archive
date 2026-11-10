<script setup lang="ts">
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
  { id: 'files', label: '存档记录' },
  { id: 'tasks', label: '备份任务' },
  { id: 'schedule', label: '每日定时' },
  { id: 'restores', label: '恢复记录' },
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
  fromDate.value && toDate.value && fromDate.value > toDate.value ? '结束日期不能早于开始日期' : '',
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
  return new Intl.DateTimeFormat('zh-CN', {
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
  AWAITING_UPLOAD: '等待上传',
  RECEIVING: '上传中',
  VERIFYING: '校验中',
  READY: '可下载',
  FAILED: '未完成',
  MISSING: '文件不可用',
  DELETING: '删除未完成',
  DELETED: '已删除',
}
const kinds = { MANUAL: '手动备份', AUTOMATIC: '自动备份', FINAL: '最终封存' }
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
  () => ({ upload: '上传备份', edit: '编辑备份信息', delete: '删除备份文件' })[action.value],
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
  return `${size.toLocaleString('zh-CN', { maximumFractionDigits: unit ? 1 : 0 })} ${units[unit]}`
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
      message.value = '备份已保存，完整文件校验通过。'
      chooseServer(serverId.value)
      tab.value = 'files'
    } else if (action.value === 'edit') {
      await api(`/backups/${selected.value!.id}`, {
        method: 'PUT',
        body: JSON.stringify({ note: note.value, permanent: permanent.value }),
      })
      message.value = '备份备注和保留设置已更新。'
    } else {
      await api(`/backups/${selected.value!.id}`, { method: 'DELETE' })
      message.value = '备份文件已删除，玩家统计历史仍保留。'
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
          <h2>服务器备份库</h2>
          <p>每个服务器独立整理，进入文件夹查看存档和每日计划。</p>
        </div>
        <button class="secondary" :disabled="groups.busy.value" @click="refreshAll">
          <RefreshCw :size="16" />刷新
        </button>
      </div>
      <label class="folder-search"
        ><Search :size="18" /><input
          v-model="folderSearch"
          aria-label="搜索备份服务器"
          placeholder="搜索服务器名称"
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
                ? '正在统计…'
                : `${groupMap.get(server.id)?.readyCount ?? 0} 份可用存档`
            }}
            <span aria-hidden="true">·</span>
            {{ bytes(groupMap.get(server.id)?.archiveBytes ?? '0') }}</span
          >
          <small>{{
            groupMap.get(server.id)?.latestReadyAt
              ? `最近备份 ${backupTime(groupMap.get(server.id)!.latestReadyAt!)}`
              : '还没有成功备份'
          }}</small>
          <span class="folder-enter">查看此服务器 →</span>
        </button>
      </div>
      <p v-if="!folders.length" class="small-empty">
        {{ servers.length ? '没有找到这个服务器' : '先创建服务器档案，再开始备份。' }}
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
          <ArrowLeft :size="16" />返回服务器列表
        </button>
        <div class="data-panel-heading">
          <div>
            <p class="backup-server-caption"><Server :size="16" />服务器备份库</p>
            <h2>{{ currentName }}</h2>
            <p>世界存档、备份任务与每日计划，都在这个服务器下。</p>
          </div>
          <div class="backup-actions">
            <button class="secondary" :disabled="busy" @click="refreshAll">
              <RefreshCw :size="16" />刷新</button
            ><button class="secondary" data-upload-backup @click="open('upload')">
              <Upload :size="16" />上传备份</button
            ><button class="primary" @click="tab = 'tasks'">开始备份</button>
          </div>
        </div>
        <div class="backup-overview">
          <span
            ><strong>{{ currentGroup?.readyCount ?? 0 }}</strong> 份可用存档</span
          ><span
            >占用 <strong>{{ bytes(currentGroup?.archiveBytes ?? '0') }}</strong></span
          ><span
            >最近成功
            {{
              currentGroup?.latestReadyAt ? backupTime(currentGroup.latestReadyAt) : '暂无'
            }}</span
          >
        </div>
      </article>
      <nav class="backup-tabs" aria-label="服务器备份功能">
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
        {{ hostList.error.value }}<button @click="hostList.refresh">重试</button>
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
      <section v-if="tab === 'files'" class="backup-file-list" aria-label="存档记录">
        <div class="panel backup-filters">
          <div class="backup-list-heading">
            <h3>存档记录</h3>
            <span>按创建时间倒序 · 时间均为 UTC+8</span>
          </div>
          <div class="backup-filter-grid">
            <label
              >状态<select v-model="stateFilter" aria-label="状态">
                <option value="">全部状态</option>
                <option value="READY">可下载</option>
                <option value="PENDING">处理中</option>
                <option value="ATTENTION">需要处理</option>
              </select></label
            >
            <label
              >类型<select v-model="kindFilter" aria-label="类型">
                <option value="">全部类型</option>
                <option value="AUTOMATIC">自动备份</option>
                <option value="MANUAL">手动备份</option>
                <option value="FINAL">最终封存</option>
              </select></label
            >
            <label>开始日期<input v-model="fromDate" type="date" /></label
            ><label>结束日期<input v-model="toDate" type="date" /></label>
            <label
              >每页显示<select v-model.number="pageSize" aria-label="每页显示">
                <option :value="10">10 条</option>
                <option :value="25">25 条</option>
                <option :value="50">50 条</option>
              </select></label
            >
            <button class="text-button" @click="clearFilters">清空筛选</button>
          </div>
          <p v-if="dateError" class="alert error" role="alert">{{ dateError }}</p>
        </div>
        <p v-if="error" class="alert error" role="alert">
          {{ error }}<button class="text-button" @click="refresh">重试</button>
        </p>
        <p v-else-if="busy" class="small-empty" role="status">正在加载备份…</p>
        <article v-else-if="!data?.items.length" class="panel small-empty">
          <HardDrive :size="32" />
          <h3>{{ currentGroup?.total ? '没有符合筛选条件的存档' : '这个服务器还没有备份' }}</h3>
          <p>成功的备份会出现在这里；执行进度和失败原因请到“备份任务”查看。</p>
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
                    ? '世界存档'
                    : backup.summary
                      ? '整服备份'
                      : '等待校验'
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
                >最新可用</span
              >
              <span class="neutral-badge">{{
                backup.interrupted ? '处理已中断' : (labels[backup.status] ?? backup.status)
              }}</span
              ><span v-if="backup.permanent" class="neutral-badge">永久保留</span>
            </div>
          </div>
          <p v-if="backup.note" class="backup-note">{{ backup.note }}</p>
          <div class="backup-row-footer">
            <a
              v-if="backup.status === 'READY'"
              class="secondary backup-download"
              :href="`/api/backups/${backup.id}/content`"
              ><Download :size="16" />下载存档</a
            ><small>编号 {{ backup.id.slice(0, 8) }}</small>
          </div>
          <details class="backup-management">
            <summary>详情与管理</summary>
            <dl class="collector-details">
              <div>
                <dt>归档大小</dt>
                <dd>{{ bytes(backup.archiveBytes ?? backup.expectedBytes) }}</dd>
              </div>
              <div>
                <dt>源文件 / 数量</dt>
                <dd>{{ bytes(backup.sourceBytes) }} / {{ backup.fileCount ?? '—' }}</dd>
              </div>
              <div>
                <dt>游戏版本</dt>
                <dd>
                  {{
                    backup.summary?.runtime?.bds?.version ??
                    (backup.status === 'READY' ? '未识别' : '待校验')
                  }}
                </dd>
              </div>
              <div>
                <dt>实际恢复验证</dt>
                <dd>未记录实际游玩确认</dd>
              </div>
            </dl>
            <p v-if="backup.status === 'RECEIVING'" class="data-note">
              已接收 {{ bytes(backup.receivedBytes) }} / {{ bytes(backup.expectedBytes) }}
            </p>
            <p v-if="['FAILED', 'MISSING', 'DELETING'].includes(backup.status)" class="alert error">
              {{
                backup.status === 'MISSING'
                  ? '存储中的文件缺失或内容不一致，下载已停止。'
                  : backup.status === 'DELETING'
                    ? '文件删除未完成，可重试删除。'
                    : '上传或文件校验未完成，请检查归档后重新上传。'
              }}
            </p>
            <details v-if="backup.summary" class="collector-capabilities">
              <summary>查看完整性与统计衔接说明</summary>
              <dl class="backup-proof">
                <dt>备份范围</dt>
                <dd>
                  {{ backup.summary.archiveScope === 'WORLD' ? '仅当前世界存档' : '整服备份' }}
                </dd>
                <dt>备份方式</dt>
                <dd>
                  {{
                    backup.summary.snapshotMode === 'BDS_SAVE_QUERY'
                      ? '运行中世界快照'
                      : backup.summary.snapshotMode === 'STOPPED'
                        ? '正常停服快照'
                        : '未记录'
                  }}
                </dd>
                <dt>SHA-256</dt>
                <dd>
                  <code>{{ backup.sha256 }}</code>
                </dd>
                <dt>原始备份 ID</dt>
                <dd>
                  <code>{{ backup.sourceBackupId }}</code>
                </dd>
                <dt>本地采集缓存</dt>
                <dd>
                  {{
                    backup.summary.archiveScope === 'WORLD'
                      ? '不包含（世界备份）'
                      : backup.summary.statistics?.cacheIntegrity === 'VERIFIED'
                        ? '摘要校验通过'
                        : '未核实'
                  }}
                  <span v-if="backup.summary.archiveScope !== 'WORLD'"
                    >· 待传事件 {{ backup.summary.statistics?.pendingEvents ?? '未知' }}</span
                  >
                </dd>
                <dt v-if="backup.summary.archiveScope !== 'WORLD'">缓存中最大已确认事件时间</dt>
                <dd v-if="backup.summary.archiveScope !== 'WORLD'">
                  {{ displayTime(backup.summary.statistics?.latestAcknowledgedEventAt) }}
                </dd>
              </dl>
              <p v-if="backup.summary.archiveScope !== 'WORLD'" class="data-note">
                此时间不表示此前全部统计都已上传。恢复旧世界时，中央已有历史继续保留；原事件按身份去重，新一期须使用新档案。
              </p>
              <p class="data-note">平台数据库和插件外部数据库不包含在此归档中。</p>
              <p
                v-if="
                  backup.summary.snapshotMode === 'BDS_SAVE_QUERY' &&
                  backup.summary.archiveScope !== 'WORLD'
                "
                class="data-note"
              >
                世界对应原生存档快照时刻；插件文件是随后取得的稳定副本。需要与世界同步提交的玩法插件，须单独协调或使用停服备份。
              </p>
            </details>
            <p v-if="backup.summary?.archiveScope === 'WORLD'" class="data-note">
              仅包含
              {{
                backup.summary.worldDirectory
              }}。恢复时先解压到新目录，正常停服后再替换世界文件夹；服务端程序、插件、全局资源包和平台统计不包含在内。
            </p>
            <div class="backup-actions">
              <button v-if="backup.status === 'READY'" class="secondary" @click="restore(backup)">
                <RotateCcw :size="16" />恢复到新目录
              </button>
              <button
                class="secondary"
                :disabled="backup.status === 'DELETING'"
                @click="open('edit', backup)"
              >
                编辑备注与保留
              </button>
              <button
                class="text-button danger-text"
                :disabled="
                  backup.permanent ||
                  (!backup.interrupted && ['RECEIVING', 'VERIFYING'].includes(backup.status))
                "
                @click="open('delete', backup)"
              >
                {{ backup.status === 'DELETING' ? '重试删除' : '删除备份' }}
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
            aria-label="关闭备份窗口"
            :disabled="working"
            @click="close"
          >
            <X :size="20" />
          </button>
        </div>
        <template v-if="action === 'upload'">
          <label
            >所属服务器<select
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
            >备份用途<select v-model="kind" :disabled="working || !!uploadId">
              <option value="MANUAL">手动备份</option>
              <option value="FINAL">最终封存（默认永久保留）</option>
            </select></label
          >
          <label
            >备份归档文件<input
              type="file"
              accept=".tar.gz,.tgz,.tar"
              :disabled="working"
              required
              @change="chooseFile"
          /></label>
          <p class="data-note">
            当前单文件上限
            {{ bytes(data?.maxUploadBytes) }}。支持本项目备份工具生成的世界存档或整服归档。
          </p>
        </template>
        <template v-if="action !== 'delete'">
          <label
            >备份备注<textarea v-model="note" maxlength="1000" rows="3" :disabled="working" />
          </label>
          <label class="backup-check"
            ><input
              v-model="permanent"
              type="checkbox"
              :disabled="working || (action === 'upload' && kind === 'FINAL')"
            />{{
              action === 'upload' && kind === 'FINAL'
                ? '最终封存默认永久保留'
                : '永久保留，免于自动清理旧备份'
            }}</label
          >
        </template>
        <p v-else class="alert info">
          将删除“{{
            selected ? serverName(selected.serverId) : ''
          }}”的这份游戏备份文件。玩家统计历史继续保留，此操作不能撤销。
        </p>
        <div v-if="working && action === 'upload'" role="status" class="backup-progress">
          <progress :value="fraction" max="1" />
          <p>
            {{
              fraction < 1
                ? `正在上传 ${Math.round(fraction * 100)}%…`
                : '文件已上传，正在核对全部内容，请保持此页面打开…'
            }}
          </p>
        </div>
        <p v-if="formError" class="alert error" role="alert">{{ formError }}</p>
        <div class="dialog-actions">
          <button type="button" class="secondary" :disabled="working" @click="close">取消</button
          ><button
            :class="action === 'delete' ? 'danger' : 'primary'"
            :disabled="working || (action === 'upload' && !validUpload)"
          >
            {{
              working
                ? '处理中…'
                : action === 'upload'
                  ? '上传并校验'
                  : action === 'delete'
                    ? '确认删除文件'
                    : '保存设置'
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
