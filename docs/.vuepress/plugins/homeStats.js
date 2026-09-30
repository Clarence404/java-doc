import fs from 'node:fs';
import path from 'node:path';

// 首页数字的统计规则：
//   文章数 = 模块目录下（含子目录）的 .md，去掉 README、0_overview 总览页和 99_interview 题单
//   题数   = 99_interview.md 中以「- **」开头的题目行
//   答案页 = docs/interview/ 下除 0_ 总览外的 .md
//   图解   = docs/assets/ 下的 .svg
const SKIP_DIRS = new Set(['.vuepress', 'assets', 'interview', 'public']);
const QUESTION_LINE = /^\s*[-*] \*\*/;

function listFiles(dir, ext) {
    const out = [];
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...listFiles(full, ext));
        else if (entry.name.endsWith(ext)) out.push(full);
    }
    return out;
}

function isArticle(file) {
    const name = path.basename(file);
    return name !== 'README.md' && name !== '99_interview.md' && !name.startsWith('0_overview');
}

export function computeHomeStats(docsDir) {
    const modules = {};
    for (const entry of fs.readdirSync(docsDir, {withFileTypes: true})) {
        if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        const dir = path.join(docsDir, entry.name);
        const articles = listFiles(dir, '.md').filter(isArticle).length;
        const qFile = path.join(dir, '99_interview.md');
        const questions = fs.existsSync(qFile)
            ? fs.readFileSync(qFile, 'utf-8').split('\n').filter((l) => QUESTION_LINE.test(l)).length
            : 0;
        modules[entry.name] = {articles, questions};
    }
    const answerPages = fs.readdirSync(path.join(docsDir, 'interview'))
        .filter((f) => f.endsWith('.md') && !f.startsWith('0_')).length;
    const svgs = listFiles(path.join(docsDir, 'assets'), '.svg').length;
    return {modules, answerPages, svgs};
}

// 构建时统计并写入 @temp/home-stats.js，首页组件从这里读取数字
export const homeStatsPlugin = (docsDir) => ({
    name: 'home-stats',
    onPrepared: async (app) => {
        const stats = computeHomeStats(docsDir);
        await app.writeTemp('home-stats.js', `export default ${JSON.stringify(stats)};\n`);
    },
});
