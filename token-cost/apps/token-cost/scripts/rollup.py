#!/usr/bin/env python3
"""Incremental token-usage rollup.

Reads `ContextCaptured` events (every real model call the engine makes emits
one, with a provider `usage` block) and folds them into a per-day, per-model
rollup at artifacts/token-cost/daily.json.

Incremental: resumes from `last_sequence` in the existing file and only reads
rows above it, so a run costs the same whether the store holds 500k events or
5M. Recomputes the touched days in full rather than adding deltas, so a rerun
is idempotent.

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

ROLLUP_SQL = """
COPY (
  SELECT coalesce(json_agg(row_to_json(t)), '[]'::json) FROM (
    SELECT
      to_char(date_trunc('day', created), 'YYYY-MM-DD') AS day,
      payload->>'producer' AS producer,
      payload->>'model' AS model,
      count(*) AS calls,
      sum((payload->'usage'->>'input_tokens')::bigint) AS total_in,
      sum((payload->'usage'->>'cache_read_tokens')::bigint) AS cache_read,
      sum((payload->'usage'->>'cache_creation_tokens')::bigint) AS cache_write,
      sum((payload->'usage'->>'output_tokens')::bigint) AS out_tok,
      count(*) FILTER (WHERE (payload->'usage'->>'input_tokens')::bigint <  32000) AS b0,
      count(*) FILTER (WHERE (payload->'usage'->>'input_tokens')::bigint >= 32000  AND (payload->'usage'->>'input_tokens')::bigint < 64000)  AS b1,
      count(*) FILTER (WHERE (payload->'usage'->>'input_tokens')::bigint >= 64000  AND (payload->'usage'->>'input_tokens')::bigint < 128000) AS b2,
      count(*) FILTER (WHERE (payload->'usage'->>'input_tokens')::bigint >= 128000 AND (payload->'usage'->>'input_tokens')::bigint < 200000) AS b3,
      count(*) FILTER (WHERE (payload->'usage'->>'input_tokens')::bigint >= 200000 AND (payload->'usage'->>'input_tokens')::bigint < 400000) AS b4,
      count(*) FILTER (WHERE (payload->'usage'->>'input_tokens')::bigint >= 400000) AS b5,
      sum((payload->'usage'->>'input_tokens')::bigint)       FILTER (WHERE (payload->'usage'->>'input_tokens')::bigint >= 200000) AS long_in,
      sum((payload->'usage'->>'output_tokens')::bigint)      FILTER (WHERE (payload->'usage'->>'input_tokens')::bigint >= 200000) AS long_out,
      sum((payload->'usage'->>'cache_read_tokens')::bigint)  FILTER (WHERE (payload->'usage'->>'input_tokens')::bigint >= 200000) AS long_cr,
      sum((payload->'usage'->>'cache_creation_tokens')::bigint) FILTER (WHERE (payload->'usage'->>'input_tokens')::bigint >= 200000) AS long_cw,
      max((payload->'usage'->>'input_tokens')::bigint) AS max_in
    FROM events
    WHERE event_type = 'ContextCaptured'
      AND payload->'usage' IS NOT NULL
      AND date_trunc('day', created)::date = ANY (%(days)s)
    GROUP BY 1, 2, 3
  ) t
) TO STDOUT;
"""


def psql(sql: str) -> str:
    r = subprocess.run(["psql", "-A", "-t", "-c", sql], capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"psql failed: {r.stderr.strip()}")
    return r.stdout.strip()


def main() -> None:
    if OUT.exists():
        state = json.loads(OUT.read_text())
    else:
        state = {"last_sequence": 0, "days": {}}

    since = int(state.get("last_sequence", 0))

    # Which days gained rows, and the new high-water sequence. One cheap scan.
    head = psql(
        "SELECT coalesce(max(sequence), 0) || '|' || "
        "coalesce(string_agg(DISTINCT to_char(date_trunc('day', created), 'YYYY-MM-DD'), ','), '') "
        f"FROM events WHERE event_type = 'ContextCaptured' AND sequence > {since};"
    )
    max_seq_s, _, day_list = head.partition("|")
    max_seq = int(max_seq_s or 0)
    touched = [d for d in day_list.split(",") if d]

    if not touched:
        print(f"no new ContextCaptured rows above sequence {since}")
        return

    day_array = "ARRAY[" + ",".join(f"'{d}'::date" for d in touched) + "]"
    rows = json.loads(psql(ROLLUP_SQL.replace("%(days)s", day_array)))

    days = state.get("days", {})
    for d in touched:
        days[d] = {}
    for x in rows:
        days[x["day"]][f"{x['producer']}|{x['model']}"] = {
            "calls": int(x["calls"]),
            "in": int(x["total_in"]),
            "cache_read": int(x["cache_read"]),
            "cache_write": int(x["cache_write"]),
            "out": int(x["out_tok"]),
            "buckets": [int(x[f"b{i}"]) for i in range(6)],
            "long": {
                "in": int(x["long_in"] or 0),
                "out": int(x["long_out"] or 0),
                "cache_read": int(x["long_cr"] or 0),
                "cache_write": int(x["long_cw"] or 0),
            },
            "max_in": int(x["max_in"]),
        }

    payload = {
        "generated": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "last_sequence": max(max_seq, since),
        "bucket_edges": BUCKET_EDGES,
        "note": (
            "'in' is TOTAL prompt size (uncached + cache_read + cache_write). "
            "uncached = in - cache_read - cache_write. 'long' is the subset of rows "
            f"whose prompt exceeded {LONG_CTX_THRESHOLD}, for the long-context price tier."
        ),
        "days": days,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, separators=(",", ":")))
    print(f"rolled up {len(touched)} day(s) {touched[0]}..{touched[-1]}, seq {since} -> {max_seq}")


if __name__ == "__main__":
    main()
