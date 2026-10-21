#!/usr/bin/env python3
"""A stand-in for the two `lucidos` commands the price migration calls.

  lucidos model-prices                    the shipped cards (FAKE_SHIPPED) merged
                                          with data/config/model-prices.json
  lucidos data write <rel> --from -|PATH  writes data/<rel> in LUCIDOS_WORKSPACE

The merge follows the engine's llm/model_prices.rs as of 2026-10-21: the
override parses card by card as serde reads it (four rates and `source`
required, `from` a YYYY-MM-DD day, `threshold_tokens` a whole number), and
a parse error, another currency, two cards on one day or a negative rate
make the engine ignore the WHOLE override and say why in `override.error`.

Seams, all optional:
  FAKE_LOG     a file that gets one JSON line per command run
  FAKE_FAIL    comma list of `model-prices`, `write` or `write:<rel>` to fail
  FAKE_REJECT  a substring: an override holding it is reported as ignored,
               as if the engine refused a file the migration thought valid
"""
import datetime
import json
import math
import os
import pathlib
import re
import sys

WS = pathlib.Path(os.environ["LUCIDOS_WORKSPACE"])
OVERRIDE = WS / "data" / "config" / "model-prices.json"
FAIL = {s.strip() for s in os.environ.get("FAKE_FAIL", "").split(",") if s.strip()}


def log(entry):
    if os.environ.get("FAKE_LOG"):
        with open(os.environ["FAKE_LOG"], "a") as f:
            f.write(json.dumps(entry) + "\n")


def num(v, what):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        raise ValueError(f"{what}: invalid type, expected f64")
    return v


def rates(c, what):
    if not isinstance(c, dict):
        raise ValueError(f"{what}: expected a map")
    for k in ("uncached_in", "cache_write", "cache_read", "out"):
        if k not in c:
            raise ValueError(f"{what}: missing field `{k}`")
        num(c[k], f"{what}.{k}")
    if c.get("cache_write_1h") is not None:
        num(c["cache_write_1h"], f"{what}.cache_write_1h")


def parse_card(c, what):
    rates(c, what)
    f = c.get("from")
    if f is not None:
        if not isinstance(f, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", f):
            raise ValueError(f"{what}.from: input contains invalid characters")
        datetime.date.fromisoformat(f)
    if c.get("long") is not None:
        lg = c["long"]
        rates(lg, f"{what}.long")
        t = lg.get("threshold_tokens")
        if isinstance(t, bool) or not isinstance(t, int) or t < 0:
            raise ValueError(f"{what}.long.threshold_tokens: invalid type, expected u64")
        if "inclusive" in lg and not isinstance(lg["inclusive"], bool):
            raise ValueError(f"{what}.long.inclusive: invalid type, expected a boolean")
    if c.get("flex") is not None:
        rates(c["flex"], f"{what}.flex")
    if c.get("per_minute") is not None:
        num(c["per_minute"], f"{what}.per_minute")
    if not isinstance(c.get("source"), str):
        raise ValueError(f"{what}: missing field `source`")


def negative(c):
    tiers = [c] + [c[k] for k in ("long", "flex") if isinstance(c.get(k), dict)]
    keys = ("uncached_in", "cache_write", "cache_read", "out", "cache_write_1h")
    return any(isinstance(t.get(k), (int, float)) and t[k] < 0 for t in tiers for k in keys)


def load_override(currency):
    """(cards by model, checked, error)."""
    text = OVERRIDE.read_text()
    reject = os.environ.get("FAKE_REJECT")
    if reject and reject in text:
        return {}, None, "refused by FAKE_REJECT"
    try:
        doc = json.loads(text)
        if not isinstance(doc, dict):
            raise ValueError("invalid type: expected a map")
        models = doc.get("models", {})
        if not isinstance(models, dict):
            raise ValueError("models: invalid type, expected a map")
        for mid, cards in models.items():
            if not isinstance(cards, list):
                raise ValueError(f"models.{mid}: invalid type, expected a sequence")
            for i, c in enumerate(cards):
                parse_card(c, f"models.{mid}[{i}]")
    except ValueError as e:
        return {}, None, str(e)
    theirs = doc.get("currency")
    if theirs is not None and theirs != currency:
        return {}, None, f"its currency is {theirs}, and the shipped prices are in {currency}"
    for mid, cards in models.items():
        days = [c.get("from") for c in cards]
        if len(days) != len(set(days)):
            return {}, None, f"{mid} has two cards from the same day"
        if any(negative(c) for c in cards):
            return {}, None, f"{mid} has a negative rate"
    return models, doc.get("checked"), None


def model_prices():
    if "model-prices" in FAIL:
        print("lucidos: GET /api/v1/model-prices failed: connection refused", file=sys.stderr)
        return 1
    shipped = json.loads(pathlib.Path(os.environ["FAKE_SHIPPED"]).read_text())
    table = {m: [dict(c, origin="shipped") for c in cs] for m, cs in shipped["models"].items()}
    state = {"path": "data/config/model-prices.json", "present": OVERRIDE.exists(), "checked": None, "error": None}
    if OVERRIDE.exists():
        models, checked, error = load_override(shipped["currency"])
        state["checked"], state["error"] = checked, error
        for mid, cards in models.items():
            lst = table.setdefault(mid, [])
            for c in cards:
                lst[:] = [o for o in lst if o.get("from") != c.get("from")]
                lst.append(dict(c, origin="override"))
    for lst in table.values():
        lst.sort(key=lambda c: c.get("from") or "")
    checked = max(filter(None, [shipped["checked"], state["checked"]]))
    print(json.dumps({"currency": shipped["currency"], "checked": checked,
                      "unpriced_cache_shares": shipped["unpriced_cache_shares"],
                      "models": table, "override": state}))
    return 0


def data_write(args):
    rel = args[0]
    src = args[args.index("--from") + 1] if "--from" in args else "-"
    text = sys.stdin.read() if src == "-" else pathlib.Path(src).read_text()
    if "write" in FAIL or f"write:{rel}" in FAIL:
        print(f"lucidos: write {rel} failed: 500 Internal Server Error", file=sys.stderr)
        return 1
    path = WS / "data" / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    print(rel)
    return 0


def main(argv):
    log(argv)
    if argv[:1] == ["model-prices"]:
        return model_prices()
    if argv[:2] == ["data", "write"]:
        return data_write(argv[2:])
    print(f"fake lucidos: unsupported command {argv}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
