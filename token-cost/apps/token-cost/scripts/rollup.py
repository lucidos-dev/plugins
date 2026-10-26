#!/usr/bin/env python3
"""Incremental token-usage rollup.

Reads `ContextCaptured` events (every real model call the engine makes emits
one, with a provider `usage` block) and folds them into a per-day, per-model
rollup at artifacts/token-cost/daily.json.

Incremental: resumes from `last_sequence` in the existing file and only reads
rows above it, so a run costs the same whether the store holds 500k events or
5M. Recomputes the touched days in full rather than adding deltas, so a rerun
is idempotent.

Set TOKEN_COST_REBUILD=1 to ignore the stored cursor and rebuild every day
from scratch (needed whenever the aggregation itself changes, since the
incremental path only ever revisits days that gained rows).

DEDUPING REPEATED USAGE FRAMES
------------------------------
Claude Code re-delivers the same assistant message several times as it
streams, and each delivery carries the same `usage` block, so the engine
emits 2-3 identical `ContextCaptured` rows per real API call. Measured
2026-08-11: claude_code 521,020 rows for 300,491 real calls (1.73x), while
codex (1.01x) and main_llm (1.00x) are clean.

So a row is dropped when its `(input, cache_read, cache_write, output)` tuple
is identical to the PREVIOUS row in the same thread and agent session by
sequence. Consecutive and per-thread both matter: two unrelated calls
elsewhere in the workspace that happen to match are never collapsed, and a
real repeat separated by any other call in its own thread survives. A thread
can hold several sessions (a handoff starts a successor session in the same
thread), and the first call of a new session is a new context, so it is never
compared with the last call of the session before. A row from before the
engine stamped `session` carries none, and those compare among themselves.

This is a heuristic, unlike the fix the engine needs (key on the CC assistant
message id, which is not persisted here). It is safe at these magnitudes: the
5th percentile of surviving rows is ~47k input tokens, so two genuinely
distinct calls agreeing on all four counts is implausible.

It is scoped to claude_code, because only claude_code ever had the frame bug
(42% of its rows against 1.1% for codex), and on the other producers an equal
pair is a real repeat rather than a re-delivered frame. Measured on the whole
store, collapsing every producer cost codex 2.75% of its uncached input and
2.08% of its output, and main_llm nothing at all (zero collisions in 31,845
rows). A time-gap guard was considered instead and rejected: at 5 seconds it
leaves claude_code at 1.62x when a real transcript measures 1.77x frames per
message, so it under-collapses the very thing it exists to catch.

Engine builds from 2026-08-11 emit one row per real API call, so on newer data
this collapses nothing (431 rows in the first night, zero dropped). It stays
for the ~220k pre-fix rows, and needs no cutoff date: the LAG is evaluated pair
by pair within a thread, so old threads collapse and new ones pass through.

The LAG runs over each thread's FULL history, not just the touched days, so a
duplicate straddling midnight is still caught on an incremental run.

VOICE SESSIONS ARE PRICED BY THE SECOND, NOT BY TOKENS
------------------------------------------------------
A GPT-Live talker reports every token count as zero (ADR 0181: "A Live turn
reports zero tokens"), so its `ContextCaptured` rows carry the model and the
call count and nothing to charge for. What prices it is
`VoiceSessionEnded.duration_secs`, which every call already writes.

So a second pass sums those seconds into the same (day, hour, producer, model)
buckets under a `seconds` field, and the app multiplies it by the card's
`per_minute` rate. The event names no model, so each session takes the model
from the last voice `ContextCaptured` in its own thread at or before the
hangup, which is the session that just ended. Seconds are recorded for every
voice model, Realtime included: a token-priced card ignores them, and the
minutes are worth seeing either way.

LOCAL DAYS, AND PER-HOUR DETAIL FOR THE RECENT ONES
---------------------------------------------------
Days are bucketed in the USER'S LOCAL timezone, not UTC. The app decides what
"today" is with a local-time date, so a UTC bucket disagreed with it for every
call made between midnight and 02:00 Oslo, quietly filing those into the
previous day. The timezone is resolved from /etc/localtime (then TZ, then UTC).

The same query also groups by local hour, which is what lets the app draw a
single selected day as 24 hourly bars instead of one lone column. Hours are
kept only for the most recent HOURS_DAYS days (the only ones a single-day
selection can land on) and pruned from older days, so the file does not grow
24x.

PER THREAD, IN A SECOND FILE
----------------------------
The query also groups by thread and agent session, and the same pass writes
those rows to artifacts/token-cost/threads-daily.json as compact lists (see
THREAD_FIELDS), keyed `<thread>@<session>` (see thread_slot()), with each
thread's title, parent and predecessor. A thread now holds one row per
session, and each session may run on its own backend and model, so the app's
thread drill-down shows one row per session that sums to the thread. The app reads it only when its Thread
group-by is on, and folds sub-threads into their root there. One query feeds
both files, so the per-thread rows always sum to daily.json. The two share a
cursor; when they disagree, the next run rebuilds both.

Each row also counts `cached_calls`, the calls that read any cache, so the app
can show cached against cold calls rather than only token shares.

LUCIDOS AGENT CALLS, BY ORIGIN
------------------------------
A `main_llm` call is filed as `main_llm:chat`, `main_llm:trigger` or
`main_llm:other` by the origin of its thread's root, read from
thread_summaries after the usage query, or bare `main_llm` when the origin
cannot be read. See classify_origins(). daily.json also lists recent threads'
origins under `thread_origins`, which is how the app files a live call.

State path is anchored on LUCIDOS_WORKSPACE, never on __file__.
"""

import hashlib
import json
import math
import os
import pathlib
import re
import subprocess
import sys
from datetime import datetime, timezone
from cache_stats import VERSION as CACHE_VERSION, build_cache
from cache_usage import WRITE_FIELDS, write_bundle, write_sql

WS = pathlib.Path(os.environ.get("LUCIDOS_WORKSPACE", "."))
OUT = WS / "data" / "artifacts" / "token-cost" / "daily.json"
# The same rows split by thread, for the app's Thread group-by. Its own file,
# because it is ten times the size of daily.json and the app only reads it
# when Thread is picked. See thread_row().
THREADS_OUT = WS / "data" / "artifacts" / "token-cost" / "threads-daily.json"
# The price table is Lucidos's: the cards it ships merged with the workspace
# override, data/config/model-prices.json (ADR 0525). `lucidos model-prices`
# prints it. TOKEN_COST_PRICE_TABLE names a file holding the same JSON
# instead, which is how a test or a replay feeds the rollup a fixed table.
PRICE_TABLE = os.environ.get("TOKEN_COST_PRICE_TABLE") or None
# The plugin's scripts/token-cost/migrate_prices.py, which moves Token Cost
# 0.4.x prices into the price table. This file sits three folders below the
# plugin root in the repo and below data/ in a workspace, so one path fits both.
MIGRATE = pathlib.Path(__file__).resolve().parents[3] / "scripts" / "token-cost" / "migrate_prices.py"

BUCKET_EDGES = [0, 32000, 64000, 128000, 200000, 400000]
LONG_CTX_THRESHOLD = 200000

# Jev calls do not reach the engine as a model call: the jev-browser loop posts
# to TypeSafe through the `lucidos proxy` CLI from a subprocess, so the engine
# proxies the bytes and emits no `ContextCaptured`. Every Jev token was
# therefore invisible here, and a real TypeSafe bill read as $0.
#
# Fixed at the source: `jev_browser.ask()` now emits a `JevCallCompleted`
# domain event per call, carrying the same four usage counters under the same
# names. (It cannot emit `ContextCaptured` itself: the engine reserves that
# name for thread events, which key `aggregate_id` on a thread uuid, and
# rejects a hand-emitted one with 400.) Those events are the live source.
#
# The disk pass below is a BACKFILL for the ~57k calls made before that event
# existed. It reads the exact `requests` count each drive already recorded and
# multiplies by the measured mean tokens per call, so the count is exact and
# the token figure is an estimate. A day that has real events is never
# backfilled, so the estimate retires itself as fresh runs land.
#
# Both sources END at the PROXY CUTOVER. The engine now records every model
# call its credentialed proxy forwards as a `ContextCaptured` with
# `purpose: "proxy"` (engine ADR 0381), Jev calls included, and the main pass
# above already counts those rows. So the cutover is the first such row: a
# `JevCallCompleted` or a drive result from after it would count the same call
# twice. The plugin stopped emitting `JevCallCompleted` at the same change. A
# drive between that and the cutover still has its result file, so the disk
# estimate covers that gap until the engine takes over.
JEV_TOKENS_PER_CALL = 12525
JEV_MODEL = "jev-1.13.0"
JEV_PRODUCER = "jev_browser"

# Where drives write their result.json. The bench harness writes under the
# gitignored scratch tree, ad-hoc drives under artifacts/browse.
JEV_RESULT_GLOBS = (
    ".lucidos/tmp/bench-*/runs/*/result.json",
    "data/artifacts/browse/*/result.json",
)

JEV_SQL = """
COPY (
  SELECT coalesce(json_agg(row_to_json(t)), '[]'::json) FROM (
    SELECT
      to_char(created AT TIME ZONE '%(tz)s', 'YYYY-MM-DD') AS day,
      %(hour)s AS hour,
      coalesce(payload->>'model', 'jev-1.13.0') AS model,
      count(*)::bigint AS calls,
      sum((payload->'usage'->>'input_tokens')::bigint) AS total_in,
      sum(coalesce((payload->'usage'->>'output_tokens')::bigint, 0)) AS out_tok,
      max((payload->'usage'->>'input_tokens')::bigint) AS max_in
    FROM events
    WHERE event_type = 'JevCallCompleted'
      AND payload->'usage'->>'input_tokens' IS NOT NULL
      AND created < %(cutover)s
    GROUP BY 1, 2, 3
  ) t
) TO STDOUT;
"""


def blank_bucket() -> dict:
    return {
        "calls": 0, "in": 0, "cache_read": 0, "cache_write": 0, **dict.fromkeys(WRITE_FIELDS, 0),
        "out": 0, "seconds": 0, "buckets": [0] * 6,
        "long": {"in": 0, "out": 0, "cache_read": 0, "cache_write": 0, **dict.fromkeys(WRITE_FIELDS, 0)},
        "max_in": 0,
        # Jev calls carry no cache counts, so none of them read the cache.
        "cached_calls": 0,
    }


# The first row the engine wrote for a proxied model call, as epoch seconds.
PROXY_CUTOVER_SQL = (
    "SELECT coalesce(extract(epoch FROM min(created))::text, '') FROM events "
    "WHERE event_type = 'ContextCaptured' AND payload->>'purpose' = 'proxy'"
)


def proxy_cutover() -> float | None:
    """When the engine began recording proxied calls, or None before then."""
    try:
        raw = psql(PROXY_CUTOVER_SQL)
    except SystemExit:
        return None
    return float(raw) if raw else None


def fold_jev(days: dict, hours: dict, keep_hours: set) -> tuple:
    """Add TypeSafe Jev calls to the rollup.

    Events first, because they carry the real per-call token counts the API
    returned. Disk only for a day the events do not cover, which is the
    historical backfill described above.

    This rebuilds every Jev row from scratch on each pass. The event side of
    the main rollup is incremental and only clears the days it touched, so
    adding to whatever was already there would double-count Jev on every run
    after the first. Both sources are cheap to re-read, so the old rows go
    first.
    """
    key = f"{JEV_PRODUCER}|{JEV_MODEL}"
    for bucket in days.values():
        bucket.pop(key, None)
    for day in hours.values():
        for bucket in day.values():
            bucket.pop(key, None)

    def add(day, hour, calls, tokens, out_tok, max_in):
        targets = [days.setdefault(day, {})]
        if day in keep_hours:
            targets.append(hours.setdefault(day, {}).setdefault(str(hour), {}))
        for bucket in targets:
            dst = bucket.setdefault(key, blank_bucket())
            dst["calls"] += calls
            dst["in"] += tokens
            dst["out"] += out_tok
            # Every Jev prompt sits in the smallest size bucket: the 64k
            # context cap makes anything else possible only in theory.
            dst["buckets"][0] += calls
            dst["max_in"] = max(dst["max_in"], max_in)

    # 1. Real events, the authoritative source, up to the proxy cutover.
    cutover = proxy_cutover()
    cutover_sql = "'infinity'::timestamptz" if cutover is None else f"to_timestamp({cutover})"
    covered = set()
    calls_total = tokens_total = 0
    try:
        rows = json.loads(psql(JEV_SQL % {"tz": TZ, "hour": LOCAL_HOUR, "cutover": cutover_sql}))
    except Exception:
        rows = []
    for x in rows:
        calls = int(x["calls"] or 0)
        tokens = int(x["total_in"] or 0)
        covered.add(x["day"])
        calls_total += calls
        tokens_total += tokens
        add(x["day"], int(x["hour"]), calls, tokens,
            int(x["out_tok"] or 0), int(x["max_in"] or 0))

    # 2. Disk backfill, for days no event covers, up to the proxy cutover.
    for pattern in JEV_RESULT_GLOBS:
        for path in WS.glob(pattern):
            mtime = path.stat().st_mtime
            if cutover is not None and mtime >= cutover:
                continue
            try:
                doc = json.loads(path.read_text())
            except (OSError, ValueError):
                continue
            calls = int(doc.get("requests") or doc.get("decisions") or 0)
            if calls <= 0:
                continue
            stamp = datetime.fromtimestamp(mtime).astimezone()
            day = stamp.strftime("%Y-%m-%d")
            if day in covered:
                continue
            tokens = calls * JEV_TOKENS_PER_CALL
            calls_total += calls
            tokens_total += tokens
            add(day, stamp.hour, calls, tokens, 0, JEV_TOKENS_PER_CALL)

    return calls_total, tokens_total


# The fields that make a card priced, as the app's isPricedCard() reads them.
RATE_FIELDS = ("uncached_in", "cache_write", "cache_read", "out", "per_minute")
DAY_RE = re.compile(r"\d{4}-\d{2}-\d{2}")


class PricingUnreadable(Exception):
    """The price table cannot be read."""


def cards_of(entry) -> list:
    """A model's price history, oldest first, as the app's cardsOf() reads it.

    The price table holds a LIST of cards per model, each in force from its
    `from` day. An undated card sorts first (in force since the beginning),
    ties keep file order, and a plain object is one undated card: the shape
    every file had before history existed.
    """
    if isinstance(entry, dict):
        cards = [entry]
    elif isinstance(entry, list):
        cards = [c for c in entry if isinstance(c, dict)]
    else:
        cards = []
    return sorted(cards, key=lambda c: str(c.get("from") or ""))


def is_priced(card: dict) -> bool:
    return any(
        isinstance(card.get(k), (int, float)) and not isinstance(card.get(k), bool)
        for k in RATE_FIELDS
    )


def threshold_of(value):
    """A threshold as the app's thresholdOf() reads it: a positive number of
    prompt tokens, or None. A typo in the file must not crash the run."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value) or value <= 0:
        return None
    return value


def over_cut(threshold, inclusive: bool):
    """The prompt size a call must be OVER to be long, as a SQL number.

    Providers word the edge two ways. OpenAI (">272K"), Google ("> 200k")
    and Anthropic ("over 100,000") bill the long rates only ABOVE the
    threshold. xAI bills them from a prompt that REACHES it, which a card
    says with `inclusive: true`. Token counts are whole numbers, so "at
    least t" is "over ceil(t) - 1", and one comparison covers both.
    """
    cut = math.ceil(threshold) - 1 if inclusive else threshold
    return int(cut) if float(cut).is_integer() else cut


def default_cut(doc) -> int:
    """The split for a card with no tier of its own, and for a model with no
    card: 200k, as the app's longRule() falls back to it. Such a call is
    priced at the flat rate either way, so the split only sorts its tokens."""
    return LONG_CTX_THRESHOLD


def threshold_schedule(entry, default) -> list:
    """[(from day or None, cut)] for each card that can be in force.

    The same cards the app's cardOn() can pick: priced, and with a `from`
    that is a real date or absent. A card whose `long` tier names no usable
    threshold splits at `default`, like the app's longThreshold() for it.
    Empty when the model has no priced card at all, which the app treats
    as unlisted.
    """
    out = []
    for card in cards_of(entry):
        start = card.get("from")
        if start and not DAY_RE.fullmatch(str(start)):
            continue
        if not is_priced(card):
            continue
        tier = card.get("long") if isinstance(card.get("long"), dict) else {}
        t = threshold_of(tier.get("threshold_tokens"))
        cut = default if t is None else over_cut(t, tier.get("inclusive") is True)
        out.append((start or None, cut))
    return out


def read_pricing() -> dict:
    """The price table as a dict, from `lucidos model-prices` (or the
    TOKEN_COST_PRICE_TABLE file).

    A table that cannot be read stops the run. Splitting every model at 200k
    instead would quietly file every 200k-272k GPT call as long, and the
    rolled-up days would keep that until the next rebuild. A failed run
    leaves daily.json as it was, and the next hour tries again. An engine
    from before the price table has no `model-prices` command, so on it the
    rollup stops here and says so.
    """
    where = PRICE_TABLE or "lucidos model-prices"
    if PRICE_TABLE:
        try:
            text = pathlib.Path(PRICE_TABLE).read_text()
        except OSError as e:
            raise PricingUnreadable(f"cannot read {where}: {e}") from e
    else:
        try:
            r = subprocess.run(["lucidos", "model-prices"], capture_output=True, text=True)
        except OSError as e:
            raise PricingUnreadable(f"cannot run {where}: {e}") from e
        if r.returncode != 0:
            raise PricingUnreadable(f"{where} failed: {(r.stderr or r.stdout).strip()[:300]}")
        text = r.stdout
    try:
        doc = json.loads(text)
    except ValueError as e:
        raise PricingUnreadable(f"{where} is not valid JSON: {e}") from e
    if not isinstance(doc, dict) or not isinstance(doc.get("models"), dict):
        raise PricingUnreadable(f"{where} has no models table")
    return doc


def long_schedules(doc: dict) -> dict:
    """Model id -> its cut schedule, for every model the price table prices.

    Read from the price table, because the threshold is a fact about the
    PROVIDER and differs between them: OpenAI's tier starts over 272k,
    xAI's at 200k, Gemini Pro's over 200k, Haiku 5.5's over 100k, and
    Anthropic's other models charge no premium at all. One global 200k
    split filed every 200k-272k GPT call as long and the app then priced
    it at a rate OpenAI does not charge. The app prices from the same
    table, so there is nothing else to agree with.
    """
    default = default_cut(doc)
    out = {}
    for model, entry in (doc.get("models") or {}).items():
        if model == "default":
            continue
        sched = threshold_schedule(entry, default)
        if sched:
            out[model] = sched
    return out


def schedule_sql(sched: list, day: str, before: str) -> str:
    """One model's cut on the row's day, as SQL.

    The newest card whose `from` is on or before the day wins, the same rule
    the app prices with. Days before the first dated card take `before`:
    the default, or for a literal id, whatever its plain id would give,
    since the app falls through to the next key when a key has no card
    that day.
    """
    base = before
    dated = []
    for start, t in sched:
        if start is None:
            base = str(t)
        else:
            dated.append((start, str(t)))
    # A card that keeps the threshold changes prices, not the split, so it
    # needs no branch here.
    kept, cur = [], base
    for start, t in dated:
        if t != cur:
            kept.append((start, t))
            cur = t
    dated = kept
    if not dated:
        return base
    # Newest first, so the first WHEN that matches is the card in force. Two
    # cards on one day: the later one in the file wins, as in the app.
    whens = " ".join(f"WHEN {day} >= '{start}' THEN {t}" for start, t in reversed(dated))
    return f"(CASE {whens} ELSE {base} END)"


def plain_id(model: str) -> str:
    """The app's modelKeys() normalisation of an id, before the release date.

    A gateway decorates the ids it passes through, and the app resolves
    each of these to the plain card: a provider prefix (`openai/gpt-5.5`),
    Bedrock's `us.anthropic.` prefix and `-v1:0` suffix, and OpenRouter's
    dotted Claude version (`claude-haiku-5.5`). Claude Haiku 5.5 has a
    long tier, so the Anthropic spellings matter here too.
    """
    m = model.lower()
    m = re.sub(r"^(?:[a-z]{2,6}\.)?anthropic\.", "", m)
    m = re.sub(r"^(?:[a-z0-9_-]+/)+", "", m)
    m = re.sub(r"-v\d+(?::\d+)?$", "", m)
    if m.startswith("claude-"):
        m = re.sub(r"(\d)\.(\d)", r"\1-\2", m)
    return m


def undated_id(model: str) -> str:
    """`claude-haiku-5-5-20261007` -> `claude-haiku-5-5`, as the app's undated().

    A release stamp is three or more digits (`-20251001`, `-001`,
    `-2026-04-01`), so a version such as `claude-opus-5-5` is never one.
    """
    return re.sub(r"-\d{3,}(?:-\d+)*$", "", model)


def _bare_sql(x: str) -> str:
    """The served-model rule's id normalisation: no `vendor/` prefix, no
    `[1m]`, `@` as `-`, lowercase."""
    return f"lower(replace(regexp_replace(regexp_replace({x}, '^.*/', ''), '\\[1m\\]$', ''), '@', '-'))"


def served_as_sent_sql(sent: str, served: str) -> str:
    """The engine's served_as_sent() (llm/served_model.rs) as SQL.

    True when the served id is the sent id plus nothing, a `:tag`, or a
    release stamp of three or more digits. Written with regexp_replace
    rather than `~` so the test can run it in sqlite.
    """
    a, b = _bare_sql(sent), _bare_sql(served)
    return (
        f"(substr({b}, 1, length({a})) = {a} AND "
        f"regexp_replace(substr({b}, length({a}) + 1), '^(:.*|-[0-9]{{3}}.*)?$', '') = '')"
    )


def row_model_sql(model: str, served: str) -> str:
    """The model a usage row is filed under, as the app's rowModel().

    The id the provider's reply names, else the id Lucidos sent, less a
    `[1m]` suffix. So a `claude-opus-5-5[1m]` call shares a row with a plain
    `claude-opus-5-5` call, also from before the engine recorded
    `served_model`, and a reroute files under the model that ran. Pricing
    reads this id too: every card lookup and the long split strip `[1m]`
    first, so the bare id prices the same.
    """
    return f"regexp_replace(coalesce(nullif({served}, ''), {model}), '\\[1m\\]$', '')"


def asked_sql(model: str, served: str) -> str:
    """The id Lucidos asked for, on a row another model answered. Else NULL."""
    same = f"coalesce({served}, '') = '' OR {served_as_sent_sql(model, served)}"
    return f"(CASE WHEN {same} THEN NULL ELSE {model} END)"


REQ = "payload->>'model'"
SERVED = "payload->>'served_model'"
ROW_MODEL = row_model_sql(REQ, SERVED)
ASKED = asked_sql(REQ, SERVED)


def plain_id_sql(expr: str) -> str:
    """plain_id() then undated_id(), as SQL over an already-lowercased id."""
    m = f"regexp_replace({expr}, '^([a-z]{{2,6}}\\.)?anthropic\\.', '')"
    m = f"regexp_replace({m}, '^([a-z0-9_-]+/)+', '')"
    m = f"regexp_replace({m}, '-v[0-9]+(:[0-9]+)?$', '')"
    m = f"(CASE WHEN {m} LIKE 'claude-%' THEN regexp_replace({m}, '([0-9])\\.([0-9])', '\\1-\\2', 'g') ELSE {m} END)"
    return f"regexp_replace({m}, '-[0-9]{{3,}}(-[0-9]+)*$', '')"


def long_cutoff_sql(column: str, day: str, doc: dict | None = None) -> str:
    """The per-model, per-day cut as one SQL expression: a call is long when
    its prompt is OVER this many tokens.

    The stored id carries the engine's decorations (`claude-opus-5@default[1m]`),
    and pricing keys on the bare model, so both sides are stripped the same way
    the app's `baseModel()` does it. The literal id is tried first, then the
    id normalised as modelKeys() does and undated, matching the order the app
    looks up in. `day` is the row's local day, so a card that starts
    mid-history splits only the days it covers.
    """
    if doc is None:
        doc = read_pricing()
    bare = (
        f"regexp_replace(regexp_replace({column}, '\\[1m\\]$', ''), '@[^\\[\\]]*$', '')"
    )
    plain = plain_id_sql(f"lower({bare})")
    rows = long_schedules(doc)
    dflt = default_cut(doc)
    default = str(dflt)
    differs = lambda sched: any(t != dflt for _, t in sched)
    # The second pass keys on table ids already in normalised form, undated:
    # the app normalises the id it looks up, never the table, and matches a
    # dated key to an undated id and back.
    plain_rows = {}
    for m, sched in sorted(rows.items()):
        if plain_id(m) == m.lower() and differs(sched):
            plain_rows.setdefault(undated_id(m.lower()), sched)
    # A literal match also has to pin the default when a tier-less card
    # would otherwise fall through to a tier under its plain id.
    literal_rows = {
        m: sched for m, sched in rows.items()
        if differs(sched) or undated_id(plain_id(m)) in plain_rows
    }
    if not literal_rows and not plain_rows:
        return default
    q = lambda s: "'" + s.replace("'", "''") + "'"
    inner = (
        f"CASE {plain} "
        + " ".join(f"WHEN {q(m)} THEN {schedule_sql(s, day, default)}" for m, s in sorted(plain_rows.items()))
        + f" ELSE {default} END"
        if plain_rows else default
    )
    if not literal_rows:
        return f"({inner})"
    whens = " ".join(
        f"WHEN {q(m)} THEN {schedule_sql(s, day, f'({inner})' if plain_rows else default)}"
        for m, s in sorted(literal_rows.items())
    )
    return f"(CASE {bare} {whens} ELSE {inner} END)"


def split_signature(cutoff_sql: str) -> str:
    """A short fingerprint of the long-context split, stamped in daily.json.

    The split happens HERE, at rollup time, and the app then prices each
    day's `long` share at the card in force. A tier added, moved or dated
    in the price table after a day was rolled up would price that day's old
    split at the new card. A changed fingerprint rebuilds every day once,
    so the two cannot drift.
    """
    return hashlib.sha256(cutoff_sql.encode()).hexdigest()[:16]


# Days that keep their per-hour breakdown. The app draws hourly bars only when
# exactly one day is selected, so a short window covers every case that can
# reach it, and older days shed the 24x detail.
HOURS_DAYS = 3


def local_tz() -> str:
    """IANA name for this machine's timezone.

    Postgres runs on Etc/UTC here, so the conversion has to be explicit and
    named. /etc/localtime is a symlink into the zoneinfo tree on both macOS and
    Linux, which is the only place the IANA name survives (time.tzname gives
    'CEST', which Postgres will not take).
    """
    try:
        parts = pathlib.Path("/etc/localtime").resolve().parts
        if "zoneinfo" in parts:
            i = len(parts) - 1 - parts[::-1].index("zoneinfo")
            name = "/".join(parts[i + 1 :])
            if name:
                return name
    except OSError:
        pass
    return os.environ.get("TZ") or "UTC"


TZ = local_tz()
# Spelled once; interpolated rather than bound because these go through psql -c.
LOCAL_DAY = f"((created AT TIME ZONE '{TZ}')::date)"
LOCAL_HOUR = f"(extract(hour FROM (created AT TIME ZONE '{TZ}'))::int)"
# The same two, qualified for a query that joins `events` to itself and so has
# to say WHICH row's timestamp it means.
E_DAY = f"((e.created AT TIME ZONE '{TZ}')::date)"
E_HOUR = f"(extract(hour FROM (e.created AT TIME ZONE '{TZ}'))::int)"

# Each row's cut comes from the card in force on that row's local day. Built
# in main(), from the price table of that run, and spliced in for this mark.
LONG_CUT_MARK = "%(long_cut)s"

# `usage` tuple, spelled once for the value and once inside the LAG.
_USAGE_TUPLE = """(
        (payload->'usage'->>'input_tokens')::bigint,
        coalesce((payload->'usage'->>'cache_read_tokens')::bigint, 0),
        coalesce((payload->'usage'->>'cache_creation_tokens')::bigint, 0),
        (payload->'usage'->>'output_tokens')::bigint
      )"""

# A cache keep-alive ping is a Claude Code turn like any other: same producer,
# same purpose. What tells it apart is its anchor. The engine opens each ping
# with a PromptInjected whose engine reason is `cache_keep_alive`, and every
# capture of that turn names it as `request_event_id`. Those calls are filed
# under their own type, so the Type column shows what the keep-alive costs.
# The CASE keeps a malformed id from failing the cast, since AND does not
# promise an order, and the lookup still uses the primary key. `c` is the
# capture row of ROLLUP_SQL.
KEEP_ALIVE_TYPE = "cache_keep_alive"
KEEP_ALIVE = """(c.payload->>'producer' = 'claude_code' AND EXISTS (
          SELECT 1 FROM events a
          WHERE a.id = CASE
              WHEN c.payload->>'request_event_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              THEN (c.payload->>'request_event_id')::uuid END
            AND a.event_type = 'PromptInjected'
            AND a.payload->'origin'->'reason'->>'kind' = 'cache_keep_alive'
        ))"""

# The engine files every housekeeping model call (compaction, memory, titles,
# voice, proxy...) under the one producer `auxiliary` and names what it was for
# in `purpose`. One row for all of them hides where the money goes, so a call is
# filed under `auxiliary:<purpose>` (bare `auxiliary` when the purpose is empty
# or missing). Other producers keep their own id, `purpose` or not: for
# claude_code and codex it is a transport detail, not a different spend. A
# purpose is cut to [A-Za-z0-9_.-] because a row key is `producer|model` and a
# stray `|` would split it. The voice-seconds query uses the same expression, or
# a session's seconds would land on a row its tokens are not in.
def producer_id_sql(payload: str = "payload") -> str:
    """The SQL expression for a call's producer id, read from this JSON column."""
    return (
        f"CASE WHEN {payload}->>'producer' = 'auxiliary' "
        f"AND coalesce({payload}->>'purpose', '') <> '' "
        f"THEN 'auxiliary:' || regexp_replace({payload}->>'purpose', '[^A-Za-z0-9_.-]', '_', 'g') "
        f"ELSE {payload}->>'producer' END"
    )


ROLLUP_SQL = (
    """
COPY (
  SELECT coalesce(json_agg(row_to_json(t)), '[]'::json) FROM (
    SELECT
      to_char(local_day, 'YYYY-MM-DD') AS day,
      local_hour AS hour,
      CASE WHEN keep_alive THEN '"""
    + KEEP_ALIVE_TYPE
    + """' ELSE producer END AS producer,
      model,
      asked,
      effort,
      thread_id::text AS thread,
      session,
      wk < cw AS cache_unknown,
      count(*) AS calls,
      count(*) FILTER (WHERE cr > 0) AS cached_calls,
      sum(in_tok) AS total_in,
      sum(cr) AS cache_read,
      sum(cw) AS cache_write,
      sum(out_tok) AS out_tok,
      count(*) FILTER (WHERE in_tok <  32000) AS b0,
      count(*) FILTER (WHERE in_tok >= 32000  AND in_tok < 64000)  AS b1,
      count(*) FILTER (WHERE in_tok >= 64000  AND in_tok < 128000) AS b2,
      count(*) FILTER (WHERE in_tok >= 128000 AND in_tok < 200000) AS b3,
      count(*) FILTER (WHERE in_tok >= 200000 AND in_tok < 400000) AS b4,
      count(*) FILTER (WHERE in_tok >= 400000) AS b5,
      sum(in_tok)  FILTER (WHERE in_tok > long_cut) AS long_in,
      sum(out_tok) FILTER (WHERE in_tok > long_cut) AS long_out,
      sum(cr)      FILTER (WHERE in_tok > long_cut) AS long_cr,
      sum(cw)      FILTER (WHERE in_tok > long_cut) AS long_cw,
      sum(in_tok)  FILTER (WHERE flex AND in_tok <= long_cut) AS flex_in,
      sum(out_tok) FILTER (WHERE flex AND in_tok <= long_cut) AS flex_out,
      sum(cr)      FILTER (WHERE flex AND in_tok <= long_cut) AS flex_cr,
      sum(cw)      FILTER (WHERE flex AND in_tok <= long_cut) AS flex_cw,
      max(in_tok) AS max_in
    FROM (
      SELECT
        """
    + LOCAL_DAY
    + """ AS local_day,
        """
    + LOCAL_HOUR
    + """ AS local_hour,
        thread_id,
        payload->>'session' AS session,
        """
    + producer_id_sql("payload")
    + """ AS producer,
        """
    + ROW_MODEL
    + """ AS model,
        """
    + ASKED
    + """ AS asked,
        coalesce(payload->>'reasoning_effort', '') AS effort,
        (payload->'usage'->>'input_tokens')::bigint AS in_tok,
        coalesce((payload->'usage'->>'cache_read_tokens')::bigint, 0) AS cr,
        coalesce((payload->'usage'->>'cache_creation_tokens')::bigint, 0) AS cw,
        (payload->'usage'->>'output_tokens')::bigint AS out_tok,
        coalesce(payload->'usage'->>'service_tier', '') = 'flex' AS flex,
        """
    + LONG_CUT_MARK
    + """ AS long_cut,
        """
    + _USAGE_TUPLE
    + """ IS NOT DISTINCT FROM LAG("""
    + _USAGE_TUPLE
    + """)
          OVER (PARTITION BY thread_id, payload->>'session' ORDER BY sequence)
        AND payload->>'producer' = 'claude_code' AS dup,
        """
    + KEEP_ALIVE
    + """ AS keep_alive
      FROM events c
      WHERE event_type = 'ContextCaptured'
        AND payload->'usage' IS NOT NULL
        AND sequence <= %(max_seq)s
        AND thread_id IN (
          SELECT DISTINCT thread_id FROM events
          WHERE event_type = 'ContextCaptured'
            AND """
    + LOCAL_DAY
    + """ = ANY (%(days)s)
        )
    ) s
    WHERE NOT dup
      AND local_day = ANY (%(days)s)
    GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9
  ) t
) TO STDOUT;
"""
)


WRITE_ALIASES = dict(zip(WRITE_FIELDS, ("wk", "wh", "wt")))
ROLLUP_SQL = ROLLUP_SQL.replace(
    "sum(cw) AS cache_write,", "sum(cw) AS cache_write, " +
    ", ".join(f"sum({alias}) AS {field}" for field, alias in WRITE_ALIASES.items()) + ",")
for tier, condition in (("long", "in_tok > long_cut"), ("flex", "flex AND in_tok <= long_cut")):
    # Whitespace differs between the two existing lines.
    pattern = rf"sum\(cw\)\s+FILTER \(WHERE {re.escape(condition)}\) AS {tier}_cw,"
    ROLLUP_SQL = re.sub(pattern, lambda m: m[0] + " " + ", ".join(
        f"sum({alias}) FILTER (WHERE {condition}) AS {tier}_{field}"
        for field, alias in WRITE_ALIASES.items()) + ",", ROLLUP_SQL)
ROLLUP_SQL = ROLLUP_SQL.replace(
    "(payload->'usage'->>'output_tokens')::bigint AS out_tok,",
    ", ".join(f"{expr} AS {WRITE_ALIASES[field]}" for field, expr in write_sql().items()) +
    ", (payload->'usage'->>'output_tokens')::bigint AS out_tok,")


def psql(sql: str) -> str:
    # The engine sets no PG* vars (ADR 0481); the workspace URL is the only way in.
    r = subprocess.run(
        ["psql", os.environ["LUCIDOS_DATABASE_URL"], "-A", "-t", "-c", sql],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        sys.exit(f"psql failed: {r.stderr.strip()}")
    return r.stdout.strip()


# Voice seconds, bucketed exactly like the token rows above.
#
# `VoiceSessionEnded` names no model, so each session is attributed to a voice
# `ContextCaptured` row: the last one in the SAME thread at or before the
# hangup, which is the session that just ended. Sessions without such a row
# (no frame or an early failure) fall back to the nearest voice row in time
# anywhere in the store. Nearest in TIME, not the latest before. A session with no voice row within a day of it
# is dropped rather than guessed at.
#
# The candidate rows are materialised once. There is no index on the payload's
# purpose, so a correlated subquery would rescan the whole events table per
# session.
SECONDS_SQL = (
    """
COPY (
  WITH voice_calls AS MATERIALIZED (
    SELECT thread_id, sequence, created, payload->>'session' AS session,
           """
    + producer_id_sql("payload")
    + """ AS producer,
           """
    + ROW_MODEL
    + """ AS model
    FROM events
    WHERE event_type = 'ContextCaptured' AND payload->>'purpose' = 'voice'
  )
  SELECT coalesce(json_agg(row_to_json(t)), '[]'::json) FROM (
    SELECT
      to_char("""
    + E_DAY
    + """, 'YYYY-MM-DD') AS day,
      """
    + E_HOUR
    + """ AS hour,
      m.producer,
      m.model,
      e.thread_id::text AS thread,
      m.session,
      sum((e.payload->>'duration_secs')::bigint) AS seconds
    FROM events e
    CROSS JOIN LATERAL (
      SELECT c.producer, c.model,
             CASE WHEN c.thread_id = e.thread_id THEN c.session END AS session
      FROM voice_calls c
      WHERE abs(extract(epoch FROM c.created - e.created)) < 86400
      ORDER BY
        (c.thread_id = e.thread_id AND c.sequence <= e.sequence) DESC,
        abs(extract(epoch FROM c.created - e.created))
      LIMIT 1
    ) m
    WHERE e.event_type = 'VoiceSessionEnded'
      AND e.payload->>'duration_secs' IS NOT NULL
      AND e.sequence <= %(max_seq)s
      AND """
    + E_DAY
    + """ = ANY (%(days)s)
    GROUP BY 1, 2, 3, 4, 5, 6
  ) t
) TO STDOUT;
"""
)


# Bump this whenever the aggregation changes in a way that makes days already
# in daily.json wrong. The incremental path only revisits days that gained
# rows, so without it an install keeps its old numbers for every past day.
# A file stamped lower (or not at all) gets one full rebuild on the next run,
# with nothing for the user to do. History:
#   1  everything before the stamp existed
#   2  2026-10-02: long-context split uses the same card the app prices with
#   3  2026-10-10: the split uses the card in force on the row's own day
#      (pricing.json now keeps a dated price history per model)
#   4  2026-10-10: a call is long only OVER the threshold unless its card says
#      `inclusive`; a tier-less card splits at the global threshold; Bedrock
#      and dotted Claude ids find their card, as in the app
#   5  2026-10-10: a row is filed under the model it is priced as (the
#      served model on a reroute) and carries `routed_from`. The split
#      fingerprint also moves, but only when pricing.json has a tier.
#   6  2026-10-13: a call served on OpenAI's Flex tier (`usage.service_tier`)
#      is kept apart in `flex`, which the app prices at the card's `flex` rates
#   7  2026-10-19: rows count `cached_calls` (calls that read any cache), and
#      the same pass writes the per-thread file, threads-daily.json
#   8  2026-10-19: a cache keep-alive ping is filed under its own type,
#      `cache_keep_alive`, rather than under claude_code
#   9  2026-10-19: a row is filed under the reply's `served_model` whenever
#      it has one, so `claude-opus-5-5[1m]` and `claude-opus-5-5` are one row
#  10  2026-10-19: a call that names its `reasoning_effort` is filed under
#      producer|model|effort, so the app can group by model and effort
#  11  2026-10-19: a row id drops its `[1m]` suffix, so a call from before
#      the engine recorded `served_model` joins its bare id's row too
#  12  2026-10-20: an auxiliary call is filed under `auxiliary:<purpose>`
#      (bare `auxiliary` with no purpose), so history splits per sub-producer
#  13  2026-10-21: a Lucidos Agent call is filed under `main_llm:<origin>`
#      (chat, trigger, other; bare `main_llm` when the thread's origin is
#      unknown), and daily.json carries `thread_origins` for the live tail
#  14  2026-10-23: the thread file splits each thread by agent session
#      (`<thread>@<session>`), the frame dedupe compares calls only within one
#      session, and a thread's meta names the thread it succeeded
#  15  evidenced 1-hour/12-hour write counts, per tier; unknown-lifetime
#      calls stay separate so they cannot hide other calls' priced spend
ROLLUP_VERSION = 15


# A thread row is a flat list in this order, trailing zeros dropped. Most
# threads never touch a long or Flex call, so most rows stop after `max_in`.
# Spelled out as objects, the file ran to several megabytes.
THREAD_FIELDS = (
    "calls", "cached_calls", "in", "cache_read", "cache_write", "out", "seconds", "max_in",
    "long.in", "long.cache_read", "long.cache_write", "long.out",
    "flex.in", "flex.cache_read", "flex.cache_write", "flex.out",
    *(prefix + field for prefix in ("", "long.", "flex.") for field in WRITE_FIELDS),
)


def row_key(producer: str, model: str, effort: str | None = None, cache_unknown=False) -> str:
    """A bucket's key: producer|model, plus |effort when the call named one.
    A reader that splits on `|` and takes the first two parts still gets the
    producer and the model."""
    if cache_unknown:
        return f"{producer}|{model}|{effort or ''}|cache_ttl_unknown"
    return f"{producer}|{model}|{effort}" if effort else f"{producer}|{model}"


def thread_slot(tid: str, session) -> str:
    """A thread file key: `<thread>@<session>` for a call that names its agent
    session, the bare thread id for one written before the engine stamped it
    (and for Jev, which has no thread). The app splits on the last `@`."""
    return f"{tid}@{session}" if tid and session not in (None, "") else tid


def slot_thread(slot: str) -> str:
    """The thread id of a thread file key."""
    return slot.rpartition("@")[0] if "@" in slot else slot


def thread_row(b: dict) -> list:
    """One bucket as a THREAD_FIELDS list."""
    out = []
    for f in THREAD_FIELDS:
        head, _, sub = f.partition(".")
        out.append(int((b.get(head) or {}).get(sub, 0) if sub else b.get(head, 0) or 0))
    while out and out[-1] == 0:
        out.pop()
    return out


# A plain SELECT, not COPY like the queries above: COPY's text format doubles
# every backslash, and a title or first message holding one is no longer JSON.
#
# `successor_of` names the thread a legacy successor thread took over from.
# Handoffs now start a successor session inside the same thread, so no new
# row sets it, but the old chains keep the link. The app folds a chain into
# its first thread, so one piece of work is one row whether it handed off the
# old way or the new one.
THREAD_META_SQL = """
SELECT coalesce(json_object_agg(thread_id::text, json_build_array(
  coalesce(nullif(title, ''), left(first_message, 80), ''), parent_thread_id::text,
  successor_of::text)), '{}'::json)
FROM thread_summaries;
"""


# When each agent session made its first and last call, so the app can show a
# session's time span. Keyed like the thread file (`<thread>@<session>`). Calls
# from before the engine stamped sessions get none: they are ten thousand bare
# threads, and their spans would add a megabyte for a row that rarely shows.
# Read only for the calls since the cursor and merged into the spans already
# on file, so an hourly run does not rescan history. A plain SELECT, as
# THREAD_META_SQL.
SESSION_SPANS_SQL = """
SELECT coalesce(json_object_agg(slot, span), '{}'::json) FROM (
  SELECT thread_id::text || '@' || (payload->>'session') AS slot,
         json_build_array(
           to_char(min(created) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           to_char(max(created) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')) AS span
  FROM events
  WHERE event_type = 'ContextCaptured'
    AND payload->'usage' IS NOT NULL
    AND thread_id IS NOT NULL
    AND coalesce(payload->>'session', '') <> ''
    AND sequence > %(since)s AND sequence <= %(max_seq)s
  GROUP BY 1
) s;
"""


def session_spans(old: dict | None, since: int, max_seq: int) -> dict:
    """`old` with the spans of the calls in (since, max_seq] folded in: the
    earliest first call and the latest last call per slot. ISO UTC strings
    compare in time order. A failed read keeps the old spans, as a missing
    span only hides the time on a session row."""
    spans = {k: list(v) for k, v in (old or {}).items() if isinstance(v, list) and len(v) == 2}
    try:
        new = json.loads(psql(SESSION_SPANS_SQL.replace("%(since)s", str(since))
                              .replace("%(max_seq)s", str(max_seq))) or "{}")
    except (SystemExit, ValueError):
        return spans
    if not isinstance(new, dict):
        return spans
    for slot, (first, last) in new.items():
        was = spans.get(slot)
        spans[slot] = [min(was[0], first), max(was[1], last)] if was else [first, last]
    return spans


def thread_meta(tids: set) -> dict:
    """Title, parent and predecessor for every thread in the file, plus each
    one's ancestors and predecessors, so the app can fold a sub-thread into
    its root, and a successor thread into the chain it continues, even when
    that root made no call. Each entry is [title], [title, parent] or
    [title, parent or None, predecessor]. A thread the summaries no longer
    hold is left out, and the app shows it under its id."""
    try:
        doc = json.loads(psql(THREAD_META_SQL) or "{}")
    except (SystemExit, ValueError):
        return {}
    if not isinstance(doc, dict):
        return {}
    meta, todo = {}, [slot_thread(t) for t in tids if t]
    while todo:
        t = todo.pop()
        if t in meta or t not in doc:
            continue
        title, parent, before = (list(doc[t]) + [None, None])[:3]
        meta[t] = [title, parent, before] if before else [title, parent] if parent else [title]
        todo.extend(x for x in (parent, before) if x)
    return meta


# The Lucidos Agent (`main_llm`) runs both the chats a person starts and the
# runs a trigger fires, and the call itself does not say which. Its thread
# does: thread_summaries records who started it (`initiator`), the trigger
# that opened it (`trigger_id`, `source` = trigger) and its parent. So an agent
# call is filed under `main_llm:<origin>`:
#   trigger  the thread, or its root, was opened by a trigger
#   chat     the root was started by a person
#   other    the root was started by the system with no trigger: a message from
#            another workspace, the API, plugin setup, a spawn with no parent
# A sub-thread takes its root's origin, so a trigger's spawned work counts as
# the trigger's. When the summaries cannot say (the thread or an ancestor is no
# longer there, or the parents loop) the call keeps the bare `main_llm`, which
# the app shows as "Origin unknown". Nothing is guessed as chat.
#
# Measured 2026-10-21: every thread holding a main_llm call has a summary, and
# a trigger never fires into a chat thread, so the thread is a clean key. A
# person's reply inside a trigger's thread counts as the trigger's (142 of the
# 2,716 calls in trigger threads over 14 days).
#
# The other producers keep their ids: auxiliary calls stay auxiliary, Claude
# Code stays Claude Code, whatever thread they ran in.
AGENT = "main_llm"
ORIGINS = ("chat", "trigger", "other")
# daily.json lists the origins of threads active this recently, so the app can
# file a live call before the next rollup. A thread newer than the last rollup
# is looked up through the thread list instead.
ORIGIN_WINDOW_DAYS = 14
ORIGIN_SQL = f"""
SELECT coalesce(json_object_agg(thread_id::text, json_build_array(
  source, initiator, trigger_id, parent_thread_id::text,
  last_activity > now() - interval '{ORIGIN_WINDOW_DAYS} days')), '{{}}'::json)
FROM thread_summaries;
"""


def classify_origins(doc: dict) -> dict:
    """Thread id -> chat | trigger | other, from ORIGIN_SQL's rows
    ([source, initiator, trigger_id, parent, recent]). A thread whose origin
    cannot be read is left out. The app's originOfSummary() is the same rule."""
    out: dict = {}
    for start in doc:
        path, t, origin = [], start, None
        while t is not None and t not in out:
            rec = doc.get(t)
            if rec is None or t in path:
                break
            path.append(t)
            source, initiator, trigger_id, parent = rec[0], rec[1], rec[2], rec[3]
            if trigger_id or source == "trigger":
                origin = "trigger"
                break
            if not parent:
                origin = "chat" if initiator == "user" else "other"
                break
            t = parent
        else:
            origin = out.get(t)
        if origin is not None:
            for p in path:
                out[p] = origin
    return out


def agent_producer(producer: str, tid: str, origins: dict) -> str:
    """The producer id a row is filed under: `main_llm:<origin>` for an agent
    call whose thread origin is known, else the producer as it came."""
    if producer != AGENT or not tid or tid not in origins:
        return producer
    return f"{AGENT}:{origins[tid]}"


# HANDOFFS, IN A THIRD FILE
# -------------------------
# A handoff ends a session and starts a successor session in the same thread
# (`SessionStarted.continuity.kind = handoff`). Before that existed, it started
# a successor thread (`SuccessorThreadSpawned`); those are reported too, as
# kind `thread`, so old and new handoffs compare like for like.
#
# Per handoff, artifacts/token-cost/handoffs.json records three token bundles
# in THREAD_FIELDS rows keyed producer|model[|effort], which the app prices:
#   narrative  the old session's calls after its last turn end, checkpoint or
#              successor request before the handoff: the turn that wrote the
#              handoff narrative. A warm handoff (opening `narrative`) has one.
#              A cold one (opening `brief`) has none: the engine wrote the
#              brief, so the field is null.
#   before     the old session's last HANDOFF_WINDOW calls before that turn
#   after      the new session's first HANDOFF_WINDOW calls
# Only main-session calls count: Claude Code or Codex, no sub-agent call (it
# runs in its own context) and no cache keep-alive ping (it repeats the
# context without doing work). The windows compare cost per call on either
# side of the boundary, which is what the handoff estimate's verdict (`pays`
# on the HandoffCheckpointReached it read) predicted. The file is rebuilt
# whole on every run: handoffs are rare, and a window can grow after the
# handoff itself.
HANDOFFS_OUT = WS / "data" / "artifacts" / "token-cost" / "handoffs.json"
HANDOFF_WINDOW = 20
HANDOFF_EVENTS = ("SessionStarted", "SessionHandedOff", "CodingAgentIdled",
                  "HandoffCheckpointReached", "SuccessorRequested", "SuccessorThreadSpawned")
# A turn end, a checkpoint or a successor request: the narrative turn starts
# after the last of these before the handoff.
TURN_MARKS = ("CodingAgentIdled", "HandoffCheckpointReached", "SuccessorRequested")
# The continuity kinds that open a new session, as the engine counts them
# (session_scope.rs). A resume stays in its session; the first is session 1.
OPENING_KINDS = ("fresh", "handoff")

# Threads that handed off either way, and the successor threads of the old way.
_HANDOFF_THREADS = """(
  SELECT thread_id FROM events
  WHERE (event_type = 'SessionStarted' AND payload->'continuity'->>'kind' = 'handoff')
     OR event_type = 'SuccessorThreadSpawned'
  UNION
  SELECT (payload->>'successor_thread_id')::uuid FROM events
  WHERE event_type = 'SuccessorThreadSpawned'
)"""

# Plain SELECTs, not COPY: a narrative message or a title may hold a backslash.
HANDOFF_EVENTS_SQL = (
    """
SELECT coalesce(json_agg(row_to_json(t) ORDER BY t.seq), '[]'::json) FROM (
  SELECT thread_id::text AS thread, sequence AS seq, event_type AS type,
         to_char("""
    + LOCAL_DAY
    + """, 'YYYY-MM-DD') AS day,
         to_char(created AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at,
         payload->'continuity'->>'kind' AS continuity,
         coalesce(payload->'continuity'->>'opening', payload->>'opening') AS opening,
         coalesce(payload->'continuity'->>'checkpoint', payload->>'checkpoint', payload->>'name') AS checkpoint,
         coalesce(payload->'continuity'->>'progress',
                  CASE WHEN jsonb_typeof(payload->'progress') = 'object'
                       THEN (payload->'progress'->>'done') || '/' || (payload->'progress'->>'total')
                       ELSE payload->>'progress' END) AS progress,
         payload->>'coding_agent' AS coding_agent,
         payload->>'pays' AS pays,
         payload->>'successor_thread_id' AS successor
  FROM events
  WHERE event_type IN ("""
    + ", ".join(f"'{e}'" for e in HANDOFF_EVENTS)
    + """)
    AND sequence <= %(max_seq)s
    AND thread_id IN """
    + _HANDOFF_THREADS
    + """
) t;
"""
)

HANDOFF_CALLS_SQL = (
    """
SELECT coalesce(json_agg(row_to_json(t) ORDER BY t.seq), '[]'::json) FROM (
  SELECT c.thread_id::text AS thread, c.sequence AS seq,
         c.payload->>'session' AS session,
         c.payload->>'producer' AS producer,
         """
    + row_model_sql("c.payload->>'model'", "c.payload->>'served_model'")
    + """ AS model,
         coalesce(c.payload->>'reasoning_effort', '') AS effort,
         (c.payload->'usage'->>'input_tokens')::bigint AS in_tok,
         coalesce((c.payload->'usage'->>'cache_read_tokens')::bigint, 0) AS cr,
         coalesce((c.payload->'usage'->>'cache_creation_tokens')::bigint, 0) AS cw,
         c.payload->'usage' AS usage,
         (c.payload->'usage'->>'output_tokens')::bigint AS out_tok,
         coalesce(c.payload->'usage'->>'service_tier', '') = 'flex' AS flex,
         (c.payload->'usage'->>'input_tokens')::bigint > """
    + LONG_CUT_MARK
    + """ AS long
  FROM events c
  WHERE c.event_type = 'ContextCaptured'
    AND c.payload->'usage' IS NOT NULL
    AND c.payload->>'producer' IN ('claude_code', 'codex')
    AND c.payload->>'parent_tool_use_id' IS NULL
    AND c.sequence <= %(max_seq)s
    AND c.thread_id IN """
    + _HANDOFF_THREADS
    + """
    AND NOT """
    + KEEP_ALIVE
    + """
) t;
"""
)


def call_bundles(calls: list) -> dict:
    """Calls as THREAD_FIELDS rows keyed producer|model[|effort], the shape
    the app prices. A Flex call over the long cut stays in `long` only."""
    out: dict = {}
    for c in calls:
        usage = c.get("usage") or {}
        ttl = write_bundle(usage)
        unknown = ttl["cache_write_known"] < int(c["cw"] or 0)
        b = out.setdefault(row_key(c["producer"], c["model"], c.get("effort"), unknown), {
            "calls": 0, "cached_calls": 0, "in": 0, "cache_read": 0, "cache_write": 0, "out": 0,
            "max_in": 0, "long": {"in": 0, "out": 0, "cache_read": 0, "cache_write": 0, **dict.fromkeys(WRITE_FIELDS, 0)},
            "flex": {"in": 0, "out": 0, "cache_read": 0, "cache_write": 0, **dict.fromkeys(WRITE_FIELDS, 0)}})
        tokens = {"in": int(c["in_tok"] or 0), "cache_read": int(c["cr"] or 0),
                  "cache_write": int(c["cw"] or 0), "out": int(c["out_tok"] or 0)}
        tokens.update(ttl)
        b["calls"] += 1
        b["cached_calls"] += tokens["cache_read"] > 0
        for k, v in tokens.items():
            b[k] = b.get(k, 0) + v
        b["max_in"] = max(b["max_in"], tokens["in"])
        part = "long" if c.get("long") else "flex" if c.get("flex") else None
        if part:
            for k, v in tokens.items():
                b[part][k] = b[part].get(k, 0) + v
    return {k: thread_row(b) for k, b in out.items()}


def implementer(call: dict | None, agent: str | None = None) -> str | None:
    """`producer|model[|effort]` of one call, or the backend alone when the
    session made no call yet."""
    if call is None:
        return {"claude-code": "claude_code", "codex": "codex"}.get(agent or "", agent)
    return row_key(call["producer"], call["model"], call.get("effort"))


def build_handoffs(events: list, calls: list) -> list:
    """One record per handoff, oldest first. See HANDOFFS, IN A THIRD FILE."""
    ev_by: dict = {}
    for e in events:
        ev_by.setdefault(e["thread"], []).append(e)
    calls_by: dict = {}
    for c in calls:
        calls_by.setdefault(c["thread"], []).append(c)
    for v in list(ev_by.values()) + list(calls_by.values()):
        v.sort(key=lambda r: int(r["seq"]))

    def last_before(rows, seq, types, pred=lambda r: True):
        hit = None
        for r in rows:
            if int(r["seq"]) >= seq:
                break
            if r["type"] in types and pred(r):
                hit = r
        return hit

    def record(thread, to_thread, at_event, old, new, mark_end, opening, kind, sessions, agent, since):
        # Only the old session's own marks: a checkpoint read in an earlier
        # session says nothing about this handoff.
        evs = [r for r in ev_by.get(thread, []) if int(r["seq"]) > since]
        anchor = last_before(evs, mark_end, TURN_MARKS)
        cut = int(anchor["seq"]) if anchor else -1
        warm = opening != "brief"
        narrative = [c for c in old if int(c["seq"]) > cut] if warm else []
        before = [c for c in old if not warm or int(c["seq"]) <= cut][-HANDOFF_WINDOW:]
        checkpoint = at_event.get("checkpoint")
        reading = last_before(evs, int(at_event["seq"]), ("HandoffCheckpointReached",),
                              lambda r: checkpoint is None or r.get("checkpoint") == checkpoint)
        if checkpoint is None and reading is not None:
            checkpoint = reading.get("checkpoint")
        pays = (reading or {}).get("pays")
        return {
            "kind": kind,
            "thread": thread,
            "to_thread": to_thread,
            "from_session": sessions[0],
            "to_session": sessions[1],
            "day": at_event["day"],
            "at": at_event["at"],
            "opening": opening,
            "checkpoint": checkpoint,
            "progress": at_event.get("progress") or (reading or {}).get("progress"),
            "pays": None if pays in (None, "") else str(pays).lower() == "true",
            "from": implementer(old[-1] if old else None),
            "to": implementer(new[0] if new else None, agent),
            "narrative": call_bundles(narrative) if warm else None,
            "before": call_bundles(before),
            "after": call_bundles(new[:HANDOFF_WINDOW]),
        }

    out = []
    for thread, evs in ev_by.items():
        tcalls = calls_by.get(thread, [])
        opened, session_start = 0, -1
        for e in evs:
            if e["type"] == "SessionStarted" and e.get("continuity") in OPENING_KINDS:
                opened += 1
                since, session_start = session_start, int(e["seq"])
                if e["continuity"] != "handoff":
                    continue
                n = opened + 1
                seq = int(e["seq"])
                handed = last_before(evs, seq, ("SessionHandedOff",))
                old = [c for c in tcalls if c.get("session") == str(n - 1) and int(c["seq"]) < seq]
                new = [c for c in tcalls if c.get("session") == str(n)]
                out.append(record(thread, thread, e, old, new,
                                  int(handed["seq"]) if handed else seq,
                                  e.get("opening") or (handed or {}).get("opening"),
                                  "session", [n - 1, n], e.get("coding_agent"), since))
            elif e["type"] == "SuccessorThreadSpawned" and e.get("successor"):
                seq = int(e["seq"])
                old = [c for c in tcalls if int(c["seq"]) < seq]
                if old and old[-1].get("session"):
                    old = [c for c in old if c.get("session") == old[-1]["session"]]
                succ = calls_by.get(e["successor"], [])
                first = succ[0].get("session") if succ else None
                new = [c for c in succ if c.get("session") == first]
                # A successor thread's opening was not recorded: `null`, and
                # its last turn is measured as the narrative turn.
                out.append(record(thread, e["successor"], e, old, new, seq, None, "thread",
                                  [old[-1].get("session") if old else None, first], None, session_start))
    out.sort(key=lambda r: r["at"] or "")
    return out


def handoffs_payload(long_cut: str, max_seq: int) -> dict:
    """handoffs.json, from two reads."""
    fill = lambda sql: sql.replace("%(max_seq)s", str(max_seq)).replace(LONG_CUT_MARK, long_cut)
    events = json.loads(psql(fill(HANDOFF_EVENTS_SQL)) or "[]")
    calls = json.loads(psql(fill(HANDOFF_CALLS_SQL)) or "[]")
    return {
        "generated": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "last_sequence": max_seq,
        "window": HANDOFF_WINDOW,
        "fields": list(THREAD_FIELDS),
        "note": (
            "One record per handoff. kind `session`: a successor session in the same thread "
            "(SessionStarted continuity handoff); kind `thread`: a legacy successor thread "
            "(SuccessorThreadSpawned), whose opening was not recorded. opening `narrative` is warm "
            "(the old session wrote the handoff narrative), `brief` is cold (the engine wrote a brief, "
            "so narrative is null). narrative, before and after are token rows in `fields` order keyed "
            "producer|model[|effort]: the narrative turn, the old session's last `window` main-session "
            "calls before it, and the new session's first `window`. Main-session calls only: Claude "
            "Code or Codex, no sub-agent call, no cache keep-alive. checkpoint is the handoff "
            "checkpoint it ran at, pays the verdict the handoff estimate gave there. threads maps "
            "each thread id to its title."
        ),
        "handoffs": build_handoffs(events, calls),
    }


# A separate, prompt-free evidence file leaves all older rollups and the
# Thread cost snapshot readable. A full ordered read retains TTL and session
# evidence across the range boundary. Prices stay in the app's price table.
# Keep-alive statuses are few and read whole first; every other event streams
# one JSON row per line, so millions of calls never sit in memory at once.
CACHE_STATUS_SQL = """
SELECT coalesce(json_agg(row_to_json(t) ORDER BY t.seq), '[]'::json) FROM (
  SELECT thread_id::text AS thread, sequence AS seq,
         to_char(created AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at,
         payload->'status' AS status
    FROM events WHERE event_type = 'CacheKeepAliveStatusChanged'
) t;
"""
CACHE_SQL = """
SELECT row_to_json(t) FROM (
  SELECT id::text AS id, thread_id::text AS thread, sequence AS seq,
         event_type AS type,
         to_char(""" + LOCAL_DAY + """, 'YYYY-MM-DD') AS day,
         to_char(created AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at,
         """ + ROW_MODEL + """ AS model,
         payload->>'producer' AS producer, payload->>'purpose' AS purpose,
         payload->>'session' AS session, payload->>'parent_tool_use_id' AS parent,
         payload->>'request_event_id' AS anchor,
         payload->>'reasoning_effort' AS effort,
         (payload->>'duration_ms')::float8 AS duration_ms,
         payload->'usage' AS usage,
         (payload->'usage'->>'input_tokens')::bigint > """ + LONG_CUT_MARK + """ AS long,
         payload->'origin'->'reason'->>'kind' = 'cache_keep_alive' AS keep_alive,
         payload->'continuity'->>'kind' AS continuity,
         payload->>'successor_thread_id' AS successor
    FROM events
   WHERE (event_type = 'ContextCaptured' AND payload->'usage' IS NOT NULL)
      OR (event_type = 'PromptInjected' AND payload->'origin'->'reason'->>'kind' = 'cache_keep_alive')
      OR event_type IN ('SessionStarted', 'SuccessorThreadSpawned')
   ORDER BY sequence
) t;
"""


CACHE_HEAD_SQL = (
    "SELECT coalesce(max(sequence), 0) FROM events WHERE event_type IN "
    "('ContextCaptured', 'PromptInjected', 'SessionStarted', 'SuccessorThreadSpawned', "
    "'CacheKeepAliveStatusChanged');"
)


def psql_rows(sql: str):
    """Each row of a one-column query, parsed as JSON, as psql streams it.
    FETCH_COUNT makes psql read through a cursor instead of buffering all."""
    proc = subprocess.Popen(
        ["psql", os.environ["LUCIDOS_DATABASE_URL"], "-A", "-t", "-v", "FETCH_COUNT=5000", "-c", sql],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    for line in proc.stdout:
        if line.strip():
            yield json.loads(line)
    err = proc.stderr.read()
    if proc.wait():
        sys.exit(f"psql failed: {err.strip()}")


def write_cache_stats(long_cut: str, split: str) -> None:
    """Rebuild cache.json from every event, unless no event it reads, and no
    long-context cut, changed since the file was built."""
    head = psql(CACHE_HEAD_SQL)
    try:
        old = json.loads((WS / "data" / "artifacts" / "token-cost" / "cache.json").read_text())
    except (OSError, ValueError):
        old = None
    if (isinstance(old, dict) and old.get("version") == CACHE_VERSION and old.get("split") == split
            and old.get("last_sequence") == int(head or 0)):
        return
    summaries = json.loads(psql(ORIGIN_SQL) or "{}")
    if not isinstance(summaries, dict):
        sys.exit("not rolling up cache stats: thread_summaries did not read as an object")
    origins = classify_origins(summaries)
    statuses = json.loads(psql(CACHE_STATUS_SQL) or "[]")
    payload = build_cache(psql_rows(CACHE_SQL.replace(LONG_CUT_MARK, long_cut)), TZ, statuses,
                          lambda producer, tid: agent_producer(producer, tid, origins))
    payload["split"] = split
    result = subprocess.run(
        ["lucidos", "data", "write", "artifacts/token-cost/cache.json", "--from", "-"],
        input=json.dumps(payload, separators=(",", ":")), capture_output=True, text=True)
    if result.returncode:
        sys.exit(f"cache stats write failed: {result.stderr.strip()[:400]}")


def dumps_by_day(doc: dict) -> str:
    """Compact JSON with each top-level key, each day under `days` and
    `hours`, and each session span under `sessions`, on its own line. Still one valid document. The engine commits
    every write to the workspace git, and on one 3 MB line an hourly run that
    touched only today rewrote the whole line; this way git stores a delta of
    the days that changed."""
    c = lambda v: json.dumps(v, separators=(",", ":"))
    parts = []
    for k, v in doc.items():
        if k in ("days", "hours", "sessions") and isinstance(v, dict):
            inner = ",\n".join(f"{c(d)}:{c(x)}" for d, x in v.items())
            parts.append(f"{c(k)}:{{\n{inner}\n}}")
        else:
            parts.append(f"{c(k)}:{c(v)}")
    return "{\n" + ",\n".join(parts) + "\n}\n"


def needs_rebuild(state: dict | None, env: dict, split: str | None = None) -> str | None:
    """Why this run must rebuild every day, or None to run incrementally.

    `split` is this run's split_signature(). A daily.json split under other
    thresholds is rebuilt, since the incremental path would only re-split
    the days that gained rows.
    """
    if env.get("TOKEN_COST_REBUILD") == "1":
        return "TOKEN_COST_REBUILD=1"
    if state is None:
        return None
    have = int(state.get("rollup_version", 1) or 1)
    if have < ROLLUP_VERSION:
        return f"daily.json is from rollup version {have}, this is {ROLLUP_VERSION}"
    if split is not None and state.get("long_split") != split:
        return "the long-context thresholds in the price table changed"
    return None


def migrate_legacy_prices() -> None:
    """Move Token Cost 0.4.x prices into the price table before reading it,
    so a model priced only in the old pricing.json splits and prices at its
    own card. Never stops the rollup: a failure is one printed line, and the
    next run tries again. A fixed test table has no engine to write to."""
    if PRICE_TABLE or not MIGRATE.exists():
        return
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location("migrate_prices", MIGRATE)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        line = mod.run_quietly(WS)
    except Exception as e:  # noqa: BLE001 - nothing here may stop the rollup
        line = f"price migration failed to load: {e}"
    if line:
        print(line)


def main() -> None:
    migrate_legacy_prices()
    try:
        # Split on the model the row is filed and priced under, so a rerouted
        # call splits at the card of the model that ran.
        long_cut = long_cutoff_sql(ROW_MODEL, LOCAL_DAY)
    except PricingUnreadable as e:
        sys.exit(f"not rolling up: {e}")
    split = split_signature(long_cut)
    existing = json.loads(OUT.read_text()) if OUT.exists() else None
    why = needs_rebuild(existing, os.environ, split)
    threads_state = json.loads(THREADS_OUT.read_text()) if THREADS_OUT.exists() else None
    # The two files are cut from one pass and share a cursor. If the thread
    # file is missing or behind (its write failed, or it predates this
    # version), an incremental run would leave its untouched days empty.
    if not why and existing is not None and (
        threads_state is None or threads_state.get("last_sequence") != existing.get("last_sequence")
    ):
        why = "threads-daily.json is missing or out of step with daily.json"
    if why:
        print(f"rebuilding every day: {why}")

    if existing is not None and not why:
        state = existing
    else:
        state = {"last_sequence": 0, "days": {}}

    since = int(state.get("last_sequence", 0))

    # Which days gained rows, and the new high-water sequence. One cheap scan.
    head = psql(
        "SELECT coalesce(max(sequence), 0) || '|' || "
        f"coalesce(string_agg(DISTINCT to_char({LOCAL_DAY}, 'YYYY-MM-DD'), ','), '') "
        "FROM events WHERE event_type IN ('ContextCaptured', 'VoiceSessionEnded') "
        f"AND sequence > {since};"
    )
    max_seq_s, _, day_list = head.partition("|")
    max_seq = int(max_seq_s or 0)
    touched = sorted(d for d in day_list.split(",") if d)

    if not touched:
        # Status-only changes and upgrades without new calls still refresh
        # the cache views. Failed queries/writes stop loudly.
        write_cache_stats(long_cut, split)
        print(f"no new ContextCaptured rows above sequence {since}")
        return

    day_array = "ARRAY[" + ",".join(f"'{d}'::date" for d in touched) + "]"
    # Every query stops at `max_seq`, the cursor this run writes. The app
    # counts every row above the cursor live, so a row that landed while the
    # rollup ran (a minute or more on a rebuild) would be in both the stored
    # day and the live tail, and counted twice until the next run.
    ceiling = lambda sql: sql.replace("%(days)s", day_array).replace("%(max_seq)s", str(max_seq))
    rows = json.loads(psql(ceiling(ROLLUP_SQL.replace(LONG_CUT_MARK, long_cut))))
    # A failed read stops the run (psql exits): carrying on would file every
    # agent call of the touched days as unknown, and an incremental run never
    # revisits them.
    summaries = json.loads(psql(ORIGIN_SQL) or "{}")
    if not isinstance(summaries, dict):
        sys.exit("not rolling up: thread_summaries did not read as an object")
    origins = classify_origins(summaries)

    # Diagnostic only, and counted separately: the rollup query filters the
    # duplicates out inside the same subquery, so it cannot also count them.
    raw_rows = int(
        psql(
            ceiling(
                "SELECT count(*) FROM events WHERE event_type = 'ContextCaptured' "
                "AND payload->'usage' IS NOT NULL AND sequence <= %(max_seq)s "
                f"AND {LOCAL_DAY} = ANY (%(days)s);"
            )
        )
        or 0
    )

    def blank() -> dict:
        return {
            "calls": 0,
            "in": 0,
            "cache_read": 0,
            "cache_write": 0,
            **dict.fromkeys(WRITE_FIELDS, 0),
            "out": 0,
            "seconds": 0,
            "buckets": [0] * 6,
            "long": {"in": 0, "out": 0, "cache_read": 0, "cache_write": 0, **dict.fromkeys(WRITE_FIELDS, 0)},
            "flex": {"in": 0, "out": 0, "cache_read": 0, "cache_write": 0, **dict.fromkeys(WRITE_FIELDS, 0)},
            "max_in": 0,
            "cached_calls": 0,
        }

    def fold(dst: dict, x: dict) -> None:
        dst["calls"] += int(x["calls"])
        dst["cached_calls"] = dst.get("cached_calls", 0) + int(x.get("cached_calls") or 0)
        dst["in"] += int(x["total_in"])
        dst["cache_read"] += int(x["cache_read"])
        dst["cache_write"] += int(x["cache_write"])
        for prefix, dest in (("", dst), ("long_", dst["long"]), ("flex_", dst["flex"])):
            for field in WRITE_FIELDS:
                dest[field] = dest.get(field, 0) + int(x.get(prefix + field) or 0)
        dst["out"] += int(x["out_tok"])
        dst.setdefault("seconds", 0)
        for i in range(6):
            dst["buckets"][i] += int(x[f"b{i}"])
        dst["long"]["in"] += int(x["long_in"] or 0)
        dst["long"]["out"] += int(x["long_out"] or 0)
        dst["long"]["cache_read"] += int(x["long_cr"] or 0)
        dst["long"]["cache_write"] += int(x["long_cw"] or 0)
        # A Flex call over the long cut stays in `long`, so no token is priced
        # twice. Compactor calls, the ones that ask for Flex, are never long.
        flex = dst.setdefault("flex", {"in": 0, "out": 0, "cache_read": 0, "cache_write": 0, **dict.fromkeys(WRITE_FIELDS, 0)})
        flex["in"] += int(x.get("flex_in") or 0)
        flex["out"] += int(x.get("flex_out") or 0)
        flex["cache_read"] += int(x.get("flex_cr") or 0)
        flex["cache_write"] += int(x.get("flex_cw") or 0)
        dst["max_in"] = max(dst["max_in"], int(x["max_in"]))
        # Calls another model answered, by the id Lucidos asked for. Absent
        # on nearly every bucket, so it is only written when it has a count.
        if x.get("asked"):
            routed = dst.setdefault("routed_from", {})
            routed[x["asked"]] = routed.get(x["asked"], 0) + int(x["calls"])

    days = state.get("days", {})
    hours = state.get("hours", {})
    # Per thread, as full buckets while folding. Untouched days are carried
    # over from the thread file as they are, already in row form.
    t_days = {} if why or threads_state is None else dict(threads_state.get("days", {}))
    t_hours = {} if why or threads_state is None else dict(threads_state.get("hours", {}))
    for d in touched:
        days[d] = {}
        hours[d] = {}
        t_days[d] = {}
        t_hours[d] = {}
    kept = 0
    # The query returns one row per (day, hour, producer, model, effort, thread). The
    # day totals are that summed over hours and threads, so no two views can
    # disagree.
    for x in rows:
        kept += int(x["calls"])
        tid = x.get("thread") or ""
        slot = thread_slot(tid, x.get("session"))
        key = row_key(agent_producer(x["producer"], tid, origins), x["model"], x.get("effort"), x.get("cache_unknown", False))
        hr = str(int(x["hour"]))
        fold(days[x["day"]].setdefault(key, blank()), x)
        fold(hours[x["day"]].setdefault(hr, {}).setdefault(key, blank()), x)
        fold(t_days[x["day"]].setdefault(slot, {}).setdefault(key, blank()), x)
        fold(t_hours[x["day"]].setdefault(hr, {}).setdefault(slot, {}).setdefault(key, blank()), x)

    # Voice seconds land in the same buckets, under their own field. A session
    # that started before midnight is filed on the day it ENDED, because that
    # is the row carrying its duration; at these volumes (a handful of calls a
    # day, none near midnight) splitting one across two days buys nothing.
    secs = json.loads(psql(ceiling(SECONDS_SQL)))
    total_secs = 0
    for x in secs:
        n = int(x["seconds"] or 0)
        total_secs += n
        tid = x.get("thread") or ""
        slot = thread_slot(tid, x.get("session"))
        key = row_key(agent_producer(x["producer"], tid, origins), x["model"])
        days[x["day"]].setdefault(key, blank())["seconds"] += n
        hr = str(int(x["hour"]))
        hours[x["day"]].setdefault(hr, {}).setdefault(key, blank())["seconds"] += n
        t_days[x["day"]].setdefault(slot, {}).setdefault(key, blank())["seconds"] += n
        t_hours[x["day"]].setdefault(hr, {}).setdefault(slot, {}).setdefault(key, blank())["seconds"] += n

    # Hourly detail only for the days a single-day selection can reach.
    keep_hours = set(sorted(days)[-HOURS_DAYS:])
    hours = {d: v for d, v in hours.items() if d in keep_hours}

    jev_calls, jev_tokens = fold_jev(days, hours, keep_hours)

    # Jev calls carry no thread, so they sit under the empty thread id, which
    # the app shows as "No thread". Copied from the day rows fold_jev just
    # rebuilt, so the thread file sums to exactly what daily.json says.
    jev_key = f"{JEV_PRODUCER}|{JEV_MODEL}"
    for d, bucket in days.items():
        t_days.setdefault(d, {}).get("", {}).pop(jev_key, None)
        if jev_key in bucket:
            t_days[d].setdefault("", {})[jev_key] = bucket[jev_key]
    for d, by_hour in hours.items():
        for hr, bucket in by_hour.items():
            t_hours.setdefault(d, {}).setdefault(hr, {}).get("", {}).pop(jev_key, None)
            if jev_key in bucket:
                t_hours[d][hr].setdefault("", {})[jev_key] = bucket[jev_key]
    t_hours = {d: v for d, v in t_hours.items() if d in keep_hours}

    # Buckets to rows. A day carried over from the old file is rows already.
    as_rows = lambda per_tid: {
        tid: {k: (b if isinstance(b, list) else thread_row(b)) for k, b in keys.items()}
        for tid, keys in per_tid.items()
    }
    t_days = {d: as_rows(v) for d, v in t_days.items()}
    t_hours = {d: {hr: as_rows(v) for hr, v in by_hour.items()} for d, by_hour in t_hours.items()}
    tids = {t for v in t_days.values() for t in v}
    handoffs = handoffs_payload(long_cut, max(max_seq, since))
    handoff_tids = {t for h in handoffs["handoffs"] for t in (h["thread"], h["to_thread"]) if t}
    meta = thread_meta(tids | handoff_tids)
    # A rebuild starts the spans over from the first call, as it does the
    # days. So does a thread file written before it carried spans.
    old_spans = None if why or threads_state is None else threads_state.get("sessions")
    spans = session_spans(old_spans, since if old_spans is not None else 0, max_seq)
    # Titles only: the app names a handoff's thread without loading the
    # thread file.
    handoffs["threads"] = {t: meta[t][0] for t in sorted(handoff_tids) if t in meta}

    payload = {
        "generated": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "last_sequence": max(max_seq, since),
        "rollup_version": ROLLUP_VERSION,
        "long_split": split,
        "bucket_edges": BUCKET_EDGES,
        "timezone": TZ,
        "hours_days": HOURS_DAYS,
        "note": (
            "cache_write_known is the write subset with evidenced lifetimes; "
            "cache_write_1h and cache_write_12h are its premium subsets, per tier. "
            "Unknown-lifetime calls use a separate fourth key component "
            "cache_ttl_unknown so a missing price cannot hide other calls' spend. "
            "'in' is TOTAL prompt size (uncached + cache_read + cache_write). "
            "uncached = in - cache_read - cache_write. 'long' is the subset of rows "
            "whose prompt went over the model's own long-context threshold (or "
            "reached it, on a card marked inclusive), from the price table's card "
            "in force on that day (272k on OpenAI's flagships, 100k on Haiku 5.5, "
            "200k elsewhere), for the long-context price tier. 'long_split' "
            "fingerprints those thresholds; a change rebuilds every day. "
            "A claude_code row whose usage tuple repeats the previous row in the same "
            "thread and agent session is dropped as a re-delivered streaming frame, not counted as a "
            "second call. Other producers are never collapsed. A claude_code call made "
            "by a cache keep-alive (its request_event_id names a PromptInjected with "
            "engine reason cache_keep_alive) is filed under the cache_keep_alive type. "
            "A row is filed under "
            "the model the provider answered with: the reply's `served_model` when it "
            "has one, else the requested model, less a [1m] suffix, and is priced as that model; "
            "'routed_from' counts calls a different model answered (a reroute) by the "
            "id that was asked for. A call that names its reasoning_effort is keyed "
            "producer|model|effort, else producer|model. An auxiliary call is filed "
            "under the producer id auxiliary:<purpose> (bare auxiliary when it has no "
            "purpose), e.g. auxiliary:memory. A Lucidos Agent call is filed under "
            "main_llm:<origin>, the origin of its thread's root in thread_summaries: "
            "trigger (a trigger opened it), chat (a person started it) or other (the "
            "system started it with no trigger); bare main_llm when that cannot be read. "
            f"'thread_origins' lists, per origin, the threads active in the last "
            f"{ORIGIN_WINDOW_DAYS} days, so a live call can be filed before the next run. "
            "'seconds' is voice "
            "session wall-clock time, for a model billed by the minute rather than by "
            "tokens, taken from VoiceSessionEnded.duration_secs. Days are bucketed in "
            f"the local timezone ({TZ}). 'hours' holds the same shape keyed by local "
            f"hour, for the most recent {HOURS_DAYS} days only. "
            "jev_browser rows do NOT come from ContextCaptured: the jev-browser loop "
            "posts to TypeSafe through the `lucidos proxy` CLI from a subprocess, so "
            "the engine never sees the call and emits no event. Those rows are read "
            "from the per-drive result.json files on disk instead, which record a "
            "`requests` count. Tokens are the measured mean per decision call, so the "
            "count is exact and the token figure is an estimate; see JEV_TOKENS_PER_CALL."
        ),
        "thread_origins": {
            o: sorted(t for t, rec in summaries.items() if rec[4] and origins.get(t) == o) for o in ORIGINS
        },
        "days": days,
        "hours": hours,
    }

    threads_payload = {
        "generated": payload["generated"],
        "last_sequence": payload["last_sequence"],
        "rollup_version": ROLLUP_VERSION,
        "fields": list(THREAD_FIELDS),
        "note": (
            "The rows of daily.json split by thread and agent session: "
            "days[day][slot][producer|model[|effort]] and hours[day][hour][slot][producer|model[|effort]], "
            "where slot is <thread>@<session> (the session ordinal ContextCaptured carries, from 1) or the "
            "bare thread id for a call from before the engine stamped sessions. Each row is a list in `fields` "
            "order with trailing zeros dropped. Same dedupe, long split and Flex split "
            "as daily.json, from the same query, so the two always sum alike. "
            "The producer is auxiliary:<purpose> for an auxiliary call and main_llm:<origin> "
            "for a Lucidos Agent call, as in daily.json. "
            "threads[id] is [title], [title, parent id] or [title, parent id or null, "
            "predecessor id]; a sub-thread folds into its root by walking parents, and a "
            "legacy successor thread into the chain it continued by walking predecessors. "
            "The empty thread id holds calls with no thread (Jev). The claude_code frame "
            "dedupe compares a call only with the one before it in the same session. "
            "sessions[<thread>@<session>] is [first call, last call] in ISO UTC, over every call the "
            "session ever made, keep-alive pings included. Bare pre-session slots have none."
        ),
        "threads": meta,
        "sessions": spans,
        "days": t_days,
        "hours": t_hours,
    }

    # Write through the CLI so the engine stages, commits and announces the
    # file. daily.json first: if the thread file then fails, the next run sees
    # the two cursors disagree and rebuilds both. The handoff file is rebuilt
    # whole each run, so it needs no cursor of its own.
    for rel, text in (("artifacts/token-cost/daily.json", json.dumps(payload, separators=(",", ":"))),
                      ("artifacts/token-cost/threads-daily.json", dumps_by_day(threads_payload)),
                      ("artifacts/token-cost/handoffs.json", json.dumps(handoffs, separators=(",", ":")))):
        w = subprocess.run(
            ["lucidos", "data", "write", rel, "--from", "-"],
            input=text, capture_output=True, text=True,
        )
        if w.returncode != 0:
            sys.exit(f"lucidos data write failed for {rel}: {w.stderr.strip()[:400]}")
    write_cache_stats(long_cut, split)
    print(
        f"rolled up {len(touched)} day(s) {touched[0]}..{touched[-1]}, "
        f"seq {since} -> {max_seq}, kept {kept} of {raw_rows} rows "
        f"({max(0, raw_rows - kept)} re-delivered frame(s) dropped), "
        f"{total_secs}s of voice, {len(handoffs['handoffs'])} handoff(s)"
    )


if __name__ == "__main__":
    main()
