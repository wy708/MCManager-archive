<script setup lang="ts">
import { t, formatLocale } from '../i18n'

import { computed, ref } from 'vue'
import type { EChartsOption } from 'echarts'
import DataChart from './DataChart.vue'
import { Activity } from '@lucide/vue'
import type { DailyPoint } from '../statistics'
import { formatValue } from '../statistics'
import { compactChartNumber } from '../chartNumbers'
const props = defineProps<{ points: DailyPoint[]; zone: string }>()
const mode = ref('online.millis')
const rows = computed(() => {
  const values = new Map<string, bigint>()
  for (const point of props.points.filter((p) => p.metric === mode.value))
    values.set(point.day, (values.get(point.day) ?? 0n) + BigInt(point.value))
  return [...values]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, value]) => ({ day, raw: value.toString(), value: Number(value) }))
})
const unit = computed(() => (mode.value === 'online.millis' ? 'ms' : 'blocks'))
const chartOption = computed<EChartsOption>(() => {
  const byDay = new Map(rows.value.map((row) => [row.day, row]))
  const days: string[] = []
  if (rows.value.length) {
    const end = Date.parse(rows.value.at(-1)!.day)
    for (let at = Date.parse(rows.value[0]!.day); at <= end; at += 86400000)
      days.push(new Date(at).toISOString().slice(0, 10))
  }
  return {
    grid: { left: 16, right: 24, top: 25, bottom: 48, containLabel: true },
    tooltip: {
      trigger: 'axis',
      renderMode: 'richText',
      valueFormatter: (value) =>
        value == null
          ? t('m1463')
          : mode.value === 'online.millis'
            ? t('m1464', [Number(value).toFixed(2)])
            : t('m1465', [Number(value).toLocaleString(formatLocale)]),
    },
    xAxis: {
      type: 'category',
      data: days,
      boundaryGap: false,
      axisLabel: { formatter: (value: string) => value.slice(5), hideOverlap: true },
      axisLine: { lineStyle: { color: '#e1e9e5' } },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      name: mode.value === 'online.millis' ? t('m1131') : t('m1466'),
      axisLabel: { formatter: compactChartNumber, hideOverlap: true },
      splitNumber: 4,
      minInterval: mode.value === 'online.millis' ? undefined : 1,
      splitLine: { lineStyle: { color: '#eef2f0', type: 'dashed' } },
    },
    dataZoom: [
      { type: 'inside' },
      {
        type: 'slider',
        height: 16,
        bottom: 4,
        borderColor: 'transparent',
        fillerColor: '#229b7818',
        showDetail: false,
      },
    ],
    series: [
      {
        type: 'line',
        name: mode.value === 'online.millis' ? t('m1467') : t('m1468'),
        data: days.map((day) => {
          const row = byDay.get(day)
          return row ? row.value / (mode.value === 'online.millis' ? 3600000 : 1) : null
        }),
        connectNulls: false,
        symbolSize: 7,
        lineStyle: { width: 3 },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: '#229b7838' },
              { offset: 1, color: '#229b7803' },
            ],
          },
        },
      },
    ],
  }
})
</script>
<template>
  <article class="panel trend-panel">
    <div class="panel-heading">
      <div>
        <h2>{{ t('m1469') }}</h2>
        <p>{{ t('m1470') }}</p>
      </div>
      <div class="segmented">
        <button :aria-pressed="mode === 'online.millis'" @click="mode = 'online.millis'">{{ t('m1467') }}</button
        ><button :aria-pressed="mode === 'blocks.mined'" @click="mode = 'blocks.mined'">{{ t('m1468') }}</button>
      </div>
    </div>
    <div v-if="!rows.length" class="chart-empty">
      <div class="chart-grid" aria-hidden="true"></div>
      <span class="empty-icon"><Activity :size="30" /></span>
      <h3>{{ t('m1471') }}</h3>
      <p>{{ t('m1472') }}</p>
    </div>
    <div v-else class="trend-body">
      <DataChart
        :option="chartOption"
        :label="mode === 'online.millis' ? t('m1473') : t('m1474')"
      />
      <p class="chart-caption">{{ t('m1475') }}</p>
      <details class="trend-details">
        <summary>{{ t('m1476') }}</summary>
        <div class="table-scroll" tabindex="0" :aria-label="t('m1477')">
          <table>
            <thead>
              <tr>
                <th>{{ t('m0798') }}</th>
                <th>{{ mode === 'online.millis' ? t('m1467') : t('m1468') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in rows" :key="row.day">
                <td>{{ row.day }}</td>
                <td>{{ formatValue(row.raw, unit) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </details>
    </div>
  </article>
</template>
