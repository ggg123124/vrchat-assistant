#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""生成正方形 emoji 图：白底 + 居中「审核PR」粗体大字（VRChat 自定义 boop emoji）。"""
from PIL import Image, ImageDraw, ImageFont

SIZE = 1024
FONT_PATH = r"C:\Windows\Fonts\msyhbd.ttc"

img = Image.new("RGB", (SIZE, SIZE), (255, 255, 255))
draw = ImageDraw.Draw(img)

text = "审核PR"
# 用大字号居中绘制
font_size = 260
font = ImageFont.truetype(FONT_PATH, font_size)
bbox = draw.textbbox((0, 0), text, font=font)
tw = bbox[2] - bbox[0]
th = bbox[3] - bbox[1]
x = (SIZE - tw) / 2 - bbox[0]
y = (SIZE - th) / 2 - bbox[1]

# 文字黑色，加一点边框/阴影提升可读性
# 阴影
draw.text((x + 6, y + 6), text, font=font, fill=(160, 160, 160))
# 主体
draw.text((x, y), text, font=font, fill=(30, 30, 30))

out = r"D:\workspace\vrcx-mcp-actions\tmp\emoji_pr_review.png"
import os
os.makedirs(os.path.dirname(out), exist_ok=True)
img.save(out, "PNG")
print("saved:", out)
print("size:", img.size)
