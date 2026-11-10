<script setup lang="ts">
import LanguageSwitcher from './LanguageSwitcher.vue'
import { t } from '../i18n'

import { computed, onMounted, onScopeDispose, ref, watch } from 'vue'
import {
  Home,
  Layers,
  Search,
  ChevronDown,
  LogOut,
  Users,
  Server,
  KeyRound,
  Compass,
} from '@lucide/vue'
import GameIcon from './GameIcon.vue'
import { api, type ServerArchive } from '../api'
import { failure, query, type PlayerRow, type Page } from '../statistics'
const props = defineProps<{
  servers: ServerArchive[]
  scope: string
  title: string
  username: string
  role?: 'ADMIN' | 'VIEWER'
}>()
const emit = defineEmits<{
  'update:scope': [value: string]
  find: []
  logout: []
  password: []
  server: [id: string]
  player: [key: string]
  error: [error: unknown]
}>()
const draft = ref(''),
  searched = ref(''),
  players = ref<PlayerRow[]>([]),
  busy = ref(false),
  error = ref(''),
  expanded = ref(false)
const root = ref<HTMLElement>(),
  account = ref<HTMLDetailsElement>()
let sequence = 0,
  controller: AbortController | undefined
const matches = computed(() =>
  props.servers
    .filter(
      (server) =>
        (props.scope === 'all' || props.scope === server.id) &&
        server.name.toLocaleLowerCase().includes(searched.value.toLocaleLowerCase()),
    )
    .slice(0, 5),
)
async function search() {
  const text = draft.value.trim()
  if (!text) {
    expanded.value = false
    return
  }
  const current = ++sequence
  controller?.abort()
  controller = new AbortController()
  searched.value = text
  players.value = []
  error.value = ''
  busy.value = true
  expanded.value = true
  try {
    const data = await api<Page<PlayerRow>>(
      '/players' + query(props.scope, undefined, { search: text, page: 1, pageSize: 5 }),
      { signal: controller.signal },
    )
    if (current === sequence) players.value = data.items
  } catch (ex) {
    if (current === sequence && !(ex instanceof DOMException && ex.name === 'AbortError')) {
      error.value = failure(ex)
      emit('error', ex)
    }
  } finally {
    if (current === sequence) busy.value = false
  }
}
function close() {
  expanded.value = false
  if (account.value) account.value.open = false
}
function chooseServer(id: string) {
  close()
  emit('server', id)
}
function choosePlayer(key: string) {
  close()
  emit('player', key)
}
function changePassword() {
  close()
  emit('password')
}
function outside(event: PointerEvent) {
  if (!root.value?.contains(event.target as Node)) close()
}
watch(
  () => props.scope,
  () => {
    sequence++
    controller?.abort()
    close()
    players.value = []
    busy.value = false
  },
)
onMounted(() => document.addEventListener('pointerdown', outside))
onScopeDispose(() => {
  sequence++
  controller?.abort()
  document.removeEventListener('pointerdown', outside)
})
</script>
<template>
  <header ref="root" class="topbar reference-topbar" @keydown.esc="close">
    <div class="breadcrumb">
      <Home :size="21" /><span class="breadcrumb-root">{{ t('m1478') }}</span><span>/</span
      ><strong>{{ title }}</strong>
    </div>
    <div class="topbar-tools">
      <LanguageSwitcher />
      <button class="feature-trigger secondary" :aria-label="t('m1479')" @click="emit('find')">
        <Compass :size="18" /><span>{{ t('m1479') }}</span>
      </button>
      <label class="scope-label"
        ><div class="select-wrap">
          <Layers :size="16" class="scope-icon" /><select
            :value="scope"
            :aria-label="t('m1480')"
            @change="emit('update:scope', ($event.target as HTMLSelectElement).value)"
          >
            <option value="all">{{ t('m1481') }}</option>
            <option v-for="server in servers" :key="server.id" :value="server.id">
              {{ server.name }}{{ server.status === 'ARCHIVED' ? t('m1482') : '' }}
            </option></select
          ><ChevronDown :size="15" /></div
      ></label>
      <div class="global-search">
        <form role="search" @submit.prevent="search">
          <button :aria-label="t('m1483')" type="submit"><Search :size="19" /></button
          ><input
            v-model="draft"
            :aria-label="t('m1484')"
            :placeholder="t('m1485')"
            maxlength="80"
            type="search"
            @input="expanded = false"
          />
        </form>
        <div v-if="expanded" class="search-results" :aria-label="t('m1486')">
          <p class="search-caption">{{ t('m1487', [searched]) }}</p>
          <button
            v-for="server in matches"
            :key="server.id"
            class="search-result"
            @click="chooseServer(server.id)"
          >
            <Server :size="17" /><span>{{ server.name }}<small>{{ t('m0044') }}</small></span>
          </button>
          <p v-if="busy" class="search-caption" role="status">{{ t('m1488') }}</p>
          <p v-if="error" class="search-caption" role="alert">{{ error }}</p>
          <button
            v-for="player in players"
            :key="player.key"
            class="search-result"
            @click="choosePlayer(player.key)"
          >
            <Users :size="17" /><span
              >{{ player.name }}<small>{{ t('m1489', [player.key]) }}</small></span
            >
          </button>
          <p v-if="!busy && !error && !matches.length && !players.length" class="search-caption">{{ t('m1490') }}</p>
        </div>
      </div>
      <details ref="account" class="account-menu">
        <summary :aria-label="role === 'VIEWER' ? t('m1491') : t('m1492')">
          <span class="reference-avatar" aria-hidden="true"><GameIcon kind="player" /></span
          ><span class="account-label">{{ role === 'VIEWER' ? t('m0296') : t('m0297') }}</span
          ><ChevronDown :size="14" />
        </summary>
        <div class="account-dropdown">
          <p>{{ username }} · {{ role === 'VIEWER' ? t('m0296') : t('m0297') }}</p>
          <button @click="changePassword">
            <KeyRound :size="16" />{{ t('m0873') }}</button>
          <button @click="emit('logout')"><LogOut :size="16" />{{ t('m1493') }}</button>
        </div>
      </details>
    </div>
  </header>
</template>
