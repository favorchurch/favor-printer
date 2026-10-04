#!/bin/bash
# Smoke test for packaged Favor Printer.app:
# Checks bundle ID, version, codesign/spctl status (reports unsigned honestly),
# relay.js presence, and runs the packaged binary with --self-test-relay against
# a loopback stub cloud.
#
#   bash scripts/smoke-packaged.sh [path/to/Favor\ Printer.app]

set -uo pipefail

APP="${1:-}"
if [ -z "$APP" ]; then
  for candidate in \
    "release/mac/Favor Printer.app" \
    "release/mac-arm64/Favor Printer.app" \
    "release/mac-x64/Favor Printer.app" \
    "/Applications/Favor Printer.app"; do
    if [ -d "$candidate" ]; then
      APP="$candidate"
      break
    fi
  done
  if [ -z "$APP" ]; then
    APP="$(find release -name "Favor Printer.app" -type d 2>/dev/null | head -1)"
  fi
fi

if [ -z "$APP" ] || [ ! -d "$APP" ]; then
  echo "FAIL: Favor Printer.app not found. Provide path as first argument: $0 <path/to/Favor Printer.app>" >&2
  exit 1
fi

echo "== checking packaged app: $APP"

INFO_PLIST="$APP/Contents/Info.plist"
if [ ! -f "$INFO_PLIST" ]; then
  echo "FAIL: Info.plist not found at $INFO_PLIST" >&2
  exit 1
fi

EXECUTABLE_NAME="$(plutil -extract CFBundleExecutable raw "$INFO_PLIST" 2>/dev/null || echo "Favor Printer")"
BINARY="$APP/Contents/MacOS/$EXECUTABLE_NAME"
if [ ! -x "$BINARY" ]; then
  echo "FAIL: Executable binary not found at $BINARY" >&2
  exit 1
fi

PASS=0
FAIL=0

check() {
  local desc="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    PASS=$((PASS + 1))
    echo "ok   $desc"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL $desc"
  fi
}

# 1. Bundle ID
BUNDLE_ID="$(plutil -extract CFBundleIdentifier raw "$INFO_PLIST" 2>/dev/null || true)"
echo "CFBundleIdentifier: $BUNDLE_ID"
check "bundle id is church.favor.printer" test "$BUNDLE_ID" = "church.favor.printer"

# 2. Version
VERSION="$(plutil -extract CFBundleShortVersionString raw "$INFO_PLIST" 2>/dev/null || true)"
echo "CFBundleShortVersionString: $VERSION"
check "version string is present" test -n "$VERSION"

# 3. codesign / spctl status (reports unsigned honestly)
echo "== codesign / spctl status"
SIGNATURE_OUT="$(codesign -dv --verbose=4 "$APP" 2>&1 || true)"
echo "$SIGNATURE_OUT" | grep -E "Authority|Signature|TeamIdentifier|Identifier" || true

if codesign --verify --deep --strict "$APP" >/dev/null 2>&1; then
  echo "codesign: valid signature"
else
  echo "codesign: unsigned or invalid signature (honest report: expected for unsigned/PR builds)"
fi

SPCTL_OUT="$(spctl -a -vv -t execute "$APP" 2>&1 || true)"
echo "spctl status: $SPCTL_OUT"

# 4. relay.js present
echo "== verifying relay.js is present"
RELAY_PRESENT=false
ASAR_FILE="$APP/Contents/Resources/app.asar"
UNPACKED_RELAY="$APP/Contents/Resources/app/dist/relay.js"

if [ -f "$UNPACKED_RELAY" ]; then
  RELAY_PRESENT=true
  echo "relay.js found at $UNPACKED_RELAY"
elif [ -f "$ASAR_FILE" ]; then
  if ELECTRON_RUN_AS_NODE=1 "$BINARY" -e '
    const fs = require("node:fs");
    const target = process.argv[1];
    if (fs.existsSync(target)) process.exit(0);
    process.exit(1);
  ' "$ASAR_FILE/dist/relay.js" 2>/dev/null; then
    RELAY_PRESENT=true
    echo "relay.js confirmed present inside app.asar (dist/relay.js) via Electron runtime"
  elif grep -a -q "dist/relay.js" "$ASAR_FILE" 2>/dev/null; then
    RELAY_PRESENT=true
    echo "relay.js entry detected in app.asar archive header"
  fi
fi

check "relay.js is present in the packaged app" test "$RELAY_PRESENT" = "true"

# 5. Start loopback stub cloud and run binary with --self-test-relay
echo "== testing --self-test-relay against loopback stub cloud"

TMP_DIR="$(mktemp -d)"
PORT_FILE="$TMP_DIR/port.txt"
CLOUD_LOG="$TMP_DIR/stub-cloud.log"

STUB_SERVER_JS='
const http = require("node:http");
const fs = require("node:fs");

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  res.setHeader("content-type", "application/json");

  if (url.pathname === "/api/printing/relay/config") {
    res.writeHead(200);
    res.end(JSON.stringify({
      apiVersion: 1,
      relayId: "self-test-relay",
      label: "Self Test",
      printerIds: [],
      printers: []
    }));
  } else if (url.pathname === "/api/printing/relay/heartbeat") {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
  } else if (url.pathname === "/api/printing/relay/claim") {
    res.writeHead(200);
    res.end(JSON.stringify({ jobs: [] }));
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: "not_found" }));
  }
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  fs.writeFileSync(process.argv[1], String(port), "utf8");
});
'

node -e "$STUB_SERVER_JS" "$PORT_FILE" >"$CLOUD_LOG" 2>&1 &
STUB_PID=$!

cleanup() {
  if [ -n "${STUB_PID:-}" ] && kill -0 "$STUB_PID" 2>/dev/null; then
    kill "$STUB_PID" 2>/dev/null || true
    wait "$STUB_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

# Wait for stub server to write its port
for _ in $(seq 1 50); do
  if [ -s "$PORT_FILE" ]; then
    break
  fi
  sleep 0.1
done

if [ ! -s "$PORT_FILE" ]; then
  echo "FAIL: Stub cloud failed to start on loopback" >&2
  cat "$CLOUD_LOG" >&2
  exit 1
fi

STUB_PORT="$(cat "$PORT_FILE")"
echo "loopback stub cloud listening on port $STUB_PORT"

SELF_TEST_OUT="$("$BINARY" "--self-test-relay=http://127.0.0.1:$STUB_PORT" 2>&1)"
SELF_TEST_EXIT=$?

echo "binary output: $SELF_TEST_OUT"
check "binary exited with 0" test "$SELF_TEST_EXIT" -eq 0

# Verify the JSON line from the utilityProcess self-test
RESULT_LINE="$(echo "$SELF_TEST_OUT" | grep '{"type":"self-test"' | head -1 || true)"
check "self-test emitted json result line" test -n "$RESULT_LINE"

if [ -n "$RESULT_LINE" ]; then
  IS_OK="$(node -e 'const r = JSON.parse(process.argv[1]); console.log(r.ok === true && r.running === true && r.cloud === "ok" && r.stopOutcome === "stopped");' "$RESULT_LINE" 2>/dev/null || echo "false")"
  check "self-test JSON shows running+cloud ok and stopped via utilityProcess" test "$IS_OK" = "true"
else
  FAIL=$((FAIL + 1))
  echo "FAIL: self-test JSON missing or malformed"
fi

echo ""
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
