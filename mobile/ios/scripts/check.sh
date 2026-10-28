#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 scripts/validate_source.py
python3 scripts/validate_redesign.py
python3 scripts/validate_feature_routes.py
python3 scripts/verify_shared_conversation_bundle.py
python3 scripts/validate_shared_conversation.py
find Claudex ClaudexTests ClaudexUITests -name '*.swift' -print0 | xargs -0 swiftc -frontend -parse
swift test "$@"
echo 'Portable checks finished. SwiftUI/Apple SDK build and UI tests still require Xcode on Mac.'

