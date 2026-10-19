# HostStatusUITests performance evidence — #44

The F5/F9/F6 printer state defects were addressed in merged PR #56. The remaining issue is an **observed slow XCUITest run** (reported ~1068 seconds for three tests). That timing must be reproduced on a Mac/Xcode simulator and measured after optimizations; Linux-only unit suites cannot prove an XCUITest performance improvement.

Run:

```sh
cd ios
FAVOR_UI_TEST_DESTINATION='platform=iOS Simulator,name=iPad Air 13-inch (M4)' scripts/profile-host-ui-tests.sh
```

This exercises **only** `HostStatusUITests` with Debug fake relay/transport and records a dated log, `.xcresult` bundle and `history.csv` in `ios/.ui-test-profile`. Compare the duration for the **same** simulator, Xcode, hardware, test subset and clean/warm boot state; investigate the trace rather than disabling assertions or swallowing tests. Target: **under 120 seconds**, without reduced coverage. It does not run on Linux, sign/release a build or print to a real Zebra.

The harness changes no production behavior. Keep #44 open until actual after-change timing and three Xcode-hosted test results are attached.
