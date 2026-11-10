<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { Search, X, ArrowRight, Compass } from '@lucide/vue'
import { visibleNavigation } from '../navigation'
import type { WorkspaceSection } from '../workspaceRoute'
const props = defineProps<{ admin: boolean }>()
const emit = defineEmits<{ select: [section: WorkspaceSection, query: string] }>()
const dialog = ref<HTMLDialogElement>(),
  input = ref<HTMLInputElement>(),
  search = ref('')
let opener: HTMLElement | null = null
const results = computed(() => {
  const terms = search.value.trim().toLocaleLowerCase().split(/\s+/)
  return visibleNavigation(props.admin).filter((item) =>
    terms.every((term) =>
      `${item.label} ${item.description} ${item.keywords}`.toLocaleLowerCase().includes(term),
    ),
  )
})
async function open() {
  opener = document.activeElement as HTMLElement
  search.value = ''
  dialog.value?.showModal()
  await nextTick()
  input.value?.focus()
}
function choose(section: WorkspaceSection) {
  dialog.value?.close()
  emit('select', section, search.value)
}
defineExpose({ open })
</script>
<template>
  <dialog
    ref="dialog"
    class="feature-finder"
    aria-labelledby="finder-title"
    @close="opener?.focus()"
  >
    <div class="dialog-heading">
      <div>
        <p class="eyebrow">冒险指南</p>
        <h2 id="finder-title"><Compass :size="22" />你想做什么？</h2>
      </div>
      <button class="icon-button" aria-label="关闭功能查找" @click="dialog?.close()">
        <X :size="22" />
      </button>
    </div>
    <label class="finder-search"
      ><Search :size="20" /><input
        ref="input"
        v-model="search"
        type="search"
        placeholder="试试：导出模型、聊天、每天备份…"
        aria-label="搜索功能"
        maxlength="80"
    /></label>
    <div class="finder-suggestions">
      <button
        v-for="word in ['聊天', '导出模型', '备份', '卡顿']"
        :key="word"
        @click="search = word"
      >
        {{ word }}
      </button>
    </div>
    <p class="finder-count" role="status">
      {{
        results.length
          ? `找到 ${results.length} 个入口`
          : '没有匹配的入口，试试“工程”“玩家”或“地图”。'
      }}
    </p>
    <div class="finder-results">
      <button v-for="item in results" :key="item.key" @click="choose(item.key)">
        <span class="finder-icon"><component :is="item.icon" :size="22" /></span
        ><span
          ><strong>{{ item.label }}</strong
          ><small>{{ item.description }}</small></span
        ><ArrowRight :size="18" />
      </button>
    </div>
  </dialog>
</template>
