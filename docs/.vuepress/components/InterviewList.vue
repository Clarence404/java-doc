<script setup>
// 题单：由答案页的分组（##）与题目（### Q<n>：）自动生成，题目链接到答案锚点。
// 用法：<InterviewList page="9_mq" />；一页对应多个模块时用 groups 取部分分组，如 groups="11-18"（按分组序号，从 1 开始）
import {computed} from 'vue';
import {RouteLink} from 'vuepress/client';
import data from '@temp/interview-data.js';

const props = defineProps({
    page: {type: String, required: true},
    groups: {type: String, default: ''},
});

const answer = computed(() => data[props.page]);

const picked = computed(() => {
    const all = answer.value?.groups ?? [];
    if (!props.groups) return all;
    const [from, to] = props.groups.split('-').map(Number);
    return all.slice(from - 1, to || from);
});

const total = computed(() => picked.value.reduce((n, g) => n + g.questions.length, 0));
// 「Q12：问题」→ 编号与题干分开显示
const split = (title) => {
    const m = title.match(/^Q?(\d+)[：:、.]\s*(.*)$/);
    return m ? {no: m[1], text: m[2]} : {no: '', text: title};
};
</script>

<template>
  <!-- 不加外层容器：分组标题需要是 #markdown-content 的直接子元素，右侧目录（TOC）才能收录 -->
  <template v-if="answer">
    <p class="interview-list-meta">
      共 {{ total }} 题，点击题目查看答案 · 答案页：<RouteLink :to="answer.path">{{ answer.title }}</RouteLink>
    </p>
    <template v-for="g in picked" :key="g.slug">
      <h2 :id="g.slug">{{ g.title }}</h2>
      <ol class="interview-list-items">
        <li v-for="q in g.questions" :key="q.slug">
          <span class="interview-list-no">Q{{ split(q.title).no }}</span>
          <RouteLink :to="answer.path + '#' + q.slug">{{ split(q.title).text }}</RouteLink>
        </li>
      </ol>
    </template>
  </template>
  <p v-else>未找到答案页 {{ page }}</p>
</template>

<style scoped>
.interview-list-meta {
  color: var(--vp-c-text-mute);
  font-size: 0.875rem;
}
.interview-list-items {
  list-style: none;
  padding-left: 0;
}
.interview-list-items li {
  display: flex;
  gap: 0.75em;
  padding: 0.35rem 0;
  border-bottom: 1px dashed var(--vp-c-divider);
}
.interview-list-no {
  flex: 0 0 2.6em;
  font-family: "JetBrains Mono", Consolas, monospace;
  font-size: 0.8rem;
  color: var(--vp-c-text-mute);
  padding-top: 0.15em;
}
</style>
