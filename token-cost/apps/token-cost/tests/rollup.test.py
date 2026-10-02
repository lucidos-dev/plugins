"""Long-context split in scripts/rollup.py.

The rollup files each call's prompt as short or long in SQL, and the app then
prices the long part at the tier card. When the two disagree on a model's
threshold, rolled-up days charge 200k-272k GPT calls at a rate OpenAI does not
bill. These pin that the rollup picks the same card the app's rateFor() does.

The SQL itself is checked by evaluating the CASE in Python, so the test needs
no database.
"""
import json
import pathlib
import re
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


def with_pricing(models):
    """Point rollup at a temporary pricing.json holding these cards."""
    f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
    json.dump({"models": models}, f)
    f.close()
    rollup.PRICING = pathlib.Path(f.name)


def cutoff(model):
    """Evaluate long_cutoff_sql() for one id the way Postgres would."""
    sql = rollup.long_cutoff_sql("m")
    if sql.isdigit():
        return int(sql)

    def bare(m):
        return re.sub(r"@[^\[\]]*$", "", re.sub(r"\[1m\]$", "", m))

    def plain(m):
        return re.sub(r"^([a-z0-9_-]+/)+", "", bare(m).lower())

    def case(expr, body):
        """Walk one `CASE <expr> WHEN ... ELSE <rest> END` level."""
        rest = body
        while rest.startswith("WHEN "):
            mm = re.match(r"WHEN '((?:[^']|'')*)' THEN (\d+) ", rest)
            if mm.group(1).replace("''", "'") == expr:
                return int(mm.group(2))
            rest = rest[mm.end():]
        assert rest.startswith("ELSE "), rest
        return rest[5:]

    body = sql[1:-1]
    assert body.startswith("CASE "), body
    head, _, rest = body[5:].partition(" WHEN ")
    expr = plain(model) if head.startswith("regexp_replace(lower(") else bare(model)
    out = case(expr, "WHEN " + rest)
    if isinstance(out, int):
        return out
    if out.startswith("CASE "):
        head, _, rest = out[5:].partition(" WHEN ")
        out = case(plain(model), "WHEN " + rest)
        if isinstance(out, int):
            return out
    return int(re.match(r"(\d+)", out).group(1))


GPT = {"uncached_in": 5, "out": 30, "long": {"threshold_tokens": 272000}}

# 1. Built-in cards apply when pricing.json does not list the model.
with_pricing({})
builtin = rollup.builtin_long_thresholds()
check("built-in gpt-5.5 tier is read from index.html", builtin.get("gpt-5.5"), 272000)
check("built-in opus has no tier", builtin.get("claude-opus-5"), None)
check("gpt-5.5 unlisted in pricing.json", cutoff("gpt-5.5"), 272000)
check("claude-opus-5[1m] stays at 200k", cutoff("claude-opus-5[1m]"), 200000)

# 2. A gateway prefix resolves to the plain card, as modelKeys() does.
check("openai/gpt-5.5", cutoff("openai/gpt-5.5"), 272000)
check("nested prefix", cutoff("openrouter/openai/gpt-5.5"), 272000)
check("mixed case with engine decoration", cutoff("OpenAI/GPT-5.5@x[1m]"), 272000)
check("unknown model", cutoff("acme/mystery-7b"), 200000)

# 3. A stored card wins over the built-in one, tier or not.
with_pricing({"gpt-5.5": {"uncached_in": 5, "out": 30}})
check("stored card without tier shadows built-in", cutoff("gpt-5.5"), 200000)
check("...also through a prefix", cutoff("openai/gpt-5.5"), 200000)
with_pricing({"acme-big": {**GPT, "long": {"threshold_tokens": 128000}}})
check("stored tier on a new model", cutoff("acme-big"), 128000)
check("...through a prefix", cutoff("gw/acme-big"), 128000)

# 4. A stored card with no rate is skipped, as isPricedCard() skips it.
with_pricing({"gpt-5.5": {}})
check("empty stored card falls through to built-in", cutoff("gpt-5.5"), 272000)

# 5. A prefixed stored card is matched literally and shadows the plain tier.
with_pricing({"openai/gpt-5.5": {"uncached_in": 5, "out": 30}})
check("prefixed stored card without tier", cutoff("openai/gpt-5.5"), 200000)
check("plain id still takes the built-in tier", cutoff("gpt-5.5"), 272000)

# 6. The `default` row never counts as a card.
with_pricing({"default": GPT})
check("default row is ignored", cutoff("acme/mystery-7b"), 200000)

# 7. A quote in a model id cannot break out of the SQL string.
with_pricing({"it's": GPT})
check("quoted id", cutoff("it's"), 272000)

# 8. A daily.json from before a rollup fix is rebuilt once, with no user step.
check("no file runs incrementally", rollup.needs_rebuild(None, {}), None)
check("an unstamped file is rebuilt", rollup.needs_rebuild({"days": {}}, {}) is not None, True)
check("an older stamp is rebuilt",
      rollup.needs_rebuild({"rollup_version": rollup.ROLLUP_VERSION - 1}, {}) is not None, True)
check("the current stamp is not",
      rollup.needs_rebuild({"rollup_version": rollup.ROLLUP_VERSION}, {}), None)
check("TOKEN_COST_REBUILD=1 still forces it",
      rollup.needs_rebuild({"rollup_version": rollup.ROLLUP_VERSION}, {"TOKEN_COST_REBUILD": "1"}) is not None, True)
check("the stamp is written", '"rollup_version": ROLLUP_VERSION' in (HERE.parent / "scripts" / "rollup.py").read_text(), True)

print(f"{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
