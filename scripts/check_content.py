"""文章规范检查：只收录不会误报的规则（规则来源见 CLAUDE.md「文档约定」）。

用法：python scripts/check_content.py；有问题时退出码为 1。
"""
import os
import re
import sys

sys.stdout.reconfigure(encoding='utf-8')
DOCS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'docs')
# 作者自管的文章，不参与检查
SKIP = {'cloud-native/17_vps_intro.md'}
H1 = re.compile(r'^# (.+)$', re.M)


def rel(path):
    return os.path.relpath(path, DOCS).replace(os.sep, '/')


def articles():
    """docs 下全部 Markdown（不含 .vuepress 与首页）。"""
    for root, dirs, files in os.walk(DOCS):
        dirs[:] = [d for d in dirs if d not in ('.vuepress', 'node_modules', 'public', 'assets')]
        for f in files:
            if f.endswith('.md') and rel(os.path.join(root, f)) != 'README.md':
                yield os.path.join(root, f)


def main():
    issues = []
    texts = {rel(p): open(p, encoding='utf-8').read() for p in articles()}
    titles = {k[:-3]: (H1.search(v).group(1).strip() if H1.search(v) else None) for k, v in texts.items()}

    for path, text in texts.items():
        if path in SKIP:
            continue
        name = os.path.basename(path)
        is_interview = path.startswith('interview/')
        is_article = re.match(r'\d+_', name) and not name.startswith(('0_overview', '99_')) and not is_interview

        def report(msg):
            issues.append(f'{path}: {msg}')

        if not titles[path[:-3]]:
            report('缺少 H1')
        if re.search(r'^> \[!\w+\][ \t]*\S', text, re.M):
            report('提示框标题写在 > [!type] 同一行，不会渲染，改用 ::: type 标题')
        if '本篇目标' in text.split('\n## ', 1)[0]:
            report('开头不写「本篇目标」')
        if is_article or (is_interview and name != '0_overview.md'):
            front = text.split('---', 2)[1] if text.startswith('---') else ''
            if 'description:' not in front:
                report('frontmatter 缺少 description')
        if is_article:
            if '## 参考资料' not in text:
                report('缺少文末「## 参考资料」')
            elif '## 小结' in text and text.index('## 参考资料') < text.index('## 小结'):
                report('「## 参考资料」应放在「## 小结」之后')
        # 答案页：interview/ 下除 0_ 总览与 90 号以后附录（如术语表）外的页面
        if is_interview and name != '0_overview.md' and not re.match(r'9\d_', name):
            if not (titles[path[:-3]] or '').endswith('面试题解答'):
                report('答案页 H1 应为「X 面试题解答」')
            if not re.search(r'^### Q\d+：', text, re.M):
                report('答案页题目应写成「### Q<n>：」')
        # 「下一篇」链接文字必须等于目标页 H1
        for m in re.finditer(r'^> 下一篇：\[([^\]]+)\]\(([^)#]+)', text, re.M):
            target = os.path.normpath(os.path.join(os.path.dirname(path), m.group(2))).replace(os.sep, '/')
            target = re.sub(r'\.(md|html)$', '', target)
            if titles.get(target) and titles[target] != m.group(1):
                report(f'下一篇链接文字「{m.group(1)}」与目标标题「{titles[target]}」不一致')

    # 有答案页的模块必须有题单，题单引用的答案页与 site.js 一致
    site = open(os.path.join(DOCS, '.vuepress', 'site.js'), encoding='utf-8').read()
    for d, iv in re.findall(r"dir: '([^']+)', interview: \[([^\]]*)\]", site):
        pages = set(re.findall(r"'([^']+)'", iv))
        q = texts.get(f'{d}/99_interview.md')
        if q is None:
            issues.append(f'{d}: site.js 登记了答案页 {sorted(pages)}，但缺少 99_interview.md')
            continue
        used = set(re.findall(r'<InterviewList page="([^"]+)"', q))
        if used != pages:
            issues.append(f'{d}/99_interview.md: 引用 {sorted(used)}，site.js 登记 {sorted(pages)}')
        for p in pages:
            if f'interview/{p}.md' not in texts:
                issues.append(f'site.js: 答案页 interview/{p}.md 不存在')

    # 学习路线（site.js 的 ROUTES）引用的文章必须存在
    routes = site.split('export const ROUTES', 1)[1].split('\nexport ', 1)[0] if 'export const ROUTES' in site else ''
    for items in re.findall(r"items: \[([^\]]*)\]", routes):
        for p in re.findall(r"'([^']+)'", items):
            if f'{p}.md' not in texts:
                issues.append(f'site.js: 学习路线引用的文章 {p}.md 不存在')

    # 图片必须被引用
    alltext = '\n'.join(texts.values()) + site
    for root, _, files in os.walk(os.path.join(DOCS, 'assets')):
        for f in files:
            if f not in alltext:
                issues.append(f'{rel(os.path.join(root, f))}: 图片未被任何文章引用')

    print(f'检查 {len(texts)} 个 Markdown 文件，发现 {len(issues)} 个问题')
    for x in issues:
        print('  ', x)
    return 1 if issues else 0


if __name__ == '__main__':
    sys.exit(main())
