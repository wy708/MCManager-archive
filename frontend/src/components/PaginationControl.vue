<script setup lang="ts">
import { t, formatLocale } from '../i18n'

import { ChevronLeft, ChevronRight } from '@lucide/vue'
const props = defineProps<{ page: number; total: number; pageSize?: number; busy?: boolean }>()
const emit = defineEmits<{ change: [page: number] }>()
</script>
<template>
  <div class="pagination">
    <span>{{ t('m0868', [total.toLocaleString(formatLocale), page]) }}</span>
    <div>
      <button class="secondary" :disabled="busy || page <= 1" @click="emit('change', page - 1)">
        <ChevronLeft :size="16" />{{ t('m0869') }}</button
      ><button
        class="secondary"
        :disabled="busy || page * (pageSize ?? 25) >= total"
        @click="emit('change', page + 1)"
      >{{ t('m0870') }}<ChevronRight :size="16" />
      </button>
    </div>
  </div>
</template>
