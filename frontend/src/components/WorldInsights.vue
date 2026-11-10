<script setup lang="ts">
import { t, formatLocale, locale } from '../i18n'

import { computed } from 'vue'
import type { EChartsOption } from 'echarts'
import type { DailyPoint, DimensionPoint, Summary, MetricResult } from '../statistics'
import { dimensions, formatValue, metricLabel } from '../statistics'
import DataChart from './DataChart.vue'
import { compactChartNumber } from '../chartNumbers'
const props = defineProps<{
  points: DailyPoint[]
  dimensionPoints: DimensionPoint[]
  summary: Summary
}>()
const worlds = computed(() => {
  const totals = new Map<string, bigint>()
  for (const row of props.dimensionPoints)
    totals.set(row.dimension, (totals.get(row.dimension) ?? 0n) + BigInt(row.value))
  return [...totals].map(([key, value]) => ({
    name: dimensions[key] ?? key,
    raw: String(value),
    value: Number(value) / 3600000,
  }))
})
const worldOption = computed<EChartsOption>(() => ({
  tooltip: { trigger: 'item', renderMode: 'richText', formatter: t('m1494') },
  series: [
    {
      type: 'pie',
      radius: ['55%', '78%'],
      center: ['50%', '50%'],
      avoidLabelOverlap: true,
      label: { show: false },
      itemStyle: { borderRadius: 7, borderWidth: 4, borderColor: '#fff' },
      data: worlds.value,
    },
  ],
}))
const worldHours = computed(() => worlds.value.reduce((n, row) => n + row.value, 0))
const gathering = computed(() =>
  ['blocks.mined', 'blocks.placed', 'crops.harvested', 'crops.planted']
    .map((key) => props.summary.metrics.find((m) => m.key === key))
    .filter((m): m is MetricResult => m != null && m.value != null),
)
const travel = computed(() =>
  props.summary.metrics.filter(
    (m) => m.key.startsWith('travel.') && m.unit === 'mm' && m.value != null,
  ),
)
function bars(rows: { label: string; value: string | null }[], divisor = 1): EChartsOption {
  return {
    grid: { left: 8, right: 18, top: 12, bottom: 16, containLabel: true },
    tooltip: {
      trigger: 'axis',
      renderMode: 'richText',
      axisPointer: { type: 'shadow' },
      valueFormatter: (value) =>
        divisor === 1000
          ? t('m1495', [Number(value).toLocaleString(formatLocale)])
          : t('m1465', [Number(value).toLocaleString(formatLocale)]),
    },
    xAxis: { type: 'value', splitNumber: 2, minInterval: 1, axisLabel: { formatter: compactChartNumber, hideOverlap: true, margin: 12 }, splitLine: { lineStyle: { color: '#edf2ef', type: 'dashed' } } },
    yAxis: {
      type: 'category',
      inverse: true,
      data: rows.map((r) => ('key' in r ? metricLabel(r as MetricResult) : r.label)),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { width: 95, overflow: 'truncate' },
    },
    series: [
      {
        type: 'bar',
        barMaxWidth: 18,
        showBackground: true,
        backgroundStyle: { color: '#f4f7f6', borderRadius: 5 },
        itemStyle: { borderRadius: [0, 5, 5, 0] },
        data: rows.map((r, i) => ({
          value: Number(r.value) / divisor,
          itemStyle: { color: ['#229b78', '#738fdb', '#af86d8', '#e8ae52', '#62bfc8'][i % 5] },
        })),
      },
    ],
  }
}
const gatheringOption = computed(() => bars(gathering.value))
const travelOption = computed(() => bars(travel.value, 1000))
const days = computed(() => {
  const totals = new Map<string, bigint>()
  for (const row of props.points.filter((p) => p.metric === 'online.millis'))
    totals.set(row.day, (totals.get(row.day) ?? 0n) + BigInt(row.value))
  return [...totals]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, value]) => ({ day, raw: String(value), value: Number(value) / 3600000 }))
})
const calendarEnd = computed(() => days.value.at(-1)?.day)
const calendarStart = computed(() =>
  calendarEnd.value
    ? new Date(Date.parse(calendarEnd.value) - 89 * 86400000).toISOString().slice(0, 10)
    : '',
)
const calendarDays = computed(() => days.value.filter((row) => row.day >= calendarStart.value))
const calendarOption = computed<EChartsOption>(() => ({
  tooltip: {
    renderMode: 'richText',
    formatter: (param) => {
      const row = (Array.isArray(param) ? param[0] : param)?.value as [string, number]
      return row ? t('m1496', [row[0], row[1].toFixed(2)]) : ''
    },
  },
  visualMap: {
    show: false,
    min: 0,
    max: Math.max(...calendarDays.value.map((r) => r.value), 1),
    inRange: { color: ['#def2e7', '#97d7b5', '#43ad85', '#157457'] },
  },
  calendar: {
    top: 30,
    left: 34,
    right: 16,
    bottom: 12,
    range: [calendarStart.value, calendarEnd.value!],
    cellSize: ['auto', 18],
    splitLine: { show: false },
    itemStyle: { color: '#f1f4f2', borderWidth: 3, borderColor: '#fff' },
    yearLabel: { show: false },
    monthLabel: { nameMap: locale === 'en' ? 'EN' : 'ZH' },
    dayLabel: {
      firstDay: 1,
      nameMap: [t('m1497'), t('m1498'), t('m1499'), t('m1500'), t('m1501'), t('m1502'), t('m1503')],
      color: '#81928a',
    },
  },
  series: [
    {
      type: 'heatmap',
      coordinateSystem: 'calendar',
      data: calendarDays.value.map((r) => [r.day, r.value]),
    },
  ],
}))
</script>
<template>
  <section class="insights-grid" :aria-label="t('m1504')">
    <article class="panel insight-card">
      <div class="insight-heading">
        <span class="insight-kicker">{{ t('m1505') }}</span>
        <h2>{{ t('m1506') }}</h2>
        <p>{{ t('m1507') }}</p>
      </div>
      <div v-if="worldHours > 0" class="donut-wrap">
        <DataChart :option="worldOption" :label="t('m1508')" :height="218" />
        <div class="donut-center">
          <strong>{{ worlds.length }}</strong
          ><span>{{ t('m1509') }}</span>
        </div>
      </div>
      <div v-else class="insight-empty">{{ t('m1510') }}</div>
      <ul class="chart-values">
        <li v-for="(row, index) in worlds" :key="row.name">
          <span
            ><i
              :style="{
                background: ['#229b78', '#6b88de', '#ad83d8', '#e8ae52', '#62bfc8'][index % 5],
              }"
            ></i
            >{{ row.name }}</span
          ><strong>{{ formatValue(row.raw, 'ms') }}</strong>
        </li>
      </ul>
    </article>
    <article class="panel insight-card">
      <div class="insight-heading">
        <span class="insight-kicker purple">{{ t('m1511') }}</span>
        <h2>{{ t('m1512') }}</h2>
        <p>{{ t('m1513') }}</p>
      </div>
      <template v-if="calendarEnd"
        ><DataChart :option="calendarOption" :label="t('m1514')" :height="205" />
        <p class="insight-footnote">{{ t('m1515', [calendarStart, calendarEnd]) }}</p>
        <details class="plain-details">
          <summary>{{ t('m1516') }}</summary>
          <ul class="chart-values">
            <li v-for="row in calendarDays" :key="row.day">
              <span>{{ row.day }}</span
              ><strong>{{ formatValue(row.raw, 'ms') }}</strong>
            </li>
          </ul>
        </details></template
      >
      <div v-else class="insight-empty">{{ t('m1517') }}</div>
    </article>
    <article class="panel insight-card">
      <div class="insight-heading">
        <span class="insight-kicker amber">{{ t('m1518') }}</span>
        <h2>{{ t('m1519') }}</h2>
        <p>{{ t('m1520') }}</p>
      </div>
      <template v-if="gathering.length"
        ><DataChart :option="gatheringOption" :label="t('m1521')" :height="230" />
        <details class="plain-details">
          <summary>{{ t('m1522') }}</summary>
          <ul class="chart-values">
            <li v-for="row in gathering" :key="row.key">
              <span>{{ metricLabel(row) }}</span
              ><strong>{{ formatValue(row.value, row.unit) }}</strong>
            </li>
          </ul>
        </details></template
      >
      <div v-else class="insight-empty">{{ t('m1523') }}</div>
    </article>
    <article class="panel insight-card">
      <div class="insight-heading">
        <span class="insight-kicker blue">{{ t('m1524') }}</span>
        <h2>{{ t('m1525') }}</h2>
        <p>{{ t('m1526') }}</p>
      </div>
      <template v-if="travel.length"
        ><DataChart :option="travelOption" :label="t('m1527')" :height="230" />
        <details class="plain-details">
          <summary>{{ t('m1528') }}</summary>
          <ul class="chart-values">
            <li v-for="row in travel" :key="row.key">
              <span>{{ metricLabel(row) }}</span
              ><strong>{{ formatValue(row.value, 'mm') }}</strong>
            </li>
          </ul>
        </details></template
      >
      <div v-else class="insight-empty">{{ t('m1529') }}</div>
    </article>
  </section>
</template>
