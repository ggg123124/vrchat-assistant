#!/usr/bin/env python3
"""从 fav_worlds_raw.json 生成中文简介的 Markdown 表格"""
import json, re

with open('fav_worlds_raw.json', encoding='utf-8') as f:
    worlds = json.load(f)

# 分类（与 handler 相同规则）
CATEGORY_RULES = [
    (re.compile(r'avatar|アバター|model|展示|改模|店', re.I), 'Avatar/模型'),
    (re.compile(r'horror|怖|ホラー|backroom', re.I), '恐怖'),
    (re.compile(r'game|ゲーム|fps|racing|race|puzzle|謎解き|udon', re.I), '游戏'),
    (re.compile(r'music|音楽|dj|ライブ|concert|dance|舞', re.I), '音乐/演出'),
    (re.compile(r'social|hangout|集合|club|バー|居酒屋|cafe|カフェ', re.I), '社交/聚会'),
    (re.compile(r'photo|写真|撮影|カメラ', re.I), '拍照'),
    (re.compile(r'vrcsleep|睡眠|寝る|sleep|chill|チル|relax', re.I), '休闲/睡觉'),
    (re.compile(r'景観|景色|scenic|view|観光|landscape', re.I), '风景/观光'),
]

def classify(w):
    name = (w.get('worldName','') or '') + ' ' + (w.get('description','') or '')[:200]
    tags = ' '.join(w.get('tags', []) or [])
    hay = name + ' ' + tags
    for re_, cat in CATEGORY_RULES:
        if re_.search(hay): return cat
    return '其他'

for w in worlds:
    w['category'] = classify(w)

# 中文简介：优先 description_zh，回退 description
for w in worlds:
    zh = w.get('description_zh') or ''
    if zh and zh != '(无简介)':
        w['desc_final'] = zh[:80]
    else:
        # 无翻译时用原文前 60 字
        orig = (w.get('description','') or '').replace('\n',' ').replace('|','｜')[:60]
        w['desc_final'] = orig or '(无简介)'

# 按分类分组排序（组内按收藏数降序）
cats = {}
order = []
for w in worlds:
    c = w['category']
    if c not in cats:
        cats[c] = []
        order.append(c)
    cats[c].append(w)

for c in order:
    cats[c].sort(key=lambda x: x.get('favorites', 0), reverse=True)

print(f"# 🗂️ 我的 VRChat 收藏世界分类（共 {len(worlds)} 个 · 中文简介）\n")

for cat in order:
    lst = cats[cat]
    print(f"## {cat}（{len(lst)} 个）\n")
    print("| # | 世界 | 作者 | 收藏 | 简介（中文） | 图片 |")
    print("|---|------|------|-----:|------|------|")
    for i, w in enumerate(lst, 1):
        name = (w.get('worldName','') or '')[:40]
        author = (w.get('authorName','') or '')[:15]
        fav = f"{w.get('favorites',0):,}"
        desc = w['desc_final']
        img = w.get('imageUrl') or ''
        if img:
            print(f"| {i} | {name} | {author} | {fav} | {desc} | ![图]({img}) |")
        else:
            print(f"| {i} | {name} | {author} | {fav} | {desc} | (无) |")
    print()
