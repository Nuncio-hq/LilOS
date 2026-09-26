#!/usr/bin/env bash
# make-feed.sh <app.zip> <version> <build> <download-url>
# Emits the update-feed.json document (contract: packages/contracts UpdateFeed)
# the desktop app polls. The zip is the update payload — `ditto -x -k` on the
# other side unpacks it into a staged LilOS.app.
set -euo pipefail

ZIP="${1:?zip path}"
VERSION="${2:?version e.g. 1.0.4}"
BUILD="${3:?build number}"
URL="${4:?download url}"

SHA="$(shasum -a 256 "$ZIP" | awk '{print $1}')"
SIZE="$(stat -f%z "$ZIP")"

cat <<EOF
{
  "latest": {
    "version": "$VERSION",
    "build": $BUILD,
    "url": "$URL",
    "sha256": "$SHA",
    "sizeBytes": $SIZE
  }
}
EOF
