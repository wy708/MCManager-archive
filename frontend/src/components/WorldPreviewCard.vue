<script setup lang="ts">
import { t } from '../i18n'

import { ArrowRight, Clock3, Users } from '@lucide/vue'
import { api, type ServerArchive } from '../api'
import { formatInteger, formatValue, type Summary } from '../statistics'
import { useResource } from '../useResource'
const props = defineProps<{ server: ServerArchive; scene: string; revision: number }>()
const emit = defineEmits<{ select: []; error: [error: unknown] }>()
const { data, error, busy } = useResource(
  () => [props.server.id, props.revision],
  (signal) => api<Summary>('/statistics/summary?serverId=' + props.server.id, { signal }),
  (ex) => emit('error', ex),
)
</script>
<template>
  <button class="world-preview" @click="emit('select')">
    <span class="world-cover" :class="'scene-' + scene" aria-hidden="true"></span>
    <span class="world-preview-body">
      <strong>{{ server.name }}</strong
      ><span class="status" :class="server.status.toLowerCase()">{{
        server.status === 'RECORDING' ? t('m0063') : t('m0064')
      }}</span>
      <span class="world-description">{{
        server.description || t('m1540')
      }}</span>
      <span v-if="busy" class="world-preview-metrics">{{ t('m1541') }}</span
      ><span v-else-if="error" class="world-preview-metrics">{{ t('m1542') }}</span>
      <span v-else class="world-preview-metrics"
        ><span
          ><Users :size="14" />{{
            data?.metrics.some((metric) => metric.coveredServers > 0)
              ? formatInteger(data.playerCount) + t('m1543')
              : t('m0272')
          }}</span
        ><span
          ><Clock3 :size="14" />{{
            formatValue(data?.metrics.find((metric) => metric.key === 'online.millis')?.value, 'ms')
          }}</span
        ></span
      >
      <span class="world-preview-link">{{ t('m0933') }}<ArrowRight :size="14" /></span>
    </span>
  </button>
</template>
