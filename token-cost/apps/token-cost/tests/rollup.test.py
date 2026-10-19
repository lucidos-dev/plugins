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

# 7b. The served model: a row is priced as the model that answered, by the
# engine's served_as_sent() rule (llm/served_model.rs), whose own cases these are.
def priced(model, served):
    row = DB.execute(f"SELECT {rollup.priced_model_sql('m', 's')}, {rollup.asked_sql('m', 's')} "
                     "FROM (SELECT ? AS m, ? AS s)", (model, served)).fetchone()
    return tuple(row)


for sent, served in [("gemini-3.5-flash", "gemini-3.6-flash"), ("gemini-3.5-flash", "gemini-3.5-pro"),
                     ("claude-opus-5", "claude-opus-5-5"), ("gemini-3.8-flash", "gemini-3.8-flash-lite")]:
    check(f"{sent} answered by {served} is priced as {served}", priced(sent, served), (served, sent))
for sent, served in [("gemini-3.8-flash", "gemini-3.8-flash"), ("claude-haiku-4-5", "claude-haiku-4-5-20251001"),
                     ("gpt-5.6-luna", "gpt-5.6-luna-2026-04-01"), ("gemini-3.8-flash", "gemini-3.8-flash-001"),
                     ("google/gemini-3.8-flash", "gemini-3.8-flash"), ("gemini-3.8-flash", "google/gemini-3.8-flash"),
                     ("claude-opus-5[1m]", "claude-opus-5"), ("claude-opus-4-5", "claude-opus-4-5@20251101"),
                     ("claude-opus-4-5@20251101", "claude-opus-4-5-20251101"), ("qwen3", "qwen3:latest"),
                     ("GPT-5.6-Luna", "gpt-5.6-luna")]:
    check(f"{sent} answered by {served} keeps the requested id", priced(sent, served), (sent, None))
check("a row with no served model keeps its model", priced("claude-opus-5-5[1m]", None), ("claude-opus-5-5[1m]", None))
check("an empty served model too", priced("x", ""), ("x", None))
# A rerouted call splits at the card of the model that ran.
with_pricing({"gpt-5.5": GPT})
sql = rollup.long_cutoff_sql(rollup.priced_model_sql("m", "s"), "d")
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
check("the thread file is written second", len(written), 2)
check("the thread file carries the same cursor", written[1]["last_sequence"], 4242)

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
check("the rollup groups by thread", "GROUP BY 1, 2, 3, 4, 5, 6" in rollup.ROLLUP_SQL, True)
check("a file from before the thread split is rebuilt",
      rollup.needs_rebuild({"rollup_version": 6}, {}) is not None, True)


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

print(f"{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
