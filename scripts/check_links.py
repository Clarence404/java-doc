"""站内链接检查：Markdown 链接 / RouteLink 的目标文件是否存在，#锚点是否存在于构建产物。

用法：先 npm run docs:build，再 python scripts/check_links.py；有问题时退出码为 1。
"""
import html
import os
import re
import sys
from urllib.parse import unquote

sys.stdout.reconfigure(encoding='utf-8')
DOCS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'docs')
DIST = os.path.join(DOCS, '.vuepress', 'dist')
LINK = re.compile(r'\]\(([^)\s]+)\)|RouteLink to="([^"]+)"')
_ids = {}


def ids_for(md):
    """构建产物中该页面的全部 id（锚点）。"""
    h = os.path.join(DIST, os.path.relpath(md, DOCS)[:-3] + '.html')
    if h not in _ids:
        s = open(h, encoding='utf-8').read() if os.path.exists(h) else ''
        _ids[h] = {html.unescape(unquote(x)) for x in re.findall(r'id="([^"]+)"', s)}
    return _ids[h]


def main():
    if not os.path.isdir(DIST):
        print('未找到构建产物，请先运行 npm run docs:build')
        return 1
    missing, bad = [], []
    for root, dirs, files in os.walk(DOCS):
        dirs[:] = [d for d in dirs if d not in ('.vuepress', 'node_modules', 'public')]
        for f in files:
            if not f.endswith('.md'):
                continue
            src = os.path.join(root, f)
            text = re.sub(r'```.*?```', '', open(src, encoding='utf-8').read(), flags=re.S)
            for m in LINK.finditer(text):
                link = m.group(1) or m.group(2)
                if re.match(r'^(https?:|mailto:|#)', link) or link.startswith('//'):
                    continue
                path, _, anchor = link.partition('#')
                if re.search(r'\.(svg|png|jpe?g|gif|webp)$', path, re.I):
                    tgt = os.path.join(DOCS, path.lstrip('/')) if path.startswith('/') else os.path.normpath(os.path.join(root, path))
                    if not os.path.exists(tgt):
                        missing.append((src, link))
                    continue
                base = os.path.join(DOCS, path.lstrip('/')) if path.startswith('/') else os.path.normpath(os.path.join(root, path))
                base = re.sub(r'\.(md|html)$', '', base)
                md = os.path.join(base, 'README.md') if base.endswith(os.sep) else base + '.md'
                if not os.path.exists(md):
                    missing.append((src, link))
                elif anchor and html.unescape(unquote(anchor)) not in ids_for(md):
                    bad.append((src, link))
    print('MISSING TARGET:', len(missing))
    for s, l in missing:
        print('  ', os.path.relpath(s, DOCS), l)
    print('BAD ANCHOR:', len(bad))
    for s, l in bad:
        print('  ', os.path.relpath(s, DOCS), l)
    return 1 if missing or bad else 0


if __name__ == '__main__':
    sys.exit(main())
