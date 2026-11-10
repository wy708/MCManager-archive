<script setup lang="ts">
import { t } from '../i18n'

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
    saved.value = t('m0881', [result.retentionDays, formatInteger(result.removedEntries)])
    if (result.batchLimitReached)
      saved.value += data.value?.automaticCleanupEnabled
        ? t('m0882')
        : t('m0883')
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
        <h2 id="platform-storage-title">{{ t('m0884') }}</h2>
        <p>{{ t('m0885') }}</p>
      </div>
      <button class="secondary" :disabled="busy || working" @click="refreshStorage">{{ t('m0886') }}</button>
    </div>
    <p v-if="error" class="alert error" role="alert">{{ error }}</p>
    <p v-else-if="busy" class="data-note" role="status">{{ t('m0887') }}</p>
    <template v-else-if="data">
      <dl class="collector-details">
        <div>
          <dt>{{ t('m0888') }}</dt>
          <dd>{{ formatRestoreBytes(data.storage.volume?.usableBytes) }}</dd>
        </div>
        <div>
          <dt>{{ t('m0889') }}</dt>
          <dd>{{ formatRestoreBytes(data.storage.volume?.totalBytes) }}</dd>
        </div>
        <div>
          <dt>{{ t('m0890') }}</dt>
          <dd>
            {{ t('m0891', [formatInteger(data.storage.readyCount), formatRestoreBytes(data.storage.readyArchiveBytes)]) }}
          </dd>
        </div>
        <div>
          <dt>{{ t('m0892') }}</dt>
          <dd>{{ formatRestoreBytes(data.storage.maxUploadBytes) }}</dd>
        </div>
      </dl>
      <p class="data-note">{{ t('m0893') }}</p>
      <form class="retention-form" @submit.prevent="previewRetention">
        <label
          >{{ t('m0894') }}<input
            v-model.number="days"
            type="number"
            min="1"
            max="365"
            step="1"
            required
            :disabled="working"
        /></label>
        <button type="submit" class="secondary" :disabled="working">{{ t('m0895') }}</button>
      </form>
      <p class="data-note">{{ t('m0896', [data.retentionDays]) }}</p>
      <p v-if="!data.automaticCleanupEnabled" class="data-note">{{ t('m0897') }}</p>
      <div v-if="preview" class="retention-preview">
        <p>{{ t('m0898', [preview.requestedDays, displayTime(preview.cutoff, 'UTC'), formatInteger(preview.chatEntries), formatInteger(preview.behaviorEntries)]) }}</p>
        <p>{{ t('m0899') }}</p>
        <div class="retention-actions">
          <button class="primary" :disabled="working" @click="saveRetention">{{ t('m0900') }}</button>
          <button class="secondary" :disabled="working" @click="preview = undefined">{{ t('m0901') }}</button>
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
