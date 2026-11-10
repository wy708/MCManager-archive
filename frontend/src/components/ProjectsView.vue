<script setup lang="ts">
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
    message.value = '工程已删除，公开链接已失效。服务器原始统计保留。'
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '删除失败，请重试'
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
      exportMessage.value = e instanceof Error ? e.message : '阶段读取失败'
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
  exportMessage.value = '正在读取可导出的高度范围…'
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
          `已采集模型：Y ${range.minY} ～ ${range.maxY}。` +
          (saved
            ? '已填入本浏览器保存的预览范围，请确认。'
            : range.basis === 'PLAYER_PLACEMENT'
              ? '默认从玩家放置方块的最低高度开始，请确认。'
              : '暂无可用放置记录，默认按已采集地表估算，请确认。')
        exportMessage.value = ''
        return
      }
      if (['FAILED', 'UNAVAILABLE', 'WAITING'].includes(state.state)) throw new Error(state.message)
      if (Date.now() > deadline) throw new Error('模型仍在准备中，请稍后重新打开导出窗口。')
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }
  } catch (e) {
    if (!controller.signal.aborted)
      exportMessage.value = e instanceof Error ? e.message : '高度范围读取失败'
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
    exportMessage.value = '请填写有效的最低和最高导出高度（-2048 至 4095），最低不能高于最高。'
    return
  }
  exportController?.abort()
  const controller = new AbortController()
  exportController = controller
  exportBusy.value = true
  exportMessage.value = '正在准备所选高度的模型和贴图…'
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
        link.download = project.name + '-阶段' + revision + '-Y' + minY + '至' + maxY + '.glb'
        document.body.appendChild(link)
        link.click()
        link.remove()
        exportMessage.value = `已开始下载 Y ${minY} ～ ${maxY} 的 GLB 模型，文件内包含贴图。`
        return
      }
      if (['FAILED', 'UNAVAILABLE', 'WAITING'].includes(state.state)) throw new Error(state.message)
      if (Date.now() > deadline) throw new Error('模型仍在准备中，请稍后重试；转换会在后台继续。')
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }
  } catch (e) {
    if (!controller.signal.aborted)
      exportMessage.value = e instanceof Error ? e.message : '导出未完成，请重试'
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
    if (ticket === generation) error.value = e instanceof Error ? e.message : '读取失败'
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
    error.value = e instanceof Error ? e.message : '操作失败。可以重试相同请求。'
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <section class="projects-admin">
    <div class="project-banner">
      <div>
        <h2>让每一座建筑都有故事</h2>
        <p>按服务器整理工程，记录方块与建设者，完工后永久留念。</p>
      </div>
      <button v-if="!props.readonly" class="primary" @click="newProject">新建工程</button>
    </div>
    <details class="project-command-help">
      <summary>在游戏里或通过 AI 管理工程</summary>
      <p class="project-muted">
        玩家可在游戏内使用 /project pos1、pos2 选点，再用 /project create 工程名创建。修改范围用
        /project range 工程名；完成用 finish，继续用 resume。AI 操作会校验绑定的创建者。
      </p>
    </details>
    <div class="project-library-tools">
      <label>查找工程<input v-model="search" type="search" placeholder="工程名称或创建者" /></label>
      <div class="segmented">
        <button :aria-pressed="stateFilter === 'all'" @click="stateFilter = 'all'">
          全部 {{ projectCounts.all }}</button
        ><button :aria-pressed="stateFilter === 'ACTIVE'" @click="stateFilter = 'ACTIVE'">
          施工中 {{ projectCounts.active }}</button
        ><button :aria-pressed="stateFilter === 'COMPLETE'" @click="stateFilter = 'COMPLETE'">
          已封存 {{ projectCounts.complete }}
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
      <h3>{{ editing ? '修改施工范围：' + editing.name : '管理员创建工程' }}</h3>
      <p class="project-muted">
        {{
          editing
            ? '修改后开始新阶段，旧范围、地图和统计保留。'
            : '管理员创建的工程由后台管理；玩家自己创建请使用游戏命令或已绑定的 AI。'
        }}两个点只限定 X/Z，包含所有高度。
      </p>
      <label v-if="create"
        >服务器<select v-model="form.serverId" required>
          <option
            v-for="s in visible.filter((s) => s.status === 'RECORDING')"
            :key="s.id"
            :value="s.id"
          >
            {{ s.name }}
          </option>
        </select></label
      >
      <label v-if="create">工程名称<input v-model="form.name" maxlength="80" required /></label>
      <label
        >维度<select v-model="form.dimension" :disabled="!!editing">
          <option value="minecraft:overworld">主世界</option>
          <option value="minecraft:nether">下界</option>
          <option value="minecraft:the_end">末地</option>
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
      <button class="primary" :disabled="busy">{{ busy ? '正在保存…' : '保存' }}</button>
      <button type="button" @click="cancelEdit">
        取消
      </button>
    </form>
    <section v-for="group in filteredGroups" :key="group.server.id" class="project-panel">
      <h2>{{ group.server.name }}</h2>
      <p v-if="!group.projects.length" class="project-empty">
        {{
          search || stateFilter !== 'all'
            ? '没有符合条件的工程，试试调整搜索或状态。'
            : '还没有工程，创建后会显示在这里。'
        }}
      </p>
      <div class="project-cards">
        <article v-for="p in group.projects" :key="p.id" class="project-card">
          <small class="project-state-chip"
            >{{ statusName(p.status) }} · 第 {{ p.revision }} 阶段</small
          >
          <h3>{{ p.name }}</h3>
          <p>{{ p.creator }} 创建</p>
          <p class="project-muted">
            X {{ p.minX }} ～ {{ p.maxX }} · Z {{ p.minZ }} ～ {{ p.maxZ }}
          </p>
          <div class="project-actions">
            <a :href="p.publicUrl" target="_blank" rel="noopener">打开公开施工地图 ↗</a
            ><a :href="p.publicUrl + '#model'" target="_blank" rel="noopener">三维建筑 ↗</a
            ><button
              v-if="!props.readonly && p.status === 'ACTIVE'"
              :disabled="busy"
              @click="edit(p)"
            >
              修改范围</button
            ><button
              v-if="!props.readonly && p.status === 'ACTIVE'"
              :disabled="busy"
              @click="operate('COMPLETE', p)"
            >
              完成封存</button
            ><button
              v-if="!props.readonly && p.status === 'COMPLETE'"
              :disabled="busy"
              @click="operate('RESUME', p)"
            >
              继续施工</button
            ><button v-if="!props.readonly" :disabled="busy" @click="openExport(p)">
              导出 3D 模型</button
            ><button
              v-if="!props.readonly"
              class="project-delete-button"
              :disabled="busy"
              @click="confirmDelete(p)"
            >
              删除工程
            </button>
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
      <h2 id="export-project-title">导出 3D 模型</h2>
      <p>{{ exporting?.name }}</p>
      <label
        >记录阶段
        <select v-model.number="exportRevision" :disabled="exportBusy" @change="prepareExportRange">
          <option v-for="r in exportRevisions" :key="r" :value="r">第 {{ r }} 阶段</option>
        </select></label
      >
      <div class="export-height-range">
        <label
          >最低导出高度 Y<input
            v-model.number="exportMinY"
            type="number"
            min="-2048"
            max="4095"
            step="1"
            :disabled="exportBusy || exportHeightBusy || !exportBuild" /></label
        ><label
          >最高导出高度 Y<input
            v-model.number="exportMaxY"
            type="number"
            min="-2048"
            max="4095"
            step="1"
            :disabled="exportBusy || exportHeightBusy || !exportBuild"
        /></label>
      </div>
      <p class="project-muted">
        {{
          exportHeightNotice
        }}
        导出包含起止两层方块，高度之外的几何不会写入文件。此设置不会修改工程采集范围。
      </p>
      <button v-if="!exportBuild && !exportHeightBusy" type="button" @click="prepareExportRange">
        重新读取高度
      </button>
      <p>
        <label class="export-creatures"
          ><input
            v-model="includeCreatures"
            type="checkbox"
            :disabled="exportBusy"
          />包含动物和怪物</label
        >
      </p>
      <p class="project-muted">
        默认导出建筑、地形、盔甲架及其装备、告示牌和展示框。掉落物不记录。GLB 包含模型和贴图；在
        Blender 中使用“文件 → 导入 → glTF 2.0”，切换“材质预览”查看贴图。水流保持采集时的形状。
      </p>
      <p v-if="exportIssues.length" class="project-muted">
        当前场景有 {{ exportIssues.length }} 项内容尚未完整显示，导出也会保留这些缺口。
      </p>
      <p v-if="exportMessage" role="status">{{ exportMessage }}</p>
      <div class="project-actions">
        <button type="button" @click="cancelExport">关闭</button
        ><button
          type="button"
          class="primary"
          :disabled="exportBusy || exportHeightBusy || !exportBuild"
          @click="exportModel"
        >
          {{ exportBusy ? '正在准备…' : '下载 GLB 模型' }}
        </button>
      </div>
    </dialog>
    <dialog
      ref="deleteDialog"
      class="project-delete-dialog"
      aria-labelledby="delete-project-title"
      @cancel="deleting = undefined"
    >
      <h2 id="delete-project-title">删除工程</h2>
      <p>确定删除「{{ deleting?.name }}」吗？</p>
      <p>
        该工程的公开地图、三维模型、贡献统计和所有历史阶段将被清除，链接立即失效，无法通过继续施工恢复。服务器原始行为记录和总统计保留。
      </p>
      <div class="project-actions">
        <button
          type="button"
          :disabled="busy"
          @click="cancelDelete"
        >
          取消</button
        ><button
          type="button"
          class="project-delete-button"
          :disabled="busy"
          @click="deleteProject"
        >
          {{ busy ? '正在删除…' : '确认删除' }}
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
