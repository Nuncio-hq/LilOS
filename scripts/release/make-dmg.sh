#!/usr/bin/env bash
# make-dmg.sh <path-to.app> <out.dmg> — pack LilOS.app into a distributable
# DMG (app + /Applications drop link). Used by sign-local.sh and CI.
set -euo pipefail

APP="${1:?usage: make-dmg.sh <app> <out.dmg>}"
OUT="${2:?usage: make-dmg.sh <app> <out.dmg>}"
VOLNAME="${3:-LilOS}"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
ditto "$APP" "$STAGE/$(basename "$APP")"
ln -s /Applications "$STAGE/Applications"

rm -f "$OUT"
hdiutil create -volname "$VOLNAME" -srcfolder "$STAGE" -ov -format UDZO "$OUT" >/dev/null
echo "$OUT"
