---
name: Browser Learning — Observation
description: How to use site-specific knowhow when driving the browser, and how to record learnings so the nightly reflection pass can fold them back into the site files. Loaded automatically when the user mentions browser tasks, scraping, web automation, or specific site work.
---

# Browser Learning — Observation

Site-specific knowhow lives at `knowhow/sites/<domain>/`. Use it before you act, repair it when it's wrong, record it when you discover something new. The reflection pass (separate trigger, runs on a schedule) folds your records into the site files.

## The loop

```
load → act → repair → record  (you, in-thread)
                          ↓
                 reflect → write  (reflection trigger, batched)
```

### 1. Load (before the first browser_open on a site)

Check whether `knowhow/sites/<domain>/` exists. If it does, read the relevant files:

| File | Contains |
|---|---|
| `selectors.md` | Stable CSS/XPath selectors that have been verified to work. Includes notes on what changes between logged-in / logged-out states. |
| `flows.md` | Step-by-step recipes for common tasks ("post a comment", "export CSV", "find the unsubscribe link"). |
| `gotchas.md` | Bot-detection patterns, hidden modals, rate limits, A/B test variants, anything that surprised a previous agent. |

Domain = the registrable domain, lowercased. `app.linkedin.com` and `www.linkedin.com` both go under `linkedin.com/`. Subdomain-specific notes go in a `subdomains/` subfolder if needed.

If no knowhow exists, that's fine — you're the first. Just keep an eye out for things worth recording.

### 2. Act

Use `browser_open`, `browser_extract`, `browser_click`, etc. Try selectors from `selectors.md` first when present.

### 3. Repair (in-thread, while the task is live)

If a selector breaks, a flow takes a surprise turn, or you hit something `gotchas.md` should have warned you about — **fix the task first**, then come back to step 4. Don't drop the user's request to chase a knowhow update.

### 4. Record (when the task is done, or at a natural pause)

For each thing worth recording, emit a `BrowserLearningObserved` event:

```python
emit_event("BrowserLearningObserved", {
    "summary": "<one-line description>",
    "domain": "linkedin.com",
    "url": "https://www.linkedin.com/feed/",
    "kind": "selector" | "flow" | "gotcha",
    "observation": "<what you saw>",
    "suggested_update": "<what should change in the knowhow, optional>",
    "thread_id": "<this thread's id, if known>"
})
```

Records accumulate. The reflection trigger (default: nightly) reads the batch, deduplicates, and writes one good knowhow update per cluster of related observations. **You don't edit the knowhow yourself in-thread** — you'd be racing other threads doing the same thing, and you don't see the patterns the batch sees.

## What's worth recording (and what isn't)

**Worth recording:**
- A selector you used that wasn't in `selectors.md` and is likely to be reused
- A working flow for a non-obvious task (multi-step navigation, hidden settings)
- A surprise: cookie banner that blocks clicks, "are you a human" interstitial, layout that differs by region/account state
- A correction: `selectors.md` says `.btn-primary`, but it's been `.action-primary` for a while now

**Not worth recording:**
- One-off URLs the user asked you to visit
- Content from the page (that's what artifacts are for)
- Things obvious from the page itself ("the homepage has a search bar")
- Successful runs where everything matched the existing knowhow — silence is the signal

## Conventions

- One observation per event. Don't batch in-thread; batching is the reflection trigger's job.
- Keep `observation` factual ("the export button is now in the kebab menu, not the toolbar"), not interpretive ("the UI got worse").
- If you have a concrete suggested edit, include it as `suggested_update` — saves the reflection pass a step.
- Site knowhow files use the same frontmatter as any other knowhow (`name:` required, `description:` recommended).

## Why batched reflection and not in-thread edits

In-thread you're optimizing for the user's task. Reflection is optimizing for the *next* agent who visits the same site — different goals, different time budget, different pair of eyes. Batching is also where deduplication happens: same observation from three different threads should produce one knowhow update, not three competing edits, and a pattern across threads ("everyone reports the composer button moved") is a stronger signal than any single sighting.
