<script setup>
// 模块总览页的导航表：与侧边栏同一棵树（分组、顺序一致），说明取各文章 frontmatter 的 description。
// 用法：在 <dir>/0_overview.md 中写 <ModuleNav />（默认取当前页所在模块，也可传 dir="jvm"）
import {computed} from 'vue';
import {RouteLink, useRoute} from 'vuepress/client';
import navData from '@temp/module-nav.js';

const props = defineProps({dir: {type: String, default: ''}});
const route = useRoute();
const dir = computed(() => props.dir || route.path.split('/').filter(Boolean)[0]);

// description 中允许 [文字](/站内路径) 形式的链接
const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;
const parts = (text) => {
    const out = [];
    let last = 0;
    for (const m of (text ?? '').matchAll(LINK)) {
        if (m.index > last) out.push({text: text.slice(last, m.index)});
        out.push({text: m[1], link: m[2]});
        last = m.index + m[0].length;
    }
    if (last < (text ?? '').length) out.push({text: text.slice(last)});
    return out;
};

const rows = computed(() => {
    const out = [];
    const self = `/${dir.value}/0_overview`;
    const walk = (items, prefix) => {
        let afterGroup = false;
        for (const it of items) {
            if (it.children) {
                const label = prefix ? `${prefix} · ${it.text}` : it.text;
                out.push({type: 'group', text: label});
                walk(it.children, label);
                afterGroup = true;
            } else if (it.link !== self) {
                // 分组之后的独立条目（附录、题单）单独起一行「其他」，避免看起来属于上一组
                if (afterGroup) {
                    out.push({type: 'group', text: prefix ? `${prefix} · 其他` : '其他'});
                    afterGroup = false;
                }
                out.push({type: 'item', ...it, parts: parts(it.description)});
            }
        }
    };
    walk(navData[dir.value] ?? [], '');
    return out;
});
// 面试题解的答案页带「对应题目清单」（由 site.js 各模块的 interview 字段反推）
const hasLists = computed(() => rows.value.some((r) => r.lists));
</script>

<template>
  <table class="module-nav">
    <thead>
      <tr><th>文档</th><th>覆盖内容</th><th v-if="hasLists">对应题目清单</th></tr>
    </thead>
    <tbody>
      <template v-for="(r, i) in rows" :key="i">
        <tr v-if="r.type === 'group'" class="module-nav-group">
          <td :colspan="hasLists ? 3 : 2">{{ r.text }}</td>
        </tr>
        <tr v-else>
          <td class="module-nav-doc"><RouteLink :to="r.link">{{ r.text }}</RouteLink></td>
          <td>
            <template v-for="(p, j) in r.parts" :key="j">
              <RouteLink v-if="p.link" :to="p.link">{{ p.text }}</RouteLink>
              <template v-else>{{ p.text }}</template>
            </template>
          </td>
          <td v-if="hasLists" class="module-nav-doc">
            <template v-for="(l, k) in r.lists ?? []" :key="l.link">
              <template v-if="k"> / </template><RouteLink :to="l.link">{{ l.text }}</RouteLink>
            </template>
          </td>
        </tr>
      </template>
    </tbody>
  </table>
</template>

<style lang="scss">
.module-nav {
  .module-nav-doc {
    white-space: nowrap;
  }

  .module-nav-group td {
    font-weight: 600;
    text-align: left;
    background: var(--vp-c-bg-alt, rgba(127, 127, 127, 0.06));
  }
}
</style>
