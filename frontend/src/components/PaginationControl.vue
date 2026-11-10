<script setup lang="ts">
import { ChevronLeft, ChevronRight } from '@lucide/vue'
const props = defineProps<{ page: number; total: number; pageSize?: number; busy?: boolean }>()
const emit = defineEmits<{ change: [page: number] }>()
</script>
<template>
  <div class="pagination">
    <span>共 {{ total.toLocaleString('zh-CN') }} 条 · 第 {{ page }} 页</span>
    <div>
      <button class="secondary" :disabled="busy || page <= 1" @click="emit('change', page - 1)">
        <ChevronLeft :size="16" />上一页</button
      ><button
        class="secondary"
        :disabled="busy || page * (pageSize ?? 25) >= total"
        @click="emit('change', page + 1)"
      >
        下一页<ChevronRight :size="16" />
      </button>
    </div>
  </div>
</template>
