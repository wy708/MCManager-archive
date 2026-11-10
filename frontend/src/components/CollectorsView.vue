<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { KeyRound, Copy, ShieldCheck, X, RefreshCw } from '@lucide/vue'
import { api } from '../api'
import { useResource } from '../useResource'
import PlatformStorageView from './PlatformStorageView.vue'
import {
  connectionNames,
  stateNames,
  qualityNames,
  displayTime,
  failure,
  query,
  type CollectorStatus,
} from '../statistics'
const props = defineProps<{ scope: string; revision: number }>()
const emit = defineEmits<{ error: [error: unknown] }>()
const { data, busy, error, refresh } = useResource(
  () => [props.scope, props.revision],
  (signal) => api<CollectorStatus[]>('/collectors' + query(props.scope), { signal }),
  (ex) => emit('error', ex),
)
const settingsTab = ref<'connection' | 'storage'>('connection')
const selected = ref<CollectorStatus>(),
  action = ref<'issue' | 'revoke'>('issue')
const modal = ref<HTMLDialogElement>(),
  tokenField = ref<HTMLTextAreaElement>()
const token = ref(''),
  working = ref(false),
  formError = ref(''),
  message = ref(''),
  copied = ref(false)
let opener: HTMLElement | null = null
let mutated = false
const collectorAddress = new URL('/api/ingest/v1/batches', window.location.origin).toString()
async function open(collector: CollectorStatus, kind: 'issue' | 'revoke') {
  opener = document.activeElement as HTMLElement
  selected.value = collector
  action.value = kind
  token.value = ''
  formError.value = ''
  copied.value = false
  mutated = false
  await nextTick()
  modal.value?.showModal()
}
async function perform() {
  if (!selected.value || working.value) return
  working.value = true
  formError.value = ''
  message.value = ''
  try {
    const path = `/servers/${selected.value.serverId}/collector-credential`
    if (action.value === 'revoke') {
      await api(path, { method: 'DELETE' })
      mutated = true
      message.value = `「${selected.value.serverName}」采集连接密钥已停用`
      modal.value?.close()
    } else {
      const issued = await api<{ token: string }>(path, { method: 'POST' })
      token.value = issued.token
      mutated = true
      await nextTick()
      tokenField.value?.focus()
      tokenField.value?.select()
    }
  } catch (ex) {
    formError.value = failure(ex)
    emit('error', ex)
  } finally {
    working.value = false
  }
}
function close() {
  if (!working.value) modal.value?.close()
}
async function onClose() {
  const id = selected.value?.serverId
  token.value = ''
  selected.value = undefined
  if (mutated) {
    await refresh()
    await nextTick()
    document
      .querySelector<HTMLButtonElement>(`[data-collector-server="${id}"] .collector-actions button`)
      ?.focus()
  } else opener?.focus()
}
async function copy() {
  try {
    await navigator.clipboard.writeText(token.value)
    copied.value = true
  } catch {
    tokenField.value?.focus()
    tokenField.value?.select()
    formError.value = '自动复制不可用，请选中凭据后手动复制。'
  }
}
</script>
<template>
  <section class="collector-workspace">
    <nav class="workspace-tabs" aria-label="平台设置分类">
      <button :aria-pressed="settingsTab === 'connection'" @click="settingsTab = 'connection'">
        游戏插件连接</button
      ><button :aria-pressed="settingsTab === 'storage'" @click="settingsTab = 'storage'">
        数据与存储
      </button>
    </nav>
    <PlatformStorageView v-if="settingsTab === 'storage'" @error="emit('error', $event)" />
    <template v-else>
      <div class="panel data-panel">
        <div class="data-panel-heading">
          <div>
            <h2>游戏插件连接</h2>
            <p>连接密钥类似密码。每台服务器各用一个，生成后填入游戏插件即可连接。</p>
          </div>
          <button class="secondary" :disabled="busy" @click="refresh">
            <RefreshCw :size="16" />刷新状态
          </button>
        </div>
        <p class="data-note">
          <ShieldCheck
            :size="16"
          />“最近已连接”仅表示近期收到合法请求，不能代替游戏采集覆盖或备份验收。
        </p>
      </div>
      <p v-if="message" class="alert success" role="status">{{ message }}</p>
      <p v-if="error" class="alert error" role="alert">
        {{ error }}<button class="text-button" @click="refresh">重试</button>
      </p>
      <p v-else-if="busy" class="small-empty" role="status">正在加载采集状态…</p>
      <div v-else-if="!data?.length" class="panel small-empty">
        <h3>还没有服务器档案</h3>
        <p>添加一期服务器后，再为它配置插件连接密钥。</p>
      </div>
      <article
        v-for="collector in data ?? []"
        :key="collector.serverId"
        :data-collector-server="collector.serverId"
        class="panel collector-card"
      >
        <div class="data-panel-heading">
          <div>
            <h2>{{ collector.serverName }}</h2>
            <code class="identity-key">{{ collector.serverId }}</code>
          </div>
          <span class="neutral-badge" :class="collector.connectionState.toLowerCase()">{{
            connectionNames[collector.connectionState]
          }}</span>
        </div>
        <dl class="collector-details">
          <div>
            <dt>采集版本</dt>
            <dd>{{ collector.collector?.version ?? '尚未连接' }}</dd>
          </div>
          <div>
            <dt>BDS / LeviLamina</dt>
            <dd>
              {{
                collector.collector
                  ? `${collector.collector.bdsVersion} / ${collector.collector.leviLaminaVersion}`
                  : '—'
              }}
            </dd>
          </div>
          <div>
            <dt>最后请求</dt>
            <dd>{{ displayTime(collector.collector?.lastSeenAt) }}</dd>
          </div>
          <div>
            <dt>最近报告的积压</dt>
            <dd>{{ collector.collector?.pendingEvents ?? '—' }}</dd>
          </div>
        </dl>
        <details class="collector-capabilities" aria-label="采集诊断">
          <summary>上传诊断与历史异常</summary>
          <template v-if="collector.diagnostics">
            <p class="data-note">
              {{ collector.diagnostics.finalReport ? '停用前报告' : '最近采集诊断' }} ·
              {{ displayTime(collector.diagnostics.reportedAt) }}
            </p>
            <dl class="collector-details">
              <div>
                <dt>内存待写事件</dt>
                <dd>{{ collector.diagnostics.queuedEvents }}</dd>
              </div>
              <div>
                <dt>拒绝提交次数</dt>
                <dd>{{ collector.diagnostics.rejectedSubmissions }}</dd>
              </div>
              <div>
                <dt>已发现的漏记数量</dt>
                <dd>{{ collector.diagnostics.captureGaps }}</dd>
              </div>
              <div>
                <dt>写盘故障</dt>
                <dd>
                  {{ collector.diagnostics.diskError ? '报告时故障中' : '报告时无故障' }} · 累计
                  {{ collector.diagnostics.diskFaults }} 次
                </dd>
              </div>
            </dl>
            <p class="data-note">
              拒绝提交可能在之后重试。已知缺口按观测计数。进程退出前未能上报的缺口数量未知。
            </p>
          </template>
          <p v-else class="data-note">本次运行尚无诊断报告。</p>
          <details v-if="collector.previousAnomalies?.length">
            <summary>历史采集异常（{{ collector.previousAnomalies.length }} 次运行）</summary>
            <div class="table-scroll" tabindex="0" aria-label="历史采集异常">
              <table>
                <thead>
                  <tr>
                    <th>报告时间</th>
                    <th>拒绝提交</th>
                    <th>已发现的漏记数量</th>
                    <th>写盘故障</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="run in collector.previousAnomalies" :key="run.bootId">
                    <td>
                      {{ displayTime(run.reportedAt)
                      }}<small>{{ run.finalReport ? '停用前报告' : '最后收到的报告' }}</small>
                    </td>
                    <td>{{ run.rejectedSubmissions }}</td>
                    <td>{{ run.captureGaps }}</td>
                    <td>{{ run.diskFaults }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </details>
        </details>
        <div class="collector-actions">
          <span>{{
            collector.credentialConfigured ? '已配置凭据 · 原文不可再次读取' : '未配置插件连接密钥'
          }}</span
          ><button class="secondary" @click="open(collector, 'issue')">
            <KeyRound :size="16" />{{
              collector.credentialConfigured ? '更换连接密钥' : '创建连接密钥'
            }}</button
          ><button
            v-if="collector.credentialConfigured"
            class="text-button danger-text"
            @click="open(collector, 'revoke')"
          >
            停用连接密钥
          </button>
        </div>
        <details class="collector-capabilities">
          <summary>可记录的项目与历史状态（{{ collector.capabilities.length }} 项声明）</summary>
          <div
            v-if="collector.capabilities.length"
            class="table-scroll"
            tabindex="0"
            aria-label="采集能力声明"
          >
            <table>
              <thead>
                <tr>
                  <th>指标</th>
                  <th>状态</th>
                  <th>质量 / 算法</th>
                  <th>维度细分</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="cap in collector.capabilities" :key="cap.metric">
                  <td>
                    <code>{{ cap.metric }}</code>
                  </td>
                  <td>{{ stateNames[cap.state] }}</td>
                  <td>
                    {{ cap.quality ? qualityNames[cap.quality] : '—'
                    }}<small>{{ cap.algorithmVersion }}</small>
                  </td>
                  <td>{{ cap.dimensionAware ? '已声明' : '未声明支持' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="data-note">尚无采集器能力声明，不能据此显示统计零值。</p>
          <p class="data-note">
            已保存 {{ collector.coverage.length }} 项指标 / 质量 / 算法历史。停用不删除这些记录。
          </p>
        </details>
      </article>
    </template>
    <dialog
      ref="modal"
      class="credential-dialog"
      aria-labelledby="credential-title"
      @cancel="working ? $event.preventDefault() : undefined"
      @close="onClose"
    >
      <form @submit.prevent="perform">
        <div class="dialog-heading">
          <div>
            <p class="eyebrow">COLLECTOR CONNECTION</p>
            <h2 id="credential-title">
              {{
                token
                  ? '保存插件连接密钥'
                  : action === 'revoke'
                    ? '撤销插件连接密钥'
                    : selected?.credentialConfigured
                      ? '轮换插件连接密钥'
                      : '创建插件连接密钥'
              }}
            </h2>
          </div>
          <button
            type="button"
            class="icon-button"
            aria-label="关闭凭据对话框"
            :disabled="working"
            @click="close"
          >
            <X :size="20" />
          </button>
        </div>
        <template v-if="token"
          ><p class="alert info">
            此凭据只显示一次。请保存到对应服务器的采集器配置中；关闭后无法再读取。
          </p>
          <label>采集服务地址<input :value="collectorAddress" readonly /></label
          ><label
            >插件连接密钥<textarea
              ref="tokenField"
              :value="token"
              readonly
              rows="3"
              spellcheck="false"
            /></label
          ><button type="button" class="secondary copy-button" @click="copy">
            <Copy :size="16" />{{ copied ? '已复制' : '复制连接密钥' }}
          </button></template
        ><template v-else
          ><p class="dialog-description">服务器：{{ selected?.serverName }}</p>
          <p class="alert info">
            {{
              action === 'revoke'
                ? '撤销后采集器无法继续上传。本地未确认的数据应继续保留，重新配置凭据后补传。'
                : selected?.credentialConfigured
                  ? '生成新连接密钥会立即使旧凭据失效。请准备好更新对应采集器配置，未确认的数据不能丢弃。'
                  : '生成该期专用的随机凭据。请通过 HTTPS 或本机地址连接，避免在不可信的明文网络使用。'
            }}
          </p></template
        >
        <p v-if="formError" class="alert error" role="alert">{{ formError }}</p>
        <div class="dialog-actions">
          <button type="button" class="secondary" :disabled="working" @click="close">
            {{ token ? '已保存，关闭' : '取消' }}</button
          ><button v-if="!token" class="primary" :disabled="working">
            {{ working ? '处理中…' : action === 'revoke' ? '确认撤销' : '生成连接密钥' }}
          </button>
        </div>
      </form>
    </dialog>
  </section>
</template>
