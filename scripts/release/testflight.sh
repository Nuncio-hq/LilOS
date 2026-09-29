#!/usr/bin/env bash
# testflight.sh — one command ships a TestFlight build (#250, hardened #268):
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
# Signing: automatic (`-allowProvisioningUpdates` + team R8GJL3N9WX). The ASC
# API key is also passed to xcodebuild as -authenticationKeyPath/-authenticationKeyID/
# -authenticationKeyIssuerID, so provisioning works on a VM with NO Apple ID
# signed into Xcode (an Apple ID signed in works too — the API key just takes
# over auth). The .p8 is written to a chmod-600 temp file and trap-cleaned.
# For a manual-signing run pass the pieces through LILOS_XCARGS, e.g.
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
    -h|--help) sed -n '2,38p' "$0"; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

banner() { echo; echo "=== $*"; }
die() { echo "FAIL: $*" >&2; exit 1; }
# miss <problem> <remedy>: WARN in --dry-run (keep reporting the rest of the
# checklist), FAIL with the exact fix in a real run.
miss() {
  if [ "$DRY_RUN" = 1 ]; then
    echo "  WARN: $1 — fix: $2"
  else
    die "$1 — fix: $2"
  fi
}

KEYFILE=""
GEN_PLIST=""
cleanup() {
  [ -z "$KEYFILE" ] || rm -f "$KEYFILE"
  [ -z "$GEN_PLIST" ] || rm -f "$GEN_PLIST"
}
trap cleanup EXIT

# --- preflight ---------------------------------------------------------------
# Dry-run reports every gap at once; a real run stops at the first.
banner "preflight"
command -v bun >/dev/null ||
  miss "bun not on PATH" "npm i -g bun  (or: curl -fsSL https://bun.sh/install | bash)"
[ -f apps/mobile/package.json ] ||
  miss "apps/mobile missing — run from a full clone" "git clone https://github.com/Nuncio-hq/LilOS.git"
[ -d node_modules ] ||
  miss "dependencies not installed" "bun install"
command -v xcodebuild >/dev/null ||
  miss "xcodebuild missing" "install Xcode from the App Store, then: sudo xcodebuild -license accept"
# Xcode's iOS platform component downloads separately — a bare VM can have
# xcodebuild yet no iphoneos SDK, and the archive dies with "Unable to find a
# destination matching generic/platform=iOS". -showsdks lists only what the
# active Xcode actually has.
if command -v xcodebuild >/dev/null; then
  IOS_SDKS="$(xcodebuild -showsdks 2>/dev/null || true)"
  if [[ "$IOS_SDKS" != *iphoneos* ]]; then
    if [ "$DRY_RUN" = 1 ]; then
      miss "no iphoneos platform for the active Xcode" "xcodebuild -downloadPlatform iOS"
    else
      echo "  iOS platform component missing — downloading it (several GB): xcodebuild -downloadPlatform iOS"
      xcodebuild -downloadPlatform iOS || die "xcodebuild -downloadPlatform iOS failed"
      IOS_SDKS="$(xcodebuild -showsdks 2>/dev/null || true)"
      [[ "$IOS_SDKS" == *iphoneos* ]] ||
        die "iphoneos SDK still missing after 'xcodebuild -downloadPlatform iOS'"
    fi
  fi
fi
# Archives built against the iOS 27+ SDK are killed at launch until UIScene
# lifecycle adoption lands (#275). A release must build on Xcode 26.x — point
# xcode-select/DEVELOPER_DIR at a 26.x install so xcrun resolves that SDK.
if command -v xcrun >/dev/null; then
  IOS_SDK="$(xcrun --sdk iphoneos --show-sdk-version 2>/dev/null || true)"
  case "${IOS_SDK%%.*}" in
    ''|*[!0-9]*) echo "  iphoneos SDK: ${IOS_SDK:-unreadable — continuing}" ;;
    *)
      if [ "${IOS_SDK%%.*}" -ge 27 ]; then
        miss "iOS SDK $IOS_SDK: iOS 27 SDK builds crash on launch until UIScene lifecycle adoption lands — see issue #275" \
          "build on Xcode 26.x (sudo xcode-select -s /Applications/Xcode-26.x.app) or pass an SDK path override (DEVELOPER_DIR=/Applications/Xcode-26.x.app/Contents/Developer)"
      else
        echo "  iphoneos SDK: $IOS_SDK"
      fi ;;
  esac
fi
if ! command -v pod >/dev/null; then
  if [ "$DRY_RUN" != 1 ] && command -v brew >/dev/null; then
    # brew's cocoapods (1.17.x) ships its own Ruby — no unicode_normalize patch.
    echo "  pod missing — auto-installing: brew install cocoapods"
    brew install cocoapods || die "brew install cocoapods failed"
    command -v pod >/dev/null || die "pod still not on PATH after 'brew install cocoapods'"
  else
    miss "pod (CocoaPods) not on PATH" "brew install cocoapods"
  fi
fi
for v in ASC_KEY_ID ASC_ISSUER_ID ASC_KEY_P8; do
  if [ -n "${!v:-}" ]; then echo "  $v: set"; else
    miss "$v is required" "export $v=<App Store Connect API key>"
  fi
done

# --- xcodebuild auth ---------------------------------------------------------
# The ASC API key doubles as xcodebuild signing auth, so a VM with no Apple ID
# signed into Xcode still provisions automatically (#268). The .p8 lands in a
# chmod-600 temp file; the same file feeds altool below.
XCAUTH=()
if [ -n "${ASC_KEY_ID:-}" ] && [ -n "${ASC_ISSUER_ID:-}" ] && [ -n "${ASC_KEY_P8:-}" ]; then
  KEYFILE="$(mktemp "${TMPDIR:-/tmp}/lilos-asc.XXXXXX")"
  printf '%s' "$ASC_KEY_P8" | sed 's/\\n/\n/g' > "$KEYFILE"
  chmod 600 "$KEYFILE"
  XCAUTH=( -authenticationKeyPath "$KEYFILE"
    -authenticationKeyID "$ASC_KEY_ID"
    -authenticationKeyIssuerID "$ASC_ISSUER_ID" )
  echo "  signing auth: ASC API key $ASC_KEY_ID (no Xcode Apple ID needed)"
else
  echo "  signing auth: Xcode Apple ID only (ASC key unset)"
fi

# Shared by BOTH xcodebuilds — archive and -exportArchive (export used to get
# none of these, #268). LILOS_XCARGS is intentionally word-split.
XCARGS=( -allowProvisioningUpdates ${XCAUTH[@]+"${XCAUTH[@]}"} )
# shellcheck disable=SC2206 # intentional word splitting for LILOS_XCARGS
XCARGS+=( ${LILOS_XCARGS:-} )

ARCHIVE_XCARGS=( -workspace "apps/mobile/ios/$SCHEME.xcworkspace"
  -scheme "$SCHEME" -configuration Release
  -destination "generic/platform=iOS" DEVELOPMENT_TEAM="$TEAM_ID"
  "${XCARGS[@]}" -archivePath "$DIST/LilOS.xcarchive" archive )

if [ -n "${LILOS_EXPORT_OPTIONS:-}" ]; then
  EXPORT_PLIST="$LILOS_EXPORT_OPTIONS"
else
  GEN_PLIST="$(mktemp "${TMPDIR:-/tmp}/lilos-export.XXXXXX")"
  cat > "$GEN_PLIST" <<PLIST
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
  EXPORT_PLIST="$GEN_PLIST"
fi

EXPORT_XCARGS=( -exportArchive -archivePath "$DIST/LilOS.xcarchive"
  -exportPath "$DIST" -exportOptionsPlist "$EXPORT_PLIST" "${XCARGS[@]}" )

# --- build number ------------------------------------------------------------
banner "build number"
if [ -n "${LILOS_BUILD_NUMBER:-}" ]; then
  BUILD="$LILOS_BUILD_NUMBER"
  echo "  override: $BUILD"
elif ! BUILD="$(bun scripts/release/asc-build-number.ts --next 2>/dev/null)"; then
  if [ "$DRY_RUN" = 1 ]; then
    BUILD="?"; echo "  ASC lookup failed — dry-run continues without it"
  else
    die "ASC lookup failed"
  fi
else
  LATEST="$(bun scripts/release/asc-build-number.ts --latest 2>/dev/null || echo '?')"
  echo "  ASC latest: ${LATEST}  ->  building: $BUILD"
fi
VERSION="$(bun -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).expo.version)' "$APP_JSON" 2>/dev/null || echo '?')"
echo "  $SCHEME $VERSION (build $BUILD)"

[ "$DRY_RUN" = 1 ] && {
  banner "plan"
  printf '  xcodebuild'; printf ' %q' "${ARCHIVE_XCARGS[@]}"; echo
  printf '  xcodebuild'; printf ' %q' "${EXPORT_XCARGS[@]}"; echo
  banner "dry-run complete — no build performed"; exit 0
}

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

banner "xcodebuild archive"
xcodebuild "${ARCHIVE_XCARGS[@]}"

banner "xcodebuild -exportArchive"
xcodebuild "${EXPORT_XCARGS[@]}"
IPA="$DIST/$SCHEME.ipa"
[ -f "$IPA" ] || die "export finished but $IPA is missing"

# --- upload ------------------------------------------------------------------
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
