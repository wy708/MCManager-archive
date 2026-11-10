<script setup lang="ts">
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
  READY: '文件已校验',
  AWAITING_UPLOAD: '等待上传',
  RECEIVING: '上传中',
  VERIFYING: '校验中',
  FAILED: '未完成',
  MISSING: '文件不可用',
  DELETING: '删除未完成',
  DELETED: '已删除',
}
const updates = computed(() => {
  const archives = props.servers
    .filter((server) => props.scope === 'all' || server.id === props.scope)
    .map((server) => ({
      id: server.id,
      at: server.updatedAt,
      title: '服务器档案更新',
      detail: server.name,
      state: server.status === 'ARCHIVED' ? '已封存' : '记录中',
      view: 'servers',
      icon: server.status === 'ARCHIVED' ? Archive : Server,
      color: server.status === 'ARCHIVED' ? 'violet' : 'blue',
      timeLabel: '更新于',
    }))
  const backups = (data.value?.items ?? []).map((backup) => ({
    id: backup.id,
    at: backup.createdAt,
    title: '完整备份记录',
    detail: props.servers.find((server) => server.id === backup.serverId)?.name ?? '服务器档案',
    state: states[backup.status] ?? '状态待确认',
    view: 'backups',
    icon: HardDrive,
    color: 'orange',
    timeLabel: '创建于',
  }))
  return [...archives, ...backups].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 4)
})
function age(at: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(at)) / 60000))
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return minutes + ' 分钟前'
  if (minutes < 1440) return Math.floor(minutes / 60) + ' 小时前'
  return Math.floor(minutes / 1440) + ' 天前'
}
</script>
<template>
  <article class="panel updates-panel" aria-label="最近动态">
    <div class="panel-heading">
      <div>
        <h2>最近动态</h2>
        <p>档案更新与备份记录</p>
      </div>
      <button class="text-button" @click="refresh" :disabled="busy">刷新</button>
    </div>
    <p v-if="error" class="updates-note" role="alert">
      {{ error }}<button class="text-button" @click="refresh">重试</button>
    </p>
    <p v-else-if="busy" class="updates-note" role="status">正在读取备份记录…</p>
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
    <p v-else-if="!busy && !error" class="updates-note">还没有动态，从记录第一个世界开始。</p>
    <button class="updates-footer text-button" @click="emit('open', 'backups')">
      前往备份中心<ArrowRight :size="15" />
    </button>
  </article>
</template>
