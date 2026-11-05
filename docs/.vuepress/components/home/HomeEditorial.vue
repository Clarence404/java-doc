<script setup>
// 首页「杂志式 Bento 目录」：所有数字、列表、链接都来自 site.js 与构建时统计，新增文章 / 模块后自动更新
import {computed, nextTick, onBeforeUnmount, onMounted, ref} from 'vue';
import {RouteLink, withBase} from 'vuepress/client';
import stats from '@temp/home-stats.js';
import navData from '@temp/module-nav.js';
import {FOOTER, GROUPS, REFS, SUMMARY, overviewLink} from '../../site.js';

const GOF = 23; // GoF 设计模式总数（常量）

/* ---------- 分组配色：沿品牌渐变 #ff6b9d → #a855f7 → #38bdf8 按分组数等距取色 ---------- */
const BRAND = [[255, 107, 157], [168, 85, 247], [56, 189, 248]];
function brandAt(t) {
    const seg = t <= .5 ? 0 : 1, u = t <= .5 ? t * 2 : (t - .5) * 2;
    const [a, b] = [BRAND[seg], BRAND[seg + 1]];
    return '#' + a.map((v, k) => Math.round(v + (b[k] - v) * u).toString(16).padStart(2, '0')).join('');
}
const pad = (n) => String(n).padStart(2, '0');
const CN = '零一二三四五六七八九';
const cn = (n) => n < 10 ? CN[n] : n < 100 ? (n >= 20 ? CN[Math.floor(n / 10)] : '') + '十' + (n % 10 ? CN[n % 10] : '') : String(n);
const maxBy = (arr, f) => arr.reduce((best, x) => (best == null || f(x) > f(best) ? x : best), null);

/* ---------- 模型：site.js 分组 + 构建时统计 ---------- */
const modStats = (stats && stats.modules) || {};
const colors = GROUPS.map((_, i) => brandAt(GROUPS.length === 1 ? 0 : i / (GROUPS.length - 1)));
const groups = GROUPS.map((g, i) => {
    const modules = g.modules.map((m) => ({
        ...m,
        link: overviewLink(m.dir),
        a: modStats[m.dir] ? modStats[m.dir].articles : 0,
        q: modStats[m.dir] ? modStats[m.dir].questions : 0,
    }));
    return {
        ...g,
        i,
        no: pad(i + 1),
        modules,
        arts: modules.reduce((s, m) => s + m.a, 0),
        qs: modules.reduce((s, m) => s + m.q, 0),
        start: modules[0] && {text: ((navData[modules[0].dir] || [])[0] || {}).text || `${modules[0].name} 总览`, link: modules[0].link},
        c: colors[i],
        c2: colors[i + 1] || brandAt(.5),
    };
});
const allMods = groups.flatMap((g) => g.modules);
const totals = {
    groups: groups.length,
    modules: allMods.length,
    articles: groups.reduce((s, g) => s + g.arts, 0),
    questions: groups.reduce((s, g) => s + g.qs, 0),
    answerPages: (stats && stats.answerPages) || 0,
    svgs: (stats && stats.svgs) || 0,
};
const lastNo = groups.length ? groups[groups.length - 1].no : '01';
const summaryLink = overviewLink(SUMMARY.dir);
const startLink = groups.length && groups[0].modules.length ? groups[0].modules[0].link : summaryLink;
const since = (FOOTER.match(/(\d{4})/) || [])[1];
const logo = withBase('/images/logo.png');

/* ---------- 首屏要目：题最多的分组 / 题最多的模块 / 设计模式 / 末组最大模块 ---------- */
const hotGroup = maxBy(groups, (g) => g.qs);
const hotMod = maxBy(allMods.filter((m) => !hotGroup || !hotGroup.modules.includes(m)), (m) => m.q); // 题最多的组之外，避免与上一条重复
const gofMod = allMods.find((m) => m.dir === 'patterns');
const edgeGroup = groups[groups.length - 1];
const edgeMod = edgeGroup && maxBy(edgeGroup.modules, (m) => m.a);
const coverlines = [
    hotGroup && hotGroup.qs && {n: hotGroup.qs, u: '题', t: hotGroup.name, d: hotGroup.tagline, to: hotGroup.modules[0].link},
    hotMod && hotMod.q && {n: hotMod.q, u: '题', t: hotMod.name, d: hotMod.desc, to: hotMod.link},
    gofMod && {n: GOF, u: '种', t: gofMod.name, d: gofMod.desc, to: gofMod.link},
    edgeMod && {n: edgeMod.a, u: '篇', t: edgeMod.name, d: edgeMod.desc, to: edgeMod.link},
].filter(Boolean);

const statList = [
    {n: totals.modules, u: '个', t: '技术模块', s: `分为 ${totals.groups} 个分组`},
    {n: totals.articles, u: '篇', t: '文章', s: '按编号组织，持续更新'},
    {n: totals.questions, u: '道', t: '题目清单', s: '分布在各模块'},
    {n: totals.answerPages, u: '页', t: `${SUMMARY.name}答案页`, s: '按导航分组'},
    {n: totals.svgs, u: '张', t: 'SVG 图解', s: '矢量绘制，缩放清晰'},
    {n: GOF, u: '种', t: '设计模式', s: 'GoF 全集'},
];

/* ---------- 面试题解：直接取面试题解目录的侧边栏分组（分组名与 GROUPS 同名） ---------- */
let pageNo = 0;
const digest = (navData.interview || [])
    .filter((n) => n.children && groups.some((g) => g.name === n.text))
    .map((n) => ({name: n.text, pages: n.children.filter((c) => c.link).map((c) => ({text: c.text, link: c.link, no: pad(++pageNo)}))}));

/* ---------- 读法：以一个模块为例走一遍（总览 → 正文 → 题单 → 答案页），按导航顺序切换，默认从缓存开始 ---------- */
const flat = (items) => (items || []).flatMap((n) => (n.children ? flat(n.children) : [n]));
const answerPages = flat((navData.interview || []).filter((n) => n.children));
const ivTitle = (t) => `${t}${/[\w.]$/.test(t) ? ' ' : ''}${SUMMARY.stripSuffix}`;
const walks = allMods.map((m) => {
    const items = flat(navData[m.dir]).filter((n) => n.link);
    const isEdge = (n) => n.link === m.link || n.link === `/${m.dir}/99_interview`;
    const iv = m.interview && answerPages.find((p) => p.link === `/${SUMMARY.dir}/${m.interview[0]}`);
    return {
        dir: m.dir, name: m.name, a: m.a, q: m.q,
        home: items.find((n) => n.link === m.link) || {text: `${m.name} 总览`, link: m.link},
        arts: items.filter((n) => !isEdge(n)).slice(0, 3),
        list: items.find((n) => n.link === `/${m.dir}/99_interview`),
        iv: iv && {link: iv.link, title: ivTitle(iv.text), no: pad(parseInt(m.interview[0], 10))},
    };
}).filter((w) => w.arts.length);
/* 延伸阅读：同排卡片等高，模块少的卡片下方会空出一块；挂载后按实际空白算能放几行，从本组各模块轮流取正文补足，不撑高整行 */
const moreOf = (g) => {
    const lists = g.modules.map((m) => flat(navData[m.dir])
        .filter((n) => n.link && n.link !== m.link && n.link !== `/${m.dir}/99_interview`)
        .map((n) => ({...n, mod: m.name})));
    const out = [];
    for (let k = 0; out.length < 12 && lists.some((l) => k < l.length); k++) {
        lists.forEach((l) => { if (k < l.length && out.length < 12) out.push(l[k]); });
    }
    return out;
};
const more = Object.fromEntries(groups.map((g) => [g.no, moreOf(g)]));
const fill = ref({});
const FILL = {head: 36, row: 24, min: 2, safe: 10};
const measureFill = async () => {
    const el = root.value;
    if (!el) return;
    fill.value = {};
    await nextTick();
    const next = {};
    el.querySelectorAll('[data-fill]').forEach((cell) => {
        const mods = cell.querySelector('.mods');
        const start = cell.querySelector('.gstart');
        if (!mods || !start) return;
        const gap = start.getBoundingClientRect().top - mods.getBoundingClientRect().bottom;
        const n = Math.min(more[cell.dataset.fill].length, Math.floor((gap - FILL.head - FILL.safe + 4) / FILL.row));
        if (n >= FILL.min) next[cell.dataset.fill] = n;
    });
    fill.value = next;
};
const walkIdx = ref(Math.max(0, walks.findIndex((w) => w.dir === 'cache')));
const walk = computed(() => walks[walkIdx.value]);
const nextWalk = () => { walkIdx.value = (walkIdx.value + 1) % walks.length; };

/* ---------- Bento 排版：首行 = 面试题解 + 第一组；其余每行 3 格（12 栏按文章数分 5/4/3），末行不足时自动改为 2 格 ---------- */
const lead = groups[0];
const items = [...groups.slice(1).map((g) => ({kind: 'g', g, w: g.arts})), {kind: 'gd', w: Infinity}];
const rows = [];
let rest = items.slice();
while (rest.length) {
    const take = rest.length === 4 ? 2 : Math.min(3, rest.length);
    rows.push(rest.slice(0, take));
    rest = rest.slice(take);
}
const SPANS = {1: [12], 2: [7, 5], 3: [5, 4, 3]};
const SIZE = {12: 'l', 7: 'l', 5: 'l', 4: 'm', 3: 's'};
rows.forEach((row) => {
    const rank = row.map((it, k) => [it.w, k]).sort((x, y) => y[0] - x[0] || x[1] - y[1]);
    rank.forEach(([, k], r) => { row[k].span = SPANS[row.length][r]; row[k].size = SIZE[row[k].span]; });
});
const tail = rows.flat();
const restGroups = groups.length - 1;
tail.forEach((it, k) => {
    // 两栏（平板）时：读法卡占满一行；组数为奇数时，最后一组也占满一行，避免空洞
    it.wideMd = it.kind === 'gd' || (restGroups % 2 === 1 && it.kind === 'g' && it.g.i === groups.length - 1);
});
const cellStyle = (g, extra = {}) => ({'--c': g.c, '--c2': g.c2, ...extra});
const showModCount = (g, size) => !g.qs || size === 'xl';

/* ---------- 首屏封面环形文字 ---------- */
const ringText = ['JAVA DOC', ...groups.map((g) => g.name)].join(' · ') + ' ·';

/* ---------- 入场：仅一次性渐显；系统要求减少动态时不做 ---------- */
const root = ref(null);
let io = null;
let fillTimer = 0;
const onResize = () => { clearTimeout(fillTimer); fillTimer = setTimeout(measureFill, 150); };
onMounted(() => {
    const el = root.value;
    if (!el) return;
    measureFill();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(measureFill);
    window.addEventListener('resize', onResize);
    let reduce = false;
    try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { /* ignore */ }
    if (reduce || !('IntersectionObserver' in window)) return;
    const targets = Array.from(el.querySelectorAll('[data-reveal]'));
    const vh = window.innerHeight || 0;
    targets.forEach((t) => { if (t.getBoundingClientRect().top < vh) t.classList.add('in'); });
    el.classList.add('js-reveal');
    io = new IntersectionObserver((entries) => {
        entries.forEach((en) => {
            if (!en.isIntersecting) return;
            en.target.classList.add('in');
            io.unobserve(en.target);
        });
    }, {rootMargin: '0px 0px -8% 0px', threshold: .12});
    targets.filter((t) => !t.classList.contains('in')).forEach((t) => io.observe(t));
});
onBeforeUnmount(() => { if (io) io.disconnect(); window.removeEventListener('resize', onResize); clearTimeout(fillTimer); });
</script>

<template>
  <div ref="root" class="editorial-home">
    <svg width="0" height="0" class="sprite" aria-hidden="true" focusable="false">
      <symbol id="ed-i-arrow" viewBox="0 0 16 16"><path d="M2.75 8h10M8.75 3.75 13 8l-4.25 4.25" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></symbol>
      <symbol id="ed-i-ne" viewBox="0 0 16 16"><path d="M4.5 11.5 11.5 4.5M5.75 4.5h5.75v5.75" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></symbol>
      <symbol id="ed-i-down" viewBox="0 0 16 16"><path d="M8 2.75v10M3.75 8.75 8 13l4.25-4.25" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></symbol>
    </svg>

    <!-- ============ 01 封面 ============ -->
    <section class="hero" aria-labelledby="ed-hero-title">
      <div class="bg-layer" aria-hidden="true"><span class="gridlines"></span></div>
      <div class="wrap">
        <div class="rail" data-hero style="--d:0">
          <span><b>Java Doc</b></span>
          <span class="rail__mid">Java 后端技术知识体系</span>
          <span><template v-if="since">{{ since }} — 至今 · </template>持续更新</span>
        </div>

        <div class="hero__grid">
          <div class="hero__main">
            <h1 id="ed-hero-title" class="headline">
              <span class="sr-only">Java Doc：</span>
              <span class="hl"><span class="hl__in" data-hero style="--d:1"><em class="serif-it">Java</em> 后端，</span></span>
              <span class="hl"><span class="hl__in hl__in--grad" data-hero style="--d:2">成体系地读。</span></span>
            </h1>
            <p class="dek" data-hero style="--d:4">开发总结 + 工程实践参考手册。<b>{{ totals.modules }}</b> 个模块、<b>{{ totals.articles }}</b> 篇文章，<br class="br-lg">从语言机制、JVM 到分布式与三高架构，按学习路径编排。</p>
            <div class="actions" data-hero style="--d:5">
              <RouteLink class="btn btn--primary" :to="summaryLink">{{ SUMMARY.name }}<svg aria-hidden="true"><use href="#ed-i-arrow"/></svg></RouteLink>
              <RouteLink class="btn btn--ghost" :to="startLink">开始阅读</RouteLink>
              <a class="link-u" href="#ed-route"><span>查看学习路线</span><svg aria-hidden="true"><use href="#ed-i-down"/></svg></a>
            </div>
          </div>

          <div class="hero__art" data-hero style="--d:2" aria-hidden="true">
            <div class="art">
              <span class="art__glow"></span>
              <svg class="art__svg" viewBox="0 0 440 440">
                <defs>
                  <linearGradient id="ed-art-grad" x1="40" y1="40" x2="400" y2="400" gradientUnits="userSpaceOnUse">
                    <stop offset="0" stop-color="#ff6b9d"/><stop offset=".5" stop-color="#a855f7"/><stop offset="1" stop-color="#38bdf8"/>
                  </linearGradient>
                  <path id="ed-ring-path" d="M 220 220 m -196 0 a 196 196 0 1 1 392 0 a 196 196 0 1 1 -392 0"/>
                </defs>
                <text class="art__ringtext"><textPath href="#ed-ring-path" textLength="1226" lengthAdjust="spacing">{{ ringText }}</textPath></text>
                <circle class="art__ring" cx="220" cy="220" r="176"/>
                <circle class="art__arc" cx="220" cy="220" r="176" stroke="url(#ed-art-grad)" pathLength="100" stroke-dasharray="16 84" transform="rotate(-62 220 220)"/>
                <circle class="art__ticks" cx="220" cy="220" r="156" pathLength="360" stroke-dasharray=".45 4.55"/>
                <circle class="art__ring art__ring--dash" cx="220" cy="220" r="132"/>
                <circle cx="372" cy="132" r="5.5" fill="url(#ed-art-grad)"/>
                <circle class="art__dot" cx="96" cy="296" r="3"/>
              </svg>
              <img class="art__logo" :src="logo" alt="" width="512" height="512">
            </div>
          </div>
        </div>

        <ol class="coverlines" aria-label="要目">
          <li v-for="(c, k) in coverlines" :key="k" data-hero :style="{'--d': 6 + k}">
            <RouteLink class="cl" :to="c.to">
              <span class="cl__num">{{ c.n }}<small>{{ c.u }}</small></span>
              <span class="cl__body"><span class="cl__t">{{ c.t }}</span><span class="cl__d">{{ c.d }}</span></span>
              <svg class="cl__arrow" aria-hidden="true"><use href="#ed-i-ne"/></svg>
            </RouteLink>
          </li>
        </ol>
      </div>
    </section>

    <!-- ============ 02 本站数据 ============ -->
    <section class="numbers" aria-labelledby="ed-numbers-title">
      <div class="wrap">
        <div class="numbers__head" data-reveal>
          <div>
            <p class="kicker"><span>01</span>By the numbers</p>
            <h2 id="ed-numbers-title" class="sec-title sec-title--sm">本站数据</h2>
          </div>
          <p class="numbers__note">按当前仓库内容统计</p>
        </div>

        <dl class="stats" data-reveal style="--i:1">
          <div v-for="s in statList" :key="s.t" class="stat">
            <dt>{{ s.t }}<small>{{ s.s }}</small></dt>
            <dd><span class="stat__n">{{ s.n }}</span><span class="stat__u">{{ s.u }}</span></dd>
          </div>
        </dl>

        <figure class="comp" data-reveal style="--i:2">
          <figcaption class="comp__cap"><span><b>{{ totals.articles }} 篇</b>文章 · 按分组分布</span><span>01 → {{ lastNo }} 即推荐阅读顺序</span></figcaption>
          <div class="comp__bar" aria-hidden="true">
            <span v-for="g in groups" :key="g.no" class="comp__seg" :style="{'--n': g.arts, '--c': g.c, '--i': g.i}"></span>
          </div>
          <ul class="comp__legend">
            <li v-for="g in groups" :key="g.no" :style="{'--n': g.arts, '--c': g.c}"><b>{{ g.name }}</b><i>{{ g.arts }} 篇</i></li>
          </ul>
        </figure>
      </div>
    </section>

    <!-- ============ 03 目录 Bento ============ -->
    <section class="contents" aria-labelledby="ed-contents-title">
      <div class="bg-layer bg-layer--mesh" aria-hidden="true"><span class="gridlines"></span></div>
      <div class="wrap">
        <header class="sec-head" data-reveal>
          <div>
            <p class="kicker"><span>02</span>Contents</p>
            <h2 id="ed-contents-title" class="sec-title">{{ cn(groups.length) }}个分组，<br><span class="grad-text">一张总图。</span></h2>
          </div>
          <p class="sec-dek">格子大小按文章数排版，编号即推荐阅读顺序。「篇」为文章数，「题」为模块题目清单中的题目数。</p>
        </header>

        <div class="bento">
          <!-- 00 面试题解 -->
          <article class="cell cell--iv" :style="{'--c': colors[0], '--c2': colors[colors.length - 1], '--i': 0}" data-reveal aria-labelledby="ed-t-00">
            <span class="gridlines" aria-hidden="true"></span>
            <div class="iv__top">
              <div>
                <p class="cell__head"><span class="cell__no">00</span><span>Cover story</span></p>
                <h3 id="ed-t-00" class="iv__title">{{ SUMMARY.name }}</h3>
                <p class="iv__desc">全站高频题答案汇总：{{ totals.answerPages }} 个答案页，按导航分组组织，适合临考速查与复盘。</p>
              </div>
              <div class="iv__figs">
                <p class="iv__fig"><b>{{ totals.answerPages }}</b><span>答案页</span></p>
                <p class="iv__fig"><b>{{ totals.questions }}</b><span>清单题目</span></p>
              </div>
            </div>
            <div class="iv__groups">
              <div v-for="d in digest" :key="d.name" class="ivg">
                <p class="ivg__name">{{ d.name }}</p>
                <ul class="chips">
                  <li v-for="p in d.pages" :key="p.link"><RouteLink class="chip" :to="p.link"><i>{{ p.no }}</i>{{ p.text }}</RouteLink></li>
                </ul>
              </div>
            </div>
            <div class="iv__foot">
              <RouteLink class="btn btn--light" :to="summaryLink">进入{{ SUMMARY.name }}<svg aria-hidden="true"><use href="#ed-i-arrow"/></svg></RouteLink>
              <p class="iv__note">模块内的题目清单与这里的答案页互相链接</p>
            </div>
          </article>

          <!-- 第一组：与面试题解同排的大格 -->
          <article v-if="lead" :id="`ed-g-${lead.no}`" :data-fill="lead.no" class="cell cell--xl cell--lead" :class="{'cell--tint': lead === hotGroup}"
                   :style="cellStyle(lead, {'--i': 1})" data-reveal :aria-labelledby="`ed-t-${lead.no}`">
            <span class="cell__wm" aria-hidden="true">{{ lead.arts }}</span>
            <p class="cell__head"><span class="cell__no">{{ lead.no }}</span></p>
            <h3 :id="`ed-t-${lead.no}`" class="cell__title">{{ lead.name }}</h3>
            <p class="cell__tag">{{ lead.tagline }}</p>
            <p class="cell__meta">
              <span><b>{{ lead.arts }}</b> 篇</span>
              <span v-if="lead.qs" :class="{hot: lead === hotGroup}"><b>{{ lead.qs }}</b> 题</span>
              <span v-if="showModCount(lead, 'xl')"><b>{{ lead.modules.length }}</b> 个模块</span>
            </p>
            <ul class="mods">
              <li v-for="m in lead.modules" :key="m.dir">
                <RouteLink class="mod" :to="m.link">
                  <span class="mod__row"><span class="mod__name">{{ m.name }}<span v-if="m.stub" class="badge">{{ m.stub }}</span></span><span class="mod__lead"></span><span class="mod__meta">{{ m.a }} 篇<template v-if="m.q"> · {{ m.q }} 题</template></span><svg class="mod__arrow" aria-hidden="true"><use href="#ed-i-arrow"/></svg></span>
                  <span class="mod__desc">{{ m.desc }}</span>
                </RouteLink>
              </li>
            </ul>
            <div v-if="fill[lead.no]" class="gmore">
              <p class="gmore__label">延伸阅读</p>
              <ul>
                <li v-for="a in more[lead.no].slice(0, fill[lead.no])" :key="a.link"><RouteLink :to="a.link"><span class="gmore__t">{{ a.text }}</span><span class="gmore__m">{{ a.mod }}</span></RouteLink></li>
              </ul>
            </div>
            <p v-if="lead.start" class="gstart"><span>从这里开始</span><RouteLink class="gstart__link" :to="lead.start.link">{{ lead.start.text }}</RouteLink></p>
          </article>

          <template v-for="(it, k) in tail" :key="it.kind === 'g' ? it.g.no : 'gd'">
            <article v-if="it.kind === 'g'" :id="`ed-g-${it.g.no}`" :data-fill="it.g.no" class="cell" :class="[`cell--${it.size}`, {'cell--tint': it.g === hotGroup, 'cell--wide-md': it.wideMd}]"
                     :style="cellStyle(it.g, {'--span': it.span, '--i': k + 2})" data-reveal :aria-labelledby="`ed-t-${it.g.no}`">
              <span class="cell__wm" aria-hidden="true">{{ it.g.arts }}</span>
              <p class="cell__head"><span class="cell__no">{{ it.g.no }}</span></p>
              <h3 :id="`ed-t-${it.g.no}`" class="cell__title">{{ it.g.name }}</h3>
              <p class="cell__tag">{{ it.g.tagline }}</p>
              <p class="cell__meta">
                <span><b>{{ it.g.arts }}</b> 篇</span>
                <span v-if="it.g.qs" :class="{hot: it.g === hotGroup}"><b>{{ it.g.qs }}</b> 题</span>
                <span v-if="showModCount(it.g, it.size)"><b>{{ it.g.modules.length }}</b> 个模块</span>
              </p>
              <ul class="mods">
                <li v-for="m in it.g.modules" :key="m.dir">
                  <RouteLink class="mod" :to="m.link">
                    <span class="mod__row"><span class="mod__name">{{ m.name }}<span v-if="m.stub" class="badge">{{ m.stub }}</span></span><span class="mod__lead"></span><span class="mod__meta">{{ m.a }} 篇<template v-if="m.q"> · {{ m.q }} 题</template></span><svg class="mod__arrow" aria-hidden="true"><use href="#ed-i-arrow"/></svg></span>
                    <span class="mod__desc">{{ m.desc }}</span>
                  </RouteLink>
                </li>
              </ul>
              <div v-if="fill[it.g.no]" class="gmore">
                <p class="gmore__label">延伸阅读</p>
                <ul>
                  <li v-for="a in more[it.g.no].slice(0, fill[it.g.no])" :key="a.link"><RouteLink :to="a.link"><span class="gmore__t">{{ a.text }}</span><span class="gmore__m">{{ a.mod }}</span></RouteLink></li>
                </ul>
              </div>
              <p v-if="it.g.start" class="gstart"><span>从这里开始</span><RouteLink class="gstart__link" :to="it.g.start.link">{{ it.g.start.text }}</RouteLink></p>
            </article>

            <!-- 读法 -->
            <article v-else class="cell cell--gd" :class="{'cell--wide-md': it.wideMd}" :style="{'--span': it.span, '--i': k + 2}" data-reveal aria-labelledby="ed-t-gd">
              <p class="cell__head"><span class="cell__no">读法</span><span>How to read</span></p>
              <h3 id="ed-t-gd" class="cell__title">总览 → 正文 → 题目清单</h3>
              <p class="cell__tag">每个模块都从 0 号总览页进入，正文从 1 号起按编号排列。</p>
              <div v-if="walk" class="walk">
                <p class="walk__hd">
                  <span>以「{{ walk.name }}」为例走一遍</span>
                  <span class="walk__meta">{{ walk.a }} 篇<template v-if="walk.q"> · {{ walk.q }} 题</template></span>
                  <button type="button" class="walk__sw" @click="nextWalk">换一个模块</button>
                </p>
                <ol class="walk__rail" aria-live="polite">
                  <li><RouteLink class="walk__st" :to="walk.home.link"><span class="walk__k grad-text">00</span><span class="walk__t">{{ walk.home.text }}</span><span class="walk__d">模块地图与推荐阅读路径</span></RouteLink></li>
                  <li>
                    <RouteLink class="walk__st" :to="walk.arts[0].link">
                      <span class="walk__k grad-text">01+</span><span class="walk__t">正文 {{ walk.a }} 篇</span>
                      <span v-for="n in walk.arts" :key="n.link" class="walk__art">{{ n.text }}</span>
                      <span v-if="walk.a > walk.arts.length" class="walk__d">…… 按编号往下读</span>
                    </RouteLink>
                  </li>
                  <li v-if="walk.list"><RouteLink class="walk__st" :to="walk.list.link"><span class="walk__k grad-text">99</span><span class="walk__t">{{ walk.list.text }}</span><span class="walk__d">{{ walk.q }} 题，可切自测模式</span></RouteLink></li>
                  <li v-if="walk.iv"><RouteLink class="walk__st" :to="walk.iv.link"><span class="walk__k grad-text">{{ walk.iv.no }}</span><span class="walk__t">{{ walk.iv.title }}</span><span class="walk__d">一句话结论 + 要点</span></RouteLink></li>
                </ol>
                <p class="walk__loop">答案末尾的「→ 详见」链接回到对应正文，读完一个模块形成闭环</p>
              </div>
              <ol class="steps">
                <li><span class="steps__k grad-text">00</span><span class="steps__t">总览页</span><span class="steps__d">模块简介、导航表与推荐阅读路径</span></li>
                <li><span class="steps__k grad-text">01+</span><span class="steps__t">正文</span><span class="steps__d">按编号顺序阅读，配 SVG 图解</span></li>
                <li><span class="steps__k grad-text">99</span><span class="steps__t">题目清单</span><span class="steps__d">每个模块都有，答案汇总在{{ SUMMARY.name }}</span></li>
              </ol>
              <p class="gd__note">尚未完成的篇章，以「待补充」明确标注。</p>
            </article>
          </template>
        </div>
      </div>
    </section>

    <!-- ============ 04 学习路线 ============ -->
    <section id="ed-route" class="route-sec" aria-labelledby="ed-route-title">
      <div class="wrap">
        <header class="sec-head" data-reveal>
          <div>
            <p class="kicker"><span>03</span>Route</p>
            <h2 id="ed-route-title" class="sec-title">{{ cn(groups.length) }}站，<br><span class="grad-text">从地基到边界。</span></h2>
          </div>
          <p class="sec-dek">顺序读是一条完整路线，每一站也能单独进入；读完回到{{ SUMMARY.name }}复盘。也可以<RouteLink class="link-u" to="/interview/91_routes">按目标选路线 →</RouteLink></p>
        </header>

        <ol class="route" data-reveal :style="{'--stops': groups.length + 1}">
          <li v-for="g in groups" :key="g.no" class="stop" :style="{'--c': g.c, '--i': g.i}">
            <span class="stop__no">{{ g.no }}</span><span class="stop__dot" aria-hidden="true"></span>
            <a class="stop__name" :href="`#ed-g-${g.no}`">{{ g.name }}</a>
            <ul class="stop__mods"><li v-for="m in g.modules" :key="m.dir">{{ m.name }}</li></ul>
            <span class="stop__count">{{ g.arts }} 篇</span>
          </li>
          <li class="stop stop--end" :style="{'--c': brandAt(.5), '--i': groups.length}">
            <span class="stop__no">终点</span><span class="stop__dot" aria-hidden="true"></span>
            <RouteLink class="stop__name" :to="summaryLink">{{ SUMMARY.name }}</RouteLink>
            <ul class="stop__mods"><li>{{ totals.answerPages }} 个答案页</li><li>临考速查</li><li>复盘</li></ul>
            <span class="stop__count">{{ totals.questions }} 题</span>
          </li>
        </ol>
      </div>
    </section>

    <!-- ============ 05 尾声 + 延伸阅读 ============ -->
    <section class="coda" aria-labelledby="ed-coda-title">
      <div class="wrap">
        <div class="coda__panel" data-reveal>
          <div class="bg-layer bg-layer--coda" aria-hidden="true"><span class="gridlines"></span></div>
          <p class="kicker"><span>04</span>Start here</p>
          <div class="coda__grid">
            <h2 id="ed-coda-title" class="coda__title">从第一页开始，<br><span class="grad-text">按路线读下去</span><span class="endmark" aria-hidden="true"></span></h2>
            <div>
              <p class="coda__dek">{{ groups[0] && groups[0].modules[0] ? groups[0].modules[0].name : '' }} 总览是整条路线的起点；临近面试，就直接从{{ SUMMARY.name }}开始复盘。</p>
              <div class="actions">
                <RouteLink class="btn btn--primary" :to="startLink">开始阅读<svg aria-hidden="true"><use href="#ed-i-arrow"/></svg></RouteLink>
                <RouteLink class="btn btn--ghost" :to="summaryLink">{{ SUMMARY.name }}</RouteLink>
              </div>
            </div>
          </div>
        </div>

        <div class="further" data-reveal>
          <div class="further__head"><h3 class="further__title">延伸阅读</h3><span>Further reading</span></div>
          <ul class="further__list">
            <li v-for="r in REFS" :key="r.url">
              <a class="fr" :href="r.url" target="_blank" rel="noopener noreferrer">
                <span class="fr__name">{{ r.title }}</span><span class="fr__host">{{ r.host }}</span><span class="fr__desc">{{ r.desc }}</span>
                <svg aria-hidden="true"><use href="#ed-i-ne"/></svg>
              </a>
            </li>
          </ul>
        </div>
      </div>
    </section>

    <footer class="foot">{{ FOOTER }}</footer>
  </div>
</template>

<style lang="scss" src="./editorial.scss"></style>
