---
name: Token Cost price check (first seed and daily check)
description: How Token Cost gets and keeps its model prices. Reads the official provider pricing pages and writes dated price cards to artifacts/token-cost/pricing.json. Covers the first seed after install (a fresh workspace has no prices, so every model shows as unpriced), the daily check, which provider pages to read, how to add a dated card without repricing the past, retired or rerouted models, promo end dates, and when to notify. Load when the Token Cost plugin is set up, when the daily model price check trigger fires, when a provider changes a price, when a model shows as unpriced or has no price card, or when the user asks whether model prices are up to date.
---

# Token Cost price check

`artifacts/token-cost/pricing.json` is the only price table. The app has no
prices of its own. A model with no card shows as **unpriced** and stays out of
the total. This recipe fills the table from the providers' own pages, and keeps
it current.

There are two modes. The steps are the same, but the scope differs:

| Mode | When | Scope |
|---|---|---|
| **Seed** | Once, during plugin setup, or whenever `pricing.json` is missing or has no models | Every model in `daily.json`, all days |
| **Daily check** | Each fire of the price check trigger | Every model in `pricing.json`, plus models used in the last 7 days that have no card |

The user asked for changes to be written at once and reported after. They do
not approve each change first. If the user says otherwise, follow them and
update this paragraph.

## The file

If `pricing.json` exists, read its `_comment` first: it is the format spec. If
it does not exist (seed mode), create it in this shape:

```json
{
  "_comment": "<the format spec, see below>",
  "_updated": "YYYY-MM-DD",
  "_sources": { "checked": "YYYY-MM-DD" },
  "currency": "USD",
  "models": {},
  "long_context_multiplier": { "threshold_tokens": 200000, "in_multiplier": 1.0, "out_multiplier": 1.0 },
  "producers": { "main_llm": "Lucidos Agent", "claude_code": "Claude Code", "codex": "Codex", "jev_browser": "Jev Browser" },
  "fx": { "rates": {} }
}
```

The format, which the `_comment` should state in full sentences:

- `models.<id>` is a LIST of cards, oldest first. A card is in force from its
  `from` day (YYYY-MM-DD, the user's local time) until the next card's. The
  first card may omit `from`, and then it is in force since the beginning.
- Rates are USD per 1M tokens: `uncached_in`, `cache_write`, `cache_read`, `out`.
- `long` is the long-context tier: `threshold_tokens` plus its own four rates. A
  call is long only when its prompt is OVER the threshold. Add `inclusive: true`
  only when the provider bills "at or over" (xAI says "200k tokens or greater").
- `per_minute` prices a model that is billed by time (realtime and live models).
- Every card has a `source`: the URL, the quoted sentence, and "checked <date>".

## Sources to read

Read the provider's own page. Never trust a blog post or an aggregator over it.
A community source may be cited only when the provider publishes nothing, and
the card must say so.

| Provider | Price page | Change dates |
|---|---|---|
| Anthropic | https://platform.claude.com/docs/en/about-claude/pricing | https://platform.claude.com/docs/en/release-notes/api |
| OpenAI | https://developers.openai.com/api/docs/pricing, plus the per-model page | https://developers.openai.com/api/docs/changelog |
| Google | https://ai.google.dev/gemini-api/docs/pricing | the same page, and the Vertex release notes |
| xAI | https://docs.x.ai/developers/pricing | the same page |
| OpenRouter | `proxy_request(name: 'openrouter', path: '/models')`, where `pricing` is USD per token | none |
| TypeSafe | https://docs.typesafe.ai/models.md | none |

Read pages with `web_search` or `browser_open`. Store the URLs you used in
`_sources`, keyed by provider. A provider whose models this workspace never
calls needs no reading.

Also read each provider's model deprecation page for retired models and for
models routed to a newer one.

## Which model ids to price

Read `artifacts/token-cost/daily.json`. Its `days` map holds keys of the form
`producer|model`. Strip a `[1m]` suffix and a provider prefix (`anthropic/`,
`openai/`, `google/`) before you look a model up, as the app does. A dated id
(`claude-haiku-4-5-20251001`) and its undated form share one card: write the
card under the id as it appears in the usage.

If `daily.json` does not exist yet, run the rollup first
(`apps/token-cost/scripts/rollup.py`).

Free, local and stealth models (`*-free`, ids served by a local Ollama,
`stealth/*`) have no price page. Skip them.

## Seed mode

1. Collect every model id in `daily.json`, all days.
2. For each one, read the provider's current rates, including the long tier,
   the cache rates and per-minute rates.
3. Write one card per model. If the provider's changelog shows a price change
   inside the usage period, write the older card too, with the newer card's
   `from` set to the change day. Otherwise write one undated card, which prices
   all history at today's rate.
4. Tell the user how many models now have prices, and name any you could not
   price. An unpriced model is not an error, but the user should know it is
   missing from the total.

## Daily check

1. For every model in `pricing.json` with a provider price, compare the newest
   card in force today with the provider's current rates.
2. Find models used in the last 7 days of `daily.json` that have no card, and
   add one.
3. Check that cards dated in the future (an announced change) still match the
   announcement.
4. Check promos with an end date. When a provider says a price holds "at least
   through" a date, check again the day after it, and write a dated card if the
   price changed.

## How to write a change

- **Add a card. Never edit an old one.** A new card gets `from` = the day the
  provider's change took effect, from the changelog. Past days then keep the
  old price automatically.
- **If the effective date is not published,** use today's date, and say in
  `source` that the real date is unknown. Never invent a date.
- **If a past card is wrong** (the provider's page or changelog shows a
  different rate for that period), fix the card and quote the evidence. This
  reprices history, so the notification must say so and give the size.
- **A retired model** keeps its cards, because history needs them. Never delete
  one. If the provider routes it to another model, say so in the notification,
  and say which model those calls are now billed at.
- **A new model** gets one undated card if it was always at this price, or a
  card dated from its launch day.
- Write the file with `run_python`: `json.load`, change, then
  `json.dump(..., indent=2, ensure_ascii=False)` plus a trailing newline. The
  file holds curly quotes, so `ensure_ascii=False` is required. Set `_updated`
  and `_sources.checked` to today. Commit message:
  `token-cost: <model> price from <date>, per <provider>`.
- Never touch `daily.json`. The rollup reprices from the new card, and a
  threshold change makes it rebuild every day once.

## When a source cannot be read

Do not guess. Record the failure in `artifacts/token-cost/price-check.json`:
`{"failures": {"<provider>": <count>}, "last_ok": {"<provider>": "<date>"}}`.
Reset the count when the page reads again. Tell the user only when the same
provider has failed 3 runs in a row.

## Notify (daily check only)

Notify only when something changed, or when a source failed 3 runs in a row:

- `send_notification` with `app_id: token-cost`. Title: "Model prices changed".
  Message: one `• ` line per change: the model, the old rate, the new rate, and
  the from date. Add a line when history was repriced, with the dollar
  difference.
- Then `request_read`, so the run waits under Review.

When nothing changed, do neither, and do not write `pricing.json`.

## Setting up the daily check

Plugins cannot ship a schedule, so plugin setup offers one. Make it an intent
trigger, with `app_id: token-cost` and `go_to_review` off. Suggest 07:30 local
time, and let the user pick the hour. Write the intent in the user's voice, for
example: "Check today's model prices against my Token Cost price table, write
any change, and tell me only when something changed." This recipe holds the
procedure, so the intent does not repeat it.
