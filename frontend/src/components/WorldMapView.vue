<script setup lang="ts">
import { t, localizedUrl } from '../i18n'

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
        <h2><Map :size="20" />{{ t('m0186') }}</h2>
        <p>{{ t('m1530') }}</p>
      </div>
      <div class="map-actions">
        <select v-if="scope === 'all' && data?.length" v-model="selected" :aria-label="t('m1531')">
          <option v-for="map in data" :key="map.serverId" :value="map.serverId">
            {{ map.serverName }}{{ map.configured ? '' : t('m1532') }}
          </option>
        </select>
        <button class="secondary" :disabled="busy" @click="reload">
          <RefreshCw :size="16" />{{ t('m1533') }}</button>
        <a
          v-if="current?.viewerUrl"
          class="secondary map-open"
          :href="localizedUrl(current.viewerUrl)"
          target="_blank"
          rel="noopener noreferrer"
        >
          <ExternalLink :size="16" />{{ t('m1534') }}</a>
      </div>
    </div>
    <p v-if="error" class="alert error" role="alert">{{ error }}</p>
    <p v-else-if="busy && !data" class="small-empty" role="status">{{ t('m1535') }}</p>
    <template v-else-if="current?.configured && current.viewerUrl">
      <iframe
        :key="current.serverId + ':' + frameRevision"
        :src="localizedUrl(current.viewerUrl)"
        :title="current.serverName + t('m0186')"
        class="world-map-frame"
      />
      <p class="map-note">{{ t('m1536') }}</p>
    </template>
    <div v-else class="map-empty">
      <Map :size="42" />
      <h3>{{ current ? t('m1537') : t('m1538') }}</h3>
      <p>{{ t('m1539') }}</p>
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
