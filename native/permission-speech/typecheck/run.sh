#!/usr/bin/env bash
# Type-check PermissionSpeechPlugin.swift WITHOUT a full Xcode install.
#
# Why this exists: 1.3.3 shipped a Swift file that had only been SYNTAX-checked
# (`swiftc -parse`). It failed to compile on Codemagic with
#   "overriding declaration requires an 'override' keyword"
# because CAPPlugin already declares checkPermissions:/requestPermissions:.
# A syntax check cannot catch that. This can.
#
# How: compile against the macOS SDK, which really does ship Speech.framework
# and AVFAudio — so SFSpeechRecognizer / SFSpeechURLRecognitionRequest /
# AVAudioEngine / AVAudioApplication are TYPE-CHECKED FOR REAL. Only the two
# iOS-only surfaces are stubbed (Capacitor and AVAudioSession), and those stubs
# are copied from the real Capacitor headers so collisions like the above are
# reproduced faithfully.
#
# Usage: native/permission-speech/typecheck/run.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/../ios/Sources/PermissionSpeechPlugin/PermissionSpeechPlugin.swift"
SDK="$(xcrun --sdk macosx --show-sdk-path)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# the stubs supply Capacitor's types, so drop the real import
grep -v '^import Capacitor$' "$SRC" > "$TMP/Plugin.swift"
cp "$HERE/CapacitorStubs.swift" "$TMP/Stubs.swift"

if xcrun swiftc -typecheck -target arm64-apple-macos14.0 -sdk "$SDK" \
     "$TMP/Stubs.swift" "$TMP/Plugin.swift"; then
  echo "OK — PermissionSpeechPlugin.swift type-checks."
else
  echo "FAILED — fix the errors above before pushing; Codemagic will fail too."
  exit 1
fi
