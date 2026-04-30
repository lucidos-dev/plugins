---
name: Browser Skills — Self-Healing Site Knowhow
description: How to use site-specific knowhow when driving the browser, and how to feed learnings back so the next agent does better. Loaded automatically when the user mentions browser tasks, scraping, web automation, or specific site work.
---

# Browser Skills

Site-specific knowhow lives at `knowhow/sites/<domain>/`. Use it before you act, repair it when it's wrong, write it down when you discover something new.

## The loop

```
load → act → repair → record
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

The `Browser Knowhow Reflection` trigger picks these up, reviews them against the existing site knowhow, and writes the update (or no-ops if it's already covered, or files it differently if your suggestion was off-base).

**You don't need to edit the knowhow yourself in-thread.** That's the trigger's job — it has time to think, you have a task to finish.

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

- One observation per event. Don't batch.
- Keep `observation` factual ("the export button is now in the kebab menu, not the toolbar"), not interpretive ("the UI got worse").
- If you have a concrete suggested edit, include it as `suggested_update` — saves the reflection trigger a step.
- Site knowhow files use the same frontmatter as any other knowhow (`name:` required, `description:` recommended).

## Why a trigger and not in-thread edits

In-thread you're optimizing for the user's task. The reflection trigger is optimizing for the *next* agent who visits the same site. Different goals, different time budget, different pair of eyes. The trigger is also where deduplication happens — same observation from three different threads should produce one knowhow update, not three competing edits.
