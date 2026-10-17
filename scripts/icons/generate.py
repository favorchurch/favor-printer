#!/usr/bin/env python3
"""Generate the Favor Printer app icons (iPad asset catalog + Mac .icns) from the Favor App source art.

Usage: python3 scripts/icons/generate.py   (needs Pillow: pip install pillow; iconutil from macOS)

Source: scripts/icons/favor-app-1024.png, copied from ~/Git/rock-mobile-app
(ios/FavorRockApp/Resources/Assets.xcassets/AppIcon.appiconset/FAVORAPP_APPLE_(1024px).png).
The diamond and FAVOR wordmark are extracted from it as masks and recoloured: RSVP red
(#EE4924, rsvp.favor.church --color-primary) on near-black, with a printer glyph under the
wordmark. The light, dark and tinted iPad variants and the Mac icon come from those masks.
"""
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "scripts/icons/favor-app-1024.png"
APPICON = ROOT / "ios/FavorPrinter/Assets.xcassets/AppIcon.appiconset"
ICNS = ROOT / "build/icon.icns"
N = 1024
RED = (0xEE, 0x49, 0x24)
PAPER = (254, 241, 232)


def smoothstep(lo, hi):
    return lambda v: 0 if v <= lo else 255 if v >= hi else int(255 * ((v - lo) / (hi - lo)) ** 2 * (3 - 2 * (v - lo) / (hi - lo)))


def source_mask():
    b = Image.open(SRC).convert("RGB").split()[2]
    m = b.point([smoothstep(110, 200)(v) for v in range(256)]).filter(ImageFilter.MedianFilter(5))
    d = ImageDraw.Draw(m)
    d.rectangle((278, 535, 748, 640), fill=0)  # CHURCH
    for box in ((0, 0, N, 100), (0, 0, 140, N), (890, 0, N, N), (0, 925, N, N), (0, 120, 100, 200), (60, 430, 110, 480)):
        d.rectangle(box, fill=0)  # source specks
    return m


def diamond_mask():
    m = source_mask()
    ImageDraw.Draw(m).rectangle((285, 395, 750, 530), fill=0)
    return m


def wordmark_mask():
    m = source_mask()
    d = ImageDraw.Draw(m)
    for box in ((0, 0, N, 395), (0, 530, N, N), (0, 0, 285, N), (750, 0, N, N)):
        d.rectangle(box, fill=0)
    return m


def printer_mask(cx=512, cy=640, w=230):
    """Printer glyph with a label coming out."""
    s = 4
    m = Image.new("L", (N * s, N * s), 0)
    d = ImageDraw.Draw(m)
    k = w / 300

    def R(x0, y0, x1, y1, r, fill=255):
        d.rounded_rectangle([int(v * s) for v in (cx + x0 * k, cy + y0 * k, cx + x1 * k, cy + y1 * k)], radius=int(r * k * s), fill=fill)

    R(-85, -75, 85, -10, 8)      # paper in
    R(-150, -30, 150, 55, 24)    # body
    R(-108, 30, 108, 105, 8)     # label out
    R(-85, -10, 85, -3, 0, 0)    # paper gap
    R(-80, 40, 80, 52, 0, 0)     # label slot
    d.ellipse([int((cx + 105 * k) * s), int((cy - 3 * k) * s), int((cx + 127 * k) * s), int((cy + 19 * k) * s)], fill=0)
    R(-70, 66, 20, 74, 3, 0)
    R(-70, 82, -10, 90, 3, 0)
    return m.resize((N, N), Image.LANCZOS)


def gradient(top, bottom):
    return Image.composite(Image.new("RGB", (N, N), bottom), Image.new("RGB", (N, N), top),
                           Image.linear_gradient("L").resize((N, N)))


def compose(bg, layers):
    im = bg
    for mask, color in layers:
        im = Image.composite(Image.new("RGB", (N, N), color), im, mask)
    return im


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
    diamond, word, printer = diamond_mask(), wordmark_mask(), printer_mask()
    light = compose(gradient((30, 33, 29), (14, 16, 13)), [(diamond, RED), (word, PAPER), (printer, RED)])
    dark = compose(gradient((18, 19, 17), (6, 7, 6)), [(diamond, RED), (word, PAPER), (printer, RED)])
    tinted = compose(Image.new("RGB", (N, N), (0, 0, 0)), [(ImageChops.lighter(ImageChops.lighter(diamond, word), printer), (255, 255, 255))])
    APPICON.mkdir(parents=True, exist_ok=True)
    light.save(APPICON / "AppIcon-1024.png")
    dark.save(APPICON / "AppIcon-Dark-1024.png")
    tinted.save(APPICON / "AppIcon-Tinted-1024.png")
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
