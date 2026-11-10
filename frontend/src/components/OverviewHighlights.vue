<script setup lang="ts">
import { t } from '../i18n'

import { computed } from 'vue'
import { Layers, Users, Clock3, HardDrive } from '@lucide/vue'
import { api, type ServerArchive } from '../api'
import { formatInteger, formatValue, query, type Summary } from '../statistics'
import { useResource } from '../useResource'
import GameIcon from './GameIcon.vue'
const props = defineProps<{
  summary: Summary | null
  servers: ServerArchive[]
  scope: string
  revision: number
}>()
const emit = defineEmits<{ error: [error: unknown] }>()
const { data, error, busy } = useResource(
  () => [props.scope, props.revision],
  (signal) => api<{ readyCount: number }>('/backups/summary' + query(props.scope), { signal }),
  (ex) => emit('error', ex),
)
const covered = computed(() => props.summary?.metrics.some((metric) => metric.coveredServers > 0))
const online = computed(() =>
  props.summary?.metrics.find((metric) => metric.key === 'online.millis'),
)
const cards = computed(() => [
  {
    key: 'servers',
    label: t('m0847'),
    icon: 'grass' as const,
    ghost: Layers,
    value: formatInteger(props.servers.filter((server) => server.status === 'RECORDING').length),
    note: t('m0848'),
  },
  {
    key: 'players',
    label: t('m0849'),
    icon: 'player' as const,
    ghost: Users,
    value: !props.summary
      ? t('m0827')
      : covered.value
        ? formatInteger(props.summary.playerCount)
        : t('m0272'),
    note: t('m0850'),
  },
  {
    key: 'online',
    label: t('m0677'),
    icon: 'crystal' as const,
    ghost: Clock3,
    value: !props.summary ? t('m0827') : formatValue(online.value?.value, online.value?.unit),
    note: t('m0851'),
  },
  {
    key: 'backups',
    label: t('m0852'),
    icon: 'chest' as const,
    ghost: HardDrive,
    value: busy.value
      ? t('m0827')
      : error.value
        ? t('m0853')
        : formatInteger(data.value?.readyCount),
    note: error.value || t('m0854'),
  },
])
</script>
<template>
  <section class="metric-grid overview-highlights" :aria-label="t('m0855')">
    <article
      v-for="card in cards"
      :key="card.key"
      class="metric-card overview-highlight"
      :data-overview-metric="card.key"
    >
      <GameIcon :kind="card.icon" />
      <div>
        <span>{{ card.label }}</span
        ><strong :class="{ 'highlight-duration': card.key === 'online' }">{{ card.value }}</strong>
      </div>
      <p>{{ card.note }}</p>
      <component :is="card.ghost" class="highlight-ghost" :size="56" aria-hidden="true" />
    </article>
  </section>
</template>
