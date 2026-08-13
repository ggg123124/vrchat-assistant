#!/usr/bin/env python3
"""生成近3天新图收藏比 Top20 排行报告（含内嵌图片 + 简洁说明）"""
import json, urllib.request, base64, re, sys

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

def mcp_call(tool, args=None):
    if args is None: args = {}
    body = json.dumps({'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':tool,'arguments':args}}).encode()
    req = urllib.request.Request('http://127.0.0.1:8799/mcp', data=body, headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req, timeout=60) as r:
        raw = r.read().decode()
    for line in raw.splitlines():
        if line.startswith('data:'):
            d = json.loads(line[5:].strip())
            for c in d.get('result',{}).get('content',[]):
                if c.get('type')=='text':
                    return json.loads(c['text'])
    return None

def fetch_img(url):
    """下载图片转 base64（失败返回 None）"""
    try:
        req = urllib.request.Request(url, headers={'User-Agent': UA})
        with urllib.request.urlopen(req, timeout=15) as r:
            return base64.b64encode(r.read()).decode()
    except Exception:
        return None

d = mcp_call('site_worlds', {'days':3, 'sortBy':'favorites_ratio', 'limit':20})
worlds = d['worlds']

print(f'# 🗺️ 近3天新图收藏比 Top{len(worlds)} 排行（来源: PlanetVRC）\n')
print(f'**数据窗口**: 3天 | **排序**: 收藏/浏览比 | **重点标准**: ≥20%\n')

for i, w in enumerate(worlds, 1):
    star = '⭐' if w['favoriteRatio'] >= 0.2 else ''
    ratio = w['favoriteRatio']*100
    name = re.sub(r'[｜|].*$', '', w['worldName']).strip() or w['worldName']
    # 简洁说明：去换行截断
    desc = re.sub(r'[\\/]{2,}', ' ', w.get('description') or '')
    desc = desc[:80] + ('…' if len(desc) > 80 else '')
    img = w.get('imageUrl') or ''
    print(f'## {i}. {star} {name}')
    print(f'- **作者**: {w["authorName"] or "未知"} | **收藏**: {w["favorites"]:,} | **浏览**: {w["visits"]:,} | **收藏比**: **{ratio:.1f}%**')
    print(f'- **简介**: {desc}')
    if img:
        print(f'- **图片**: {img}')
    print()
