import { systemMessage, t, formatLocale } from './i18n'
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
    'travel.walk_millimeters': t('m0251'),
    'travel.swim_millimeters': t('m0252'),
    'travel.fly_millimeters': t('m0253'),
    'travel.glide_millimeters': t('m0254'),
    'travel.vehicle_millimeters': t('m0255'),
    'activity.millis': t('m0256'),
  }
  return labels[metric.key] ?? systemMessage(metric.label)
}
export const dimensions: Record<string, string> = {
  'minecraft:overworld': t('m0257'),
  'minecraft:nether': t('m0258'),
  'minecraft:the_end': t('m0259'),
  unknown: t('m0260'),
}
export const qualityNames = { EXACT: t('m0261'), ESTIMATED: t('m0262'), OBSERVED: t('m0263') }
export const stateNames = {
  ACTIVE: t('m0264'),
  DISABLED: t('m0265'),
  UNSUPPORTED: t('m0266'),
  ERROR: t('m0267'),
}
export const connectionNames = {
  UNCONNECTED: t('m0268'),
  STALE: t('m0269'),
  CONNECTED: t('m0270'),
  REPLAYING: t('m0271'),
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
  if (value === null || value === undefined) return t('m0272')
  try {
    return BigInt(value).toLocaleString(formatLocale)
  } catch {
    return '—'
  }
}
export function formatValue(value: string | null | undefined, unit = 'count') {
  if (value === null || value === undefined) return t('m0272')
  if (unit === 'ms') {
    const millis = BigInt(value)
    const hours = millis / 3_600_000n,
      minutes = (millis % 3_600_000n) / 60_000n,
      seconds = (millis % 60_000n) / 1000n
    return hours > 0
      ? t('m0273', [hours.toLocaleString(formatLocale), minutes])
      : minutes > 0
        ? t('m0274', [minutes, seconds])
        : t('m0275', [seconds])
  }
  if (unit === 'mm') {
    const mm = BigInt(value)
    return t('m0276', [(mm / 1000n).toLocaleString(formatLocale), (mm % 1000n).toString().padStart(3, '0')])
  }
  return formatInteger(value)
}
export function displayTime(value: string | null | undefined, zone = 'Asia/Hong_Kong') {
  if (!value) return '—'
  return new Intl.DateTimeFormat(formatLocale, {
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
  return seconds % 60 === 0 ? t('m0277', [seconds / 60]) : t('m0275', [seconds])
}
export function failure(ex: unknown) {
  return ex instanceof TypeError
    ? t('m0278')
    : ex instanceof Error
      ? systemMessage(ex.message)
      : t('m0279')
}
