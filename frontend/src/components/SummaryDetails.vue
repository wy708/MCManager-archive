<script setup lang="ts">
import { computed } from 'vue'
import type { Summary } from '../statistics'
import { formatValue, formatInteger } from '../statistics'
const props = defineProps<{ summary: Summary }>()
const value = (key: string) => props.summary.metrics.find((metric) => metric.key === key)?.value
const rows = computed(() => [
  { label: '死亡次数', value: formatInteger(value('deaths')) },
  { label: '记录中的最高等级', value: formatInteger(value('level.max')) },
  { label: '记录到的上线次数', value: formatInteger(props.summary.confirmedJoinCount) },
  { label: '游玩记录段数', value: formatInteger(props.summary.sessionCount) },
  { label: '最长单次游玩', value: formatValue(props.summary.longestSessionMillis, 'ms') },
  { label: '原木 / 菌柄', value: formatInteger(props.summary.woodBlocks) },
  { label: '矿石 / 远古残骸', value: formatInteger(props.summary.oreBlocks) },
])
</script>
<template>
  <section class="panel summary-details">
    <h2>更多记录</h2>
    <dl>
      <div v-for="row in rows" :key="row.label">
        <dt>{{ row.label }}</dt>
        <dd>{{ row.value }}</dd>
      </div>
    </dl>
    <details class="plain-details">
      <summary>这些记录怎么计算？</summary>
      <p>
        上线次数只统计插件确认的进服。一次游玩中途断开记录后，可能会分成几段。伐木和采矿已包含在挖掘总数中。
      </p>
      <p>最高等级是所选时间里实际记录到的最高值，不会把不同服务器的等级相加。</p>
    </details>
  </section>
</template>
