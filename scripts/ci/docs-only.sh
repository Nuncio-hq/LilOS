#!/usr/bin/env sh
# Exit 0 when every changed path on stdin (one per line) is docs-only, so CI
# can skip E2E for it (#201). Unit tests still read these files, so the fast
# checks always run. Any unreadable or blank input counts as code: when in
# doubt, E2E runs. If the app ever reads Markdown at runtime (templates,
# skills), narrow the pattern first.
DOCS_ONLY='(\.md$|^\.agents/|^site/|^\.github/ISSUE_TEMPLATE/)'
# -c reads all of stdin (no early exit, so no SIGPIPE upstream).
[ "$(grep -cvE "$DOCS_ONLY")" = 0 ]
