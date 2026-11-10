<script setup lang="ts">
import { t } from '../i18n'

import { computed, ref, watch } from 'vue'
import { api } from '../api'
import { behaviorAlgorithmName, behaviorSubjectKind, gameName } from '../gameNames'
import RecordBars from './RecordBars.vue'
import { useResource } from '../useResource'
import { defaultBehavior, type BehaviorSelection } from '../workspaceRoute'
import {
  activityIdleDuration,
  displayTime,
  formatValue,
  metricLabel,
  qualityNames,
  query,
  type Filters,
  type Page,
  type MetricResult,
  type Breakdown,
  type Death,
  type Session,
} from '../statistics'
import PaginationControl from './PaginationControl.vue'
import GameName from './GameName.vue'
import SessionChatDialog from './SessionChatDialog.vue'
const props = defineProps<{
  scope: string
  filters: Filters
  metrics: MetricResult[]
  zone: string
  playerKey?: string
}>()
const emit = defineEmits<{ error: [error: unknown] }>()
const selection = defineModel<BehaviorSelection>('selection', { required: true })
const mode = computed(() => selection.value.mode)
function selectMode(mode: BehaviorSelection['mode']) {
  selection.value = { ...selection.value, mode }
}
const sessionChat = ref<InstanceType<typeof SessionChatDialog>>()
const showGameIds = ref(false)
const selectedMetric = computed({
  get: () =>
    props.metrics.some((metric) => metric.key === selection.value.metric)
      ? selection.value.metric
      : defaultBehavior.metric,
  set: (metric: string) => {
    selection.value = { ...selection.value, metric, category: '' }
  },
})
const category = computed({
  get: () => (selectedMetric.value === 'blocks.mined' ? selection.value.category : ''),
  set: (category: string) => {
    selection.value = { ...selection.value, category }
  },
})
const page = ref(1)
const metric = computed(() => props.metrics.find((m) => m.key === selectedMetric.value))
const measuredIdleRules = computed(() =>
  [
    ...new Set(
      metric.value?.measurements.map((item) => activityIdleDuration(item.algorithmVersion)),
    ),
  ].filter((value): value is string => value !== null),
)
const blockedSession = computed(() => mode.value === 'sessions' && Boolean(props.filters.dimension))
watch(
  () => [
    props.scope,
    props.filters,
    mode.value,
    selectedMetric.value,
    category.value,
    props.playerKey,
  ],
  () => {
    page.value = 1
    sessionChat.value?.close()
  },
)
const { data, busy, error, refresh } = useResource(
  () => [
    props.scope,
    props.filters,
    mode.value,
    selectedMetric.value,
    category.value,
    page.value,
    props.playerKey,
  ],
  (signal) =>
    blockedSession.value
      ? Promise.resolve(null)
      : api<Page<Breakdown | Death | Session>>(
          (mode.value === 'breakdown' ? '/statistics/breakdown' : '/' + mode.value) +
            query(props.scope, props.filters, {
              page: page.value,
              playerKey: props.playerKey,
              ...(mode.value === 'breakdown'
                ? { metric: selectedMetric.value, category: category.value }
                : {}),
            }),
          { signal },
        ),
  (ex) => emit('error', ex),
)
const breakdownRows = computed(() =>
  mode.value === 'breakdown' ? (data.value?.items as Breakdown[] | undefined) : [],
)
const deathRows = computed(() =>
  mode.value === 'deaths' ? (data.value?.items as Death[] | undefined) : [],
)
const chartRows = computed(() =>
  (breakdownRows.value ?? []).slice(0, 10).map((row, index) => ({
    label: `${index + 1}. ${gameName(row.subject, behaviorSubjectKind(selectedMetric.value)) ?? row.subject}`,
    raw: row.value,
  })),
)
const sessionRows = computed(() =>
  mode.value === 'sessions' ? (data.value?.items as Session[] | undefined) : [],
)
const sessionStates: Record<string, string> = {
  OPEN: t('m0534'),
  STALE: t('m0535'),
  ENDED: t('m0536'),
  INTERRUPTED: t('m0537'),
}
</script>
<template>
  <section class="panel data-panel">
    <div class="data-panel-heading">
      <div>
        <h2>{{ playerKey ? t('m0538') : t('m0539') }}</h2>
        <p>{{ t('m0540') }}</p>
      </div>
      <div class="segmented">
        <button :aria-pressed="mode === 'breakdown'" @click="selectMode('breakdown')">{{ t('m0541') }}</button
        ><button :aria-pressed="mode === 'deaths'" @click="selectMode('deaths')">{{ t('m0542') }}</button
        ><button :aria-pressed="mode === 'sessions'" @click="selectMode('sessions')">{{ t('m0543') }}</button>
      </div>
    </div>
    <label v-if="mode !== 'sessions'" class="game-id-toggle">
      <input v-model="showGameIds" type="checkbox" />{{ t('m0544') }}</label>
    <div v-if="mode === 'breakdown'" class="behavior-options">
      <label
        >{{ t('m0545') }}<select v-model="selectedMetric">
          <option v-for="item in metrics" :key="item.key" :value="item.key">
            {{ metricLabel(item) }}
          </option>
        </select></label
      ><label v-if="selectedMetric === 'blocks.mined'"
        >{{ t('m0546') }}<select v-model="category">
          <option value="">{{ t('m0547') }}</option>
          <option value="WOOD">{{ t('m0548') }}</option>
          <option value="ORE">{{ t('m0549') }}</option>
          <option value="OTHER">{{ t('m0550') }}</option>
        </select></label
      >
      <p class="subtle">
        {{ t('m0553', [metric?.aggregation === 'MAX' ? t('m0551') : t('m0552'), metric?.coveredServers ?? 0, metric?.selectedServers ?? 0]) }}</p>
    </div>
    <details
      v-if="mode === 'breakdown'"
      :key="selectedMetric"
      class="plain-details behavior-explanation"
    >
      <summary>{{ t('m0554') }}</summary>
      <p v-if="mode === 'breakdown' && selectedMetric.startsWith('kills.')" class="data-note">{{ t('m0555') }}</p>
      <p
        v-if="
          mode === 'breakdown' &&
          selectedMetric.startsWith('kills.') &&
          metric?.measurements.some((item) => item.algorithmVersion === 'native-kill-source-v1')
        "
        class="data-note"
      >{{ t('m0556') }}</p>
      <p
        v-if="
          mode === 'breakdown' &&
          selectedMetric.startsWith('kills.') &&
          metric?.measurements.some((item) => item.algorithmVersion === 'native-kill-source-v3')
        "
        class="data-note"
      >{{ t('m0557') }}</p>
      <p v-if="mode === 'breakdown' && selectedMetric === 'crops.planted'" class="data-note">{{ t('m0558') }}</p>
      <p v-if="mode === 'breakdown' && selectedMetric === 'breeding.offspring'" class="data-note">{{ t('m0559') }}</p>
      <p v-if="mode === 'breakdown' && selectedMetric.startsWith('crafting.')" class="data-note">{{ t('m0560') }}</p>
      <p v-if="mode === 'breakdown' && selectedMetric.startsWith('villager.')" class="data-note">{{ t('m0561') }}</p>
      <p v-if="mode === 'breakdown' && selectedMetric.startsWith('fishing.')" class="data-note">{{ t('m0562') }}</p>
      <p v-if="mode === 'breakdown' && selectedMetric.startsWith('travel.')" class="data-note">{{ t('m0563') }}</p>
      <p v-if="mode === 'breakdown' && selectedMetric === 'activity.millis'" class="data-note">{{ t('m0564') }}<span v-if="measuredIdleRules.length"
          >{{ t('m0565', [measuredIdleRules.join('、')]) }}</span
        >
      </p>
      <p v-if="mode === 'breakdown' && selectedMetric === 'crops.harvested'" class="data-note">{{ t('m0566') }}</p>
      <p v-if="mode === 'breakdown' && selectedMetric === 'crops.interacted'" class="data-note">{{ t('m0567') }}</p>
      <p v-if="mode === 'breakdown' && selectedMetric === 'blocks.mined'" class="data-note">{{ t('m0568') }}</p>
      <p v-if="mode === 'breakdown' && selectedMetric === 'blocks.placed'" class="data-note">{{ t('m0569') }}</p>
      <p v-if="mode === 'breakdown' && selectedMetric === 'level.max'" class="data-note">{{ t('m0570') }}</p>
      <p v-if="mode === 'breakdown' && selectedMetric.startsWith('actions.')" class="data-note">{{ t('m0571') }}</p>
      <p v-if="mode === 'breakdown' && selectedMetric === 'items.picked_up'" class="data-note">{{ t('m0572') }}</p>
      <p v-if="mode === 'breakdown' && selectedMetric === 'items.use_requests'" class="data-note">{{ t('m0573') }}</p>
      <p v-if="mode === 'breakdown' && selectedMetric === 'items.used'" class="data-note">{{ t('m0574') }}</p>
    </details>
    <p v-if="error" class="alert error" role="alert">
      {{ error }}<button class="text-button" @click="refresh">{{ t('m0337') }}</button>
    </p>
    <p v-else-if="blockedSession" class="data-note">{{ t('m0575') }}</p>
    <div v-else-if="busy" class="small-empty" role="status">{{ t('m0576') }}</div>
    <div v-else-if="!data?.items.length" class="small-empty">
      <h3>{{ t('m0577') }}</h3>
      <p>{{ t('m0578') }}</p>
    </div>
    <template v-else>
      <div v-if="mode === 'breakdown' && chartRows.length" class="behavior-chart">
        <h3>{{ t('m0579') }}</h3>
        <p class="data-note">{{ t('m0580') }}</p>
        <RecordBars :rows="chartRows" :unit="metric?.unit" :label="t('m0581')" />
      </div>
      <div
        class="table-scroll"
        tabindex="0"
        :aria-label="
          mode === 'breakdown'
            ? t('m0582')
            : mode === 'deaths'
              ? t('m0583')
              : t('m0584')
        "
      >
        <table v-if="mode === 'breakdown'">
          <thead>
            <tr>
              <th>{{ t('m0585') }}</th>
              <th>{{ t('m0586') }}</th>
              <th>{{ t('m0587') }}</th>
              <th>{{ t('m0588') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in breakdownRows"
              :key="[row.subject, row.dimension, row.quality, row.algorithmVersion].join('|')"
            >
              <td>
                <GameName
                  :raw="row.subject"
                  :kind="behaviorSubjectKind(selectedMetric)"
                  :show-id="showGameIds"
                />
              </td>
              <td><GameName :raw="row.dimension" kind="dimension" :show-id="showGameIds" /></td>
              <td class="numeric">{{ formatValue(row.value, metric?.unit) }}</td>
              <td>
                <span class="quality-badge" :class="row.quality.toLowerCase()">{{
                  qualityNames[row.quality]
                }}</span>
                <details class="identity-details">
                  <summary>{{ t('m0589') }}</summary>
                  <small :title="row.algorithmVersion" :data-algorithm="row.algorithmVersion">{{
                    behaviorAlgorithmName(row.algorithmVersion)
                  }}</small>
                </details>
                <small v-if="showGameIds">{{ row.algorithmVersion }}</small>
              </td>
            </tr>
          </tbody>
        </table>
        <table v-else-if="mode === 'deaths'">
          <thead>
            <tr>
              <th>{{ t('m0590') }}</th>
              <th>{{ t('m0591') }}</th>
              <th>{{ t('m0586') }}</th>
              <th>{{ t('m0592') }}</th>
              <th>{{ t('m0593') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in deathRows" :key="row.serverId + row.eventId">
              <td>
                <strong>{{ row.playerName }}</strong
                ><small>{{ row.serverName }}</small>
              </td>
              <td>{{ displayTime(row.at, zone) }}</td>
              <td><GameName :raw="row.dimension" kind="dimension" :show-id="showGameIds" /></td>
              <td><GameName :raw="row.cause" kind="death" :show-id="showGameIds" /></td>
              <td>
                <GameName
                  v-if="row.killerType"
                  :raw="row.killerType"
                  kind="entity"
                  :show-id="showGameIds"
                />
                <template v-else>{{ t('m0594') }}</template>
              </td>
            </tr>
          </tbody>
        </table>
        <table v-else>
          <thead>
            <tr>
              <th>{{ t('m0590') }}</th>
              <th>{{ t('m0595') }}</th>
              <th>{{ t('m0596') }}</th>
              <th>{{ t('m0597') }}</th>
              <th>{{ t('m0598') }}</th>
              <th>{{ t('m0599') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in sessionRows" :key="row.serverId + row.sessionId">
              <td>
                <strong>{{ row.playerName }}</strong
                ><small>{{ row.serverName }}</small>
              </td>
              <td>
                {{ displayTime(row.startedAt, zone) }}
                <small>{{
                  row.startReason === 'JOIN'
                    ? t('m0600')
                    : row.startReason === 'OBSERVED'
                      ? t('m0601')
                      : t('m0602')
                }}</small>
              </td>
              <td>{{ displayTime(row.checkpointAt, zone) }}</td>
              <td :title="row.onlineMillis + t('m0603')">{{ formatValue(row.onlineMillis, 'ms') }}</td>
              <td>
                {{
                  row.endReason === 'CAPTURE_STOPPED'
                    ? t('m0604')
                    : (sessionStates[row.state] ?? row.state)
                }}
              </td>
              <td>
                <button class="text-button" @click="sessionChat?.open(row)">{{ t('m0605') }}</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <PaginationControl :page="page" :total="data.total" :busy="busy" @change="page = $event"
    /></template>
    <p class="data-note">
      {{
        mode === 'sessions'
          ? t('m0606')
          : mode === 'deaths'
            ? t('m0607')
            : t('m0608')
      }}
    </p>
    <SessionChatDialog ref="sessionChat" :zone="zone" @error="emit('error', $event)" />
  </section>
</template>

<style scoped>
.game-id-toggle {
  display: inline-flex;
  flex-direction: row;
  align-items: center;
  gap: 0.35rem;
  margin-bottom: 0.75rem;
  font-size: 0.8rem;
  padding: 0 22px;
  white-space: nowrap;
}
.game-id-toggle input {
  width: 16px;
  height: 16px;
  flex: 0 0 16px;
  margin: 0;
  accent-color: #17815f;
}
</style>
