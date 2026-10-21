# Token Cost

See what your workspace spends on AI, live. Every model call the workspace makes is counted and priced as it lands: chat turns, coding agents, triggers, voice and images.

## What you get

- **The Token Cost app.** A dashboard with the running spend for the range you pick (presets from today to all time, or any two dates on a calendar), calls, tokens in and out, and the share served from cache. An analysis table and chart group the cost by any mix of model, type and thread. Split a model by reasoning effort, or a type into its parts: each auxiliary purpose (memory, titles, compaction...) and the cache keep-alive pings get a row of their own. Click a legend entry to filter to it. Below it you find a live list of calls as they arrive, a cost per day chart, and how large each prompt was.
- **Honest prices.** Each model has a price history. Each day is priced at the rate in force that day, and each call at the model that actually served it. A price change never reprices the past. Prices come from Lucidos's own price table, and any rate you edit in Settings is saved as your workspace override.
- **The Thread cost widget.** A small live card for the thread you have open. It shows what that thread costs, sub-threads always included: the total, today's share, the model mix and the costliest sub-threads. It fits a small, medium or large dashboard tile. One tap opens Token Cost.
- **Health in the header.** If the live stream drops, a gap opens behind it, or the rollup gets stale, the header says so.

## What it needs

- Lucidos 0.50.0 or later, with the price table.
- No API key and no account. The scripts read the workspace event store on your own machine.
- Two schedules, which setup offers to create for you: an hourly rollup for the dashboard, and an hourly snapshot for the widget.
- Prices come from Lucidos. The plugin ships none of its own. To keep them current, turn on **Keep prices current** in Settings > Intelligence.

All data stays in your workspace: usage under `artifacts/token-cost/`, and your price edits in `config/model-prices.json`.

## What to try first

1. Open the app and look at **Analysis**, grouped by model. Which model costs you the most?
2. Start a chat and watch **Live calls** fill as the agent answers.
3. Ask Lucidos to show the Thread cost widget in a thread that runs sub-threads, and watch its total grow as they work.
4. Open **Settings** to check a rate, or add a price change from the day it took effect.

## Links

- Source: https://github.com/lucidos-dev/plugins/tree/main/token-cost
- Lucidos: https://lucidos.dev
