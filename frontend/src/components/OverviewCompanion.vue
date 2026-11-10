<script setup lang="ts">
import { computed } from 'vue'
import { Activity, ArrowRight, Server } from '@lucide/vue'
import { api, type ServerArchive } from '../api'
import { useResource } from '../useResource'
const props = defineProps<{ scope: string; servers: ServerArchive[]; revision: number }>()
const emit = defineEmits<{ open: [server: string] }>()
const server = computed(
  () =>
    props.servers.find((s) => s.id === props.scope) ??
    props.servers.find((s) => s.status === 'RECORDING') ??
    props.servers[0],
)
interface Runtime {
  state: string
  latest: {
    at: string
    hostCpuPercent: number | null
    cpuPercent: number | null
    hostMemoryTotalBytes: number | null
    hostMemoryAvailableBytes: number | null
  } | null
}
// One snapshot for the selected/first recording server. No dashboard polling or fleet-wide fanout.
const { data, busy, error, refresh } = useResource(
  () => [server.value?.id, props.revision],
  (signal) =>
    server.value
      ? api<Runtime>(`/servers/${server.value.id}/runtime?hours=1`, { signal })
      : Promise.resolve(null),
  () => {},
)
const fresh = computed(
  () => !error.value && ['HEALTHY', 'SLOW', 'TICK_STALLED'].includes(data.value?.state ?? ''),
)
const state = computed(() =>
  busy.value
    ? '正在读取'
    : error.value
      ? '暂时无法读取'
      : ({
          HEALTHY: '运行流畅',
          SLOW: '流畅度下降',
          TICK_STALLED: '游戏暂停推进',
          STALE: '数据已中断',
          STOPPED: '采集已停止',
          NO_DATA: '等待首次采集',
        }[data.value?.state ?? 'NO_DATA'] ?? '状态待确认'),
)
const bars = computed(() => {
  const last = data.value?.latest
  return [
    { name: '主机 CPU', value: last?.hostCpuPercent },
    {
      name: '主机内存',
      value:
        last?.hostMemoryTotalBytes && last.hostMemoryAvailableBytes != null
          ? (1 - last.hostMemoryAvailableBytes / last.hostMemoryTotalBytes) * 100
          : null,
    },
    { name: '游戏进程 CPU', value: last?.cpuPercent },
  ]
})
</script>
<template>
  <article class="panel dashboard-runtime">
    <div class="panel-heading">
      <h2><Activity :size="20" />服务器运行状况</h2>
      <span class="status" :class="fresh && data?.state === 'HEALTHY' ? 'recording' : 'archived'">{{
        state
      }}</span>
    </div>
    <div class="dashboard-runtime-body">
      <p class="runtime-server-name"><Server :size="15" />{{ server?.name ?? '还没有服务器' }}</p>
      <p v-if="scope === 'all' && servers.length > 1" class="data-note">
        首页展示这台服务器，其余主机可进入运行状况查看。
      </p>
      <div v-for="bar in bars" :key="bar.name" class="runtime-meter">
        <span>{{ bar.name }}</span>
        <div class="meter-track">
          <i
            :style="{
              width: (fresh && bar.value != null ? Math.min(100, Math.max(0, bar.value)) : 0) + '%',
            }"
          ></i>
        </div>
        <strong>{{ fresh && bar.value != null ? bar.value.toFixed(0) + '%' : '—' }}</strong>
      </div>
      <p class="runtime-snapshot-note">
        {{
          data?.latest
            ? '最近采样：' + new Date(data.latest.at).toLocaleString('zh-CN', { hour12: false })
            : '连接游戏插件后，主机状态会显示在这里。'
        }}
      </p>
      <div class="runtime-card-actions">
        <button class="text-button" :disabled="busy || !server" @click="refresh">刷新快照</button
        ><button class="text-button" :disabled="!server" @click="emit('open', server!.id)">
          查看运行详情<ArrowRight :size="15" />
        </button>
      </div>
    </div>
  </article>
</template>
