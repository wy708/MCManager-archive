<script setup lang="ts">
import { t } from '../i18n'

import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { api, type ServerArchive } from '../api'
import { statusName, type Project, type ProjectDetail } from '../projects'
import { readHeight } from '../projectViewPreferences'
const props = defineProps<{ scope: string; servers: ServerArchive[]; readonly?: boolean }>()
const groups = ref<{ server: ServerArchive; projects: Project[] }[]>([]),
  error = ref(''),
  busy = ref(false),
  editing = ref<Project>(),
  create = ref(false),
  message = ref('')
const deleting = ref<Project>(),
  deleteDialog = ref<HTMLDialogElement>()
function confirmDelete(project: Project) {
  deleting.value = project
  deleteDialog.value?.showModal()
}
async function deleteProject() {
  if (!deleting.value || busy.value) return
  busy.value = true
  error.value = ''
  try {
    const p = deleting.value
    await api<void>(`/servers/${p.serverId}/projects/${p.id}`, { method: 'DELETE' })
    deleteDialog.value?.close()
    deleting.value = undefined
    editing.value = undefined
    message.value = t('m1030')
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('m1031')
    deleteDialog.value?.close()
  } finally {
    busy.value = false
  }
}
function cancelDelete() {
  deleteDialog.value?.close()
  deleting.value = undefined
}
const exporting = ref<Project>(),
  exportDialog = ref<HTMLDialogElement>(),
  exportBusy = ref(false),
  exportMessage = ref(''),
  exportRevision = ref(1),
  exportRevisions = ref<number[]>([]),
  includeCreatures = ref(false)
const exportMinY = ref(0),
  exportMaxY = ref(319),
  exportBuild = ref(''),
  exportHeightBusy = ref(false),
  exportHeightNotice = ref(''),
  exportIssues = ref<string[]>([])
let exportController: AbortController | undefined
function cancelExport() {
  exportController?.abort()
  exportBusy.value = false
  exportHeightBusy.value = false
  exportBuild.value = ''
  exportDialog.value?.close()
  exporting.value = undefined
}
onBeforeUnmount(() => exportController?.abort())
async function openExport(project: Project) {
  exportController?.abort()
  const controller = new AbortController()
  exportController = controller
  exporting.value = project
  exportRevision.value = project.revision
  exportRevisions.value = [project.revision]
  includeCreatures.value = false
  exportMessage.value = ''
  exportBuild.value = ''
  exportDialog.value?.showModal()
  try {
    const detail = await api<ProjectDetail>(`/public/projects/${project.id}`, {
      signal: controller.signal,
    })
    if (exporting.value?.id === project.id) exportRevisions.value = detail.revisions
  } catch (e) {
    if (!controller.signal.aborted)
      exportMessage.value = e instanceof Error ? e.message : t('m1032')
  }
  if (!controller.signal.aborted) void prepareExportRange()
}
async function prepareExportRange() {
  const project = exporting.value
  if (!project) return
  exportController?.abort()
  const controller = new AbortController()
  exportController = controller
  exportBuild.value = ''
  exportIssues.value = []
  exportHeightBusy.value = true
  exportMessage.value = t('m1033')
  const revision = exportRevision.value,
    prefix = `/servers/${project.serverId}/projects/${project.id}/phases/${revision}/scene-export`
  try {
    const deadline = Date.now() + 180000
    while (!controller.signal.aborted) {
      const state = await api<{
        state: string
        message: string
        build: string | null
        issues?: string[]
      }>(prefix + '/status', { signal: controller.signal })
      exportMessage.value = state.message
      if (state.state === 'READY' && state.build) {
        exportIssues.value = state.issues ?? []
        const range = await api<{
          minY: number
          maxY: number
          suggestedMinY: number
          basis: string
        }>(`/public/projects/${project.id}/phases/${revision}/scene/${state.build}/height-range`, {
          signal: controller.signal,
        })
        if (controller.signal.aborted) return
        const saved = readHeight(project.id)
        exportMinY.value = saved?.minY ?? range.suggestedMinY
        exportMaxY.value = saved?.maxY ?? range.maxY
        exportBuild.value = state.build
        exportHeightNotice.value =
          t('m1034', [range.minY, range.maxY]) +
          (saved
            ? t('m1035')
            : range.basis === 'PLAYER_PLACEMENT'
              ? t('m1036')
              : t('m1037'))
        exportMessage.value = ''
        return
      }
      if (['FAILED', 'UNAVAILABLE', 'WAITING'].includes(state.state)) throw new Error(state.message)
      if (Date.now() > deadline) throw new Error(t('m1038'))
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }
  } catch (e) {
    if (!controller.signal.aborted)
      exportMessage.value = e instanceof Error ? e.message : t('m1039')
  } finally {
    if (exportController === controller) exportHeightBusy.value = false
  }
}
async function exportModel() {
  const project = exporting.value
  if (!project || exportBusy.value || exportHeightBusy.value || !exportBuild.value) return
  const minY = exportMinY.value,
    maxY = exportMaxY.value
  if (
    !Number.isInteger(minY) ||
    !Number.isInteger(maxY) ||
    minY < -2048 ||
    maxY > 4095 ||
    minY > maxY
  ) {
    exportMessage.value = t('m1040')
    return
  }
  exportController?.abort()
  const controller = new AbortController()
  exportController = controller
  exportBusy.value = true
  exportMessage.value = t('m1041')
  const revision = exportRevision.value,
    creatures = includeCreatures.value,
    build = exportBuild.value,
    prefix = `/servers/${project.serverId}/projects/${project.id}/phases/${revision}/scene-export/${build}`,
    query = new URLSearchParams({
      minY: String(minY),
      maxY: String(maxY),
      includeCreatures: String(creatures),
    })
  try {
    const deadline = Date.now() + 180000
    while (!controller.signal.aborted) {
      const state = await api<{ state: string; message: string }>(
        prefix + '/range-status?' + query,
        { signal: controller.signal },
      )
      exportMessage.value = state.message
      if (state.state === 'READY') {
        const link = document.createElement('a')
        link.href = '/api' + prefix + '?' + query
        link.download = project.name + t('m1042') + revision + '-Y' + minY + t('m1043') + maxY + '.glb'
        document.body.appendChild(link)
        link.click()
        link.remove()
        exportMessage.value = t('m1044', [minY, maxY])
        return
      }
      if (['FAILED', 'UNAVAILABLE', 'WAITING'].includes(state.state)) throw new Error(state.message)
      if (Date.now() > deadline) throw new Error(t('m1045'))
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }
  } catch (e) {
    if (!controller.signal.aborted)
      exportMessage.value = e instanceof Error ? e.message : t('m1046')
  } finally {
    if (exportController === controller) exportBusy.value = false
  }
}

const form = ref({
  serverId: '',
  name: '',
  dimension: 'minecraft:overworld',
  x1: 0,
  z1: 0,
  x2: 16,
  z2: 16,
})
const search = ref(''),
  stateFilter = ref('all')
const projectCounts = computed(() => ({
  all: groups.value.reduce((n, g) => n + g.projects.length, 0),
  active: groups.value.reduce(
    (n, g) => n + g.projects.filter((p) => p.status === 'ACTIVE').length,
    0,
  ),
  complete: groups.value.reduce(
    (n, g) => n + g.projects.filter((p) => p.status === 'COMPLETE').length,
    0,
  ),
}))
const filteredGroups = computed(() =>
  groups.value.map((g) => ({
    ...g,
    projects: g.projects.filter(
      (p) =>
        (stateFilter.value === 'all' || p.status === stateFilter.value) &&
        `${p.name} ${p.creator}`
          .toLocaleLowerCase()
          .includes(search.value.trim().toLocaleLowerCase()),
    ),
  })),
)
const visible = computed(() =>
  props.servers.filter((s) => props.scope === 'all' || s.id === props.scope),
)
let generation = 0
async function load() {
  const ticket = ++generation
  try {
    const result = await Promise.all(
      visible.value.map(async (server) => ({
        server,
        projects: await api<Project[]>(`/servers/${server.id}/projects`),
      })),
    )
    if (ticket === generation) groups.value = result
  } catch (e) {
    if (ticket === generation) error.value = e instanceof Error ? e.message : t('m1047')
  }
}
watch(
  () => [props.scope, props.servers],
  () => {
    create.value = false
    editing.value = undefined
    load()
  },
  { immediate: true },
)
function edit(project: Project) {
  editing.value = project
  create.value = false
  form.value = {
    serverId: project.serverId,
    name: project.name,
    dimension: project.dimension,
    x1: project.minX,
    z1: project.minZ,
    x2: project.maxX,
    z2: project.maxZ,
  }
  error.value = ''
}
function cancelEdit() {
  create.value = false
  editing.value = undefined
}
function newProject() {
  editing.value = undefined
  create.value = true
  form.value = {
    serverId: visible.value.find((s) => s.status === 'RECORDING')?.id ?? '',
    name: '',
    dimension: 'minecraft:overworld',
    x1: 0,
    z1: 0,
    x2: 16,
    z2: 16,
  }
  error.value = ''
}
let retry: { signature: string; requestId: string } | undefined
async function operate(action: string, project?: Project) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  message.value = ''
  const serverId = project?.serverId ?? form.value.serverId
  const operation = {
    action,
    projectId: project?.id,
    ...(action === 'CREATE' || action === 'UPDATE'
      ? {
          name: form.value.name,
          dimension: form.value.dimension,
          x1: form.value.x1,
          z1: form.value.z1,
          x2: form.value.x2,
          z2: form.value.z2,
        }
      : {}),
  }
  const signature = JSON.stringify({ serverId, operation })
  if (!retry || retry.signature !== signature) retry = { signature, requestId: crypto.randomUUID() }
  try {
    const result = await api<{ message: string }>(`/servers/${serverId}/projects`, {
      method: 'POST',
      body: JSON.stringify({ ...operation, requestId: retry.requestId }),
    })
    message.value = result.message
    retry = undefined
    create.value = false
    editing.value = undefined
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('m1048')
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <section class="projects-admin">
    <div class="project-banner">
      <div>
        <h2>{{ t('m1049') }}</h2>
        <p>{{ t('m1050') }}</p>
      </div>
      <button v-if="!props.readonly" class="primary" @click="newProject">{{ t('m1051') }}</button>
    </div>
    <details class="project-command-help">
      <summary>{{ t('m1052') }}</summary>
      <p class="project-muted">{{ t('m1053') }}</p>
    </details>
    <div class="project-library-tools">
      <label>{{ t('m1054') }}<input v-model="search" type="search" :placeholder="t('m1055')" /></label>
      <div class="segmented">
        <button :aria-pressed="stateFilter === 'all'" @click="stateFilter = 'all'">{{ t('m1056', [projectCounts.all]) }}</button
        ><button :aria-pressed="stateFilter === 'ACTIVE'" @click="stateFilter = 'ACTIVE'">{{ t('m1057', [projectCounts.active]) }}</button
        ><button :aria-pressed="stateFilter === 'COMPLETE'" @click="stateFilter = 'COMPLETE'">{{ t('m1058', [projectCounts.complete]) }}
        </button>
      </div>
    </div>
    <p v-if="error" class="project-error" role="alert">{{ error }}</p>
    <p v-if="message" role="status">{{ message }}</p>
    <form
      v-if="!props.readonly && (create || editing)"
      class="project-panel project-form"
      @submit.prevent="operate(editing ? 'UPDATE' : 'CREATE', editing)"
    >
      <h3>{{ editing ? t('m1059') + editing.name : t('m1060') }}</h3>
      <p class="project-muted">
        {{ t('m1063', [editing
            ? t('m1061')
            : t('m1062')]) }}</p>
      <label v-if="create"
        >{{ t('m0727') }}<select v-model="form.serverId" required>
          <option
            v-for="s in visible.filter((s) => s.status === 'RECORDING')"
            :key="s.id"
            :value="s.id"
          >
            {{ s.name }}
          </option>
        </select></label
      >
      <label v-if="create">{{ t('m1064') }}<input v-model="form.name" maxlength="80" required /></label>
      <label
        >{{ t('m0586') }}<select v-model="form.dimension" :disabled="!!editing">
          <option value="minecraft:overworld">{{ t('m0257') }}</option>
          <option value="minecraft:nether">{{ t('m0258') }}</option>
          <option value="minecraft:the_end">{{ t('m0259') }}</option>
        </select></label
      >
      <div class="project-coordinates">
        <label v-for="field in ['x1', 'z1', 'x2', 'z2'] as const" :key="field"
          >{{ field.toUpperCase()
          }}<input
            v-model.number="form[field]"
            type="number"
            min="-30000000"
            max="30000000"
            step="1"
            required
        /></label>
      </div>
      <button class="primary" :disabled="busy">{{ busy ? t('m0417') : t('m1065') }}</button>
      <button type="button" @click="cancelEdit">{{ t('m0102') }}</button>
    </form>
    <section v-for="group in filteredGroups" :key="group.server.id" class="project-panel">
      <h2>{{ group.server.name }}</h2>
      <p v-if="!group.projects.length" class="project-empty">
        {{
          search || stateFilter !== 'all'
            ? t('m1066')
            : t('m1067')
        }}
      </p>
      <div class="project-cards">
        <article v-for="p in group.projects" :key="p.id" class="project-card">
          <small class="project-state-chip"
            >{{ t('m0862', [statusName(p.status), p.revision]) }}</small
          >
          <h3>{{ p.name }}</h3>
          <p>{{ t('m0863', [p.creator]) }}</p>
          <p class="project-muted">
            X {{ p.minX }} ～ {{ p.maxX }} · Z {{ p.minZ }} ～ {{ p.maxZ }}
          </p>
          <div class="project-actions">
            <a :href="p.publicUrl" target="_blank" rel="noopener">{{ t('m1068') }}</a
            ><a :href="p.publicUrl + '#model'" target="_blank" rel="noopener">{{ t('m1069') }}</a
            ><button
              v-if="!props.readonly && p.status === 'ACTIVE'"
              :disabled="busy"
              @click="edit(p)"
            >{{ t('m1070') }}</button
            ><button
              v-if="!props.readonly && p.status === 'ACTIVE'"
              :disabled="busy"
              @click="operate('COMPLETE', p)"
            >{{ t('m1071') }}</button
            ><button
              v-if="!props.readonly && p.status === 'COMPLETE'"
              :disabled="busy"
              @click="operate('RESUME', p)"
            >{{ t('m1072') }}</button
            ><button v-if="!props.readonly" :disabled="busy" @click="openExport(p)">{{ t('m1073') }}</button
            ><button
              v-if="!props.readonly"
              class="project-delete-button"
              :disabled="busy"
              @click="confirmDelete(p)"
            >{{ t('m1074') }}</button>
          </div>
        </article>
      </div>
    </section>
    <dialog
      ref="exportDialog"
      class="project-delete-dialog project-export-dialog"
      aria-labelledby="export-project-title"
      @cancel="cancelExport"
    >
      <h2 id="export-project-title">{{ t('m1073') }}</h2>
      <p>{{ exporting?.name }}</p>
      <label
        >{{ t('m1075') }}<select v-model.number="exportRevision" :disabled="exportBusy" @change="prepareExportRange">
          <option v-for="r in exportRevisions" :key="r" :value="r">{{ t('m1076', [r]) }}</option>
        </select></label
      >
      <div class="export-height-range">
        <label
          >{{ t('m1077') }}<input
            v-model.number="exportMinY"
            type="number"
            min="-2048"
            max="4095"
            step="1"
            :disabled="exportBusy || exportHeightBusy || !exportBuild" /></label
        ><label
          >{{ t('m1078') }}<input
            v-model.number="exportMaxY"
            type="number"
            min="-2048"
            max="4095"
            step="1"
            :disabled="exportBusy || exportHeightBusy || !exportBuild"
        /></label>
      </div>
      <p class="project-muted">
        {{ t('m1079', [exportHeightNotice]) }}</p>
      <button v-if="!exportBuild && !exportHeightBusy" type="button" @click="prepareExportRange">{{ t('m1080') }}</button>
      <p>
        <label class="export-creatures"
          ><input
            v-model="includeCreatures"
            type="checkbox"
            :disabled="exportBusy"
          />{{ t('m1081') }}</label
        >
      </p>
      <p class="project-muted">{{ t('m1082') }}</p>
      <p v-if="exportIssues.length" class="project-muted">{{ t('m1083', [exportIssues.length]) }}</p>
      <p v-if="exportMessage" role="status">{{ exportMessage }}</p>
      <div class="project-actions">
        <button type="button" @click="cancelExport">{{ t('m1084') }}</button
        ><button
          type="button"
          class="primary"
          :disabled="exportBusy || exportHeightBusy || !exportBuild"
          @click="exportModel"
        >
          {{ exportBusy ? t('m1085') : t('m1086') }}
        </button>
      </div>
    </dialog>
    <dialog
      ref="deleteDialog"
      class="project-delete-dialog"
      aria-labelledby="delete-project-title"
      @cancel="deleting = undefined"
    >
      <h2 id="delete-project-title">{{ t('m1074') }}</h2>
      <p>{{ t('m1087', [deleting?.name]) }}</p>
      <p>{{ t('m1088') }}</p>
      <div class="project-actions">
        <button
          type="button"
          :disabled="busy"
          @click="cancelDelete"
        >{{ t('m0102') }}</button
        ><button
          type="button"
          class="project-delete-button"
          :disabled="busy"
          @click="deleteProject"
        >
          {{ busy ? t('m1089') : t('m1090') }}
        </button>
      </div>
    </dialog>
  </section>
</template>
<style scoped>
.export-height-range {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  margin-top: 16px;
}
.export-height-range label {
  display: grid;
  gap: 6px;
  min-width: 0;
}
.export-height-range input {
  width: 100%;
  min-width: 0;
}
.project-export-dialog .export-creatures {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
}
.project-export-dialog .export-creatures input {
  display: inline-block;
  width: 16px;
  height: 16px;
  margin: 0;
  flex: none;
  accent-color: #16845d;
}
.project-delete-button {
  color: #a23131 !important;
  border-color: #edbcbc !important;
  background: #fff4f2 !important;
}
.project-delete-dialog {
  width: min(90vw, 480px);
  border: 1px solid #dbe5df;
  border-radius: 18px;
  padding: 24px;
  color: #24483c;
}
.project-delete-dialog::backdrop {
  background: #15372877;
}
.project-delete-dialog p {
  line-height: 1.8;
}

.project-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr));
  gap: 16px;
}
.project-card {
  padding: 20px;
  border: 1px solid #d4e6dd;
  border-radius: 14px;
  background: linear-gradient(130deg, #f0fbf3, #f4f7ff);
}
.project-card h3 {
  font-size: 22px;
  overflow-wrap: anywhere;
  margin: 10px 0;
}
.project-card small {
  color: #258265;
}
.project-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}
.project-actions a {
  width: 100%;
  padding: 8px 0;
  color: #127750;
}
.project-form label {
  display: block;
  margin: 14px 0;
}
.project-form input,
.project-form select {
  display: block;
  max-width: 100%;
  margin-top: 6px;
}
.project-coordinates {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
}
.project-coordinates input {
  width: 100%;
}
@media (max-width: 700px) {
  .project-coordinates {
    grid-template-columns: 1fr 1fr;
  }
}
</style>
