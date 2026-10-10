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
#               the total does not depend on delivery order, and each day is
#               priced at the card in force that day
#   freshness   a dead stream, a hole behind it, and a failing reconcile are
#               all recovered from and reported
#   save        an edit typed mid-save is still written, and a save never
#               writes a stale table over a newer pricing.json
#   defaults    the app carries no prices of its own (pricing.json is the
#               only table), and the built-in sounds play without a fetch
#               the frame is refused
#   rollup      the daily rollup splits long context at the same dated card
#               the app prices with (python3, SQL run in sqlite, no Postgres)
set -euo pipefail
cd "$(dirname "$0")"
export TZ="${TZ:-Europe/Oslo}"
fail=0
for t in accounting.test.mjs freshness.test.mjs save.test.mjs defaults-and-sounds.test.mjs; do
  echo "== $t"
  if ! node "$t"; then fail=1; echo "   ^ $t FAILED"; fi
done
echo "== rollup.test.py"
if ! python3 rollup.test.py; then fail=1; echo "   ^ rollup.test.py FAILED"; fi
exit $fail
