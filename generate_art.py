# generate_art.py
import os
import sys
import random
from datetime import datetime
from PIL import Image, ImageDraw, ImageFilter

# public/generated/ に保存して、そのまま Express の静的配信で出す
OUT_DIR = os.path.join("public", "generated")


def _clamp(x, a=0, b=255):
    return max(a, min(b, int(x)))


def _lerp(a, b, t):
    return a + (b - a) * t


def _lerp_color(c1, c2, t):
    return (
        _clamp(_lerp(c1[0], c2[0], t)),
        _clamp(_lerp(c1[1], c2[1], t)),
        _clamp(_lerp(c1[2], c2[2], t)),
    )


def _rand_palette():
    """
    風景っぽく見える配色（朝焼け/夕景/青空/霧/夜明け）をランダムに選ぶ
    """
    palettes = [
        # dawn
        {"sky_top": (70, 120, 200), "sky_bottom": (255, 190, 160), "mist": (235, 240, 255)},
        # sunset
        {"sky_top": (45, 70, 140), "sky_bottom": (255, 150, 90), "mist": (250, 230, 210)},
        # clear day
        {"sky_top": (50, 140, 220), "sky_bottom": (170, 220, 255), "mist": (240, 250, 255)},
        # fog
        {"sky_top": (160, 170, 180), "sky_bottom": (210, 215, 220), "mist": (235, 235, 240)},
        # night-ish
        {"sky_top": (15, 25, 60), "sky_bottom": (60, 80, 120), "mist": (200, 210, 230)},
    ]
    p = random.choice(palettes)

    # 山・地面・水の基調色
    mountain_base = random.choice([(40, 70, 90), (60, 80, 110), (80, 90, 100), (50, 60, 70)])
    land_base = random.choice([(30, 60, 50), (60, 70, 60), (80, 70, 50), (45, 55, 65)])
    water_base = random.choice([(30, 80, 110), (50, 100, 140), (25, 60, 90), (70, 120, 160)])

    p["mountain"] = mountain_base
    p["land"] = land_base
    p["water"] = water_base
    return p


def _vertical_gradient(img, top_color, bottom_color):
    w, h = img.size
    px = img.load()
    for y in range(h):
        t = y / max(1, (h - 1))
        c = _lerp_color(top_color, bottom_color, t)
        for x in range(w):
            px[x, y] = c


def _paint_strokes(base_img, stroke_count=2200, max_len=90):
    """
    半透明の“筆致”を大量に重ねて、抽象っぽいタッチに寄せる
    """
    w, h = base_img.size
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer, "RGBA")

    for _ in range(stroke_count):
        x = random.randint(0, w - 1)
        y = random.randint(0, h - 1)

        # 背景色を拾って近い色で塗る（風景の色相が崩れにくい）
        r, g, b = base_img.getpixel((x, y))
        jitter = random.randint(-25, 25)
        col = (_clamp(r + jitter), _clamp(g + jitter), _clamp(b + jitter), random.randint(18, 60))

        length = random.randint(8, max_len)
        thickness = random.randint(2, 8)
        ang = random.random() * 3.14159 * 2

        x2 = _clamp(x + int(length * (random.random() * 0.6 + 0.4) * (1 if random.random() < 0.5 else -1)), 0, w - 1)
        y2 = _clamp(y + int(length * (random.random() * 0.6 + 0.4) * (1 if random.random() < 0.5 else -1)), 0, h - 1)

        # ランダムにカーブっぽく（短い折れ線）
        if random.random() < 0.35:
            xm = _clamp((x + x2) // 2 + random.randint(-20, 20), 0, w - 1)
            ym = _clamp((y + y2) // 2 + random.randint(-20, 20), 0, h - 1)
            d.line([(x, y), (xm, ym), (x2, y2)], fill=col, width=thickness, joint="curve")
        else:
            d.line([(x, y), (x2, y2)], fill=col, width=thickness)

    layer = layer.filter(ImageFilter.GaussianBlur(radius=0.6))
    return Image.alpha_composite(base_img.convert("RGBA"), layer).convert("RGB")


def _draw_mountains(img, horizon_y, palette):
    w, h = img.size
    d = ImageDraw.Draw(img)

    # 遠景の山（薄め）
    for band in range(2):
        points = []
        y_base = horizon_y + random.randint(-60, 30) + band * 35
        x = -20
        while x < w + 20:
            y = y_base + random.randint(-80, 80) * (0.35 if band == 0 else 0.55)
            points.append((x, int(y)))
            x += random.randint(40, 110)

        points = [(-20, h), (-20, y_base)] + points + [(w + 20, y_base), (w + 20, h)]
        base = palette["mountain"]
        tint = 40 + band * 25
        col = (_clamp(base[0] + tint), _clamp(base[1] + tint), _clamp(base[2] + tint))
        d.polygon(points, fill=col)


def _draw_land_and_water(img, horizon_y, palette):
    w, h = img.size
    d = ImageDraw.Draw(img)

    # 水面 or 平地をランダム
    water_ratio = random.uniform(0.35, 0.65)
    water_top = int(_lerp(horizon_y, h, 0.18))
    water_line = int(_lerp(water_top, h, water_ratio))

    # 地面（手前）
    land_col = palette["land"]
    d.rectangle([0, water_line, w, h], fill=land_col)

    # 水面（中景）
    water_col = palette["water"]
    d.rectangle([0, water_top, w, water_line], fill=water_col)

    return water_top, water_line


def _draw_sun_and_reflection(img, horizon_y):
    w, h = img.size
    d = ImageDraw.Draw(img, "RGBA")

    sx = random.randint(int(w * 0.2), int(w * 0.8))
    sy = random.randint(int(horizon_y * 0.2), int(horizon_y * 0.75))
    r = random.randint(int(w * 0.03), int(w * 0.08))

    sun_col = (255, 245, 220, 130)
    d.ellipse([sx - r, sy - r, sx + r, sy + r], fill=sun_col)

    # 反射（縦の薄いストローク）
    for i in range(random.randint(120, 220)):
        yy = random.randint(horizon_y, h - 1)
        spread = int(_lerp(5, 60, (yy - horizon_y) / max(1, (h - horizon_y))))
        xx = sx + random.randint(-spread, spread)
        alpha = random.randint(12, 40)
        d.line([(xx, yy), (xx + random.randint(-6, 6), yy + random.randint(6, 18))], fill=(255, 240, 210, alpha), width=random.randint(1, 3))


def _draw_trees(img, horizon_y):
    w, h = img.size
    d = ImageDraw.Draw(img, "RGBA")

    # シルエット的に“木”があるだけで風景感が一気に出る
    tree_count = random.randint(12, 26)
    for _ in range(tree_count):
        base_x = random.randint(0, w - 1)
        base_y = random.randint(int(_lerp(horizon_y, h, 0.65)), h - 1)
        height = random.randint(int(h * 0.06), int(h * 0.16))
        width = random.randint(2, 6)
        col = (20, 35, 25, random.randint(90, 150))

        # trunk
        d.line([(base_x, base_y), (base_x, base_y - height)], fill=col, width=width)

        # canopy (abstract blobs)
        blob_n = random.randint(10, 18)
        for _b in range(blob_n):
            rx = random.randint(10, 28)
            ry = random.randint(8, 22)
            cx = base_x + random.randint(-28, 28)
            cy = base_y - height + random.randint(-24, 18)
            d.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=(30, 60, 45, random.randint(45, 90)))


def generate_landscape_abstract(size=1024):
    os.makedirs(OUT_DIR, exist_ok=True)
    palette = _rand_palette()

    img = Image.new("RGB", (size, size), palette["mist"])
    _vertical_gradient(img, palette["sky_top"], palette["sky_bottom"])

    w, h = img.size
    horizon_y = random.randint(int(h * 0.38), int(h * 0.58))

    # 霧の薄レイヤ
    mist = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    md = ImageDraw.Draw(mist, "RGBA")
    for _ in range(10):
        y = random.randint(int(horizon_y * 0.2), int(horizon_y * 1.1))
        md.rectangle([0, y, w, y + random.randint(20, 80)], fill=(palette["mist"][0], palette["mist"][1], palette["mist"][2], random.randint(18, 35)))
    img = Image.alpha_composite(img.convert("RGBA"), mist).convert("RGB")

    _draw_mountains(img, horizon_y, palette)
    water_top, water_line = _draw_land_and_water(img, horizon_y, palette)

    # 光源（太陽）をたまに入れる
    if random.random() < 0.75:
        _draw_sun_and_reflection(img, horizon_y)

    # 木や前景を少し
    if random.random() < 0.8:
        _draw_trees(img, horizon_y)

    # “抽象化”の筆致を重ねる（ここがポイント）
    img = _paint_strokes(img, stroke_count=random.randint(1700, 3200), max_len=random.randint(45, 120))

    # 仕上げ：軽いぼかし + ほんの少し粒状感
    img = img.filter(ImageFilter.GaussianBlur(radius=0.6))

    # 保存
    filename = datetime.now().strftime("%Y%m%d_%H%M%S") + ".png"
    path = os.path.join(OUT_DIR, filename)
    img.save(path, "PNG")

    # Node 側から扱いやすいように public/ より下の相対パスに変換
    rel_path = os.path.join("generated", filename).replace("\\", "/")
    return rel_path


if __name__ == "__main__":
    rel = generate_landscape_abstract()
    print(rel)
    sys.stdout.flush()
