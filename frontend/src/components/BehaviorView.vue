<script setup lang="ts">
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
  OPEN: '尚未结束 · 最近有更新',
  STALE: '较久没有更新',
  ENDED: '正常结束',
  INTERRUPTED: '异常中断',
}
</script>
<template>
  <section class="panel data-panel">
    <div class="data-panel-heading">
      <div>
        <h2>{{ playerKey ? '该玩家的记录明细' : '玩家做了什么' }}</h2>
        <p>选择一类行为，查看物品、方块和游玩记录。</p>
      </div>
      <div class="segmented">
        <button :aria-pressed="mode === 'breakdown'" @click="selectMode('breakdown')">
          行为分类</button
        ><button :aria-pressed="mode === 'deaths'" @click="selectMode('deaths')">死亡记录</button
        ><button :aria-pressed="mode === 'sessions'" @click="selectMode('sessions')">
          游玩与聊天
        </button>
      </div>
    </div>
    <label v-if="mode !== 'sessions'" class="game-id-toggle">
      <input v-model="showGameIds" type="checkbox" />显示游戏内编号
    </label>
    <div v-if="mode === 'breakdown'" class="behavior-options">
      <label
        >想看什么<select v-model="selectedMetric">
          <option v-for="item in metrics" :key="item.key" :value="item.key">
            {{ metricLabel(item) }}
          </option>
        </select></label
      ><label v-if="selectedMetric === 'blocks.mined'"
        >方块分类<select v-model="category">
          <option value="">全部方块</option>
          <option value="WOOD">原木 / 菌柄</option>
          <option value="ORE">矿石</option>
          <option value="OTHER">其他方块</option>
        </select></label
      >
      <p class="subtle">
        {{ metric?.aggregation === 'MAX' ? '显示记录中的最高值' : '显示累计数量' }} ·
        {{ metric?.coveredServers ?? 0 }}/{{ metric?.selectedServers ?? 0 }} 服曾启用
      </p>
    </div>
    <details
      v-if="mode === 'breakdown'"
      :key="selectedMetric"
      class="plain-details behavior-explanation"
    >
      <summary>这些数量怎么算？</summary>
      <p v-if="mode === 'breakdown' && selectedMetric.startsWith('kills.')" class="data-note">
        按已确认死亡的目标计次，保留生物或玩家类型；直接伤害、投射物、有明确点火者的爆炸、可识别主人的驯服宠物和已追踪点火来源的持续燃烧可归属。未致死、图腾保命、取消和重复死亡路径不计；环境死亡不借用最近攻击者，无法可靠识别来源时不计入玩家击杀。
      </p>
      <p
        v-if="
          mode === 'breakdown' &&
          selectedMetric.startsWith('kills.') &&
          metric?.measurements.some((item) => item.algorithmVersion === 'native-kill-source-v1')
        "
        class="data-note"
      >
        旧版本可能漏记击杀者离线后的凋零结算和宠物击杀；历史保留原算法，没有推测回填。当前版本仅在已确认来源、目标及主人身份仍匹配时延续归属。
      </p>
      <p
        v-if="
          mode === 'breakdown' &&
          selectedMetric.startsWith('kills.') &&
          metric?.measurements.some((item) => item.algorithmVersion === 'native-kill-source-v3')
        "
        class="data-note"
      >
        宠物随世界保存的主人身份可跨游戏进程使用，归属时仍会核对宠物的原生主人。旧算法可能遗漏重启后主人离线期间的宠物击杀。
      </p>
      <p v-if="mode === 'breakdown' && selectedMetric === 'crops.planted'" class="data-note">
        记录种子或可种植物品实际形成的新作物，按已适配作物分类；施肥、自然生长、失败和取消不计。
      </p>
      <p v-if="mode === 'breakdown' && selectedMetric === 'breeding.offspring'" class="data-note">
        只记录原生交配结果中已实际加入世界的新生个体，按子代类型和出生维度分类。双亲须归属同一玩家；不同玩家喂养或来源无法确认时不重复分配。喂食、爱心、冷却、取消、命令生成及仅怀孕或产卵不计；已确认的喂养来源在本次运行内可延续到玩家离线后的出生。
      </p>
      <p v-if="mode === 'breakdown' && selectedMetric.startsWith('crafting.')" class="data-note">
        只记录玩家背包或工作台合成在服务器最终提交成功的结果，包含配方书操作。合成次数按配方执行次数累计，产物按实际配方数量累计；一次批量操作可包含多次配方。预览、移动材料、失败回滚、直接给予物品和自动合成器不计入。
        次数按配方首个产物分类；产物明细包含配方返还的瓶、桶等容器。
      </p>
      <p v-if="mode === 'breakdown' && selectedMetric.startsWith('villager.')" class="data-note">
        只记录原版村民和流浪商人交易最终提交成功的结果，交易次数与产物数量分别累计，按实际产物类型分类。一次批量操作可完成多次交易；打开界面、预览、失败回滚、售罄和插件经济交易不计入。
      </p>
      <p v-if="mode === 'breakdown' && selectedMetric.startsWith('fishing.')" class="data-note">
        收竿按服务器实际完成的操作计次，空收竿也包含在内。拉回物品要求物品实体实际受到拉力，拉回生物不算物品；成功钓获要求本次收竿新生成并确认进入世界的钓鱼产物，钩住已有物品不算新鱼获。操作次数与物品数量分别累计，生成鱼获不等于已经拾取入背包。
        收竿按鱼钩分类，拉回和钓获按物品类型分类；同次操作有多种物品时，次数归入按标识排序的首项，数量分别列出。
      </p>
      <p v-if="mode === 'breakdown' && selectedMetric.startsWith('travel.')" class="data-note">
        移动距离是服务端相邻位置的估算值。每段只归入一种移动方式，依次判断载具、滑翔、飞行、游泳和步行。步行使用水平距离，其余使用三维距离。传送、跨维度、重生、模式切换和异常跳变会切断距离累计。
      </p>
      <p v-if="mode === 'breakdown' && selectedMetric === 'activity.millis'" class="data-note">
        活跃时间从确认的移动输入与位移、挖掘、交互或公开发言开始估算。默认连续 5
        分钟无有效行为后停止累计。在线停留时间包含挂机，单独记录。
        <span v-if="measuredIdleRules.length"
          >所选记录采用的挂机阈值为 {{ measuredIdleRules.join('、') }}。</span
        >
      </p>
      <p v-if="mode === 'breakdown' && selectedMetric === 'crops.harvested'" class="data-note">
        破坏前达到已适配的成熟状态，成功破坏后才记录；这是采收方块数，不是掉落物数量。成熟瓶子草上下两格分别计数，未成熟作物和瓜藤不计，生存与创造操作都记录。
      </p>
      <p v-if="mode === 'breakdown' && selectedMetric === 'crops.interacted'" class="data-note">
        记录甜浆果、发光浆果实际采收后状态改变的操作次数；重复点击空果、施肥、失败和取消不计。
      </p>
      <p v-if="mode === 'breakdown' && selectedMetric === 'blocks.mined'" class="data-note">
        按实际破坏的方块位置计数，已确认同时消失的配对半格分别记录；失败和取消不计，旧记录保留原算法。
      </p>
      <p v-if="mode === 'breakdown' && selectedMetric === 'blocks.placed'" class="data-note">
        按实际放置的方块格数计数，床和门完整放置时各计两格，部分成功按实际格数记录；叠加雪层或合并台阶按变更位置计一次。开关、失败和取消不计，旧记录保留原算法。
      </p>
      <p v-if="mode === 'breakdown' && selectedMetric === 'level.max'" class="data-note">
        最高等级取当前筛选范围内的观测最大值。降级不会降低历史最高值；日期和维度筛选只包含该范围内实际收到的观测。
      </p>
      <p v-if="mode === 'breakdown' && selectedMetric.startsWith('actions.')" class="data-note">
        跳跃和挥手记录游戏触发的动作事件；潜行和疾跑按确认的状态变化计次，重复开始输入不重复累计，离线和死亡期间不计时。
      </p>
      <p v-if="mode === 'breakdown' && selectedMetric === 'items.picked_up'" class="data-note">
        拾取量按拾取过程中背包实际收入的数量累计，部分拾取只计收入部分；取消、背包已满和直接给予物品不计入。
      </p>
      <p v-if="mode === 'breakdown' && selectedMetric === 'items.use_requests'" class="data-note">
        使用请求记录到达游戏物品操作入口的尝试，包含被取消和未成功的使用；请求次数不等于成功使用或消耗数量。
      </p>
      <p v-if="mode === 'breakdown' && selectedMetric === 'items.used'" class="data-note">
        成功使用按游戏确认的操作计次，持续进食等在完成后记录；取消、失败和中途停止不计入。一次使用不等于消耗一个物品。
        旧版记录可能包含持物采浆果的误计，保留原始版本供核对。
      </p>
    </details>
    <p v-if="error" class="alert error" role="alert">
      {{ error }}<button class="text-button" @click="refresh">重试</button>
    </p>
    <p v-else-if="blockedSession" class="data-note">
      一次游玩可能经过多个世界。请清空“所在世界”筛选后查看上线与下线记录。
    </p>
    <div v-else-if="busy" class="small-empty" role="status">正在加载记录…</div>
    <div v-else-if="!data?.items.length" class="small-empty">
      <h3>此范围内没有已记录的明细</h3>
      <p>指标未接入、没有对应行为或筛选范围不同，都可能没有记录。</p>
    </div>
    <template v-else>
      <div v-if="mode === 'breakdown' && chartRows.length" class="behavior-chart">
        <h3>当前页的行为记录</h3>
        <p class="data-note">展示本页前 10 条，与下方表格顺序一致；不是所有记录的排行榜。</p>
        <RecordBars :rows="chartRows" :unit="metric?.unit" label="当前页行为数量对比" />
      </div>
      <div
        class="table-scroll"
        tabindex="0"
        :aria-label="
          mode === 'breakdown'
            ? '行为分类明细'
            : mode === 'deaths'
              ? '死亡记录明细'
              : '上线与下线明细'
        "
      >
        <table v-if="mode === 'breakdown'">
          <thead>
            <tr>
              <th>分类对象</th>
              <th>维度</th>
              <th>数值</th>
              <th>记录说明</th>
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
                  <summary>查看计算方式</summary>
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
              <th>玩家 / 服务器</th>
              <th>时间</th>
              <th>维度</th>
              <th>最终死因</th>
              <th>来源类型</th>
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
                <template v-else>无法归属</template>
              </td>
            </tr>
          </tbody>
        </table>
        <table v-else>
          <thead>
            <tr>
              <th>玩家 / 服务器</th>
              <th>开始时间</th>
              <th>最近更新时间</th>
              <th>已确认时长</th>
              <th>游玩状态</th>
              <th>聊天</th>
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
                    ? '确认进服'
                    : row.startReason === 'OBSERVED'
                      ? '采集开始时已在线'
                      : '旧版未区分'
                }}</small>
              </td>
              <td>{{ displayTime(row.checkpointAt, zone) }}</td>
              <td :title="row.onlineMillis + ' 毫秒'">{{ formatValue(row.onlineMillis, 'ms') }}</td>
              <td>
                {{
                  row.endReason === 'CAPTURE_STOPPED'
                    ? '采集停止'
                    : (sessionStates[row.state] ?? row.state)
                }}
              </td>
              <td>
                <button class="text-button" @click="sessionChat?.open(row)">查看聊天</button>
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
          ? '按开始游玩的日期筛选。插件断线期间不计时，恢复后会另记一段。'
          : mode === 'deaths'
            ? '最终死因不能代表完整伤害因果链；未知来源不会强行归属玩家。'
            : '分类不是额外的总计。伐木和矿石已经包含在挖掘中；估算值保留算法版本。'
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
