<script setup lang="ts">
import { t } from '../i18n'

import { ref, watch } from 'vue'
import { Search, Users, ArrowRight } from '@lucide/vue'
import { api } from '../api'
import { useResource } from '../useResource'
import { displayTime, query, type Filters, type Page, type PlayerRow } from '../statistics'
import PaginationControl from './PaginationControl.vue'
const props = defineProps<{ scope: string; filters: Filters; zone: string }>()
const emit = defineEmits<{ select: [key: string]; error: [error: unknown] }>()
const draft = ref(''),
  search = ref(''),
  page = ref(1)
watch(
  () => [props.scope, props.filters, search.value],
  () => {
    page.value = 1
  },
)
const { data, busy, error, refresh } = useResource(
  () => [props.scope, props.filters, search.value, page.value],
  (signal) =>
    api<Page<PlayerRow>>(
      '/players' + query(props.scope, props.filters, { search: search.value, page: page.value }),
      { signal },
    ),
  (ex) => emit('error', ex),
)
</script>
<template>
  <section class="panel data-panel">
    <div class="data-panel-heading">
      <div>
        <h2>{{ t('m0920') }}</h2>
        <p>{{ t('m0921') }}</p>
      </div>
      <form class="inline-search" @submit.prevent="search = draft">
        <label class="search-field"
          ><Search :size="17" /><input
            v-model="draft"
            type="search"
            :aria-label="t('m0922')"
            :placeholder="t('m0923')"
            maxlength="80" /></label
        ><button class="secondary">{{ t('m0924') }}</button>
      </form>
    </div>
    <p v-if="error" class="alert error" role="alert">
      {{ error }}<button class="text-button" @click="refresh">{{ t('m0337') }}</button>
    </p>
    <div v-else-if="busy" class="small-empty" role="status">{{ t('m0925') }}</div>
    <div v-else-if="!data?.items.length" class="small-empty">
      <span class="empty-icon"><Users :size="30" /></span>
      <h3>{{ t('m0926') }}</h3>
      <p>{{ t('m0927') }}</p>
    </div>
    <template v-else
      ><div class="table-scroll" tabindex="0" :aria-label="t('m0928')">
        <table>
          <thead>
            <tr>
              <th>{{ t('m0089') }}</th>
              <th>{{ t('m0929') }}</th>
              <th>{{ t('m0930') }}</th>
              <th>{{ t('m0931') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="player in data.items" :key="player.key">
              <td>
                <div class="player-name-cell">
                  <span class="player-tile" aria-hidden="true">{{
                    player.name.charAt(0).toUpperCase()
                  }}</span>
                  <div>
                    <strong>{{ player.name }}</strong>
                    <details class="identity-details">
                      <summary>{{ t('m0904') }}</summary>
                      <code class="identity-key">{{ player.key }}</code>
                    </details>
                  </div>
                </div>
              </td>
              <td>{{ displayTime(player.firstSeenAt, zone) }}</td>
              <td>{{ displayTime(player.lastSeenAt, zone) }}</td>
              <td>
                <button
                  class="text-button"
                  :aria-label="t('m0932', [player.name])"
                  @click="emit('select', player.key)"
                >{{ t('m0933') }}<ArrowRight :size="15" />
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <PaginationControl :page="page" :total="data.total" :busy="busy" @change="page = $event"
    /></template>
  </section>
</template>
