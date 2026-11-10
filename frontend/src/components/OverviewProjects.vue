<script setup lang="ts">
import { t } from '../i18n'

import { computed, ref } from 'vue'
import { Box, ArrowRight, Map, Users } from '@lucide/vue'
import { api, type ServerArchive } from '../api'
import { statusName, type Project } from '../projects'
import { useResource } from '../useResource'
const props = defineProps<{ scope: string; servers: ServerArchive[]; revision: number }>()
const emit = defineEmits<{ open: [] }>()
const selected = ref('')
const server = computed(
  () =>
    props.servers.find((s) => s.id === props.scope) ??
    props.servers.find((s) => s.id === selected.value) ??
    props.servers.find((s) => s.status === 'RECORDING') ??
    props.servers[0],
)
const { data, busy, error, refresh } = useResource(
  () => [server.value?.id, props.revision],
  (signal) =>
    server.value
      ? api<Project[]>(`/servers/${server.value.id}/projects`, { signal })
      : Promise.resolve([]),
  () => {},
)
const projects = computed(() =>
  [...(data.value ?? [])]
    .sort((a, b) => Number(b.status === 'ACTIVE') - Number(a.status === 'ACTIVE'))
    .slice(0, 2),
)
</script>
<template>
  <section class="panel overview-projects">
    <div class="panel-heading">
      <h2><Box :size="20" />{{ t('m0856') }}</h2>
      <select
        v-if="scope === 'all' && servers.length > 1"
        v-model="selected"
        :aria-label="t('m0857')"
      >
        <option value="">{{ server?.name }}</option>
        <option v-for="s in servers" :key="s.id" :value="s.id">{{ s.name }}</option></select
      ><button class="text-button" @click="emit('open')">{{ t('m0858') }}<ArrowRight :size="16" /></button>
    </div>
    <p v-if="busy" class="small-empty" role="status">{{ t('m0859') }}</p>
    <p v-else-if="error" class="small-empty">{{ t('m0860') }}<button class="text-button" @click="refresh">{{ t('m0337') }}</button>
    </p>
    <div v-else-if="projects.length" class="overview-project-grid">
      <article v-for="(p, i) in projects" :key="p.id" class="overview-project-card">
        <div class="project-story-art" :class="i ? 'story-sunset' : 'story-overworld'">
          <span>{{ t('m0861') }}</span>
        </div>
        <div class="project-story-copy">
          <span class="status" :class="p.status === 'ACTIVE' ? 'recording' : 'archived'"
            >{{ t('m0862', [statusName(p.status), p.revision]) }}</span
          >
          <h3>{{ p.name }}</h3>
          <p><Users :size="14" />{{ t('m0863', [p.creator]) }}</p>
          <p><Map :size="14" />X {{ p.minX }}～{{ p.maxX }} · Z {{ p.minZ }}～{{ p.maxZ }}</p>
          <a class="text-button" :href="p.publicUrl + '#model'" target="_blank" rel="noopener"
            >{{ t('m0864') }}<ArrowRight :size="15"
          /></a>
        </div>
      </article>
    </div>
    <div v-else class="project-welcome">
      <Box :size="38" />
      <div>
        <h3>{{ t('m0865') }}</h3>
        <p>{{ t('m0866') }}</p>
      </div>
      <button class="secondary" @click="emit('open')">{{ t('m0867') }}<ArrowRight :size="16" /></button>
    </div>
  </section>
</template>
