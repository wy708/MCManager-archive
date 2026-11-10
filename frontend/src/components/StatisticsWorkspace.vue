<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { ShieldCheck } from '@lucide/vue'
import { api } from '../api'
import { behaviorAlgorithmName } from '../gameNames'
import type { ServerArchive } from '../api'
import OverviewHighlights from './OverviewHighlights.vue'
import { useResource } from '../useResource'
import type { BehaviorSelection } from '../workspaceRoute'
import {
  activityIdleDuration,
  metricLabel,
  query,
  qualityNames,
  stateNames,
  type Filters,
  type Summary,
  type DailyPoint,
  type DimensionPoint,
  type CollectorStatus,
} from '../statistics'
import StatisticsFilters from './StatisticsFilters.vue'
import MetricCards from './MetricCards.vue'
import TrendChart from './TrendChart.vue'
import WorldInsights from './WorldInsights.vue'
import PlayersView from './PlayersView.vue'
import BehaviorView from './BehaviorView.vue'
import PlayerProfileView from './PlayerProfileView.vue'
import SummaryDetails from './SummaryDetails.vue'
const props = defineProps<{
  view: string
  player: string | null
  scope: string
  revision: number
  servers: ServerArchive[]
}>()
const emit = defineEmits<{ error: [error: unknown]; player: [key: string | null] }>()
const filters = defineModel<Filters>('filters', { required: true })
const behavior = defineModel<BehaviorSelection>('behavior', { required: true })
const { data, busy, error, refresh } = useResource(
  () => [props.scope, props.view, props.revision, filters.value],
  async (signal) => {
    const suffix = query(props.scope, filters.value)
    const [summary, collectors] = await Promise.all([
      api<Summary>('/statistics/summary' + suffix, { signal }),
      api<CollectorStatus[]>('/collectors' + query(props.scope), { signal }),
    ])
    const end =
      filters.value.toDate ||
      new Date().toLocaleDateString('sv-SE', { timeZone: summary.statisticsZone })
    const latestFrom = new Date(Date.parse(end + 'T00:00:00Z') - 365 * 86_400_000)
      .toISOString()
      .slice(0, 10)
    const trendFilters = {
      ...filters.value,
      toDate: end,
      fromDate:
        filters.value.fromDate && filters.value.fromDate < latestFrom
          ? latestFrom
          : filters.value.fromDate,
    }
    const [points, dimensionPoints] = await Promise.all([
      props.view === 'overview' && (!trendFilters.fromDate || trendFilters.fromDate <= end)
        ? api<DailyPoint[]>('/statistics/daily' + query(props.scope, trendFilters), { signal })
        : Promise.resolve([]),
      props.view === 'overview'
        ? api<DimensionPoint[]>(
            '/statistics/dimensions' +
              query(props.scope, filters.value, { metric: 'online.millis' }),
            { signal },
          )
        : Promise.resolve([]),
    ])
    return { summary, collectors, points, dimensionPoints }
  },
  (ex) => emit('error', ex),
)
const coverageMetric = ref('online.millis')
const statisticsExpanded = ref(false)
const coverage = computed(
  () =>
    data.value?.collectors.map((collector) => ({
      ...collector,
      current: collector.capabilities.find((cap) => cap.metric === coverageMetric.value),
      history: collector.coverage.filter((cap) => cap.metric === coverageMetric.value),
    })) ?? [],
)
let playerOpener: HTMLElement | null = null
function selectPlayer(key: string) {
  playerOpener = document.activeElement as HTMLElement
  emit('player', key)
}
function backToPlayers() {
  emit('player', null)
  nextTick(() => {
    if (playerOpener?.isConnected) playerOpener.focus()
  })
}
</script>
<template>
  <section class="statistics-workspace">
    <StatisticsFilters
      v-if="view !== 'overview'"
      v-model="filters"
      :busy="busy"
      @refresh="refresh"
    />
    <p v-if="error" class="alert error" role="alert">
      {{ error }}<button class="text-button" @click="refresh">重新加载统计</button>
    </p>
    <p v-else-if="busy" class="small-empty" role="status">正在加载统计…</p>
    <template v-if="view === 'overview'">
      <OverviewHighlights
        :summary="data?.summary ?? null"
        :servers="servers"
        :scope="scope"
        :revision="revision"
        @error="emit('error', $event)"
      />
    </template>
    <template v-if="data && !busy && !error">
      <template v-if="view === 'overview'">
        <div class="dashboard-main-row">
          <TrendChart :points="data.points" :zone="data.summary.statisticsZone" /><slot
            name="beside-trend"
          />
        </div>
        <slot name="after-metrics" />
        <WorldInsights
          :points="data.points"
          :dimension-points="data.dimensionPoints"
          :summary="data.summary"
        />
        <details
          class="panel overview-detail-controls"
          :open="statisticsExpanded"
          @toggle="statisticsExpanded = ($event.target as HTMLDetailsElement).open"
        >
          <summary>更多统计 · 按日期查看</summary>
          <StatisticsFilters v-model="filters" :busy="busy" @refresh="refresh" /><MetricCards
            :summary="data.summary"
          />
        </details>
        <SummaryDetails :summary="data.summary" />
      </template>
      <template v-else-if="view === 'players'"
        ><PlayersView
          v-show="!player"
          :scope="scope"
          :filters="filters"
          :zone="data.summary.statisticsZone"
          @select="selectPlayer"
          @error="emit('error', $event)" /><PlayerProfileView
          v-if="player"
          v-model:behavior="behavior"
          :player-key="player"
          :scope="scope"
          :filters="filters"
          :zone="data.summary.statisticsZone"
          @back="backToPlayers"
          @error="emit('error', $event)"
      /></template>
      <BehaviorView
        v-else-if="view === 'activity'"
        v-model:selection="behavior"
        :scope="scope"
        :filters="filters"
        :metrics="data.summary.metrics"
        :zone="data.summary.statisticsZone"
        @error="emit('error', $event)"
      />
      <details class="panel coverage-panel">
        <summary><ShieldCheck :size="17" />数据从哪里来？<span>记录范围与计算说明</span></summary>
        <div class="coverage-content">
          <label class="compact-select"
            >查看指标<select v-model="coverageMetric">
              <option v-for="metric in data.summary.metrics" :key="metric.key" :value="metric.key">
                {{ metricLabel(metric) }}
              </option>
            </select></label
          >
          <p class="data-note">
            这里只统计游戏插件实际传回的记录。断线期间可能缺少数据；没有接入的项目显示为“未接入”，不代表玩家没有做过。停用插件后，已有记录仍会保留。
          </p>
          <div v-if="coverage.length" class="table-scroll" tabindex="0" aria-label="指标覆盖明细">
            <table>
              <thead>
                <tr>
                  <th>服务器</th>
                  <th>当前能力</th>
                  <th>历史质量 / 算法</th>
                  <th>维度细分</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in coverage" :key="row.serverId">
                  <td>{{ row.serverName }}</td>
                  <td>
                    {{ row.current ? stateNames[row.current.state] : '尚未声明' }}
                    <small v-if="activityIdleDuration(row.current?.algorithmVersion)">
                      挂机阈值 {{ activityIdleDuration(row.current?.algorithmVersion) }}
                    </small>
                  </td>
                  <td>
                    <template v-if="row.history.length"
                      ><small
                        v-for="history in row.history"
                        :key="history.quality + history.algorithmVersion"
                        :title="history.algorithmVersion"
                        >{{ qualityNames[history.quality] }} ·
                        {{ behaviorAlgorithmName(history.algorithmVersion) }}</small
                      ></template
                    ><span v-else>无历史覆盖</span>
                  </td>
                  <td>{{ row.current?.dimensionAware ? '已声明' : '未声明支持' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="data-note">先添加服务器，连接采集器后查看覆盖。</p>
        </div>
      </details>
    </template>
  </section>
</template>
