#!/usr/bin/env bash
# sign-local.sh [BUILD] — build, sign, notarize, staple, and pack LilOS.app
# into a distributable DMG plus its auto-update payload (zip + feed JSON).
#
#   scripts/release/sign-local.sh 5
#
# One script, two modes, decided entirely by environment — no credential is
# ever written to the repo:
#
#   signed:   APPLE_SIGNING_IDENTITY + ASC_KEY_ID + ASC_ISSUER_ID + ASC_KEY_P8
#             set → Developer ID sign, notarytool submit --wait, staple.
#   unsigned: identity unset → ad-hoc ("-") build; artifacts are named
#             *-unsigned.* and every banner says "unsigned (dev)". These are
#             for local testing only and are never published.
#
# CI-only extra: APPLE_CERTIFICATES_P12 (base64 or path) +
#                APPLE_CERTIFICATES_PASSWORD imports the Developer ID cert
#                into a temporary keychain so a fresh runner can sign.
#
# Output (apps/desktop/dist/):
#   LilOS-<version>.dmg | LilOS-<version>-unsigned.dmg
#   lilos-app.zip       update payload (zipped .app)
#   update-feed.json    feed document (url = LILOS_UPDATE_ASSET_URL override)
set -euo pipefail
cd "$(dirname "$0")/../.."

BUILD="${1:-${GITHUB_RUN_NUMBER:-1}}"
VERSION="1.0.${BUILD}"
IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
DIST="apps/desktop/dist"
APP="$DIST/LilOS.app"
ZIP="$DIST/lilos-app.zip"
FEED="$DIST/update-feed.json"
SIGNED=0
[ -n "$IDENTITY" ] && SIGNED=1

banner() { echo; echo "=== $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

if [ "$SIGNED" = 0 ]; then
  banner "unsigned (dev) build"
  echo "APPLE_SIGNING_IDENTITY is not set — building an ad-hoc bundle."
  echo "This DMG is a dev artifact; it is never published."
else
  for v in ASC_KEY_ID ASC_ISSUER_ID ASC_KEY_P8; do
    [ -n "${!v:-}" ] || die "$v is required for a signed release"
  done
fi

# --- optional CI keychain ---------------------------------------------------
KEYCHAIN=""
cleanup_keychain() {
  [ -n "$KEYCHAIN" ] && security delete-keychain "$KEYCHAIN" 2>/dev/null || true
}
if [ "$SIGNED" = 1 ] && [ -n "${APPLE_CERTIFICATES_P12:-}" ]; then
  banner "importing signing certificate into a temporary keychain"
  KEYCHAIN="lilos-sign-$$.keychain-db"
  KCPASS="$(openssl rand -hex 16)"
  security create-keychain -p "$KCPASS" "$KEYCHAIN"
  security set-keychain-settings -lut 3600 "$KEYCHAIN"
  security unlock-keychain -p "$KCPASS" "$KEYCHAIN"
  P12="$(mktemp -t lilos-cert).p12"
  if [ -f "$APPLE_CERTIFICATES_P12" ]; then
    cp "$APPLE_CERTIFICATES_P12" "$P12"
  else
    echo "$APPLE_CERTIFICATES_P12" | base64 --decode > "$P12"
  fi
  security import "$P12" -k "$KEYCHAIN" \
    -P "${APPLE_CERTIFICATES_PASSWORD:?APPLE_CERTIFICATES_PASSWORD required with APPLE_CERTIFICATES_P12}" \
    -T /usr/bin/codesign -T /usr/bin/security
  rm -f "$P12"
  # let codesign use the key without a UI prompt
  security set-key-partition-list -S apple-tool:,apple:,codesign:,security: \
    -s -k "$KCPASS" "$KEYCHAIN" >/dev/null
  security list-keychains -d user -s "$KEYCHAIN" login.keychain-db
  trap cleanup_keychain EXIT
fi

# --- build ------------------------------------------------------------------
banner "build LilOS.app $VERSION"
"${BUN:-bun}" apps/desktop/scripts/build.ts "$BUILD" "${IDENTITY:--}"

# --- packaged smoke (#539) --------------------------------------------------
# Every compiled binary must actually START with the repo hidden — the
# 1.0.33..1.0.40 builds compiled fine and then crashed at startup, and CI
# stayed green because nothing ever ran the artifact.
banner "packaged smoke"
bash scripts/ci/smoke-bins.sh "$APP/Contents/MacOS"

# --- update payload (always produced; unsigned zips feed dev update tests) --
banner "pack update payload"
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"
scripts/release/make-feed.sh "$ZIP" "$VERSION" "$BUILD" \
  "${LILOS_UPDATE_ASSET_URL:-https://github.com/Nuncio-hq/LilOS/releases/latest/download/lilos-app.zip}" \
  > "$FEED"
cat "$FEED"

# --- DMG --------------------------------------------------------------------
if [ "$SIGNED" = 0 ]; then
  DMG="$DIST/LilOS-$VERSION-unsigned.dmg"
else
  DMG="$DIST/LilOS-$VERSION.dmg"
fi
banner "pack DMG"
scripts/release/make-dmg.sh "$APP" "$DMG" "LilOS $VERSION"

# --- notarize + staple (signed only) ----------------------------------------
if [ "$SIGNED" = 1 ]; then
  banner "notarize"
  P8="$(mktemp -t lilos-asc).p8"
  # %b accepts both raw and \n-escaped PEM bodies.
  printf '%b' "$ASC_KEY_P8" > "$P8"
  chmod 600 "$P8"
  NOTARY=(xcrun notarytool submit --wait --timeout 30m
    --key "$P8" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID")
  "${NOTARY[@]}" "$ZIP"
  xcrun stapler staple "$APP"
  codesign --sign "$IDENTITY" --timestamp "$DMG" || true
  "${NOTARY[@]}" "$DMG"
  xcrun stapler staple "$DMG"
  rm -f "$P8"

  banner "verify"
  codesign --verify --deep --strict --verbose=2 "$APP"
  spctl -a -vv "$APP"
  stapler validate "$DMG"
  echo "signed + notarized + stapled: $DMG"
else
  banner "unsigned (dev) result"
  echo "DMG: $DMG  — Gatekeeper will warn; right-click → Open to run it."
fi

banner "artifacts"
ls -la "$DIST"/*.dmg "$ZIP" "$FEED" 2>/dev/null || true
