#!/usr/bin/env bash
# check-mobile-release-bundle.sh — #397: the shipped JS bundle must not carry
# dev tooling. Builds apps/mobile's production bundle the same way the Xcode
# "Bundle React Native code and images" phase does (expo export:embed,
# dev=false — no Xcode needed) and fails if netspy markers survive.
#
#   scripts/ci/check-mobile-release-bundle.sh   # exit 1 + list hits on failure
#
# Plain JS output, not Hermes bytecode: what this asserts is module
# inclusion, which the resolver decides before any bytecode compile.
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"

OUT="$(mktemp -d "${TMPDIR:-/tmp}/lilos-release-bundle.XXXXXX")"
trap 'rm -rf "$OUT"' EXIT

echo "=== building apps/mobile release JS bundle (dev=false)"
(cd apps/mobile && bunx expo export:embed \
  --entry-file index.ts \
  --platform ios \
  --dev false \
  --bundle-output "$OUT/main.jsbundle" \
  --assets-dest "$OUT/assets")

# netspy is the #168 dev-only network counter; none of its identifiers may
# appear in a release bundle.
HITS="$(grep -aoE '[A-Za-z_$]*[Nn]etSpy[A-Za-z_$]*' "$OUT/main.jsbundle" | sort | uniq -c || true)"
if [ -n "$HITS" ]; then
  echo "FAIL: dev-only netspy code in the release bundle:" >&2
  echo "$HITS" >&2
  exit 1
fi
echo "=== clean: no netspy code in the release bundle"
