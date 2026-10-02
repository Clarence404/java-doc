<script setup>
import {onBeforeUnmount, onMounted, ref} from 'vue';
import {RouteLink, resolveRoutePath, useRouter, withBase} from 'vuepress/client';
import stats from '@temp/home-stats.js';
import navData from '@temp/module-nav.js';
import {FOOTER, REFS} from '../../site.js';
import {DISC, WIDE, buildAtlas, buildGlyph, buildModel, defaultCaption, mountAtlas, paletteStyle} from './atlas.js';

const model = buildModel(stats);
const {groups, goals, totals} = model;
const atlasSvg = [WIDE, DISC].map((L) => buildAtlas(model, L, withBase)).join('');
const glyphs = groups.map((g) => buildGlyph(model, g.i));
const caption = defaultCaption(model);
// 开发总结速查：直接取开发总结目录的侧边栏分组（分组名与星图方向同名），标题与说明来自各答案页
const digest = (navData.interview ?? [])
    .filter((n) => n.children)
    .map((n) => ({g: groups.find((g) => g.name === n.text), pages: n.children.map((c) => [c.text, c.link, c.description])}))
    .filter((c) => c.g);
const palette = paletteStyle(groups.length);
const pct = (n) => Math.round(n / (totals.articles || 1) * 100);
const gstyle = (i) => ({'--c': `var(--c${i + 1})`, '--t': `var(--t${i + 1})`});
const figs = [
    [totals.modules, '技术模块'],
    [totals.articles, '篇文章'],
    [totals.questions, '道题单题目'],
    [totals.answerPages, '个答案页'],
    [totals.svgs, '幅 SVG 图解'],
    [23, '种 GoF 设计模式'],
];

const root = ref(null);
const router = useRouter();
let cleanup = null;
onMounted(() => {
    cleanup = mountAtlas(root.value, model, {withBase, navigate: (p) => router.push(resolveRoutePath(p))});
});
onBeforeUnmount(() => cleanup && cleanup());
</script>

<template>
  <div ref="root" class="atlas-home" :style="palette">
    <!-- ============ 首屏：品牌 + 知识星图 ============ -->
    <section class="hero" aria-labelledby="hero-title">
      <div class="wrap hero-grid">
        <div class="hero-text">
          <p class="kicker"><span class="bar" aria-hidden="true"></span>Knowledge Atlas · 知识星图</p>
          <h1 id="hero-title">
            <span class="h1-en">Java <i>Doc</i></span>
            <span class="h1-zh">Java 后端技术知识体系</span>
          </h1>
          <p class="lead">开发总结 + 工程实践参考手册。{{ totals.modules }} 个模块沿一条推荐路径排布：从语言与运行时出发，经框架、存储、分布式与三高，抵达架构、效能与运维。</p>
          <div class="actions">
            <RouteLink class="btn btn-primary" to="/interview/0_overview">开发总结
              <svg class="arr" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4"/></svg>
            </RouteLink>
            <RouteLink class="btn btn-ghost" to="/java/0_overview">开始阅读</RouteLink>
            <a class="quiet" href="#catalogue">浏览全部 {{ totals.modules }} 个模块</a>
          </div>
          <ul class="figs" aria-label="站点数据">
            <li v-for="f in figs" :key="f[1]"><b>{{ f[0] }}</b><span>{{ f[1] }}</span></li>
          </ul>
        </div>

        <figure class="plate" aria-labelledby="fig-cap-title">
          <div class="plate-head">
            <div id="fig-cap-title" class="ph-t">Fig. 1<b>知识星图</b></div>
            <ul class="keys" aria-label="图例">
              <li><svg viewBox="0 0 22 14" aria-hidden="true"><circle class="k-dot" cx="11" cy="7" r="4"/></svg>文章数</li>
              <li><svg viewBox="0 0 22 14" aria-hidden="true"><circle class="k-dot" cx="11" cy="7" r="3"/><circle class="k-ring" cx="11" cy="7" r="6"/></svg>题单题数</li>
              <li><svg viewBox="0 0 22 14" aria-hidden="true"><circle class="k-hollow" cx="11" cy="7" r="3.2"/><circle class="k-dash" cx="11" cy="7" r="6"/></svg>编写中</li>
              <li><svg viewBox="0 0 22 14" aria-hidden="true"><path class="k-route" d="M1 7h20"/></svg>学习路径</li>
              <li><svg viewBox="0 0 22 14" aria-hidden="true"><path class="k-rel" d="M1 9Q11 1 21 9"/></svg>关联</li>
            </ul>
          </div>
          <div class="goals">
            <span id="goals-l" class="goals-l">按目标选路径</span>
            <div class="seg" role="tablist" aria-labelledby="goals-l">
              <button type="button" role="tab" aria-selected="true" data-k="-1">全部方向</button>
              <button v-for="(g, k) in goals" :key="g.name" type="button" role="tab" aria-selected="false" tabindex="-1" :data-k="k">{{ g.name }}</button>
            </div>
          </div>
          <div class="atlas-wrap" v-html="atlasSvg"></div>
          <div class="share">
            <p class="share-h"><span><b>{{ totals.articles }}</b>篇文章 · 按方向分布</span><span>01 → {{ groups[groups.length - 1].no }} 即推荐阅读顺序</span></p>
            <div class="share-bar">
              <button v-for="g in groups" :key="g.no" class="sh" type="button" aria-pressed="false" :data-g="g.i"
                      :style="{'--n': g.arts, '--c': `var(--c${g.i + 1})`, '--i': g.i}"
                      :title="`${g.no} ${g.name} · ${g.arts} 篇 · ${pct(g.arts)}%`"
                      :aria-label="`${g.no} ${g.name}：${g.arts} 篇，占 ${pct(g.arts)}%`"></button>
            </div>
          </div>
          <ul class="chips" aria-label="按方向点亮星图">
            <li v-for="g in groups" :key="g.no">
              <button class="chip" type="button" aria-pressed="false" :data-g="g.i" :style="gstyle(g.i)">
                <i aria-hidden="true"></i><span class="ci">{{ g.no }}</span>{{ g.name }}<span class="cn">{{ g.arts }} 篇</span>
              </button>
            </li>
          </ul>
          <figcaption class="caption" aria-live="polite" v-html="caption"></figcaption>
        </figure>
      </div>
    </section>

    <!-- ============ § 01 开发总结 ============ -->
    <section id="digest" class="sec" aria-labelledby="digest-title">
      <div class="wrap">
        <div class="sec-head reveal">
          <div>
            <p class="sec-no">§ 01 · 开发总结</p>
            <h2 id="digest-title">高频题答案，按方向速查</h2>
          </div>
          <div>
            <p class="sec-desc">各模块末尾的题目清单只列题目，答案统一收录在 {{ totals.answerPages }} 个答案页中，按导航分组组织。适合临考速查，也适合读完正文后复盘。</p>
            <div class="sec-meta">
              <span class="meta-line"><b>{{ totals.answerPages }}</b> 个答案页 · <b>{{ digest.length }}</b> 个方向 · 题单共 <b>{{ totals.questions }}</b> 道</span>
              <RouteLink class="link-arrow" to="/interview/0_overview">进入开发总结
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4"/></svg>
              </RouteLink>
            </div>
          </div>
        </div>
        <div class="dg reveal">
          <div v-for="col in digest" :key="col.g.no" class="dg-col" :style="gstyle(col.g.i)">
            <p class="dg-h"><i aria-hidden="true"></i><span class="n">{{ col.g.no }}</span>{{ col.g.name }}</p>
            <ul>
              <li v-for="p in col.pages" :key="p[1]">
                <RouteLink :to="p[1]">
                  <b>{{ p[0] }}<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4"/></svg></b>
                  <span>{{ p[2] }}</span>
                </RouteLink>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </section>

    <!-- ============ § 02 星表 ============ -->
    <section id="catalogue" class="sec" aria-labelledby="cat-title">
      <div class="wrap">
        <div class="sec-head reveal">
          <div>
            <p class="sec-no">§ 02 · 星表</p>
            <h2 id="cat-title">{{ totals.modules }} 个模块，按学习路径排列</h2>
          </div>
          <div>
            <p class="sec-desc">由语言与运行时出发，经框架、存储、分布式与三高，抵达架构设计、研发效能、运维保障与垂直领域。每个模块的总览页都附导航表与推荐阅读顺序。</p>
            <div class="sec-meta">
              <span class="meta-line"><b>{{ groups.length }}</b> 个方向 · <b>{{ totals.modules }}</b> 个模块 · <b>{{ totals.articles }}</b> 篇文章</span>
              <span class="meta-line"><span class="badge" style="--t: var(--muted)">编写中</span> 表示部分篇章仍在编写</span>
            </div>
          </div>
        </div>
      </div>
      <nav class="route" aria-label="学习路径">
        <div class="wrap">
          <ol>
            <li v-for="g in groups" :key="g.no">
              <a :href="`#g-${g.no}`" :data-g="g.i" :style="gstyle(g.i)"><i aria-hidden="true"></i><span class="n">{{ g.no }}</span>{{ g.name }}</a>
            </li>
          </ol>
        </div>
      </nav>
      <div class="wrap">
        <section v-for="g in groups" :id="`g-${g.no}`" :key="g.no" class="gblock reveal" :data-g="g.i" :aria-labelledby="`gh-${g.no}`" :style="gstyle(g.i)">
          <div class="g-aside">
            <div class="g-top"><span class="g-no" aria-hidden="true">{{ g.no }}</span><h3 :id="`gh-${g.no}`">{{ g.name }}</h3></div>
            <p class="g-tag">{{ g.tagline }}</p>
            <div class="glyph-wrap" v-html="glyphs[g.i]"></div>
            <div class="g-stats"><b>{{ g.modules.length }}</b> 模块 · <b>{{ g.arts }}</b> 篇<template v-if="g.qs"> · <b>{{ g.qs }}</b> 题</template></div>
          </div>
          <ul class="mlist">
            <li v-for="(m, j) in g.modules" :key="m.dir">
              <RouteLink class="mrow" :to="m.link">
                <span class="m-i" aria-hidden="true">{{ g.i + 1 }}.{{ j + 1 }}</span>
                <span class="m-n">{{ m.name }}<span v-if="m.stub" class="badge">{{ m.stub }}</span></span>
                <span class="m-d">{{ m.desc }}</span>
                <span class="m-meta"><span>{{ m.a }} 篇</span><span v-if="m.q">{{ m.q }} 题</span><span v-else class="z" aria-label="无题单">—</span></span>
                <svg class="m-arr" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4"/></svg>
              </RouteLink>
            </li>
          </ul>
        </section>
      </div>
    </section>

    <!-- ============ § 03 延伸阅读 ============ -->
    <section class="sec" aria-labelledby="ref-title">
      <div class="wrap">
        <div class="sec-head reveal">
          <div>
            <p class="sec-no">§ 03 · 延伸阅读</p>
            <h2 id="ref-title">推荐博客</h2>
          </div>
          <p class="sec-desc">几位同行整理的知识体系与源码解读，适合与本站对照阅读。</p>
        </div>
        <ol class="refs reveal">
          <li v-for="(r, i) in REFS" :key="r.url">
            <a :href="r.url" target="_blank" rel="noopener noreferrer">
              <span class="rn">[{{ i + 1 }}]</span><span class="rt">{{ r.title }}</span><span class="rd">{{ r.host }}</span><span class="rx">{{ r.desc }}</span>
            </a>
          </li>
        </ol>
      </div>
    </section>

    <footer class="foot"><div class="wrap">{{ FOOTER }}</div></footer>
  </div>
</template>

<style lang="scss" src="./atlas.scss"></style>
