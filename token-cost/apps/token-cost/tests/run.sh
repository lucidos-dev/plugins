#!/usr/bin/env bash
# Headless accounting and freshness tests for the Token Cost dashboard.
#
# The app is one HTML file, so these extract its <script> block and run it
# against small DOM and SDK stubs. No browser, no build step, about a second.
#
# They exist because this app's failure mode is SILENT: the numbers stay
# plausible while going stale, so nothing about the rendered page tells you it
# broke. Every assertion here pins a way that was actually possible.
#
#   accounting  a call is priced exactly once whichever path delivered it,
#               and the total does not depend on delivery order
#   freshness   a dead stream, a hole behind it, and a failing reconcile are
#               all recovered from and reported
set -euo pipefail
cd "$(dirname "$0")"
export TZ="${TZ:-Europe/Oslo}"
fail=0
for t in accounting.test.mjs freshness.test.mjs; do
  echo "== $t"
  if ! node "$t"; then fail=1; echo "   ^ $t FAILED"; fi
done
exit $fail
