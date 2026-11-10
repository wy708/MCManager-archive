<script setup lang="ts">
import { t } from '../i18n'

import { ref } from 'vue'
import { api } from '../api'
import { displayTime, type Session } from '../statistics'
import { useResource } from '../useResource'
import GameName from './GameName.vue'

interface SessionChat {
  startedAt: string
  confirmedThrough: string
  messages: {
    items: {
      eventId: string
      occurredAt: string
      actorName: string
      dimension: string
      text: string
    }[]
    hasMore: boolean
    nextCursor: string
    retentionDays: number
  }
}

defineProps<{ zone: string }>()
const emit = defineEmits<{ error: [error: unknown] }>()
const dialog = ref<HTMLDialogElement>()
const selected = ref<Session>()
const cursors = ref(['0'])
const { data, busy, error, refresh } = useResource(
  () => [selected.value, cursors.value],
  (signal) => {
    const session = selected.value
    if (!session) return Promise.resolve(null)
    const params = new URLSearchParams({
      serverId: session.serverId,
      after: cursors.value.at(-1)!,
    })
    return api<SessionChat>(`/activity/sessions/${session.sessionId}/chat?${params}`, { signal })
  },
  (ex) => emit('error', ex),
)

function open(session: Session) {
  selected.value = session
  cursors.value = ['0']
  dialog.value?.showModal()
}
function close() {
  dialog.value?.close()
}
function restart() {
  if (cursors.value.length > 1) cursors.value = ['0']
  else void refresh()
}
defineExpose({ open, close })
</script>

<template>
  <dialog ref="dialog" :aria-label="t('m1428')" @close="selected = undefined">
    <div class="dialog-heading">
      <h2>{{ t('m1428') }}</h2>
      <button class="secondary" type="button" autofocus @click="close">{{ t('m1084') }}</button>
    </div>
    <template v-if="selected">
      <p class="dialog-description">
        {{ selected.playerName }} · {{ selected.serverName }}<br />{{ t('m1429', [displayTime(data?.startedAt ?? selected.startedAt, zone), displayTime(data?.confirmedThrough ?? selected.checkpointAt, zone)]) }}
      </p>
      <p class="field-note">{{ t('m1430') }}<template v-if="data">{{ t('m1431', [data.messages.retentionDays]) }}</template>
      </p>
      <p v-if="busy" class="small-empty" role="status">{{ t('m1432') }}</p>
      <p v-else-if="error" class="alert error" role="alert">
        {{ error }} <button class="text-button" @click="refresh">{{ t('m0337') }}</button>
      </p>
      <template v-else-if="data">
        <ul v-if="data.messages.items.length" class="chat-list" :aria-label="t('m1433')">
          <li v-for="message in data.messages.items" :key="message.eventId">
            <small>
              {{ displayTime(message.occurredAt, zone) }} · {{ message.actorName }} ·
              <GameName :raw="message.dimension" kind="dimension" />
            </small>
            <p>{{ message.text }}</p>
          </li>
        </ul>
        <p v-else class="small-empty">{{ t('m1434') }}</p>
      </template>
      <div class="dialog-actions">
        <button class="secondary" type="button" :disabled="busy" @click="restart">{{ t('m0331') }}</button>
        <button
          v-if="cursors.length > 1"
          class="secondary"
          type="button"
          :disabled="busy"
          @click="cursors = cursors.slice(0, -1)"
        >{{ t('m0869') }}</button>
        <button
          v-if="data?.messages.hasMore"
          class="secondary"
          type="button"
          :disabled="busy"
          @click="cursors = [...cursors, data.messages.nextCursor]"
        >{{ t('m0870') }}</button>
      </div>
    </template>
  </dialog>
</template>

<style scoped>
.chat-list {
  padding: 0;
  margin: 1rem 0;
  list-style: none;
}
.chat-list li {
  padding: 0.7rem 0;
  border-top: 1px solid #edf1ec;
  overflow-wrap: anywhere;
}
.chat-list small {
  color: #526657;
}
.chat-list p {
  margin: 0.25rem 0 0;
  white-space: pre-wrap;
}
</style>
