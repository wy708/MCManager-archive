<script setup lang="ts">
import { computed } from 'vue'
import { Clock3, Box, Sparkles, Users } from '@lucide/vue'
import type { Summary } from '../statistics'
import { formatValue, formatInteger } from '../statistics'
const props = defineProps<{ summary: Summary | null; loading?: boolean }>()
const metric = (key: string) => props.summary?.metrics.find((m) => m.key === key)
const hasCoverage = computed(() => props.summary?.metrics.some((m) => m.coveredServers > 0))
const cards = computed(() => [
  {
    key: 'players',
    label: '已记录玩家',
    icon: Users,
    value: props.summary && hasCoverage.value ? formatInteger(props.summary.playerCount) : '未接入',
    note: '按稳定身份跨服务器去重',
    metric: undefined,
  },
  ...[
    { key: 'online.millis', label: '累计在线', icon: Clock3, note: '已确认时长，包含挂机' },
    { key: 'blocks.mined', label: '挖掘方块', icon: Box, note: '伐木和采矿已包含其中' },
    { key: 'experience.gained', label: '累计获得经验', icon: Sparkles, note: '消耗或损失不倒扣' },
  ].map((card) => ({
    ...card,
    value: formatValue(metric(card.key)?.value, metric(card.key)?.unit),
    metric: metric(card.key),
  })),
])
</script>
<template>
  <section class="metric-grid" aria-label="统计概况">
    <article
      v-for="card in cards"
      :key="card.key"
      class="metric-card"
      :class="{ 'muted-metric': card.value === '未接入' }"
      :data-metric="card.key"
    >
      <span class="metric-icon"><component :is="card.icon" :size="25" /></span>
      <div>
        <span>{{ card.label }}</span
        ><strong
          :class="{
            unavailable: card.value === '未接入',
            'duration-value': card.key === 'online.millis',
          }"
          >{{ loading ? '加载中…' : card.value }}</strong
        >
        <p>{{ card.note }}</p>
        <small v-if="card.metric && card.metric.value !== null" class="coverage-label"
          >曾启用 {{ card.metric.coveredServers }}/{{ card.metric.selectedServers }} 服</small
        >
      </div>
    </article>
  </section>
</template>
