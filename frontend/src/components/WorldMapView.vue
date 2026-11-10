<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ExternalLink, Map, RefreshCw } from '@lucide/vue'
import { api } from '../api'
import { useResource } from '../useResource'

interface MapInfo {
  serverId: string
  serverName: string
  configured: boolean
  viewerUrl: string | null
}
const props = defineProps<{ scope: string; revision: number }>()
const emit = defineEmits<{ error: [error: unknown] }>()
const selected = ref('')
const frameRevision = ref(0)
const { data, error, busy, refresh } = useResource(
  () => [props.revision],
  (signal) => api<MapInfo[]>('/world-maps', { signal }),
  (error) => emit('error', error),
)
watch(
  () => [props.scope, data.value] as const,
  () => {
    if (props.scope !== 'all') selected.value = props.scope
    else if (!data.value?.some((map) => map.serverId === selected.value))
      selected.value =
        data.value?.find((map) => map.configured)?.serverId ?? data.value?.[0]?.serverId ?? ''
  },
  { immediate: true },
)
const current = computed(() => data.value?.find((map) => map.serverId === selected.value))
function reload() {
  frameRevision.value++
  void refresh()
}
</script>

<template>
  <section class="panel world-map-workspace">
    <div class="data-panel-heading">
      <div>
        <h2><Map :size="20" />世界地图</h2>
        <p>拖动探索世界，切换维度，或在地图里输入坐标前往目的地。</p>
      </div>
      <div class="map-actions">
        <select v-if="scope === 'all' && data?.length" v-model="selected" aria-label="地图服务器">
          <option v-for="map in data" :key="map.serverId" :value="map.serverId">
            {{ map.serverName }}{{ map.configured ? '' : ' · 未连接地图' }}
          </option>
        </select>
        <button class="secondary" :disabled="busy" @click="reload">
          <RefreshCw :size="16" />刷新地图
        </button>
        <a
          v-if="current?.viewerUrl"
          class="secondary map-open"
          :href="current.viewerUrl"
          target="_blank"
          rel="noopener noreferrer"
        >
          <ExternalLink :size="16" />独立打开
        </a>
      </div>
    </div>
    <p v-if="error" class="alert error" role="alert">{{ error }}</p>
    <p v-else-if="busy && !data" class="small-empty" role="status">正在连接地图…</p>
    <template v-else-if="current?.configured && current.viewerUrl">
      <iframe
        :key="current.serverId + ':' + frameRevision"
        :src="current.viewerUrl"
        :title="current.serverName + '世界地图'"
        class="world-map-frame"
      />
      <p class="map-note">
        独立地图链接可直接分享，无需登录。 地图功能与更新规则沿用原版 MipMap；游戏内可使用 /loadmap
        批量绘制指定区域。
      </p>
    </template>
    <div v-else class="map-empty">
      <Map :size="42" />
      <h3>{{ current ? '这台服务器尚未连接地图' : '先添加服务器档案' }}</h3>
      <p>请先为这台游戏服连接地图服务。连接完成后，玩家探索过的地形会显示在这里。</p>
    </div>
  </section>
</template>

<style scoped>
.world-map-workspace {
  min-width: 0;
  overflow: hidden;
}
h2,
.map-actions,
.map-open {
  display: flex;
  align-items: center;
  gap: 8px;
}
.map-actions {
  flex-wrap: wrap;
}
.map-actions select {
  width: auto;
  max-width: 260px;
}
.map-open {
  min-height: 42px;
  padding: 9px 14px;
  font-weight: 600;
}
.world-map-frame {
  display: block;
  width: 100%;
  height: min(75vh, 840px);
  min-height: 480px;
  border: 0;
  border-block: 1px solid #dce9e1;
}
.map-note {
  padding: 14px 22px;
  color: #667e71;
  font-size: 12px;
  line-height: 1.8;
}
.map-empty {
  min-height: 360px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 14px;
  padding: 32px;
  color: #5e7d6b;
}
.map-empty p {
  max-width: 440px;
  line-height: 1.8;
}
@media (max-width: 600px) {
  .map-actions {
    width: 100%;
  }
  .map-actions select {
    width: 100%;
    max-width: none;
  }
  .world-map-frame {
    min-height: 560px;
  }
  .map-note {
    padding: 14px 16px;
  }
}
</style>
