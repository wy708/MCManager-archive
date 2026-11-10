<script setup lang="ts">
import { t } from '../i18n'

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
      >{{ t('m0466') }}<input v-model="draft.fromDate" type="date" :max="draft.toDate || undefined"
    /></label>
    <label
      >{{ t('m0095') }}<input v-model="draft.toDate" type="date" :min="draft.fromDate || undefined"
    /></label>
    <label
      >{{ t('m1435') }}<input
        v-model="dimensionName"
        list="known-dimensions"
        :placeholder="t('m1436')"
        :aria-label="t('m1437')" /><datalist id="known-dimensions">
        <option v-for="(label, key) in knownDimensions" :key="key" :value="label" /></datalist
    ></label>
    <div class="filter-actions">
      <button class="primary" :disabled="busy">{{ t('m1438') }}</button
      ><button type="button" class="secondary" @click="reset">{{ t('m1439') }}</button
      ><button
        type="button"
        class="icon-button"
        :aria-label="t('m1440')"
        :disabled="busy"
        @click="emit('refresh')"
      >
        <RefreshCw :size="18" />
      </button>
    </div>
  </form>
</template>
