#!/usr/bin/env bash
# Issue #567 AC-3: fail CI on high/critical dependency advisories.
#
# Exceptions (--ignore) are accepted only when no fixed version is
# published AND the reachable code path is dev/build-time tooling, never
# agent-facing runtime text. Each exception is documented below with its
# reason; the workflow-hygiene unit test requires a comment per --ignore.
#
# - GHSA-vfj7-8cjw-p6xm braces<=3.0.3: stack-exhaustion DoS on deeply
#   nested glob patterns. No fix published (3.0.3 is the latest release).
#   Reachable only through build-time tools (micromatch via fast-glob,
#   metro); LilOS never feeds attacker-controlled globs to it. Revisit
#   when micromatch/fast-glob ship braces>=3.0.4.
# - GHSA-86w9-cpqp-85rv node-forge<=1.4.0: RSA PKCS#1 v1.5 signature
#   verification accepts extra nested DigestAlgorithm elements. No fix
#   published (1.4.0 is the latest release). Reachable only inside
#   @expo/cli at mobile build time; LilOS does not verify RSA signatures
#   with node-forge. Revisit on an expo/xcode bump.
#
# uuid@7 via xcode (GHSA-w5hq-g745-h8pq) is moderate — below the gate.
#
# Fixed-but-unreachable-in-range: linkify-it<=5.0.1 quadratic-DoS
# (GHSA-22p9-wv53-3rq4, GHSA-v245-v573-v5vm) renders agent output via
# ansi-to-react, which still pins ^3 — root package.json `overrides`
# forces linkify-it@^5.0.2. Drop the override when ansi-to-react bumps.
set -euo pipefail
cd "$(dirname "$0")/../.."

exec bun audit --audit-level=high \
  --ignore GHSA-vfj7-8cjw-p6xm \
  --ignore GHSA-86w9-cpqp-85rv
