# Token Cost

Real-time token usage and running cost for every model call a Lucidos workspace
makes: chat turns, trigger fires, and coding-agent sessions alike.

## What it shows

- **Spend**, over today / 7 days / 30 days / all time, per producer.
- **Per day** stacked bars split into fresh input, cache write, cache read and output.
- **By model**, sorted by cost, with the token breakdown behind each number.
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
  recomputes each touched day in full so a rerun is idempotent.
- The app reads that rollup, then folds anything that has arrived over SSE since
  on top of it, so today's number is live rather than an hour stale.

Cost is computed in the browser from the rates in Settings, never stored. A call
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
- **Long-context premium**: the threshold, and the input and output multipliers
  applied to calls over it on a model whose id ends in `[1m]`.
- **Producer labels**, how each producer id is named in the table and the filter.

Saving writes `artifacts/token-cost/pricing.json`, so the table is
version-controlled with the rest of the workspace and still editable by hand.

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

`tests/run.sh` runs the accounting and freshness suites headless: it extracts the
app's script block and runs it against DOM and SDK stubs. No browser, no build
step, about a second. Every assertion pins a way the dashboard was actually able
to go wrong.

```
apps/token-cost/tests/run.sh
```

## Requirements

Lucidos 0.47.2 or newer. Served-model pricing reads the `served_model` field
that release adds to every model call.

## Prices

The app ships no prices. Plugin setup fills `artifacts/token-cost/pricing.json`
from each provider's official pricing page, following
`knowhow/daily-price-check.md`, and offers a daily check that writes a new dated
card when a provider changes a price. Every card names its source.

## Updating

Your `pricing.json` is never replaced. When an update changes how the rollup
sums a day, `daily.json` carries an older `rollup_version`, and the next
scheduled run rebuilds every day once. Set `TOKEN_COST_REBUILD=1` to force one
yourself.

## After install

The setup step creates the rollup trigger, seeds the prices, and offers the
daily price check. Hourly at five past is the suggested rollup cadence.
