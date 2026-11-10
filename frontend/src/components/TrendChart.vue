<script setup lang="ts">
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
          ? '暂无记录'
          : mode.value === 'online.millis'
            ? `${Number(value).toFixed(2)} 小时`
            : `${Number(value).toLocaleString('zh-CN')} 方块`,
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
      name: mode.value === 'online.millis' ? '小时' : '方块',
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
        name: mode.value === 'online.millis' ? '在线时长' : '挖掘数量',
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
        <h2>玩家活跃趋势</h2>
        <p>看看大家最近有多活跃</p>
      </div>
      <div class="segmented">
        <button :aria-pressed="mode === 'online.millis'" @click="mode = 'online.millis'">
          在线时长</button
        ><button :aria-pressed="mode === 'blocks.mined'" @click="mode = 'blocks.mined'">
          挖掘数量
        </button>
      </div>
    </div>
    <div v-if="!rows.length" class="chart-empty">
      <div class="chart-grid" aria-hidden="true"></div>
      <span class="empty-icon"><Activity :size="30" /></span>
      <h3>还没有每日记录</h3>
      <p>连接游戏插件后，就能看到每天的变化。</p>
    </div>
    <div v-else class="trend-body">
      <DataChart
        :option="chartOption"
        :label="mode === 'online.millis' ? '每日在线时长趋势' : '每日挖掘数量趋势'"
      />
      <p class="chart-caption">
        拖动底部滑块可放大日期。空白表示没有记录，不代表零；最多显示 366 天。
      </p>
      <details class="trend-details">
        <summary>查看每日数值</summary>
        <div class="table-scroll" tabindex="0" aria-label="每日趋势数值">
          <table>
            <thead>
              <tr>
                <th>日期</th>
                <th>{{ mode === 'online.millis' ? '在线时长' : '挖掘数量' }}</th>
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
