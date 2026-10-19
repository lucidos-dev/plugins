---
name: Token Cost price check (pointer)
description: Token Cost reads model prices from Lucidos's price table. Checking prices and writing cards is the system knowhow model-price-check. Load when a Token Cost price check fires, a model shows unpriced, or prices need checking.
---

# Token Cost price check

Token Cost has no price table of its own. It prices from Lucidos's *price
table*: the cards Lucidos ships, merged with this workspace's override,
`data/config/model-prices.json` (ADR 0525). `lucidos model-prices` prints the
merged table.

To check prices, or to add a card for a model that shows as unpriced, load the
system knowhow `model-price-check` with `load_knowhow` and follow it. It writes
only the override, never the shipped cards.

To run the check on a schedule, use **Keep prices current** in Settings →
Intelligence. It creates the trigger `keep-prices-current`.

Token Cost's own settings, the producer labels and the exchange rates, live in
`artifacts/token-cost/settings.json`.
