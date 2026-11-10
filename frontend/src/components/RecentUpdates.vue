<script setup lang="ts">
import { t } from '../i18n'

import { computed } from 'vue'
import { ArrowRight, Archive, HardDrive, Server } from '@lucide/vue'
import { api, type ServerArchive } from '../api'
import { displayTime, query } from '../statistics'
import { useResource } from '../useResource'
const props = defineProps<{ servers: ServerArchive[]; scope: string; revision: number }>()
const emit = defineEmits<{ open: [view: 'servers' | 'backups']; error: [error: unknown] }>()
interface BackupUpdate {
  id: string
  serverId: string
  createdAt: string
  status: string
}
const { data, busy, error, refresh } = useResource(
  () => [props.scope, props.revision],
  (signal) =>
    api<{ items: BackupUpdate[] }>('/backups' + query(props.scope, undefined, { size: 4 }), {
      signal,
    }),
  (error) => emit('error', error),
)
const states: Record<string, string> = {
  READY: t('m1117'),
  AWAITING_UPLOAD: t('m0424'),
  RECEIVING: t('m0425'),
  VERIFYING: t('m0426'),
  FAILED: t('m0428'),
  MISSING: t('m0429'),
  DELETING: t('m0430'),
  DELETED: t('m0431'),
}
const updates = computed(() => {
  const archives = props.servers
    .filter((server) => props.scope === 'all' || server.id === props.scope)
    .map((server) => ({
      id: server.id,
      at: server.updatedAt,
      title: t('m1118'),
      detail: server.name,
      state: server.status === 'ARCHIVED' ? t('m0064') : t('m0063'),
      view: 'servers',
      icon: server.status === 'ARCHIVED' ? Archive : Server,
      color: server.status === 'ARCHIVED' ? 'violet' : 'blue',
      timeLabel: t('m1119'),
    }))
  const backups = (data.value?.items ?? []).map((backup) => ({
    id: backup.id,
    at: backup.createdAt,
    title: t('m1120'),
    detail: props.servers.find((server) => server.id === backup.serverId)?.name ?? t('m0044'),
    state: states[backup.status] ?? t('m0837'),
    view: 'backups',
    icon: HardDrive,
    color: 'orange',
    timeLabel: t('m1121'),
  }))
  return [...archives, ...backups].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 4)
})
function age(at: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(at)) / 60000))
  if (minutes < 1) return t('m1122')
  if (minutes < 60) return minutes + t('m1123')
  if (minutes < 1440) return Math.floor(minutes / 60) + t('m1124')
  return Math.floor(minutes / 1440) + t('m1125')
}
</script>
<template>
  <article class="panel updates-panel" :aria-label="t('m1126')">
    <div class="panel-heading">
      <div>
        <h2>{{ t('m1126') }}</h2>
        <p>{{ t('m1127') }}</p>
      </div>
      <button class="text-button" @click="refresh" :disabled="busy">{{ t('m0331') }}</button>
    </div>
    <p v-if="error" class="updates-note" role="alert">
      {{ error }}<button class="text-button" @click="refresh">{{ t('m0337') }}</button>
    </p>
    <p v-else-if="busy" class="updates-note" role="status">{{ t('m1128') }}</p>
    <div v-if="updates.length" class="updates-list">
      <button
        v-for="item in updates"
        :key="item.id"
        class="update-item"
        :class="item.color"
        @click="emit('open', item.view)"
      >
        <span class="update-icon"><component :is="item.icon" :size="19" /></span>
        <span class="update-copy"
          ><strong>{{ item.title }}</strong
          ><span>{{ item.detail }} · {{ item.state }}</span></span
        >
        <small class="update-time" :title="item.timeLabel + ' ' + displayTime(item.at)">{{
          age(item.at)
        }}</small>
      </button>
    </div>
    <p v-else-if="!busy && !error" class="updates-note">{{ t('m1129') }}</p>
    <button class="updates-footer text-button" @click="emit('open', 'backups')">{{ t('m1130') }}<ArrowRight :size="15" />
    </button>
  </article>
</template>
