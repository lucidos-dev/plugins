#!/usr/bin/env bash
# Headless tests for the Token Cost dashboard, the Thread cost widget and
# the plugin's scripts.
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
#   save        a price edit lands in the override (config/model-prices.json),
#               never the shipped cards; an edit typed mid-save is still
#               written; a save never writes a stale file over a newer one,
#               nor over an override Lucidos ignores
#   defaults    the app carries no prices of its own (Lucidos's price table
#               is the only table), and the app plays no sound
#   markup      rate badges use the shared .label tones, and every :hover
#               rule sits inside @media (hover: hover)
#   upgrade     an update from 0.4.4: before the migration the unpriced calls
#               are named; after it the dashboard prices them at 0.4.4's
#               rates and sources, and Settings says what moved and what not
#   thread-cost the Thread cost widget prices a moved 0.4.4 card live, and
#               says how many calls its total leaves out
#   rollup      the daily rollup splits long context at the same dated card
#               the app prices with (python3, SQL run in sqlite, no Postgres),
#               and moves 0.4.x prices into the price table before it reads it
#   migrate     the 0.4.x pricing.json cards the price table does not price
#               move into config/model-prices.json unchanged, once, through
#               the engine's write path; nothing is lost, invented or dropped
#               silently, and the legacy file is never written (python3,
#               against fake_lucidos.py, which merges like the engine)
#   snapshot    the Thread cost snapshot migrates first, and counts the calls
#               it cannot price instead of folding them in as $0
#
# The app tests price from tests/fixtures/price-table.json: the table as
# lucidos.priceTable.get() returns it, the cards Lucidos shipped on 2026-10-16
# merged with a migrated workspace override.
set -euo pipefail
cd "$(dirname "$0")"
export TZ="${TZ:-Europe/Oslo}"
fail=0
for t in accounting.test.mjs freshness.test.mjs save.test.mjs defaults.test.mjs markup.test.mjs upgrade.test.mjs thread-cost.test.mjs; do
  echo "== $t"
  if ! node "$t"; then fail=1; echo "   ^ $t FAILED"; fi
done
for t in rollup.test.py cache.test.py migrate.test.py snapshot.test.py; do
  echo "== $t"
  if ! python3 "$t"; then fail=1; echo "   ^ $t FAILED"; fi
done
exit $fail
