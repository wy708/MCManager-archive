<script setup lang="ts">
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
  tooltip: { trigger: 'item', renderMode: 'richText', formatter: '{b}\n{d}% 的已记录在线时间' },
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
          ? `${Number(value).toLocaleString('zh-CN')} 米`
          : `${Number(value).toLocaleString('zh-CN')} 方块`,
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
      return row ? `${row[0]}\n在线 ${row[1].toFixed(2)} 小时` : ''
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
    monthLabel: { nameMap: 'ZH' },
    dayLabel: {
      firstDay: 1,
      nameMap: ['日', '一', '二', '三', '四', '五', '六'],
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
  <section class="insights-grid" aria-label="世界与冒险统计">
    <article class="panel insight-card">
      <div class="insight-heading">
        <span class="insight-kicker">世界足迹</span>
        <h2>大家都在哪里？</h2>
        <p>按已记录的在线时间统计，包含挂机</p>
      </div>
      <div v-if="worldHours > 0" class="donut-wrap">
        <DataChart :option="worldOption" label="各世界在线时长占比" :height="218" />
        <div class="donut-center">
          <strong>{{ worlds.length }}</strong
          ><span>个世界有记录</span>
        </div>
      </div>
      <div v-else class="insight-empty">暂时没有可展示的在线时长</div>
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
        <span class="insight-kicker purple">冒险日历</span>
        <h2>一起玩过的日子</h2>
        <p>颜色越深，大家累计在线的时间越长</p>
      </div>
      <template v-if="calendarEnd"
        ><DataChart :option="calendarOption" label="最近记录日前 90 天在线时间日历" :height="205" />
        <p class="insight-footnote">{{ calendarStart }} — {{ calendarEnd }} · 灰色表示没有记录</p>
        <details class="plain-details">
          <summary>查看每天的时间</summary>
          <ul class="chart-values">
            <li v-for="row in calendarDays" :key="row.day">
              <span>{{ row.day }}</span
              ><strong>{{ formatValue(row.raw, 'ms') }}</strong>
            </li>
          </ul>
        </details></template
      >
      <div v-else class="insight-empty">有了每日记录，这里就会点亮</div>
    </article>
    <article class="panel insight-card">
      <div class="insight-heading">
        <span class="insight-kicker amber">方块故事</span>
        <h2>建造与采集</h2>
        <p>看看大家挖了多少，又为世界添了多少</p>
      </div>
      <template v-if="gathering.length"
        ><DataChart :option="gatheringOption" label="挖掘、放置和作物方块数量" :height="230" />
        <details class="plain-details">
          <summary>查看具体数量</summary>
          <ul class="chart-values">
            <li v-for="row in gathering" :key="row.key">
              <span>{{ metricLabel(row) }}</span
              ><strong>{{ formatValue(row.value, row.unit) }}</strong>
            </li>
          </ul>
        </details></template
      >
      <div v-else class="insight-empty">游戏插件尚未传回建造与采集记录</div>
    </article>
    <article class="panel insight-card">
      <div class="insight-heading">
        <span class="insight-kicker blue">探索旅途</span>
        <h2>走过的每一段路</h2>
        <p>按移动方式估算距离，不包含传送</p>
      </div>
      <template v-if="travel.length"
        ><DataChart :option="travelOption" label="不同移动方式的距离，单位米" :height="230" />
        <details class="plain-details">
          <summary>查看距离与单位</summary>
          <ul class="chart-values">
            <li v-for="row in travel" :key="row.key">
              <span>{{ metricLabel(row) }}</span
              ><strong>{{ formatValue(row.value, 'mm') }}</strong>
            </li>
          </ul>
        </details></template
      >
      <div v-else class="insight-empty">游戏插件尚未传回移动距离</div>
    </article>
  </section>
</template>
