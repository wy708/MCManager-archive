<script setup lang="ts">
import { computed } from 'vue'
import { gameName, unknownGameNames, type GameNameKind } from '../gameNames'

const props = defineProps<{ raw: string; kind: GameNameKind; showId?: boolean }>()
const label = computed(() => gameName(props.raw, props.kind))
</script>

<template>
  <span :title="raw" :data-game-id="raw">
    {{ label ?? unknownGameNames[kind] }}
    <small v-if="raw !== 'all' && (showId || !label)" class="raw-game-name">{{ raw }}</small>
  </span>
</template>

<style scoped>
.raw-game-name {
  overflow-wrap: anywhere;
}
</style>
