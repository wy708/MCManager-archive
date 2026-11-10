export interface Measurement {
  quality: 'EXACT' | 'ESTIMATED' | 'OBSERVED'
  algorithmVersion: string
  value: string
}
export interface MetricResult {
  key: string
  label: string
  unit: string
  aggregation: 'SUM' | 'MAX'
  value: string | null
  coveredServers: number
  selectedServers: number
  measurements: Measurement[]
}
export interface Summary {
  statisticsZone: string
  playerCount: number
  sessionCount: number | null
  confirmedJoinCount: number | null
  longestSessionMillis: string | null
  woodBlocks: string | null
  oreBlocks: string | null
  metrics: MetricResult[]
}
export interface Filters {
  fromDate: string
  toDate: string
  dimension: string
}
export interface Page<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}
export interface PlayerRow {
  key: string
  name: string
  firstSeenAt: string
  lastSeenAt: string
}
export interface Profile {
  player: PlayerRow
  names: { name: string; firstSeenAt: string; lastSeenAt: string }[]
  servers: {
    serverId: string
    serverName: string
    serverStatus: string
    firstSeenAt: string
    lastSeenAt: string
  }[]
}
export interface DailyPoint extends Measurement {
  day: string
  metric: string
}
export interface DimensionPoint extends Measurement {
  dimension: string
  metric: string
}
export interface Contribution extends Measurement {
  serverId: string
  serverName: string
  metric: string
}
export interface Breakdown extends Measurement {
  subject: string
  dimension: string
  category: string
}
export interface Death {
  eventId: string
  serverId: string
  serverName: string
  playerKey: string
  playerName: string
  at: string
  dimension: string
  cause: string
  killerType: string | null
}
export interface Session {
  sessionId: string
  serverId: string
  serverName: string
  playerKey: string
  playerName: string
  startedAt: string
  checkpointAt: string
  onlineMillis: string
  ended: boolean
  endReason: string | null
  startReason: 'JOIN' | 'OBSERVED' | null
  state: string
}
export interface Capability {
  metric: string
  state: 'ACTIVE' | 'DISABLED' | 'UNSUPPORTED' | 'ERROR'
  quality: Measurement['quality'] | null
  algorithmVersion: string | null
  dimensionAware: boolean
}
export interface Coverage {
  metric: string
  quality: Measurement['quality']
  algorithmVersion: string
  dimensionAware: boolean
  firstObservedAt: string
  lastObservedAt: string
}
export interface CollectorStatus {
  serverId: string
  serverName: string
  credentialConfigured: boolean
  connectionState: 'UNCONNECTED' | 'STALE' | 'CONNECTED' | 'REPLAYING'
  diagnostics: CollectorDiagnostic | null
  previousAnomalies: CollectorDiagnostic[]
  collector: {
    version: string
    bdsVersion: string
    leviLaminaVersion: string
    reportedAt: string
    lastSeenAt: string
    pendingEvents: number
  } | null
  capabilities: Capability[]
  coverage: Coverage[]
}
export interface CollectorDiagnostic {
  bootId: string
  reportedAt: string
  queuedEvents: number
  rejectedSubmissions: number
  captureGaps: number
  diskError: boolean
  diskFaults: number
  finalReport: boolean
}
export interface MetricDefinition {
  key: string
  label: string
  unit: string
  aggregation: 'SUM' | 'MAX'
  estimatedOnly: boolean
}
export function metricLabel(metric: { key: string; label: string }) {
  const labels: Record<string, string> = {
    'travel.walk_millimeters': '步行',
    'travel.swim_millimeters': '游泳',
    'travel.fly_millimeters': '飞行',
    'travel.glide_millimeters': '滑翔',
    'travel.vehicle_millimeters': '乘坐载具',
    'activity.millis': '活跃时间（估算）',
  }
  return labels[metric.key] ?? metric.label
}
export const dimensions: Record<string, string> = {
  'minecraft:overworld': '主世界',
  'minecraft:nether': '下界',
  'minecraft:the_end': '末地',
  unknown: '未记录维度',
}
export const qualityNames = { EXACT: '精确记录', ESTIMATED: '估算', OBSERVED: '已观测' }
export const stateNames = {
  ACTIVE: '启用',
  DISABLED: '已停用',
  UNSUPPORTED: '尚未支持',
  ERROR: '采集异常',
}
export const connectionNames = {
  UNCONNECTED: '尚未连接',
  STALE: '较久未连接',
  CONNECTED: '最近已连接',
  REPLAYING: '正在补传记录',
}
export function query(
  scope: string,
  filters?: Filters,
  extra: Record<string, string | number | undefined> = {},
) {
  const params = new URLSearchParams()
  if (scope !== 'all') params.set('serverId', scope)
  for (const [key, value] of Object.entries({ ...filters, ...extra }))
    if (value !== '' && value !== undefined) params.set(key, String(value))
  return params.size ? '?' + params.toString() : ''
}
export function formatInteger(value: string | number | null | undefined) {
  if (value === null || value === undefined) return '未接入'
  try {
    return BigInt(value).toLocaleString('zh-CN')
  } catch {
    return '—'
  }
}
export function formatValue(value: string | null | undefined, unit = 'count') {
  if (value === null || value === undefined) return '未接入'
  if (unit === 'ms') {
    const millis = BigInt(value)
    const hours = millis / 3_600_000n,
      minutes = (millis % 3_600_000n) / 60_000n,
      seconds = (millis % 60_000n) / 1000n
    return hours > 0
      ? `${hours.toLocaleString('zh-CN')} 小时 ${minutes} 分`
      : minutes > 0
        ? `${minutes} 分 ${seconds} 秒`
        : `${seconds} 秒`
  }
  if (unit === 'mm') {
    const mm = BigInt(value)
    return `${(mm / 1000n).toLocaleString('zh-CN')}.${(mm % 1000n).toString().padStart(3, '0')} 米`
  }
  return formatInteger(value)
}
export function displayTime(value: string | null | undefined, zone = 'Asia/Hong_Kong') {
  if (!value) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: zone,
    dateStyle: 'medium',
    timeStyle: 'short',
    hour12: false,
  }).format(new Date(value))
}
export function activityIdleDuration(algorithmVersion?: string | null) {
  const match = /^native-activity-idle-([0-9]+)s-v1$/.exec(algorithmVersion ?? '')
  if (!match) return null
  const seconds = Number(match[1])
  return seconds % 60 === 0 ? `${seconds / 60} 分钟` : `${seconds} 秒`
}
export function failure(ex: unknown) {
  return ex instanceof TypeError
    ? '无法连接服务器，请检查连接后重试'
    : ex instanceof Error
      ? ex.message
      : '加载失败，请重试'
}
