---
name: Browser Learning — Reflection
description: How to run the periodic reflection pass over recent BrowserLearningObserved events and fold them into site knowhow. Loaded by the browser-knowhow-reflection trigger.
---

# Browser Learning — Reflection

You're running a periodic reflection pass over recent `BrowserLearningObserved` events. Your job is to fold them into `knowhow/sites/<domain>/` files — deduplicating, choosing the right shape per cluster, and emitting `BrowserKnowhowUpdated` for each file you actually write.

## What you have

`BrowserLearningObserved` event payloads contain:
- `domain` — registrable domain (e.g. `linkedin.com`)
- `url` — full URL where the observation happened
- `kind` — `selector`, `flow`, or `gotcha`
- `observation` — what the prior agent saw
- `suggested_update` — optional concrete edit they proposed
- `thread_id` — the originating thread, for context if you need it

## The pass

### 1. Pick the time window

Query the most recent `BrowserKnowhowUpdated` event. Use that as the lower bound. If none exists (first run), use the last 24h.

```bash
lucidos events query --type BrowserKnowhowUpdated --limit 1
lucidos events query --type BrowserLearningObserved --since <that timestamp or 24h ago>
```

If there are no observations in the window, stop. Don't emit anything, don't notify.

### 2. Group

Group observations by `(domain, kind)`. Each group becomes at most one knowhow file edit.

Within a group, cluster further by what they're actually about — three reports that "the composer button moved to the kebab menu" are one cluster, even if the wording differs. Agents won't always write identical text; pattern-match on the substance, not the surface.

### 3. Per cluster, decide

Load the existing site file (`knowhow/sites/<domain>/<selectors|flows|gotchas>.md`) once per group. Then for each cluster:

- **Already covered, accurately** → no-op. Skip.
- **Already covered, but stale or wrong** → update the existing entry. Trailing one-line note on what changed is fine; don't sprawl.
- **Not covered** → add a new entry. If the file doesn't exist yet, create it with proper frontmatter (see below).
- **Suggestion is off-base** (observation is real but `suggested_update` would harm the file) → write what's actually right, ignore the suggestion.
- **Single low-confidence sighting** (one observation, no `suggested_update`, no clear action) → leave a `# unverified — saw once on YYYY-MM-DD` note in the relevant file rather than authoritatively rewriting. Let the next live thread confirm or contradict.
- **Site directory doesn't exist** → create `knowhow/sites/<domain>/` and start the relevant file with frontmatter.

Three reports of the same thing > one report of the same thing. Weight clusters by sighting count when deciding how aggressively to rewrite.

### 4. Write

Keep it terse. Site knowhow is reference material:
- One bullet per selector
- A short numbered list per flow
- A one-paragraph note per gotcha

If you're writing more than a screen of text per cluster, you're paraphrasing — cut it down. Don't paraphrase the agent's prose into your own; their wording is closer to ground truth than yours.

### 5. Emit `BrowserKnowhowUpdated` — once per file you actually wrote

```bash
lucidos events emit BrowserKnowhowUpdated \
  --summary "Updated <domain> <kind>: <one-line>" \
  --payload '{
    "domain": "<domain>",
    "file": "knowhow/sites/<domain>/<file>.md",
    "kind": "<kind>",
    "observations_folded": <count>,
    "source_threads": ["<thread_id>", ...]
  }'
```

If a group ended in no-ops, don't emit anything for it. The next reflection pass will use the most recent `BrowserKnowhowUpdated` as its lower bound, so unprocessed observations from this window will still be visible — but only if you didn't write any file at all this run. **If you wrote at least one file, you are claiming the whole window was reviewed.** Don't write some clusters and silently drop others.

### 6. Notification

Send a notification only if you wrote something material (one or more files). Otherwise stay silent — this trigger should be invisible on quiet days.

## File conventions

Each site knowhow file starts with frontmatter:

```yaml
---
name: <Domain> Selectors
description: Verified selectors for <domain>. Maintained by the browser-learning reflection pass.
---
```

Use sub-headings to group related entries (`## Login flow`, `## Settings`, `## Composer`). Each entry small and scannable — this gets read in 5 seconds by an agent in a hurry, not studied.

## What not to do

- **Don't open the browser.** This is a reflection pass, not a verification pass. If a selector needs verification, leave a `# unverified` note and let the next live thread confirm.
- **Don't archive scraped content here.** That belongs in artifacts.
- **Don't editorialize** ("the LinkedIn UI is a mess"). Just record the fact.
- **Don't add timestamps to every line** — git history covers that. Only add a date on `# unverified` notes so the next agent knows how stale the unverified claim is.
- **Don't fall behind silently.** If the observation backlog is huge (say, >50 events in one window), you can process the largest clusters first and let the rest carry to the next pass — but say so in the notification when you do.
