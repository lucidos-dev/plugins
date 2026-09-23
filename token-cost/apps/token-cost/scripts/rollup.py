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
is identical to the PREVIOUS row in the same thread by sequence. Consecutive
and per-thread both matter: two unrelated calls elsewhere in the workspace
that happen to match are never collapsed, and a real repeat separated by any
other call in its own thread survives.

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

State path is anchored on LUCIDOS_WORKSPACE, never on __file__ (see
knowhow/script-state-paths.md).
"""

import json
import os
import pathlib
import subprocess
import sys
from datetime import datetime, timezone

WS = pathlib.Path(os.environ.get("LUCIDOS_WORKSPACE", "."))
OUT = WS / "data" / "artifacts" / "token-cost" / "daily.json"
PRICING = WS / "data" / "artifacts" / "token-cost" / "pricing.json"

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
    GROUP BY 1, 2, 3
  ) t
) TO STDOUT;
"""


def blank_bucket() -> dict:
    return {
        "calls": 0, "in": 0, "cache_read": 0, "cache_write": 0,
        "out": 0, "seconds": 0, "buckets": [0] * 6,
        "long": {"in": 0, "out": 0, "cache_read": 0, "cache_write": 0},
        "max_in": 0,
    }


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

    # 1. Real events, the authoritative source.
    covered = set()
    calls_total = tokens_total = 0
    try:
        rows = json.loads(psql(JEV_SQL % {"tz": TZ, "hour": LOCAL_HOUR}))
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

    # 2. Disk backfill, for days no event covers.
    for pattern in JEV_RESULT_GLOBS:
        for path in WS.glob(pattern):
            try:
                doc = json.loads(path.read_text())
            except (OSError, ValueError):
                continue
            calls = int(doc.get("requests") or doc.get("decisions") or 0)
            if calls <= 0:
                continue
            stamp = datetime.fromtimestamp(path.stat().st_mtime).astimezone()
            day = stamp.strftime("%Y-%m-%d")
            if day in covered:
                continue
            tokens = calls * JEV_TOKENS_PER_CALL
            calls_total += calls
            tokens_total += tokens
            add(day, stamp.hour, calls, tokens, 0, JEV_TOKENS_PER_CALL)

    return calls_total, tokens_total


def long_thresholds() -> dict:
    """Base model id -> the prompt size its long-context tier starts at.

    Read from pricing.json, because the threshold is a fact about the
    PROVIDER and differs between them: OpenAI's flagship tier starts at 272k,
    xAI's and Gemini Pro's at 200k, and Anthropic charges no premium at all.
    One global 200k split filed every 200k-272k GPT call as long and the app
    then priced it at a rate OpenAI does not charge.

    Missing or unreadable pricing.json is not fatal: every model falls back to
    200k, which is what this script did before.
    """
    try:
        cards = json.loads(PRICING.read_text()).get("models", {})
    except (OSError, ValueError):
        return {}
    out = {}
    for model, card in cards.items():
        t = (card or {}).get("long", {}).get("threshold_tokens")
        if t and int(t) != LONG_CTX_THRESHOLD:
            out[model] = int(t)
    return out


def long_cutoff_sql(column: str) -> str:
    """The per-model threshold as one SQL expression.

    The stored id carries the engine's decorations (`claude-opus-5@default[1m]`),
    and pricing keys on the bare model, so both sides are stripped the same way
    the app's `baseModel()` does it.
    """
    bare = (
        f"regexp_replace(regexp_replace({column}, '\\[1m\\]$', ''), '@[^\\[\\]]*$', '')"
    )
    rows = long_thresholds()
    if not rows:
        return str(LONG_CTX_THRESHOLD)
    whens = " ".join(
        f"WHEN '{m}' THEN {t}" for m, t in sorted(rows.items())
    )
    return f"(CASE {bare} {whens} ELSE {LONG_CTX_THRESHOLD} END)"


LONG_CUTOFF = long_cutoff_sql("payload->>'model'")
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

# `usage` tuple, spelled once for the value and once inside the LAG.
_USAGE_TUPLE = """(
        (payload->'usage'->>'input_tokens')::bigint,
        coalesce((payload->'usage'->>'cache_read_tokens')::bigint, 0),
        coalesce((payload->'usage'->>'cache_creation_tokens')::bigint, 0),
        (payload->'usage'->>'output_tokens')::bigint
      )"""

ROLLUP_SQL = (
    """
COPY (
  SELECT coalesce(json_agg(row_to_json(t)), '[]'::json) FROM (
    SELECT
      to_char(local_day, 'YYYY-MM-DD') AS day,
      local_hour AS hour,
      producer,
      model,
      count(*) AS calls,
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
      sum(in_tok)  FILTER (WHERE in_tok >= long_cut) AS long_in,
      sum(out_tok) FILTER (WHERE in_tok >= long_cut) AS long_out,
      sum(cr)      FILTER (WHERE in_tok >= long_cut) AS long_cr,
      sum(cw)      FILTER (WHERE in_tok >= long_cut) AS long_cw,
      max(in_tok) AS max_in
    FROM (
      SELECT
        """
    + LOCAL_DAY
    + """ AS local_day,
        """
    + LOCAL_HOUR
    + """ AS local_hour,
        payload->>'producer' AS producer,
        payload->>'model' AS model,
        (payload->'usage'->>'input_tokens')::bigint AS in_tok,
        coalesce((payload->'usage'->>'cache_read_tokens')::bigint, 0) AS cr,
        coalesce((payload->'usage'->>'cache_creation_tokens')::bigint, 0) AS cw,
        (payload->'usage'->>'output_tokens')::bigint AS out_tok,
        """
    + LONG_CUTOFF
    + """ AS long_cut,
        """
    + _USAGE_TUPLE
    + """ IS NOT DISTINCT FROM LAG("""
    + _USAGE_TUPLE
    + """)
          OVER (PARTITION BY thread_id ORDER BY sequence)
        AND payload->>'producer' = 'claude_code' AS dup
      FROM events
      WHERE event_type = 'ContextCaptured'
        AND payload->'usage' IS NOT NULL
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
    GROUP BY 1, 2, 3, 4
  ) t
) TO STDOUT;
"""
)


def psql(sql: str) -> str:
    r = subprocess.run(["psql", "-A", "-t", "-c", sql], capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"psql failed: {r.stderr.strip()}")
    return r.stdout.strip()


# Voice seconds, bucketed exactly like the token rows above.
#
# `VoiceSessionEnded` names no model, so each session is attributed to a voice
# `ContextCaptured` row: the last one in the SAME thread at or before the
# hangup, which is the session that just ended. Six of the 33 sessions on
# record have no such row (the talker opened and produced no frame, or the call
# died early), and those fall back to the nearest voice row in time anywhere in
# the store. Nearest in TIME, not the latest before: a fallback that walked
# backwards filed two calls made on a GPT-Live evening under the Realtime model
# last used nine days earlier. A session with no voice row within a day of it
# is dropped rather than guessed at.
#
# The candidate rows are materialised once. There is no index on the payload's
# purpose, so a correlated subquery would rescan the whole events table per
# session.
SECONDS_SQL = (
    """
COPY (
  WITH voice_calls AS MATERIALIZED (
    SELECT thread_id, sequence, created,
           payload->>'producer' AS producer, payload->>'model' AS model
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
      sum((e.payload->>'duration_secs')::bigint) AS seconds
    FROM events e
    CROSS JOIN LATERAL (
      SELECT c.producer, c.model
      FROM voice_calls c
      WHERE abs(extract(epoch FROM c.created - e.created)) < 86400
      ORDER BY
        (c.thread_id = e.thread_id AND c.sequence <= e.sequence) DESC,
        abs(extract(epoch FROM c.created - e.created))
      LIMIT 1
    ) m
    WHERE e.event_type = 'VoiceSessionEnded'
      AND e.payload->>'duration_secs' IS NOT NULL
      AND """
    + E_DAY
    + """ = ANY (%(days)s)
    GROUP BY 1, 2, 3, 4
  ) t
) TO STDOUT;
"""
)


def main() -> None:
    rebuild = os.environ.get("TOKEN_COST_REBUILD") == "1"

    if OUT.exists() and not rebuild:
        state = json.loads(OUT.read_text())
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
        print(f"no new ContextCaptured rows above sequence {since}")
        return

    day_array = "ARRAY[" + ",".join(f"'{d}'::date" for d in touched) + "]"
    rows = json.loads(psql(ROLLUP_SQL.replace("%(days)s", day_array)))

    # Diagnostic only, and counted separately: the rollup query filters the
    # duplicates out inside the same subquery, so it cannot also count them.
    raw_rows = int(
        psql(
            "SELECT count(*) FROM events WHERE event_type = 'ContextCaptured' "
            f"AND payload->'usage' IS NOT NULL AND {LOCAL_DAY} = ANY ({day_array});"
        )
        or 0
    )

    def blank() -> dict:
        return {
            "calls": 0,
            "in": 0,
            "cache_read": 0,
            "cache_write": 0,
            "out": 0,
            "seconds": 0,
            "buckets": [0] * 6,
            "long": {"in": 0, "out": 0, "cache_read": 0, "cache_write": 0},
            "max_in": 0,
        }

    def fold(dst: dict, x: dict) -> None:
        dst["calls"] += int(x["calls"])
        dst["in"] += int(x["total_in"])
        dst["cache_read"] += int(x["cache_read"])
        dst["cache_write"] += int(x["cache_write"])
        dst["out"] += int(x["out_tok"])
        dst.setdefault("seconds", 0)
        for i in range(6):
            dst["buckets"][i] += int(x[f"b{i}"])
        dst["long"]["in"] += int(x["long_in"] or 0)
        dst["long"]["out"] += int(x["long_out"] or 0)
        dst["long"]["cache_read"] += int(x["long_cr"] or 0)
        dst["long"]["cache_write"] += int(x["long_cw"] or 0)
        dst["max_in"] = max(dst["max_in"], int(x["max_in"]))

    days = state.get("days", {})
    hours = state.get("hours", {})
    for d in touched:
        days[d] = {}
        hours[d] = {}
    kept = 0
    # The query returns one row per (day, hour, producer, model). The day totals
    # are that summed over hours, so the two views can never disagree.
    for x in rows:
        kept += int(x["calls"])
        key = f"{x['producer']}|{x['model']}"
        fold(days[x["day"]].setdefault(key, blank()), x)
        hr = str(int(x["hour"]))
        fold(hours[x["day"]].setdefault(hr, {}).setdefault(key, blank()), x)

    # Voice seconds land in the same buckets, under their own field. A session
    # that started before midnight is filed on the day it ENDED, because that
    # is the row carrying its duration; at these volumes (a handful of calls a
    # day, none near midnight) splitting one across two days buys nothing.
    secs = json.loads(psql(SECONDS_SQL.replace("%(days)s", day_array)))
    total_secs = 0
    for x in secs:
        n = int(x["seconds"] or 0)
        total_secs += n
        key = f"{x['producer']}|{x['model']}"
        days[x["day"]].setdefault(key, blank())["seconds"] += n
        hr = str(int(x["hour"]))
        hours[x["day"]].setdefault(hr, {}).setdefault(key, blank())["seconds"] += n

    # Hourly detail only for the days a single-day selection can reach.
    keep_hours = set(sorted(days)[-HOURS_DAYS:])
    hours = {d: v for d, v in hours.items() if d in keep_hours}

    jev_calls, jev_tokens = fold_jev(days, hours, keep_hours)

    payload = {
        "generated": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "last_sequence": max(max_seq, since),
        "bucket_edges": BUCKET_EDGES,
        "timezone": TZ,
        "hours_days": HOURS_DAYS,
        "note": (
            "'in' is TOTAL prompt size (uncached + cache_read + cache_write). "
            "uncached = in - cache_read - cache_write. 'long' is the subset of rows "
            "whose prompt reached the model's own long-context threshold, from "
            "pricing.json (272k on OpenAI's flagships, 200k elsewhere), for the "
            "long-context price tier. "
            "A claude_code row whose usage tuple repeats the previous row in the same "
            "thread is dropped as a re-delivered streaming frame, not counted as a "
            "second call. Other producers are never collapsed. 'seconds' is voice "
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
        "days": days,
        "hours": hours,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, separators=(",", ":")))
    print(
        f"rolled up {len(touched)} day(s) {touched[0]}..{touched[-1]}, "
        f"seq {since} -> {max_seq}, kept {kept} of {raw_rows} rows "
        f"({max(0, raw_rows - kept)} re-delivered frame(s) dropped), "
        f"{total_secs}s of voice"
    )


if __name__ == "__main__":
    main()
