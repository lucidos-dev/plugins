---
name: Browser Knowhow Reflection
knowhow:
  - browser-skills
---

# Browser Knowhow Reflection

A `BrowserLearningObserved` event was just emitted from a browser task. Decide whether and how to update the site's knowhow.

## What you have

The event payload contains:
- `domain` — registrable domain (e.g. `linkedin.com`)
- `url` — full URL where the observation happened
- `kind` — `selector`, `flow`, or `gotcha`
- `observation` — what the prior agent saw
- `suggested_update` — optional concrete edit they proposed
- `thread_id` — the originating thread, for context if you need it

## What to do

1. **Load the existing site knowhow.** Look under `knowhow/sites/<domain>/`. The conventional files are `selectors.md`, `flows.md`, `gotchas.md`. Match the `kind` to the file (selector → selectors.md, flow → flows.md, gotcha → gotchas.md).

2. **Decide:**
   - **Already covered, accurately** → no-op. Don't write. Emit nothing. Just stop.
   - **Already covered, but stale or wrong** → update the existing entry. Note what changed and when (one-line trailing comment is fine).
   - **Not covered** → add a new entry. If the file doesn't exist yet, create it with proper frontmatter.
   - **Suggestion is off-base** (the observation is real but `suggested_update` would harm the file) → write what's actually right, ignore the suggestion.
   - **Site directory doesn't exist** → create `knowhow/sites/<domain>/` and start the relevant file with frontmatter.

3. **Keep it terse.** Site knowhow is reference material. One bullet per selector, a short numbered list per flow, a one-paragraph note per gotcha. If you're writing more than a screen of text per observation, you're paraphrasing — cut it down.

4. **Don't paraphrase the agent's prose into your own.** Their wording is closer to ground truth than yours.

5. **Emit `BrowserKnowhowUpdated`** when (and only when) you actually wrote a file:

   ```bash
   lucidos events emit BrowserKnowhowUpdated \
     --summary "Updated <domain> <kind>: <one-line>" \
     --payload '{"domain": "<domain>", "file": "knowhow/sites/<domain>/<file>.md", "kind": "<kind>", "source_thread": "<thread_id>"}'
   ```

   If you no-opped, don't emit anything. The audit can see the original `BrowserLearningObserved` event either way.

## File conventions

Each file starts with frontmatter:

```yaml
---
name: <Domain> Selectors
description: Verified selectors for <domain>. Updated by browser knowhow reflection trigger.
---
```

Use sub-headings to group related entries (`## Login flow`, `## Settings`, `## Composer`). Each entry small and scannable — this gets read in 5 seconds by an agent in a hurry, not studied.

## What not to do

- Don't archive the user's data, scraped content, or task output here. That belongs in artifacts.
- Don't editorialize ("the LinkedIn UI is a mess"). Just record the fact.
- Don't add timestamps to every line — git history covers that.
- Don't open the browser. This is a reflection trigger, not a verification trigger. If a selector needs verification, leave a `# unverified — saw once on <date>` note and let the next live thread confirm.
