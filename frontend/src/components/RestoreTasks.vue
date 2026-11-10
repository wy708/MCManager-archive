<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, ref, watch } from 'vue'
import { FolderOpen, RefreshCw, ShieldCheck, X } from '@lucide/vue'
import { api, ApiError, type ServerArchive } from '../api'
import { displayTime, failure, query } from '../statistics'
import { newRequestId } from '../ids'
import {
  restoreModes,
  supportsWorldBackup,
  restoreStates,
  restoreDiagnostics,
  validRestoreDraft,
  validRestoreFolder,
  formatRestoreBytes,
  type RestoreSource,
  type RestoreHost,
  type RestoreJob,
  type RestoreDraft,
} from '../restores'
import { useResource } from '../useResource'
import PaginationControl from './PaginationControl.vue'
const props = defineProps<{ servers: ServerArchive[]; scope: string; revision: number }>()
const emit = defineEmits<{ error: [error: unknown]; changed: []; archivesChanged: [] }>()
const page = ref(1),
  working = ref(false),
  opening = ref(false),
  modal = ref<HTMLDialogElement>(),
  heading = ref<HTMLElement>(),
  first = ref<HTMLElement>()
const action = ref<'create' | 'cancel' | 'resolve'>('create'),
  step = ref(1),
  source = ref<RestoreSource>(),
  selectedJob = ref<RestoreJob>()
const mode = ref<RestoreDraft['mode']>('DISABLED'),
  hostId = ref(''),
  folder = ref(''),
  note = ref(''),
  forkName = ref(''),
  forkDate = ref(''),
  outcome = ref('FAILED'),
  acknowledged = ref(false),
  delegated = ref(false),
  formError = ref(''),
  message = ref('')
const proposal = ref<RestoreDraft>(),
  pending = ref<RestoreDraft>()
const storageKey = 'mcmanager.pending-restore.v1'
let opener: HTMLElement | null = null,
  timer: ReturnType<typeof setInterval> | undefined,
  disposed = false
let refreshAfterMutation: Promise<void> | undefined
const { data, busy, error, refresh } = useResource(
  () => [props.scope, props.revision, page.value],
  async (signal) => {
    const [hosts, jobs] = await Promise.all([
      api<RestoreHost[]>('/backup-hosts', { signal }),
      api<{ items: RestoreJob[]; total: number }>(
        '/restores' + query(props.scope, undefined, { page: page.value - 1, size: 10 }),
        { signal },
      ),
    ])
    return { hosts, ...jobs }
  },
  (ex) => emit('error', ex),
)
watch(
  () => props.scope,
  () => {
    page.value = 1
  },
)
const sourceServer = computed(() =>
  props.servers.find((server) => server.id === source.value?.serverId),
)
const canContinue = computed(() => sourceServer.value?.status === 'RECORDING')
const eligible = computed(() =>
  (data.value?.hosts ?? []).filter(
    (host) =>
      !host.revoked &&
      host.restoreEnabled &&
      (source.value?.summary?.archiveScope !== 'WORLD' || supportsWorldBackup(host.version)) &&
      (mode.value !== 'CONTINUE' || host.serverId === source.value?.serverId),
  ),
)
const host = computed(() => data.value?.hosts.find((host) => host.id === hostId.value))
const crossHost = computed(() =>
  Boolean(host.value && source.value && host.value.serverId !== source.value.serverId),
)
const valid = computed(
  () =>
    source.value?.status === 'READY' &&
    eligible.value.some((host) => host.id === hostId.value) &&
    validRestoreFolder(folder.value) &&
    (mode.value !== 'CONTINUE' || canContinue.value) &&
    (mode.value !== 'FORK' || (forkName.value.trim().length > 0 && Boolean(forkDate.value))) &&
    (!crossHost.value || delegated.value),
)
const title = computed(() =>
  action.value === 'create'
    ? step.value === 1
      ? '恢复到新目录'
      : '核对恢复方案'
    : action.value === 'cancel'
      ? '取消恢复任务'
      : '核实恢复结果',
)
function serverName(id: string) {
  return props.servers.find((server) => server.id === id)?.name ?? id
}
function hostName(id: string) {
  return data.value?.hosts.find((host) => host.id === id)?.name ?? id
}
function keep(value?: RestoreDraft) {
  if (value) {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(value))
    } catch {
      const error = new Error('浏览器无法保存原请求，尚未提交。请允许本页面使用会话存储后重试。')
      error.name = 'RestoreStorageError'
      throw error
    }
    pending.value = value
  } else {
    pending.value = undefined
    try {
      sessionStorage.removeItem(storageKey)
    } catch {
      /* A stale saved draft can only retry the original idempotent request. */
    }
  }
}
function readPending() {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null')
    if (validRestoreDraft(value))
      pending.value = {
        backupId: value.backupId,
        requestId: value.requestId,
        hostId: value.hostId,
        mode: value.mode,
        destinationName: value.destinationName,
        note: value.note,
        forkName: value.forkName,
        forkStartDate: value.forkStartDate,
      }
  } catch {
    /* Never submit invalid browser state. */
  }
}
function applyDraft(value: RestoreDraft) {
  proposal.value = { ...value }
  mode.value = value.mode
  hostId.value = value.hostId
  folder.value = value.destinationName
  note.value = value.note
  forkName.value = value.forkName ?? ''
  forkDate.value = value.forkStartDate ?? ''
}
async function open(backup?: RestoreSource) {
  if (working.value || opening.value) return
  opening.value = true
  opener = document.activeElement as HTMLElement
  formError.value = ''
  action.value = 'create'
  selectedJob.value = undefined
  acknowledged.value = false
  delegated.value = false
  proposal.value = undefined
  mode.value = 'DISABLED'
  folder.value = ''
  note.value = ''
  forkName.value = ''
  forkDate.value = new Date().toLocaleDateString('sv-SE')
  step.value = 1
  try {
    if (pending.value) {
      source.value = await api<RestoreSource>('/backups/' + pending.value.backupId)
      applyDraft(pending.value)
      step.value = 2
    } else {
      source.value = backup
      hostId.value = ''
    }
    await refresh()
    if (!proposal.value)
      hostId.value =
        eligible.value.find((host) => host.serverId === backup?.serverId)?.id ??
        eligible.value[0]?.id ??
        ''
    await nextTick()
    modal.value?.showModal()
    first.value?.focus()
  } catch (ex) {
    message.value = failure(ex)
    emit('error', ex)
  } finally {
    opening.value = false
  }
}
function changeMode() {
  delegated.value = false
  if (!eligible.value.some((host) => host.id === hostId.value))
    hostId.value = eligible.value[0]?.id ?? ''
}
function review() {
  if (!source.value || !valid.value) return
  proposal.value = {
    backupId: source.value.id,
    requestId: newRequestId(),
    hostId: hostId.value,
    mode: mode.value,
    destinationName: folder.value,
    note: note.value.trim(),
    forkName: mode.value === 'FORK' ? forkName.value.trim() : null,
    forkStartDate: mode.value === 'FORK' ? forkDate.value : null,
  }
  step.value = 2
  acknowledged.value = false
  nextTick(() => {
    modal.value?.scrollTo({ top: 0 })
    heading.value?.focus({ preventScroll: true })
  })
}
function back() {
  if (!pending.value) {
    step.value = 1
    proposal.value = undefined
    formError.value = ''
    nextTick(() => first.value?.focus())
  }
}
async function manage(kind: 'cancel' | 'resolve', job: RestoreJob) {
  opener = document.activeElement as HTMLElement
  action.value = kind
  selectedJob.value = job
  formError.value = ''
  note.value = ''
  outcome.value = 'FAILED'
  await nextTick()
  modal.value?.showModal()
  first.value?.focus()
}
function close() {
  if (!working.value) modal.value?.close()
}
async function afterClose() {
  if (disposed) return
  await refreshAfterMutation
  if (disposed) return
  await nextTick()
  if (opener?.isConnected && opener !== document.body && opener.getClientRects().length)
    opener.focus()
  else document.querySelector<HTMLButtonElement>('[data-refresh-restores]')?.focus()
}
async function perform() {
  if (working.value) return
  if (action.value === 'create' && step.value === 1) {
    review()
    return
  }
  if (action.value === 'create' && (!proposal.value || !acknowledged.value)) return
  if (action.value === 'resolve' && (!note.value.trim() || /[\p{Cc}]/u.test(note.value.trim())))
    return
  working.value = true
  formError.value = ''
  message.value = ''
  const abort = new AbortController(),
    timeout = setTimeout(() => abort.abort(), 20000)
  try {
    if (action.value === 'create') {
      const saved = proposal.value!
      keep(saved)
      const { backupId, ...body } = saved
      const result = await api<RestoreJob>('/backups/' + backupId + '/restores', {
        method: 'POST',
        signal: abort.signal,
        body: JSON.stringify(body),
      })
      keep()
      message.value = '恢复任务已确认：' + (restoreStates[result.status] ?? '等待状态更新') + '。'
      if (saved.mode === 'FORK') emit('archivesChanged')
    } else if (action.value === 'cancel') {
      const result = await api<RestoreJob>('/restores/' + selectedJob.value!.id + '/cancel', {
        method: 'POST',
        signal: abort.signal,
      })
      message.value =
        result.status === 'CANCELLED'
          ? '任务已取消，原目录与文件仍保留。'
          : result.cancelRequested
            ? '已请求取消，等待执行端确认；不会删除现场。'
            : '任务状态已更新，请查看结果。'
    } else {
      await api('/restores/' + selectedJob.value!.id + '/resolve', {
        method: 'POST',
        signal: abort.signal,
        body: JSON.stringify({ outcome: outcome.value, note: note.value.trim() }),
      })
      message.value = '核实结果已保存，原目录和诊断仍保留。'
    }
    refreshAfterMutation = refresh()
    modal.value?.close()
    emit('changed')
    await refreshAfterMutation
    refreshAfterMutation = undefined
  } catch (ex) {
    if (ex instanceof Error && ex.name === 'RestoreStorageError') formError.value = ex.message
    else if (
      action.value === 'create' &&
      proposal.value &&
      (!(ex instanceof ApiError) || [401, 403, 408, 429].includes(ex.status) || ex.status >= 500)
    )
      formError.value = '提交结果尚未确认。请核实同一个请求，避免重复恢复或创建新一期。'
    else {
      formError.value = failure(ex)
      if (
        action.value === 'create' &&
        ex instanceof ApiError &&
        [400, 404, 409].includes(ex.status)
      ) {
        keep()
        proposal.value = undefined
        step.value = 1
      }
    }
    emit('error', ex)
    await refresh()
  } finally {
    clearTimeout(timeout)
    working.value = false
  }
}
onMounted(() => {
  readPending()
  timer = setInterval(() => {
    if (
      !busy.value &&
      !working.value &&
      !modal.value?.open &&
      document.visibilityState === 'visible'
    )
      void refresh()
  }, 5000)
})
onScopeDispose(() => {
  disposed = true
  clearInterval(timer)
  modal.value?.close()
})
defineExpose({ open })
</script>
<template>
  <section class="restore-workspace" aria-label="新目录恢复任务">
    <article class="panel data-panel">
      <div class="data-panel-heading">
        <div>
          <h2>恢复任务</h2>
          <p>把备份解压到新的目录，原世界不覆盖</p>
        </div>
        <button data-refresh-restores class="secondary" :disabled="busy" @click="refresh">
          <RefreshCw :size="16" />刷新恢复任务
        </button>
      </div>
      <p class="data-note">
        <ShieldCheck
          :size="16"
        />从下方已校验的归档选择“恢复到新目录”。文件准备完成后仍需实际启动并检查游戏。
      </p>
    </article>
    <p v-if="pending" class="alert info">
      上次提交尚未核实，先确认原请求，避免再次创建任务。<button class="text-button" @click="open()">
        核实上次提交
      </button>
    </p>
    <p v-if="message" class="alert info" role="status">{{ message }}</p>
    <p v-if="error" class="alert error" role="alert">
      {{ error }}<button class="text-button" @click="refresh">重试恢复列表</button>
    </p>
    <p v-else-if="busy" class="data-note" role="status">正在读取恢复任务…</p>
    <article
      v-for="job in data?.items ?? []"
      :key="job.id"
      class="panel restore-card"
      :data-restore="job.id"
    >
      <div class="data-panel-heading">
        <div>
          <h3>{{ serverName(job.sourceServerId) }} → {{ serverName(job.targetServerId) }}</h3>
          <p>
            {{ restoreModes[job.mode as keyof typeof restoreModes] }} ·
            {{ displayTime(job.createdAt) }}
          </p>
        </div>
        <span class="neutral-badge">{{
          job.cancelRequested && ['RUNNING', 'UNCERTAIN'].includes(job.status)
            ? '已请求取消，等待核实'
            : (restoreStates[job.status] ?? '状态待确认')
        }}</span>
      </div>
      <p class="data-note">
        <FolderOpen :size="16" />{{ hostName(job.hostId) }} · 新目录 {{ job.destinationName }}
      </p>
      <p v-if="job.note" class="restore-note">{{ job.note }}</p>
      <p v-if="job.status === 'READY'" class="alert info">
        文件准备完成，尚未确认实际游玩。结束恢复维护后，按目标档案配置执行端，再启动并检查世界和背包。
      </p>
      <p v-else-if="job.status === 'UNCERTAIN'" class="alert info">
        先核对原目录和执行进程。完整且未修改的文件可由执行端补交原回执；不完整的现场不会自动再次解包。
      </p>
      <p v-else-if="job.status === 'QUEUED'" class="data-note">
        等待已启用恢复的执行端领取。继续原一期时，原游戏必须停止并进入维护模式。
      </p>
      <p v-if="job.errorCode" class="data-note">
        {{ restoreDiagnostics[job.errorCode] ?? '请检查执行端的原始诊断。' }}
      </p>
      <p v-if="job.resolutionNote" class="data-note">核实说明：{{ job.resolutionNote }}</p>
      <div class="restore-actions">
        <button
          v-if="['QUEUED', 'CLAIMED', 'RUNNING'].includes(job.status) && !job.cancelRequested"
          class="secondary"
          :disabled="busy || !!error"
          @click="manage('cancel', job)"
        >
          {{ job.status === 'RUNNING' ? '请求取消恢复' : '取消恢复任务' }}</button
        ><button
          v-if="job.status === 'UNCERTAIN'"
          class="secondary"
          :disabled="busy || !!error"
          @click="manage('resolve', job)"
        >
          核实处理结果
        </button>
      </div>
      <details class="restore-proof">
        <summary>查看身份与文件校验</summary>
        <dl>
          <dt>任务编号</dt>
          <dd>
            <code>{{ job.id }}</code>
          </dd>
          <dt>原始备份身份</dt>
          <dd>
            <code>{{ job.sourceBackupId }}</code>
          </dd>
          <dt>目标档案身份</dt>
          <dd>
            <code>{{ job.targetServerId }}</code>
          </dd>
          <dt>原归档 SHA-256</dt>
          <dd>
            <code>{{ job.archiveSha256 }}</code>
          </dd>
          <dt>文件数 / 归档大小</dt>
          <dd>{{ job.fileCount }} / {{ formatRestoreBytes(job.archiveBytes) }}</dd>
          <dt>恢复身份</dt>
          <dd>
            <code>{{ job.restorationId ?? '尚未确认' }}</code>
          </dd>
        </dl>
        <p class="data-note">恢复旧世界不回滚中央统计历史；独立检查和新一期会隔离旧采集缓存。</p>
      </details>
    </article>
    <PaginationControl
      v-if="(data?.total ?? 0) > 10"
      :page="page"
      :total="data?.total ?? 0"
      :page-size="10"
      :busy="busy"
      @change="page = $event"
    />
    <dialog
      ref="modal"
      class="credential-dialog restore-dialog"
      aria-labelledby="restore-title"
      @cancel="working ? $event.preventDefault() : undefined"
      @close="afterClose"
    >
      <form @submit.prevent="perform">
        <div class="dialog-heading">
          <h2 id="restore-title" ref="heading" tabindex="-1">{{ title }}</h2>
          <button
            type="button"
            class="icon-button"
            aria-label="关闭恢复窗口"
            :disabled="working"
            @click="close"
          >
            <X :size="20" />
          </button>
        </div>
        <template v-if="action === 'create' && source">
          <p class="dialog-description">
            来源：{{ serverName(source.serverId) }} · {{ source.fileCount ?? '未确认' }} 个文件 ·
            {{ formatRestoreBytes(source.archiveBytes) }}
          </p>
          <template v-if="step === 1">
            <label
              >恢复方式<select
                ref="first"
                v-model="mode"
                aria-label="恢复方式"
                @change="changeMode"
              >
                <option value="DISABLED">独立检查，关闭采集（推荐先检查）</option>
                <option
                  value="CONTINUE"
                  :disabled="!canContinue || source?.summary?.archiveScope === 'WORLD'"
                >
                  继续原一期{{ canContinue ? '' : '（原档案已封存）' }}
                </option>
                <option value="FORK" :disabled="source?.summary?.archiveScope === 'WORLD'">
                  创建新一期
                </option>
              </select></label
            >
            <p class="data-note">
              {{
                source?.summary?.archiveScope === 'WORLD'
                  ? '仅解压世界存档到新目录，不启动游戏，不修改插件或平台历史。备份程序需要 0.7.0 或更高版本。'
                  : mode === 'CONTINUE'
                    ? '保留原 UUID 与中央新历史，原缓存按事件身份去重。须使用原一期执行端与当前有效插件连接密钥，并停止原游戏进入恢复维护。'
                    : mode === 'FORK'
                      ? '新建独立档案与插件连接密钥，隔离旧缓存；不把旧聊天或统计复制到新一期。'
                      : '保留来源身份但关闭采集，隔离旧缓存，适合独立检查。'
              }}
            </p>
            <label
              >恢复程序<select
                v-model="hostId"
                aria-label="恢复程序"
                required
                @change="delegated = false"
              >
                <option value="" disabled>选择已启用恢复的执行端</option>
                <option v-for="item in eligible" :key="item.id" :value="item.id">
                  {{ item.name }} · {{ serverName(item.serverId) }} ·
                  {{
                    item.online
                      ? item.runtimeState === 'STOPPED'
                        ? '维护中'
                        : '已连接'
                      : '离线等待'
                  }}
                </option>
              </select></label
            >
            <p v-if="!eligible.length" class="data-note">
              尚无可用备份程序。在本地主机配置 restoreDirectory，使用 0.4.0
              或更新的宿主工具连接后再刷新。继续原一期还要求原档案仍在记录中。
            </p>
            <label v-if="crossHost" class="restore-check"
              ><input v-model="delegated" type="checkbox" />确认把这份来源归档交给“{{
                host?.name
              }}”读取并恢复</label
            >
            <label
              >新目录名称<input
                v-model="folder"
                required
                maxlength="64"
                placeholder="例如：一期-恢复检查"
                autocomplete="off"
            /></label>
            <p class="data-note">
              只填一个新名称，允许汉字、字母、数字、下划线和短横线。父目录取自主机本地配置；已存在或用过的目标名称不能覆盖。
            </p>
            <template v-if="mode === 'FORK'"
              ><label
                >新一期名称<input
                  v-model="forkName"
                  required
                  maxlength="64"
                  autocomplete="off" /></label
              ><label>新一期开服日期<input v-model="forkDate" type="date" required /></label
            ></template>
            <label>恢复备注<textarea v-model="note" rows="2" maxlength="1000" /></label>
          </template>
          <template v-else-if="proposal">
            <dl class="restore-review">
              <dt>世界快照时间</dt>
              <dd>{{ displayTime(source.snapshotAt ?? source.createdAt) }}</dd>
              <dt>恢复方式</dt>
              <dd>{{ restoreModes[proposal.mode] }}</dd>
              <dt>执行端</dt>
              <dd>{{ hostName(proposal.hostId) }} · {{ serverName(host?.serverId ?? '') }}</dd>
              <dt>目标新目录</dt>
              <dd>{{ proposal.destinationName }}</dd>
              <dt>目标档案</dt>
              <dd>
                {{
                  proposal.mode === 'FORK'
                    ? proposal.forkName + ' · ' + proposal.forkStartDate
                    : serverName(source.serverId) + '（保持原身份）'
                }}
              </dd>
              <dt>原文件摘要</dt>
              <dd>
                <code>{{ source.sha256 ?? '未确认' }}</code>
              </dd>
              <dt>采集缓存</dt>
              <dd>
                {{
                  source.summary?.statistics?.cacheIntegrity === 'VERIFIED'
                    ? '摘要校验通过'
                    : '未核实'
                }}
                · 待传事件 {{ source.summary?.statistics?.pendingEvents ?? '未知' }}
              </dd>
              <dt>缓存中最大已确认事件时间</dt>
              <dd>
                {{ displayTime(source.summary?.statistics?.latestAcknowledgedEventAt)
                }}<small class="data-note">不表示此前所有统计均已上传。</small>
              </dd>
            </dl>
            <p class="alert info">
              游戏世界会回到快照时刻，中央已有历史继续保留。此归档不包含平台或插件外部数据库。执行中与结果待核实期间，归档会被占用，不能删除或自动清理旧备份。
            </p>
            <label class="restore-check"
              ><input
                ref="first"
                v-model="acknowledged"
                :disabled="working"
                type="checkbox"
              />确认使用新目录，并理解文件准备完成不代表已验证实际游玩</label
            >
          </template>
        </template>
        <template v-else-if="selectedJob"
          ><p class="dialog-description">
            {{ hostName(selectedJob.hostId) }} · {{ selectedJob.destinationName }}
          </p>
          <p class="alert info">
            {{
              action === 'cancel'
                ? '尚未开始可直接取消；已经开始须等待执行端安全收尾。原目录、临时文件与诊断都保留。'
                : '先确认原执行进程与新目录的实际结果。此操作只记录失败或取消，不会删除现场，也不能标记为已验证游玩；再次恢复须使用新任务与新目录名。'
            }}
          </p>
          <template v-if="action === 'resolve'"
            ><label
              >核实结果<select
                ref="first"
                v-model="outcome"
                aria-label="核实结果"
                :disabled="working"
              >
                <option value="FAILED">标记失败</option>
                <option value="CANCELLED">标记取消</option>
              </select></label
            ><label
              >核实说明<input
                v-model="note"
                :disabled="working"
                required
                maxlength="1000"
                autocomplete="off" /></label></template
        ></template>
        <p v-if="formError" class="alert error" role="alert">{{ formError }}</p>
        <div class="dialog-actions">
          <button type="button" class="secondary" :disabled="working" @click="close">返回</button
          ><button
            v-if="action === 'create' && step === 2 && !pending"
            type="button"
            class="secondary"
            :disabled="working"
            @click="back"
          >
            修改方案</button
          ><button
            class="primary"
            :disabled="
              working ||
              (action === 'create' && (step === 1 ? !valid : !acknowledged)) ||
              (action === 'resolve' && (!note.trim() || /[\p{Cc}]/u.test(note.trim())))
            "
          >
            {{
              working
                ? '正在处理…'
                : action === 'create'
                  ? step === 1
                    ? '下一步，核对方案'
                    : pending
                      ? '重试并核实原任务'
                      : '创建恢复任务'
                  : action === 'cancel'
                    ? '确认取消恢复'
                    : '保存核实结果'
            }}
          </button>
        </div>
      </form>
    </dialog>
  </section>
</template>
<style scoped>
.restore-workspace {
  display: grid;
  gap: 16px;
  min-width: 0;
}
.restore-card {
  padding: 22px;
  min-width: 0;
}
.restore-card h3,
.restore-note {
  overflow-wrap: anywhere;
}
.restore-note {
  white-space: pre-wrap;
  font-size: 13px;
}
.restore-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 14px;
}
.restore-proof {
  margin-top: 16px;
  border-top: 1px solid #e2e9e5;
  padding-top: 12px;
}
.restore-proof summary {
  cursor: pointer;
  color: #527064;
  font-size: 12px;
}
.restore-proof dl,
.restore-review {
  display: grid;
  grid-template-columns: minmax(90px, 0.7fr) minmax(0, 2fr);
  gap: 12px;
  font-size: 12px;
  margin: 18px 0;
}
.restore-proof dt,
.restore-review dt {
  color: #6d7e74;
}
.restore-proof dd,
.restore-review dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.restore-check {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  gap: 10px;
  line-height: 1.7;
  font-size: 13px;
}
.restore-check input {
  width: 17px;
  height: 17px;
  margin-top: 3px;
  flex-shrink: 0;
}
@media (max-width: 560px) {
  .restore-card {
    padding: 18px;
  }
  .restore-proof dl,
  .restore-review {
    grid-template-columns: 1fr;
    gap: 7px;
  }
  .restore-review dd,
  .restore-proof dd {
    margin-bottom: 5px;
  }
}
</style>
