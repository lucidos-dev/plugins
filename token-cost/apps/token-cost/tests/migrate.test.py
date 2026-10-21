"""The 0.4.x price migration, scripts/token-cost/migrate_prices.py.

Token Cost 0.4.x kept its prices in artifacts/token-cost/pricing.json. 0.5.0
moved to Lucidos's price table and stopped reading that file, with no
migration, so every model the shipped cards miss went unpriced on update.
These pin that the migration carries exactly the cards the merged table
does not price, unchanged, through the engine's own write path, and that
it never loses, invents or silently drops a price.

The engine is tests/fake_lucidos.py, put on PATH as `lucidos`: the shipped
cards in fixtures/shipped-prices.json merged with the override the way
llm/model_prices.rs merges it. The legacy file is fixtures/
legacy-pricing-0.4.json, sanitized from a real 0.4.4 install.
"""
import copy
import fcntl
import hashlib
import importlib.util
import json
import os
import pathlib

import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
FIX = HERE / "fixtures"
MODULE = HERE.parents[2] / "scripts" / "token-cost" / "migrate_prices.py"
spec = importlib.util.spec_from_file_location("migrate_prices", MODULE)
mp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mp)

LEGACY = json.loads((FIX / "legacy-pricing-0.4.json").read_text())
SHIPPED = json.loads((FIX / "shipped-prices.json").read_text())

passed = failed = 0


def check(name, got, want):
    global passed, failed
    if got == want:
        passed += 1
    else:
        failed += 1
        print(f"  FAIL {name}: got {got!r}, want {want!r}")


class Workspace:
    """A temporary workspace with a fake `lucidos` on PATH."""

    def __init__(self, legacy=LEGACY, shipped=SHIPPED, override=None, settings=None, legacy_text=None):
        self.root = pathlib.Path(tempfile.mkdtemp(prefix="tc-migrate-"))
        self.data = self.root / "data"
        (self.data / "artifacts" / "token-cost").mkdir(parents=True)
        self.legacy = self.data / "artifacts" / "token-cost" / "pricing.json"
        if legacy is not None or legacy_text is not None:
            self.legacy.write_text(legacy_text if legacy_text is not None else json.dumps(legacy, indent=2))
            os.utime(self.legacy, (1_700_000_000, 1_700_000_000))
        self.override = self.data / "config" / "model-prices.json"
        if override is not None:
            self.override.parent.mkdir(parents=True)
            self.override.write_text(override if isinstance(override, str) else json.dumps(override, indent=2))
        self.settings = self.data / "artifacts" / "token-cost" / "settings.json"
        if settings is not None:
            self.settings.write_text(json.dumps(settings))
        self.report_path = self.data / "artifacts" / "token-cost" / "price-migration.json"
        self.shipped = self.root / "shipped.json"
        self.shipped.write_text(json.dumps(shipped))
        self.log = self.root / "cli.log"
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        fake = bin_dir / "lucidos"
        fake.write_text(f'#!/bin/sh\nexec "{sys.executable}" -I "{HERE / "fake_lucidos.py"}" "$@"\n')
        fake.chmod(0o755)
        self.env = {"PATH": f"{bin_dir}:{os.environ['PATH']}", "LUCIDOS_WORKSPACE": str(self.root),
                    "FAKE_SHIPPED": str(self.shipped), "FAKE_LOG": str(self.log)}
        self.legacy_stamp = self.stamp(self.legacy)

    @staticmethod
    def stamp(p):
        if not p.exists():
            return None
        return hashlib.sha256(p.read_bytes()).hexdigest(), p.stat().st_mtime_ns

    def run(self, dry_run=False, hooks=None, **env):
        """Migrate in-process, with this workspace's environment."""
        saved = {k: os.environ.get(k) for k in [*self.env, "FAKE_FAIL", "FAKE_REJECT"]}
        os.environ.update(self.env)
        for k in ("FAKE_FAIL", "FAKE_REJECT"):
            os.environ.pop(k, None)
        os.environ.update(env)
        try:
            report = mp.migrate(self.root, dry_run=dry_run, hooks=hooks)
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
        check(f"[{self.root.name}] the legacy file is never changed", self.stamp(self.legacy), self.legacy_stamp)
        return report

    def calls(self):
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def writes(self, rel="config/model-prices.json"):
        return [c for c in self.calls() if c[:3] == ["data", "write", rel]]

    def table(self):
        r = subprocess.run(["lucidos", "model-prices"], env={**os.environ, **self.env},
                           capture_output=True, text=True, check=True)
        return json.loads(r.stdout)

    def override_doc(self):
        return json.loads(self.override.read_text())


def by_day(items):
    """(model, from) pairs in order, an undated card first."""
    return sorted(items, key=lambda x: (x[0], x[1] or ""))


def pairs(entries):
    return by_day((e["model"], e["from"]) for e in entries)


def card_on(table, model, day):
    best = None
    for c in table["models"].get(model, []):
        if not c.get("from") or c["from"] <= day:
            best = c
    return best


MOVED = by_day([
    ("gemini-2.5-flash-lite", None), ("gemini-3-flash-preview", None), ("gpt-5.5", None),
    ("gpt-5.6-sol", None), ("gpt-5.6-sol", "2026-08-21"), ("gpt-image-2", None),
    ("gpt-realtime", None), ("haiku", None), ("sonnet", None), ("sonnet", "2026-08-25"),
])

# 1. An upgrade from 0.4.4 with no override: every card the shipped table
# misses lands in the override exactly as 0.4.4 had it.
ws = Workspace()
r = ws.run()
check("1 status", r["status"], "migrated")
check("1 the unpriced cards move", pairs(r["migrated"]), MOVED)
check("1 a model the shipped table prices stays out",
      [(e["model"], e["priced_as"], e["origin"]) for e in r["covered"] if e["model"] == "claude-opus-5-5"],
      [("claude-opus-5-5", "claude-opus-5-5", "shipped")])
check("1 a dated id is priced by its undated card, so it stays out",
      [(e["model"], e["priced_as"]) for e in r["covered"] if e["model"] == "claude-sonnet-4-5-20250929"],
      [("claude-sonnet-4-5-20250929", "claude-sonnet-4-5")])
ov = ws.override_doc()
check("1 the override is in the table's currency", ov.get("currency"), "USD")
check("1 the override gets no `checked`: nothing was checked against a provider", "checked" in ov, False)
for model, entry in LEGACY["models"].items():
    if model in ov["models"]:
        check(f"1 {model}: every card is written as 0.4.4 had it (source, rates, long, from)",
              sorted(ov["models"][model], key=lambda c: c.get("from") or ""),
              sorted(entry, key=lambda c: c.get("from") or ""))
t = ws.table()
check("1 the engine accepts the override", t["override"]["error"], None)
check("1 the engine serves the moved cards as override cards",
      by_day((m, c.get("from")) for m, cs in t["models"].items() for c in cs if c["origin"] == "override"), MOVED)
check("1 gpt-5.6-sol keeps its price history: the old rate before 2026-08-21",
      card_on(t, "gpt-5.6-sol", "2026-08-20")["uncached_in"], 5.0)
check("1 and the new rate from it", card_on(t, "gpt-5.6-sol", "2026-08-21")["uncached_in"], 4.0)
check("1 gpt-5.5 keeps its long tier", card_on(t, "gpt-5.5", "2026-10-01")["long"]["threshold_tokens"], 272000)
check("1 one write, through `lucidos data write`", len(ws.writes()), 1)
check("1 nothing to carry into settings.json (default labels, no rates)", ws.settings.exists(), False)
saved = json.loads(ws.report_path.read_text())
check("1 the report is kept on disk", (saved["status"], len(saved["migrated"])), ("migrated", 10))
check("1 the report records the legacy file it read",
      saved["legacy"]["sha256"], hashlib.sha256(ws.legacy.read_bytes()).hexdigest())

# 2. A rerun changes nothing: same override bytes, no write.
before = ws.override.read_bytes()
r = ws.run()
check("2 status", r["status"], "done")
check("2 nothing moves again", r["migrated"], [])
check("2 the moved cards read as already moved", pairs(r["already"]), MOVED)
check("2 no second write", len(ws.writes()), 1)
check("2 the override is byte for byte the same", ws.override.read_bytes(), before)

# 3. A third run leaves even the report file alone.
stamp = ws.stamp(ws.report_path)
ws.run()
check("3 the report is not rewritten when nothing changed", ws.stamp(ws.report_path), stamp)

# 4. An existing override: its cards win, and every key it holds survives.
existing = {
    "_comment": "my own note",
    "checked": "2026-10-20",
    "currency": "USD",
    "sources": {"openai": "https://developers.openai.com/api/docs/pricing"},
    "failures": {"google": {"count": 1, "last_ok": "2026-10-19"}},
    "x_custom": {"keep": True},
    "models": {
        "gpt-5.5": [{"uncached_in": 5.5, "cache_write": 5.5, "cache_read": 0.55, "out": 33,
                     "source": "hand check 2026-10-20", "x_card_note": "mine"}],
        "my-model": [{"uncached_in": 1, "cache_write": 1, "cache_read": 0.1, "out": 2, "source": "mine"}],
        "sonnet": [{"from": "2026-08-25", "uncached_in": 2, "cache_write": 2.5, "cache_read": 0.2, "out": 10,
                    "source": "override card for the same day"}],
    },
}
ws = Workspace(override=existing)
r = ws.run()
ov = ws.override_doc()
check("4 status", r["status"], "migrated")
check("4 every top-level key is kept, in order", list(ov), list(existing))
for k in ("_comment", "checked", "sources", "failures", "x_custom"):
    check(f"4 {k} is untouched", ov[k], existing[k])
check("4 the override's gpt-5.5 card wins over the legacy one", ov["models"]["gpt-5.5"], existing["models"]["gpt-5.5"])
check("4 an unrelated model is untouched", ov["models"]["my-model"], existing["models"]["my-model"])
g = [e for e in r["covered"] if e["model"] == "gpt-5.5"][0]
check("4 the legacy gpt-5.5 is reported covered by the override, with the difference",
      (g["origin"], g["differs"]), ("override", True))
check("4 legacy sonnet on the override's day stays out", ("sonnet", "2026-08-25") in pairs(r["covered"]), True)
check("4 legacy sonnet before it moves in, ahead of the dated card",
      [c.get("from") for c in ov["models"]["sonnet"]], [None, "2026-08-25"])
check("4 the override's own sonnet card is untouched", ov["models"]["sonnet"][1], existing["models"]["sonnet"][0])
check("4 the engine accepts the result", ws.table()["override"]["error"], None)

# 5. A shipped card that starts later still leaves the days before it
# unpriced, so the undated legacy card moves and covers only those days.
shipped = copy.deepcopy(SHIPPED)
shipped["models"]["gpt-image-2"] = [{"from": "2026-09-01", "uncached_in": 6, "cache_write": 6, "cache_read": 1.5,
                                     "out": 32, "source": "shipped from 2026-09-01"}]
ws = Workspace(shipped=shipped)
r = ws.run()
check("5 the undated legacy card moves", ("gpt-image-2", None) in pairs(r["migrated"]), True)
t = ws.table()
check("5 before the shipped card: the legacy rate", card_on(t, "gpt-image-2", "2026-08-31")["uncached_in"], 5.0)
check("5 from it on: the shipped rate", card_on(t, "gpt-image-2", "2026-09-01")["uncached_in"], 6)

# 6. Malformed cards: each is reported, the rest still move, and the engine
# accepts what was written.
ok = {"uncached_in": 1, "cache_write": 1.25, "cache_read": 0.1, "out": 5}
weird = {
    "currency": "usd",
    "models": {
        "no-source": [dict(ok)],
        "negative": [dict(ok, source="s", out=-1)],
        "bad-day": [dict(ok, source="s", **{"from": "2026-13-01"})],
        "text-rate": [dict(ok, source="s", out="5")],
        "nan-rate": [dict(ok, source="s", out=float("nan"))],
        "long-no-threshold": [dict(ok, source="s", long=dict(ok))],
        "long-float-threshold": [dict(ok, source="s", long=dict(ok, threshold_tokens=272000.0))],
        "long-bad-inclusive": [dict(ok, source="s", long=dict(ok, threshold_tokens=1000, inclusive="yes"))],
        "same-day": [dict(ok, source="a", **{"from": "2026-05-01"}), dict(ok, source="b", **{"from": "2026-05-01"})],
        "empty": [{}],
        "default": [dict(ok, source="s")],
        "not-cards": "nope",
        "plain-object": dict(ok, source="pre-history shape"),
        "voice": [{"per_minute": 0.06, "source": "s"}],
        "blank-rate": [{"uncached_in": 2, "out": 8, "source": "s"}],
        "extra-field": [dict(ok, source="s", note="kept", origin="shipped")],
    },
}
ws = Workspace(legacy=weird)
r = ws.run()
unsupported = {e["model"]: e["reason"] for e in r["unsupported"]}
check("6 unsupported, each with a reason",
      sorted(unsupported),
      sorted(["negative", "bad-day", "text-rate", "nan-rate", "long-no-threshold", "long-bad-inclusive", "same-day", "not-cards"]))
check("6 two cards on one day are both held back", len([e for e in r["unsupported"] if e["model"] == "same-day"]), 2)
check("6 a negative rate says so", "negative" in unsupported["negative"], True)
check("6 skipped: the empty card and the default row",
      sorted(e["model"] for e in r["skipped"]), ["default", "empty"])
moved = {e["model"]: e for e in r["migrated"]}
check("6 moved", sorted(moved),
      sorted(["no-source", "long-float-threshold", "plain-object", "voice", "blank-rate", "extra-field"]))
ov = ws.override_doc()["models"]
check("6 a card with no source gets one that says so, and the report notes it",
      ("no source" in ov["no-source"][0]["source"], bool(moved["no-source"]["notes"])), (True, True))
check("6 a whole-number float threshold is written as an integer",
      type(ov["long-float-threshold"][0]["long"]["threshold_tokens"]), int)
check("6 a plain object loads as one undated card", ov["plain-object"], [weird["models"]["plain-object"]])
check("6 a per-minute card gets zero token rates, as the engine needs them",
      {k: ov["voice"][0][k] for k in ("uncached_in", "cache_write", "cache_read", "out", "per_minute")},
      {"uncached_in": 0, "cache_write": 0, "cache_read": 0, "out": 0, "per_minute": 0.06})
check("6 a blank rate is 0, as 0.4.4 priced it, and the report says so",
      (ov["blank-rate"][0]["cache_write"], ov["blank-rate"][0]["cache_read"], len(moved["blank-rate"]["notes"])), (0, 0, 1))
check("6 an unknown field is kept, `origin` is not", (ov["extra-field"][0].get("note"), "origin" in ov["extra-field"][0]),
      ("kept", False))
check("6 lowercase usd is the same currency", r["currency"], "USD")
check("6 the engine accepts what was written", ws.table()["override"]["error"], None)

# 7. Another currency: nothing is converted, nothing is written.
ws = Workspace(legacy=dict(LEGACY, currency="NOK", fx={"rates": {"USD": 0.09}}))
r = ws.run()
check("7 status", r["status"], "blocked")
check("7 no write", ws.writes(), [])
check("7 every card is reported, naming the currency",
      (len(r["unsupported"]), all("NOK" in e["reason"] for e in r["unsupported"])), (12, True))
check("7 no settings carried either", ws.settings.exists(), False)

# 8. An override the engine ignores: never written over.
broken = {"models": {"x": [dict(ok, source="s", out=-2)]}}
ws = Workspace(override=broken)
before = ws.override.read_bytes()
r = ws.run()
check("8 status", r["status"], "blocked")
check("8 the reason is the engine's", "negative" in " ".join(r["errors"]), True)
check("8 the override is untouched", ws.override.read_bytes(), before)
ws = Workspace(override="{not json")
r = ws.run()
check("8 an unreadable override blocks too", (r["status"], ws.writes()), ("blocked", []))

# 9. Failures: nothing is marked moved, and the next run tries again.
ws = Workspace()
r = ws.run(FAKE_FAIL="model-prices")
check("9 a price table that cannot be read is an error", (r["status"], ws.writes()), ("error", []))
check("9 the error is recorded on disk", json.loads(ws.report_path.read_text())["status"], "error")
r = ws.run(FAKE_FAIL="write:config/model-prices.json")
check("9 a failed write is an error", r["status"], "error")
check("9 nothing is recorded as moved", (r["migrated"], r["history"]), ([], []))
check("9 the override was not created", ws.override.exists(), False)
r = ws.run()
check("9 the next run moves everything", (r["status"], len(r["migrated"])), ("migrated", 10))

# 10. The engine refuses the written file: the previous one is put back.
ws = Workspace(override={"currency": "USD", "models": {"my-model": [dict(ok, source="mine")]}})
before = ws.override_doc()
r = ws.run(FAKE_REJECT="gpt-realtime")
check("10 status", r["status"], "error")
check("10 the previous override is back", ws.override_doc(), before)
check("10 the engine reads it again", ws.table()["override"]["error"], None)
check("10 nothing counts as moved", r["history"], [])
ws = Workspace()
r = ws.run(FAKE_REJECT="gpt-realtime")
check("10 with no override before, an empty valid one is left", ws.override_doc().get("models"), {})
check("10 and the engine reads it", ws.table()["override"]["error"], None)

# 11. Someone writes the override while the migration runs: nothing is
# written over it, and the next run starts from their file.
ws = Workspace(override={"currency": "USD", "models": {}})
theirs = {"currency": "USD", "models": {"my-model": [dict(ok, source="written meanwhile")]}}
r = ws.run(hooks={"before_write": lambda: ws.override.write_text(json.dumps(theirs))})
check("11 status", r["status"], "retry")
check("11 their file stands", ws.override_doc(), theirs)
check("11 no write", ws.writes(), [])
r = ws.run()
check("11 the next run moves the cards and keeps theirs",
      (r["status"], ws.override_doc()["models"]["my-model"]), ("migrated", theirs["models"]["my-model"]))

# 12. Another migration holds the lock: this one does nothing.
ws = Workspace()
lock = ws.data / "artifacts" / "token-cost" / ".price-migration.lock"
with open(lock, "w") as held:
    fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
    r = ws.run()
check("12 status", r["status"], "busy")
check("12 no command ran", ws.calls(), [])

# 13. A moved card the user deletes later is not put back.
ws = Workspace()
ws.run()
doc = ws.override_doc()
del doc["models"]["haiku"]
ws.override.write_text(json.dumps(doc, indent=2))
r = ws.run()
check("13 haiku is not added back", "haiku" in ws.override_doc()["models"], False)
check("13 the report says it was removed after the move", pairs(r["removed"]), [("haiku", None)])
check("13 nothing else is written", len(ws.writes()), 1)

# 14. A dry run reports and writes nothing at all.
ws = Workspace()
r = ws.run(dry_run=True)
check("14 status", r["status"], "dry-run")
check("14 it lists what would move", pairs(r["migrated"]), MOVED)
check("14 no write, no report file", (ws.writes(), ws.report_path.exists(), ws.override.exists()), ([], False, False))

# 15. A legacy file that is not JSON is an error, and stays as it is.
ws = Workspace(legacy_text="{ broken")
r = ws.run()
check("15 status", (r["status"], ws.writes()), ("error", []))

# 16. No legacy file: nothing runs, nothing is written.
ws = Workspace(legacy=None)
r = ws.run()
check("16 status", r["status"], "no-legacy")
check("16 no command, no report", (ws.calls(), ws.report_path.exists()), ([], False))

# 17. Settings: exchange rates and custom labels move to settings.json only
# when it does not exist; a long-context multiplier other than 1 is reported.
legacy = dict(LEGACY, fx={"rates": {"NOK": 10.5, "EUR": 0.92}, "_updated": "2026-10-01"},
              producers=dict(LEGACY["producers"], main_llm="My agent"),
              long_context_multiplier={"threshold_tokens": 200000, "in_multiplier": 2.0, "out_multiplier": 1.5})
ws = Workspace(legacy=legacy)
r = ws.run()
st = json.loads(ws.settings.read_text())
check("17 the exchange rates move with their date", st["fx"], legacy["fx"])
check("17 only the label that differs from 0.4's default moves", st["producers"], {"main_llm": "My agent"})
check("17 written through `lucidos data write`", len(ws.writes("artifacts/token-cost/settings.json")), 1)
check("17 the multiplier is reported, not dropped",
      [e["field"] for e in r["settings"]["unsupported"]], ["long_context_multiplier"])
ws = Workspace(legacy=legacy, settings={"producers": {}, "fx": {"rates": {}}})
r = ws.run()
check("17 an existing settings.json is left alone",
      (json.loads(ws.settings.read_text()), ws.writes("artifacts/token-cost/settings.json")),
      ({"producers": {}, "fx": {"rates": {}}}, []))

# 18. The command line: --dry-run --json prints the report, and exits 0.
ws = Workspace()
p = subprocess.run([sys.executable, "-I", str(MODULE), "--dry-run", "--json"], env={**os.environ, **ws.env},
                   capture_output=True, text=True)
check("18 exit code", p.returncode, 0)
check("18 the first line is the summary", p.stdout.splitlines()[0].startswith("price migration ("), True)
check("18 then the report", json.loads(p.stdout.split("\n", 1)[1])["status"], "dry-run")
p = subprocess.run([sys.executable, "-I", str(MODULE)], env={**os.environ, **ws.env, "FAKE_FAIL": "model-prices"},
                   capture_output=True, text=True)
check("18 an error exits 1", p.returncode, 1)

# 19. run_quietly() never raises, for the rollup and the snapshot to call.
ws = Workspace()
os.environ.update(ws.env)
check("19 a summary line", mp.run_quietly(ws.root).startswith("price migration ("), True)
check("19 no legacy file, no line", mp.run_quietly(Workspace(legacy=None).root), None)
real_migrate = mp.migrate


def crash(*a, **k):
    raise RuntimeError("boom")


mp.migrate = crash
try:
    line = mp.run_quietly(Workspace().root)
finally:
    mp.migrate = real_migrate
check("19 a crash is a line, not an exception", line, "price migration failed: boom")

print(f"{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
