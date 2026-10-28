<script setup>
// 版本基线速查：由 site.js 的 BASELINE 生成，按类别分表。用法：<VersionBaseline />
import {BASELINE} from '../site.js';

const cats = [...new Set(BASELINE.versions.map(v => v.cat))]
    .map(cat => ({cat, items: BASELINE.versions.filter(v => v.cat === cat)}));
</script>

<template>
  <p class="vb-date">基线时间：{{ BASELINE.date }}</p>
  <!-- 不加外层容器：类别标题需要是 #markdown-content 的直接子元素，右侧目录（TOC）才能收录 -->
  <template v-for="c in cats" :key="c.cat">
    <h2 :id="'vb-' + c.cat">{{ c.cat }}</h2>
    <ul class="vb-list">
      <li v-for="v in c.items" :key="v.name">
        <span class="vb-name">{{ v.name }}</span>
        <span class="vb-ver">{{ v.ver }}</span>
      </li>
    </ul>
  </template>
  <template v-if="BASELINE.exceptions.length">
    <h2 id="vb-exceptions">例外</h2>
    <ul class="vb-exc">
      <li v-for="e in BASELINE.exceptions" :key="e.path + e.name">
        <code>{{ e.path }}</code> 下的文章使用 {{ e.name }} {{ e.ver }}
      </li>
    </ul>
  </template>
</template>

<style scoped>
.vb-date {
  color: var(--vp-c-text-mute);
  font-size: 0.875rem;
}
.vb-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
  gap: 0.5rem;
  list-style: none;
  padding-left: 0;
}
.vb-list li {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 0.75rem;
  padding: 0.45rem 0.75rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
}
.vb-name {
  font-weight: 500;
}
.vb-ver {
  font-family: "JetBrains Mono", Consolas, monospace;
  color: var(--vp-c-accent);
  white-space: nowrap;
}
.vb-exc {
  color: var(--vp-c-text-mute);
}
</style>
