#!/usr/bin/env python3
"""
Generate Chrome Web Store listing screenshots (1280x800, 24-bit RGB, no alpha)
that accurately represent the Voiceido — Full Page Capture extension.

Five screenshots are produced into store-assets/screenshots/.

Each screenshot is a stylised marketing mockup of one feature. They are
brand-consistent and NEVER claim a feature the extension does not provide
(see Chrome Web Store program policy on misleading metadata).
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
ICON_SRC = ROOT / "public" / "icons" / "icon512.png"
OUT_DIR = ROOT / "store-assets" / "screenshots"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# ── brand palette (matches popup.css) ─────────────────────────────────────────
ACCENT = (109, 40, 217)
ACCENT_STRONG = (76, 29, 149)
ACCENT_SOFT = (167, 139, 250)
BG_TOP = (245, 243, 255)
BG_BOTTOM = (224, 215, 255)
INK = (24, 12, 56)
INK_SOFT = (90, 80, 130)
WHITE = (255, 255, 255)
PANEL = (255, 255, 255)
PANEL_SHADOW = (180, 165, 220)
SUCCESS = (16, 185, 129)
NEUTRAL_LINE = (228, 220, 245)


# ── font helpers ──────────────────────────────────────────────────────────────


def font(size: int, weight: str = "regular"):
    chain_bold = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ]
    chain_regular = [
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ]
    chain_mono = [
        "/System/Library/Fonts/Menlo.ttc",
        "/System/Library/Fonts/Supplemental/Courier New.ttf",
    ]
    chain = {"bold": chain_bold, "regular": chain_regular, "mono": chain_mono}[weight]
    for c in chain:
        if Path(c).exists():
            try:
                return ImageFont.truetype(c, size)
            except OSError:
                pass
    return ImageFont.load_default()


# ── shape helpers ────────────────────────────────────────────────────────────


def gradient_bg(size, top_color, bottom_color):
    w, h = size
    base = Image.new("RGB", size, top_color)
    overlay = Image.new("RGB", size, bottom_color)
    grad = Image.new("L", (1, h), 0)
    for y in range(h):
        grad.putpixel((0, y), int(255 * (y / max(1, h - 1))))
    grad = grad.resize(size)
    return Image.composite(overlay, base, grad)


def soft_shadow(canvas, box, radius, blur=24, alpha=70, dy=12):
    layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    shadow_box = (box[0], box[1] + dy, box[2], box[3] + dy)
    d.rounded_rectangle(shadow_box, radius=radius, fill=(20, 8, 60, alpha))
    layer = layer.filter(ImageFilter.GaussianBlur(blur))
    return Image.alpha_composite(canvas.convert("RGBA"), layer).convert("RGB")


def draw_panel(draw, box, radius=20, fill=PANEL, outline=NEUTRAL_LINE, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def draw_browser_chrome(draw, x, y, w, h, title="https://example.com"):
    """A simple mock browser card top-bar (traffic lights + URL pill)."""
    draw.rounded_rectangle((x, y, x + w, y + h), radius=18, fill=(248, 246, 252), outline=NEUTRAL_LINE, width=1)
    cy = y + h // 2
    cx = x + 22
    for i, color in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        draw.ellipse((cx + i * 22 - 7, cy - 7, cx + i * 22 + 7, cy + 7), fill=color)
    pill_x1 = x + 110
    pill_x2 = x + w - 110
    draw.rounded_rectangle((pill_x1, cy - 13, pill_x2, cy + 13), radius=13, fill=(255, 255, 255), outline=NEUTRAL_LINE)
    draw.text((pill_x1 + 14, cy - 9), title, font=font(15), fill=INK_SOFT)


def text_block(draw, anchor, lines, fill=INK, leading=8):
    x, y = anchor
    for line, f in lines:
        bbox = draw.textbbox((0, 0), line, font=f)
        line_h = bbox[3] - bbox[1]
        draw.text((x, y - bbox[1]), line, font=f, fill=fill)
        y += line_h + leading
    return y


def draw_title_block(canvas, *, eyebrow, title, body, x, y, max_w):
    draw = ImageDraw.Draw(canvas)
    f_eye = font(20, "bold")
    f_title = font(54, "bold")
    f_body = font(22, "regular")

    cursor = y
    draw.text((x, cursor), eyebrow.upper(), font=f_eye, fill=ACCENT)
    cursor += 36

    for line in wrap(title, f_title, max_w, draw):
        draw.text((x, cursor), line, font=f_title, fill=INK)
        cursor += 64

    cursor += 12
    for line in wrap(body, f_body, max_w, draw):
        draw.text((x, cursor), line, font=f_body, fill=INK_SOFT)
        cursor += 32


def wrap(text, f, max_w, draw):
    words = text.split()
    lines, cur = [], ""
    for w in words:
        trial = (cur + " " + w).strip()
        if draw.textlength(trial, font=f) <= max_w:
            cur = trial
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


# ── popup mockup (matches popup.html in essence) ─────────────────────────────


def draw_popup_mockup(canvas, top_left, *, scale=1.0):
    """A faithful mock of the extension popup (idle state)."""
    draw = ImageDraw.Draw(canvas)
    pw, ph = int(360 * scale), int(420 * scale)
    x, y = top_left

    canvas2 = soft_shadow(canvas, (x, y, x + pw, y + ph), radius=int(20 * scale), blur=int(28 * scale), alpha=80, dy=int(14 * scale))
    canvas.paste(canvas2)

    draw = ImageDraw.Draw(canvas)
    draw_panel(draw, (x, y, x + pw, y + ph), radius=int(20 * scale), fill=PANEL)

    pad = int(20 * scale)
    icon = Image.open(ICON_SRC).convert("RGBA").resize((int(40 * scale), int(40 * scale)), Image.LANCZOS)
    canvas.alpha_composite(icon, (x + pad, y + pad)) if canvas.mode == "RGBA" else canvas.paste(icon, (x + pad, y + pad), icon)

    draw.text((x + pad + int(54 * scale), y + pad + int(2 * scale)), "Full Page Capture", font=font(int(18 * scale), "bold"), fill=INK)
    draw.text((x + pad + int(54 * scale), y + pad + int(24 * scale)), "Pick a mode, then run the capture.", font=font(int(12 * scale)), fill=INK_SOFT)

    card_top = y + pad + int(60 * scale)
    card_box = (x + pad, card_top, x + pw - pad, card_top + int(110 * scale))
    draw.rounded_rectangle(card_box, radius=int(14 * scale), fill=(245, 240, 255), outline=ACCENT_SOFT)
    draw.text((card_box[0] + int(14 * scale), card_box[1] + int(12 * scale)), "Ready to capture this tab.", font=font(int(14 * scale), "bold"), fill=INK)
    blurb_lines = wrap("Choose a mode below, then press Run capture. Voiceido never captures automatically — you stay in control.", font(int(12 * scale)), card_box[2] - card_box[0] - int(24 * scale), draw)
    cy = card_box[1] + int(34 * scale)
    for line in blurb_lines:
        draw.text((card_box[0] + int(14 * scale), cy), line, font=font(int(12 * scale)), fill=INK_SOFT)
        cy += int(16 * scale)

    btn_top = card_box[3] + int(12 * scale)
    btn_box = (x + pad, btn_top, x + pw - pad, btn_top + int(40 * scale))
    draw.rounded_rectangle(btn_box, radius=int(10 * scale), fill=ACCENT)
    btn_text = "Run capture"
    tw = draw.textlength(btn_text, font=font(int(14 * scale), "bold"))
    draw.text(((btn_box[0] + btn_box[2]) / 2 - tw / 2, btn_top + int(11 * scale)), btn_text, font=font(int(14 * scale), "bold"), fill=WHITE)

    mode_top = btn_box[3] + int(18 * scale)
    for i, (title_, desc) in enumerate(
        [("Full page", "Capture the entire scrollable document."), ("Inner section", "Capture only the scroll box you last clicked inside.")]
    ):
        b_top = mode_top + i * int(64 * scale)
        b = (x + pad, b_top, x + pw - pad, b_top + int(54 * scale))
        draw.rounded_rectangle(b, radius=int(10 * scale), fill=PANEL, outline=NEUTRAL_LINE)
        radio_x, radio_y = b[0] + int(14 * scale), b[1] + int(18 * scale)
        draw.ellipse((radio_x, radio_y, radio_x + int(18 * scale), radio_y + int(18 * scale)), outline=ACCENT_SOFT, width=2)
        if i == 0:
            draw.ellipse((radio_x + int(4 * scale), radio_y + int(4 * scale), radio_x + int(14 * scale), radio_y + int(14 * scale)), fill=ACCENT)
        draw.text((b[0] + int(40 * scale), b[1] + int(10 * scale)), title_, font=font(int(13 * scale), "bold"), fill=INK)
        draw.text((b[0] + int(40 * scale), b[1] + int(28 * scale)), desc, font=font(int(11 * scale)), fill=INK_SOFT)


def draw_capture_preview(canvas, top_left, *, scale=1.0, mode="actions", body_text=None):
    """A mockup of the post-capture preview tab toolbar + image area."""
    draw = ImageDraw.Draw(canvas)
    pw, ph = int(720 * scale), int(440 * scale)
    x, y = top_left

    canvas2 = soft_shadow(canvas, (x, y, x + pw, y + ph), radius=int(20 * scale), blur=int(30 * scale), alpha=70, dy=int(14 * scale))
    canvas.paste(canvas2)

    draw = ImageDraw.Draw(canvas)
    draw_panel(draw, (x, y, x + pw, y + ph), radius=int(20 * scale), fill=PANEL)

    bar_h = int(56 * scale)
    draw.rounded_rectangle((x, y, x + pw, y + bar_h), radius=int(20 * scale), fill=(252, 250, 255))
    draw.line((x, y + bar_h, x + pw, y + bar_h), fill=NEUTRAL_LINE)

    icon = Image.open(ICON_SRC).convert("RGBA").resize((int(28 * scale), int(28 * scale)), Image.LANCZOS)
    canvas.paste(icon, (x + int(16 * scale), y + (bar_h - int(28 * scale)) // 2), icon)
    draw.text((x + int(54 * scale), y + int(18 * scale)), "Voiceido", font=font(int(14 * scale), "bold"), fill=INK)

    btns = [("Download PNG", ACCENT), ("Download PDF", ACCENT), ("OCR · txt", ACCENT_STRONG), ("Analyze · txt", ACCENT_STRONG)]
    bx = x + pw - int(16 * scale)
    for label, color in reversed(btns):
        bw = int(draw.textlength(label, font=font(int(13 * scale), "bold")) + int(28 * scale))
        bh = int(32 * scale)
        b_left = bx - bw
        b_top = y + (bar_h - bh) // 2
        draw.rounded_rectangle((b_left, b_top, bx, b_top + bh), radius=int(8 * scale), fill=color)
        draw.text((b_left + int(14 * scale), b_top + int(9 * scale)), label, font=font(int(13 * scale), "bold"), fill=WHITE)
        bx = b_left - int(8 * scale)

    body = (x + int(20 * scale), y + bar_h + int(20 * scale), x + pw - int(20 * scale), y + ph - int(20 * scale))

    if mode == "image":
        sub_canvas = Image.new("RGB", (body[2] - body[0], body[3] - body[1]), (243, 240, 252))
        sub_draw = ImageDraw.Draw(sub_canvas)
        for line_y in range(20, sub_canvas.height - 20, 28):
            w = sub_canvas.width - 60
            sub_draw.rounded_rectangle((30, line_y, 30 + int(w * 0.8), line_y + 12), radius=4, fill=(220, 212, 240))
        for box_y in range(60, sub_canvas.height - 60, 110):
            sub_draw.rounded_rectangle(
                (40, box_y, 40 + 160, box_y + 80),
                radius=12,
                fill=(255, 255, 255),
                outline=NEUTRAL_LINE,
            )
        sub_draw.rounded_rectangle((sub_canvas.width - 200, 60, sub_canvas.width - 60, 200), radius=10, fill=(218, 205, 245), outline=ACCENT_SOFT)
        canvas.paste(sub_canvas, (body[0], body[1]))
        draw.rounded_rectangle(body, radius=int(12 * scale), outline=NEUTRAL_LINE, width=1)

    elif mode == "ocr":
        draw.rounded_rectangle(body, radius=int(12 * scale), fill=(252, 250, 255), outline=NEUTRAL_LINE, width=1)
        sample = body_text or (
            "Voiceido — Full Page Capture\n"
            "Capture full-page screenshots of any web page.\n"
            "OCR Result\n\n"
            "WELCOME TO THE OPEN-SOURCE WEB\n"
            "Voiceido is a Manifest V3 Chrome extension that\n"
            "turns any browser tab into a single, high-fidelity\n"
            "PNG or PDF screenshot in one click.\n\n"
            "  • Full-page capture — no scrolling required\n"
            "  • Optional OCR — extract text from the screenshot\n"
            "  • Optional AI Analyze — summarize what's on the page"
        )
        f_mono = font(int(15 * scale), "mono")
        ty = body[1] + int(20 * scale)
        for line in sample.splitlines():
            draw.text((body[0] + int(20 * scale), ty), line, font=f_mono, fill=INK)
            ty += int(22 * scale)

    elif mode == "analyze":
        draw.rounded_rectangle(body, radius=int(12 * scale), fill=(252, 250, 255), outline=NEUTRAL_LINE, width=1)
        sample = body_text or (
            "AI Analysis\n\n"
            "The captured page is the GitHub repository for an\n"
            "open-source Chrome extension named Voiceido.\n\n"
            "Key elements visible on the page:\n"
            "  – Repository title and short description\n"
            "  – README rendered in markdown with installation steps\n"
            "  – Architecture diagram showing the popup, service worker,\n"
            "    offscreen document, and capture preview tab\n"
            "  – Buttons for Issues, Pull requests, and Releases\n\n"
            "The page appears to be in dark mode and emphasizes\n"
            "privacy: no host_permissions, optional self-hosted\n"
            "backend for OCR and analysis."
        )
        f_text = font(int(15 * scale))
        ty = body[1] + int(20 * scale)
        for line in sample.splitlines():
            draw.text((body[0] + int(20 * scale), ty), line, font=f_text, fill=INK)
            ty += int(22 * scale)

    else:  # actions hint
        draw.rounded_rectangle(body, radius=int(12 * scale), fill=(248, 244, 255), outline=NEUTRAL_LINE)
        f = font(int(16 * scale))
        msg = "↑  Pick an action: PNG, PDF, OCR, or Analyze."
        tw = draw.textlength(msg, font=f)
        draw.text(((body[0] + body[2]) / 2 - tw / 2, (body[1] + body[3]) / 2 - 12), msg, font=f, fill=INK_SOFT)


# ── compositions ────────────────────────────────────────────────────────────


def compose_screenshot_one():
    canvas = gradient_bg((1280, 800), BG_TOP, BG_BOTTOM)
    draw = ImageDraw.Draw(canvas)

    draw_title_block(
        canvas,
        eyebrow="Voiceido",
        title="One click. Full page. PNG or PDF.",
        body="Capture the entire scrollable document — not just the viewport — directly to your Downloads folder.",
        x=80,
        y=200,
        max_w=560,
    )

    draw_popup_mockup(canvas, top_left=(820, 165), scale=0.95)

    f = font(15)
    draw.text((80, 720), "Manifest V3 · No host permissions · No telemetry · No ads", font=f, fill=INK_SOFT)
    return canvas


def compose_screenshot_two():
    canvas = gradient_bg((1280, 800), BG_TOP, BG_BOTTOM)
    draw_title_block(
        canvas,
        eyebrow="Capture preview",
        title="Export, OCR, or analyze — your choice.",
        body="A clean preview tab opens after every capture, with PNG, PDF, OCR, and Analyze in the toolbar.",
        x=80,
        y=110,
        max_w=1100,
    )
    draw_capture_preview(canvas, top_left=(280, 360), scale=1.0, mode="image")
    return canvas


def compose_screenshot_three():
    canvas = gradient_bg((1280, 800), BG_TOP, BG_BOTTOM)
    draw_title_block(
        canvas,
        eyebrow="Local PDF export",
        title="Save any web page as a single-image PDF.",
        body="Generated entirely on-device. No backend, no cloud, no upload — just a clean PDF in your Downloads folder.",
        x=80,
        y=110,
        max_w=1100,
    )
    draw = ImageDraw.Draw(canvas)
    pdf_w, pdf_h = 540, 360
    pdf_x, pdf_y = 220, 380
    canvas = soft_shadow(canvas, (pdf_x, pdf_y, pdf_x + pdf_w, pdf_y + pdf_h), radius=14, blur=24, dy=12)
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle((pdf_x, pdf_y, pdf_x + pdf_w, pdf_y + pdf_h), radius=14, fill=WHITE, outline=NEUTRAL_LINE)
    for line_y in range(pdf_y + 30, pdf_y + pdf_h - 30, 26):
        line_w = int((pdf_w - 60) * (0.95 if (line_y // 26) % 3 else 0.55))
        draw.rounded_rectangle((pdf_x + 30, line_y, pdf_x + 30 + line_w, line_y + 10), radius=3, fill=(228, 220, 245))
    draw.rounded_rectangle((pdf_x + 30, pdf_y + pdf_h - 130, pdf_x + 30 + 200, pdf_y + pdf_h - 30), radius=10, fill=(243, 240, 252), outline=ACCENT_SOFT)

    arrow_x = 820
    draw.text((arrow_x, 420), "Saved as", font=font(20), fill=INK_SOFT)
    draw.text((arrow_x, 460), "voiceido-capture.pdf", font=font(28, "bold"), fill=INK)
    draw.rounded_rectangle((arrow_x, 520, arrow_x + 320, 580), radius=12, fill=ACCENT)
    label = "Downloads ▾"
    tw = draw.textlength(label, font=font(20, "bold"))
    draw.text((arrow_x + 160 - tw / 2, 537), label, font=font(20, "bold"), fill=WHITE)

    return canvas


def compose_screenshot_four():
    canvas = gradient_bg((1280, 800), BG_TOP, BG_BOTTOM)
    draw_title_block(
        canvas,
        eyebrow="Optional OCR",
        title="Pull text out of any page you can see.",
        body="One click sends the captured screenshot to your self-hosted backend and saves the recognised text as .txt.",
        x=80,
        y=110,
        max_w=1100,
    )
    draw_capture_preview(canvas, top_left=(280, 360), scale=1.0, mode="ocr")
    return canvas


def compose_screenshot_five():
    canvas = gradient_bg((1280, 800), BG_TOP, BG_BOTTOM)
    draw_title_block(
        canvas,
        eyebrow="Optional AI analyze",
        title="A short, useful description of any captured page.",
        body="Send the screenshot to your own GPT-4o-mini-backed endpoint and receive a concise description as text.",
        x=80,
        y=110,
        max_w=1100,
    )
    draw_capture_preview(canvas, top_left=(280, 360), scale=1.0, mode="analyze")
    return canvas


# ── main ────────────────────────────────────────────────────────────────────


def main():
    builders = [
        ("01-one-click-capture.png", compose_screenshot_one),
        ("02-export-actions.png", compose_screenshot_two),
        ("03-local-pdf.png", compose_screenshot_three),
        ("04-ocr.png", compose_screenshot_four),
        ("05-analyze.png", compose_screenshot_five),
    ]
    for name, fn in builders:
        img = fn()
        if img.mode != "RGB":
            img = img.convert("RGB")
        out = OUT_DIR / name
        img.save(out, "PNG", optimize=True)
        print(f"wrote {out} ({img.size}, {img.mode})")


if __name__ == "__main__":
    main()
