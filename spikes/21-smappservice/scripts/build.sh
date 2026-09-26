#!/bin/bash
# Build LilOSSpike.app — issue #21 spike.
#
#   scripts/build.sh [APP_VERSION] [SIGN_IDENTITY]
#
# APP_VERSION:    1 or 2 (embedded in helpers + CFBundleVersion; used for the
#                app-update leg of the spike).
# SIGN_IDENTITY:  "-" (ad-hoc, default) or e.g. "Developer ID Application: ...".
set -euo pipefail

VERSION="${1:-1}"
IDENTITY="${2:--}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ROOT/build"
APP="$ROOT/dist/LilOSSpike.app"
ELECTRON_APP="$ROOT/node_modules/electron/dist/Electron.app"

if [[ ! -d "$ELECTRON_APP" ]]; then
  echo "Electron not downloaded — run 'npm install' in $ROOT first" >&2
  exit 1
fi

echo "==> compiling native helpers (version $VERSION)"
mkdir -p "$BUILD"
rm -f "$BUILD"/lilos-* "$BUILD"/smappservice-helper "$BUILD"/*_config.swift

for svc in relay harness; do
  printf 'let AGENT_NAME = "lilos-%s"\nlet SPIKE_VERSION = "%s"\n' "$svc" "$VERSION" > "$BUILD/${svc}_config.swift"
  swiftc -O -o "$BUILD/lilos-$svc" \
    -target arm64-apple-macosx13.0 \
    "$ROOT/native/agent/main.swift" "$BUILD/${svc}_config.swift"
done

swiftc -O -o "$BUILD/smappservice-helper" \
  -target arm64-apple-macosx13.0 \
  "$ROOT/native/helper/main.swift"

echo "==> assembling LilOSSpike.app from $ELECTRON_APP"
rm -rf "$APP"
mkdir -p "$ROOT/dist"
cp -R "$ELECTRON_APP" "$APP"

# App identity
/usr/libexec/PlistBuddy -c "Set :CFBundleName LilOSSpike" "$APP/Contents/Info.plist" \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleName string LilOSSpike" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string LilOSSpike" "$APP/Contents/Info.plist" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName LilOSSpike" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.nuncio.lilos.spike" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString 1.0.$VERSION" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $VERSION" "$APP/Contents/Info.plist"

# App payload: Electron loads Contents/Resources/app/package.json
rm -rf "$APP/Contents/Resources/app"
mkdir -p "$APP/Contents/Resources/app"
cp -R "$ROOT/src" "$APP/Contents/Resources/app/src"
printf '{"name":"lilos-smappservice-spike","version":"1.0.%s","main":"src/main.js"}\n' "$VERSION" \
  > "$APP/Contents/Resources/app/package.json"

# Launch agents: plists in Contents/Library/LaunchAgents, binaries in Contents/MacOS
mkdir -p "$APP/Contents/Library/LaunchAgents"
cp "$ROOT/launchagents/"*.plist "$APP/Contents/Library/LaunchAgents/"
cp "$BUILD/lilos-relay" "$BUILD/lilos-harness" "$BUILD/smappservice-helper" "$APP/Contents/MacOS/"
chmod +x "$APP/Contents/MacOS/lilos-relay" "$APP/Contents/MacOS/lilos-harness" "$APP/Contents/MacOS/smappservice-helper"

echo "==> signing ($([ "$IDENTITY" = "-" ] && echo 'ad-hoc' || echo "$IDENTITY"))"
if [[ "$IDENTITY" = "-" ]]; then
  codesign --force --deep --sign - "$APP"
else
  codesign --force --options runtime --timestamp --deep --sign "$IDENTITY" "$APP"
fi

echo "==> verify"
codesign --verify --deep --strict --verbose=2 "$APP" 2>&1
codesign -dv --verbose=2 "$APP" 2>&1 | grep -E "Identifier|Signature|TeamIdentifier" || true
echo "==> done: $APP"
