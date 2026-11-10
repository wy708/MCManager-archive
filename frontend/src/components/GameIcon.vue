<script setup lang="ts">
defineProps<{ kind: 'grass' | 'player' | 'crystal' | 'chest' }>()
</script>
<template>
  <svg viewBox="0 0 48 48" aria-hidden="true" class="game-icon" shape-rendering="crispEdges">
    <template v-if="kind === 'grass'">
      <path fill="#79cb43" d="M3 13 24 2l21 11-21 12z" />
      <path fill="#4a9b30" d="m3 13 21 12v21L3 34z" />
      <path fill="#226c31" d="m24 25 21-12v21L24 46z" />
      <path fill="#a2e35b" d="m8 12 8-4 7 4-8 4zm15-6 7 4-6 4-7-4zm7 10 8-4 5 3-8 4z" />
      <path fill="#5bad37" d="m16 17 7-4 7 4-7 4zm-10 0 6 4v8l-6-4zm11 7 7 4v8l-7-4z" />
      <path fill="#327b2a" d="m27 28 7-4v8l-7 4zm8-9 7-4v8l-7 4z" />
      <path fill="#30622a" d="m6 28 7 4v7l-7-4zm10 5 8 4v9l-8-5z" />
    </template>
    <template v-else-if="kind === 'player'">
      <path fill="#3e281c" d="M5 3h38v42H5z" />
      <path fill="#5d3f2c" d="M9 3h8v6H9zm16 0h13v6H25z" />
      <path fill="#b77b52" d="M5 17h38v25H5z" />
      <path fill="#d39d72" d="M10 13h28v24H10z" />
      <path fill="#573820" d="M5 12h8v10H5zm29-2h9v11h-9z" />
      <path fill="#fff3dd" d="M10 24h11v6H10zm17 0h11v6H27z" />
      <path fill="#335b8e" d="M16 24h5v6h-5zm11 0h5v6h-5z" />
      <path fill="#af724c" d="M21 27h6v8h-6z" />
      <path fill="#65402b" d="M16 36h17v6H16z" />
      <path fill="#d69873" d="M21 35h6v4h-6z" />
    </template>
    <template v-else-if="kind === 'crystal'">
      <path fill="#532978" d="m18 2 12 0 0 6h7v7h7v19h-7v7h-7v5H18v-5h-7v-7H4V15h7V8h7z" />
      <path fill="#a552e1" d="m18 8 12 0v7h7v19h-7v6H18v-6h-7V15h7z" />
      <path fill="#e3a7ff" d="M18 8h8v12h-8zm-7 9h7v8h-7z" />
      <path fill="#7330ac" d="M26 17h11v17H26zm-8 17h12v6H18z" />
      <path fill="#c976ef" d="M18 20h8v14h-8z" />
    </template>
    <template v-else>
      <path fill="#593b1e" d="m3 12 21-9 21 9v29l-21 6L3 38z" />
      <path fill="#f2b643" d="m7 13 17-7 17 7-17 7z" />
      <path fill="#ce892e" d="m7 18 15 6v18L7 36z" />
      <path fill="#9b6126" d="m26 24 15-6v20l-15 4z" />
      <path fill="#64442b" d="m6 25 16 5v4L6 29zm20 5 16-6v4l-16 6z" />
      <path fill="#dfe3d7" d="M20 24h8v13h-8z" />
      <path fill="#8b968b" d="M24 27h4v10h-4z" />
    </template>
  </svg>
</template>
