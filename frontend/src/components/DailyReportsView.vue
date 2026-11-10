<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { api, type ServerArchive } from '../api'
import { gameName } from '../gameNames'
import DataChart from './DataChart.vue'
import { compactChartNumber } from '../chartNumbers'
import type { EChartsOption } from 'echarts'
const props = defineProps<{ scope: string; servers: ServerArchive[] }>()
const emit = defineEmits<{ select: [id: string] }>()
interface Report {
  serverName: string
  date: string
  timezone: string
  recordedPlayers: number
  totals: { metric: string; value: string; quality: string; algorithm: string }[]
  materials: { block: string; metric: string; value: string }[]
  trend: { date: string; metric: string; value: string }[]
  projects: { id: string; name: string; revision: number; startedAt: string; endedAt: string }[]
  notice: string
}
const report = ref<Report>(),
  date = ref(''),
  error = ref('')
let sequence = 0
async function load() {
  const seq = ++sequence
  report.value = undefined
  if (props.scope === 'all') return
  try {
    const result = await api<Report>(
      `/servers/${props.scope}/daily-report${date.value ? '?date=' + date.value : ''}`,
    )
    if (seq === sequence) {
      report.value = result
      error.value = ''
    }
  } catch (e) {
    if (seq === sequence) error.value = e instanceof Error ? e.message : '日报读取失败'
  }
}
watch(() => [props.scope, date.value], load, { immediate: true })
const labels: Record<string, string> = {
  'online.millis': '累计在线',
  'activity.millis': '估算活跃',
  'blocks.placed': '放置方块',
  'blocks.mined': '挖掘方块',
  'items.used': '使用物品',
  'chat.messages': '聊天发言',
  deaths: '死亡次数',
}
const totals = computed(() => {
  const values = new Map<string, bigint>()
  for (const t of report.value?.totals ?? [])
    values.set(t.metric, (values.get(t.metric) ?? 0n) + BigInt(t.value))
  return [...values].map(([metric, value]) => ({
    metric,
    name: labels[metric] ?? metric,
    value: metric.endsWith('.millis')
      ? `${value / 3600000n} 小时 ${(value % 3600000n) / 60000n} 分`
      : value.toString(),
  }))
})
const trend = computed<EChartsOption>(() => {
  const days = [...new Set(report.value?.trend.map((r) => r.date))].sort()
  return {
    tooltip: { trigger: 'axis', renderMode: 'richText' },
    legend: { top: 0, left: 'center', type: 'scroll', itemGap: 18 },
    grid: { left: 12, right: 16, top: 56, bottom: 20, containLabel: true },
    xAxis: {
      type: 'category',
      data: days,
      axisLabel: { formatter: (value: string) => value.slice(5), hideOverlap: true, margin: 12 },
    },
    yAxis: { type: 'value', name: '次数', axisLabel: { formatter: compactChartNumber } },
    series: ['blocks.placed', 'blocks.mined'].map((metric) => ({
      type: 'line' as const,
      name: labels[metric],
      connectNulls: false,
      smooth: true,
      data: days.map((day) => {
        const row = report.value?.trend.find((r) => r.date === day && r.metric === metric)
        return row ? Number(row.value) : null
      }),
    })),
  }
})
const blocks = computed<EChartsOption>(() => ({
  tooltip: { trigger: 'axis', renderMode: 'richText' },
  grid: { left: 130, right: 30, bottom: 30 },
  xAxis: {
    type: 'value',
    splitNumber: 3,
    minInterval: 1,
    axisLabel: { formatter: compactChartNumber, hideOverlap: true },
  },
  yAxis: {
    type: 'category',
    inverse: true,
    data: report.value?.materials
      .slice(0, 12)
      .map(
        (r) =>
          (gameName(r.block, 'block') ?? r.block) +
          ' · ' +
          (r.metric === 'blocks.placed' ? '放置' : '挖掘'),
      ),
    axisLabel: { width: 120, overflow: 'truncate' },
  },
  series: [
    {
      type: 'bar',
      data: report.value?.materials.slice(0, 12).map((r) => Number(r.value)),
      itemStyle: { borderRadius: [0, 6, 6, 0] },
    },
  ],
}))
</script>
<template>
  <section>
    <div class="project-banner">
      <div>
        <h2>方块世界的一天</h2>
        <p>看看伙伴的足迹、今天的建设和最近一周的变化。</p>
      </div>
      <label
        >选择日期<input v-model="date" type="date" aria-label="日报日期" /><small
          >留空查看昨天</small
        ></label
      >
    </div>
    <label v-if="scope === 'all'"
      >选择服务器<select @change="emit('select', ($event.target as HTMLSelectElement).value)">
        <option value="">请选择</option>
        <option v-for="s in servers" :key="s.id" :value="s.id">{{ s.name }}</option>
      </select></label
    >
    <p v-if="error" class="project-error" role="alert">{{ error }}</p>
    <template v-if="report"
      ><h2>{{ report.serverName }} · {{ report.date }}</h2>
      <p class="project-muted">
        统计时区：{{
          ['Asia/Hong_Kong', 'Asia/Shanghai'].includes(report.timezone) ? 'UTC+8' : report.timezone
        }}
        · {{ report.notice }}
      </p>
      <div class="report-totals">
        <article>
          <span>留下记录的玩家</span><strong>{{ report.recordedPlayers }}</strong>
        </article>
        <article v-for="t in totals" :key="t.metric">
          <span>{{ t.name }}</span
          ><strong>{{ t.value }}</strong>
        </article>
      </div>
      <div class="report-charts">
        <section class="project-panel">
          <h3>最近七天的建设</h3>
          <DataChart :option="trend" label="七天放置与挖掘趋势" />
        </section>
        <section class="project-panel">
          <h3>当天热门方块</h3>
          <DataChart :option="blocks" label="当天方块行为排行" :height="350" />
        </section>
      </div>
      <section class="project-panel">
        <h3>工程进展</h3>
        <p v-if="!report.projects.length" class="project-muted">当天没有工程阶段变化记录。</p>
        <p v-for="p in report.projects" :key="p.id + p.revision">
          <a :href="'/projects/' + p.id" target="_blank" rel="noopener">{{ p.name }}</a> · 第
          {{ p.revision }} 阶段 · {{ p.endedAt ? '已封存' : '已开始' }}
        </p>
      </section>
      <details class="project-panel">
        <summary>查看统计数值与采集质量</summary>
        <p v-for="t in report.totals" :key="t.metric + t.quality + t.algorithm">
          {{ labels[t.metric] ?? t.metric }}：{{ t.value }}（{{
            t.quality === 'EXACT' ? '精确计数' : t.quality === 'ESTIMATED' ? '估算' : '观察记录'
          }}；{{ t.algorithm }}）
        </p>
        <p v-for="m in report.materials" :key="m.block + m.metric">
          {{ gameName(m.block, 'block') ?? m.block }} · {{ labels[m.metric] }}：{{ m.value }}
        </p>
      </details>
    </template>
  </section>
</template>
<style scoped>
.report-totals {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 14px;
  margin: 20px 0;
}
.report-totals article {
  padding: 22px;
  border: 1px solid #cfe7d9;
  border-radius: 16px;
  background: linear-gradient(135deg, #def6e5, #eff8ff);
}
.report-totals article:nth-child(3n) {
  background: #f0e7fd;
  border-color: #e1d3f7;
}
.report-totals article:nth-child(3n + 2) {
  background: #fff0d8;
  border-color: #f0dfc0;
}
.report-totals strong {
  display: block;
  font-size: 24px;
  margin-top: 12px;
}
.report-charts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20px;
}
.project-banner input,
.project-banner small {
  display: block;
  margin-top: 6px;
}
@media (max-width: 850px) {
  .report-charts {
    grid-template-columns: 1fr;
  }
}
</style>
