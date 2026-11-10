<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RefreshCw } from '@lucide/vue'
import type { Filters } from '../statistics'
import { dimensions } from '../statistics'
const props = defineProps<{ modelValue: Filters; busy?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: Filters]; refresh: [] }>()
const draft = ref({ ...props.modelValue })
const knownDimensions = Object.fromEntries(
  Object.entries(dimensions).filter(([key]) => key !== 'unknown'),
)
const dimensionName = computed({
  get: () => knownDimensions[draft.value.dimension] ?? draft.value.dimension,
  set: (value: string) => {
    draft.value.dimension =
      Object.entries(knownDimensions).find(([, label]) => label === value)?.[0] ?? value
  },
})
watch(
  () => props.modelValue,
  (value) => {
    draft.value = { ...value }
  },
)
function apply() {
  emit('update:modelValue', { ...draft.value })
}
function reset() {
  draft.value = { fromDate: '', toDate: '', dimension: '' }
  apply()
}
</script>
<template>
  <form class="statistics-filters panel" @submit.prevent="apply">
    <label
      >开始日期<input v-model="draft.fromDate" type="date" :max="draft.toDate || undefined"
    /></label>
    <label
      >结束日期<input v-model="draft.toDate" type="date" :min="draft.fromDate || undefined"
    /></label>
    <label
      >所在世界<input
        v-model="dimensionName"
        list="known-dimensions"
        placeholder="主世界、下界、末地…"
        aria-label="维度筛选" /><datalist id="known-dimensions">
        <option v-for="(label, key) in knownDimensions" :key="key" :value="label" /></datalist
    ></label>
    <div class="filter-actions">
      <button class="primary" :disabled="busy">应用筛选</button
      ><button type="button" class="secondary" @click="reset">查看全部时间</button
      ><button
        type="button"
        class="icon-button"
        aria-label="刷新统计"
        :disabled="busy"
        @click="emit('refresh')"
      >
        <RefreshCw :size="18" />
      </button>
    </div>
  </form>
</template>
