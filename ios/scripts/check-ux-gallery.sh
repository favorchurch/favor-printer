#!/usr/bin/env bash
# Exits non-zero unless DIR holds the nine setup-guide screenshots (non-empty) and DIR/index.html has, for each, a
# <figure> containing <img src="<state>.png"> and a non-empty <figcaption>.
#
#   bash ios/scripts/check-ux-gallery.sh DIR
set -euo pipefail

[ $# -eq 1 ] || { echo "usage: $0 DIR" >&2; exit 2; }

states=(
  onboarding-welcome driver-not-running printer-not-seen enrollment-help guided-access
  background-on background-interrupted status-ready status-needs-attention
)

python3 -I - "$1" "${states[@]}" <<'PY'
import sys
from html.parser import HTMLParser
from pathlib import Path

directory, states = Path(sys.argv[1]), sys.argv[2:]
problems = []


class Gallery(HTMLParser):
    def __init__(self):
        super().__init__()
        self.figures = []
        self.open = None
        self.in_caption = False

    def handle_starttag(self, tag, attrs):
        if tag == "figure":
            self.open = {"imgs": [], "caption": ""}
        elif self.open is not None and tag == "img":
            self.open["imgs"].append(dict(attrs).get("src"))
        elif self.open is not None and tag == "figcaption":
            self.in_caption = True

    def handle_endtag(self, tag):
        if tag == "figcaption":
            self.in_caption = False
        elif tag == "figure" and self.open is not None:
            self.figures.append(self.open)
            self.open = None

    def handle_data(self, data):
        if self.in_caption:
            self.open["caption"] += data


index = directory / "index.html"
gallery = Gallery()
if index.is_file():
    gallery.feed(index.read_text())
else:
    problems.append(f"{index} is missing")

for state in states:
    png = directory / f"{state}.png"
    if not png.is_file() or png.stat().st_size == 0:
        problems.append(f"{png} is missing or empty")
    if not any(f["imgs"][:1] == [f"{state}.png"] and f["caption"].strip() for f in gallery.figures):
        problems.append(f'index.html has no figure with img src="{state}.png" first and a non-empty figcaption')

if problems:
    print("\n".join(problems), file=sys.stderr)
    raise SystemExit(1)
print(f"{directory}: {len(states)} states, gallery complete")
PY
