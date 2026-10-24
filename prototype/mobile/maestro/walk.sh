#!/bin/bash
# Runs the v3 walks (v3-walk.yaml, then v3-walk-work-company.yaml) in light and
# dark on one simulator and gathers the screenshots flat in /tmp/820b as
# light-NN-name.png / dark-NN-name.png.
#   prototype/mobile/maestro/walk.sh <udid> [light|dark]   (both by default)
set -e
D=${1:?simulator udid}
export JAVA_HOME=${JAVA_HOME:-/opt/homebrew/opt/openjdk@21}
export PATH=$JAVA_HOME/bin:$PATH
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=/tmp/820b
mkdir -p "$OUT"
THEMES=${2:-"light dark"}
for THEME in $THEMES; do
  xcrun simctl ui "$D" appearance $THEME
  RUN=$OUT/run-$THEME
  rm -rf "$RUN"
  maestro --device "$D" test --test-output-dir="$RUN" -e THEME=$THEME "$HERE"/v3-walk.yaml "$HERE"/v3-walk-work-company.yaml
  find "$RUN" -path '*takeScreenshot/*.png' -exec cp {} "$OUT"/ \;
done
xcrun simctl ui "$D" appearance light
