#!/usr/bin/env bash
# Issue #44: reproducible wall-clock baseline for the three HostStatusUITests.
# Requires a Mac with Xcode, XcodeGen and an installed iPad simulator.
# Never signs or uploads an app, changes provisioning or talks to production.
set -euo pipefail

cd "$(dirname "$0")/.."
if ! command -v xcodebuild >/dev/null 2>&1 || ! command -v xcodegen >/dev/null 2>&1; then
  echo "ERROR: Xcode and XcodeGen on macOS are required for iPad UI-test profiling" >&2
  exit 2
fi

destination="${FAVOR_UI_TEST_DESTINATION:-platform=iOS Simulator,name=iPad Air 13-inch (M4)}"
output="${FAVOR_UI_TEST_OUTPUT:-$PWD/.ui-test-profile}"
mkdir -p "$output"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
log="$output/host-status-$timestamp.log"
results="$output/host-status-$timestamp.xcresult"
start="$(date +%s)"

xcodegen generate >/dev/null
echo "Profiling HostStatusUITests, destination: $destination"
echo "Result bundle: $results"
set +e
xcodebuild test \
  -scheme FavorPrinter \
  -destination "$destination" \
  -only-testing:FavorPrinterUITests/HostStatusUITests \
  -resultBundlePath "$results" \
  2>&1 | tee "$log"
test_exit=${PIPESTATUS[0]}
set -e

elapsed="$(( $(date +%s) - start ))"
echo "host-status wall_seconds=$elapsed exit_code=$test_exit"
grep -E 'Test Case .*HostStatusUITests.*(started|passed|failed)|Executed [0-9]+ tests' "$log" || true
printf '%s,%s,%s,%s\n' "$timestamp" "$elapsed" "$test_exit" "$results" >> "$output/history.csv"
if [ "$elapsed" -gt 120 ]; then
  echo "NOTICE: HostStatusUITests exceed the target of 120s; investigate xcresult and startup/step durations." >&2
fi
echo "No physical Zebra print, Apple signing or TestFlight behavior is exercised."
exit "$test_exit"
