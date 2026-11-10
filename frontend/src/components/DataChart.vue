<script setup lang="ts">
import { t, locale } from '../i18n'

import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import type { EChartsOption, ECharts } from 'echarts'
const props = withDefaults(
  defineProps<{ option: EChartsOption; label: string; height?: number }>(),
  { height: 280 },
)
const element = ref<HTMLDivElement>()
const failed = ref(false)
let chart: ECharts | undefined
let observer: ResizeObserver | undefined
let visibility: IntersectionObserver | undefined
let loading = false
let disposed = false
function render() {
  chart?.setOption(
    {
      color: ['#229b78', '#6b88de', '#ad83d8', '#e8ae52', '#62bfc8'],
      textStyle: { fontFamily: '"Microsoft YaHei", system-ui, sans-serif', color: '#64756f' },
      ...props.option,
      animation: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      animationDuration: 350,
    },
    { notMerge: true },
  )
}
async function initialize() {
  if (loading || disposed) return
  loading = true
  try {
    const { init } = await import('../charts')
    if (disposed || !element.value) return
    const resize = () => {
      if (!element.value?.clientWidth || !element.value?.clientHeight) return
      if (!chart) {
        chart = init(element.value, undefined, { renderer: 'svg', locale: locale === 'en' ? 'EN' : 'ZH' })
        render()
      } else chart.resize()
    }
    observer = new ResizeObserver(resize)
    observer.observe(element.value)
    resize()
  } catch {
    failed.value = true
  }
}
onMounted(() => {
  // Charts below the fold (or inside closed details) do not load the chart engine yet.
  if (!element.value) return
  visibility = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        visibility?.disconnect()
        void initialize()
      }
    },
    { rootMargin: '160px' },
  )
  visibility.observe(element.value)
})
watch(() => props.option, render, { deep: true })
onBeforeUnmount(() => {
  disposed = true
  visibility?.disconnect()
  observer?.disconnect()
  chart?.dispose()
})
</script>
<template>
  <div
    class="data-chart"
    ref="element"
    role="img"
    :aria-label="label"
    :style="{ height: `${height}px` }"
  >
    <p v-if="failed" class="small-empty">{{ t('m0707') }}</p>
  </div>
</template>
