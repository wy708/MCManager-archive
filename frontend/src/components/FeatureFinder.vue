<script setup lang="ts">
import { t } from '../i18n'

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
        <p class="eyebrow">{{ t('m0810') }}</p>
        <h2 id="finder-title"><Compass :size="22" />{{ t('m0811') }}</h2>
      </div>
      <button class="icon-button" :aria-label="t('m0812')" @click="dialog?.close()">
        <X :size="22" />
      </button>
    </div>
    <label class="finder-search"
      ><Search :size="20" /><input
        ref="input"
        v-model="search"
        type="search"
        :placeholder="t('m0813')"
        :aria-label="t('m0814')"
        maxlength="80"
    /></label>
    <div class="finder-suggestions">
      <button
        v-for="word in [t('m0599'), t('m0815'), t('m0816'), t('m0817')]"
        :key="word"
        @click="search = word"
      >
        {{ word }}
      </button>
    </div>
    <p class="finder-count" role="status">
      {{
        results.length
          ? t('m0818', [results.length])
          : t('m0819')
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
