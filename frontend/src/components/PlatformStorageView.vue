<script setup lang="ts">
import { ref, watch } from 'vue'
import { api } from '../api'
import { formatRestoreBytes } from '../restores'
import { displayTime, failure, formatInteger } from '../statistics'
import { useResource } from '../useResource'

interface Storage {
  readyCount: number
  readyArchiveBytes: string
  maxUploadBytes: string
  volume: { totalBytes: string; usableBytes: string } | null
}
interface Preview {
  currentDays: number
  requestedDays: number
  cutoff: string
  chatEntries: number
  behaviorEntries: number
}
interface RetentionResult {
  retentionDays: number
  removedEntries: number
  batchLimitReached: boolean
}
const emit = defineEmits<{ error: [error: unknown] }>()
const { data, busy, error, refresh } = useResource(
  () => true,
  async (signal) => {
    const [storage, policy] = await Promise.all([
      api<Storage>('/backups/storage', { signal }),
      api<{ retentionDays: number; automaticCleanupEnabled: boolean }>('/activity/retention', {
        signal,
      }),
    ])
    return { storage, ...policy }
  },
  (ex) => emit('error', ex),
)
const days = ref<number | ''>('')
const preview = ref<Preview>()
const working = ref(false)
const formError = ref('')
const saved = ref('')
watch(data, (value) => {
  if (value) days.value = value.retentionDays
})
watch(days, () => {
  preview.value = undefined
  formError.value = ''
})

function refreshStorage() {
  preview.value = undefined
  return refresh()
}

async function previewRetention() {
  if (working.value || days.value === '') return
  working.value = true
  preview.value = undefined
  formError.value = ''
  saved.value = ''
  try {
    preview.value = await api<Preview>(`/activity/retention-preview?days=${days.value}`)
  } catch (ex) {
    formError.value = failure(ex)
    emit('error', ex)
  } finally {
    working.value = false
  }
}
async function saveRetention() {
  const reviewed = preview.value
  if (working.value || !reviewed || reviewed.requestedDays !== days.value) return
  working.value = true
  formError.value = ''
  try {
    const result = await api<RetentionResult>('/activity/retention', {
      method: 'PUT',
      body: JSON.stringify({ days: reviewed.requestedDays, expectedDays: reviewed.currentDays }),
    })
    preview.value = undefined
    saved.value = `已保存 ${result.retentionDays} 天保留期，本次清理 ${formatInteger(result.removedEntries)} 条。`
    if (result.batchLimitReached)
      saved.value += data.value?.automaticCleanupEnabled
        ? '其余超期明细由后台分批清理。'
        : '可再次保存以清理下一批超期明细。'
    await refresh()
  } catch (ex) {
    formError.value = failure(ex)
    emit('error', ex)
  } finally {
    working.value = false
  }
}
</script>

<template>
  <section class="panel data-panel" aria-labelledby="platform-storage-title">
    <div class="data-panel-heading">
      <div>
        <h2 id="platform-storage-title">存储与保留</h2>
        <p>适用于平台内所有服务器档案</p>
      </div>
      <button class="secondary" :disabled="busy || working" @click="refreshStorage">
        刷新存储
      </button>
    </div>
    <p v-if="error" class="alert error" role="alert">{{ error }}</p>
    <p v-else-if="busy" class="data-note" role="status">正在读取存储和保留设置…</p>
    <template v-else-if="data">
      <dl class="collector-details">
        <div>
          <dt>备份目录所在卷可用空间</dt>
          <dd>{{ formatRestoreBytes(data.storage.volume?.usableBytes) }}</dd>
        </div>
        <div>
          <dt>所在卷总容量</dt>
          <dd>{{ formatRestoreBytes(data.storage.volume?.totalBytes) }}</dd>
        </div>
        <div>
          <dt>备份目录册</dt>
          <dd>
            {{ formatInteger(data.storage.readyCount) }} 份 ·
            {{ formatRestoreBytes(data.storage.readyArchiveBytes) }}
          </dd>
        </div>
        <div>
          <dt>单份上传上限</dt>
          <dd>{{ formatRestoreBytes(data.storage.maxUploadBytes) }}</dd>
        </div>
      </dl>
      <p class="data-note">目录册大小按可用备份记录合计。所在卷可能还存有其他文件。</p>
      <form class="retention-form" @submit.prevent="previewRetention">
        <label
          >行为与聊天明细保留天数<input
            v-model.number="days"
            type="number"
            min="1"
            max="365"
            step="1"
            required
            :disabled="working"
        /></label>
        <button type="submit" class="secondary" :disabled="working">预览超期明细</button>
      </form>
      <p class="data-note">
        当前保留
        {{ data.retentionDays }} 天，按中央收到明细的时间计算。累计统计、去重记录和备份独立保留。
      </p>
      <p v-if="!data.automaticCleanupEnabled" class="data-note">
        自动物理清理已停用。超期明细仍会从查询中隐藏，保存策略可手动清理一批。
      </p>
      <div v-if="preview" class="retention-preview">
        <p>
          按 {{ preview.requestedDays }} 天策略，截至
          {{ displayTime(preview.cutoff, 'UTC') }}（UTC）前的明细中，现有聊天
          {{ formatInteger(preview.chatEntries) }} 条，行为
          {{ formatInteger(preview.behaviorEntries) }} 条。
        </p>
        <p>保存后超期明细将从网页和 MCP 查询中移除，并分批从数据库清理。已清理的明细无法恢复。</p>
        <div class="retention-actions">
          <button class="primary" :disabled="working" @click="saveRetention">
            保存并清理超期明细
          </button>
          <button class="secondary" :disabled="working" @click="preview = undefined">
            取消预览
          </button>
        </div>
      </div>
    </template>
    <p v-if="formError" class="alert error" role="alert">{{ formError }}</p>
    <p v-if="saved" class="alert success" role="status">{{ saved }}</p>
  </section>
</template>

<style scoped>
.retention-form,
.retention-actions {
  display: flex;
  align-items: end;
  flex-wrap: wrap;
  gap: 0.75rem;
}
.retention-form label {
  display: grid;
  gap: 0.35rem;
}
.retention-form input {
  width: 8rem;
}
.retention-preview {
  padding: 0.75rem 1rem;
  margin-block: 0.75rem;
  border: 1px solid var(--border, #dce4da);
  border-radius: 0.75rem;
}
</style>
