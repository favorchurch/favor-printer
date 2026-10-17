#!/usr/bin/env python3
"""Generate the Favor Printer app icons (iPad asset catalog + Mac .icns) from the Favor App source art.

Usage: python3 scripts/icons/generate.py   (needs Pillow: pip install pillow; iconutil from macOS)

Source: scripts/icons/favor-app-1024.png, copied from ~/Git/rock-mobile-app
(ios/FavorRockApp/Resources/Assets.xcassets/AppIcon.appiconset/FAVORAPP_APPLE_(1024px).png).
The white mark is extracted from it, "CHURCH" is replaced by a printer glyph, and the
variants are composed from that one mask.
"""
import random
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "scripts/icons/favor-app-1024.png"
APPICON = ROOT / "ios/FavorPrinter/Assets.xcassets/AppIcon.appiconset"
ICNS = ROOT / "build/icon.icns"
N = 1024
ORANGE = (253, 94, 40)


def smoothstep(lo, hi):
    return lambda v: 0 if v <= lo else 255 if v >= hi else int(255 * ((v - lo) / (hi - lo)) ** 2 * (3 - 2 * (v - lo) / (hi - lo)))


def mark_mask():
    """White Favor diamond + FAVOR wordmark as an L mask, with CHURCH and specks removed."""
    b = Image.open(SRC).convert("RGB").split()[2]
    m = b.point([smoothstep(110, 200)(v) for v in range(256)]).filter(ImageFilter.MedianFilter(5))
    d = ImageDraw.Draw(m)
    d.rectangle((278, 535, 748, 640), fill=0)  # CHURCH
    for box in ((0, 0, N, 100), (0, 0, 140, N), (890, 0, N, N), (0, 925, N, N), (0, 120, 100, 200), (60, 430, 110, 480)):
        d.rectangle(box, fill=0)  # source specks
    return m


def printer_mask():
    """Printer glyph with a label coming out, drawn at the old CHURCH position."""
    s = 4
    m = Image.new("L", (N * s, N * s), 0)
    d = ImageDraw.Draw(m)
    def R(x0, y0, x1, y1, r, fill=255):
        d.rounded_rectangle([v * s for v in (x0, y0, x1, y1)], radius=r * s, fill=fill)
    cx = 512
    R(cx - 85, 545, cx + 85, 600, 8)              # paper in
    R(cx - 150, 590, cx + 150, 665, 22)           # body
    R(cx - 108, 640, cx + 108, 695, 8)            # label out
    R(cx - 108, 640, cx + 108, 695, 8, 255)
    # cut-outs: slot above label, paper gap, status light
    R(cx - 80, 652, cx + 80, 664, 0, 0)
    R(cx - 85, 600, cx + 85, 606, 0, 0)
    d.ellipse([(cx + 105) * s, 612 * s, (cx + 127) * s, 634 * s], fill=0)
    # label stripe lines
    R(cx - 70, 672, cx + 20, 679, 3, 0)
    R(cx - 70, 684, cx - 10, 690, 3, 0)
    return m.resize((N, N), Image.LANCZOS)


def background(light=True):
    rnd = random.Random(7)
    base = Image.new("RGB", (N, N), ORANGE)
    noise = Image.effect_noise((N, N), 18).filter(ImageFilter.GaussianBlur(0.8))
    g = Image.merge("RGB", [noise] * 3)
    tex = ImageChops.add(base, g, scale=1, offset=-128)
    glow = Image.radial_gradient("L").resize((N, N)).point(lambda v: 255 - v)
    hi = Image.new("RGB", (N, N), (255, 140, 70))
    return Image.composite(hi, tex, glow.point(lambda v: v // 5))


def compose(mask, bg, fg=(255, 255, 255)):
    return Image.composite(Image.new("RGB", (N, N), fg), bg, mask)


def squircle(img, inset=100, radius=185):
    """Mac icon: artwork on a 824px rounded square with a soft shadow, transparent margin."""
    size = N - 2 * inset
    art = img.resize((size, size), Image.LANCZOS).convert("RGBA")
    mk = Image.new("L", (size * 4, size * 4), 0)
    ImageDraw.Draw(mk).rounded_rectangle((0, 0, size * 4 - 1, size * 4 - 1), radius=radius * 4, fill=255)
    art.putalpha(mk.resize((size, size), Image.LANCZOS))
    out = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    sh = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    sh.paste((0, 0, 0, 110), (inset, inset + 12), art.getchannel("A"))
    out = Image.alpha_composite(out, sh.filter(ImageFilter.GaussianBlur(14)))
    out.alpha_composite(art, (inset, inset))
    return out


def main():
    mark = ImageChops.lighter(mark_mask(), printer_mask())
    light = compose(mark, background())
    dark_bg = Image.new("RGB", (N, N), (28, 20, 17))
    dark_bg = Image.composite(Image.new("RGB", (N, N), (58, 30, 18)), dark_bg,
                              Image.radial_gradient("L").resize((N, N)).point(lambda v: (255 - v) // 2))
    dark = compose(mark, dark_bg, ORANGE)
    tinted = compose(mark, Image.new("RGB", (N, N), (0, 0, 0)), (255, 255, 255))
    APPICON.mkdir(parents=True, exist_ok=True)
    light.save(APPICON / "AppIcon-1024.png")
    dark.save(APPICON / "AppIcon-Dark-1024.png")
    tinted.convert("L").convert("RGB").save(APPICON / "AppIcon-Tinted-1024.png")
    (APPICON / "Contents.json").write_text(CONTENTS)

    # Mac .icns from the squircled artwork
    mac = squircle(light)
    iconset = ROOT / "build/icon.iconset"
    iconset.mkdir(exist_ok=True)
    for base in (16, 32, 128, 256, 512):
        mac.resize((base, base), Image.LANCZOS).save(iconset / f"icon_{base}x{base}.png")
        mac.resize((base * 2, base * 2), Image.LANCZOS).save(iconset / f"icon_{base}x{base}@2x.png")
    subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(ICNS)], check=True)
    for f in iconset.iterdir():
        f.unlink()
    iconset.rmdir()


CONTENTS = """{
  "images" : [
    {
      "filename" : "AppIcon-1024.png",
      "idiom" : "universal",
      "platform" : "ios",
      "size" : "1024x1024"
    },
    {
      "appearances" : [
        {
          "appearance" : "luminosity",
          "value" : "dark"
        }
      ],
      "filename" : "AppIcon-Dark-1024.png",
      "idiom" : "universal",
      "platform" : "ios",
      "size" : "1024x1024"
    },
    {
      "appearances" : [
        {
          "appearance" : "luminosity",
          "value" : "tinted"
        }
      ],
      "filename" : "AppIcon-Tinted-1024.png",
      "idiom" : "universal",
      "platform" : "ios",
      "size" : "1024x1024"
    }
  ],
  "info" : {
    "author" : "xcode",
    "version" : 1
  }
}
"""

if __name__ == "__main__":
    sys.exit(main())
