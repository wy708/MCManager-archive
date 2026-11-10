<script setup lang="ts">
import { t, formatLocale } from '../i18n'

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
  QUEUED: t('m0368'),
  QUEUED_OFFLINE: t('m0369'),
  WAITING_TASK: t('m0370'),
  HOST_REVOKED: t('m0371'),
  SERVER_ARCHIVED: t('m0372'),
}
function name(id: string) {
  return props.servers.find((server) => server.id === id)?.name ?? t('m0044')
}
function scheduleTime(policy: Policy) {
  if (policy.dailyTime) return policy.dailyTime
  return policy.nextRunAt
    ? new Date(new Date(policy.nextRunAt).getTime() + 8 * 3600000).toISOString().slice(11, 16)
    : '03:00'
}
function localTime(value: string) {
  return new Intl.DateTimeFormat(formatLocale, {
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
      : `${size.toLocaleString(formatLocale)} B`
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
    throw new Error(t('m0373'))
  if (retention.value && count === null && age === null) throw new Error(t('m0374'))
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
      throw new Error(t('m0375'))
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
    message.value = t('m0376')
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
  <section class="panel policy-panel" :aria-label="t('m0377')">
    <div class="data-panel-heading">
      <div>
        <h2><CalendarClock :size="20" />{{ t('m0377') }}</h2>
        <p>{{ t('m0378') }}</p>
      </div>
      <div class="policy-actions">
        <button class="secondary" :disabled="busy" @click="refresh">
          <RefreshCw :size="16" />{{ t('m0379') }}</button
        ><button
          class="secondary"
          :disabled="!ready || busy || !!error || !available.length"
          @click="open"
        >
          <Settings :size="16" />{{ t('m0380') }}</button>
      </div>
    </div>
    <p v-if="error" class="alert error" role="alert">
      {{ error }}<button class="text-button" @click="refresh">{{ t('m0381') }}</button>
    </p>
    <p v-else-if="busy && !data" class="small-empty" role="status">{{ t('m0382') }}</p>
    <p v-else-if="!data?.length" class="small-empty">{{ t('m0383') }}</p>
    <article
      v-for="policy in data ?? []"
      :key="policy.serverId"
      :data-backup-policy="policy.serverId"
      class="policy-row"
    >
      <div class="policy-status">
        <strong>{{ name(policy.serverId) }}</strong
        ><span class="neutral-badge">{{
          policy.enabled ? t('m0384', [scheduleTime(policy)]) : t('m0385')
        }}</span>
      </div>
      <p>{{ t('m0387', [policy.nextRunAt ? localTime(policy.nextRunAt) : t('m0386')]) }}</p>
      <p v-if="policy.lastOutcome">
        {{ outcomes[policy.lastOutcome] ?? t('m0388')
        }}<span v-if="policy.lastCheckedAt"> · {{ displayTime(policy.lastCheckedAt) }}</span>
      </p>
      <p>
        {{ t('m0393', [policy.retentionEnabled
            ? t('m0391', [policy.keepCount ? t('m0389', [policy.keepCount]) : '', policy.maxAgeDays ? t('m0390', [policy.maxAgeDays]) : ''])
            : t('m0392')]) }}</p>
      <p v-if="policy.prunedCount">{{ t('m0394', [policy.prunedCount]) }}<span v-if="policy.lastPrunedAt">
          · {{ displayTime(policy.lastPrunedAt) }}</span
        >
      </p>
      <p v-if="policy.cleanupError" class="policy-attention">{{ t('m0395') }}</p>
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
            <h2 id="policy-dialog-title">{{ t('m0396') }}</h2>
          </div>
          <button
            type="button"
            class="icon-button"
            :aria-label="t('m0397')"
            :disabled="working"
            @click="close"
          >
            <X :size="19" />
          </button>
        </div>
        <label
          >{{ t('m0398') }}<select
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
          />{{ t('m0399') }}</label
        >
        <p v-if="!canEnable" class="data-note">{{ t('m0400') }}</p>
        <label
          >{{ t('m0401') }}<input
            v-model="dailyTime"
            type="time"
            step="60"
            required
            :disabled="working"
        /></label>
        <p class="data-note">{{ t('m0402') }}</p>
        <p class="data-note">{{ t('m0403') }}</p>
        <label class="policy-check"
          ><input
            v-model="retention"
            type="checkbox"
            :disabled="working"
            @change="resetPreview"
          />{{ t('m0404') }}</label
        >
        <div class="policy-retention">
          <label
            >{{ t('m0405') }}<input
              v-model="keepCount"
              type="number"
              min="1"
              max="1000"
              step="1"
              :disabled="working || !retention"
              @input="resetPreview" /></label
          ><label
            >{{ t('m0406') }}<input
              v-model="days"
              type="number"
              min="1"
              max="3650"
              step="1"
              :disabled="working || !retention"
              @input="resetPreview"
          /></label>
        </div>
        <p class="data-note">{{ t('m0407') }}</p>
        <p class="data-note">{{ t('m0408') }}</p>
        <button
          type="button"
          class="secondary"
          :disabled="working || previewing || !retention"
          @click="inspectRetention"
        >
          {{ previewing ? t('m0409') : t('m0410') }}
        </button>
        <div v-if="showPreview" class="policy-preview" role="status">
          <p>{{ t('m0411', [preview?.total ?? 0]) }}<span v-if="preview"
              >（{{ storageSize(preview.bytes) }}）</span
            >{{ t('m0412') }}</p>
          <ul>
            <li v-for="item in preview?.items.slice(0, 5)" :key="item.id">
              <code>{{ item.id }}</code
              ><span
                >{{ displayTime(item.createdAt) }} ·
                {{ item.reason === 'AGE' ? t('m0413') : t('m0414') }}</span
              >
            </li>
          </ul>
        </div>
        <p v-if="formError" class="alert error" role="alert">
          {{ formError
          }}<button type="button" class="text-button" :disabled="working" @click="reloadSettings">{{ t('m0415') }}</button>
        </p>
        <div class="dialog-actions">
          <button type="button" class="secondary" :disabled="working" @click="close">{{ t('m0416') }}</button
          ><button class="primary" :disabled="working || !selectedHost">
            {{ working ? t('m0417') : t('m0418') }}
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
