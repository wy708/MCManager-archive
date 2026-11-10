<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { ArrowLeft, ShieldCheck } from '@lucide/vue'
import { api } from '../api'
import { behaviorAlgorithmName } from '../gameNames'
import { useResource } from '../useResource'
import type { BehaviorSelection } from '../workspaceRoute'
import {
  displayTime,
  formatValue,
  metricLabel,
  qualityNames,
  query,
  type Filters,
  type Profile,
  type Summary,
  type Contribution,
} from '../statistics'
import MetricCards from './MetricCards.vue'
import BehaviorView from './BehaviorView.vue'
import SummaryDetails from './SummaryDetails.vue'
import RecordBars from './RecordBars.vue'
const props = defineProps<{ playerKey: string; scope: string; filters: Filters; zone: string }>()
const emit = defineEmits<{ back: []; error: [error: unknown] }>()
const behavior = defineModel<BehaviorSelection>('behavior', { required: true })
const contributionMetric = ref('online.millis')
const heading = ref<HTMLHeadingElement>()
const { data, busy, error, refresh } = useResource(
  () => [props.playerKey, props.scope, props.filters],
  async (signal) => {
    const { playerKey, scope, filters } = props
    const profile = await api<Profile>('/players/' + encodeURIComponent(playerKey), { signal })
    if (scope !== 'all' && !profile.servers.some((server) => server.serverId === scope))
      return { profile, summary: null, contributions: [] }
    const suffix = query(scope, filters, { playerKey })
    const [summary, contributions] = await Promise.all([
      api<Summary>('/statistics/summary' + suffix, { signal }),
      api<Contribution[]>('/statistics/servers' + suffix, { signal }),
    ])
    return { profile, summary, contributions }
  },
  (ex) => emit('error', ex),
)
watch(data, () => nextTick(() => heading.value?.focus()))
const definition = computed(() =>
  data.value?.summary?.metrics.find((m) => m.key === contributionMetric.value),
)
const contributions = computed(() => {
  const rows = new Map<
    string,
    { id: string; name: string; value: bigint; versions: Map<string, string> }
  >()
  for (const row of data.value?.contributions.filter(
    (row) => row.metric === contributionMetric.value,
  ) ?? []) {
    const entry = rows.get(row.serverId) ?? {
      id: row.serverId,
      name: row.serverName,
      value: 0n,
      versions: new Map<string, string>(),
    }
    entry.value =
      definition.value?.aggregation === 'MAX'
        ? entry.value > BigInt(row.value)
          ? entry.value
          : BigInt(row.value)
        : entry.value + BigInt(row.value)
    entry.versions.set(
      `${row.quality} · ${row.algorithmVersion}`,
      `${qualityNames[row.quality]} · ${behaviorAlgorithmName(row.algorithmVersion)}`,
    )
    rows.set(row.serverId, entry)
  }
  return [...rows.values()]
})
</script>
<template>
  <section class="player-profile">
    <button class="text-button back-button" @click="emit('back')">
      <ArrowLeft :size="17" />返回玩家列表
    </button>
    <p v-if="error" class="alert error" role="alert">
      {{ error }}<button class="text-button" @click="refresh">重试</button>
    </p>
    <p v-else-if="busy" class="small-empty" role="status">正在加载玩家档案…</p>
    <template v-else-if="data"
      ><article class="panel profile-identity">
        <span class="avatar profile-avatar">{{ data.profile.player.name.charAt(0) }}</span>
        <div>
          <h2 ref="heading" tabindex="-1">{{ data.profile.player.name }}</h2>
          <details class="identity-details">
            <summary>查看玩家编号</summary>
            <code>{{ data.profile.player.key }}</code>
          </details>
          <p>
            最早记录 {{ displayTime(data.profile.player.firstSeenAt, zone) }} · 最近记录
            {{ displayTime(data.profile.player.lastSeenAt, zone) }}
          </p>
        </div>
      </article>
      <p v-if="!data.summary || data.summary.playerCount === 0" class="data-note">
        当前筛选范围内没有这位玩家的记录。
      </p>
      <MetricCards v-if="data.summary" :summary="data.summary" />
      <SummaryDetails v-if="data.summary" :summary="data.summary" />
      <div class="profile-columns">
        <article class="panel data-panel">
          <div class="data-panel-heading">
            <div>
              <h2>历史名字</h2>
              <p>这位玩家曾经用过的名字</p>
            </div>
          </div>
          <ul class="name-history">
            <li v-for="name in data.profile.names" :key="name.name">
              <strong>{{ name.name }}</strong
              ><small>最近记录 {{ displayTime(name.lastSeenAt, zone) }}</small>
            </li>
          </ul>
        </article>
        <article class="panel data-panel">
          <div class="data-panel-heading">
            <div>
              <h2>参与过的服务器</h2>
              <p>包括已经封存的世界</p>
            </div>
          </div>
          <ul class="name-history">
            <li v-for="server in data.profile.servers" :key="server.serverId">
              <strong>{{ server.serverName }}</strong
              ><span class="status" :class="server.serverStatus.toLowerCase()">{{
                server.serverStatus === 'ARCHIVED' ? '已封存' : '记录中'
              }}</span>
            </li>
          </ul>
        </article>
      </div>
      <article v-if="data.summary" class="panel data-panel">
        <div class="data-panel-heading">
          <div>
            <h2>在不同服务器的足迹</h2>
            <p>
              当前筛选范围 ·
              {{ definition?.aggregation === 'MAX' ? '最大值不跨服相加' : '可展开各服分别贡献' }}
            </p>
          </div>
          <label class="compact-select"
            >想看什么<select v-model="contributionMetric">
              <option v-for="metric in data.summary.metrics" :key="metric.key" :value="metric.key">
                {{ metricLabel(metric) }}
              </option>
            </select></label
          >
        </div>
        <RecordBars
          v-if="contributions.length"
          :rows="
            contributions
              .slice(0, 10)
              .map((row) => ({ label: row.name, raw: row.value.toString() }))
          "
          :unit="definition?.unit"
          label="各服务器玩家记录对比，前十台服务器"
        />
        <div
          v-if="contributions.length"
          class="table-scroll"
          tabindex="0"
          aria-label="各服务器贡献"
        >
          <table>
            <thead>
              <tr>
                <th>服务器</th>
                <th>{{ definition ? metricLabel(definition) : '' }}</th>
                <th>记录说明</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in contributions" :key="row.id">
                <td>{{ row.name }}</td>
                <td>{{ formatValue(row.value.toString(), definition?.unit) }}</td>
                <td>
                  <details class="identity-details">
                    <summary>查看计算方式</summary>
                    <small v-for="[raw, label] in row.versions" :key="raw" :title="raw">{{
                      label
                    }}</small>
                  </details>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="data-note">
          当前范围内没有该指标的已保存增量。未接入与零值以统计卡的覆盖状态为准。
        </p>
      </article>
      <BehaviorView
        v-if="data.summary"
        v-model:selection="behavior"
        :scope="scope"
        :filters="filters"
        :metrics="data.summary.metrics"
        :zone="data.summary.statisticsZone"
        :player-key="playerKey"
        @error="emit('error', $event)"
      />
      <p class="section-footnote">
        <ShieldCheck
          :size="15"
        />当前名字与参与历史属于全局身份档案；统计数值和明细遵循上方的服务器、日期与维度筛选。
      </p>
    </template>
  </section>
</template>
