<script setup>
// 题单：由答案页的分组（##）与题目（### Q<n>：）自动生成，题目链接到答案锚点。
// 用法：<InterviewList page="9_mq" />；一页对应多个模块时用 groups 取部分分组，如 groups="11-18"（按分组序号，从 1 开始）
// 自测模式：先只显示题目，点开看「一句话」，标记会 / 不会（存浏览器本地），可随机抽题，优先抽不会和没做过的
import {computed, onMounted, reactive, ref, watch} from 'vue';
import {RouteLink} from 'vuepress/client';
import data from '@temp/interview-data.js';

const props = defineProps({
    page: {type: String, required: true},
    groups: {type: String, default: ''},
});

const MODE_KEY = 'interview-mode';
const MARKS_KEY = 'interview-marks';
const DRAW_SIZE = 10;

const answer = computed(() => data[props.page]);

const picked = computed(() => {
    const all = answer.value?.groups ?? [];
    if (!props.groups) return all;
    const [from, to] = props.groups.split('-').map(Number);
    return all.slice(from - 1, to || from);
});

const allQuestions = computed(() => picked.value.flatMap(g => g.questions));
const total = computed(() => allQuestions.value.length);
// 「Q12：问题」→ 编号与题干分开显示
const split = (title) => {
    const m = title.match(/^Q?(\d+)[：:、.]\s*(.*)$/);
    return m ? {no: m[1], text: m[2]} : {no: '', text: title};
};

// ---- 本地存储（SSR 时不可用，挂载后再读） ----
const load = (key, fallback) => {
    try {
        const v = localStorage.getItem(key);
        return v == null ? fallback : JSON.parse(v);
    } catch {
        return fallback;
    }
};
const save = (key, value) => {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch { /* 隐私模式等写不进去时忽略 */ }
};

const mode = ref('list');
const marks = reactive({});
const markKey = (q) => `${props.page}#${q.slug}`;
const markOf = (q) => marks[markKey(q)] ?? '';

onMounted(() => {
    Object.assign(marks, load(MARKS_KEY, {}));
    if (load(MODE_KEY, 'list') === 'quiz') setMode('quiz');
});

// ---- 自测 ----
const answers = ref(null);
const loading = ref(false);
const revealed = reactive(new Set());
const filter = ref('all');
const draw = ref(null);

async function setMode(m) {
    mode.value = m;
    save(MODE_KEY, m);
    if (m === 'quiz' && !answers.value && !loading.value) {
        loading.value = true;
        try {
            answers.value = (await import('@temp/interview-answers.js')).default[props.page] ?? {};
        } finally {
            loading.value = false;
        }
    }
}

function mark(q, value) {
    const k = markKey(q);
    if (marks[k] === value) delete marks[k];
    else marks[k] = value;
    save(MARKS_KEY, {...load(MARKS_KEY, {}), [k]: marks[k]});
}

const stats = computed(() => {
    let ok = 0, ng = 0;
    for (const q of allQuestions.value) {
        const m = markOf(q);
        if (m === 'ok') ok++;
        else if (m === 'ng') ng++;
    }
    return {ok, ng, todo: total.value - ok - ng};
});

const visible = (q) => filter.value === 'all'
    || (filter.value === 'ng' && markOf(q) === 'ng')
    || (filter.value === 'todo' && markOf(q) !== 'ok');

const quizGroups = computed(() => picked.value
    .map(g => ({...g, questions: g.questions.filter(visible)}))
    .filter(g => g.questions.length));

const shuffle = (arr) => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
};

// 优先级：不会 → 没做过 → 已会
function drawRandom() {
    const bucket = {ng: [], '': [], ok: []};
    allQuestions.value.forEach(q => bucket[markOf(q)].push(q));
    draw.value = [...shuffle(bucket.ng), ...shuffle(bucket['']), ...shuffle(bucket.ok)].slice(0, DRAW_SIZE);
    revealed.clear();
}

function resetMarks() {
    if (!window.confirm(`清空本题单 ${total.value} 题的会 / 不会标记？`)) return;
    const stored = load(MARKS_KEY, {});
    for (const q of allQuestions.value) {
        delete marks[markKey(q)];
        delete stored[markKey(q)];
    }
    save(MARKS_KEY, stored);
}

watch(filter, () => (draw.value = null));

function toggle(q) {
    if (revealed.has(q.slug)) revealed.delete(q.slug);
    else revealed.add(q.slug);
}

// 「一句话」里的少量 Markdown：行内代码、加粗、链接（只留文字）
const escape = (s) => s.replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);
const inline = (md) => escape(md)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
const answerOf = (q) => inline(answers.value?.[q.slug] || '（这题没有「一句话」，看完整答案）');
</script>

<template>
  <!-- 不加外层容器：分组标题需要是 #markdown-content 的直接子元素，右侧目录（TOC）才能收录 -->
  <template v-if="answer">
    <div class="il-bar">
      <div class="il-tabs" role="tablist">
        <button type="button" role="tab" :aria-selected="mode === 'list'" :class="{active: mode === 'list'}"
                @click="setMode('list')">题单</button>
        <button type="button" role="tab" :aria-selected="mode === 'quiz'" :class="{active: mode === 'quiz'}"
                @click="setMode('quiz')">自测</button>
      </div>
      <span class="il-meta">
        共 {{ total }} 题
        <template v-if="stats.ok || stats.ng"> · <span class="il-ok">会 {{ stats.ok }}</span> · <span class="il-ng">不会 {{ stats.ng }}</span></template>
        · 答案页：<RouteLink :to="answer.path">{{ answer.title }}</RouteLink>
      </span>
    </div>

    <!-- 题单模式 -->
    <template v-if="mode === 'list'">
      <template v-for="g in picked" :key="g.slug">
        <h2 :id="g.slug">{{ g.title }}</h2>
        <ol class="interview-list-items">
          <li v-for="q in g.questions" :key="q.slug">
            <span class="interview-list-no">Q{{ split(q.title).no }}<i v-if="markOf(q)" :class="['il-dot', markOf(q)]"
                                                                      :title="markOf(q) === 'ok' ? '会' : '不会'"></i></span>
            <RouteLink :to="answer.path + '#' + q.slug">{{ split(q.title).text }}</RouteLink>
          </li>
        </ol>
      </template>
    </template>

    <!-- 自测模式 -->
    <template v-else>
      <div class="il-controls">
        <button type="button" class="il-btn primary" @click="drawRandom">随机抽 {{ Math.min(DRAW_SIZE, total) }} 题</button>
        <button v-if="draw" type="button" class="il-btn" @click="draw = null">看全部</button>
        <label v-else class="il-filter">
          范围
          <select v-model="filter">
            <option value="all">全部（{{ total }}）</option>
            <option value="todo">未掌握（{{ stats.todo + stats.ng }}）</option>
            <option value="ng">只看不会（{{ stats.ng }}）</option>
          </select>
        </label>
        <button v-if="stats.ok || stats.ng" type="button" class="il-btn ghost" @click="resetMarks">清空标记</button>
      </div>
      <p v-if="loading" class="il-meta">答案加载中…</p>

      <template v-if="draw">
        <h2 :id="'draw-' + page">随机 {{ draw.length }} 题</h2>
        <ol class="il-cards">
          <li v-for="q in draw" :key="q.slug" :class="['il-card', markOf(q)]">
            <div class="il-q" @click="toggle(q)">
              <span class="interview-list-no">Q{{ split(q.title).no }}</span>
              <span class="il-title">{{ split(q.title).text }}</span>
            </div>
            <div class="il-actions">
              <button type="button" class="il-btn small" @click="toggle(q)">{{ revealed.has(q.slug) ? '收起' : '看答案' }}</button>
              <button type="button" :class="['il-btn small ok', {on: markOf(q) === 'ok'}]" @click="mark(q, 'ok')">会</button>
              <button type="button" :class="['il-btn small ng', {on: markOf(q) === 'ng'}]" @click="mark(q, 'ng')">不会</button>
            </div>
            <div v-if="revealed.has(q.slug)" class="il-answer">
              <p v-html="answerOf(q)"></p>
              <RouteLink :to="answer.path + '#' + q.slug">完整答案 →</RouteLink>
            </div>
          </li>
        </ol>
      </template>

      <template v-else>
        <p v-if="!quizGroups.length" class="il-meta">这个范围里没有题目了。</p>
        <template v-for="g in quizGroups" :key="g.slug">
          <h2 :id="g.slug">{{ g.title }}</h2>
          <ol class="il-cards">
            <li v-for="q in g.questions" :key="q.slug" :class="['il-card', markOf(q)]">
              <div class="il-q" @click="toggle(q)">
                <span class="interview-list-no">Q{{ split(q.title).no }}</span>
                <span class="il-title">{{ split(q.title).text }}</span>
              </div>
              <div class="il-actions">
                <button type="button" class="il-btn small" @click="toggle(q)">{{ revealed.has(q.slug) ? '收起' : '看答案' }}</button>
                <button type="button" :class="['il-btn small ok', {on: markOf(q) === 'ok'}]" @click="mark(q, 'ok')">会</button>
                <button type="button" :class="['il-btn small ng', {on: markOf(q) === 'ng'}]" @click="mark(q, 'ng')">不会</button>
              </div>
              <div v-if="revealed.has(q.slug)" class="il-answer">
                <p v-html="answerOf(q)"></p>
                <RouteLink :to="answer.path + '#' + q.slug">完整答案 →</RouteLink>
              </div>
            </li>
          </ol>
        </template>
      </template>
    </template>
  </template>
  <p v-else>未找到答案页 {{ page }}</p>
</template>

<style scoped>
.il-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 1rem;
  margin: 1rem 0 0.5rem;
}
.il-tabs {
  display: inline-flex;
  border: 1px solid var(--vp-c-border);
  border-radius: 8px;
  overflow: hidden;
}
.il-tabs button {
  padding: 0.3rem 0.9rem;
  border: 0;
  background: transparent;
  color: var(--vp-c-text-mute);
  font-size: 0.875rem;
  cursor: pointer;
}
.il-tabs button.active {
  background: var(--vp-c-accent-bg);
  color: #fff;
}
.il-meta {
  color: var(--vp-c-text-mute);
  font-size: 0.875rem;
}
.il-ok { color: #059669; }
.il-ng { color: #dc2626; }

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
  white-space: nowrap;
}
.il-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-left: 4px;
  border-radius: 50%;
  vertical-align: middle;
}
.il-dot.ok { background: #059669; }
.il-dot.ng { background: #dc2626; }

.il-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin: 0.75rem 0;
}
.il-filter {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.875rem;
  color: var(--vp-c-text-mute);
}
.il-filter select {
  padding: 0.25rem 0.4rem;
  border: 1px solid var(--vp-c-border);
  border-radius: 6px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text);
}
.il-btn {
  padding: 0.3rem 0.8rem;
  border: 1px solid var(--vp-c-border);
  border-radius: 6px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text);
  font-size: 0.875rem;
  cursor: pointer;
}
.il-btn.primary {
  border-color: var(--vp-c-accent-bg);
  background: var(--vp-c-accent-bg);
  color: #fff;
}
.il-btn.ghost {
  border-color: transparent;
  color: var(--vp-c-text-mute);
}
.il-btn.small {
  padding: 0.15rem 0.6rem;
  font-size: 0.8rem;
}
.il-btn.ok.on { border-color: #059669; background: #059669; color: #fff; }
.il-btn.ng.on { border-color: #dc2626; background: #dc2626; color: #fff; }

.il-cards {
  list-style: none;
  padding-left: 0;
}
.il-card {
  padding: 0.6rem 0.75rem;
  margin: 0.5rem 0;
  border: 1px solid var(--vp-c-divider);
  border-left: 3px solid var(--vp-c-divider);
  border-radius: 6px;
}
.il-card.ok { border-left-color: #059669; }
.il-card.ng { border-left-color: #dc2626; }
.il-q {
  display: flex;
  gap: 0.75em;
  cursor: pointer;
}
.il-title { flex: 1; }
.il-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin: 0.5rem 0 0 3.35em;
}
.il-answer {
  margin: 0.6rem 0 0 3.35em;
  padding: 0.5rem 0.75rem;
  border-radius: 6px;
  background: var(--vp-c-bg-alt, var(--vp-c-control));
  font-size: 0.925rem;
}
.il-answer p { margin: 0 0 0.3rem; }
@media (max-width: 480px) {
  .il-actions, .il-answer { margin-left: 0; }
}
</style>
