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

Cost is computed in the browser from the rates in Settings, never stored. Edit a
rate and your whole history re-prices on save.

## Settings

The **Settings** tab holds everything the dashboard prices with:

- **Model rates**, USD per 1,000,000 tokens, split into fresh input, cache write,
  cache read and output. The `default` row is the fallback for any model id the
  engine reports that is not listed.
- **Long-context premium**: the threshold, and the input and output multipliers
  applied to calls over it on a model whose id ends in `[1m]`.
- **Producer labels**, how each producer id is named in the table and the filter.

Saving writes `artifacts/token-cost/pricing.json`, so the table is
version-controlled with the rest of the workspace and still editable by hand.

## After install

Ask Lucidos to set up the rollup trigger; the plugin's setup step walks it
through. Hourly at five past is the suggested default.
