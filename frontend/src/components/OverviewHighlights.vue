<script setup lang="ts">
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
    label: '记录中的服务器',
    icon: 'grass' as const,
    ghost: Layers,
    value: formatInteger(props.servers.filter((server) => server.status === 'RECORDING').length),
    note: '所选范围内正在记录的档案',
  },
  {
    key: 'players',
    label: '累计玩家',
    icon: 'player' as const,
    ghost: Users,
    value: !props.summary
      ? '加载中…'
      : covered.value
        ? formatInteger(props.summary.playerCount)
        : '未接入',
    note: '同一位玩家只计算一次',
  },
  {
    key: 'online',
    label: '累计在线',
    icon: 'crystal' as const,
    ghost: Clock3,
    value: !props.summary ? '加载中…' : formatValue(online.value?.value, online.value?.unit),
    note: '所有玩家的总时长，包含挂机',
  },
  {
    key: 'backups',
    label: '完整备份',
    icon: 'chest' as const,
    ghost: HardDrive,
    value: busy.value
      ? '加载中…'
      : error.value
        ? '暂不可读'
        : formatInteger(data.value?.readyCount),
    note: error.value || '已保存并通过文件检查',
  },
])
</script>
<template>
  <section class="metric-grid overview-highlights" aria-label="世界概况">
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
