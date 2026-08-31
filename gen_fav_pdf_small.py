#!/usr/bin/env python3
"""压缩版 PDF：下载图片→缩小→base64 内嵌→Chrome 打印"""
import markdown, re, os, sys, io, base64, urllib.request

SRC = '收藏世界分类表_中文.md'
OUT_HTML = '收藏世界分类表_zh_small.html'
OUT_PDF = '收藏世界分类表_中文.pdf'

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

def download_img(url):
    """下载图片并压缩到宽度 240px"""
    try:
        req = urllib.request.Request(url, headers={'User-Agent': UA})
        with urllib.request.urlopen(req, timeout=20) as r:
            data = r.read()
        # 用 PIL 压缩（若可用），否则原样 base64
        try:
            from PIL import Image
            img = Image.open(io.BytesIO(data))
            img.thumbnail((240, 180), Image.LANCZOS)
            buf = io.BytesIO()
            img.convert('RGB').save(buf, 'JPEG', quality=60)
            return base64.b64encode(buf.getvalue()).decode(), 'jpeg'
        except ImportError:
            return base64.b64encode(data).decode(), 'png'
    except Exception:
        return None, None

with open(SRC, encoding='utf-8') as f:
    md_text = f.read()

# 提取所有图片 URL，下载+压缩
img_urls = re.findall(r'!\[图\]\((https?://[^)]+)\)', md_text)
print(f'共 {len(img_urls)} 张图片，开始下载压缩...')
img_cache = {}
for i, url in enumerate(img_urls):
    b64, ext = download_img(url)
    img_cache[url] = (b64, ext)
    if (i + 1) % 50 == 0:
        print(f'  {i+1}/{len(img_urls)}...')

# 替换 md 里的图片为 base64 data URI（保留文件名供 alt 显示）
def replace_img(m):
    url = m.group(1)
    b64, ext = img_cache.get(url, (None, None))
    if b64:
        return f'![图](data:image/{ext};base64,{b64})'
    return '![图](图片不可用)'

md_new = re.sub(r'!\[图\]\((https?://[^)]+)\)', replace_img, md_text)
body = markdown.markdown(md_new, extensions=['tables'])

html_doc = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>我的 VRChat 收藏世界分类（压缩版）</title>
<style>
  @page {{ size: A4 landscape; margin: 10mm; }}
  body {{ font-family: "Microsoft YaHei", sans-serif; font-size: 8pt; color: #222; }}
  h1 {{ font-size: 16pt; border-bottom: 2px solid #333; }}
  h2 {{ font-size: 12pt; background: #f0f0f0; padding: 4px 8px; border-left: 4px solid #4a90d9; margin-top: 16px; }}
  table {{ border-collapse: collapse; width: 100%; }}
  th {{ background: #4a90d9; color: #fff; padding: 3px 5px; text-align: left; font-size: 7.5pt; }}
  td {{ border: 1px solid #ccc; padding: 2px 5px; }}
  tr:nth-child(even) td {{ background: #f8f9fa; }}
  img {{ height: 34px; width: 45px; object-fit: cover; }}
  tr {{ page-break-inside: avoid; }}
</style>
</head>
<body>
{body}
</body>
</html>"""

with open(OUT_HTML, 'w', encoding='utf-8') as f:
    f.write(html_doc)
print(f'✅ 压缩 HTML: {OUT_HTML} ({os.path.getsize(OUT_HTML)/1024:.0f}KB)')
