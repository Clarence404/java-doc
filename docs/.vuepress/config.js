import {defineUserConfig} from 'vuepress';
import {hopeTheme} from 'vuepress-theme-hope';
import {viteBundler} from '@vuepress/bundler-vite';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';
import {computeHomeStats, homeStatsPlugin} from './plugins/homeStats.js';
import {GROUPS, SUMMARY, overviewLink} from './site.js';

// 导航栏风格：统一读 .env 里的 NAVBAR_STYLE
//   flat      → 所有模块平铺展开
//   dropdown  → 分组下拉菜单
// 本地：改 .env 文件即可；CI/CD：workflow env 里覆盖
const NAVBAR_STYLE = process.env.NAVBAR_STYLE ?? 'dropdown';

// 导航栏由 site.js 生成：导航文字优先用模块的 nav 短名
const navItem = m => ({text: m.nav ?? m.name, link: overviewLink(m.dir)});
const summaryNav = {text: SUMMARY.name, link: overviewLink(SUMMARY.dir)};
const navbarFlat = [summaryNav, ...GROUPS.flatMap(g => g.modules.map(navItem))];
const navbarDropdown = [summaryNav, ...GROUPS.map(g => ({text: g.name, children: g.modules.map(navItem)}))];

// ============================================================
// 侧边栏：全部由目录与文章 frontmatter 自动生成，新增文章只需新建 .md
//   条目文字：第一个 # 标题（interview 去掉「 面试题解答」后缀）
//   条目顺序：0_overview 在最前，其余按文件名数字前缀，99_interview 在最后
//   分组：site.js 中模块的 sidebar 只写每组起始编号 from，编号 ≥ from 的文章归入该组（90 号以后为附录，不分组）
//   子目录：site.js 中登记了 subdirs 的模块，每个子目录自动成为一个可折叠分组
//   展开：所有分组默认收起，主题只展开当前页面所在的分组（点开其他分组时自动收起原分组）
// 同时收集每篇文章的 description，供总览页 <ModuleNav /> 自动生成导航表
// ============================================================
const docsRoot = path.resolve(__dirname, '..');
const NAV_DESC = {};

// 只解析单行 key: value 的简单 frontmatter（description）
function readFrontmatter(content) {
    const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return {};
    const fm = {};
    for (const line of m[1].split(/\r?\n/)) {
        const kv = line.match(/^(\w+):\s*(.*)$/);
        if (kv) fm[kv[1]] = kv[2].replace(/^(['"])(.*)\1$/, '$2').trim();
    }
    return fm;
}

const fileNum = name => parseInt(name.match(/^(\d+)/)?.[1] ?? '0');
const byFileOrder = (a, b) => {
    const oa = a.startsWith('0_overview') ? -1 : fileNum(a), ob = b.startsWith('0_overview') ? -1 : fileNum(b);
    // 编号相同时按去掉 .md 的文件名排序，较短的在前（如 5_spring 在 5_spring_boot 之前）
    return oa - ob || a.replace(/\.md$/, '').localeCompare(b.replace(/\.md$/, ''));
};

function getSidebarFromDir(dirPath, {stripSuffix} = {}) {
    if (!fs.existsSync(dirPath)) {
        console.warn(`Warning: Directory ${dirPath} does not exist. Skipping sidebar generation.`);
        return [];
    }
    const files = fs.readdirSync(dirPath).filter(file => file.endsWith('.md') && file !== 'README.md').sort(byFileOrder);
    return files.map(file => {
        const filePath = path.join(dirPath, file);
        const content = fs.readFileSync(filePath, 'utf-8').replace(/^﻿/, '');
        const fm = readFrontmatter(content);
        const heading = content.match(/^# (.+)/m)?.[1] ?? file;
        const link = '/' + path.relative(docsRoot, filePath).replace(/\\/g, '/').replace(/\.md$/, '');
        NAV_DESC[link] = fm.description ?? '';
        const title = stripSuffix && heading.endsWith(stripSuffix) ? heading.slice(0, -stripSuffix.length).trim() : heading;
        return {text: title, link};
    });
}

// 按起始编号分组：0_overview 与 90 号以后（附录、99 题单）不分组；其余归入 from ≤ 编号的最后一组
function groupItems(items, groups) {
    const result = [];
    const emitted = new Map();
    for (const item of items) {
        const n = fileNum(item.link.split('/').pop());
        const isOverview = item.link.endsWith('/0_overview') && n === 0;
        const group = isOverview || n >= 90 ? null : groups.filter(g => n >= g.from).at(-1);
        if (!group) {
            result.push(item);
            continue;
        }
        if (!emitted.has(group)) {
            const node = {text: group.text, collapsible: true, expanded: false, children: []};
            emitted.set(group, node);
            result.push(node);
        }
        emitted.get(group).children.push(item);
    }
    return result;
}

const subdirConf = conf => (typeof conf === 'string' ? {title: conf} : conf);

// 子目录模块：根目录文章 → 各子目录分组（按目录编号）→ 99 号题单
function getSubdirSidebar(dir, subdirs) {
    const root = getSidebarFromDir(dirOf(dir));
    const head = root.filter(i => fileNum(i.link.split('/').pop()) < 99);
    const tail = root.filter(i => fileNum(i.link.split('/').pop()) >= 99);
    const subs = Object.keys(subdirs).filter(sub => fs.existsSync(path.join(dirOf(dir), sub))).sort(byFileOrder);
    const groups = subs.map(sub => {
        const conf = subdirConf(subdirs[sub]);
        const items = getSidebarFromDir(path.join(dirOf(dir), sub));
        const children = conf.sidebar ? groupItems(items, conf.sidebar) : items;
        return {text: conf.title, link: items[0]?.link, collapsible: true, expanded: false, children};
    });
    return [...head, ...groups, ...tail];
}

const dirOf = name => path.resolve(docsRoot, name);

// 组内条目若以所在分组名（含上层分组）开头，侧边栏自动去掉该前缀，避免「MySQL 组 → MySQL 索引」式重复；
// 页面 H1、浏览器标题与搜索结果仍保留完整标题
const SEP = /^[\s·\-—:：]+/;
function stripGroupPrefix(items, ancestors = []) {
    return items.map(item => {
        if (item.children) {
            return {...item, children: stripGroupPrefix(item.children, [...ancestors, item.text])};
        }
        let text = item.text;
        for (const g of ancestors) {
            if (text.startsWith(g)) {
                const rest = text.slice(g.length).replace(SEP, '');
                if (rest) text = rest;
            }
        }
        return text === item.text ? item : {...item, text};
    });
}

const sidebarOf = ({dir, sidebar, subdirs, stripSuffix}) => {
    if (subdirs) return stripGroupPrefix(getSubdirSidebar(dir, subdirs));
    const items = getSidebarFromDir(dirOf(dir), {stripSuffix});
    return stripGroupPrefix(sidebar ? groupItems(items, sidebar) : items);
};

const ALL_MODULES = [SUMMARY, ...GROUPS.flatMap(g => g.modules)];
const buildSidebar = () => Object.fromEntries(ALL_MODULES.map(m => [`/${m.dir}/`, sidebarOf(m)]));
let SIDEBAR = buildSidebar();

// 总览页导航表数据：与侧边栏同一棵树，叶子带上文章 frontmatter 的 description，写入 @temp/module-nav.js
// 简介取自页面数据，开发时修改 description 会热更新（新增文章仍需重启，与侧边栏一致）
const missingDesc = Object.entries(NAV_DESC).filter(([link, d]) => !d && !link.endsWith('/0_overview')).map(([link]) => link);
if (missingDesc.length) console.warn(`[module-nav] ${missingDesc.length} 篇文章缺少 frontmatter description：\n  ${missingDesc.join('\n  ')}`);

// 答案页 → 对应的模块题目清单：由 site.js 中各模块的 interview 字段反推
const ANSWER_LISTS = {};
for (const m of GROUPS.flatMap(g => g.modules)) {
    for (const stem of m.interview ?? []) {
        (ANSWER_LISTS[`/${SUMMARY.dir}/${stem}`] ??= []).push({text: m.name, link: `/${m.dir}/99_interview`});
    }
}

function writeModuleNav(app) {
    const desc = Object.fromEntries(app.pages
        .filter(p => p.filePathRelative)
        .map(p => ['/' + p.filePathRelative.replace(/\.md$/, ''), p.frontmatter.description ?? '']));
    const withDesc = items => items.map(i => (i.children
        ? {text: i.text, children: withDesc(i.children)}
        : {text: i.text, link: i.link, description: desc[i.link] ?? NAV_DESC[i.link] ?? '', ...(ANSWER_LISTS[i.link] ? {lists: ANSWER_LISTS[i.link]} : {})}));
    const nav = Object.fromEntries(ALL_MODULES.map(m => [m.dir, withDesc(SIDEBAR[`/${m.dir}/`])]));
    return Promise.all([
        app.writeTemp('module-nav.js', `export default ${JSON.stringify(nav)};\n`),
        writeInterviewData(app),
    ]);
}

// 答案页（interview/*.md）的分组与题目：<InterviewList page="9_mq" /> 据此生成题单，题目链接到答案锚点
function writeInterviewData(app) {
    const data = {};
    for (const p of app.pages) {
        const rel = p.filePathRelative ?? '';
        if (!rel.startsWith('interview/') || rel.endsWith('0_overview.md')) continue;
        const groups = (p.headers ?? []).filter(h => h.level === 2).map(h => ({
            title: h.title, slug: h.slug,
            questions: (h.children ?? []).filter(c => c.level === 3).map(c => ({title: c.title, slug: c.slug})),
        }));
        data[rel.slice('interview/'.length, -3)] = {title: p.title, path: '/' + rel.replace(/\.md$/, ''), groups};
    }
    return app.writeTemp('interview-data.js', `export default ${JSON.stringify(data)};\n`);
}

// 新增 / 删除文章后重算侧边栏，覆盖主题数据临时文件（客户端通过 HMR 的 updateThemeData 即时生效）
async function refreshStructure(app) {
    SIDEBAR = buildSidebar();
    const file = app.dir.temp('internal/themeData.js');
    const src = fs.readFileSync(file, 'utf-8');
    const m = src.match(/^export const themeData = JSON\.parse\(("(?:[^"\\]|\\.)*")\)/);
    if (m) {
        const data = JSON.parse(JSON.parse(m[1]));
        data.locales['/'].sidebar = SIDEBAR;
        await app.writeTemp('internal/themeData.js', src.replace(m[1], JSON.stringify(JSON.stringify(data))));
    }
    await writeModuleNav(app);
    await app.writeTemp('home-stats.js', `export default ${JSON.stringify(computeHomeStats(docsRoot))};\n`);
}

// 站内链接补全：Markdown 中写成 [x](/java/1_advanced) 或 [x](./2_version) 的链接（无 .md / .html 后缀、不以 / 结尾）
// VuePress 不会识别为站内路由，渲染成不带 base（/java-doc/）的普通 <a>，点击 404。这里在渲染前补上 .md，交给内置 linksPlugin 处理
const INTERNAL_NO_EXT = /^(\.{1,2}\/|\/)(?!\/)([^#?]*?)([#?].*)?$/;
const linkSuffixPlugin = {
    name: 'link-suffix',
    extendsMarkdown: (md) => {
        const original = md.renderer.rules.link_open;
        md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
            const href = tokens[idx].attrGet('href');
            const m = href?.match(INTERNAL_NO_EXT);
            if (m && m[2] && !m[2].endsWith('/') && !/\.[a-z0-9]+$/i.test(m[2])) {
                tokens[idx].attrSet('href', `${m[1]}${m[2]}.md${m[3] ?? ''}`);
            }
            return original ? original(tokens, idx, opts, env, self) : self.renderToken(tokens, idx, opts);
        };
    },
};

const moduleNavPlugin = {
    name: 'module-nav',
    onPrepared: (app) => writeModuleNav(app),
    // 开发模式（全部热更新，无需重启）：
    //   - Markdown 内容变更：页面数据已更新，重新生成导航表数据
    //   - 新增 / 删除 Markdown：重算侧边栏写回主题数据，并刷新导航表与首页统计
    onWatched: (app, watchers) => {
        let timer = null;
        const schedule = (fn) => {
            clearTimeout(timer);
            timer = setTimeout(fn, 400);
        };
        const pageWatchers = watchers.filter(w => typeof w?.on === 'function');
        pageWatchers.forEach(w => w.on('change', () => schedule(() => writeModuleNav(app))));
        pageWatchers.forEach(w => ['add', 'unlink'].forEach(ev => w.on(ev, (file) => {
            if (String(file).endsWith('.md')) schedule(() => refreshStructure(app));
        })));
    },
};

// 面包屑名称：目录没有 README 时主题自动生成目录页，这里给出中文标题（模块名 + subdirs）
const DIR_TITLES = Object.fromEntries(ALL_MODULES.flatMap(m => [
    [`/${m.dir}/`, m.name],
    ...Object.entries(m.subdirs ?? {}).map(([sub, conf]) => [`/${m.dir}/${sub}/`, subdirConf(conf).title]),
]));

export default defineUserConfig({
    head: [
        ['link', {rel: 'icon', href: 'images/logo.png'}]
    ],
    base: '/java-doc/',
    lang: 'zh-CN',
    port: 1000,
    title: 'Java Doc',
    description: '实践是检验真理的唯一标准',
    // 首页知识星图的数字（文章数 / 题数 / 答案页 / SVG）在构建时统计
    plugins: [homeStatsPlugin(docsRoot), moduleNavPlugin, linkSuffixPlugin],
    // 处理vite 打包警告
    bundler: viteBundler({
        viteOptions: {
            build: {
                rollupOptions: {
                    onwarn(warning, warn) {
                        if (warning.code === 'INVALID_ANNOTATION') return;
                        if (warning.code === 'PLUGIN_TIMINGS') return;
                        warn(warning);
                    },
                },
            },
        },
    }),
    theme: hopeTheme({
        logo: '/images/logo.png',
        navbar: NAVBAR_STYLE === 'dropdown' ? navbarDropdown : navbarFlat,
        sidebar: SIDEBAR,
        markdown: {
            hint: true,
            alert: true,
        },
        plugins: {
            // 保留主题默认的 frontmatter，再补上中文目录标题
            catalog: {
                frontmatter: (pagePath) => ({
                    article: false,
                    feed: false,
                    sitemap: false,
                    ...(DIR_TITLES[pagePath] ? {title: DIR_TITLES[pagePath]} : {}),
                }),
            },
            copyCode: {
                showInMobile: true,
            },
            slimsearch: {
                locales: {
                    '/': {placeholder: '搜索'},
                },
                isSearchable: (page) => page.path !== '/',
            },
        },
    }),
});
