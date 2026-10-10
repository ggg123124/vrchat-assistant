#!/usr/bin/env python3
"""
prepare_image.py — 将任意图片处理为 VRChat 上传要求的目标比例

用法:
  python prepare_image.py --input <图片路径> --output <输出路径> [--mode square|landscape] [--ratio 16:9|4:3] [--size 1920] [--background white|transparent]

模式说明:
  square    正方形（VRChat emoji 用，maskTag: square）
            - fit:    中心裁剪成正方形后缩放（主体居中时最佳）
            - pad:    四周补透明边成正方形（不裁剪任何内容）
            - smart:  按视觉模型给的边界框 --crop-box 裁剪（主体偏移明显时）
  landscape 横版填充（VRChat Prints 16:9 / Gallery 4:3 用，不强制方形）
            - 判断图片方向：竖图(高>宽)自动转横向，横图保持
            - 内容完整保留（不裁剪），按 --ratio 目标比例创建画布，图片 contain 缩放居中
            - 背景色 --background（默认白色，Prints/Gallery 都是浅色底，白边最合适）
            - 若图片已符合目标比例且方向正确，仅缩放到 --size 宽度

输出: PNG（square 模式带透明通道；landscape 模式按背景色）

例子:
  # emoji: 方形化
  python prepare_image.py --input a.png --output e.png --mode square --mode-detail fit --size 1024
  # Prints 照片: 16:9 横版白底
  python prepare_image.py --input a.png --output p.png --mode landscape --ratio 16:9 --size 1920
  # Gallery 图片: 4:3 横版白底
  python prepare_image.py --input a.png --output g.png --mode landscape --ratio 4:3 --size 1600
"""
import argparse
import os
import sys
from PIL import Image, ImageOps

def make_square(img, mode, crop_box=None, size=1024):
    """Return a square image."""
    w, h = img.size
    if mode == "pad":
        side = max(w, h)
        canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        offset = ((side - w) // 2, (side - h) // 2)
        canvas.paste(img.convert("RGBA"), offset)
        square = canvas
    elif mode == "smart":
        if not crop_box:
            raise ValueError("smart 模式需要 --crop-box 'x1,y1,x2,y2'")
        x1, y1, x2, y2 = [float(v) for v in crop_box.split(",")]
        if x1 <= 1 and y1 <= 1 and x2 <= 1 and y2 <= 1:
            x1, y1, x2, y2 = x1 * w, y1 * h, x2 * w, y2 * h
        x1, y1 = max(0, int(x1)), max(0, int(y1))
        x2, y2 = min(w, int(x2)), min(h, int(y2))
        if x2 - x1 <= 0 or y2 - y1 <= 0:
            raise ValueError(f"非法裁剪框: {crop_box}")
        bw, bh = x2 - x1, y2 - y1
        cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
        half = max(bw, bh) / 2
        left, top = max(0, int(cx - half)), max(0, int(cy - half))
        right, bottom = min(w, int(cx + half)), min(h, int(cy + half))
        if right - left != bottom - top:
            side = max(right - left, bottom - top)
            canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
            canvas.paste(img.convert("RGBA").crop((left, top, right, bottom)), (0, 0))
            square = canvas
        else:
            square = img.convert("RGBA").crop((left, top, right, bottom))
    else:  # fit
        square = ImageOps.fit(img.convert("RGBA"), (size, size), Image.LANCZOS)
    if square.size != (size, size):
        square = square.resize((size, size), Image.LANCZOS)
    return square

def make_landscape(img, ratio_w, ratio_h, target_w=1920, background="white", strategy="auto"):
    """Return a landscape image at target ratio.

    - 竖图(高>宽)先旋转 90° 变成横图（内容跟着转）
    - strategy:
      - crop:   按目标比例裁剪原图（保留原始分辨率，无白边）
      - fill:   按目标比例 contain 缩放居中，四周背景色填充
      - auto:   比较两种方案"浪费面积"：裁剪损失(被裁掉的内容面积) vs 填充白边(画布-内容面积)，损失小的优先
    """
    w, h = img.size
    rotated = False
    if h > w:
        img = img.rotate(90, expand=True)
        rotated = True
        w, h = img.size

    # 目标比例
    target_ratio = ratio_w / ratio_h
    cur_ratio = w / h

    # ---- 方案1: 裁剪（保持原分辨率，裁出目标比例矩形）----
    if cur_ratio >= target_ratio:
        # 原图更宽：裁左右，高度全保留
        crop_w = round(h * target_ratio)
        crop_box = ((w - crop_w) // 2, 0, (w - crop_w) // 2 + crop_w, h)
    else:
        # 原图更高：裁上下，宽度全保留
        crop_h = round(w / target_ratio)
        crop_box = (0, (h - crop_h) // 2, w, (h - crop_h) // 2 + crop_h)
    cropped = img.crop(crop_box)
    crop_loss = w * h - cropped.size[0] * cropped.size[1]  # 被裁掉的内容面积

    # ---- 方案2: 填充（contain 缩放 + 背景色）----
    target_h = round(target_w * ratio_h / ratio_w)
    canvas = Image.new("RGB", (target_w, target_h), (255, 255, 255) if background == "white" else (0, 0, 0, 0))
    if background != "white":
        canvas = Image.new("RGBA", (target_w, target_h), (0, 0, 0, 0))
        paste_img = img.convert("RGBA")
    else:
        paste_img = img.convert("RGB")
    scale = min(target_w / w, target_h / h)
    nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
    resized = paste_img.resize((nw, nh), Image.LANCZOS)
    canvas.paste(resized, ((target_w - nw) // 2, (target_h - nh) // 2))
    fill_waste = target_w * target_h - nw * nh  # 白边面积

    # ---- 选择策略 ----
    if strategy == "crop":
        chosen, note = "crop", f"明确指定裁剪（损失 {crop_loss:,} px）"
    elif strategy == "fill":
        chosen, note = "fill", f"明确指定填充（白边 {fill_waste:,} px）"
    else:  # auto
        if crop_loss <= fill_waste:
            chosen, note = "crop", f"auto: 裁剪损失 {crop_loss:,} <= 填充白边 {fill_waste:,}，裁剪更省"
        else:
            chosen, note = "fill", f"auto: 填充白边 {fill_waste:,} < 裁剪损失 {crop_loss:,}，填充更省"

    if chosen == "crop":
        # 裁剪结果缩放到目标宽度
        cw, ch = cropped.size
        cscale = target_w / cw
        result = cropped.convert("RGB" if background == "white" else "RGBA").resize(
            (target_w, round(ch * cscale)), Image.LANCZOS)
    else:
        result = canvas

    return result, rotated, note

def main():
    ap = argparse.ArgumentParser(description="处理图片为 VRChat 上传要求的目标比例")
    ap.add_argument("--input", required=True, help="输入图片路径")
    ap.add_argument("--output", required=True, help="输出 PNG 路径")
    ap.add_argument("--mode", choices=["square", "landscape"], required=True)
    ap.add_argument("--mode-detail", choices=["fit", "pad", "smart"], default="fit", help="square 模式的子模式")
    ap.add_argument("--crop-box", help="smart 模式: 主体边界框 'x1,y1,x2,y2'（像素或 0~1 归一化）")
    ap.add_argument("--ratio", default="16:9", help="landscape 模式目标比例，如 16:9 / 4:3")
    ap.add_argument("--size", type=int, default=0, help="目标宽度（square 默认1024，landscape 默认1920）")
    ap.add_argument("--background", choices=["white", "transparent"], default="white", help="landscape 填充背景")
    ap.add_argument("--strategy", choices=["auto", "crop", "fill"], default="auto", help="landscape 模式策略：auto 自动选损失小的 / crop 强制裁剪 / fill 强制填充")
    args = ap.parse_args()

    if not os.path.exists(args.input):
        print(f"错误: 输入文件不存在: {args.input}", file=sys.stderr)
        sys.exit(1)

    try:
        img = Image.open(args.input)
        img.load()
    except Exception as e:
        print(f"错误: 无法读取图片 {args.input}: {e}", file=sys.stderr)
        sys.exit(1)

    print(f"原始尺寸: {img.size} ({img.format}, {img.mode})")
    direction = "竖图(高>宽)" if img.size[1] > img.size[0] else "横图(宽>=高)"
    print(f"方向: {direction}")

    try:
        if args.mode == "square":
            size = args.size or 1024
            result = make_square(img, args.mode_detail, crop_box=args.crop_box, size=size)
            rotated = False
            note = {
                "fit": f"中心裁剪为 {size}×{size} 正方形（不补边）",
                "pad": f"四周补透明边为 {size}×{size} 正方形（不裁剪内容）",
                "smart": f"按 --crop-box 裁剪为 {size}×{size} 正方形",
            }.get(args.mode_detail, f"square/{args.mode_detail}: 输出 {size}×{size}")
        else:
            rw, rh = [int(x) for x in args.ratio.split(":")]
            target_w = args.size or 1920
            result, rotated, note = make_landscape(img, rw, rh, target_w=target_w, background=args.background, strategy=args.strategy)
    except ValueError as e:
        print(f"错误: {e}", file=sys.stderr)
        sys.exit(1)

    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    result.save(args.output, "PNG")
    detail = args.mode_detail if args.mode == 'square' else args.ratio
    rot_note = " (已旋转90°)" if rotated else ""
    print(f"✅ 已输出: {args.output} ({result.size}, 模式={args.mode}/{detail}{rot_note})")
    print(f"📊 决策: {note}")

if __name__ == "__main__":
    main()
