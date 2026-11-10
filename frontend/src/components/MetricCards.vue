<script setup lang="ts">
import { t } from '../i18n'

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
    label: t('m0820'),
    icon: Users,
    value: props.summary && hasCoverage.value ? formatInteger(props.summary.playerCount) : t('m0272'),
    note: t('m0821'),
    metric: undefined,
  },
  ...[
    { key: 'online.millis', label: t('m0677'), icon: Clock3, note: t('m0822') },
    { key: 'blocks.mined', label: t('m0680'), icon: Box, note: t('m0823') },
    { key: 'experience.gained', label: t('m0824'), icon: Sparkles, note: t('m0825') },
  ].map((card) => ({
    ...card,
    value: formatValue(metric(card.key)?.value, metric(card.key)?.unit),
    metric: metric(card.key),
  })),
])
</script>
<template>
  <section class="metric-grid" :aria-label="t('m0826')">
    <article
      v-for="card in cards"
      :key="card.key"
      class="metric-card"
      :class="{ 'muted-metric': card.value === t('m0272') }"
      :data-metric="card.key"
    >
      <span class="metric-icon"><component :is="card.icon" :size="25" /></span>
      <div>
        <span>{{ card.label }}</span
        ><strong
          :class="{
            unavailable: card.value === t('m0272'),
            'duration-value': card.key === 'online.millis',
          }"
          >{{ loading ? t('m0827') : card.value }}</strong
        >
        <p>{{ card.note }}</p>
        <small v-if="card.metric && card.metric.value !== null" class="coverage-label"
          >{{ t('m0828', [card.metric.coveredServers, card.metric.selectedServers]) }}</small
        >
      </div>
    </article>
  </section>
</template>
