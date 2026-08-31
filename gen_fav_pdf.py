#!/usr/bin/env python3
"""Markdown 收藏表格 → 带样式的 HTML（供 Chrome headless 打印 PDF）"""
import markdown, html as html_mod, sys, os

SRC = '收藏世界分类表.md'
OUT = '收藏世界分类表.html'

with open(SRC, encoding='utf-8') as f:
    md_text = f.read()

# 把图片链接转成可点击的链接文本（图片 URL 是 VRChat API，渲染时浏览器会自动拉取；为稳妥同时保留 URL）
# markdown 转 HTML
body = markdown.markdown(md_text, extensions=['tables'])

# 包装样式：中文字体、表格边框、分页
html_doc = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>我的 VRChat 收藏世界分类</title>
<style>
  @page {{ size: A4 landscape; margin: 12mm; }}
  body {{ font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif; font-size: 9pt; color: #222; }}
  h1 {{ font-size: 18pt; border-bottom: 2px solid #333; padding-bottom: 6px; }}
  h2 {{ font-size: 14pt; background: #f0f0f0; padding: 5px 10px; border-left: 4px solid #4a90d9; margin-top: 24px; page-break-after: avoid; }}
  table {{ border-collapse: collapse; width: 100%; margin: 8px 0; }}
  th {{ background: #4a90d9; color: #fff; padding: 4px 6px; text-align: left; font-size: 8.5pt; }}
  td {{ border: 1px solid #ccc; padding: 3px 6px; vertical-align: middle; }}
  tr:nth-child(even) td {{ background: #f8f9fa; }}
  img {{ max-height: 40px; max-width: 60px; }}
  tr {{ page-break-inside: avoid; }}
</style>
</head>
<body>
{body}
</body>
</html>"""

with open(OUT, 'w', encoding='utf-8') as f:
    f.write(html_doc)
print(f'✅ HTML 生成: {OUT} ({os.path.getsize(OUT)}B)')
