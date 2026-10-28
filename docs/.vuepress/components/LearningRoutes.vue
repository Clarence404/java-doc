<script setup>
// 学习路线：由 site.js 的 ROUTES 生成，文章标题与简介取文章的 H1 与 description。
// 用法：<LearningRoutes />；每篇可勾「已读」，记录按文章路径存在浏览器本地，同一篇在多条路线里只需勾一次
import {onMounted, reactive} from 'vue';
import {RouteLink} from 'vuepress/client';
import routes from '@temp/routes-data.js';

const READ_KEY = 'route-read';
const read = reactive({});

onMounted(() => {
    try {
        Object.assign(read, JSON.parse(localStorage.getItem(READ_KEY) || '{}'));
    } catch { /* 读不到就当没有记录 */ }
});

const save = () => {
    try {
        localStorage.setItem(READ_KEY, JSON.stringify(read));
    } catch { /* 隐私模式等写不进去时忽略 */ }
};

function toggle(path) {
    if (read[path]) delete read[path];
    else read[path] = true;
    save();
}

const itemsOf = (r) => r.stages.flatMap(s => s.items);
const doneOf = (r) => itemsOf(r).filter(i => read[i.path]).length;

function reset(r) {
    if (!window.confirm(`清空「${r.name}」的已读记录？其他路线里的同一篇文章也会一起清空。`)) return;
    itemsOf(r).forEach(i => delete read[i.path]);
    save();
}
</script>

<template>
  <!-- 不加外层容器：路线标题需要是 #markdown-content 的直接子元素，右侧目录（TOC）才能收录 -->
  <template v-for="(r, ri) in routes" :key="r.name">
    <h2 :id="'route-' + (ri + 1)">{{ r.name }}</h2>
    <div class="lr-head">
      <p class="lr-meta"><span class="lr-time">{{ r.time }}</span>{{ r.for }}</p>
      <div class="lr-progress" :title="`已读 ${doneOf(r)} / ${itemsOf(r).length}`">
        <span class="lr-bar"><span :style="{width: (doneOf(r) / itemsOf(r).length * 100) + '%'}"></span></span>
        <span class="lr-count">{{ doneOf(r) }} / {{ itemsOf(r).length }}</span>
        <button v-if="doneOf(r)" type="button" class="lr-reset" @click="reset(r)">清空</button>
      </div>
    </div>
    <div v-for="(s, si) in r.stages" :key="s.title" class="lr-stage">
      <p class="lr-stage-title">
        <span class="lr-stage-no">{{ si + 1 }}</span>{{ s.title }}<span v-if="s.time" class="lr-stage-time">{{ s.time }}</span>
      </p>
      <p v-if="s.note" class="lr-note">{{ s.note }}</p>
      <ul class="lr-items">
        <li v-for="i in s.items" :key="i.path" :class="{done: read[i.path]}">
          <input type="checkbox" :checked="!!read[i.path]" :aria-label="`标记「${i.title}」已读`" @change="toggle(i.path)">
          <div>
            <RouteLink :to="i.link">{{ i.title }}</RouteLink>
            <span v-if="i.description" class="lr-desc">{{ i.description }}</span>
          </div>
        </li>
      </ul>
    </div>
  </template>
</template>

<style scoped>
.lr-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem 1.5rem;
  margin: 0.5rem 0 1rem;
}
.lr-meta {
  margin: 0;
  color: var(--vp-c-text-mute);
  font-size: 0.925rem;
}
.lr-time {
  display: inline-block;
  margin-right: 0.6rem;
  padding: 0.05rem 0.5rem;
  border-radius: 999px;
  background: var(--vp-c-accent-soft, var(--vp-c-control));
  color: var(--vp-c-accent);
  font-size: 0.8rem;
}
.lr-progress {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8rem;
  color: var(--vp-c-text-mute);
}
.lr-bar {
  width: 8rem;
  height: 6px;
  border-radius: 3px;
  background: var(--vp-c-divider);
  overflow: hidden;
}
.lr-bar > span {
  display: block;
  height: 100%;
  background: var(--vp-c-accent-bg);
  transition: width 0.2s;
}
.lr-count {
  font-family: "JetBrains Mono", Consolas, monospace;
}
.lr-reset {
  border: 0;
  background: transparent;
  color: var(--vp-c-text-mute);
  font-size: 0.8rem;
  cursor: pointer;
}
.lr-stage {
  margin: 1rem 0 1.25rem;
}
.lr-stage-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0 0 0.4rem;
  font-weight: 600;
}
.lr-stage-no {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.4rem;
  height: 1.4rem;
  border-radius: 50%;
  background: var(--vp-c-accent-bg);
  color: #fff;
  font-size: 0.75rem;
}
.lr-stage-time {
  color: var(--vp-c-text-mute);
  font-size: 0.8rem;
  font-weight: 400;
}
.lr-note {
  margin: 0 0 0.4rem 1.9rem;
  color: var(--vp-c-text-mute);
  font-size: 0.875rem;
}
.lr-items {
  list-style: none;
  margin: 0;
  padding-left: 1.9rem;
}
.lr-items li {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  padding: 0.3rem 0;
  border-bottom: 1px dashed var(--vp-c-divider);
}
.lr-items input {
  margin-top: 0.35rem;
  cursor: pointer;
}
.lr-items li.done a {
  color: var(--vp-c-text-mute);
}
.lr-desc {
  display: block;
  color: var(--vp-c-text-mute);
  font-size: 0.825rem;
}
@media (max-width: 480px) {
  .lr-note, .lr-items { padding-left: 0; margin-left: 0; }
}
</style>
