#!/bin/sh
set -euo pipefail

# Xcode Cloud runs this after cloning. The Xcode project is generated, not committed.
# Do not set build numbers here: Xcode Cloud sets CURRENT_PROJECT_VERSION from CI_BUILD_NUMBER.
if ! command -v xcodegen >/dev/null 2>&1; then
  brew install xcodegen
fi

cd "$CI_PRIMARY_REPOSITORY_PATH/ios"
xcodegen generate
