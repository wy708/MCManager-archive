<script setup lang="ts">
import LanguageSwitcher from './LanguageSwitcher.vue'
import { formatLocale, systemMessage, t } from '../i18n'

import { ref, computed, onMounted, onBeforeUnmount, defineAsyncComponent } from 'vue'
import { api, ApiError } from '../api'
import { gameName } from '../gameNames'
import { blockIcon, statusName, type ProjectDetail } from '../projects'
import DataChart from './DataChart.vue'
import ProjectMapView from './ProjectMapView.vue'
import type { EChartsOption } from 'echarts'
const ProjectModelView=defineAsyncComponent(()=>import('./ProjectModelView.vue'))
const view=ref(location.hash==='#model'?'model':'map')
const props = defineProps<{ id: string }>()
const detail = ref<ProjectDetail>(), error = ref(''), revision = ref(''), busy = ref(false)
let timer: ReturnType<typeof setInterval> | undefined
let alive = true
async function load() {
  if (busy.value) return
  busy.value = true
  try {
    const result = await api<ProjectDetail>(`/public/projects/${props.id}${revision.value ? '?revision=' + revision.value : ''}`)
    if (alive) { detail.value = result; error.value = '' }
  } catch (e) { if (alive) { error.value = e instanceof Error ? e.message : t('m1091'); if(e instanceof ApiError && e.status===404)detail.value=undefined } }
  finally { busy.value = false }
}
onMounted(() => { load(); timer = setInterval(() => { if (!document.hidden && !revision.value && detail.value?.project.status === 'ACTIVE') load() }, 15000) })
onBeforeUnmount(() => { alive = false; clearInterval(timer) })
const mapUrl = computed(() => detail.value ? `/api/public/projects/${props.id}/phases/${detail.value.revision}/map.png?t=${encodeURIComponent(detail.value.mapAt ?? '')}` : '')
const people = computed(() => {
  const rows = new Map<string, { name: string; placed: number; removed: number }>()
  for (const item of detail.value?.statistics.contributors ?? []) {
    const row = rows.get(item.contributorId) ?? { name: item.name, placed: 0, removed: 0 }
    row[item.operation === 'PLACE' ? 'placed' : 'removed'] += Number(item.count); rows.set(item.contributorId, row)
  }
  return [...rows.values()].sort((a,b) => b.placed + b.removed - a.placed - a.removed)
})
const chart = computed<EChartsOption>(() => ({ tooltip: { trigger: 'axis', renderMode: 'richText' }, legend: { top: 0 }, grid: { top: 40, left: 110, right: 25, bottom: 35 },
  xAxis: { type: 'value', minInterval: 1 }, yAxis: { type: 'category', inverse: true, data: people.value.slice(0,20).map(p => p.name), axisLabel: { width: 95, overflow: 'truncate' } },
  series: [{ type: 'bar', name: t('m0685'), stack: 'work', data: people.value.slice(0,20).map(p=>p.placed) }, { type: 'bar', name: t('m1015'), stack: 'work', data: people.value.slice(0,20).map(p=>p.removed) }] }))
function iconFailed(event: Event) { (event.target as HTMLImageElement).style.visibility = 'hidden' }
const date = (value: string | null) => value ? new Date(value).toLocaleString(formatLocale) : t('m1092')
</script>
<template>
  <main class="project-public">
      <LanguageSwitcher />
    <p v-if="error" role="alert" class="project-error">{{ error }} <button @click="load">{{ t('m0337') }}</button></p>
    <template v-if="detail">
      <header class="project-banner"><div><small>{{ t('m1093', [detail.project.serverName]) }}</small><h1>{{ detail.project.name }}</h1><p>{{ t('m1094', [detail.project.creator, statusName(detail.project.status), detail.revision]) }}</p></div>
        <label>{{ t('m1095') }}<select v-model="revision" @change="load()"><option value="">{{ t('m1096') }}</option><option v-for="r in detail.revisions" :key="r" :value="String(r)">{{ t('m1076', [r]) }}</option></select><button @click="load">{{ t('m0331') }}</button></label>
      </header>
      <div class="project-layout">
        <section class="project-panel">
          <div class="project-toolbar"><div><h2>{{ t('m1097') }}</h2><p>{{ t('m1098', [gameName(detail.project.dimension,'dimension') ?? detail.project.dimension, detail.project.minX, detail.project.maxX, detail.project.minZ, detail.project.maxZ]) }}</p></div></div>
          <div class="project-view-tabs"><button :aria-pressed="view==='map'" @click="view='map'">{{ t('m1099') }}</button><button :aria-pressed="view==='model'" @click="view='model'">{{ t('m1100') }}</button></div>
          <ProjectModelView v-if="view==='model'" :key="`${props.id}:${detail.revision}`" :id="props.id" :revision="detail.revision" />
          <ProjectMapView v-else-if="detail.mapAvailable" :key="`${props.id}:${detail.revision}:map`" :url="mapUrl" :min-x="detail.project.minX" :max-x="detail.project.maxX" :min-z="detail.project.minZ" :max-z="detail.project.maxZ" />
          <div v-else class="project-map project-empty">{{ detail.project.status === 'COMPLETE' ? t('m1101') : t('m1102') }}</div>
          <p v-if="view==='map'" class="project-muted">{{ t('m1103', [date(detail.mapAt)]) }}<span v-if="detail.mapMetadata && !detail.mapMetadata.tileCoverageComplete">{{ t('m1104') }}</span><span v-if="detail.mapMetadata?.truncated">{{ t('m1105') }}</span></p>
          <details class="project-muted"><summary>{{ t('m1106') }}</summary><p>{{ systemMessage(detail.notice) }}</p></details>
        </section>
        <aside class="project-panel project-legend"><h2>{{ t('m1107') }}</h2><p class="project-muted">{{ t('m1108') }}</p><p v-if="!detail.statistics.materials.length" class="project-empty">{{ t('m1109') }}</p>
          <ul><li v-for="item in detail.statistics.materials" :key="item.block+item.operation"><img :src="blockIcon(item.block)" alt="" @error="iconFailed"/><span :title="item.block">{{ gameName(item.block,'block') ?? item.block }}</span><small>{{ item.operation==='PLACE'?t('m0685'):t('m1015') }}</small><strong>{{ item.count }}</strong></li></ul>
        </aside>
      </div>
      <section class="project-panel"><h2>{{ t('m1110') }}</h2><p class="project-muted">{{ t('m1111') }}</p><DataChart v-if="people.length" :option="chart" :label="t('m1112')" :height="Math.max(240,Math.min(20,people.length)*34+80)"/><p v-else class="project-empty">{{ t('m1113') }}</p>
        <details v-if="people.length"><summary>{{ t('m1114') }}</summary><ul class="project-contributions"><li v-for="(p,i) in people" :key="i">{{ t('m1115', [p.name, p.placed, p.removed]) }}</li></ul></details>
      </section>
    </template><p v-else-if="!error" class="project-empty">{{ t('m1116') }}</p>
  </main>
</template>
<style>
.project-view-tabs{display:flex;gap:8px;margin:10px 0 16px}.project-view-tabs button[aria-pressed="true"]{background:#19815c;color:#fff;border-color:#19815c}
.project-public{max-width:1560px;margin:0 auto;padding:24px;color:#183c35;background:#f3f8f5;min-height:100vh}.project-banner{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:28px;border-radius:20px;background:linear-gradient(120deg,#d8f3df,#e0ecff 65%,#f2e1fa);margin-bottom:20px}.project-banner h1{margin:10px 0;font-size:32px;overflow-wrap:anywhere}.project-banner small{color:#527364}.project-banner select{display:block;margin-top:8px}.project-layout{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:20px}.project-panel{padding:22px;border:1px solid #dbe8e0;border-radius:18px;background:#fff;min-width:0;margin-bottom:20px}.project-panel h2{font-size:20px;margin:0 0 12px}.project-toolbar{display:flex;justify-content:space-between;gap:15px;align-items:center;flex-wrap:wrap}.project-toolbar p,.project-muted{font-size:13px;color:#6a8076;line-height:1.7}.project-toolbar button{margin-left:5px}.project-map{height:62vh;min-height:300px;max-height:720px;overflow:auto;border-radius:12px;background-color:#dbe5df;background-image:linear-gradient(45deg,#e9efeb 25%,transparent 25%),linear-gradient(-45deg,#e9efeb 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#e9efeb 75%),linear-gradient(-45deg,transparent 75%,#e9efeb 75%);background-size:24px 24px;background-position:0 0,0 12px,12px -12px,-12px 0}.project-map img{display:block;height:auto;image-rendering:pixelated}.project-legend ul{list-style:none;margin:16px 0 0;padding:0;max-height:72vh;overflow:auto}.project-legend li{display:grid;grid-template-columns:32px minmax(0,1fr) auto auto;align-items:center;gap:8px;padding:12px 0;border-bottom:1px solid #edf1ee;font-size:14px}.project-legend li span{overflow-wrap:anywhere}.project-legend img{width:28px;height:28px;object-fit:contain;image-rendering:pixelated}.project-legend small{color:#778b80}.project-empty{padding:40px 16px;text-align:center;color:#789084;line-height:1.8}.project-error{padding:16px;background:#fff0e7;color:#913d28;border-radius:12px}.project-contributions{line-height:2}.project-public button,.project-public select{border:1px solid #c3d7cb;border-radius:8px;padding:8px 12px;background:#fff;color:#174e3d;cursor:pointer}@media(max-width:850px){.project-layout{grid-template-columns:1fr}.project-public{padding:12px}.project-banner{padding:20px;align-items:flex-start;flex-direction:column}.project-banner h1{font-size:26px}.project-panel{padding:16px}.project-map{height:48vh}.project-legend ul{max-height:400px}}
</style>
