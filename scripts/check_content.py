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


LINK = re.compile(r'(?<!!)\[([^\]]+)\]\(([^)\s#]+)(#[^)\s]*)?\)')


def norm(s):
    return re.sub(r'[\s（）()「」：:、，,]', '', s).lower()


def link_text_ok(text, h1, target, headings):
    """链接文字能看出是同一篇：标题本身或其一部分、「模块 · 标题」「标题 · 小节」、目标页某个小节名、
    指向题单写「X 面试题」、指向总览写模块名；上一篇 / 下一篇与代码文字不比较"""
    if text in ('上一篇', '下一篇') or text.startswith('`'):
        return True
    nh = norm(h1)
    for nt in (norm(p) for p in text.split(' · ')):
        if nt == nh or nt in nh or nh in nt:
            return True
        if nt and any(nt in norm(h) for h in headings):
            return True
    nt = norm(text)
    if target.endswith('99_interview') and nt.endswith('面试题'):
        return True
    if target.endswith('0_overview'):
        base = nh[:-2] if nh.endswith('总览') else nh
        if nt in (base, base + '模块', base + '模块总览', '模块总览') or nt.startswith(base):
            return True
    return False


def check_link_texts(texts, titles):
    """站内链接（不带锚点）的文字要能看出指向哪篇：文章改名后漏改的旧标题会在这里报出"""
    headings = {k[:-3]: re.findall(r'^#{2,4} (.+)$', v, re.M) for k, v in texts.items()}
    issues = []
    for path, text in texts.items():
        for i, line in enumerate(text.split('\n'), 1):
            for m in LINK.finditer(line):
                label, target, anchor = m.group(1).strip(), m.group(2), m.group(3)
                if anchor or re.match(r'https?:|mailto:', target) or 'assets/' in target:
                    continue
                t = target.lstrip('/') if target.startswith('/') else os.path.normpath(
                    os.path.join(os.path.dirname(path), target)).replace(os.sep, '/')
                t = re.sub(r'\.(md|html)$', '', t)
                if t.endswith('/'):
                    t += '0_overview'
                if titles.get(t) and not link_text_ok(label, titles[t], t, headings.get(t, [])):
                    issues.append(f'{path}:{i}: 链接文字「{label}」与目标标题「{titles[t]}」对不上，可能是改名后的旧标题')
    return issues


def check_redirects(texts, site):
    """site.js 的 REDIRECTS：旧地址不能再是现有文章（否则跳转覆盖文章），新地址必须存在"""
    block = site.split('export const REDIRECTS', 1)[1].split('\n};', 1)[0] if 'export const REDIRECTS' in site else ''
    issues = []
    for old, new in re.findall(r"'(/[^']+)': '(/[^']+)'", block):
        if f'{old.lstrip("/")}.md' in texts:
            issues.append(f'site.js: REDIRECTS 的旧地址 {old} 仍是现有文章')
        if f'{new.lstrip("/")}.md' not in texts:
            issues.append(f'site.js: REDIRECTS 的新地址 {new} 不存在')
    return issues


VERSION = r'v?(\d+(?:\.\w+)*(?:\s*/\s*\d+(?:\.\w+)*)*)'


def baseline_registry(site):
    """读取 site.js 的 BASELINE：{产品: 允许的版本集合}，以及 [(路径前缀, 产品, 版本)] 例外"""
    block = site.split('export const BASELINE', 1)[1].split('\n};', 1)[0] if 'export const BASELINE' in site else ''
    body, _, exc = block.partition('exceptions:')
    versions = {n: {x.strip() for x in v.split('/')} for n, v in re.findall(r"name: '([^']+)', ver: '([^']+)'", body)}
    exceptions = re.findall(r"path: '([^']+)', name: '([^']+)', ver: '([^']+)'", exc)
    return versions, exceptions


def baseline_segments(text):
    """版本基线写在哪：总览页的「版本基线」行、引言的「基线为」句，只看基线列表本身（到第一个「，；。」为止），括号里的补充说明不算"""
    for i, line in enumerate(text.split('\n'), 1):
        # 先去掉括号再截断，否则括号里的「，」会把括号截成半个
        if line.startswith('**版本基线'):
            seg = re.split(r'[。；]', re.sub(r'（[^）]*）', '', line), maxsplit=1)[0]
        elif '基线为' in line:
            seg = re.split(r'[，。；]', re.sub(r'（[^）]*）', '', line.split('基线为', 1)[1]), maxsplit=1)[0]
        else:
            continue
        yield i, seg


def baseline_mentions(seg, name):
    """在一段文字里找「产品 版本」；前后紧挨别的单词时（如 Redisson、Spring Data Redis）不算"""
    pattern = r'(?<![A-Za-z.\-])(?<!Data )' + re.escape(name) + r'(?![A-Za-z])\s*' + VERSION
    for m in re.finditer(pattern, seg):
        yield m.group(1)


def check_baseline(texts, site):
    versions, exceptions = baseline_registry(site)
    issues = []
    for path, text in texts.items():
        for line_no, seg in baseline_segments(text):
            for name, allowed in versions.items():
                ok = allowed | {v for p, n, v in exceptions if n == name and path.startswith(p)}
                for ver in baseline_mentions(seg, name):
                    parts = [x.strip() for x in ver.split('/')]
                    if any(x not in ok for x in parts):
                        expect = ' / '.join(sorted(allowed))
                        issues.append(f'{path}:{line_no}: 版本基线「{name} {ver}」与 site.js 的 BASELINE（{expect}）不一致')
    return issues


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

    # 版本基线：总览页「版本基线」行与引言「基线为」句中的版本须与 site.js 的 BASELINE 一致
    issues.extend(check_baseline(texts, site))

    # 改名、搬家后引用要同步：链接文字对得上目标标题，跳转表指向现有文章
    issues.extend(check_link_texts(texts, {k: v for k, v in titles.items() if v}))
    issues.extend(check_redirects(texts, site))

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
