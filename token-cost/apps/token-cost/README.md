# Token Cost

Real-time token usage and running cost for every model call a Lucidos workspace
makes: chat turns, trigger fires, and coding-agent sessions alike.

## What it shows

- **Spend** over the range you pick: presets from today to all time (week,
  month and quarter to date among them), or any two dates on a calendar.
- **Per day** stacked bars split into fresh input, cache write, cache read and output.
- **Analysis**, one table and chart grouped by any mix of model, type and
  thread, by cost, calls, or cached against cold calls. Model splits into
  Model:effort by the reasoning effort a call named. Type folds every
  auxiliary call into one row; Type:subtype lists each auxiliary purpose
  (memory, titles, compaction...) and the cache keep-alive pings on their own.
  Sub-threads fold into their root thread, and the thread you have open in
  Lucidos is marked. Click a legend entry to filter the chart and table to it.
- **Context size per call**, the histogram that tells you where a long-context
  premium is actually biting.
- **Live calls**, streamed over SSE as they land, including calls from other
  threads and agents running right now.

## How it works

Every real model call the engine makes emits a `ContextCaptured` event carrying
the provider's own `usage` block. Two halves read it:

- `scripts/rollup.py` folds those events into a per-day, per-model rollup at
  `artifacts/token-cost/daily.json`. It is incremental: it resumes from the
  `last_sequence` recorded in the file and only reads rows above it, then
  recomputes each touched day in full so a rerun is idempotent. The same pass
  writes the per-thread rows to `artifacts/token-cost/threads-daily.json`.
- The app reads that rollup, then folds anything that has arrived over SSE since
  on top of it, so today's number is live rather than an hour stale.

Cost is computed in the browser from Lucidos's price table, never stored. A call
is priced as the model that served it, which can differ from the model asked
for when a provider reroutes a retired model; the dashboard marks those calls.
Adding a dated card changes prices from its day on and leaves the past alone.

## Settings

The **Settings** tab holds everything the dashboard prices with:

- **Model rates**, USD per 1,000,000 tokens, split into fresh input, cache write,
  cache read and output. Each model holds a list of dated cards, its price
  history, and each day is priced at the card in force that day. A model with no
  card shows as unpriced and stays out of the total: there is no fallback rate,
  because a guessed price looks exactly like a real one.
- **Currency**: the exchange rates for display, refreshed from frankfurter.dev.
- **Producer labels**, how each producer id is named in the table and the filter.

A rate you edit is written to `data/config/model-prices.json`, the workspace
override of Lucidos's price table, and never to the cards Lucidos ships.
Producer labels and exchange rates go to `artifacts/token-cost/settings.json`.
Both are version-controlled with the rest of the workspace and still editable by
hand.

## Staying honest

The dashboard's worst failure is a silent one: the numbers stay plausible while
going stale, so the rendered page tells you nothing. Three states are detected
and named in the header instead.

- **The stream dies.** The app polls the event store, recovers the calls it
  missed, and says how many it dropped.
- **A gap sits behind the rollup.** Calls that landed between the last rollup and
  page load are backfilled, including a tail from before midnight.
- **The rollup is overdue.** Said plainly, with live totals still current.

Every call is priced exactly once whichever path delivered it, rollup or stream,
and the total does not depend on the order they arrive in.

## Tests

`tests/run.sh` runs the accounting, freshness, save, defaults and markup suites
headless (it extracts the app's script block and runs it against DOM and SDK
stubs), then the rollup suite in Python with SQLite standing in for Postgres. No browser, no build
step, about a second. Every assertion pins a way the dashboard was actually able
to go wrong.

```
apps/token-cost/tests/run.sh
```

## Requirements

A Lucidos engine with the price table: it serves `GET /api/v1/model-prices`,
`lucidos.priceTable.get()` and the `lucidos model-prices` command. On an older
engine the app shows every model as unpriced and the rollup stops with a clear
message.

## Prices

The app ships no prices. The app, the rollup and the Thread cost snapshot all
read Lucidos's price table: the dated cards Lucidos ships, merged with the
workspace override in `data/config/model-prices.json`. To check prices against
the providers' own pages, Lucidos has the system knowhow `model-price-check`.
**Keep prices current** in Settings > Intelligence runs it on a schedule.

## Updating

Your price override is never replaced. When an update changes how the rollup
sums a day, `daily.json` carries an older `rollup_version`, and the next
scheduled run rebuilds every day once. Set `TOKEN_COST_REBUILD=1` to force one
yourself.

## After install

The setup step creates the rollup trigger and the Thread cost snapshot, and
points you to **Keep prices current** in Settings > Intelligence. Hourly at
five past is the suggested rollup cadence.
