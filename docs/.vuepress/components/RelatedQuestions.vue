<script setup>
// 本篇相关面试题：数据由构建插件写入页面数据 relatedQuestions（见 config.js 的 computeRelatedQuestions），
// 挂在 Layout 的 contentAfter 插槽，出现在正文最后；题号旁的点取自题单自测模式的「会 / 不会」标记
import {computed, onMounted, reactive, ref} from 'vue';
import {RouteLink, usePageData} from 'vuepress/client';

const FOLD = 8;
const MARKS_KEY = 'interview-marks';

const page = usePageData();
const list = computed(() => page.value.relatedQuestions ?? []);
const expanded = ref(false);
const shown = computed(() => (expanded.value ? list.value : list.value.slice(0, FOLD)));
const marks = reactive({});

onMounted(() => {
    try {
        Object.assign(marks, JSON.parse(localStorage.getItem(MARKS_KEY) || '{}'));
    } catch { /* 读不到就不显示标记 */ }
});

const markOf = (q) => marks[`${q.page}#${q.slug}`] ?? '';
// 同一小节的题只在第一题显示小节名
const showSection = (i) => i === 0 || shown.value[i - 1].section !== shown.value[i].section;
</script>

<template>
  <section v-if="list.length" class="rq" aria-labelledby="rq-title">
    <p id="rq-title" class="rq-title">本篇相关面试题<span class="rq-count">{{ list.length }}</span></p>
    <ol class="rq-list">
      <li v-for="(q, i) in shown" :key="q.link">
        <span class="rq-section">{{ showSection(i) ? q.section : '' }}</span>
        <RouteLink class="rq-q" :to="q.link">
          <span class="rq-no">Q{{ q.no }}<i v-if="markOf(q)" :class="['rq-dot', markOf(q)]" :title="markOf(q) === 'ok' ? '会' : '不会'"></i></span>
          <span class="rq-text">{{ q.text }}</span>
        </RouteLink>
        <span class="rq-answer">{{ q.answer }}</span>
      </li>
    </ol>
    <button v-if="list.length > FOLD" type="button" class="rq-more" @click="expanded = !expanded">
      {{ expanded ? '收起' : `展开全部 ${list.length} 题` }}
    </button>
  </section>
</template>

<style scoped>
.rq {
  margin: 2.5rem 0 1rem;
  padding: 1rem 1.25rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-soft, var(--vp-c-bg-alt));
}
.rq-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0 0 0.6rem;
  font-weight: 600;
}
.rq-count {
  padding: 0 0.45rem;
  border-radius: 999px;
  background: var(--vp-c-accent-bg);
  color: #fff;
  font-size: 0.75rem;
  line-height: 1.5;
}
.rq-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.rq-list li {
  display: grid;
  grid-template-columns: 9rem 1fr auto;
  gap: 0.75rem;
  align-items: baseline;
  padding: 0.35rem 0;
  border-bottom: 1px dashed var(--vp-c-divider);
  font-size: 0.9rem;
}
.rq-list li:last-child {
  border-bottom: 0;
}
.rq-section {
  overflow: hidden;
  color: var(--vp-c-text-mute);
  font-size: 0.8rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rq-q {
  display: flex;
  gap: 0.5rem;
}
.rq-no {
  flex: none;
  font-family: "JetBrains Mono", Consolas, monospace;
  font-size: 0.8rem;
  color: var(--vp-c-text-mute);
}
.rq-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-left: 3px;
  border-radius: 50%;
  vertical-align: middle;
}
.rq-dot.ok { background: #059669; }
.rq-dot.ng { background: #dc2626; }
.rq-answer {
  color: var(--vp-c-text-mute);
  font-size: 0.8rem;
  white-space: nowrap;
}
.rq-more {
  margin-top: 0.5rem;
  border: 0;
  background: transparent;
  color: var(--vp-c-accent);
  font-size: 0.85rem;
  cursor: pointer;
}
@media (max-width: 719px) {
  .rq-list li {
    grid-template-columns: 1fr auto;
  }
  .rq-section {
    grid-column: 1 / -1;
  }
  .rq-section:empty {
    display: none;
  }
}
</style>
