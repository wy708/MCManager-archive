<script setup lang="ts">
import { t } from '../i18n'

import { computed } from 'vue'
import type { Summary } from '../statistics'
import { formatValue, formatInteger } from '../statistics'
const props = defineProps<{ summary: Summary }>()
const value = (key: string) => props.summary.metrics.find((metric) => metric.key === key)?.value
const rows = computed(() => [
  { label: t('m0683'), value: formatInteger(value('deaths')) },
  { label: t('m1454'), value: formatInteger(value('level.max')) },
  { label: t('m1455'), value: formatInteger(props.summary.confirmedJoinCount) },
  { label: t('m1456'), value: formatInteger(props.summary.sessionCount) },
  { label: t('m1457'), value: formatValue(props.summary.longestSessionMillis, 'ms') },
  { label: t('m0548'), value: formatInteger(props.summary.woodBlocks) },
  { label: t('m1458'), value: formatInteger(props.summary.oreBlocks) },
])
</script>
<template>
  <section class="panel summary-details">
    <h2>{{ t('m1459') }}</h2>
    <dl>
      <div v-for="row in rows" :key="row.label">
        <dt>{{ row.label }}</dt>
        <dd>{{ row.value }}</dd>
      </div>
    </dl>
    <details class="plain-details">
      <summary>{{ t('m1460') }}</summary>
      <p>{{ t('m1461') }}</p>
      <p>{{ t('m1462') }}</p>
    </details>
  </section>
</template>
