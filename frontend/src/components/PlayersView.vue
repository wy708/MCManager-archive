<script setup lang="ts">
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
        <h2>玩家档案</h2>
        <p>改名后也能找到同一位玩家；名字相同的玩家会分别记录。</p>
      </div>
      <form class="inline-search" @submit.prevent="search = draft">
        <label class="search-field"
          ><Search :size="17" /><input
            v-model="draft"
            type="search"
            aria-label="搜索玩家当前或历史名字"
            placeholder="当前名字 / 历史名字"
            maxlength="80" /></label
        ><button class="secondary">搜索</button>
      </form>
    </div>
    <p v-if="error" class="alert error" role="alert">
      {{ error }}<button class="text-button" @click="refresh">重试</button>
    </p>
    <div v-else-if="busy" class="small-empty" role="status">正在加载玩家…</div>
    <div v-else-if="!data?.items.length" class="small-empty">
      <span class="empty-icon"><Users :size="30" /></span>
      <h3>此范围内还没有玩家记录</h3>
      <p>连接游戏插件后，玩家记录会出现在这里。也可以试着放宽日期筛选。</p>
    </div>
    <template v-else
      ><div class="table-scroll" tabindex="0" aria-label="玩家列表">
        <table>
          <thead>
            <tr>
              <th>玩家</th>
              <th>最早记录时间</th>
              <th>最近记录时间</th>
              <th>操作</th>
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
                      <summary>查看玩家编号</summary>
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
                  :aria-label="`查看玩家 ${player.name}`"
                  @click="emit('select', player.key)"
                >
                  查看档案<ArrowRight :size="15" />
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
