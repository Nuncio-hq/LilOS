#!/usr/bin/env bash
# Issue #246: launch the real app for a manual look at the adopted prototype
# theme — one glass window floating on the slow colour field (engine-fake,
# fresh throwaway state; nothing to configure).
#
#   bash scripts/live/246.sh
#
# In the browser tab the app floats on the colour field. For the desktop
# frame (no wallpaper, no margin — the OS window is the frame, #232) run
# `bun run app:local` instead.
set -eu
cd "$(dirname "$0")/../.."
export PATH="$HOME/.bun/bin:$PATH"

URL="http://localhost:${LILOS_WEB_PORT:-5200}"
echo "LilOS dev stack → $URL (engine-fake)"
( sleep 3 && open "$URL" ) &
exec bun apps/web/dev/stack.ts
