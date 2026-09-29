#!/usr/bin/env bash
# testflight.sh — one command ships a TestFlight build (#250):
#
#   bun run mobile:release            # the whole thing
#   scripts/release/testflight.sh --dry-run   # plan + preflight, nothing builds
#
# Legs: derive build number -> prebuild -> archive -> export .ipa -> upload.
#
# Why Apple-native and not `eas build`/`eas submit`: eas-cli requires an Expo
# login for every command (verified: `eas build --local` and `eas submit
# --path` both hard-stop on "An Expo user account is required") and this org
# has no Expo credentials — the App Store Connect API key (ASC_KEY_ID /
# ASC_ISSUER_ID / ASC_KEY_P8) is what exists, so the script uses xcodebuild +
# altool. The optional tag workflow (.github/workflows/mobile-release.yml) is
# the EAS path for when Oscar adds an EXPO_TOKEN.
#
# Build number: App Store Connect is the one counter that can never collide —
# the script reads the app's newest build via the ASC API
# (scripts/release/asc-build-number.ts) and writes latest+1 into
# apps/mobile/app.json expo.ios.buildNumber before prebuild. app.json is left
# bumped (git diff shows it; nothing to hand-edit).
#
# Env:
#   ASC_KEY_ID ASC_ISSUER_ID ASC_KEY_P8   App Store Connect API key (required)
#   LILOS_ASC_APP_ID                       ASC app id (default: eas.json ascAppId)
#   LILOS_BUILD_NUMBER                     skip the ASC lookup, use this number
#   LILOS_SKIP_UPLOAD=1                    build + export only (CI/dry leg)
#   LILOS_XCARGS                           extra args appended to both xcodebuilds
#   LILOS_EXPORT_OPTIONS                   path to a custom ExportOptions.plist
#
# Signing: automatic (`-allowProvisioningUpdates` + team R8GJL3N9WX) — Xcode
# resolves the dist cert/profile using the Apple ID signed into Xcode. For a
# manual-signing run pass the pieces through LILOS_XCARGS, e.g.
#   LILOS_XCARGS="CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY='iPhone Distribution: X' PROVISIONING_PROFILE_SPECIFIER=uuid"
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
# CocoaPods (Ruby 4.0) dies on unicode_normalize without a UTF-8 locale.
export LANG=en_US.UTF-8

DRY_RUN=0
TEAM_ID="R8GJL3N9WX"
SCHEME="LilOS"
APP_JSON="apps/mobile/app.json"
DIST="apps/mobile/dist"
ASC_APP_ID="${LILOS_ASC_APP_ID:-$(bun -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).submit.production.ios.ascAppId)' apps/mobile/eas.json 2>/dev/null || echo 6816892244)}"

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --skip-upload) LILOS_SKIP_UPLOAD=1 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

banner() { echo; echo "=== $*"; }
die() { echo "FAIL: $*" >&2; exit 1; }

# --- preflight ---------------------------------------------------------------
banner "preflight"
command -v bun >/dev/null || die "bun not on PATH (see README)"
command -v xcodebuild >/dev/null || die "xcodebuild missing — install Xcode"
command -v pod >/dev/null || {
  echo "WARN: pod (CocoaPods) not on PATH — expo prebuild needs it."
  echo "      brew install cocoapods, then re-run."
  [ "$DRY_RUN" = 1 ] || die "pod missing"
}
for v in ASC_KEY_ID ASC_ISSUER_ID ASC_KEY_P8; do
  if [ -n "${!v:-}" ]; then echo "  $v: set"; else
    [ "$DRY_RUN" = 1 ] && echo "  $v: MISSING (would fail)" || die "$v is required"
  fi
done

# --- build number ------------------------------------------------------------
banner "build number"
if [ -n "${LILOS_BUILD_NUMBER:-}" ]; then
  BUILD="$LILOS_BUILD_NUMBER"
  echo "  override: $BUILD"
else
  BUILD="$(bun scripts/release/asc-build-number.ts --next)" || die "ASC lookup failed"
  LATEST="$(bun scripts/release/asc-build-number.ts --latest 2>/dev/null || echo '?')"
  echo "  ASC latest: ${LATEST}  ->  building: $BUILD"
fi
VERSION="$(bun -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).expo.version)' "$APP_JSON")"
echo "  $SCHEME $VERSION (build $BUILD)"

[ "$DRY_RUN" = 1 ] && { banner "dry-run complete — no build performed"; exit 0; }

# Stamp app.json (expo.ios.buildNumber) — sed keeps the file's formatting.
if grep -q '"buildNumber"' "$APP_JSON"; then
  sed -i '' "s/\"buildNumber\": \"[^\"]*\"/\"buildNumber\": \"$BUILD\"/" "$APP_JSON"
else
  bun -e 'const fs=require("fs"),p="'"$APP_JSON"'";const j=JSON.parse(fs.readFileSync(p,"utf8"));j.expo.ios.buildNumber="'"$BUILD"'";fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n")'
fi
VERSION="$(bun -e 'console.log(JSON.parse(require("fs").readFileSync("'"$APP_JSON"'","utf8")).expo.version)')"
echo "  $SCHEME $VERSION (build $BUILD)"


# --- prebuild + archive ------------------------------------------------------
banner "expo prebuild (ios)"
(cd apps/mobile && bunx expo prebuild --platform ios)

XCARGS=( -workspace "apps/mobile/ios/$SCHEME.xcworkspace"
  -scheme "$SCHEME" -configuration Release
  -destination "generic/platform=iOS"
  DEVELOPMENT_TEAM="$TEAM_ID" -allowProvisioningUpdates )
# shellcheck disable=SC2206 # intentional word splitting for LILOS_XCARGS
XCARGS+=( ${LILOS_XCARGS:-} )

banner "xcodebuild archive"
xcodebuild "${XCARGS[@]}" -archivePath "$DIST/LilOS.xcarchive" archive

banner "xcodebuild -exportArchive"
if [ -n "${LILOS_EXPORT_OPTIONS:-}" ]; then
  EXPORT_PLIST="$LILOS_EXPORT_OPTIONS"
else
  EXPORT_PLIST="$(mktemp -t lilos-export).plist"
  cat > "$EXPORT_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>teamID</key><string>${TEAM_ID}</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict></plist>
PLIST
fi
xcodebuild -exportArchive -archivePath "$DIST/LilOS.xcarchive" \
  -exportPath "$DIST" -exportOptionsPlist "$EXPORT_PLIST" \
  -allowProvisioningUpdates
IPA="$DIST/$SCHEME.ipa"
[ -f "$IPA" ] || die "export finished but $IPA is missing"

# --- upload ------------------------------------------------------------------
KEYFILE="$(mktemp -t asc-key).p8"
trap 'rm -f "$KEYFILE"' EXIT
printf '%s' "$ASC_KEY_P8" | sed 's/\\n/\n/g' > "$KEYFILE"
chmod 600 "$KEYFILE"

if [ "${LILOS_SKIP_UPLOAD:-0}" = 1 ]; then
  banner "LILOS_SKIP_UPLOAD — .ipa at $IPA (not uploaded)"
else
  banner "altool --upload-app"
  xcrun altool --upload-app --type ios -f "$IPA" \
    --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID" \
    --p8-file-path "$KEYFILE"
fi

banner "done"
echo "  LilOS $VERSION (build $BUILD) — $IPA"
echo "  Appears under TestFlight -> Internal Testing after ASC processing"
echo "  (usually 5-30 min; watch https://appstoreconnect.apple.com/apps/$ASC_APP_ID/testflight)."
