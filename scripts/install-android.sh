#!/usr/bin/env bash
# Installs the existing debug APK on an explicitly selected ADB device.
set -euo pipefail
PHONEUSE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ ! -f "$PHONEUSE_ROOT/artifacts/PhoneUse-debug.apk" ]]; then
  printf 'Build the APK first with npm run android:build.\n' >&2
  exit 1
fi
PHONEUSE_ADB="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}/platform-tools/adb"
if [[ ! -x "$PHONEUSE_ADB" ]]; then PHONEUSE_ADB="adb"; fi
if [[ $# -ne 1 ]]; then
  printf 'Usage: npm run android:install -- <device-serial>\n' >&2
  "$PHONEUSE_ADB" devices -l
  exit 1
fi
"$PHONEUSE_ADB" -s "$1" install -r "$PHONEUSE_ROOT/artifacts/PhoneUse-debug.apk"
