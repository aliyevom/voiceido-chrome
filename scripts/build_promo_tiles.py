#!/usr/bin/env python3
"""
Generate Chrome Web Store promo tiles from the Voiceido brand icon.

Outputs (RGB, 24-bit PNG, no alpha — required by CWS):
  store-assets/promo-small-440x280.png
  store-assets/promo-marquee-1400x560.png
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
ICON_SRC = ROOT / "public" / "icons" / "icon512.png"
OUT_DIR = ROOT / "store-assets"
OUT_DIR.mkdir(parents=True, exist_ok=True)

ACCENT = (109, 40, 217)
ACCENT_STRONG = (76, 29, 149)
WHITE = (255, 255, 255)
SOFT_WHITE = (240, 234, 255)
DARK_INK = (24, 12, 56)


def vertical_gradient(size, top, bottom):
    w, h = size
    base = Image.new("RGB", size, top)
    grad = Image.new("L", (1, h), 0)
    for y in range(h):
        grad.putpixel((0, y), int(255 * (y / max(1, h - 1))))
    grad = grad.resize(size)
    overlay = Image.new("RGB", size, bottom)
    return Image.composite(overlay, base, grad)


def diagonal_gradient(size, top_left, bottom_right):
    w, h = size
    base = Image.new("RGB", size, top_left)
    overlay = Image.new("RGB", size, bottom_right)
    mask = Image.new("L", size, 0)
    px = mask.load()
    for y in range(h):
        for x in range(w):
            t = ((x / max(1, w - 1)) + (y / max(1, h - 1))) / 2
            px[x, y] = int(255 * t)
    return Image.composite(overlay, base, mask)


def load_font(size, weight="bold"):
    # Inter / SF aren't TTF on macOS by default; ship with a clean fallback chain.
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
        if weight == "bold"
        else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ]
    for c in candidates:
        if Path(c).exists():
            try:
                return ImageFont.truetype(c, size)
            except OSError:
                continue
    return ImageFont.load_default()


def draw_subtle_grid(draw, w, h, step, colour=(255, 255, 255, 18)):
    overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    for x in range(0, w, step):
        od.line([(x, 0), (x, h)], fill=colour, width=1)
    for y in range(0, h, step):
        od.line([(0, y), (w, y)], fill=colour, width=1)
    return overlay


def add_glow_rect(canvas, box, radius, colour, blur):
    """Soft glow under the icon."""
    layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.rounded_rectangle(box, radius=radius, fill=colour)
    return Image.alpha_composite(canvas.convert("RGBA"), layer.filter(ImageFilter.GaussianBlur(blur)))


def make_tile(size, *, title, tagline, icon_size, padding):
    w, h = size
    canvas = diagonal_gradient(size, ACCENT, ACCENT_STRONG)

    grid = draw_subtle_grid(None, w, h, step=max(40, w // 24))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), grid)

    icon = Image.open(ICON_SRC).convert("RGBA")
    icon = icon.resize((icon_size, icon_size), Image.LANCZOS)

    icon_x = padding
    icon_y = (h - icon_size) // 2

    glow_box = (
        icon_x - icon_size // 6,
        icon_y - icon_size // 6,
        icon_x + icon_size + icon_size // 6,
        icon_y + icon_size + icon_size // 6,
    )
    canvas = add_glow_rect(canvas, glow_box, radius=icon_size // 3, colour=(255, 255, 255, 60), blur=icon_size // 4)

    canvas.alpha_composite(icon, (icon_x, icon_y))

    draw = ImageDraw.Draw(canvas)

    title_size = int(h * 0.16)
    tagline_size = int(h * 0.085)
    title_font = load_font(title_size, weight="bold")
    tagline_font = load_font(tagline_size, weight="regular")

    text_x = icon_x + icon_size + padding // 2
    title_bbox = draw.textbbox((0, 0), title, font=title_font)
    title_h = title_bbox[3] - title_bbox[1]
    tagline_bbox = draw.textbbox((0, 0), tagline, font=tagline_font)
    tagline_h = tagline_bbox[3] - tagline_bbox[1]

    block_h = title_h + int(h * 0.04) + tagline_h
    title_y = (h - block_h) // 2 - title_bbox[1]

    draw.text((text_x, title_y), title, font=title_font, fill=WHITE)
    draw.text(
        (text_x, title_y + title_h + int(h * 0.04) - tagline_bbox[1]),
        tagline,
        font=tagline_font,
        fill=SOFT_WHITE,
    )

    return canvas.convert("RGB")


def main():
    small = make_tile(
        (440, 280),
        title="Voiceido",
        tagline="Full-page capture · OCR · AI",
        icon_size=160,
        padding=28,
    )
    small_path = OUT_DIR / "promo-small-440x280.png"
    small.save(small_path, "PNG", optimize=True)
    print(f"wrote {small_path} ({small.size})")

    marquee = make_tile(
        (1400, 560),
        title="Voiceido — Full Page Capture",
        tagline="Full-page screenshots · PNG / PDF · self-hosted OCR & AI",
        icon_size=360,
        padding=80,
    )
    marquee_path = OUT_DIR / "promo-marquee-1400x560.png"
    marquee.save(marquee_path, "PNG", optimize=True)
    print(f"wrote {marquee_path} ({marquee.size})")


if __name__ == "__main__":
    main()
