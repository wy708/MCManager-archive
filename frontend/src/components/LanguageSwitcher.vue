<script setup lang="ts">
import { locale, changeLanguage } from '../i18n'
</script>
<template>
  <label class="language-switcher">
    <select :value="locale" aria-label="Language / 语言" :title="locale === 'en' ? 'Changing language reloads this page' : '切换语言会重新加载当前页面'" @change="changeLanguage(($event.target as HTMLSelectElement).value)">
      <option value="zh-CN">简体中文</option>
      <option value="en">English</option>
    </select>
  </label>
</template>
<style scoped>
.language-switcher{display:inline-flex;align-items:center;gap:5px;flex-shrink:0;font-size:12px;color:#336452}
.language-switcher select{width:auto;min-width:82px;max-width:130px;padding:6px;border:1px solid #cbded4;background:#fff;border-radius:8px;font:inherit;color:inherit;cursor:pointer}
</style>
