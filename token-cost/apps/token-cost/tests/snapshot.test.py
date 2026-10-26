"""The Thread cost snapshot, scripts/token-cost/thread_costs.py.

The script runs whole, with a fake `psql` serving canned rows and the fake
`lucidos` from fake_lucidos.py. These pin three things:

- it runs the 0.4.x price migration first, so a model priced only in the
  legacy pricing.json is priced in the same run, not an hour later;
- a call it cannot price is never folded in silently as $0. Each thread and
  the whole snapshot carry how many calls are left out, so the widget can
  say its total is incomplete;
- the frame dedupe in its SQL never compares a call with the last call of
  the session before it (run in sqlite, see FAKE_PSQL).
"""
import datetime
import json
import os
import pathlib
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
FIX = HERE / "fixtures"
SCRIPT = HERE.parents[2] / "scripts" / "token-cost" / "thread_costs.py"
TODAY = datetime.date.today().isoformat()

passed = failed = 0


def check(name, got, want):
    global passed, failed
    if got == want:
        passed += 1
    else:
        failed += 1
        print(f"  FAIL {name}: got {got!r}, want {want!r}")


def row(tid, model, calls, i, o):
    return {"tid": tid, "dy": TODAY, "mdl": model, "producer": "auxiliary:memory", "calls": calls,
            "i": i, "cr": 0, "cw": 0, "o": o, "li": 0, "lcr": 0, "lcw": 0, "lo": 0}


ROWS = [
    row("t1", "gemini-3-flash-preview", 3, 1_000_000, 100_000),  # priced only in the legacy file
    row("t1", "claude-opus-5-5", 2, 1_000_000, 0),                # shipped
    row("t2", "mystery-model-1", 1, 10, 10),                     # priced nowhere
]

# With a psql.events file beside it, the fake runs the script's own per-call
# query in sqlite over those events, so the dedupe in its SQL is what the test
# sees. sqlite reads Postgres's ->, ->>, FILTER, LAG and IS NOT DISTINCT FROM
# as they are; only the casts and the time-zone day need rewriting.
FAKE_PSQL = f"#!{sys.executable} -I\n" + r'''
import json, os, re, sqlite3, sys
sql = sys.argv[-1]
events = sys.argv[0] + ".events"
if "max(sequence)" in sql: print("100")
elif "json_agg(t)" in sql and os.path.exists(events):
    q = sql.replace("SELECT coalesce(json_agg(t),'[]') FROM (", "SELECT * FROM (", 1)
    q = re.sub(r"\(\(created AT TIME ZONE '[^']*'\)::date\)::text", "date(created)", q)
    q = re.sub(r"::(bigint|int|text|date)\b", "", q)
    db = sqlite3.connect(":memory:")
    db.execute("CREATE TABLE events (sequence INTEGER, thread_id TEXT, created TEXT, event_type TEXT, payload TEXT)")
    db.executemany("INSERT INTO events VALUES (?, ?, ?, 'ContextCaptured', ?)",
                   [(e["seq"], e["tid"], e["created"], json.dumps(e["payload"])) for e in json.load(open(events))])
    cur = db.execute(q)
    names = [d[0] for d in cur.description]
    rows = [dict(zip(names, r)) for r in cur]
    open(sys.argv[0] + ".count", "w").write(str(len(rows)))
    print(json.dumps(rows))
elif "json_agg(t)" in sql: print(open(sys.argv[0] + ".rows").read())
elif "parent_thread_id IS NOT NULL" in sql: print("")
elif "thread_summaries" in sql: print('{"t1": "Thread one", "t2": "Thread two"}')
else: print("{}")
'''


def snapshot(with_legacy, rows=ROWS, events=None, table=None):
    root = pathlib.Path(tempfile.mkdtemp(prefix="tc-snapshot-"))
    (root / "data" / "artifacts" / "token-cost").mkdir(parents=True)
    (root / ".lucidos" / "tmp").mkdir(parents=True)
    if with_legacy:
        (root / "data" / "artifacts" / "token-cost" / "pricing.json").write_text(
            (FIX / "legacy-pricing-0.4.json").read_text())
    bin_dir = root / "bin"
    bin_dir.mkdir()
    (bin_dir / "lucidos").write_text(f'#!/bin/sh\nexec "{sys.executable}" -I "{HERE / "fake_lucidos.py"}" "$@"\n')
    (bin_dir / "psql").write_text(FAKE_PSQL)
    (bin_dir / "psql.rows").write_text(json.dumps(rows))
    if events is not None:
        (bin_dir / "psql.events").write_text(json.dumps(events))
    for f in ("lucidos", "psql"):
        (bin_dir / f).chmod(0o755)
    env = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", "LUCIDOS_WORKSPACE": str(root),
           "LUCIDOS_DATABASE_URL": "postgres://fake", "FAKE_SHIPPED": str(FIX / "shipped-prices.json")}
    env.pop("TOKEN_COST_PRICE_TABLE", None)
    if table is not None:
        table_file = root / "table.json"
        table_file.write_text(json.dumps(table))
        env["TOKEN_COST_PRICE_TABLE"] = str(table_file)
    p = subprocess.run([sys.executable, "-I", str(SCRIPT)], env=env, capture_output=True, text=True)
    if p.returncode:
        print(p.stdout, p.stderr)
    out = json.loads((root / "data" / "artifacts" / "token-cost" / "threads-cost.json").read_text())
    p.head = json.loads((root / "data" / "artifacts" / "token-cost" / "threads-cost-head.json").read_text())
    count = bin_dir / "psql.count"
    p.rows = int(count.read_text()) if count.exists() else None
    return p, out


def thread(out, tid):
    for r in out["top_all"] + out["top_today"]:
        if r["id"] == tid:
            return r
    c = out["rest"].get(tid)
    return c and {"id": tid, "all": c[1], "calls": c[3], "unpriced": c[6] if len(c) > 6 else 0}


# 1. No legacy file: the Gemini calls are unpriced, and the snapshot says so.
p, out = snapshot(with_legacy=False)
check("1 the script succeeds", p.returncode, 0)
check("1 no migration line without a legacy file", "price migration" in p.stdout, False)
t1 = thread(out, "t1")
check("1 thread one counts its unpriced calls", t1.get("unpriced"), 3)
check("1 and its priced cost is opus alone", t1["all"], 4.0)
check("1 the snapshot names what it left out",
      (out.get("unpriced_calls"), out.get("unpriced_models")), (4, {"gemini-3-flash-preview": 3, "mystery-model-1": 1}))
check("1 the widget gets no rate for an unpriced model", "gemini-3-flash-preview" in out["rates"], False)

# 2. A 0.4.4 legacy file: migrated first, so the same run prices Gemini.
p, out = snapshot(with_legacy=True)
check("2 the script succeeds", p.returncode, 0)
check("2 it reports the migration", "price migration (migrated)" in p.stdout, True)
t1 = thread(out, "t1")
check("2 thread one is fully priced: opus 4.00 plus gemini 0.50 + 0.30", (t1["all"], t1.get("unpriced", 0)), (4.8, 0))
check("2 the widget gets the moved rate", out["rates"].get("gemini-3-flash-preview", {}).get("in"), 0.5)
check("2 only the model priced nowhere is left out",
      (out.get("unpriced_calls"), out.get("unpriced_models")), (1, {"mystery-model-1": 1}))
check("2 thread two still says so", thread(out, "t2").get("unpriced"), 1)

# Session totals and the lightweight head are emitted together, with no
# tradeoff between session rows and the plugin's unpriced-call warning.
rows = [{**r, "sess": n + 1} for n, r in enumerate(ROWS)]
p, out = snapshot(with_legacy=True, rows=rows)
check("3 sessions sum to the thread's priced total",
      round(sum(s[1] for s in thread(out, "t1")["sessions"]), 2), thread(out, "t1")["all"])
check("3 each session keeps its ordinal", [s[0] for s in thread(out, "t1")["sessions"]], [1, 2])
check("3 unpriced session keeps its warning", thread(out, "t2").get("unpriced"), 1)

check("3 the head shares the full snapshot cursor", p.head["last_sequence"], out["last_sequence"])
check("3 head rows keep session and unpriced data", thread(p.head, "t2"), thread(out, "t2"))

# Force a priced, idle thread outside both top lists into the compact format.
old_day = (datetime.date.today() - datetime.timedelta(days=30)).isoformat()
rows = [{**row(f"old-{n}", "claude-opus-5-5", 1, 1_000_000, 0), "dy": old_day, "sess": 1}
        for n in range(401)]
p, out = snapshot(with_legacy=False, rows=rows)
c = out["rest"]["old-400"]
check("4 compact rows reserve the unpriced slot", c[6], 0)
check("4 compact rows keep sessions after that slot", c[7], [[1, 4.0, "claude-opus-5-5", "auxiliary:memory"]])
check("4 idle rows outside the top lists stay out of the head", "old-400" in p.head["rest"], False)
check("4 the head declares completeness only for included roots", "old-400" in p.head["closed"], False)

# 5. The frame dedupe runs per thread AND session, in the script's own SQL.
# Claude Code re-delivers a frame as an identical row right after it, and the
# snapshot drops that copy. The first call of a successor session is a new
# context: identical usage to the last call of the session before is chance,
# so it is kept, as the rollup, the dashboard and the widget keep it.
U = {"input_tokens": 1_000_000, "cache_read_tokens": 0, "cache_creation_tokens": 0, "output_tokens": 0}


def ev(seq, tid, session):
    payload = {"producer": "claude_code", "model": "claude-opus-5-5", "usage": U}
    if session is not None:
        payload["session"] = session
    return {"seq": seq, "tid": tid, "created": TODAY + "T10:00:00", "payload": payload}


p, out = snapshot(with_legacy=False, events=[
    ev(1, "t1", None), ev(2, "t1", None),  # before the stamp: a re-delivered frame
    ev(3, "t1", 1), ev(4, "t1", 1),        # session 1 opens, then a re-delivered frame
    ev(5, "t1", 2),                        # session 2 opens with the same usage
    ev(6, "t2", 2),                        # another thread, same usage
])
check("5 the script succeeds", p.returncode, 0)
t1 = thread(out, "t1")
check("5 a re-delivered frame is dropped only inside its own session", t1["calls"], 3)
check("5 each session keeps its opening call", [(s[0], s[1]) for s in t1.get("sessions") or []],
      [(0, 4.0), (1, 4.0), (2, 4.0)])
check("5 the sessions sum to the thread's total", t1["all"], 12.0)
check("5 another thread is never compared", thread(out, "t2")["calls"], 1)

# Real projected events go through the shipped SQL, including its TTL columns,
# and through snapshot pricing. An unknown write must not swallow priced calls
# with the same model, session and prompt size.
CACHE_CARD = {"uncached_in": 2, "cache_read": 0.2, "cache_write": 2.5, "cache_write_1h": 4,
              "cache_write_12h": 5, "out": 10,
              "long": {"threshold_tokens": 200000, "uncached_in": 4, "cache_read": 0.4,
                       "cache_write": 5, "cache_write_1h": 8, "cache_write_12h": 10, "out": 20},
              "flex": {"uncached_in": 1, "cache_read": 0.1, "cache_write": 1.25,
                       "cache_write_1h": 2, "cache_write_12h": 2.5, "out": 5}}
cache_events = []
for seq, extra in enumerate(({}, {"input_tokens": 250000}, {"service_tier": "flex"},
                             {"cache_creation_1h_tokens": None, "cache_creation_requested_ttl": "12h"},
                             {"cache_creation_1h_tokens": None}), 1):
    u = {"input_tokens": 100000, "cache_read_tokens": 30000, "cache_creation_tokens": 50000,
         "cache_creation_1h_tokens": 30000, "output_tokens": 1000, **extra}
    cache_events.append({"seq": seq, "tid": "t1", "created": TODAY + "T12:00:00",
                         "payload": {"producer": "main_llm", "model": "asked", "served_model": "cache-model", "session": 1, "usage": u}})
p, out = snapshot(False, events=cache_events, table={"models": {"cache-model": [CACHE_CARD]}})
check("6 TTL snapshot succeeds", p.returncode, 0)
# The fifth call's write has no lifetime: 20,000 fresh at 2, 30,000 read at
# 0.2, 50,000 written at the base 2.5 and 1,000 out at 10 make $0.181.
check("6 an unknown-lifetime write prices at the base rate beside the known ones", thread(out, "t1")["all"], 1.88)
check("6 so no call is left out", thread(out, "t1").get("unpriced"), None)
check("6 session cost uses all dated tier and lifetime rates", thread(out, "t1")["sessions"][0][1], 1.878)
check("6 the floor-priced call is counted per thread and producer", out.get("ttl_unknown"), {"t1": {"main_llm": 1}})
check("6 and the head carries the count for the threads it holds", p.head.get("ttl_unknown"), {"t1": {"main_llm": 1}})
check("6 snapshots declare their lifetime pricing contract", (out.get("ttl_pricing"), p.head.get("ttl_pricing")), (1, 1))
check("6 snapshot rates retain lifetime prices", (out["rates"]["cache-model"]["cw1h"], out["rates"]["cache-model"]["cw12h"]), (4, 5))
check("6 snapshot Flex rates retain lifetime prices", out["rates"]["cache-model"]["flex"]["cw12h"], 2.5)

# 7. Rows group on the prompt's band between the cards' long cuts, never on its
# own size: 0.7.0's first cut grouped per prompt and read 1.2M rows where 24k do.
# Each row still prices at its own card's cut, inclusive or not.
CUT_CARD = lambda cut, inclusive=False: {"uncached_in": 1, "cache_read": 0, "cache_write": 0, "out": 0,
    "long": {"threshold_tokens": cut, "uncached_in": 10, "out": 0, **({"inclusive": True} if inclusive else {})}}
band_events = [{"seq": n, "tid": "t1", "created": TODAY + "T12:00:00",
                "payload": {"producer": "main_llm", "model": model, "session": 1,
                            "usage": {"input_tokens": prompt, "cache_read_tokens": 0, "cache_creation_tokens": 0, "output_tokens": 0}}}
               for n, (model, prompt) in enumerate((("model-a", 1000), ("model-a", 2000), ("model-a", 3000),
                                                     ("model-a", 250000), ("model-b", 250000), ("model-c", 200000)), 1)]
p, out = snapshot(False, events=band_events, table={"models": {
    "model-a": [CUT_CARD(272000)], "model-b": [CUT_CARD(200000)], "model-c": [CUT_CARD(200000, True)]}})
check("7 band snapshot succeeds", p.returncode, 0)
check("7 three short prompts on one model share a row", p.rows, 4)
models = thread(out, "t1")["models"]
check("7 under model-a's 272k cut, 256k prompts price standard", models["model-a"]["all"], round((6000 + 250000) / 1e6, 4))
check("7 over model-b's 200k cut, the same prompt prices long", models["model-b"]["all"], 2.5)
check("7 an inclusive cut prices a prompt of exactly the cut long", models["model-c"]["all"], 2.0)

print(f"{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
