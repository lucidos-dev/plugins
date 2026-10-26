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
  Lucidos is marked. Each recorded agent session has its own row, time span,
  peak context and keep-alive line. Click a legend entry or donut slice to filter
  the chart and table; ranges over 31 days use weekly bars.
- **Handoffs**, grouped by checkpoint: narrative cost, calls before and after,
  warm or cold openings, and whether the recorded verdict held.
- **Context size per call**, the histogram that tells you where a long-context
  premium is actually biting.
- **Live calls**, streamed over SSE as they land, including calls from other
  threads and agents running right now.

## How it works

Every real model call the engine makes emits a `ContextCaptured` event carrying
the provider's own `usage` block. These parts read it:

- `scripts/rollup.py` folds those events into a per-day, per-model rollup at
  `artifacts/token-cost/daily.json`. It is incremental: it resumes from the
  `last_sequence` recorded in the file and only reads rows above it, then
  recomputes each touched day in full so a rerun is idempotent. The same pass
  writes per-session thread rows and spans to `artifacts/token-cost/threads-daily.json`
  and checkpoint comparisons to `artifacts/token-cost/handoffs.json`.
- The same trigger writes `artifacts/token-cost/cache.json`, a separate,
  versioned projection of cache evidence, without prompts or stored prices.
  It rebuilds from ordered events, including on runs with no new usage, so
  status-only changes and upgrades from older snapshots are covered.
- The app reads that rollup, then folds anything that has arrived over SSE since
  on top of it, so today's number is live rather than an hour stale. A capped
  first paint marks its total as catching up until that tail finishes.
  There is no Refresh button: the app reconciles automatically.
- `scripts/token-cost/thread_costs.py` writes the full widget snapshot and
  `artifacts/token-cost/threads-cost-head.json` for faster first paint. The
  widget offers thread-only or inclusive scope and per-session spend.

Dashboard cost is computed in the browser from Lucidos's price table;
the widget snapshot stores priced totals for its first paint. A call
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

## Cache and keep-alive

The three views share the dashboard's range, type filter, currency and Group
by chips. Each row includes its day and model. They load on opening **Cache
and keep-alive**, use responsive rows at phone width, and state their rollup
timestamp separately from the live dashboard totals. Missing or older files
show an unavailable state until the next rollup; the existing daily and
Thread cost snapshot formats are unchanged. No setup revision is needed.

- **Keep-alive cost vs savings** prices actual ping input, output and cache
  usage. A resume ping is identified by its `PromptInjected` anchor's
  `origin.reason.kind = cache_keep_alive`; copy beats use
  `ContextCaptured.purpose = cache_keep_alive`. Avoided rewrite spend uses
  `CacheKeepAliveStatusChanged.status` only when an `ended` run has a
  recorded `saved_usd`, context tokens, a matching wake that read the whole
  context and a full prior write with an evidenced single lifetime. A partial
  write cannot establish a lifetime for the whole retained context.
  The engine's dollars are evidence of a saved
  rewrite, never a price source. Tokens are repriced from the app's dated
  price table. This is gross avoided rewrite spend, before ping costs;
  unknown runs have no estimated savings. Ping costs use their billing day;
  savings use the local day the wait ended.
- **Cache write vs read spend** separates write, read and uncached input
  dollars per day. Input is a total containing the cache counts, so uncached
  input subtracts both. Writes use reported 5-minute, 30-minute, 1-hour and
  12-hour splits, or a recorded supported requested TTL. Dated, served-model,
  long-context and Flex price cards apply. Missing TTL evidence leaves a
  premium write price unknown; unpriced amounts carry an unknown count.
- **Cache rewrites by cause** counts calls with cache writes. Only cold
  writes with prior context and exactly one supported cause are classified:
  a recorded handoff boundary, a changed served model, or a request-start
  gap longer than the evidenced TTL after the last refresh in the same
  model and session. With mixed lifetimes, every part must have expired.
  First writes, partial writes, unrecorded boundaries and ambiguous causes
  count as unknown. The count includes these unclassified writes rather
  than claiming every write rewrote an existing prefix.

The source contract was read from Lucidos v0.51.0 on `main`:
`crates/lucidos-engine/src/engine/types.rs` (`ApiUsage`, `ContextPurpose`),
`engine/thread_events/keep_alive_status.rs`, `engine/cache_ttl.rs`,
`llm/cache_lifetime.rs`, and `engine/event_wait/keep_alive.rs`
(`run_end_sql`, `read_run_end`). Provider defaults are not TTL evidence.
The evidence query retains history before the selected range, so a range
boundary does not invent an expiry or hide a handoff. Claude Code frame
deduplication stays scoped to thread and session.

Lifetime pricing also applies to the existing dashboard, feed, handoff
comparisons and Thread cost widget. Rollup version 15 appends known-write,
1-hour and 12-hour token counts to each tier and to compact thread rows. It
rebuilds older rollups automatically. Calls with unknown lifetimes stay in
separate buckets, so they cannot hide other calls' priced spend or change it
when the grouping changes. A premium write without enough evidence is counted
as unpriced, with its cost excluded visibly; adding a rate cannot repair a
missing TTL. Older files still read, with unknown write evidence.

New widget snapshots carry `ttl_pricing: 1` and the lifetime rates for their
live tail. An older snapshot still renders, with a notice that its total may
omit premiums until the next scheduled snapshot. The widget uses the price
table for newer calls and refuses to use older compact rates to guess a write
premium. Snapshot pricing uses each dated card's own long threshold and Flex
rates, including their write lifetime prices.

## Tests

`tests/run.sh` runs the accounting, freshness, save, defaults, markup, upgrade
and Thread cost suites headless (it extracts each page's script block and runs
it against DOM and SDK stubs), then the rollup, cache evidence, price migration and snapshot
suites in Python, with SQLite standing in for Postgres and a fake `lucidos`
that merges prices the way the engine does. No browser, no build step, a few
seconds. Every assertion pins a way the dashboard was actually able
to go wrong.

```
env -u LUCIDOS_WORKSPACE apps/token-cost/tests/run.sh
```

## Requirements

Lucidos 0.51.0 or later, for stamped agent sessions and same-thread handoff
continuity. It also needs the price table: it serves `GET /api/v1/model-prices`,
`lucidos.priceTable.get()` and the `lucidos model-prices` command. On an older
engine the app shows every model as unpriced and the rollup stops with a clear
message.

## Prices

The app ships no prices. The app, the rollup and the Thread cost snapshot all
read Lucidos's price table: the dated cards Lucidos ships, merged with the
workspace override in `data/config/model-prices.json`. To check prices against
the providers' own pages, Lucidos has the system knowhow `model-price-check`.
**Keep prices current** in Settings > Intelligence runs it on a schedule.

A call no card prices is counted, kept out of every total, and named: the
dashboard says how many calls on how many models it left out, and the Thread
cost widget says "Not included: N unpriced calls" under its total.

## Prices from Token Cost 0.4

Token Cost 0.4 kept its own prices in `artifacts/token-cost/pricing.json`.
0.5.0 to 0.6.3 stopped reading that file and moved nothing over, so every
model it priced that Lucidos does not ship a card for went unpriced.

Since 0.6.4, `scripts/token-cost/migrate_prices.py` moves those cards into
`data/config/model-prices.json`. The rollup and the Thread cost snapshot run it
first on every run, so an update heals within the hour. It:

- moves a card only when the price table does not price its model on the
  card's first day, so a shipped or override card always wins;
- keeps each card as it was: source, rates, dates, long-context and Flex
  tiers, per-minute rates and any extra field;
- holds back and reports a card the engine would refuse (a negative rate, a
  bad date, two cards on one day), because one bad card makes Lucidos ignore
  the whole override; converts no currency; and never edits, moves or deletes
  the old file;
- writes through `lucidos data write` under a lock, only when the override is
  unchanged since it read it, then checks that Lucidos serves what it wrote
  and puts the previous file back if not;
- leaves out a moved card you delete from the override later.

Its report is `artifacts/token-cost/price-migration.json`, and Settings shows
it under **Model rates**, with every card that did not move and why. Run it by
hand with `--dry-run --json` to see what it would do.

## Updating

Your price override is never replaced. When an update changes how the rollup
sums a day, `daily.json` carries an older `rollup_version`, and the next
scheduled run rebuilds every day once. Set `TOKEN_COST_REBUILD=1` to force one
yourself.

## After install

The setup step creates the rollup trigger and the Thread cost snapshot, and
points you to **Keep prices current** in Settings > Intelligence. Hourly at
five past is the suggested rollup cadence.
