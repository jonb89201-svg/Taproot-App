# Seal share cards: 1200x630 (X / Open Graph) and 1200x800 (Farcaster embed, 3:2).
# Name per the Architect, 2026-10-20: "Taproot's Seal hash-fingerprint".
# Usage: python3 tools/seal-card.py assets_base   (needs Pillow and the Inter fonts under /usr/share/fonts/opentype/inter)
import math, sys
from PIL import Image, ImageDraw, ImageFont

OUT = sys.argv[1]
F = "/usr/share/fonts/opentype/inter/"
BG, OXIDE, INK, DIM = "#f4f1e6", "#2b7b17", "#1e211b", "#5f6553"

def font(name, size): return ImageFont.truetype(F + name, size)

def fingerprint(size, color):
    # a fingertip: whorl ridges around a core, two breaks per ridge, clipped to a tall oval; drawn 4x then scaled
    S = size * 4
    lay = Image.new("L", (S, S), 0)
    d = ImageDraw.Draw(lay)
    cx, cy = S * 0.5, S * 0.42
    w = int(S * 0.026)
    for k in range(1, 15):
        rx, ry = S * 0.052 * k, S * 0.064 * k
        box = [cx - rx, cy - ry, cx + rx, cy + ry]
        if k <= 2:
            segs = [(110, 430)]                               # the core loop opens downward
        else:
            g1, g2 = (k * 73) % 360, (k * 151 + 40) % 360
            cuts = sorted([g1, g2])
            segs = [(cuts[0] + 7, cuts[1] - 7), (cuts[1] + 7, cuts[0] + 360 - 7)]
        for a0, a1 in segs:
            if a1 > a0:
                d.arc(box, a0, a1, fill=255, width=w)
    tip = Image.new("L", (S, S), 0)
    ImageDraw.Draw(tip).ellipse([S * 0.15, S * 0.03, S * 0.85, S * 0.99], fill=255)
    alpha = Image.composite(lay, Image.new("L", (S, S), 0), tip)
    out = Image.new("RGBA", (S, S), color)
    out.putalpha(alpha)
    return out.resize((size, size), Image.LANCZOS)

def wax_seal(im, d, cx, cy, r):
    pts = []
    for i in range(240):
        a = 2 * math.pi * i / 240
        rr = r * (1 + 0.045 * math.cos(24 * a))
        pts.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
    d.polygon(pts, fill=OXIDE)
    d.ellipse([cx - r * 0.78, cy - r * 0.78, cx + r * 0.78, cy + r * 0.78], outline="#d3f0c2", width=max(3, int(r * 0.035)))
    fp = int(r * 1.36)
    im.paste(fingerprint(fp, "white"), (int(cx - fp / 2), int(cy - fp / 2)), fingerprint(fp, "white"))

def card(W, H, path):
    # laid out for 630 high; a taller canvas centres the block and keeps the footer at the bottom
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    off = (H - 630) // 2
    wax_seal(im, d, 240, 290 + off, 157)
    x = 456
    d.text((x, 112 + off), "Taproot's", font=font("Inter-Medium.otf", 34), fill=DIM)
    d.text((x, 142 + off), "Seal", font=font("Inter-Bold.otf", 120), fill=OXIDE)
    d.text((x, 288 + off), "hash-fingerprint", font=font("Inter-SemiBold.otf", 48), fill=INK)
    small = font("Inter-Regular.otf", 28)
    for i, line in enumerate(["Your wallet signs the file's fingerprint.",
                              "The file never leaves your device.",
                              "Free to sign and verify. Anchor on Base for $0.02."]):
        d.text((x, 372 + off + 40 * i), line, font=small, fill=DIM)
    d.text((72, H - 82), "taproot.possessio.io/seal", font=font("Inter-Medium.otf", 28), fill=OXIDE)
    d.rectangle([0, H - 10, W, H], fill=OXIDE)
    im.save(path, optimize=True)

card(1200, 630, OUT + "/seal_card_1200x630.png")
card(1200, 800, OUT + "/seal_embed_1200x800.png")
print("ok")
