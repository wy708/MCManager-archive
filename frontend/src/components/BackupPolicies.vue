<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, ref } from 'vue'
import { CalendarClock, RefreshCw, Settings, X } from '@lucide/vue'
import { api, type ServerArchive } from '../api'
import { useResource } from '../useResource'
import { displayTime, failure } from '../statistics'

interface Host {
  id: string
  serverId: string
  revoked: boolean
}
interface Policy {
  serverId: string
  hostId: string
  revision: number
  enabled: boolean
  intervalMinutes: number
  dailyTime: string | null
  nextRunAt: string | null
  retentionEnabled: boolean
  keepCount: number | null
  maxAgeDays: number | null
  lastOutcome: string | null
  lastCheckedAt: string | null
  prunedCount: number
  lastPrunedAt: string | null
  cleanupError: string | null
}
interface Candidate {
  id: string
  bytes: string
  createdAt: string
  reason: string
}
interface Preview {
  items: Candidate[]
  total: number
  bytes: string
}
const props = defineProps<{
  servers: ServerArchive[]
  scope: string
  revision: number
  hosts: Host[]
  ready: boolean
}>()
const emit = defineEmits<{ error: [error: unknown]; changed: [] }>()
const { data, busy, error, refresh } = useResource(
  () => [props.scope, props.revision],
  (signal) =>
    api<Policy[]>(`/backup-policies${props.scope === 'all' ? '' : `?serverId=${props.scope}`}`, {
      signal,
    }),
  (ex) => emit('error', ex),
  true,
)
const available = computed(() =>
  props.servers.filter(
    (server) =>
      (props.scope === 'all' || server.id === props.scope) &&
      props.hosts.some((host) => host.serverId === server.id),
  ),
)
const modal = ref<HTMLDialogElement>(),
  first = ref<HTMLSelectElement>()
const serverId = ref(''),
  enabled = ref(false),
  dailyTime = ref('03:00')
const retention = ref(false),
  keepCount = ref<number | ''>(7),
  days = ref<number | ''>('')
const working = ref(false),
  formError = ref(''),
  message = ref(''),
  preview = ref<Preview>(),
  previewing = ref(false)
const selected = ref<Policy>(),
  showPreview = ref(false)
const selectedHost = computed(() => props.hosts.find((host) => host.serverId === serverId.value))
const selectedServer = computed(() => props.servers.find((server) => server.id === serverId.value))
const canEnable = computed(
  () =>
    selectedHost.value &&
    !selectedHost.value.revoked &&
    selectedServer.value?.status === 'RECORDING',
)
let opener: HTMLElement | null = null,
  timer: ReturnType<typeof setInterval> | undefined,
  disposed = false,
  previewController: AbortController | undefined
const outcomes: Record<string, string> = {
  QUEUED: '已下发本期任务',
  QUEUED_OFFLINE: '已排队，等待游戏主机运行',
  WAITING_TASK: '等待当前任务结束，不重复排队',
  HOST_REVOKED: '执行端连接密钥已停用，暂停下发',
  SERVER_ARCHIVED: '服务器已封存，自动制作与新增轮换均已停止',
}
function name(id: string) {
  return props.servers.find((server) => server.id === id)?.name ?? '服务器档案'
}
function scheduleTime(policy: Policy) {
  if (policy.dailyTime) return policy.dailyTime
  return policy.nextRunAt
    ? new Date(new Date(policy.nextRunAt).getTime() + 8 * 3600000).toISOString().slice(11, 16)
    : '03:00'
}
function localTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value))
}
function storageSize(bytes: string) {
  const size = Number(bytes)
  return size >= 1024 ** 3
    ? `${(size / 1024 ** 3).toFixed(2)} GiB`
    : size >= 1024 ** 2
      ? `${(size / 1024 ** 2).toFixed(1)} MiB`
      : `${size.toLocaleString('zh-CN')} B`
}
function loadFields() {
  resetPreview()
  selected.value = data.value?.find((policy) => policy.serverId === serverId.value)
  enabled.value = selected.value?.enabled ?? false
  dailyTime.value = selected.value ? scheduleTime(selected.value) : '03:00'
  retention.value = selected.value?.retentionEnabled ?? false
  keepCount.value = selected.value?.keepCount ?? ''
  days.value = selected.value?.maxAgeDays ?? ''
  if (!selected.value) keepCount.value = 7
  preview.value = undefined
  showPreview.value = false
  formError.value = ''
  previewController?.abort()
}
function resetPreview() {
  previewController?.abort()
  previewController = undefined
  preview.value = undefined
  showPreview.value = false
  previewing.value = false
}
async function open() {
  opener = document.activeElement as HTMLElement
  serverId.value = available.value[0]?.id ?? ''
  loadFields()
  await nextTick()
  modal.value?.showModal()
  first.value?.focus()
}
function close() {
  if (!working.value) modal.value?.close()
}
function afterClose() {
  previewController?.abort()
  preview.value = undefined
  if (!disposed && opener?.isConnected) opener.focus()
}
function retentionValues() {
  const count = keepCount.value === '' ? null : Number(keepCount.value),
    age = days.value === '' ? null : Number(days.value)
  if (
    (count !== null && (!Number.isInteger(count) || count < 1 || count > 1000)) ||
    (age !== null && (!Number.isInteger(age) || age < 1 || age > 3650))
  )
    throw new Error('保留数量须为 1 至 1000，天数须为 1 至 3650。')
  if (retention.value && count === null && age === null) throw new Error('请填写至少一项保留规则。')
  return { count, age }
}
async function inspectRetention() {
  previewController?.abort()
  const controller = new AbortController()
  previewController = controller
  previewing.value = true
  formError.value = ''
  preview.value = undefined
  showPreview.value = false
  try {
    const { count, age } = retentionValues(),
      query = new URLSearchParams()
    if (count !== null) query.set('keepCount', String(count))
    if (age !== null) query.set('maxAgeDays', String(age))
    const result = await api<Preview>(
      `/servers/${serverId.value}/backup-policy/retention-preview?${query}`,
      { signal: controller.signal },
    )
    if (previewController === controller) {
      preview.value = result
      showPreview.value = true
    }
  } catch (ex) {
    if (!controller.signal.aborted) {
      formError.value = failure(ex)
      emit('error', ex)
    }
  } finally {
    if (previewController === controller) previewing.value = false
  }
}
async function save() {
  if (working.value || !selectedHost.value) return
  formError.value = ''
  working.value = true
  const controller = new AbortController(),
    timeout = setTimeout(() => controller.abort(), 20000)
  try {
    const { count, age } = retentionValues()
    if (!/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(dailyTime.value))
      throw new Error('请选择每日备份时间。')
    await api(`/servers/${serverId.value}/backup-policy`, {
      method: 'PUT',
      signal: controller.signal,
      body: JSON.stringify({
        revision: selected.value?.revision ?? 0,
        hostId: selectedHost.value.id,
        enabled: enabled.value,
        intervalMinutes: 1440,
        firstRunAt: null,
        dailyTime: dailyTime.value,
        retentionEnabled: retention.value,
        keepCount: count,
        maxAgeDays: age,
      }),
    })
    message.value = '策略已保存，系统会按这台服务器的设置执行。'
    modal.value?.close()
    emit('changed')
    await refresh()
  } catch (ex) {
    formError.value = failure(ex)
    emit('error', ex)
  } finally {
    clearTimeout(timeout)
    working.value = false
  }
}
async function reloadSettings() {
  await refresh()
  if (!error.value) loadFields()
}
onMounted(() => {
  timer = setInterval(() => {
    if (
      !working.value &&
      !busy.value &&
      !modal.value?.open &&
      document.visibilityState === 'visible'
    )
      void refresh()
  }, 5000)
})
onScopeDispose(() => {
  disposed = true
  clearInterval(timer)
  previewController?.abort()
  modal.value?.close()
})
</script>

<template>
  <section class="panel policy-panel" aria-label="自动备份与清理">
    <div class="data-panel-heading">
      <div>
        <h2><CalendarClock :size="20" />自动备份与清理</h2>
        <p>每期服务器独立设置，默认关闭；中央服务持续运行时生效</p>
      </div>
      <div class="policy-actions">
        <button class="secondary" :disabled="busy" @click="refresh">
          <RefreshCw :size="16" />刷新策略</button
        ><button
          class="secondary"
          :disabled="!ready || busy || !!error || !available.length"
          @click="open"
        >
          <Settings :size="16" />配置自动备份
        </button>
      </div>
    </div>
    <p v-if="error" class="alert error" role="alert">
      {{ error }}<button class="text-button" @click="refresh">重试策略列表</button>
    </p>
    <p v-else-if="busy && !data" class="small-empty" role="status">正在读取自动备份策略…</p>
    <p v-else-if="!data?.length" class="small-empty">
      尚未配置自动备份。先添加游戏主机，再设置每天的备份时间和保留规则。
    </p>
    <article
      v-for="policy in data ?? []"
      :key="policy.serverId"
      :data-backup-policy="policy.serverId"
      class="policy-row"
    >
      <div class="policy-status">
        <strong>{{ name(policy.serverId) }}</strong
        ><span class="neutral-badge">{{
          policy.enabled ? `每天 ${scheduleTime(policy)}（UTC+8）` : '自动备份已关闭'
        }}</span>
      </div>
      <p>下次计划：{{ policy.nextRunAt ? localTime(policy.nextRunAt) : '未开启' }}</p>
      <p v-if="policy.lastOutcome">
        {{ outcomes[policy.lastOutcome] ?? '请查看备份任务结果'
        }}<span v-if="policy.lastCheckedAt"> · {{ displayTime(policy.lastCheckedAt) }}</span>
      </p>
      <p>
        {{
          policy.retentionEnabled
            ? `普通自动备份保留${policy.keepCount ? ` ${policy.keepCount} 份` : ''}${policy.maxAgeDays ? ` / ${policy.maxAgeDays} 天` : ''}，超出任一规则会轮换`
            : '自动清理旧备份已关闭'
        }}。永久保留、手动和最终封存备份不参与。
      </p>
      <p v-if="policy.prunedCount">
        已轮换 {{ policy.prunedCount }} 份<span v-if="policy.lastPrunedAt">
          · {{ displayTime(policy.lastPrunedAt) }}</span
        >
      </p>
      <p v-if="policy.cleanupError" class="policy-attention">
        文件清理尚未完成，原记录保留，后端会继续尝试；请检查存储权限和空间。
      </p>
    </article>
    <p v-if="message" class="alert success" role="status">{{ message }}</p>
    <dialog
      ref="modal"
      class="credential-dialog policy-dialog"
      aria-labelledby="policy-dialog-title"
      @cancel="working ? $event.preventDefault() : undefined"
      @close="afterClose"
    >
      <form @submit.prevent="save">
        <div class="dialog-heading">
          <div>
            <p class="eyebrow">BACKUP POLICY</p>
            <h2 id="policy-dialog-title">自动备份策略</h2>
          </div>
          <button
            type="button"
            class="icon-button"
            aria-label="关闭策略设置"
            :disabled="working"
            @click="close"
          >
            <X :size="19" />
          </button>
        </div>
        <label
          >策略所属服务器<select
            ref="first"
            v-model="serverId"
            :disabled="working"
            @change="loadFields"
          >
            <option v-for="server in available" :key="server.id" :value="server.id">
              {{ server.name }}
            </option>
          </select></label
        >
        <label class="policy-check"
          ><input
            v-model="enabled"
            type="checkbox"
            :disabled="working || (!canEnable && !enabled)"
          />启用每日自动备份</label
        >
        <p v-if="!canEnable" class="data-note">
          当前执行端连接密钥已停用或服务器已封存，可关闭制作；恢复条件后才能开启。
        </p>
        <label
          >每天备份时间（UTC+8）<input
            v-model="dailyTime"
            type="time"
            step="60"
            required
            :disabled="working"
        /></label>
        <p class="data-note">
          每天在选定的时间发起备份，与浏览器或游戏电脑的时区无关。今天的时间已过时，从明天开始；任务通常会在到点后
          15 秒左右排队。
        </p>
        <p class="data-note">
          离线时等待主机上线，错过多天只补一份，不会连续制作多份。修改时间会取消尚未开始的旧计划任务，正在执行的任务继续完成。
        </p>
        <label class="policy-check"
          ><input
            v-model="retention"
            type="checkbox"
            :disabled="working"
            @change="resetPreview"
          />启用自动清理旧备份，删除超出规则的普通自动备份</label
        >
        <div class="policy-retention">
          <label
            >保留普通自动备份数量<input
              v-model="keepCount"
              type="number"
              min="1"
              max="1000"
              step="1"
              :disabled="working || !retention"
              @input="resetPreview" /></label
          ><label
            >保留天数<input
              v-model="days"
              type="number"
              min="1"
              max="3650"
              step="1"
              :disabled="working || !retention"
              @input="resetPreview"
          /></label>
        </div>
        <p class="data-note">
          数量和天数可只填一项；同时填写时，超出任一规则即轮换。至少保留最新的一份普通自动备份，永久保留的备份额外保存。只清理中央游戏归档，玩家统计和游戏主机本地文件继续保留。
        </p>
        <p class="data-note">
          关闭定期制作与关闭轮换是两个独立设置。已经进入文件删除流程的记录会继续收尾；封存服务器不会新建制作或轮换操作。
        </p>
        <button
          type="button"
          class="secondary"
          :disabled="working || previewing || !retention"
          @click="inspectRetention"
        >
          {{ previewing ? '正在核对…' : '查看将清理哪些备份' }}
        </button>
        <div v-if="showPreview" class="policy-preview" role="status">
          <p>
            当前符合规则：{{ preview?.total ?? 0 }} 份<span v-if="preview"
              >（{{ storageSize(preview.bytes) }}）</span
            >。保存后系统会按规则清理，执行前再次核对保护设置。下方最多展示 5 份。
          </p>
          <ul>
            <li v-for="item in preview?.items.slice(0, 5)" :key="item.id">
              <code>{{ item.id }}</code
              ><span
                >{{ displayTime(item.createdAt) }} ·
                {{ item.reason === 'AGE' ? '超出天数' : '超出数量' }}</span
              >
            </li>
          </ul>
        </div>
        <p v-if="formError" class="alert error" role="alert">
          {{ formError
          }}<button type="button" class="text-button" :disabled="working" @click="reloadSettings">
            重新加载已保存设置
          </button>
        </p>
        <div class="dialog-actions">
          <button type="button" class="secondary" :disabled="working" @click="close">返回</button
          ><button class="primary" :disabled="working || !selectedHost">
            {{ working ? '正在保存…' : '保存备份策略' }}
          </button>
        </div>
      </form>
    </dialog>
  </section>
</template>

<style scoped>
.policy-panel {
  min-width: 0;
}
.policy-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.policy-row {
  padding: 20px 24px;
  border-top: 1px solid #edf1ec;
  min-width: 0;
}
.policy-status {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
}
.policy-status strong {
  font-size: 14px;
  overflow-wrap: anywhere;
}
.policy-row p {
  font-size: 12px;
  color: #728176;
  line-height: 1.9;
  margin-top: 10px;
}
.policy-row .policy-attention {
  color: #896421;
}
.policy-check {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 10px;
}
.policy-check input {
  width: 16px;
  min-height: 16px;
  flex: none;
}
.policy-dialog {
  width: min(650px, calc(100% - 32px));
}
.policy-retention {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
.policy-preview {
  margin-top: 16px;
  background: #f4f8f4;
  padding: 14px;
  font-size: 12px;
  line-height: 1.8;
}
.policy-preview ul {
  padding-left: 15px;
}
.policy-preview li {
  margin-top: 10px;
  overflow-wrap: anywhere;
}
.policy-preview span {
  display: block;
  color: #728176;
}
.policy-panel > .alert {
  margin: 16px 20px;
}
.policy-dialog .dialog-actions {
  background: #fff;
}
@media (max-width: 560px) {
  .policy-retention {
    grid-template-columns: 1fr;
    gap: 0;
  }
  .policy-row {
    padding: 18px;
  }
  .policy-dialog .dialog-actions {
    position: sticky;
    bottom: -22px;
    padding-bottom: 8px;
    flex-wrap: wrap;
  }
  .policy-dialog .dialog-actions > * {
    flex: 1;
    justify-content: center;
  }
}
</style>
