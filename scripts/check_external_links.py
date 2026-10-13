"""外链巡检：检查各文章「## 参考资料」里的外部链接是否失效。

只把明确失效的链接算作问题（404 / 410、域名无法解析、连接被拒）；
403 / 429 / 超时等多半是站点反爬或临时抖动，只列为「需人工确认」，不算失败。

用法：python scripts/check_external_links.py [--out report.md]；有失效链接时退出码为 1。
"""
import argparse
import concurrent.futures
import os
import re
import socket
import sys
import urllib.error
import urllib.request

sys.stdout.reconfigure(encoding='utf-8')
DOCS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'docs')
LINK = re.compile(r'\]\((https?://[^)\s]+)\)')
UA = 'Mozilla/5.0 (compatible; java-doc-linkcheck/1.0; +https://github.com/Clarence404/java-doc)'
BROKEN_STATUS = {404, 410}


def collect():
    """{url: [引用它的文件]}，只取「## 参考资料」小节里的链接。"""
    refs = {}
    for root, dirs, files in os.walk(DOCS):
        dirs[:] = [d for d in dirs if d not in ('.vuepress', 'node_modules', 'public', 'assets')]
        for f in files:
            if not f.endswith('.md'):
                continue
            path = os.path.join(root, f)
            text = open(path, encoding='utf-8').read()
            if '## 参考资料' not in text:
                continue
            section = text.split('## 参考资料', 1)[1].split('\n## ', 1)[0]
            for url in LINK.findall(section):
                refs.setdefault(url, []).append(os.path.relpath(path, DOCS).replace(os.sep, '/'))
    return refs


def probe(url):
    """返回 (类别, 说明)：ok / broken / unsure。"""
    for method in ('HEAD', 'GET'):
        req = urllib.request.Request(url, method=method, headers={'User-Agent': UA})
        try:
            with urllib.request.urlopen(req, timeout=20):
                return 'ok', ''
        except urllib.error.HTTPError as e:
            if method == 'HEAD':
                continue  # 不少站点对 HEAD 返回 403 / 404 / 405，统一改用 GET 再确认
            if e.code in BROKEN_STATUS:
                return 'broken', f'HTTP {e.code}'
            return 'unsure', f'HTTP {e.code}'
        except urllib.error.URLError as e:
            reason = e.reason
            if isinstance(reason, socket.gaierror):
                return 'broken', '域名无法解析'
            if isinstance(reason, ConnectionRefusedError):
                return 'broken', '连接被拒绝'
            return 'unsure', str(reason)[:80]
        except Exception as e:  # 超时、SSL 等
            return 'unsure', type(e).__name__
    return 'unsure', '无法确认'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', help='把报告写成 Markdown 文件（供 CI 建 Issue 用）')
    args = ap.parse_args()

    refs = collect()
    results = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
        for url, res in zip(refs, pool.map(probe, refs)):
            results[url] = res
    broken = [(u, r[1]) for u, r in results.items() if r[0] == 'broken']
    unsure = [(u, r[1]) for u, r in results.items() if r[0] == 'unsure']

    lines = [f'检查 {len(refs)} 个外链：失效 {len(broken)} 个，需人工确认 {len(unsure)} 个', '']
    if broken:
        lines += ['## 失效链接', '', '| 链接 | 原因 | 引用位置 |', '|---|---|---|']
        lines += [f'| {u} | {why} | {"<br>".join(refs[u])} |' for u, why in sorted(broken)]
        lines.append('')
    if unsure:
        lines += ['## 需人工确认（可能是反爬或临时故障）', '', '| 链接 | 原因 | 引用位置 |', '|---|---|---|']
        lines += [f'| {u} | {why} | {"<br>".join(refs[u])} |' for u, why in sorted(unsure)]
    report = '\n'.join(lines)
    print(report)
    if args.out:
        with open(args.out, 'w', encoding='utf-8') as f:
            f.write(report + '\n')
    return 1 if broken else 0


if __name__ == '__main__':
    sys.exit(main())
