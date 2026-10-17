#!/usr/bin/env bash
# Captures the iPad setup-guide and status screens on an iPad simulator and writes them, with an index.html gallery,
# to --out-dir (default docs/verification/ipad-ux/). Runs FavorPrinterUITests/ScreenshotUITests against the mocked
# backend (UITestBackend.swift), so no printer, relay or network is involved.
#
#   bash ios/scripts/capture-ux-screenshots.sh [--out-dir DIR]
#
# SIMULATOR_NAME overrides the device (default "iPad Air 13-inch (M4)").
set -euo pipefail

ios_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_dir="$(dirname "$ios_dir")"
out_dir="$repo_dir/docs/verification/ipad-ux"
simulator_name="${SIMULATOR_NAME:-iPad Air 13-inch (M4)}"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

while [ $# -gt 0 ]; do
  case "$1" in
    --out-dir)
      [ $# -ge 2 ] || { echo "--out-dir needs a directory" >&2; exit 2; }
      out_dir="$2"; shift 2 ;;
    *) echo "usage: $0 [--out-dir DIR]" >&2; exit 2 ;;
  esac
done

for tool in xcodegen python3 xcrun; do
  command -v "$tool" >/dev/null || { echo "$tool is required (brew install xcodegen for xcodegen)" >&2; exit 1; }
done

# state|caption, in gallery order. check-ux-gallery.sh hardcodes the same names.
states=(
  "onboarding-welcome|Setup guide, first screen. Explains that this iPad becomes the campus label printer."
  "driver-not-running|Setup guide, Printer driver. The printer is seen but the driver is off, with the Settings steps to turn it on."
  "printer-not-seen|Setup guide, Connect the printer. No printer on the cable, with the direct USB-C steps."
  "enrollment-help|Setup guide, Enroll this printer. The one-time code field and what the RSVP admin does first."
  "guided-access|Setup guide, Guided Access and Auto-Lock. Guided Access is off, with how to turn it on."
  "background-on|Setup guide, Background printing. Keep-alive is on and nothing is interrupting it."
  "background-interrupted|Setup guide, Background printing. Another app took the audio, so printing pauses in the background."
  "status-ready|Printer host status, Ready. Printer attached and driver running."
  "status-needs-attention|Printer host status, Needs attention. Printer seen but the driver is not running."
)

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

simulator_id="$(xcrun simctl list devices available -j | python3 -I -c '
import json, sys
name = sys.argv[1]
for devices in json.load(sys.stdin)["devices"].values():
    for device in devices:
        if device["name"] == name:
            print(device["udid"]); raise SystemExit
raise SystemExit("no available simulator named " + name)
' "$simulator_name")"

# Regenerated every run: the project is not committed and a stale one misses added or renamed files.
(cd "$ios_dir" && xcodegen generate --quiet)

if ! (cd "$ios_dir" && xcodebuild test -project FavorPrinter.xcodeproj -scheme FavorPrinter \
  -destination "platform=iOS Simulator,id=$simulator_id" \
  -only-testing:FavorPrinterUITests/ScreenshotUITests \
  -resultBundlePath "$work/result.xcresult" -quiet >"$work/xcodebuild.log" 2>&1); then
  grep -E "error:|Failing tests|\t[A-Za-z]+\.test" "$work/xcodebuild.log" >&2 || tail -40 "$work/xcodebuild.log" >&2
  echo "xcodebuild test failed" >&2
  exit 1
fi

xcrun xcresulttool export attachments --path "$work/result.xcresult" --output-path "$work/attachments" >/dev/null

mkdir -p "$out_dir"
python3 -I - "$work/attachments" "$out_dir" "${states[@]}" <<'PY'
import json, shutil, sys
from pathlib import Path

source, out = Path(sys.argv[1]), Path(sys.argv[2])
states = [entry.split("|", 1) for entry in sys.argv[3:]]
exported = {}
for test in json.loads((source / "manifest.json").read_text()):
    for attachment in test["attachments"]:
        name = attachment["suggestedHumanReadableName"].rsplit("_", 2)[0]
        exported[name] = source / attachment["exportedFileName"]

missing = [state for state, _ in states if state not in exported]
if missing:
    raise SystemExit("no screenshot captured for: " + ", ".join(missing))
for state, _ in states:
    shutil.copyfile(exported[state], out / f"{state}.png")

figures = "\n".join(
    f'    <figure>\n      <img src="{state}.png" alt="{caption}">\n      <figcaption><strong>{state}</strong>. {caption}</figcaption>\n    </figure>'
    for state, caption in states
)
(out / "index.html").write_text(f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Favor Printer iPad setup guide: simulator screenshots</title>
  <style>
    body {{ font: 16px/1.5 -apple-system, system-ui, sans-serif; margin: 2rem auto; max-width: 72rem; padding: 0 1rem; color: #1a1a1a; }}
    .gallery {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr)); gap: 1.5rem; }}
    figure {{ margin: 0; }}
    img {{ width: 100%; height: auto; border: 1px solid #ccc; border-radius: 6px; }}
    figcaption {{ font-size: 0.9rem; margin-top: 0.5rem; }}
  </style>
</head>
<body>
  <h1>Favor Printer iPad setup guide</h1>
  <p>iPad simulator screenshots from the mocked backend. Nothing here is verified on a real iPad. See README.md.</p>
  <main class="gallery">
{figures}
  </main>
</body>
</html>
""")
PY

echo "Wrote ${#states[@]} screenshots and index.html to $out_dir"
