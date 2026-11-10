<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, ref, defineAsyncComponent } from 'vue'
import {
  Activity,
  Bot,
  Archive,
  ArrowRight,
  Box,
  BookOpen,
  CalendarDays,
  Check,
  HardDrive,
  Home,
  Leaf,
  Menu,
  Map as MapIcon,
  Plus,
  Search,
  Server,
  Settings,
  Terminal,
  ShieldCheck,
  Users,
  X,
} from '@lucide/vue'
import { api, ApiError, refreshCsrf, type ServerArchive } from './api'
import StatisticsWorkspace from './components/StatisticsWorkspace.vue'
const CollectorsView = defineAsyncComponent(() => import('./components/CollectorsView.vue'))
const AgentsView = defineAsyncComponent(() => import('./components/AgentsView.vue'))
const BackupsView = defineAsyncComponent(() => import('./components/BackupsView.vue'))
const WorldMapView = defineAsyncComponent(() => import('./components/WorldMapView.vue'))
const ServerConsoleView = defineAsyncComponent(() => import('./components/ServerConsoleView.vue'))
const ProjectsView = defineAsyncComponent(() => import('./components/ProjectsView.vue'))
const AccountsView = defineAsyncComponent(() => import('./components/AccountsView.vue'))
import PasswordDialog from './components/PasswordDialog.vue'
const ExplorationView = defineAsyncComponent(() => import('./components/ExplorationView.vue'))
const DailyReportsView = defineAsyncComponent(() => import('./components/DailyReportsView.vue'))
const ServerRuntimeView = defineAsyncComponent(() => import('./components/ServerRuntimeView.vue'))
import RecentUpdates from './components/RecentUpdates.vue'
import WorkspaceHeader from './components/WorkspaceHeader.vue'
import GameIcon from './components/GameIcon.vue'
import FeatureFinder from './components/FeatureFinder.vue'
import OverviewCompanion from './components/OverviewCompanion.vue'
import OverviewProjects from './components/OverviewProjects.vue'
import { navigation, navigationGroups, visibleNavigation } from './navigation'
import WorldPreviewCard from './components/WorldPreviewCard.vue'
import { connectionNames, type CollectorStatus } from './statistics'
import {
  defaultBehavior,
  overviewRoute,
  readWorkspaceRoute,
  workspaceHref,
  type WorkspaceRoute,
  type WorkspaceSection,
} from './workspaceRoute'

const loading = ref(true)
const authenticated = ref(false)
const accountRole = ref<'ADMIN' | 'VIEWER'>('VIEWER')
const isAdmin = computed(() => accountRole.value === 'ADMIN')
const passwordDialog = ref<InstanceType<typeof PasswordDialog>>()
const loginNotice = ref('')
const restrictedSections = new Set(['settings', 'accounts', 'agents', 'backups', 'console'])
const username = ref('admin')
const password = ref('')
const loginBusy = ref(false)
const loginError = ref('')
const error = ref('')
const notice = ref('')
const servers = ref<ServerArchive[]>([])
const collectors = ref<CollectorStatus[]>([])
const revision = ref(0)
const archivesReadAt = ref('')
const collectorMap = computed(
  () => new Map(collectors.value.map((collector) => [collector.serverId, collector])),
)
const route = ref(readWorkspaceRoute(new URL(window.location.href)))
const view = computed(() => route.value.section)
const scope = computed({
  get: () => route.value.scope,
  set: (scope) => updateRoute({ ...route.value, scope }),
})
const filters = computed({
  get: () => route.value.filters,
  set: (filters) => updateRoute({ ...route.value, filters }),
})
const behavior = computed({
  get: () => route.value.behavior,
  set: (behavior) => updateRoute({ ...route.value, behavior }),
})
const query = ref('')
const statusFilter = ref('all')
const mobileMenu = ref(false)
const dialog = ref<HTMLDialogElement>()
const dialogMode = ref<'create' | 'edit' | 'archive'>('create')
const selected = ref<ServerArchive>()
const saving = ref(false)
const formError = ref('')
const nameInput = ref<HTMLInputElement>()
const dateInput = ref<HTMLInputElement>()
const form = ref({ name: '', description: '', startDate: '', endDate: '' })
let opener: HTMLElement | null = null
const today = () => new Date().toLocaleDateString('sv-SE')
const sections = navigation
const page = computed(() => navigation.find((item) => item.key === view.value)!)
const pageTitle = computed(() => page.value.label)
const featureFinder = ref<InstanceType<typeof FeatureFinder>>()
const menuGroups = computed(() =>
  navigationGroups
    .map((label) => ({
      label,
      items: visibleNavigation(isAdmin.value).filter((item) => item.group === label),
    }))
    .filter((group) => group.items.length),
)
const dateLabel = new Intl.DateTimeFormat('zh-CN', {
  month: 'long',
  day: 'numeric',
  weekday: 'long',
}).format(new Date())
const quickLinks = computed(() =>
  visibleNavigation(isAdmin.value).filter((item) =>
    ['map', 'projects', 'players', 'backups'].includes(item.key),
  ),
)
const scoped = computed(() =>
  scope.value === 'all' ? servers.value : servers.value.filter((s) => s.id === scope.value),
)
const filtered = computed(() =>
  scoped.value.filter(
    (s) =>
      (statusFilter.value === 'all' || s.status === statusFilter.value) &&
      `${s.name} ${s.description}`.toLowerCase().includes(query.value.toLowerCase()),
  ),
)
const recording = computed(() => scoped.value.filter((s) => s.status === 'RECORDING').length)
const archived = computed(() => scoped.value.filter((s) => s.status === 'ARCHIVED').length)
// Alternate the three reference themes and keep them consistent across views.
const serverScene = (id: string) =>
  ['overworld', 'sunset', 'end'][
    Math.max(
      0,
      servers.value.findIndex((server) => server.id === id),
    ) % 3
  ]
const dialogTitle = computed(
  () => ({ create: '添加服务器', edit: '编辑服务器档案', archive: '封存服务器' })[dialogMode.value],
)

function updateRoute(next: WorkspaceRoute, replace = false) {
  if (authenticated.value && !isAdmin.value && restrictedSections.has(next.section))
    next = { ...next, section: 'overview' }
  const href = workspaceHref(next)
  if (href !== window.location.pathname + window.location.search) {
    if (replace) window.history.replaceState(null, '', href)
    else window.history.pushState(null, '', href)
  }
  route.value = next
}
function validScope(next: WorkspaceRoute) {
  return next.scope !== 'all' && !servers.value.some((server) => server.id === next.scope)
    ? { ...next, scope: 'all' }
    : next
}
function restoreRoute() {
  const next = readWorkspaceRoute(new URL(window.location.href))
  const previous = route.value.filters
  if (
    next.filters.fromDate === previous.fromDate &&
    next.filters.toDate === previous.toDate &&
    next.filters.dimension === previous.dimension
  )
    next.filters = previous
  updateRoute(archivesReadAt.value && authenticated.value ? validScope(next) : next, true)
  mobileMenu.value = false
  notice.value = ''
  if (view.value === 'servers' && authenticated.value) void loadCollectors()
}
function navigate(key: WorkspaceSection, nextScope = scope.value) {
  updateRoute({
    ...route.value,
    section: key,
    scope: nextScope,
    player: null,
    behavior: key === view.value && !route.value.player ? behavior.value : { ...defaultBehavior },
  })
  mobileMenu.value = false
  notice.value = ''
  if (key === 'servers') loadCollectors()
  nextTick(() => {
    document.getElementById('main-content')?.focus({ preventScroll: true })
    window.scrollTo({ top: 0, behavior: 'instant' })
  })
}
function findFeature(section: WorkspaceSection, query: string) {
  navigate(section)
  if (section === 'activity' && /聊天|会话/.test(query))
    updateRoute({ ...route.value, behavior: { ...defaultBehavior, mode: 'sessions' } })
}
function showMobileMenu() {
  mobileMenu.value = true
  window.scrollTo({ top: 0, behavior: 'instant' })
  nextTick(() => document.querySelector<HTMLButtonElement>('.mobile-toggle')?.focus())
}
function openPlayer(key: string | null) {
  updateRoute({
    ...route.value,
    section: 'players',
    player: key,
    behavior: key === route.value.player ? behavior.value : { ...defaultBehavior },
  })
  mobileMenu.value = false
  notice.value = ''
}
function searchServer(id: string) {
  navigate('servers', id)
}
function childFailure(ex: unknown) {
  if (ex instanceof ApiError && ex.status === 401) readableError(ex)
}
async function loadCollectors() {
  try {
    collectors.value = await api<CollectorStatus[]>('/collectors')
  } catch (ex) {
    error.value = readableError(ex)
  }
}
function readableError(ex: unknown) {
  if (ex instanceof ApiError && ex.status === 401) {
    authenticated.value = false
    password.value = ''
    loginError.value = ex.message
  }
  return ex instanceof Error
    ? ex instanceof TypeError
      ? '无法连接服务器，请检查服务后重试'
      : ex.message
    : '操作失败，请重试'
}
async function loadServers() {
  loading.value = true
  error.value = ''
  try {
    const [archives, connections] = await Promise.all([
      api<ServerArchive[]>('/servers'),
      api<CollectorStatus[]>('/collectors'),
    ])
    servers.value = archives
    updateRoute(validScope(route.value), true)
    archivesReadAt.value = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    collectors.value = connections
    revision.value++
  } catch (ex) {
    error.value = readableError(ex)
  } finally {
    loading.value = false
  }
}
async function login() {
  loginBusy.value = true
  loginError.value = ''
  loginNotice.value = ''
  try {
    await refreshCsrf()
    await api('/auth/login', {
      method: 'POST',
      body: new URLSearchParams({ username: username.value, password: password.value }),
    })
    password.value = ''
    await refreshCsrf()
    const current = await api<{ username: string; role: 'ADMIN' | 'VIEWER' }>('/auth/me')
    username.value = current.username
    accountRole.value = current.role
    authenticated.value = true
    updateRoute(route.value, true)
    await loadServers()
  } catch (ex) {
    if (ex instanceof ApiError && ex.status === 429) {
      loginError.value = '登录尝试过于频繁，请稍后重试。'
    } else {
      loginError.value =
        ex instanceof ApiError && ex.status === 401
          ? '用户名或密码不正确，请重试'
          : readableError(ex)
    }
  } finally {
    loginBusy.value = false
  }
}
async function logout() {
  try {
    await api('/auth/logout', { method: 'POST' })
    authenticated.value = false
    servers.value = []
    collectors.value = []
    accountRole.value = 'VIEWER'
    archivesReadAt.value = ''
    updateRoute(overviewRoute(), true)
    await refreshCsrf()
  } catch (ex) {
    error.value = readableError(ex)
  }
}
async function passwordChanged() {
  authenticated.value = false
  password.value = ''
  servers.value = []
  collectors.value = []
  loginError.value = ''
  loginNotice.value = '密码已修改，请使用新密码重新登录。'
  try {
    await refreshCsrf()
  } catch {
    loginError.value = '暂时无法连接，请稍后使用新密码登录。'
  }
}
async function openDialog(mode: 'create' | 'edit' | 'archive', server?: ServerArchive) {
  opener = document.activeElement as HTMLElement
  dialogMode.value = mode
  selected.value = server
  formError.value = ''
  form.value = {
    name: server?.name ?? '',
    description: server?.description ?? '',
    startDate: server?.startDate ?? today(),
    endDate: today(),
  }
  await nextTick()
  dialog.value?.showModal()
  await nextTick()
  if (mode === 'archive') dateInput.value?.focus()
  else nameInput.value?.focus()
}
function closeDialog() {
  if (!saving.value) dialog.value?.close()
}
function afterDialogClose() {
  opener?.focus()
}
async function save() {
  saving.value = true
  formError.value = ''
  error.value = ''
  notice.value = ''
  const mode = dialogMode.value
  try {
    const path =
      mode === 'create'
        ? '/servers'
        : `/servers/${selected.value!.id}${mode === 'archive' ? '/archive' : ''}`
    const body =
      mode === 'archive'
        ? { endDate: form.value.endDate }
        : {
            name: form.value.name.trim(),
            description: form.value.description.trim(),
            startDate: form.value.startDate,
          }
    const result = await api<ServerArchive>(path, {
      method: mode === 'edit' ? 'PUT' : 'POST',
      body: JSON.stringify(body),
    })
    const index = servers.value.findIndex((s) => s.id === result.id)
    if (index < 0) servers.value.unshift(result)
    else servers.value[index] = result
    revision.value++
    dialog.value?.close()
    notice.value =
      mode === 'archive'
        ? `「${result.name}」已封存，档案将长期保留`
        : `「${result.name}」${mode === 'create' ? '已添加' : '已保存'}`
    if (mode === 'create') {
      statusFilter.value = 'all'
      query.value = ''
      updateRoute({ ...route.value, section: 'servers', scope: 'all', player: null })
    }
  } catch (ex) {
    formError.value = readableError(ex)
    if (!authenticated.value) dialog.value?.close()
  } finally {
    saving.value = false
  }
}
function inspect(server: ServerArchive) {
  query.value = ''
  statusFilter.value = 'all'
  navigate('servers', server.id)
}
function configureCollector(server: ServerArchive) {
  navigate('settings', server.id)
}
function inspectPlayers(server: ServerArchive) {
  navigate('players', server.id)
}

onMounted(async () => {
  window.addEventListener('popstate', restoreRoute)
  restoreRoute()
  try {
    const current = await api<{ username: string; role: 'ADMIN' | 'VIEWER' }>('/auth/me')
    username.value = current.username
    accountRole.value = current.role
    authenticated.value = true
    updateRoute(route.value, true)
    await refreshCsrf()
    await loadServers()
  } catch (ex) {
    if (!(ex instanceof ApiError && ex.status === 401)) loginError.value = readableError(ex)
  } finally {
    loading.value = false
  }
})
onScopeDispose(() => window.removeEventListener('popstate', restoreRoute))
</script>

<template>
  <div v-if="!authenticated" class="login-page">
    <div class="login-art" aria-hidden="true">
      <div class="world-mark"><Box :size="88" :stroke-width="1" /></div>
      <p>每一段冒险，都值得珍藏。</p>
      <span>MCManager · 服务器纪念档案</span>
    </div>
    <main class="login-card">
      <div class="brand">
        <span class="brand-mark"><Box :size="27" /></span>
        <div><strong>MCManager</strong><small>服务器纪念档案</small></div>
      </div>
      <p class="eyebrow">WELCOME BACK</p>
      <h1>欢迎回来</h1>
      <p class="muted">登录工作台，回看每一期服务器的故事。</p>
      <form @submit.prevent="login">
        <label
          >用户名<input v-model="username" autocomplete="username" required maxlength="80"
        /></label>
        <label
          >密码<input v-model="password" type="password" autocomplete="current-password" required
        /></label>
        <p v-if="loginError" class="alert error" role="alert">{{ loginError }}</p>
        <p v-if="loginNotice" class="alert success" role="status">{{ loginNotice }}</p>
        <button class="primary full" :disabled="loginBusy || loading">
          {{ loginBusy ? '正在登录…' : loading ? '连接中…' : '进入工作台'
          }}<ArrowRight :size="18" />
        </button>
      </form>
      <p class="login-note"><ShieldCheck :size="15" />账号由管理员创建，请联系服主开通</p>
    </main>
  </div>

  <div v-else class="app-shell">
    <a href="#main-content" class="skip-link">跳到主要内容</a>
    <aside class="sidebar" :class="{ expanded: mobileMenu }">
      <a
        class="brand"
        :href="workspaceHref({ ...route, section: 'overview', player: null })"
        @click.prevent="navigate('overview')"
        ><span class="brand-mark reference-brand"><GameIcon kind="grass" /></span>
        <div><strong>MCManager</strong><small>服务器纪念档案</small></div></a
      >
      <button
        class="mobile-toggle icon-button"
        :aria-expanded="mobileMenu"
        aria-controls="navigation"
        aria-label="切换导航"
        @click="mobileMenu = !mobileMenu"
      >
        <X v-if="mobileMenu" :size="22" /><Menu v-else :size="22" />
      </button>
      <nav id="navigation" aria-label="主导航" @keydown.esc="mobileMenu = false">
        <div v-for="group in menuGroups" :key="group.label" class="nav-group">
          <p class="nav-group-label">{{ group.label }}</p>
          <button
            v-for="section in group.items"
            :key="section.key"
            :class="{ active: view === section.key }"
            :aria-current="view === section.key ? 'page' : undefined"
            @click="navigate(section.key)"
          >
            <component :is="section.icon" :size="19" />{{ section.label }}
          </button>
        </div>
      </nav>
      <div class="sidebar-landscape" aria-hidden="true"></div>
      <p class="sidebar-signoff">每一个世界，都有故事 <Leaf :size="13" /></p>
    </aside>
    <div class="workspace">
      <WorkspaceHeader
        v-model:scope="scope"
        :servers="servers"
        :title="pageTitle"
        :username="username"
        :role="accountRole"
        @password="passwordDialog?.open()"
        @find="featureFinder?.open()"
        @logout="logout"
        @server="searchServer"
        @player="openPlayer"
        @error="childFailure"
      />
      <main
        id="main-content"
        :class="{ 'reference-overview': view === 'overview' }"
        :data-section="view"
        tabindex="-1"
      >
        <div class="page-heading" :class="{ 'overview-heading': view === 'overview' }">
          <div class="page-title-row">
            <span class="page-emblem"
              ><GameIcon v-if="view === 'overview'" kind="grass" /><component
                v-else
                :is="page.icon"
                :size="28"
            /></span>
            <div>
              <p class="eyebrow">
                {{ page.group }} <span v-if="view === 'overview'">· 数据总览</span>
              </p>
              <h1>{{ view === 'overview' ? '今天的方块世界' : pageTitle }}</h1>
              <p class="muted">{{ page.description }}</p>
            </div>
          </div>
          <span v-if="view === 'overview'" class="today-chip"
            ><CalendarDays :size="17" />{{ dateLabel }}</span
          >
          <button
            v-if="view === 'servers' && isAdmin"
            class="primary"
            @click="openDialog('create')"
          >
            <Plus :size="19" />添加服务器
          </button>
        </div>
        <section
          v-if="view === 'overview'"
          class="adventure-hero"
          aria-labelledby="adventure-title"
        >
          <div class="hero-copy">
            <span class="hero-label">和伙伴们，一起创造</span>
            <h2 id="adventure-title">每一段冒险，都值得珍藏</h2>
            <div class="hero-actions">
              <button class="primary" @click="navigate('map')">
                <MapIcon :size="20" />打开世界地图<ArrowRight :size="17" /></button
              ><button class="secondary" @click="navigate('projects')">
                <Box :size="20" />查看施工工程<ArrowRight :size="17" />
              </button>
            </div>
          </div>
        </section>
        <div v-if="view !== 'overview'" class="page-context">
          <span
            ><Server :size="15" />{{
              scope === 'all' ? '当前查看所有服务器' : servers.find((s) => s.id === scope)?.name
            }}</span
          ><button class="text-button" @click="featureFinder?.open()">
            <Search :size="16" />找不到功能？查找入口
          </button>
        </div>
        <p v-if="notice" class="alert success" role="status"><Check :size="18" />{{ notice }}</p>
        <div v-if="error" class="alert error" role="alert">
          {{ error }}<button class="text-button" @click="loadServers">重新加载</button>
        </div>

        <StatisticsWorkspace
          v-if="['overview', 'players', 'activity'].includes(view)"
          v-model:filters="filters"
          v-model:behavior="behavior"
          :view="view"
          :player="route.player"
          :scope="scope"
          :revision="revision"
          :servers="scoped"
          @player="openPlayer"
          @error="childFailure"
        >
          <template #beside-trend
            ><OverviewCompanion
              :scope="scope"
              :servers="scoped"
              :revision="revision"
              @open="navigate('runtime', $event)"
          /></template>
          <template #after-metrics>
            <OverviewProjects
              :scope="scope"
              :servers="scoped"
              :revision="revision"
              @open="navigate('projects')"
            />
            <section class="quick-destinations" aria-label="常用入口">
              <button v-for="item in quickLinks" :key="item.key" @click="navigate(item.key)">
                <component :is="item.icon" :size="22" /><span
                  ><strong>{{ item.label }}</strong
                  ><small>{{ item.description }}</small></span
                ><ArrowRight :size="18" />
              </button>
            </section>
            <section class="overview-bottom">
              <article class="panel">
                <div class="panel-heading">
                  <div>
                    <h2>服务器档案</h2>
                    <p>珍藏每一期的故事</p>
                  </div>
                  <button
                    v-if="isAdmin"
                    class="icon-button"
                    aria-label="添加服务器"
                    title="添加服务器"
                    @click="openDialog('create')"
                  >
                    <Plus :size="17" />
                  </button>
                  <button class="text-button" @click="navigate('servers')">
                    查看全部<ArrowRight :size="15" />
                  </button>
                </div>
                <div v-if="!scoped.length" class="small-empty">
                  <span class="empty-icon"><Server :size="28" /></span>
                  <h3>
                    {{
                      loading
                        ? '正在加载档案…'
                        : error
                          ? '档案暂时无法加载'
                          : '从你的第一个世界开始'
                    }}
                  </h3>
                  <p>
                    {{
                      error ? '恢复连接后，请重新加载。' : '添加一期服务器，为它建立专属纪念档案。'
                    }}
                  </p>
                  <button
                    v-if="isAdmin && !loading && !error"
                    class="secondary"
                    @click="openDialog('create')"
                  >
                    <Plus :size="16" />添加服务器
                  </button>
                </div>
                <div v-else class="world-preview-grid">
                  <WorldPreviewCard
                    v-for="server in scoped.slice(0, 3)"
                    :key="server.id"
                    :server="server"
                    :scene="serverScene(server.id)"
                    :revision="revision"
                    @select="inspect(server)"
                    @error="childFailure"
                  />
                </div>
              </article>
              <RecentUpdates
                v-if="isAdmin"
                :servers="servers"
                :scope="scope"
                :revision="revision"
                @open="navigate"
                @error="childFailure"
              />
              <article v-else class="panel">
                <div class="panel-heading"><h2>只读查看</h2></div>
                <p class="muted">
                  你可以查看全部服务器的统计、聊天记录、地图、工程、日报与运行状况。需要修改数据时，请联系管理员。
                </p>
              </article>
            </section>
            <div class="overview-status-strip">
              <span
                ><i :class="{ unavailable: error }"></i
                >{{ error ? '档案服务暂不可读' : '档案服务已连接'
                }}<small>{{ scoped.length }} 个档案 · {{ recording }} 个记录中</small></span
              ><span>最近读取：{{ archivesReadAt || '尚未确认' }}</span>
            </div>
          </template>
        </StatisticsWorkspace>

        <template v-else-if="view === 'servers'">
          <section class="panel archive-panel">
            <div class="archive-toolbar">
              <div class="search-field">
                <Search :size="18" /><input
                  v-model="query"
                  type="search"
                  aria-label="搜索服务器"
                  placeholder="搜索名称或介绍…"
                />
              </div>
              <select v-model="statusFilter" aria-label="档案状态">
                <option value="all">全部状态</option>
                <option value="RECORDING">记录中</option>
                <option value="ARCHIVED">已封存</option></select
              ><span class="result-count">{{ filtered.length }} 份档案</span>
            </div>
            <div v-if="loading" class="small-empty" role="status">正在加载档案…</div>
            <div v-else-if="!filtered.length" class="small-empty">
              <span class="empty-icon"><Archive :size="32" /></span>
              <h3>
                {{
                  error
                    ? '档案暂时无法加载'
                    : servers.length
                      ? '没有符合条件的档案'
                      : '还没有服务器档案'
                }}
              </h3>
              <p>
                {{
                  error
                    ? '恢复连接后，请重新加载。'
                    : servers.length
                      ? '试试调整搜索、范围或状态。'
                      : '添加第一期服务器，开始记录你的世界。'
                }}
              </p>
              <button
                v-if="isAdmin && !servers.length && !error"
                class="secondary"
                @click="openDialog('create')"
              >
                <Plus :size="16" />添加服务器
              </button>
            </div>
            <div v-else class="server-grid">
              <article v-for="server in filtered" :key="server.id" class="server-card">
                <div
                  class="archive-cover world-cover"
                  :class="'scene-' + serverScene(server.id)"
                  aria-hidden="true"
                ></div>
                <div class="server-card-top">
                  <span class="server-icon"><Box :size="28" /></span
                  ><span class="status" :class="server.status.toLowerCase()">{{
                    server.status === 'RECORDING' ? '记录中' : '已封存'
                  }}</span>
                </div>
                <h2>{{ server.name }}</h2>
                <p class="server-description">
                  {{ server.description || '尚未添加介绍，为这个世界留下几句话吧。' }}
                </p>
                <p class="date-line">
                  <CalendarDays :size="15" />{{ server.startDate }} — {{ server.endDate ?? '至今' }}
                </p>
                <dl class="server-details">
                  <div>
                    <dt>采集器</dt>
                    <dd>
                      {{
                        connectionNames[
                          collectorMap.get(server.id)?.connectionState ?? 'UNCONNECTED'
                        ]
                      }}
                    </dd>
                  </div>
                  <div>
                    <dt>玩家统计</dt>
                    <dd>
                      <button class="text-button" @click="inspectPlayers(server)">查看玩家</button>
                    </dd>
                  </div>
                </dl>
                <details>
                  <summary>档案标识</summary>
                  <code>{{ server.id }}</code>
                </details>
                <div v-if="isAdmin" class="server-actions">
                  <button
                    class="secondary"
                    @click="updateRoute({ ...route, section: 'console', scope: server.id })"
                  >
                    <Terminal :size="16" />控制台
                  </button>
                  <button class="text-button" @click="configureCollector(server)">配置采集</button>
                  <button class="secondary" @click="openDialog('edit', server)">编辑档案</button
                  ><button
                    v-if="server.status === 'RECORDING'"
                    class="text-button"
                    :aria-label="`封存 ${server.name}`"
                    @click="openDialog('archive', server)"
                  >
                    <Archive :size="16" />封存</button
                  ><span v-else class="preserved"><ShieldCheck :size="15" />历史长期保留</span>
                </div>
              </article>
            </div>
          </section>
          <p class="section-footnote">
            <ShieldCheck
              :size="15"
            />每份档案对应独立的一期服务器。封存不会移除历史，也不会生成游戏文件备份。
          </p>
        </template>

        <ProjectsView
          v-else-if="view === 'projects'"
          :scope="scope"
          :servers="servers"
          :readonly="!isAdmin"
        />
        <AccountsView
          v-else-if="view === 'accounts' && isAdmin"
          :username="username"
          @error="childFailure"
        />
        <ExplorationView v-else-if="view === 'exploration'" :scope="scope" :servers="servers" />
        <DailyReportsView
          v-else-if="view === 'reports'"
          :scope="scope"
          :servers="servers"
          @select="scope = $event"
        />
        <ServerRuntimeView
          v-else-if="view === 'runtime'"
          :scope="scope"
          :servers="servers"
          @select="scope = $event"
        />
        <ServerConsoleView
          v-else-if="view === 'console'"
          :scope="scope"
          :servers="servers"
          @select="scope = $event"
          @error="childFailure"
        />
        <WorldMapView
          v-else-if="view === 'map'"
          :scope="scope"
          :revision="revision"
          @error="childFailure"
        />
        <AgentsView
          v-else-if="view === 'agents'"
          :scope="scope"
          :revision="revision"
          :servers="servers"
          @error="childFailure"
        />
        <CollectorsView
          v-else-if="view === 'settings'"
          :scope="scope"
          :revision="revision"
          @error="childFailure"
        />
        <BackupsView
          v-else-if="view === 'backups'"
          :servers="servers"
          :scope="scope"
          :revision="revision"
          @error="childFailure"
          @archives-changed="loadServers"
        />
        <footer>
          <span
            >{{ scoped.length }} 个服务器档案 · {{ recording }} 个记录中 ·
            {{ archived }} 个已封存</span
          ><span><Leaf :size="13" />每一个世界，都有故事</span>
        </footer>
      </main>
    </div>

    <nav class="mobile-dock" aria-label="手机快捷导航">
      <button
        v-for="item in sections.filter((s) =>
          ['overview', 'map', 'projects', 'players'].includes(s.key),
        )"
        :key="item.key"
        :class="{ active: view === item.key }"
        :aria-label="'打开' + item.label"
        :aria-current="view === item.key ? 'page' : undefined"
        @click="navigate(item.key)"
      >
        <component :is="item.icon" :size="20" /><span>{{
          { overview: '总览', map: '地图', projects: '工程', players: '玩家' }[
            item.key as 'overview'
          ]
        }}</span></button
      ><button aria-label="打开全部功能" @click="showMobileMenu">
        <Menu :size="20" /><span>全部</span>
      </button>
    </nav>
    <FeatureFinder ref="featureFinder" :admin="isAdmin" @select="findFeature" />
    <PasswordDialog ref="passwordDialog" @changed="passwordChanged" @error="childFailure" />
    <dialog
      ref="dialog"
      aria-labelledby="dialog-title"
      @cancel="saving ? $event.preventDefault() : undefined"
      @close="afterDialogClose"
    >
      <form @submit.prevent="save">
        <div class="dialog-heading">
          <div>
            <p class="eyebrow">SERVER ARCHIVE</p>
            <h2 id="dialog-title">{{ dialogTitle }}</h2>
          </div>
          <button
            type="button"
            class="icon-button"
            aria-label="关闭对话框"
            :disabled="saving"
            @click="closeDialog"
          >
            <X :size="21" />
          </button>
        </div>
        <template v-if="dialogMode === 'archive'"
          ><p class="dialog-description">
            结束「{{
              selected?.name
            }}」这一期的记录。封存后，档案和历史统计仍会保留在所有服务器范围中。
          </p>
          <p class="alert info">此操作只封存平台档案，不会停止游戏服务器或创建最终备份。</p>
          <label
            >结束日期<input
              ref="dateInput"
              v-model="form.endDate"
              type="date"
              required
              :min="selected?.startDate" /></label
        ></template>
        <template v-else
          ><label
            >服务器名称 <span class="required">*</span
            ><input
              ref="nameInput"
              v-model="form.name"
              required
              maxlength="80"
              placeholder="例如：秋日生存服 · 第一周目" /></label
          ><label
            >开服日期 <span class="required">*</span
            ><input
              v-model="form.startDate"
              type="date"
              required
              :max="selected?.endDate ?? undefined" /></label
          ><label
            >服务器介绍<textarea
              v-model="form.description"
              maxlength="2000"
              rows="4"
              placeholder="记录这一期的玩法、伙伴，或一段值得珍藏的回忆。"
            ></textarea
            ><span class="field-hint">{{ form.description.length }} / 2000</span></label
          >
          <p v-if="dialogMode === 'create'" class="field-note">
            保存后会生成独立档案标识，后续可连接对应的采集插件。
          </p></template
        >
        <p v-if="formError" class="alert error" role="alert">{{ formError }}</p>
        <div class="dialog-actions">
          <button type="button" class="secondary" :disabled="saving" @click="closeDialog">
            取消</button
          ><button
            class="primary"
            :disabled="saving || (dialogMode !== 'archive' && !form.name.trim())"
          >
            {{
              saving
                ? '保存中…'
                : dialogMode === 'archive'
                  ? '确认封存'
                  : dialogMode === 'create'
                    ? '创建档案'
                    : '保存修改'
            }}
          </button>
        </div>
      </form>
    </dialog>
  </div>
</template>
