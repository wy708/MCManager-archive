<script setup lang="ts">
import { t } from '../i18n'

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
      message.value = t('m0609', [selected.value.serverName])
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
    formError.value = t('m0610')
  }
}
</script>
<template>
  <section class="collector-workspace">
    <nav class="workspace-tabs" :aria-label="t('m0611')">
      <button :aria-pressed="settingsTab === 'connection'" @click="settingsTab = 'connection'">{{ t('m0612') }}</button
      ><button :aria-pressed="settingsTab === 'storage'" @click="settingsTab = 'storage'">{{ t('m0613') }}</button>
    </nav>
    <PlatformStorageView v-if="settingsTab === 'storage'" @error="emit('error', $event)" />
    <template v-else>
      <div class="panel data-panel">
        <div class="data-panel-heading">
          <div>
            <h2>{{ t('m0612') }}</h2>
            <p>{{ t('m0614') }}</p>
          </div>
          <button class="secondary" :disabled="busy" @click="refresh">
            <RefreshCw :size="16" />{{ t('m0615') }}</button>
        </div>
        <p class="data-note">
          <ShieldCheck
            :size="16"
          />{{ t('m0616') }}</p>
      </div>
      <p v-if="message" class="alert success" role="status">{{ message }}</p>
      <p v-if="error" class="alert error" role="alert">
        {{ error }}<button class="text-button" @click="refresh">{{ t('m0337') }}</button>
      </p>
      <p v-else-if="busy" class="small-empty" role="status">{{ t('m0617') }}</p>
      <div v-else-if="!data?.length" class="panel small-empty">
        <h3>{{ t('m0067') }}</h3>
        <p>{{ t('m0618') }}</p>
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
            <dt>{{ t('m0619') }}</dt>
            <dd>{{ collector.collector?.version ?? t('m0268') }}</dd>
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
            <dt>{{ t('m0620') }}</dt>
            <dd>{{ displayTime(collector.collector?.lastSeenAt) }}</dd>
          </div>
          <div>
            <dt>{{ t('m0621') }}</dt>
            <dd>{{ collector.collector?.pendingEvents ?? '—' }}</dd>
          </div>
        </dl>
        <details class="collector-capabilities" :aria-label="t('m0622')">
          <summary>{{ t('m0623') }}</summary>
          <template v-if="collector.diagnostics">
            <p class="data-note">
              {{ collector.diagnostics.finalReport ? t('m0624') : t('m0625') }} ·
              {{ displayTime(collector.diagnostics.reportedAt) }}
            </p>
            <dl class="collector-details">
              <div>
                <dt>{{ t('m0626') }}</dt>
                <dd>{{ collector.diagnostics.queuedEvents }}</dd>
              </div>
              <div>
                <dt>{{ t('m0627') }}</dt>
                <dd>{{ collector.diagnostics.rejectedSubmissions }}</dd>
              </div>
              <div>
                <dt>{{ t('m0628') }}</dt>
                <dd>{{ collector.diagnostics.captureGaps }}</dd>
              </div>
              <div>
                <dt>{{ t('m0629') }}</dt>
                <dd>
                  {{ t('m0632', [collector.diagnostics.diskError ? t('m0630') : t('m0631'), collector.diagnostics.diskFaults]) }}</dd>
              </div>
            </dl>
            <p class="data-note">{{ t('m0633') }}</p>
          </template>
          <p v-else class="data-note">{{ t('m0634') }}</p>
          <details v-if="collector.previousAnomalies?.length">
            <summary>{{ t('m0635', [collector.previousAnomalies.length]) }}</summary>
            <div class="table-scroll" tabindex="0" :aria-label="t('m0636')">
              <table>
                <thead>
                  <tr>
                    <th>{{ t('m0637') }}</th>
                    <th>{{ t('m0638') }}</th>
                    <th>{{ t('m0628') }}</th>
                    <th>{{ t('m0629') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="run in collector.previousAnomalies" :key="run.bootId">
                    <td>
                      {{ displayTime(run.reportedAt)
                      }}<small>{{ run.finalReport ? t('m0624') : t('m0639') }}</small>
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
            collector.credentialConfigured ? t('m0640') : t('m0641')
          }}</span
          ><button class="secondary" @click="open(collector, 'issue')">
            <KeyRound :size="16" />{{
              collector.credentialConfigured ? t('m0345') : t('m0642')
            }}</button
          ><button
            v-if="collector.credentialConfigured"
            class="text-button danger-text"
            @click="open(collector, 'revoke')"
          >{{ t('m0643') }}</button>
        </div>
        <details class="collector-capabilities">
          <summary>{{ t('m0644', [collector.capabilities.length]) }}</summary>
          <div
            v-if="collector.capabilities.length"
            class="table-scroll"
            tabindex="0"
            :aria-label="t('m0645')"
          >
            <table>
              <thead>
                <tr>
                  <th>{{ t('m0646') }}</th>
                  <th>{{ t('m0461') }}</th>
                  <th>{{ t('m0647') }}</th>
                  <th>{{ t('m0648') }}</th>
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
                  <td>{{ cap.dimensionAware ? t('m0649') : t('m0650') }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="data-note">{{ t('m0651') }}</p>
          <p class="data-note">{{ t('m0652', [collector.coverage.length]) }}</p>
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
                  ? t('m0653')
                  : action === 'revoke'
                    ? t('m0654')
                    : selected?.credentialConfigured
                      ? t('m0655')
                      : t('m0656')
              }}
            </h2>
          </div>
          <button
            type="button"
            class="icon-button"
            :aria-label="t('m0657')"
            :disabled="working"
            @click="close"
          >
            <X :size="20" />
          </button>
        </div>
        <template v-if="token"
          ><p class="alert info">{{ t('m0658') }}</p>
          <label>{{ t('m0659') }}<input :value="collectorAddress" readonly /></label
          ><label
            >{{ t('m0660') }}<textarea
              ref="tokenField"
              :value="token"
              readonly
              rows="3"
              spellcheck="false"
            /></label
          ><button type="button" class="secondary copy-button" @click="copy">
            <Copy :size="16" />{{ copied ? t('m0353') : t('m0351') }}
          </button></template
        ><template v-else
          ><p class="dialog-description">{{ t('m0661', [selected?.serverName]) }}</p>
          <p class="alert info">
            {{
              action === 'revoke'
                ? t('m0662')
                : selected?.credentialConfigured
                  ? t('m0663')
                  : t('m0664')
            }}
          </p></template
        >
        <p v-if="formError" class="alert error" role="alert">{{ formError }}</p>
        <div class="dialog-actions">
          <button type="button" class="secondary" :disabled="working" @click="close">
            {{ token ? t('m0362') : t('m0102') }}</button
          ><button v-if="!token" class="primary" :disabled="working">
            {{ working ? t('m0363') : action === 'revoke' ? t('m0366') : t('m0665') }}
          </button>
        </div>
      </form>
    </dialog>
  </section>
</template>
