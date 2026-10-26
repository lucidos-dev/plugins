"""Long-context split in scripts/rollup.py.

The rollup files each call's prompt as short or long in SQL, and the app then
prices the long part at the tier card. When the two disagree on a model's
threshold, rolled-up days charge 200k-272k GPT calls at a rate OpenAI does not
bill. These pin that the rollup picks the same card the app's rateFor() does,
on the same day: the price table keeps a dated price history, and a tier that
starts mid-history must split only the days it covers.

The table is Lucidos's (`lucidos model-prices`, ADR 0525). These feed it
through the TOKEN_COST_PRICE_TABLE seam, a file holding the same JSON.

The generated SQL is run for real in sqlite, with Postgres's regexp_replace
registered as a Python function, so the test needs no database server.
"""
import json
import pathlib
import re
import sqlite3
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))
import rollup  # noqa: E402

passed = failed = 0


def check(name, got, want):
    global passed, failed
    if got == want:
        passed += 1
    else:
        failed += 1
        print(f"  FAIL {name}: got {got!r}, want {want!r}")


def with_pricing(models, **extra):
    """Point rollup at a temporary price table holding these cards, shaped
    as `lucidos model-prices` prints it: every card carries its origin."""
    def tagged(entry):
        if isinstance(entry, list):
            return [dict(c, origin="shipped") if isinstance(c, dict) else c for c in entry]
        return dict(entry, origin="shipped") if isinstance(entry, dict) else entry
    f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
    json.dump({"currency": "USD", "checked": "2026-10-16",
               "models": {m: tagged(e) for m, e in models.items()},
               "override": {"path": "data/config/model-prices.json", "present": False, "checked": None, "error": None},
               **extra}, f)
    f.close()
    rollup.PRICE_TABLE = f.name


DB = sqlite3.connect(":memory:")
# Postgres replaces the first match unless told 'g', which none of these do.
DB.create_function("regexp_replace", 3, lambda s, p, r: re.sub(p, r, s, count=1))
DB.create_function("regexp_replace", 4, lambda s, p, r, f: re.sub(p, r, s, count=0 if "g" in f else 1))


def cutoff(model, day="2026-10-10"):
    """Evaluate long_cutoff_sql() for one id on one local day."""
    sql = rollup.long_cutoff_sql("m", "d")
    return DB.execute(f"SELECT {sql} FROM (SELECT ? AS m, ? AS d)", (model, day)).fetchone()[0]


def is_long(model, prompt, day="2026-10-10"):
    """The rollup's own test for one call: is its prompt over the cut?"""
    sql = rollup.long_cutoff_sql("m", "d")
    return DB.execute(f"SELECT ? > {sql} FROM (SELECT ? AS m, ? AS d)", (prompt, model, day)).fetchone()[0] == 1


GPT = {"uncached_in": 5, "out": 30, "long": {"threshold_tokens": 272000}}

# 1. A model's tier comes from the price table, the only table.
with_pricing({"gpt-5.5": GPT, "claude-opus-5": {"uncached_in": 5, "out": 25}})
check("gpt-5.5 splits at its card's 272k", cutoff("gpt-5.5"), 272000)
check("claude-opus-5[1m] stays at 200k", cutoff("claude-opus-5[1m]"), 200000)
with_pricing({})
check("an unlisted model splits at 200k, as the app's unpriced model", cutoff("gpt-5.5"), 200000)

# 2. A gateway prefix and a release date resolve to the plain card, as modelKeys() does.
with_pricing({"gpt-5.5": GPT, "claude-haiku-5-5": {"uncached_in": 0.1, "out": 0.5, "long": {"threshold_tokens": 100000}}})
check("openai/gpt-5.5", cutoff("openai/gpt-5.5"), 272000)
check("nested prefix", cutoff("openrouter/openai/gpt-5.5"), 272000)
check("mixed case with engine decoration", cutoff("OpenAI/GPT-5.5@x[1m]"), 272000)
check("a dated id finds the undated card", cutoff("claude-haiku-5-5-20261007"), 100000)
check("unknown model", cutoff("acme/mystery-7b"), 200000)

# 3. A literal card wins over the plain one, tier or not.
with_pricing({"gpt-5.5": GPT, "openai/gpt-5.5": {"uncached_in": 5, "out": 30}})
check("prefixed stored card without tier", cutoff("openai/gpt-5.5"), 200000)
check("plain id still takes its tier", cutoff("gpt-5.5"), 272000)
with_pricing({"acme-big": {**GPT, "long": {"threshold_tokens": 128000}}})
check("stored tier on a new model", cutoff("acme-big"), 128000)
check("...through a prefix", cutoff("gw/acme-big"), 128000)

# 4. A card with no rate is skipped, as isPricedCard() skips it.
with_pricing({"gpt-5.5": {}})
check("empty stored card is no card", cutoff("gpt-5.5"), 200000)

# 5. The `default` row never counts as a card.
with_pricing({"default": GPT})
check("default row is ignored", cutoff("acme/mystery-7b"), 200000)

# 6. A quote in a model id cannot break out of the SQL string.
with_pricing({"it's": GPT})
check("quoted id", cutoff("it's"), 272000)

# 7. Price history: the split follows the card in force on the row's day.
haiku = [
    {"uncached_in": 1, "out": 5},
    {"from": "2026-10-07", "uncached_in": 0.1, "out": 0.5, "long": {"threshold_tokens": 100000}},
]
with_pricing({"haiku": haiku})
check("before the tier's card, the old card splits at 200k", cutoff("haiku", "2026-10-06"), 200000)
check("from its day, the new card splits at 100k", cutoff("haiku[1m]", "2026-10-07"), 100000)
check("and after it", cutoff("haiku", "2026-12-01"), 100000)
with_pricing({"acme": [{"uncached_in": 1, "out": 1}, {"from": "2099-01-01", **GPT}]})
check("a future-dated tier is not in force yet", cutoff("acme", "2026-10-10"), 200000)
check("it is on its day", cutoff("acme", "2099-01-01"), 272000)
with_pricing({"acme": {"uncached_in": 1, "out": 1, "long": {"threshold_tokens": 150000}}})
check("a plain object card still loads", cutoff("acme", "2026-01-01"), 150000)
with_pricing({"acme": [{"from": "2026-09-01", **GPT}]})
check("before a model's first card it splits at 200k", cutoff("acme", "2026-08-31"), 200000)
check("from it, at the card's tier", cutoff("acme", "2026-09-01"), 272000)
with_pricing({"acme": [GPT, {"from": "2026-09-01"}, {"from": "soon", "uncached_in": 1}]})
check("an empty later card leaves the old tier standing", cutoff("acme", "2026-09-02"), 272000)
check("a card whose from is not a date is ignored", cutoff("acme", "2099-01-01"), 272000)
with_pricing({"gpt-5.6-sol": [GPT, {"from": "2026-08-21", **GPT, "uncached_in": 4}]})
check("a price change that keeps the tier adds no SQL branch",
      "2026-08-21" in rollup.long_cutoff_sql("m", "d"), False)
with_pricing({"gpt-5.5": GPT, "openai/gpt-5.5": [{"from": "2026-09-01", "uncached_in": 5, "out": 30}]})
check("a literal card that starts later falls through to the plain tier before it",
      cutoff("openai/gpt-5.5", "2026-08-31"), 272000)
check("and pins its own split from its day", cutoff("openai/gpt-5.5", "2026-09-01"), 200000)

# 7b. The served model: a row is filed under the id the provider's reply names,
# else the id Lucidos sent. `asked` keeps the sent id only on a reroute, by the
# engine's served_as_sent() rule (llm/served_model.rs), whose own cases these are.
def filed(model, served):
    row = DB.execute(f"SELECT {rollup.row_model_sql('m', 's')}, {rollup.asked_sql('m', 's')} "
                     "FROM (SELECT ? AS m, ? AS s)", (model, served)).fetchone()
    return tuple(row)


for sent, served in [("gemini-3.5-flash", "gemini-3.6-flash"), ("gemini-3.5-flash", "gemini-3.5-pro"),
                     ("claude-opus-5", "claude-opus-5-5"), ("gemini-3.8-flash", "gemini-3.8-flash-lite"),
                     ("claude-opus-5-5[1m]", "claude-opus-5")]:
    check(f"{sent} answered by {served} is filed under {served}", filed(sent, served), (served, sent))
for sent, served in [("gemini-3.8-flash", "gemini-3.8-flash"), ("claude-haiku-4-5", "claude-haiku-4-5-20251001"),
                     ("gpt-5.6-luna", "gpt-5.6-luna-2026-04-01"), ("gemini-3.8-flash", "gemini-3.8-flash-001"),
                     ("google/gemini-3.8-flash", "gemini-3.8-flash"), ("gemini-3.8-flash", "google/gemini-3.8-flash"),
                     ("claude-opus-5[1m]", "claude-opus-5"), ("claude-opus-4-5", "claude-opus-4-5@20251101"),
                     ("claude-opus-4-5@20251101", "claude-opus-4-5-20251101"), ("qwen3", "qwen3:latest"),
                     ("GPT-5.6-Luna", "gpt-5.6-luna")]:
    check(f"{sent} answered by {served} is filed under {served}, not a reroute", filed(sent, served), (served, None))
for sent in ("claude-opus-5-5[1m]", "claude-sonnet-5-5[1m]", "claude-fable-5-1[1m]"):
    bare = sent.removesuffix("[1m]")
    check(f"{sent} answered as {bare} shares the plain row", filed(sent, bare), filed(bare, bare))
check("a row with no served model keeps its model, less [1m]", filed("claude-opus-5-5[1m]", None), ("claude-opus-5-5", None))
check("a reroute's [1m] served id drops it too", filed("claude-opus-5", "claude-opus-5-5[1m]"), ("claude-opus-5-5", "claude-opus-5"))
check("an empty served model too", filed("x", ""), ("x", None))
# The [1m] twin and its bare id split at the same cut, so filing under the bare
# id moves no token between the long and short rates.
with_pricing({"claude-haiku-5-5": {"uncached_in": 1, "long": {"threshold_tokens": 100000, "uncached_in": 2}}})
check("a [1m] id splits where its bare id does", cutoff("claude-haiku-5-5[1m]"), cutoff("claude-haiku-5-5"))
check("and that is the card's own tier", cutoff("claude-haiku-5-5"), 100000)
# A rerouted call splits at the card of the model that ran.
with_pricing({"gpt-5.5": GPT})
sql = rollup.long_cutoff_sql(rollup.row_model_sql("m", "s"), "d")
got = DB.execute(f"SELECT {sql} FROM (SELECT ? AS m, ? AS s, ? AS d)", ("gpt-5.4-mini", "gpt-5.5", "2026-10-10")).fetchone()[0]
check("a rerouted call splits at the served model's tier", got, 272000)
check("a release stamp finds the undated card", cutoff("gpt-5.5-2026-04-23"), 272000)
got = DB.execute(f"SELECT {sql} FROM (SELECT ? AS m, ? AS s, ? AS d)", ("gpt-5.5", "gpt-5.9", "2026-10-10")).fetchone()[0]
check("a reroute to a model with no card splits at the default, not the asked model's tier", got, 200000)

# 8. The edge of the tier. OpenAI (">272K"), Google ("> 200k") and Anthropic
# ("over 100,000") bill the long rates only ABOVE the threshold; xAI from a
# prompt that reaches it, which its card marks `inclusive`.
check("the rollup counts a call long only over the cut",
      "in_tok > long_cut" in rollup.ROLLUP_SQL and "in_tok >= long_cut" not in rollup.ROLLUP_SQL, True)
with_pricing({"gpt-5.5": GPT, "grok-4.6": {"uncached_in": 2, "out": 6,
              "long": {"threshold_tokens": 200000, "inclusive": True}}})
check("a GPT prompt of exactly 272,000 is short", is_long("gpt-5.5", 272000), False)
check("one token over is long", is_long("gpt-5.5", 272001), True)
check("an xAI prompt of exactly 200,000 is long", is_long("grok-4.6", 200000), True)
check("one token under is short", is_long("grok-4.6", 199999), False)
check("a tier-less model at exactly 200,000 is short", is_long("claude-opus-5", 200000), False)

# 9. A card with no tier splits at 200k, as the app's longRule() does. The
# global `long_context_multiplier` of pricing.json is gone: its multipliers
# were all 1.0, and long tiers live on cards. A stray one moves nothing.
with_pricing({"acme": {"uncached_in": 1, "out": 1}, "gpt-5.5": GPT},
             long_context_multiplier={"threshold_tokens": 150000, "in_multiplier": 2})
check("a tier-less card splits at 200k", cutoff("acme"), 200000)
check("so does an unlisted model", cutoff("acme/mystery-7b"), 200000)
check("a card's own tier still wins", cutoff("gpt-5.5"), 272000)
with_pricing({"acme": {"uncached_in": 1, "out": 1, "long": {"threshold_tokens": "abc"}},
              "acme-2": {"uncached_in": 1, "out": 1, "long": {"threshold_tokens": True}}})
check("a threshold that is not a number falls back, it does not crash", cutoff("acme"), 200000)
check("nor is true read as 1 token", cutoff("acme-2"), 200000)

# 10. Every gateway spelling the app resolves finds the same tier here.
with_pricing({"claude-haiku-5-5": {"uncached_in": 0.1, "out": 0.5, "long": {"threshold_tokens": 100000}}})
for spelled in ("anthropic/claude-haiku-5.5", "us.anthropic.claude-haiku-5-5-20261007-v1:0",
                "anthropic.claude-haiku-5-5-v1:0", "Claude-Haiku-5-5@x[1m]"):
    check(f"{spelled} splits at Haiku 5.5's 100k", cutoff(spelled), 100000)
check("a dotted non-Claude id is left alone", cutoff("gpt-5.5"), 200000)

# 11. A price table that cannot be read stops the run. Splitting at 200k
# instead would file every 200k-272k GPT call as long until the next rebuild.
def stops(name):
    try:
        rollup.long_cutoff_sql("m", "d")
        check(name, "no error", "PricingUnreadable")
    except rollup.PricingUnreadable:
        check(name, True, True)


broken = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
broken.write('{"models": {"gpt-5.5": ')
broken.close()
rollup.PRICE_TABLE = broken.name
stops("a half-written table stops the run")
rollup.PRICE_TABLE = str(pathlib.Path(tempfile.mkdtemp()) / "missing.json")
stops("a missing table file stops the run")


def via_cli(returncode, stdout, stderr=""):
    """Read the table the way a live run does, through `lucidos model-prices`."""
    seen = []

    class Done:
        pass

    def fake_run(cmd, **kw):
        seen.append(cmd)
        d = Done()
        d.returncode, d.stdout, d.stderr = returncode, stdout, stderr
        return d

    real = rollup.subprocess.run, rollup.PRICE_TABLE
    rollup.subprocess.run, rollup.PRICE_TABLE = fake_run, None
    try:
        return seen, rollup.read_pricing()
    except rollup.PricingUnreadable as e:
        return seen, e
    finally:
        rollup.subprocess.run, rollup.PRICE_TABLE = real


table = {"currency": "USD", "models": {"gpt-5.5": [dict(GPT, origin="override")]}}
seen, got = via_cli(0, json.dumps(table))
check("a live run asks `lucidos model-prices`", seen, [["lucidos", "model-prices"]])
check("and reads the table it prints", got, table)
seen, got = via_cli(2, "", "error: unrecognized subcommand 'model-prices'")
check("an engine with no price table stops the run, and says why",
      isinstance(got, rollup.PricingUnreadable) and "model-prices" in str(got), True)
seen, got = via_cli(0, '{"error": "not found"}')
check("a reply with no models stops the run", isinstance(got, rollup.PricingUnreadable), True)

# 12. A threshold change in the price table rebuilds every day once.
with_pricing({"gpt-5.5": GPT})
sig = rollup.split_signature(rollup.long_cutoff_sql("payload->>'model'", "d"))
with_pricing({"gpt-5.5": [GPT, {"from": "2026-11-01", **GPT, "uncached_in": 4}]})
check("a price change that keeps the threshold keeps the fingerprint",
      rollup.split_signature(rollup.long_cutoff_sql("payload->>'model'", "d")), sig)
with_pricing({"gpt-5.5": {**GPT, "long": {"threshold_tokens": 200000}}})
moved = rollup.split_signature(rollup.long_cutoff_sql("payload->>'model'", "d"))
check("a moved threshold changes it", moved != sig, True)
stamped = {"rollup_version": rollup.ROLLUP_VERSION, "long_split": sig}
check("a daily.json split at other thresholds is rebuilt",
      rollup.needs_rebuild(stamped, {}, moved) is not None, True)
check("the same thresholds run incrementally", rollup.needs_rebuild(stamped, {}, sig), None)
check("the fingerprint is written", '"long_split": split' in (HERE.parent / "scripts" / "rollup.py").read_text(), True)

# 13. A daily.json from before a rollup fix is rebuilt once, with no user step.
check("no file runs incrementally", rollup.needs_rebuild(None, {}), None)
check("an unstamped file is rebuilt", rollup.needs_rebuild({"days": {}}, {}) is not None, True)
check("an older stamp is rebuilt",
      rollup.needs_rebuild({"rollup_version": rollup.ROLLUP_VERSION - 1}, {}) is not None, True)
check("the current stamp is not",
      rollup.needs_rebuild({"rollup_version": rollup.ROLLUP_VERSION}, {}), None)
check("TOKEN_COST_REBUILD=1 still forces it",
      rollup.needs_rebuild({"rollup_version": rollup.ROLLUP_VERSION}, {"TOKEN_COST_REBUILD": "1"}) is not None, True)
check("the stamp is written", '"rollup_version": ROLLUP_VERSION' in (HERE.parent / "scripts" / "rollup.py").read_text(), True)
check("a file from before served-model filing is rebuilt, whatever the table holds",
      rollup.needs_rebuild({"rollup_version": 4}, {}) is not None, True)

# 14. Jev spend ends at the proxy cutover, where the engine's own rows begin.
# A drive result or a JevCallCompleted from after it would count a call twice.
def jev_fold(cutover):
    import os
    ws = pathlib.Path(tempfile.mkdtemp())
    for name, age in (("before", 7200), ("after", 60)):
        f = ws / "data" / "artifacts" / "browse" / name / "result.json"
        f.parent.mkdir(parents=True)
        f.write_text(json.dumps({"requests": 3 if name == "before" else 5}))
        stamp = rollup.datetime.now().timestamp() - age
        os.utime(f, (stamp, stamp))
    asked = []

    def fake_psql(sql):
        asked.append(sql)
        if sql == rollup.PROXY_CUTOVER_SQL:
            return "" if cutover is None else str(cutover)
        return "[]"

    real_psql, real_ws = rollup.psql, rollup.WS
    rollup.psql, rollup.WS = fake_psql, ws
    try:
        calls, _ = rollup.fold_jev({}, {}, set())
    finally:
        rollup.psql, rollup.WS = real_psql, real_ws
    return calls, asked


halfway = rollup.datetime.now().timestamp() - 3600
calls, asked = jev_fold(halfway)
check("a drive after the cutover is the engine's to count", calls, 3)
check("the event pass stops at the cutover",
      any(f"to_timestamp({halfway})" in q for q in asked), True)
calls, asked = jev_fold(None)
check("before any proxied row, every drive counts", calls, 8)
check("before any proxied row, every event counts",
      any("'infinity'::timestamptz" in q for q in asked), True)

# 15. Every query stops at the cursor the run writes. The app counts each row
# above the cursor live, so a row that landed while the rollup ran (a minute on
# a rebuild) was in the stored day AND the live tail: counted twice.
def run_main(head):
    asked, written = [], []

    def fake_psql(sql):
        asked.append(sql)
        if "max(sequence)" in sql and "string_agg" in sql:
            return head
        if sql.startswith("SELECT count(*)"):
            return "0"
        if sql == rollup.PROXY_CUTOVER_SQL:
            return ""
        if sql == rollup.ORIGIN_SQL:
            return "{}"
        return "[]"

    class Done:
        returncode, stderr = 0, ""

    def fake_run(cmd, **kw):
        written.append(json.loads(kw["input"]))
        return Done()

    real = rollup.psql, rollup.subprocess.run, rollup.OUT, rollup.THREADS_OUT, rollup.WS
    tmp = pathlib.Path(tempfile.mkdtemp())
    rollup.psql, rollup.subprocess.run, rollup.OUT, rollup.THREADS_OUT, rollup.WS = (
        fake_psql, fake_run, tmp / "daily.json", tmp / "threads-daily.json", tmp)
    try:
        rollup.main()
    finally:
        rollup.psql, rollup.subprocess.run, rollup.OUT, rollup.THREADS_OUT, rollup.WS = real
    return asked, written


with_pricing({"gpt-5.5": GPT})
asked, written = run_main("4242|2026-10-10")
reads = [q for q in asked if "= ANY (ARRAY[" in q]
check("the rollup, the voice pass and the row count all ran", len(reads), 3)
check("each stops at the cursor", all("sequence <= 4242" in q for q in reads), True)
check("no placeholder is left in any query", any("%(" in q for q in asked), False)
check("the cursor written is that same ceiling", written and written[0]["last_sequence"], 4242)
check("daily, thread, handoff and cache evidence files are written", len(written), 4)
check("the thread file carries the same cursor", written[1]["last_sequence"], 4242)
check("the handoff file carries the window, the fields and the thread titles",
      (written[2].get("window"), written[2].get("fields") == list(rollup.THREAD_FIELDS), "threads" in written[2]),
      (rollup.HANDOFF_WINDOW, True, True))
check("the handoff reads stop at the cursor too",
      [q for q in asked if "parent_tool_use_id" in q and q != rollup.CACHE_SQL] != []
      and all("sequence <= 4242" in q for q in asked if "parent_tool_use_id" in q and q != rollup.CACHE_SQL), True)
asked_idle, written_idle = run_main("0|")
check("a rollup without new calls still rebuilds cache evidence", len(written_idle), 1)
check("old snapshots gain a versioned cache file without a rebuild", written_idle[0].get("version"), 1)
check("cache query still runs on status-only updates", rollup.CACHE_SQL in asked_idle, True)

# 16. A Flex call is summed apart, never also as a long call, and a file
# from before the Flex bucket is rebuilt once.
check("the rollup sums Flex calls apart",
      "FILTER (WHERE flex AND in_tok <= long_cut) AS flex_in" in rollup.ROLLUP_SQL, True)
check("a Flex call is read off its usage block",
      "payload->'usage'->>'service_tier'" in rollup.ROLLUP_SQL, True)
check("a file from before the Flex bucket is rebuilt",
      rollup.needs_rebuild({"rollup_version": 5}, {}) is not None, True)

# 17. psql connects through LUCIDOS_DATABASE_URL. The engine sets no PG* vars
# (ADR 0481), so a bare `psql` tries the local socket and reaches nothing.
def psql_argv(env):
    import os
    seen = []

    class Done:
        returncode, stdout, stderr = 0, "1\n", ""

    def fake_run(cmd, **kw):
        seen.append(cmd)
        return Done()

    real_run, real_env = rollup.subprocess.run, dict(os.environ)
    rollup.subprocess.run = fake_run
    os.environ.clear()
    os.environ.update(env)
    try:
        out = rollup.psql("SELECT 1")
    finally:
        rollup.subprocess.run = real_run
        os.environ.clear()
        os.environ.update(real_env)
    return seen[0], out


argv, out = psql_argv({"LUCIDOS_DATABASE_URL": "postgresql://ro@db.invalid/ws"})
check("psql is handed the workspace URL first", argv[:2], ["psql", "postgresql://ro@db.invalid/ws"])
check("psql keeps its flags and query", argv[2:], ["-A", "-t", "-c", "SELECT 1"])
check("psql output is still stripped", out, "1")
check("the rollup never asks for a write", "READ WRITE" in " ".join(argv), False)

# 18. Per-thread rows, for the app's Thread group-by.
doc = {"a": 1, "days": {"2026-10-18": {"t": {"k": [1]}}, "2026-10-19": {}}, "hours": {}}
text = rollup.dumps_by_day(doc)
check("the thread file is still one JSON document", json.loads(text), doc)
check("with each day on its own line", sum(1 for l in text.splitlines() if l.startswith('"2026-10-')), 2)
check("a thread row drops its trailing zeros",
      rollup.thread_row({"calls": 3, "cached_calls": 2, "in": 900, "cache_read": 600,
                         "cache_write": 0, "out": 40, "seconds": 0, "max_in": 400,
                         "long": {"in": 0}, "flex": {}}),
      [3, 2, 900, 600, 0, 40, 0, 400])
check("a long call keeps its tail",
      rollup.thread_row({"calls": 1, "in": 300000, "long": {"in": 300000}})[:9],
      [1, 0, 300000, 0, 0, 0, 0, 0, 300000])
check("the rollup counts calls that read the cache",
      "count(*) FILTER (WHERE cr > 0) AS cached_calls" in rollup.ROLLUP_SQL, True)
check("the rollup groups by effort", "coalesce(payload->>'reasoning_effort', '') AS effort" in rollup.ROLLUP_SQL, True)
check("an effort joins the key", rollup.row_key("p", "m", "high"), "p|m|high")
check("no effort keeps the old key", rollup.row_key("p", "m", ""), "p|m")
check("the rollup groups by thread", "GROUP BY 1, 2, 3, 4, 5, 6, 7" in rollup.ROLLUP_SQL, True)
check("a file from before the thread split is rebuilt",
      rollup.needs_rebuild({"rollup_version": 6}, {}) is not None, True)

# 19. A cache keep-alive ping is filed under its own type, by its anchor.
check("a keep-alive call is filed under its own type",
      "CASE WHEN keep_alive THEN 'cache_keep_alive' ELSE producer END AS producer" in rollup.ROLLUP_SQL, True)
check("the anchor test reads the capture's request_event_id, not the anchor's",
      "FROM events c" in rollup.ROLLUP_SQL and "(c.payload->>'request_event_id')::uuid" in rollup.KEEP_ALIVE, True)
check("a malformed request_event_id never reaches the cast", "a.id = CASE" in rollup.KEEP_ALIVE, True)
check("a file from before the keep-alive type is rebuilt",
      rollup.needs_rebuild({"rollup_version": 7}, {}) is not None, True)

# 20. Auxiliary calls are filed per purpose, so the app can filter and group
# by each one. Every other producer keeps its own id. Voice and proxy rows are
# `auxiliary` too (purpose voice, proxy), so they split the same way.
def producer_id(producer, purpose="<absent>"):
    payload = {"producer": producer}
    if purpose != "<absent>":
        payload["purpose"] = purpose
    sql = rollup.producer_id_sql("payload")
    return DB.execute(f"SELECT {sql} FROM (SELECT ? AS payload)", (json.dumps(payload),)).fetchone()[0]


check("an auxiliary call is filed under its purpose", producer_id("auxiliary", "memory"), "auxiliary:memory")
check("a purpose with an underscore", producer_id("auxiliary", "summary_compaction"), "auxiliary:summary_compaction")
check("voice is its own auxiliary row", producer_id("auxiliary", "voice"), "auxiliary:voice")
check("proxy is its own auxiliary row", producer_id("auxiliary", "proxy"), "auxiliary:proxy")
check("no purpose stays bare auxiliary", producer_id("auxiliary", None), "auxiliary")
check("an empty purpose stays bare auxiliary", producer_id("auxiliary", ""), "auxiliary")
check("a missing purpose stays bare auxiliary", producer_id("auxiliary"), "auxiliary")
check("a pipe in a purpose cannot split the row key", producer_id("auxiliary", "a|b"), "auxiliary:a_b")
check("main_llm keeps its id", producer_id("main_llm"), "main_llm")
check("claude_code keeps its id whatever the purpose", producer_id("claude_code", "proxy"), "claude_code")
check("codex keeps its id", producer_id("codex", "voice"), "codex")
check("a producer-less row stays NULL, as before", producer_id(None, "memory"), None)
check("the main query files by the producer id",
      f"{rollup.producer_id_sql('payload')} AS producer" in rollup.ROLLUP_SQL, True)
check("voice seconds join on the same id, or they would land on another row",
      f"{rollup.producer_id_sql('payload')} AS producer" in rollup.SECONDS_SQL, True)
check("the keep-alive CASE still sits over it",
      "CASE WHEN keep_alive THEN 'cache_keep_alive' ELSE producer END AS producer" in rollup.ROLLUP_SQL, True)
check("an auxiliary key reads back as producer|model", rollup.row_key("auxiliary:memory", "m"), "auxiliary:memory|m")
check("the duplicate-frame test still reads the raw producer",
      "AND payload->>'producer' = 'claude_code' AS dup" in rollup.ROLLUP_SQL, True)
check("a file from before the aux split is rebuilt",
      rollup.needs_rebuild({"rollup_version": 11}, {}) is not None, True)
src = (HERE.parent / "scripts" / "rollup.py").read_text()
check("the format note names the aux ids", src.count("auxiliary:<purpose>") >= 2, True)


def meta_from(doc):
    real = rollup.psql
    rollup.psql = lambda sql: json.dumps(doc)
    try:
        return rollup.thread_meta({"kid", "gone"})
    finally:
        rollup.psql = real


meta = meta_from({"kid": ["Fix test", "mid"], "mid": ["Sub", "root"], "root": ["Parent", None],
                  "other": ["Unrelated", None]})
check("a sub-thread brings its ancestors along", sorted(meta), ["kid", "mid", "root"])
check("a root carries no parent", meta["root"], ["Parent"])
check("a thread the summaries lost is left out", "gone" in meta, False)
check("unreadable summaries give no titles, not a crash", meta_from([]), {})

# 20. Token Cost 0.4.x prices move into the price table before the rollup
# reads it, so a model priced only in the old pricing.json splits at its own
# card. migrate.test.py covers the migration itself.
order = []
real_migrate, real_read = rollup.migrate_legacy_prices, rollup.read_pricing
rollup.migrate_legacy_prices = lambda: order.append("migrate")
rollup.read_pricing = lambda: (order.append("read"), real_read())[1]
try:
    run_main("4242|2026-10-10")
finally:
    rollup.migrate_legacy_prices, rollup.read_pricing = real_migrate, real_read
check("the migration runs before the price table is read", order[:2], ["migrate", "read"])
check("the rollup finds the migration script beside it", rollup.MIGRATE.exists(), True)

import os  # noqa: E402

ws = pathlib.Path(tempfile.mkdtemp())
(ws / "data" / "artifacts" / "token-cost").mkdir(parents=True)
(ws / "data" / "artifacts" / "token-cost" / "pricing.json").write_text(
    (HERE / "fixtures" / "legacy-pricing-0.4.json").read_text())
(ws / "bin").mkdir()
(ws / "bin" / "lucidos").write_text(f'#!/bin/sh\nexec "{sys.executable}" -I "{HERE / "fake_lucidos.py"}" "$@"\n')
(ws / "bin" / "lucidos").chmod(0o755)
saved_env = dict(os.environ)
os.environ.update({"PATH": f"{ws / 'bin'}:{os.environ['PATH']}", "LUCIDOS_WORKSPACE": str(ws),
                   "FAKE_SHIPPED": str(HERE / "fixtures" / "shipped-prices.json")})
real_ws, real_table = rollup.WS, rollup.PRICE_TABLE
override = ws / "data" / "config" / "model-prices.json"
try:
    rollup.WS = ws
    rollup.PRICE_TABLE = "/fixed/table.json"
    rollup.migrate_legacy_prices()
    check("a fixed test table skips the migration", override.exists(), False)
    rollup.PRICE_TABLE = None
    rollup.migrate_legacy_prices()
    check("otherwise the legacy cards land in the override",
          "gemini-3-flash-preview" in json.loads(override.read_text())["models"], True)
finally:
    rollup.WS, rollup.PRICE_TABLE = real_ws, real_table
    os.environ.clear()
    os.environ.update(saved_env)

# 21. A Lucidos Agent call is filed by the origin of the thread it ran in:
# main_llm:chat, main_llm:trigger, main_llm:other, or bare main_llm when the
# summaries cannot say. The rule reads thread_summaries; a sub-thread takes its
# root's origin. Nothing unknown is guessed as chat.
SUMMARIES = {
    # thread: [source, initiator, trigger_id, parent, active in the export window]
    "trig": ["trigger", "system", "t-1", None, True],
    "trig-in-chat": ["chat", "system", "t-2", None, True],
    "chat": ["chat", "user", None, None, True],
    "sys": ["chat", "system", None, None, True],
    "kid-of-trig": ["chat", "system", None, "trig", True],
    "grandkid": ["chat", "system", None, "kid-of-trig", True],
    "kid-of-chat": ["chat", "system", None, "chat", False],
    "orphan": ["chat", "user", None, "gone", True],
    "loop-a": ["chat", "user", None, "loop-b", True],
    "loop-b": ["chat", "user", None, "loop-a", True],
    "blank-trigger": ["chat", "user", "", None, True],
    "old-chat": ["chat", "user", None, None, False],
}
origins = rollup.classify_origins(SUMMARIES)
check("a thread a trigger opened is trigger", (origins["trig"], origins["trig-in-chat"]), ("trigger", "trigger"))
check("a thread a person started is chat", origins["chat"], "chat")
check("a system-started thread with no trigger or parent is other", origins["sys"], "other")
check("a sub-thread inherits its root", (origins["kid-of-trig"], origins["grandkid"], origins["kid-of-chat"]),
      ("trigger", "trigger", "chat"))
check("a sub-thread whose parent is gone is unknown", "orphan" in origins, False)
check("a parent cycle is unknown, and terminates", ("loop-a" in origins, "loop-b" in origins), (False, False))
check("an empty trigger id is no trigger", origins["blank-trigger"], "chat")
check("a thread the summaries lost is unknown", "gone" in origins, False)

check("an agent call takes its thread's origin", rollup.agent_producer("main_llm", "trig", origins), "main_llm:trigger")
check("chat", rollup.agent_producer("main_llm", "chat", origins), "main_llm:chat")
check("an unknown thread keeps the bare id", rollup.agent_producer("main_llm", "gone", origins), "main_llm")
check("a call with no thread keeps the bare id", rollup.agent_producer("main_llm", "", origins), "main_llm")
check("an auxiliary call is never split by origin",
      rollup.agent_producer("auxiliary:title", "trig", origins), "auxiliary:title")
check("nor is Claude Code", rollup.agent_producer("claude_code", "chat", origins), "claude_code")
check("nor a keep-alive ping", rollup.agent_producer("cache_keep_alive", "chat", origins), "cache_keep_alive")
check("the origin query reads the projection", "FROM thread_summaries" in rollup.ORIGIN_SQL, True)
check("a file from before the origin split is rebuilt",
      rollup.needs_rebuild({"rollup_version": 12}, {}) is not None, True)


def qrow(thread, producer, calls, tokens, hour=9, model="gpt-5.5", session=None):
    """One row of ROLLUP_SQL's output."""
    z = {k: 0 for k in ("cached_calls", "cache_read", "cache_write", "out_tok", "b1", "b2", "b3", "b4", "b5",
                        "long_in", "long_out", "long_cr", "long_cw", "flex_in", "flex_out", "flex_cr", "flex_cw")}
    return {**z, "day": "2026-10-10", "hour": hour, "producer": producer, "model": model, "asked": None,
            "effort": "", "thread": thread, "session": session, "calls": calls, "total_in": tokens,
            "b0": calls, "max_in": tokens}


def run_origin_main(rows, secs, summaries):
    asked, written = [], []

    def fake_psql(sql):
        asked.append(sql)
        if "max(sequence)" in sql and "string_agg" in sql:
            return "5000|2026-10-10"
        if sql.startswith("SELECT count(*)"):
            return str(sum(r["calls"] for r in rows))
        if sql == rollup.PROXY_CUTOVER_SQL:
            return ""
        if sql == rollup.ORIGIN_SQL:
            if isinstance(summaries, Exception):
                sys.exit("psql failed: relation thread_summaries is unreadable")
            return json.dumps(summaries)
        if sql == rollup.THREAD_META_SQL:
            return "{}"
        if "duration_secs" in sql:
            return json.dumps(secs)
        if "FROM events c" in sql and "GROUP BY" in sql:
            return json.dumps(rows)
        return "[]"

    class Done:
        returncode, stderr = 0, ""

    def fake_run(cmd, **kw):
        written.append(json.loads(kw["input"]))
        return Done()

    real = rollup.psql, rollup.subprocess.run, rollup.OUT, rollup.THREADS_OUT, rollup.WS
    tmp = pathlib.Path(tempfile.mkdtemp())
    rollup.psql, rollup.subprocess.run, rollup.OUT, rollup.THREADS_OUT, rollup.WS = (
        fake_psql, fake_run, tmp / "daily.json", tmp / "threads-daily.json", tmp)
    try:
        rollup.main()
        exited = None
    except SystemExit as e:
        exited = str(e)
    finally:
        rollup.psql, rollup.subprocess.run, rollup.OUT, rollup.THREADS_OUT, rollup.WS = real
    return asked, written, exited


ROWS = [
    qrow("chat", "main_llm", 3, 3000),
    qrow("trig", "main_llm", 5, 5000),
    qrow("kid-of-trig", "main_llm", 1, 100, hour=10),
    qrow("sys", "main_llm", 2, 200),
    qrow("gone", "main_llm", 7, 700),
    qrow("trig", "auxiliary:title", 4, 400),
    qrow("chat", "claude_code", 6, 600),
]
SECS = [{"day": "2026-10-10", "hour": 9, "producer": "main_llm", "model": "gpt-5.5", "thread": "trig", "seconds": 30}]
asked, written, exited = run_origin_main(ROWS, SECS, SUMMARIES)
check("the run with origins completes", exited, None)
day = written[0]["days"]["2026-10-10"] if written else {}
check("the day holds one key per origin, auxiliary and Claude Code apart", sorted(day), sorted([
    "main_llm:chat|gpt-5.5", "main_llm:trigger|gpt-5.5", "main_llm:other|gpt-5.5", "main_llm|gpt-5.5",
    "auxiliary:title|gpt-5.5", "claude_code|gpt-5.5"]))
check("chat calls", day.get("main_llm:chat|gpt-5.5", {}).get("calls"), 3)
check("trigger calls, its sub-thread included", day.get("main_llm:trigger|gpt-5.5", {}).get("calls"), 6)
check("a thread with no summary is the bare id", day.get("main_llm|gpt-5.5", {}).get("calls"), 7)
check("voice seconds land on the row their tokens are in", day.get("main_llm:trigger|gpt-5.5", {}).get("seconds"), 30)
check("calls are conserved across the split", sum(b["calls"] for b in day.values()), sum(r["calls"] for r in ROWS))
check("tokens are conserved across the split", sum(b["in"] for b in day.values()), sum(r["total_in"] for r in ROWS))
hrs = written[0]["hours"]["2026-10-10"] if written else {}
check("the hours carry the same keys", sorted({k for h in hrs.values() for k in h}), sorted(day))
check("and the same calls", sum(b["calls"] for h in hrs.values() for b in h.values()), sum(r["calls"] for r in ROWS))
tdays = written[1]["days"]["2026-10-10"] if len(written) > 1 else {}
check("the thread file files by origin too", sorted(tdays.get("trig", {})),
      ["auxiliary:title|gpt-5.5", "main_llm:trigger|gpt-5.5"])
check("the thread file sums to the same calls",
      sum(r[0] for keys in tdays.values() for r in keys.values()), sum(r["calls"] for r in ROWS))
exported = written[0].get("thread_origins", {}) if written else {}
check("daily.json carries the origins of recently active threads", exported, {
    "chat": ["blank-trigger", "chat"],
    "other": ["sys"],
    "trigger": ["grandkid", "kid-of-trig", "trig", "trig-in-chat"]})
check("a thread outside the window is not exported", "old-chat" in exported.get("chat", []), False)
check("the format note names the origin ids", "main_llm:<origin>" in written[0].get("note", ""), True)

asked, written, exited = run_origin_main(ROWS, SECS, RuntimeError("no summaries"))
check("an unreadable projection stops the run", exited is not None, True)
check("and writes nothing, rather than filing every agent call as unknown", written, [])


# 22. Agent sessions. A thread can hold several sessions (a handoff starts a
# successor session in the same thread), each on its own backend and model.
# The thread file keys each one `<thread>@<session>`, and the frame dedupe
# never compares the last call of one session with the first of the next.
check("a call naming its session is keyed thread@session", rollup.thread_slot("t", "2"), "t@2")
check("a call from before sessions keeps the bare thread", rollup.thread_slot("t", None), "t")
check("Jev has no thread and no session", rollup.thread_slot("", "1"), "")
check("a slot gives back its thread", (rollup.slot_thread("t@2"), rollup.slot_thread("t")), ("t", "t"))
check("the dedupe partitions by thread and session",
      "PARTITION BY thread_id, payload->>'session' ORDER BY sequence" in rollup.ROLLUP_SQL, True)
check("the rollup groups by session", "payload->>'session' AS session" in rollup.ROLLUP_SQL, True)
check("voice seconds take the session of their own thread's call",
      "CASE WHEN c.thread_id = e.thread_id THEN c.session END" in rollup.SECONDS_SQL, True)
check("a file from before sessions is rebuilt",
      rollup.needs_rebuild({"rollup_version": 13}, {}) is not None, True)

# A two-session thread: Claude Code in session 1, Codex in session 2.
TWO = [
    qrow("chat", "claude_code", 4, 4000, model="claude-opus-5-5", session="1"),
    qrow("chat", "codex", 3, 900, hour=10, model="gpt-5.5", session="2"),
    qrow("chat", "main_llm", 2, 200, session=None),
]
asked, written, exited = run_origin_main(TWO, [], SUMMARIES)
check("the two-session run completes", exited, None)
tdays = written[1]["days"]["2026-10-10"] if len(written) > 1 else {}
check("the thread file holds one slot per session", sorted(tdays), ["chat", "chat@1", "chat@2"])
check("session 1 holds Claude Code", sorted(tdays.get("chat@1", {})), ["claude_code|claude-opus-5-5"])
check("session 2 holds Codex", sorted(tdays.get("chat@2", {})), ["codex|gpt-5.5"])
check("the sessions keep their own peak",
      (tdays["chat@1"]["claude_code|claude-opus-5-5"][7], tdays["chat@2"]["codex|gpt-5.5"][7]), (4000, 900))
check("the sessions sum to the day's calls",
      sum(r[0] for keys in tdays.values() for r in keys.values()),
      sum(b["calls"] for b in written[0]["days"]["2026-10-10"].values()))
thrs = written[1]["hours"]["2026-10-10"] if len(written) > 1 else {}
check("the hours split by session too", sorted(thrs.get("10", {})), ["chat@2"])
check("the format note names the slot", "<thread>@<session>" in written[1].get("note", ""), True)


# 23. A legacy successor chain keeps its link, so the app folds it into one row.
def meta_with(doc, tids):
    real = rollup.psql
    rollup.psql = lambda sql: json.dumps(doc)
    try:
        return rollup.thread_meta(tids)
    finally:
        rollup.psql = real


meta = meta_with({"first": ["Build", None, None], "second": ["Build (2)", None, "first"],
                  "kid": ["Sub", "second", None]}, {"kid@1", "second@3"})
check("a successor thread names its predecessor", meta.get("second"), ["Build (2)", None, "first"])
check("and the predecessor comes along", meta.get("first"), ["Build"])
check("a sub-thread keeps its parent", meta.get("kid"), ["Sub", "second"])
check("the meta query reads successor_of", "successor_of" in rollup.THREAD_META_SQL, True)


# 24. Handoffs. A warm handoff (narrative) has a narrative turn, a cold one
# (brief) has none. Before and after are the windows either side.
def ev(seq, type_, thread="t", **kw):
    return {"thread": thread, "seq": seq, "type": type_, "day": "2026-10-23",
            "at": f"2026-10-23T10:{seq % 60:02d}:00Z", **kw}


def call(seq, session, thread="t", producer="claude_code", model="claude-opus-5-5", tokens=1000, **kw):
    return {"thread": thread, "seq": seq, "session": session, "producer": producer, "model": model,
            "effort": "medium", "in_tok": tokens, "cr": tokens // 2, "cw": 0, "out_tok": 10, **kw}


EVENTS = [
    ev(1, "SessionStarted", continuity="first", coding_agent="claude-code"),
    ev(10, "CodingAgentIdled"),
    ev(20, "HandoffCheckpointReached", checkpoint="phase-commit", progress="2/5", pays="true"),
    ev(24, "SessionHandedOff", opening="narrative", checkpoint="phase-commit", progress="2/5"),
    ev(25, "CodingAgentIdled"),
    ev(26, "SessionStarted", continuity="handoff", opening="narrative", checkpoint="phase-commit",
       progress="2/5", coding_agent="codex"),
    ev(40, "SessionHandedOff", opening="brief"),
    ev(41, "SessionStarted", continuity="handoff", opening="brief", coding_agent="claude-code"),
]
CALLS = ([call(s, "1", tokens=100000 + s) for s in range(2, 20)]
         + [call(21, "1", tokens=150000), call(22, "1", tokens=151000), call(23, "1", tokens=152000)]
         + [call(s, "2", producer="codex", model="gpt-5.5", tokens=20000) for s in range(27, 40)]
         + [call(s, "3", tokens=5000) for s in range(42, 70)])
hs = rollup.build_handoffs(EVENTS, CALLS)
check("two handoffs in one thread", [(h["from_session"], h["to_session"]) for h in hs], [(1, 2), (2, 3)])
warm, cold = hs
check("a warm handoff stays in its thread", (warm["kind"], warm["thread"], warm["to_thread"]), ("session", "t", "t"))
check("its narrative turn is the calls after the checkpoint",
      warm["narrative"]["claude_code|claude-opus-5-5|medium"][0], 3)
check("before is the last calls ahead of the narrative turn",
      warm["before"]["claude_code|claude-opus-5-5|medium"][0], 18)
check("after is the new session's first calls, on its own backend",
      sorted(warm["after"]), ["codex|gpt-5.5|medium"])
check("the implementers either side",
      (warm["from"], warm["to"]), ("claude_code|claude-opus-5-5|medium", "codex|gpt-5.5|medium"))
check("the checkpoint, its progress and the estimate's verdict",
      (warm["checkpoint"], warm["progress"], warm["pays"]), ("phase-commit", "2/5", True))
check("a cold handoff has no narrative turn", (cold["opening"], cold["narrative"]), ("brief", None))
check("its before window is the old session's last calls",
      cold["before"]["codex|gpt-5.5|medium"][0], 13)
check("the after window stops at the window size",
      cold["after"]["claude_code|claude-opus-5-5|medium"][0], rollup.HANDOFF_WINDOW)
check("a handoff with no checkpoint borrows no reading from an earlier session",
      (cold["checkpoint"], cold["pays"]), (None, None))

# A resume opens no session, so the ordinal skips it.
RESUMED = [ev(1, "SessionStarted", continuity="first"), ev(5, "SessionStarted", continuity="resumed"),
           ev(8, "SessionStarted", continuity="fresh"), ev(12, "SessionStarted", continuity="handoff", opening="brief")]
hs = rollup.build_handoffs(RESUMED, [call(9, "2"), call(13, "3")])
check("a resume stays in its session, a fresh start opens the next",
      [(h["from_session"], h["to_session"]) for h in hs], [(2, 3)])

# A legacy successor thread: the old thread's last session against the new thread's first.
LEGACY = [ev(5, "CodingAgentIdled", thread="old"),
          ev(9, "SuccessorThreadSpawned", thread="old", successor="new")]
hs = rollup.build_handoffs(LEGACY, [call(3, None, thread="old"), call(6, None, thread="old"),
                                    call(7, None, thread="old"), call(20, None, thread="new")])
check("a legacy successor thread is a handoff of kind thread",
      [(h["kind"], h["thread"], h["to_thread"], h["opening"]) for h in hs], [("thread", "old", "new", None)])
check("its last turn is measured as the narrative turn",
      sum(r[0] for r in hs[0]["narrative"].values()), 2)
check("and the new thread's first calls are after", sum(r[0] for r in hs[0]["after"].values()), 1)

# A long call keeps its tokens in `long`, as the app prices it.
row = rollup.call_bundles([call(1, "1", tokens=300000, long=True)])["claude_code|claude-opus-5-5|medium"]
fields = list(rollup.THREAD_FIELDS)
check("a long call's prompt lands in long.in", row[fields.index("long.in")], 300000)
check("the handoff calls exclude sub-agents and keep-alives",
      "parent_tool_use_id' IS NULL" in rollup.HANDOFF_CALLS_SQL and "NOT (c.payload->>'producer'" in rollup.HANDOFF_CALLS_SQL,
      True)

# Session spans: the calls since the cursor fold into the spans on file.
def spans_with(reply, old, since=10, max_seq=20):
    asked = []
    real = rollup.psql
    def fake(sql):
        asked.append(sql)
        if isinstance(reply, Exception):
            sys.exit("psql failed")
        return json.dumps(reply)
    rollup.psql = fake
    try:
        return rollup.session_spans(old, since, max_seq), asked
    finally:
        rollup.psql = real

OLD = {"t@1": ["2026-10-20T08:00:00Z", "2026-10-20T09:00:00Z"], "t@2": ["2026-10-21T08:00:00Z", "2026-10-21T08:30:00Z"]}
spans, asked = spans_with({"t@2": ["2026-10-22T10:00:00Z", "2026-10-22T11:00:00Z"],
                           "u": ["2026-10-22T07:00:00Z", "2026-10-22T07:05:00Z"]}, OLD)
check("a session that called again keeps its first call and moves its last",
      spans["t@2"], ["2026-10-21T08:00:00Z", "2026-10-22T11:00:00Z"])
check("a session with no new call keeps its span", spans["t@1"], OLD["t@1"])
check("a new slot gets its own span", spans["u"], ["2026-10-22T07:00:00Z", "2026-10-22T07:05:00Z"])
check("the span query reads only above the cursor, up to the ceiling",
      "sequence > 10 AND sequence <= 20" in asked[0], True)
spans, _ = spans_with(RuntimeError(), OLD)
check("a failed read keeps the spans on file", spans, OLD)
check("the thread file writes one span per line",
      sum(1 for line in rollup.dumps_by_day({"sessions": OLD}).splitlines() if line.startswith('"t@')), 2)

print(f"{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
