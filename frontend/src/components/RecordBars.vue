<script setup lang="ts">
import { computed } from 'vue'
import type { EChartsOption } from 'echarts'
import { formatValue } from '../statistics'
import DataChart from './DataChart.vue'
const props = defineProps<{
  rows: { label: string; raw: string }[]
  unit?: string
  label: string
}>()
const divisor = computed(() => (props.unit === 'ms' ? 3600000 : props.unit === 'mm' ? 1000 : 1))
const unitName = computed(() =>
  props.unit === 'ms' ? '小时' : props.unit === 'mm' ? '米' : '数量',
)
const option = computed<EChartsOption>(() => ({
  grid: { left: 12, right: 30, top: 25, bottom: 20, containLabel: true },
  tooltip: {
    trigger: 'axis',
    renderMode: 'richText',
    axisPointer: { type: 'shadow' },
    formatter: (params) => {
      const row = Array.isArray(params) ? params[0] : params
      const item = row && props.rows[row.dataIndex]
      return item ? `${item.label}\n${formatValue(item.raw, props.unit)}` : ''
    },
  },
  xAxis: {
    type: 'value',
    name: unitName.value,
    nameLocation: 'middle',
    nameGap: 28,
    splitLine: { lineStyle: { color: '#eef3f0', type: 'dashed' } },
  },
  yAxis: {
    type: 'category',
    inverse: true,
    data: props.rows.map((r) => r.label),
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { width: 110, overflow: 'truncate' },
  },
  series: [
    {
      type: 'bar',
      barMaxWidth: 20,
      itemStyle: { borderRadius: [0, 6, 6, 0] },
      data: props.rows.map((r, i) => ({
        value: Number(r.raw) / divisor.value,
        itemStyle: { color: ['#349f7b', '#8298df', '#b894d4', '#e4b264'][i % 4] },
      })),
    },
  ],
}))
</script>
<template>
  <div class="record-bars">
    <DataChart
      :option="option"
      :label="label"
      :height="Math.max(200, Math.min(rows.length, 10) * 34 + 65)"
    />
  </div>
</template>
