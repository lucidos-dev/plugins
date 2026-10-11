# Token Cost

See what your workspace spends on AI, live. Every model call the workspace makes is counted and priced as it lands: chat turns, coding agents, triggers, voice and images.

## What you get

- **The Token Cost app.** A dashboard with the running spend for the range you pick, calls, tokens in and out, and the share served from cache. A table splits the cost by model and by producer (the Lucidos Agent, Claude Code, Codex, auxiliary calls). Below it you find a live list of calls as they arrive, a cost per day chart, and how large each prompt was.
- **Honest prices.** Each model has a price history. Each day is priced at the rate in force that day, and each call at the model that actually served it. A price change never reprices the past. You can edit any rate in Settings.
- **The Thread cost widget.** A small live card you can show in any thread. It ranks your threads by cost, today or all time, and a row unfolds to show the spend per model. One tap on the arrow opens the thread. A filter shows the threads in flight right now.
- **Health in the header.** If the live stream drops, a gap opens behind it, or the rollup gets stale, the header says so.

## What it needs

- Lucidos 0.48.0 or later.
- No API key and no account. The scripts read the workspace event store on your own machine.
- Two schedules, which setup offers to create for you: an hourly rollup for the dashboard, and an hourly snapshot for the widget. Setup also offers a daily price check.
- Prices. The plugin ships no prices of its own. At setup, the agent reads each provider's official pricing page and writes a price card for each model you use. Until then, models show as unpriced.

All data stays in your workspace, under `artifacts/token-cost/`.

## What to try first

1. Open the app and look at **By model**. Which model costs you the most?
2. Start a chat and watch **Live calls** fill as the agent answers.
3. Ask Lucidos to show the Thread cost widget in a thread. Switch to **In flight** while a coding agent works.
4. Open **Settings** to check a rate, or add a price change from the day it took effect.

## Links

- Source: https://github.com/lucidos-dev/plugins/tree/main/token-cost
- Lucidos: https://lucidos.dev
