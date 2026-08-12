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

BUCKET_EDGES = [0, 32000, 64000, 128000, 200000, 400000]
LONG_CTX_THRESHOLD = 200000
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
      sum(in_tok)  FILTER (WHERE in_tok >= 200000) AS long_in,
      sum(out_tok) FILTER (WHERE in_tok >= 200000) AS long_out,
      sum(cr)      FILTER (WHERE in_tok >= 200000) AS long_cr,
      sum(cw)      FILTER (WHERE in_tok >= 200000) AS long_cw,
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
        f"FROM events WHERE event_type = 'ContextCaptured' AND sequence > {since};"
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

    # Hourly detail only for the days a single-day selection can reach.
    keep_hours = set(sorted(days)[-HOURS_DAYS:])
    hours = {d: v for d, v in hours.items() if d in keep_hours}

    payload = {
        "generated": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "last_sequence": max(max_seq, since),
        "bucket_edges": BUCKET_EDGES,
        "timezone": TZ,
        "hours_days": HOURS_DAYS,
        "note": (
            "'in' is TOTAL prompt size (uncached + cache_read + cache_write). "
            "uncached = in - cache_read - cache_write. 'long' is the subset of rows "
            f"whose prompt exceeded {LONG_CTX_THRESHOLD}, for the long-context price tier. "
            "A claude_code row whose usage tuple repeats the previous row in the same "
            "thread is dropped as a re-delivered streaming frame, not counted as a "
            "second call. Other producers are never collapsed. Days are bucketed in "
            f"the local timezone ({TZ}). 'hours' holds the same shape keyed by local "
            f"hour, for the most recent {HOURS_DAYS} days only."
        ),
        "days": days,
        "hours": hours,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, separators=(",", ":")))
    print(
        f"rolled up {len(touched)} day(s) {touched[0]}..{touched[-1]}, "
        f"seq {since} -> {max_seq}, kept {kept} of {raw_rows} rows "
        f"({max(0, raw_rows - kept)} re-delivered frame(s) dropped)"
    )


if __name__ == "__main__":
    main()
