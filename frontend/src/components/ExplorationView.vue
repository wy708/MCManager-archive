<script setup lang="ts">
import { weekdays, formatLocale, systemMessage, t } from '../i18n'

import { ref, computed, watch, onBeforeUnmount, defineAsyncComponent } from 'vue'
import type { EChartsOption } from 'echarts'
import { api, type ServerArchive } from '../api'
import type { Exploration } from '../exploration'
import { blockIcon } from '../projects'
import { gameName } from '../gameNames'
import { compactChartNumber } from '../chartNumbers'
import DataChart from './DataChart.vue'
const MoreCharts = defineAsyncComponent(() => import('./ExplorationMoreCharts.vue'))
const extraTabs = [
  ['river', t('m0743')],
  ['clock', t('m0744')],
  ['bubble', t('m0745')],
  ['sunburst', t('m0746')],
  ['box', t('m0747')],
  ['timeline', t('m0748')],
  ['radar', t('m0749')],
] as const
const HeatMap = defineAsyncComponent(() => import('./ConstructionHeatMap.vue'))
const props = defineProps<{ scope: string; servers: ServerArchive[] }>()
const tabs = [
  ['hours', t('m0767')],
  ['network', t('m0768')],
  ['flow', t('m0769')],
  ['map', t('m0770')],
  ['materials', t('m0771')],
  ['race', t('m0772')],
  ['height', t('m0773')],
  ...extraTabs,
] as const
type Tab = (typeof tabs)[number][0]
const chartGroups = [
  {
    name: t('m0774'),
    keys: ['hours', 'river', 'clock', 'bubble', 'radar'],
    help: t('m0775'),
  },
  {
    name: t('m0776'),
    keys: ['network', 'flow', 'materials', 'sunburst', 'race', 'timeline'],
    help: t('m0777'),
  },
  {
    name: t('m0778'),
    keys: ['map', 'height', 'box'],
    help: t('m0779'),
  },
]
const chartGroup = ref(0)
const visibleTabs = computed(() =>
  tabs.filter(([key]) => chartGroups[chartGroup.value]!.keys.includes(key)),
)
function chooseGroup(index: number) {
  chartGroup.value = index
  tab.value = visibleTabs.value[0]![0]
  playing.value = false
}

const tab = ref<Tab>('hours'),
  selected = ref(''),
  from = ref(''),
  to = ref(''),
  data = ref<Exploration>(),
  error = ref(''),
  busy = ref(false),
  dimension = ref('minecraft:overworld'),
  day = ref(''),
  project = ref(''),
  metric = ref('blocks.placed'),
  frame = ref(0),
  playing = ref(false)
let controller: AbortController | undefined, timer: ReturnType<typeof setInterval> | undefined
const server = computed(() => (props.scope === 'all' ? selected.value : props.scope))
watch(
  () => props.servers,
  () => {
    if (!props.servers.some((s) => s.id === selected.value))
      selected.value = props.servers[0]?.id ?? ''
  },
  { immediate: true },
)
async function load() {
  controller?.abort()
  const request = new AbortController()
  controller = request
  data.value = undefined
  error.value = ''
  playing.value = false
  project.value = ''
  day.value = ''
  if (!server.value) return
  busy.value = true
  try {
    const params = new URLSearchParams({ serverId: server.value })
    if (from.value) params.set('from', from.value)
    if (to.value) params.set('to', to.value)
    const result = await api<Exploration>('/statistics/exploration?' + params, {
      signal: request.signal,
    })
    if (request.signal.aborted) return
    data.value = result
    frame.value = days.value.length - 1
  } catch (e) {
    if (!request.signal.aborted) error.value = e instanceof Error ? e.message : t('m0780')
  } finally {
    if (controller === request) busy.value = false
  }
}
watch(server, load, { immediate: true })
watch(tab, () => {
  playing.value = false
})
watch(playing, (value) => {
  if (!value) clearInterval(timer)
})
const isExtra = computed(() => extraTabs.some(([id]) => id === tab.value))
onBeforeUnmount(() => {
  controller?.abort()
  clearInterval(timer)
})
const projects = computed(() => [
  ...new Map(
    data.value?.contributions.map((c) => [c.project, { id: c.project, name: c.project_name }]) ??
      [],
  ).values(),
])
const contributions = computed(() =>
  (data.value?.contributions ?? []).filter(
    (c) =>
      (!project.value || c.project === project.value) &&
      c.operation === (metric.value === 'blocks.placed' ? 'PLACE' : 'BREAK'),
  ),
)
const days = computed(() => {
  if (!data.value) return []
  const out: string[] = []
  for (
    let d = Date.parse(data.value.from + 'T00:00:00Z');
    d <= Date.parse(data.value.to + 'T00:00:00Z');
    d += 86400000
  )
    out.push(new Date(d).toISOString().slice(0, 10))
  return out
})
const hotRows = computed(() =>
  (data.value?.hotspots ?? []).filter(
    (r) =>
      r.dimension === dimension.value &&
      r.metric === metric.value &&
      (!day.value || r.day === day.value),
  ),
)
const names = computed(
  () =>
    new Map(
      data.value?.contributions.flatMap(
        (c) =>
          [
            ['p:' + c.player, c.player_name],
            ['j:' + c.project, c.project_name],
            ['b:' + c.block, gameName(c.block, 'block') ?? c.block],
          ] as [string, string][],
      ) ?? [],
    ),
)
const tip = { trigger: 'item' as const, renderMode: 'richText' as const, confine: true }
const empty = computed(
  () =>
    !data.value ||
    (tab.value === 'hours' && !data.value.hours.length) ||
    (['network', 'flow', 'materials'].includes(tab.value) && !contributions.value.length) ||
    (tab.value === 'race' && !data.value.ranking.length) ||
    (tab.value === 'height' &&
      !data.value.heights.some(
        (r) => r.dimension === dimension.value && r.metric === metric.value,
      )),
)
const hourOption = computed<EChartsOption>(() => ({
  tooltip: {
    ...tip,
    formatter: (p: any) =>
      t('m0781', [weekdays[p.value[1]], p.value[0], p.value[2].toFixed(2)]),
  },
  grid: { left: 35, right: 20, top: 25, bottom: 75 },
  xAxis: { type: 'category', data: Array.from({ length: 24 }, (_, i) => String(i)), name: t('m0782') },
  yAxis: { type: 'category', data: weekdays, name: t('m0783') },
  visualMap: {
    min: 0,
    max: Math.max(1, ...(data.value?.hours ?? []).map((r) => r.millis / 3600000)),
    orient: 'horizontal',
    left: 'center',
    bottom: 5,
    inRange: { color: ['#ecf7ed', '#79cfa6', '#12694b'] },
  },
  series: [
    {
      type: 'heatmap',
      data: data.value?.hours.map((r) => [
        r.hour,
        r.weekday,
        Number((r.millis / 3600000).toFixed(3)),
      ]),
      itemStyle: { borderColor: '#fff', borderWidth: 2 },
    },
  ],
}))
function links() {
  const totals = new Map<string, number>()
  for (const c of contributions.value) {
    const k = 'p:' + c.player + '|j:' + c.project
    totals.set(k, (totals.get(k) ?? 0) + Number(c.value))
  }
  return [...totals]
    .map(([k, value]) => ({ source: k.split('|')[0]!, target: k.split('|')[1]!, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 80)
}
const networkOption = computed<EChartsOption>(() => {
  const edges = links(),
    ids = [...new Set(edges.flatMap((e) => [e.source, e.target]))]
  return {
    tooltip: {
      ...tip,
      formatter: (p: any) =>
        p.dataType === 'edge'
          ? t('m0784', [names.value.get(p.data.source), names.value.get(p.data.target), p.data.value.toLocaleString(formatLocale)])
          : p.name,
    },
    series: [
      {
        type: 'graph',
        layout: 'circular',
        roam: true,
        draggable: true,
        label: { show: true, position: 'right', width: 90, overflow: 'truncate' },
        lineStyle: { opacity: 0.45, curveness: 0.15 },
        data: ids.map((id) => ({
          id,
          name: names.value.get(id) ?? id,
          symbolSize: id.startsWith('j:') ? 40 : 25,
          itemStyle: { color: id.startsWith('j:') ? '#1d9873' : '#8973d8' },
        })),
        links: edges.map((e) => ({ ...e, lineStyle: { width: 1 + Math.log1p(e.value) } })),
      },
    ],
  }
})
const flowOption = computed<EChartsOption>(() => {
  const edges = links().slice(0, 25),
    allowed = new Set(edges.map((e) => e.source + '|' + e.target)),
    materials = new Map<string, number>()
  for (const c of contributions.value)
    if (allowed.has('p:' + c.player + '|j:' + c.project)) {
      const k = 'j:' + c.project + '|b:' + c.block
      materials.set(k, (materials.get(k) ?? 0) + Number(c.value))
    }
  const materialTotals = new Map<string, number>()
  for (const [k, v] of materials) {
    const block = k.split('|')[1]!
    materialTotals.set(block, (materialTotals.get(block) ?? 0) + v)
  }
  const ranked = [...materialTotals]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([k]) => k),
    merged = new Map<string, number>()
  for (const [k, v] of materials) {
    const [a, b] = k.split('|')
    const key = a + '|' + (ranked.includes(b!) ? b : 'b:other')
    merged.set(key, (merged.get(key) ?? 0) + v)
  }
  const all = [
      ...edges,
      ...[...merged].map(([k, value]) => ({
        source: k.split('|')[0]!,
        target: k.split('|')[1]!,
        value,
      })),
    ],
    ids = [...new Set(all.flatMap((e) => [e.source, e.target]))]
  return {
    tooltip: {
      ...tip,
      formatter: (p: any) =>
        p.dataType === 'edge'
          ? t('m0784', [names.value.get(p.data.source) ?? t('m0785'), names.value.get(p.data.target) ?? t('m0785'), p.data.value.toLocaleString(formatLocale)])
          : (names.value.get(p.name) ?? t('m0785')),
    },
    series: [
      {
        type: 'sankey',
        left: 10,
        right: 90,
        top: 20,
        bottom: 20,
        nodeWidth: 14,
        nodeGap: 12,
        emphasis: { focus: 'adjacency' },
        label: {
          formatter: (p: any) => names.value.get(p.name) ?? t('m0785'),
          width: 80,
          overflow: 'truncate',
        },
        lineStyle: { color: 'gradient', opacity: 0.3 },
        data: ids.map((name) => ({ name })),
        links: all,
      },
    ],
  }
})
const materialsOption = computed<EChartsOption>(() => {
  const map = new Map<string, number>()
  for (const c of contributions.value) map.set(c.block, (map.get(c.block) ?? 0) + Number(c.value))
  const rows = [...map].sort((a, b) => b[1] - a[1]),
    first = rows
      .slice(0, 80)
      .map(([block, value]) => ({ name: gameName(block, 'block') ?? block, value }))
  if (rows.length > 80)
    first.push({ name: t('m0785'), value: rows.slice(80).reduce((n, r) => n + r[1], 0) })
  return {
    tooltip: { ...tip, valueFormatter: (v: any) => Number(v).toLocaleString(formatLocale) + t('m0764') },
    series: [
      {
        type: 'treemap',
        roam: false,
        breadcrumb: { show: false },
        nodeClick: false,
        label: { show: true, formatter: '{b}\n{c}' },
        itemStyle: { borderColor: '#fff', borderWidth: 3, gapWidth: 3 },
        data: first,
      },
    ],
  }
})
const materialRows = computed(() => {
  const sums = new Map<string, number>()
  for (const c of contributions.value) sums.set(c.block, (sums.get(c.block) ?? 0) + Number(c.value))
  return [...sums].sort((a, b) => b[1] - a[1]).slice(0, 20)
})
const heightOption = computed<EChartsOption>(() => {
  const rows = (data.value?.heights ?? []).filter(
      (r) => r.dimension === dimension.value && r.metric === metric.value,
    ),
    levels = [...new Set(rows.map((r) => Number(r.y)))].sort((a, b) => a - b)
  return {
    tooltip: {
      ...tip,
      formatter: (p: any) =>
        t('m0786', [days.value[p.value[0]], levels[p.value[1]], levels[p.value[1]]! + 7, p.value[2].toLocaleString(formatLocale)]),
    },
    grid: { left: 60, right: 20, top: 20, bottom: 80 },
    xAxis: {
      type: 'category',
      data: days.value.map((d) => d.slice(5)),
      axisLabel: { hideOverlap: true },
    },
    yAxis: { type: 'category', data: levels.map(String), name: t('m0787') },
    visualMap: {
      min: 0,
      max: Math.max(1, ...rows.map((r) => Number(r.value))),
      orient: 'horizontal',
      left: 'center',
      bottom: 5,
      inRange: { color: ['#e9f1fc', '#8b89df', '#6538aa'] },
    },
    series: [
      {
        type: 'heatmap',
        data: rows.map((r) => [
          days.value.indexOf(r.day),
          levels.indexOf(Number(r.y)),
          Number(r.value),
        ]),
      },
    ],
  }
})
const rankRows = computed(() => {
  const totals = new Map<string, { name: string; value: number }>()
  for (const r of data.value?.ranking ?? [])
    if (r.day <= (days.value[frame.value] ?? '')) {
      const p = totals.get(r.player) ?? { name: r.player_name, value: 0 }
      p.value += Number(r.value)
      totals.set(r.player, p)
    }
  return [...totals.values()]
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name))
    .slice(0, 10)
})
const raceOption = computed<EChartsOption>(() => ({
  tooltip: { ...tip, trigger: 'axis' },
  grid: { left: 105, right: 55, top: 20, bottom: 30 },
  xAxis: { type: 'value', axisLabel: { formatter: compactChartNumber } },
  yAxis: {
    type: 'category',
    inverse: true,
    data: rankRows.value.map((r) => r.name),
    axisLabel: { width: 95, overflow: 'truncate' },
  },
  series: [
    {
      type: 'bar',
      data: rankRows.value.map((r) => r.value),
      label: { show: true, position: 'right' },
      itemStyle: { borderRadius: [0, 6, 6, 0] },
    },
  ],
}))
const option = computed(
  () =>
    ({
      hours: hourOption,
      network: networkOption,
      flow: flowOption,
      materials: materialsOption,
      race: raceOption,
      height: heightOption,
    })[tab.value as 'hours']?.value ?? {},
)
function play() {
  playing.value = !playing.value
  if (!playing.value) return
  if (frame.value >= days.value.length - 1) frame.value = 0
  clearInterval(timer)
  timer = setInterval(() => {
    if (document.hidden || !playing.value) return
    if (frame.value >= days.value.length - 1) {
      playing.value = false
      return
    }
    frame.value++
  }, 900)
}
</script>
<template>
  <section class="exploration">
    <div class="project-banner">
      <div>
        <h2>{{ t('m0193') }}</h2>
        <p>{{ t('m0788') }}</p>
      </div>
      <span>{{ t('m0789') }}</span>
    </div>
    <form class="explore-filters" @submit.prevent="load">
      <label v-if="scope === 'all'"
        >{{ t('m0727') }}<select v-model="selected">
          <option v-for="s in servers" :key="s.id" :value="s.id">{{ s.name }}</option>
        </select></label
      ><label>{{ t('m0466') }}<input v-model="from" type="date" /></label
      ><label>{{ t('m0095') }}<input v-model="to" type="date" /></label
      ><button :disabled="busy">{{ busy ? t('m0790') : t('m0791') }}</button
      ><small>{{ t('m0792') }}</small>
    </form>
    <div class="story-categories">
      <button
        v-for="(group, i) in chartGroups"
        :key="group.name"
        :aria-pressed="chartGroup === i"
        @click="chooseGroup(i)"
      >
        <strong>{{ group.name }}</strong
        ><small>{{ group.help }}</small>
      </button>
    </div>
    <nav class="explore-tabs" :aria-label="t('m0793')">
      <button
        v-for="[id, label] in visibleTabs"
        :key="id"
        :class="{ selected: tab === id }"
        :aria-pressed="tab === id"
        @click="tab = id"
      >
        {{ label }}
      </button>
    </nav>
    <p v-if="error" role="alert" class="project-error">{{ error }}</p>
    <p v-if="busy" role="status">{{ t('m0794') }}</p>
    <article v-if="data" class="project-panel explore-chart">
      <h2>{{ tabs.find((t) => t[0] === tab)?.[1] }}</h2>
      <p class="muted">
        {{ t('m0795', [data.from, data.to, ['Asia/Hong_Kong', 'Asia/Shanghai'].includes(data.zone) ? 'UTC+8' : data.zone, new Date(data.generatedAt).toLocaleTimeString(formatLocale)]) }}
      </p>
      <KeepAlive><MoreCharts v-if="isExtra" :tab="tab" :server="server" :base="data" /></KeepAlive>
      <template v-if="!isExtra">
        <div class="explore-controls">
          <label v-if="['network', 'flow', 'materials'].includes(tab)"
            >{{ t('m0088') }}<select v-model="project">
              <option value="">{{ t('m0796') }}</option>
              <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select></label
          ><label v-if="!['hours', 'race'].includes(tab)"
            >{{ t('m0797') }}<select v-model="metric">
              <option value="blocks.placed">{{ t('m0679') }}</option>
              <option value="blocks.mined">{{ t('m0680') }}</option>
            </select></label
          ><label v-if="['map', 'height'].includes(tab)"
            >{{ t('m0586') }}<select v-model="dimension">
              <option value="minecraft:overworld">{{ t('m0257') }}</option>
              <option value="minecraft:nether">{{ t('m0258') }}</option>
              <option value="minecraft:the_end">{{ t('m0259') }}</option>
            </select></label
          ><label v-if="tab === 'map'"
            >{{ t('m0798') }}<select v-model="day">
              <option value="">{{ t('m0799') }}</option>
              <option v-for="d in days" :key="d">{{ d }}</option>
            </select></label
          >
        </div>
        <p v-if="tab === 'network' || tab === 'flow'" class="muted">{{ t('m0800') }}</p>
        <p v-if="tab === 'materials'" class="muted">{{ t('m0801') }}</p>
        <div v-if="tab === 'race'" class="race-controls">
          <button @click="play">{{ playing ? t('m0802') : t('m0803') }}</button
          ><strong>{{ days[frame] }}</strong
          ><input
            v-model.number="frame"
            :aria-label="t('m0804')"
            type="range"
            min="0"
            :max="Math.max(0, days.length - 1)"
            @input="playing = false"
          /><span>{{ t('m0805') }}</span>
        </div>
        <HeatMap
          v-if="tab === 'map'"
          :key="server"
          :server="server"
          :dimension="dimension"
          :rows="hotRows"
        />
        <p v-else-if="empty" class="explore-empty">{{ t('m0806') }}</p>
        <DataChart
          v-else
          :key="tab"
          :option="option"
          :label="tabs.find((t) => t[0] === tab)?.[1] ?? t('m0807')"
          :height="460"
        />
        <ul v-if="tab === 'materials'" class="material-list">
          <li v-for="[block, count] in materialRows" :key="block">
            <img
              :src="blockIcon(block)"
              alt=""
              loading="lazy"
              @error="($event.target as HTMLImageElement).style.visibility = 'hidden'"
            /><span>{{ gameName(block, 'block') ?? block }}</span
            ><strong>{{ count.toLocaleString(formatLocale) }}</strong>
          </li>
        </ul>
        <div v-if="['map', 'height'].includes(tab)" class="explore-coverage">{{ t('m0808', [Number(data.coverage.recorded_blocks).toLocaleString(formatLocale), Number(data.coverage.positioned_blocks).toLocaleString(formatLocale), data.coverage.retention_days]) }}</div>
        <details class="explore-notes">
          <summary>{{ t('m0809') }}</summary>
          <p v-for="n in data.notices" :key="n">{{ systemMessage(n) }}</p>
        </details>
      </template>
    </article>
  </section>
</template>
<style scoped>
.material-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 8px;
  list-style: none;
  padding: 0;
}
.material-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid #edf3ef;
  padding: 8px;
  font-size: 12px;
}
.material-list img {
  width: 24px;
  height: 24px;
  image-rendering: pixelated;
}
.material-list strong {
  margin-left: auto;
}
.explore-filters,
.explore-controls,
.race-controls {
  display: flex;
  align-items: end;
  flex-wrap: wrap;
  gap: 12px;
  margin: 18px 0;
}
.explore-filters label,
.explore-controls label {
  display: grid;
  gap: 6px;
  font-size: 13px;
}
.exploration input,
.exploration select {
  min-width: 0;
  padding: 10px;
  border: 1px solid #cee0d5;
  border-radius: 10px;
  background: white;
  color: #235b47;
}
.explore-tabs {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  gap: 8px;
  padding: 12px;
  background: #edf5ef;
  border-radius: 16px;
}
.explore-tabs button {
  width: auto;
  flex: 1 1 120px;
  background: white;
  color: #42685a;
  border: 1px solid #d4e5db;
  border-radius: 10px;
  padding: 12px 16px;
}
.explore-tabs .selected {
  background: #178660;
  color: white;
  border-color: #178660;
}
.explore-chart {
  margin-top: 18px;
  min-width: 0;
}
.explore-chart h2 {
  margin-bottom: 6px;
}
.muted,
.explore-notes,
.explore-filters small {
  font-size: 12px;
  color: #607a6e;
  line-height: 1.8;
}
.explore-empty {
  min-height: 250px;
  display: grid;
  place-content: center;
  color: #71887c;
}
.explore-coverage {
  margin: 16px 0;
  padding: 12px;
  border-radius: 10px;
  background: #fff5df;
  color: #78602b;
  font-size: 13px;
}
.race-controls input {
  flex: 1;
  min-width: 120px;
}
.race-controls span {
  font-size: 12px;
}
.explore-notes {
  margin-top: 18px;
}
@media (max-width: 700px) {
  .explore-tabs {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .explore-tabs button {
    font-size: 13px;
    padding: 10px;
  }
  .explore-filters label {
    flex: 1;
    min-width: 120px;
  }
  .explore-chart {
    padding: 14px;
  }
  .exploration .project-banner {
    display: block;
  }
  .explore-controls label {
    flex: 1;
    min-width: 100px;
  }
}
</style>
