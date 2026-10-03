#!/usr/bin/env bash
# Builds the companion and copies its installable debug APK into ignored artifacts.
set -euo pipefail
PHONEUSE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -z "${JAVA_HOME:-}" && -x /usr/libexec/java_home ]]; then
  export JAVA_HOME="$(/usr/libexec/java_home -v 17)"
fi
export ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
if [[ ! -d "$ANDROID_HOME" ]]; then
  printf 'Android SDK not found. Set ANDROID_HOME to your SDK directory.\n' >&2
  exit 1
fi
cd "$PHONEUSE_ROOT/android"
./gradlew --console=plain :app:assembleDebug
mkdir -p "$PHONEUSE_ROOT/artifacts"
cp app/build/outputs/apk/debug/app-debug.apk "$PHONEUSE_ROOT/artifacts/PhoneUse-debug.apk"
printf '\nAPK ready: %s/artifacts/PhoneUse-debug.apk\n' "$PHONEUSE_ROOT"
