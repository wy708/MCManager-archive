<script setup lang="ts">
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
      <h2><Box :size="20" />正在书写的建筑故事</h2>
      <select
        v-if="scope === 'all' && servers.length > 1"
        v-model="selected"
        aria-label="首页工程服务器"
      >
        <option value="">{{ server?.name }}</option>
        <option v-for="s in servers" :key="s.id" :value="s.id">{{ s.name }}</option></select
      ><button class="text-button" @click="emit('open')">全部工程<ArrowRight :size="16" /></button>
    </div>
    <p v-if="busy" class="small-empty" role="status">正在翻开工程手记…</p>
    <p v-else-if="error" class="small-empty">
      工程暂时无法读取。<button class="text-button" @click="refresh">重试</button>
    </p>
    <div v-else-if="projects.length" class="overview-project-grid">
      <article v-for="(p, i) in projects" :key="p.id" class="overview-project-card">
        <div class="project-story-art" :class="i ? 'story-sunset' : 'story-overworld'">
          <span>世界插画</span>
        </div>
        <div class="project-story-copy">
          <span class="status" :class="p.status === 'ACTIVE' ? 'recording' : 'archived'"
            >{{ statusName(p.status) }} · 第 {{ p.revision }} 阶段</span
          >
          <h3>{{ p.name }}</h3>
          <p><Users :size="14" />{{ p.creator }} 创建</p>
          <p><Map :size="14" />X {{ p.minX }}～{{ p.maxX }} · Z {{ p.minZ }}～{{ p.maxZ }}</p>
          <a class="text-button" :href="p.publicUrl + '#model'" target="_blank" rel="noopener"
            >查看三维建筑<ArrowRight :size="15"
          /></a>
        </div>
      </article>
    </div>
    <div v-else class="project-welcome">
      <Box :size="38" />
      <div>
        <h3>下一座建筑，从这里开始</h3>
        <p>记录施工范围、伙伴贡献和三维模型，完工后留下纪念。</p>
      </div>
      <button class="secondary" @click="emit('open')">前往施工工程<ArrowRight :size="16" /></button>
    </div>
  </section>
</template>
