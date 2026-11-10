<script setup lang="ts">
import { t, formatLocale } from '../i18n'

import { computed } from 'vue'
import { Activity, ArrowRight, Server } from '@lucide/vue'
import { api, type ServerArchive } from '../api'
import { useResource } from '../useResource'
const props = defineProps<{ scope: string; servers: ServerArchive[]; revision: number }>()
const emit = defineEmits<{ open: [server: string] }>()
const server = computed(
  () =>
    props.servers.find((s) => s.id === props.scope) ??
    props.servers.find((s) => s.status === 'RECORDING') ??
    props.servers[0],
)
interface Runtime {
  state: string
  latest: {
    at: string
    hostCpuPercent: number | null
    cpuPercent: number | null
    hostMemoryTotalBytes: number | null
    hostMemoryAvailableBytes: number | null
  } | null
}
// One snapshot for the selected/first recording server. No dashboard polling or fleet-wide fanout.
const { data, busy, error, refresh } = useResource(
  () => [server.value?.id, props.revision],
  (signal) =>
    server.value
      ? api<Runtime>(`/servers/${server.value.id}/runtime?hours=1`, { signal })
      : Promise.resolve(null),
  () => {},
)
const fresh = computed(
  () => !error.value && ['HEALTHY', 'SLOW', 'TICK_STALLED'].includes(data.value?.state ?? ''),
)
const state = computed(() =>
  busy.value
    ? t('m0829')
    : error.value
      ? t('m0830')
      : ({
          HEALTHY: t('m0831'),
          SLOW: t('m0832'),
          TICK_STALLED: t('m0833'),
          STALE: t('m0834'),
          STOPPED: t('m0835'),
          NO_DATA: t('m0836'),
        }[data.value?.state ?? 'NO_DATA'] ?? t('m0837')),
)
const bars = computed(() => {
  const last = data.value?.latest
  return [
    { name: t('m0838'), value: last?.hostCpuPercent },
    {
      name: t('m0839'),
      value:
        last?.hostMemoryTotalBytes && last.hostMemoryAvailableBytes != null
          ? (1 - last.hostMemoryAvailableBytes / last.hostMemoryTotalBytes) * 100
          : null,
    },
    { name: t('m0731'), value: last?.cpuPercent },
  ]
})
</script>
<template>
  <article class="panel dashboard-runtime">
    <div class="panel-heading">
      <h2><Activity :size="20" />{{ t('m0840') }}</h2>
      <span class="status" :class="fresh && data?.state === 'HEALTHY' ? 'recording' : 'archived'">{{
        state
      }}</span>
    </div>
    <div class="dashboard-runtime-body">
      <p class="runtime-server-name"><Server :size="15" />{{ server?.name ?? t('m0841') }}</p>
      <p v-if="scope === 'all' && servers.length > 1" class="data-note">{{ t('m0842') }}</p>
      <div v-for="bar in bars" :key="bar.name" class="runtime-meter">
        <span>{{ bar.name }}</span>
        <div class="meter-track">
          <i
            :style="{
              width: (fresh && bar.value != null ? Math.min(100, Math.max(0, bar.value)) : 0) + '%',
            }"
          ></i>
        </div>
        <strong>{{ fresh && bar.value != null ? bar.value.toFixed(0) + '%' : '—' }}</strong>
      </div>
      <p class="runtime-snapshot-note">
        {{
          data?.latest
            ? t('m0843') + new Date(data.latest.at).toLocaleString(formatLocale, { hour12: false })
            : t('m0844')
        }}
      </p>
      <div class="runtime-card-actions">
        <button class="text-button" :disabled="busy || !server" @click="refresh">{{ t('m0845') }}</button
        ><button class="text-button" :disabled="!server" @click="emit('open', server!.id)">{{ t('m0846') }}<ArrowRight :size="15" />
        </button>
      </div>
    </div>
  </article>
</template>
