import type { Filters } from './statistics'

const paths = {
  overview: '/',
  servers: '/servers',
  players: '/players',
  activity: '/activity',
  map: '/map',
  projects: '/projects',
  reports: '/reports',
  exploration: '/exploration',
  runtime: '/runtime',
  console: '/console',
  agents: '/agents',
  backups: '/backups',
  settings: '/settings',
  accounts: '/accounts',
} as const

export type WorkspaceSection = keyof typeof paths
export interface BehaviorSelection {
  mode: 'breakdown' | 'deaths' | 'sessions'
  metric: string
  category: string
}
export interface WorkspaceRoute {
  section: WorkspaceSection
  scope: string
  player: string | null
  filters: Filters
  behavior: BehaviorSelection
}

export const defaultBehavior: BehaviorSelection = {
  mode: 'breakdown',
  metric: 'blocks.mined',
  category: '',
}
const emptyFilters: Filters = { fromDate: '', toDate: '', dimension: '' }
const uuidPattern = '[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}'
const archiveId = new RegExp(`^${uuidPattern}$`, 'i')
const playerKey = new RegExp(`^(?:uuid:${uuidPattern}|xuid:[1-9][0-9]{0,19})$`, 'i')
const sections = Object.entries(paths) as [WorkspaceSection, string][]

function decodedPlayer(segment: string) {
  try {
    const key = decodeURIComponent(segment).toLowerCase()
    return playerKey.test(key) ? key : null
  } catch {
    return null
  }
}

function dateParam(value: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return ''
  const date = new Date(value + 'T00:00:00Z')
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(value) ? value : ''
}

export function readWorkspaceRoute(location: URL): WorkspaceRoute {
  const pathname = location.pathname.replace(/\/+$/, '') || '/'
  const profile = /^\/players\/([^/]+)$/.exec(pathname)?.[1]
  const section = profile
    ? 'players'
    : (sections.find(([, value]) => value === pathname)?.[0] ?? 'overview')
  const { searchParams } = location
  const scope = searchParams.get('server') ?? ''
  const tab = searchParams.get('tab')
  const metric = searchParams.get('metric') ?? ''
  const category = searchParams.get('category') ?? ''
  const dimension = searchParams.get('dimension') ?? ''
  const fromDate = dateParam(searchParams.get('from'))
  const toDate = dateParam(searchParams.get('to'))
  return {
    section,
    scope: archiveId.test(scope) ? scope.toLowerCase() : 'all',
    player: profile ? decodedPlayer(profile) : null,
    filters: {
      fromDate: toDate && fromDate > toDate ? '' : fromDate,
      toDate,
      dimension:
        /^(?:unknown|[a-z0-9_.-]+:[a-z0-9_./-]+)$/.test(dimension) && dimension.length <= 80
          ? dimension
          : '',
    },
    behavior: {
      mode: tab === 'deaths' || tab === 'sessions' ? tab : 'breakdown',
      metric: /^[a-z][a-z0-9_.]{0,63}$/.test(metric) ? metric : defaultBehavior.metric,
      category: ['WOOD', 'ORE', 'OTHER'].includes(category) ? category : '',
    },
  }
}

export function workspaceHref(route: WorkspaceRoute) {
  const path =
    route.section === 'players' && route.player
      ? paths.players + '/' + encodeURIComponent(route.player)
      : paths[route.section]
  const params = new URLSearchParams()
  if (route.scope !== 'all') params.set('server', route.scope)
  if (['overview', 'players', 'activity'].includes(route.section)) {
    const { fromDate, toDate, dimension } = route.filters
    if (fromDate) params.set('from', fromDate)
    if (toDate) params.set('to', toDate)
    if (dimension) params.set('dimension', dimension)
  }
  if (route.section === 'activity' || (route.section === 'players' && route.player)) {
    const { mode, metric, category } = route.behavior
    if (mode !== 'breakdown') params.set('tab', mode)
    if (metric !== defaultBehavior.metric) params.set('metric', metric)
    if (metric === 'blocks.mined' && category) params.set('category', category)
  }
  return path + (params.size ? '?' + params.toString() : '')
}

export function overviewRoute(): WorkspaceRoute {
  return {
    section: 'overview',
    scope: 'all',
    player: null,
    filters: { ...emptyFilters },
    behavior: { ...defaultBehavior },
  }
}
