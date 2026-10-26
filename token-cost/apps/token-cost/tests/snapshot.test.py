"""The Thread cost snapshot, scripts/token-cost/thread_costs.py.

The script runs whole, with a fake `psql` serving canned rows and the fake
`lucidos` from fake_lucidos.py. These pin two things:

- it runs the 0.4.x price migration first, so a model priced only in the
  legacy pricing.json is priced in the same run, not an hour later;
- a call it cannot price is never folded in silently as $0. Each thread and
  the whole snapshot carry how many calls are left out, so the widget can
  say its total is incomplete.
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

FAKE_PSQL = f'''#!{sys.executable} -I
import sys
sql = sys.argv[-1]
if "max(sequence)" in sql: print("100")
elif "json_agg(t)" in sql: print(open(sys.argv[0] + ".rows").read())
elif "parent_thread_id IS NOT NULL" in sql: print("")
elif "thread_summaries" in sql: print('{{"t1": "Thread one", "t2": "Thread two"}}')
else: print("{{}}")
'''


def snapshot(with_legacy, rows=ROWS):
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
    for f in ("lucidos", "psql"):
        (bin_dir / f).chmod(0o755)
    env = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", "LUCIDOS_WORKSPACE": str(root),
           "LUCIDOS_DATABASE_URL": "postgres://fake", "FAKE_SHIPPED": str(FIX / "shipped-prices.json")}
    env.pop("TOKEN_COST_PRICE_TABLE", None)
    p = subprocess.run([sys.executable, "-I", str(SCRIPT)], env=env, capture_output=True, text=True)
    if p.returncode:
        print(p.stdout, p.stderr)
    out = json.loads((root / "data" / "artifacts" / "token-cost" / "threads-cost.json").read_text())
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

print(f"{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
