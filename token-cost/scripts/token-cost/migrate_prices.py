#!/usr/bin/env python3
"""Move Token Cost 0.4.x prices into Lucidos's price table.

Token Cost 0.4.x kept its own price table in artifacts/token-cost/pricing.json.
Since 0.5.0 every surface reads Lucidos's price table instead: the cards
Lucidos ships merged with the workspace override, data/config/model-prices.json
(ADR 0525). 0.5.0 shipped without a migration, so every model the shipped
cards miss went unpriced on update. This carries those cards over.

The rules:
- The legacy file is only read. It is never changed, moved or deleted.
- A legacy card moves only when the merged table does not price its model on
  the card's first day. A shipped or override card that prices that day wins,
  and the report says when its rates differ.
- A card moves as it is: source, rates, `from`, `long`, `flex`, `per_minute`,
  `cache_write_1h` and any field the engine does not know. A blank rate is 0,
  as 0.4.x priced it, and a missing `source` is filled in to say so. Each is
  noted in the report.
- A card the engine would refuse is held back and reported, never written:
  one bad card makes the engine ignore the WHOLE override.
- No currency is converted. A legacy file in another currency moves nothing.
- Every other key and card in the override stays as it is.
- The write goes through `lucidos data write`, under a lock, only if the
  override did not change since it was read. Then `lucidos model-prices` must
  serve the new cards, or the previous file is put back.
- A card moved once and later deleted from the override is not put back.

The rollup and the thread snapshot call run_quietly() on every run, so an
update needs no setup step to heal. `--dry-run` reports and writes nothing.
The report is kept in artifacts/token-cost/price-migration.json, which the
Settings tab shows.

    python3 migrate_prices.py [--dry-run] [--json]
"""
import copy
import datetime
import fcntl
import hashlib
import json
import math
import os
import pathlib
import re
import subprocess
import sys

LEGACY_REL = "artifacts/token-cost/pricing.json"
OVERRIDE_REL = "config/model-prices.json"
SETTINGS_REL = "artifacts/token-cost/settings.json"
REPORT_REL = "artifacts/token-cost/price-migration.json"
LOCK_REL = "artifacts/token-cost/.price-migration.lock"
REPORT_VERSION = 1

RATES = ("uncached_in", "cache_write", "cache_read", "out")
DAY_RE = re.compile(r"\d{4}-\d{2}-\d{2}")

# Token Cost 0.4.x's own producer labels. A legacy label that differs from
# these is the user's, and moves to settings.json.
LEGACY_DEFAULT_PRODUCERS = {
    "main_llm": "Lucidos Agent", "claude_code": "Claude Code", "codex": "Codex",
    "jev_browser": "Jev Browser", "auxiliary": "Auxiliary",
}

# The app writes these at the top of each file it creates (index.html,
# OVERRIDE_COMMENT and SETTINGS_COMMENT), so a hand editor finds what the
# file is for.
OVERRIDE_COMMENT = (
    "This workspace’s cards for Lucidos’s price table (ADR 0525). Each card corrects or adds to "
    "the cards Lucidos ships, and replaces the shipped card that has the same ‘from’ day. Rates "
    "are per 1,000,000 tokens in ‘currency’. Written by the Token Cost app’s Settings tab "
    "and the model-price-check recipe, or by hand. Lucidos ignores the whole file when it has another "
    "currency, two cards for one model on one day, a negative rate, or a card without ‘source’."
)
SETTINGS_COMMENT = (
    "Token Cost’s own settings. ‘producers’ names each producer id in the table and the "
    "filter. ‘fx.rates’ is units of each currency per 1 unit of the price table’s currency, "
    "used for display conversion only, at one rate for every day. Prices live in Lucidos’s price "
    "table, not here."
)


class Unsupported(Exception):
    """A legacy card the engine would refuse."""


class CliError(Exception):
    pass


# ---- The lucidos CLI ---------------------------------------------------------

def cli_model_prices() -> dict:
    try:
        r = subprocess.run(["lucidos", "model-prices"], capture_output=True, text=True)
    except OSError as e:
        raise CliError(f"cannot run lucidos model-prices: {e}") from e
    if r.returncode != 0:
        raise CliError(f"lucidos model-prices failed: {(r.stderr or r.stdout).strip()[:300]}")
    try:
        doc = json.loads(r.stdout)
    except ValueError as e:
        raise CliError(f"lucidos model-prices is not valid JSON: {e}") from e
    if not isinstance(doc, dict) or not isinstance(doc.get("models"), dict):
        raise CliError("lucidos model-prices has no models table")
    return doc


def cli_write(rel: str, text: str) -> None:
    try:
        r = subprocess.run(["lucidos", "data", "write", rel, "--from", "-"],
                           input=text, capture_output=True, text=True)
    except OSError as e:
        raise CliError(f"cannot run lucidos data write: {e}") from e
    if r.returncode != 0:
        raise CliError(f"lucidos data write {rel} failed: {(r.stderr or r.stdout).strip()[:300]}")


# ---- Cards -------------------------------------------------------------------

def is_number(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def rate(tier: dict, key: str, where: str, blanks: list, required: bool):
    """A rate as the engine reads it: a finite number, never negative. A
    blank required rate is 0, as 0.4.x priced a blank, and lands in
    `blanks`."""
    v = tier.get(key)
    if v is None:
        if required:
            blanks.append(key)
            return 0
        return None
    if not is_number(v):
        raise Unsupported(f"{where}{key} is not a number ({json.dumps(v)})")
    if v < 0:
        raise Unsupported(f"{where}{key} is negative ({v})")
    return v


def tier_of(raw, where: str, notes: list, long: bool) -> dict:
    """A `long` or `flex` block, with every rate the engine needs."""
    if not isinstance(raw, dict):
        raise Unsupported(f"{where} is not an object")
    out = {k: v for k, v in raw.items()}
    if long:
        t = raw.get("threshold_tokens")
        if not is_number(t) or t <= 0 or t != int(t):
            raise Unsupported(f"{where} has no whole positive threshold_tokens ({json.dumps(t)})")
        out["threshold_tokens"] = int(t)
        if "inclusive" in raw and not isinstance(raw["inclusive"], bool):
            raise Unsupported(f"{where}.inclusive is not true or false ({json.dumps(raw['inclusive'])})")
    blanks = []
    for k in RATES:
        out[k] = rate(raw, k, f"{where}.", blanks, required=True)
    if raw.get("cache_write_1h") is not None:
        out["cache_write_1h"] = rate(raw, "cache_write_1h", f"{where}.", blanks, required=False)
    blank_note(notes, f"{where}.", blanks)
    return out


def blank_note(notes: list, where: str, blanks: list) -> None:
    if blanks:
        keys = ", ".join(where + k for k in blanks)
        notes.append(f"{keys} {'was' if len(blanks) == 1 else 'were'} blank, written as 0 "
                     f"(0.4.x priced a blank as 0)")


def normalize(raw, today: str):
    """(card, notes) as the engine will read it, or (None, reason) for an
    empty card. Raises Unsupported for a card the engine would refuse."""
    if not isinstance(raw, dict):
        raise Unsupported(f"the card is not an object ({json.dumps(raw)[:60]})")
    notes = []
    has_rate = any(raw.get(k) is not None for k in (*RATES, "per_minute"))
    if not has_rate:
        return None, "the card has no rate, so 0.4.x left this model unpriced too"
    card = {}
    for k, v in raw.items():
        if k == "origin":
            continue
        card[k] = v
    f = raw.get("from")
    if f in (None, ""):
        card.pop("from", None)
    elif not isinstance(f, str) or not DAY_RE.fullmatch(f) or not valid_day(f):
        raise Unsupported(f"from is not a YYYY-MM-DD day ({json.dumps(f)})")
    blanks = []
    for k in RATES:
        card[k] = rate(raw, k, "", blanks, required=True)
    for k in ("cache_write_1h", "per_minute"):
        if raw.get(k) is not None:
            card[k] = rate(raw, k, "", blanks, required=False)
    # Token rates are unused on a per-minute card, so a blank one there is no
    # news. The engine still needs all four.
    if "per_minute" not in card:
        blank_note(notes, "", blanks)
    for k, long in (("long", True), ("flex", False)):
        if raw.get(k) is not None:
            card[k] = tier_of(raw[k], k, notes, long)
        else:
            card.pop(k, None)
    src = raw.get("source")
    if not isinstance(src, str) or not src.strip():
        card["source"] = (f"Set by hand in Token Cost 0.4 with no source. Moved from {LEGACY_REL} "
                          f"on {today}.")
        notes.append("it had no source, so the source now says where it came from")
    return card, notes


def valid_day(s: str) -> bool:
    try:
        datetime.date.fromisoformat(s)
        return True
    except ValueError:
        return False


def cards_of(entry):
    """A model's legacy cards: a list, or one plain object (the shape every
    price file had before history existed)."""
    if isinstance(entry, list):
        return entry
    if isinstance(entry, dict):
        return [entry]
    return None


def fingerprint(card: dict) -> str:
    return hashlib.sha256(json.dumps(card, sort_keys=True).encode()).hexdigest()[:16]


def rates_of(card: dict) -> dict:
    return {k: card.get(k) for k in (*RATES, "per_minute") if card.get(k) is not None}


# ---- Looking a model up, as every Token Cost surface does ----------------------

def undated(m: str) -> str:
    return re.sub(r"-\d{3,}(?:-\d+)*$", "", m)


def model_keys(model: str) -> list:
    """The app's modelKeys(): the literal id, the id without a gateway's
    decorations, and that id undated. A dated id shares its undated form's
    cards, as the engine's served_as_sent() and the price-check recipe say."""
    base = re.sub(r"@[^\[\]]*$", "", re.sub(r"\[1m\]$", "", model))
    m = base.lower()
    m = re.sub(r"^(?:[a-z]{2,6}\.)?anthropic\.", "", m)
    m = re.sub(r"^(?:[a-z0-9_-]+/)+", "", m)
    m = re.sub(r"-v\d+(?::\d+)?$", "", m)
    if m.startswith("claude-"):
        m = re.sub(r"(\d)\.(\d)", r"\1-\2", m)
    return list(dict.fromkeys([base, m, undated(m)]))


def in_force(cards, day):
    """The card in force on `day`, or None. `day` None is the first day of
    all, which only an undated card covers."""
    hit = None
    for c in cards or []:
        f = c.get("from")
        if f and (day is None or f > day):
            continue
        hit = c
    return hit


def covering(models: dict, model: str, day):
    """(table id, card) of the card that prices `model` on `day`, the way the
    app's lookupCard() finds it, or None."""
    keys = model_keys(model)
    for k in keys:
        c = in_force(models.get(k), day)
        if c is not None:
            return k, c
    want = {undated(k) for k in keys}
    for k, cards in models.items():
        if undated(k.lower()) in want:
            c = in_force(cards, day)
            if c is not None:
                return k, c
    return None


# ---- The migration -------------------------------------------------------------

def blank_report(status: str) -> dict:
    return {
        "version": REPORT_VERSION, "status": status, "legacy": {"path": LEGACY_REL, "sha256": None},
        "currency": None, "migrated": [], "already": [], "covered": [], "removed": [], "skipped": [],
        "unsupported": [], "errors": [], "settings": {"carried": [], "unsupported": [], "kept": None},
        "history": [],
    }


def read_json(path: pathlib.Path):
    """(text, parsed) of a file, (None, None) when it does not exist."""
    if not path.exists():
        return None, None
    text = path.read_text()
    return text, json.loads(text)


def entry(model, card_from, **more):
    return {"model": model, "from": card_from, **more}


def migrate(ws, dry_run: bool = False, hooks=None) -> dict:
    """Run the migration once for workspace root `ws`. Returns the report."""
    hooks = hooks or {}
    data = pathlib.Path(ws) / "data"
    legacy_path = data / LEGACY_REL
    if not legacy_path.exists():
        return blank_report("no-legacy")
    lock_path = data / LOCK_REL
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with open(lock_path, "a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return blank_report("busy")
        report = run_locked(data, legacy_path, dry_run, hooks)
        if not dry_run:
            save_report(data, report)
        return report


def run_locked(data: pathlib.Path, legacy_path: pathlib.Path, dry_run: bool, hooks: dict) -> dict:
    report = blank_report("done")
    previous = load_report(data)
    report["history"] = list(previous.get("history") or [])
    today = datetime.date.today().isoformat()

    raw = legacy_path.read_bytes()
    report["legacy"]["sha256"] = hashlib.sha256(raw).hexdigest()
    try:
        legacy = json.loads(raw)
        if not isinstance(legacy, dict):
            raise ValueError("it is not a JSON object")
    except ValueError as e:
        return fail(report, "error", f"{LEGACY_REL} cannot be read: {e}")
    try:
        table = cli_model_prices()
    except CliError as e:
        return fail(report, "error", str(e))
    currency = str(table.get("currency") or "USD")
    report["currency"] = currency
    err = (table.get("override") or {}).get("error")
    if err:
        return fail(report, "blocked", f"Lucidos is ignoring {OVERRIDE_REL} ({err}). Fix it first: "
                                       f"until then a write would add to a file that does not count.")
    override_path = data / OVERRIDE_REL
    try:
        ov_text, ov = read_json(override_path)
    except (OSError, ValueError) as e:
        return fail(report, "blocked", f"{OVERRIDE_REL} cannot be read: {e}")
    if ov is not None and (not isinstance(ov, dict) or not isinstance(ov.get("models", {}), dict)):
        return fail(report, "blocked", f"{OVERRIDE_REL} is not a price table override")

    legacy_ccy = str(legacy.get("currency") or "USD").upper()
    models = legacy.get("models") if isinstance(legacy.get("models"), dict) else {}
    if legacy_ccy != currency.upper():
        why = (f"0.4.x priced it in {legacy_ccy}, and the price table is in {currency}. "
               f"Nothing is converted, so add it by hand in {currency}")
        for model, e in models.items():
            for c in cards_of(e) or [e]:
                report["unsupported"].append(entry(model, c.get("from") if isinstance(c, dict) else None, reason=why))
        report["status"] = "blocked"
        report["errors"].append(f"{LEGACY_REL} is in {legacy_ccy}, the price table in {currency}")
        return report

    candidates = plan_cards(models, today, report)
    to_add = sort_out(candidates, table["models"], report)
    carry_settings(data, legacy, currency, report, dry_run)
    if not to_add:
        return report
    if dry_run:
        report["status"] = "dry-run"
        report["migrated"] = [entry(m, c.get("from"), source=c["source"], notes=n) for m, c, n in to_add]
        return report
    return write_override(data, ov_text, ov, currency, to_add, report, hooks, today)


def fail(report: dict, status: str, message: str) -> dict:
    report["status"] = status
    report["errors"].append(message)
    return report


def plan_cards(models: dict, today: str, report: dict) -> list:
    """Every legacy card that can move, as (model, card, notes). The rest go
    into the report."""
    out = []
    for model, e in models.items():
        if model == "default":
            report["skipped"].append(entry(model, None, reason="0.4.x ignored a default row, and the price "
                                                              "table has none"))
            continue
        cards = cards_of(e)
        if cards is None:
            report["unsupported"].append(entry(model, None, reason=f"not a list of cards ({json.dumps(e)[:60]})"))
            continue
        for raw in cards:
            day = raw.get("from") if isinstance(raw, dict) else None
            try:
                card, notes = normalize(raw, today)
            except Unsupported as why:
                report["unsupported"].append(entry(model, day, reason=str(why)))
                continue
            if card is None:
                report["skipped"].append(entry(model, day, reason=notes))
                continue
            out.append((model, card, notes))
    # Two cards on one day: the engine would refuse the whole override, and
    # picking one would guess. Both stay out.
    seen = {}
    for model, card, _ in out:
        seen[(model, card.get("from"))] = seen.get((model, card.get("from")), 0) + 1
    kept = []
    for model, card, notes in out:
        if seen[(model, card.get("from"))] > 1:
            report["unsupported"].append(entry(model, card.get("from"),
                                               reason="two cards from the same day, so neither is moved"))
        else:
            kept.append((model, card, notes))
    return kept


def sort_out(candidates: list, table_models: dict, report: dict) -> list:
    """Which cards move: those the merged table does not price on their
    first day, and that were not moved before and deleted since."""
    moved_before = {(h["model"], h.get("from")): h for h in report["history"]}
    to_add = []
    for model, card, notes in candidates:
        day = card.get("from")
        hit = covering(table_models, model, day)
        if hit is not None:
            tid, tc = hit
            if tid == model and tc.get("origin") == "override" and tc.get("from") == day \
                    and (model, day) in moved_before:
                report["already"].append(entry(model, day))
                continue
            report["covered"].append(entry(
                model, day, priced_as=tid, origin=tc.get("origin"), table_from=tc.get("from"),
                differs=rates_of(tc) != rates_of(card), table=rates_of(tc), legacy=rates_of(card)))
            continue
        if (model, day) in moved_before:
            report["removed"].append(entry(model, day, migrated_on=moved_before[(model, day)].get("on")))
            continue
        to_add.append((model, card, notes))
    return to_add


def write_override(data, ov_text, ov, currency, to_add, report, hooks, today):
    override_path = data / OVERRIDE_REL
    doc = copy.deepcopy(ov) if ov is not None else {"_comment": OVERRIDE_COMMENT, "currency": currency, "models": {}}
    doc.setdefault("models", {})
    touched = []
    for model, card, _ in to_add:
        lst = doc["models"].setdefault(model, [])
        if not isinstance(lst, list):
            return fail(report, "blocked", f"{OVERRIDE_REL} holds {model} as something other than a list of cards")
        if any(isinstance(c, dict) and c.get("from") == card.get("from") for c in lst):
            # The table did not price this day, yet the override has a card on
            # it: the engine would refuse two. Leave the override's.
            report["unsupported"].append(entry(model, card.get("from"),
                                               reason=f"{OVERRIDE_REL} already has a card for that day"))
            continue
        lst.append(card)
        touched.append(model)
    for model in set(touched):
        doc["models"][model].sort(key=lambda c: (c.get("from") or "") if isinstance(c, dict) else "")
    added = [(m, c, n) for m, c, n in to_add if m in touched and c in doc["models"][m]]
    if not added:
        return report
    text = json.dumps(doc, indent=2, ensure_ascii=False) + "\n"

    if "before_write" in hooks:
        hooks["before_write"]()
    try:
        now_text = override_path.read_text() if override_path.exists() else None
    except OSError as e:
        return fail(report, "error", f"{OVERRIDE_REL} cannot be read again: {e}")
    if now_text != ov_text:
        return fail(report, "retry", f"{OVERRIDE_REL} changed while the migration ran. Nothing was "
                                     f"written; the next run starts from the new file.")
    try:
        cli_write(OVERRIDE_REL, text)
    except CliError as e:
        return fail(report, "error", str(e))

    # The engine has the last word: it must serve every card just written.
    problem = None
    try:
        after = cli_model_prices()
        err = (after.get("override") or {}).get("error")
        if err:
            problem = f"Lucidos refused the written {OVERRIDE_REL}: {err}"
        else:
            missing = [f"{m} {c.get('from') or '(undated)'}" for m, c, _ in added
                       if not any(t.get("from") == c.get("from") and t.get("origin") == "override"
                                  and t.get("source") == c["source"] for t in after["models"].get(m, []))]
            if missing:
                problem = f"Lucidos does not serve these written cards: {', '.join(missing)}"
    except CliError as e:
        problem = f"the written {OVERRIDE_REL} could not be checked: {e}"
    if problem:
        restore = ov_text if ov_text is not None else json.dumps(
            {"_comment": OVERRIDE_COMMENT, "currency": currency, "models": {}}, indent=2, ensure_ascii=False) + "\n"
        try:
            cli_write(OVERRIDE_REL, restore)
            problem += ". The previous file is back."
        except CliError as e:
            problem += f". Putting the previous file back failed too: {e}"
        return fail(report, "error", problem)

    report["status"] = "migrated"
    report["migrated"] = [entry(m, c.get("from"), source=c["source"], notes=n) for m, c, n in added]
    report["history"] += [{"model": m, "from": c.get("from"), "fingerprint": fingerprint(c), "on": today}
                          for m, c, _ in added]
    return report


def carry_settings(data, legacy, currency, report, dry_run):
    """Exchange rates and custom producer labels, into settings.json, only
    when there is none yet. A global long-context multiplier has no place in
    the price table, so one other than 1 is reported."""
    st = report["settings"]
    lc = legacy.get("long_context_multiplier")
    if isinstance(lc, dict) and any(lc.get(k, 1) != 1 for k in ("in_multiplier", "out_multiplier")):
        st["unsupported"].append({"field": "long_context_multiplier", "value": lc, "reason": (
            "the price table has no global long-context multiplier. Give each model that bills one a "
            "`long` tier on its card instead")})
    fx = legacy.get("fx") if isinstance(legacy.get("fx"), dict) else {}
    rates = fx.get("rates") if isinstance(fx.get("rates"), dict) else {}
    rates = {k: v for k, v in rates.items() if k.upper() != currency.upper()}
    producers = legacy.get("producers") if isinstance(legacy.get("producers"), dict) else {}
    custom = {k: v for k, v in producers.items() if LEGACY_DEFAULT_PRODUCERS.get(k) != v}
    if not rates and not custom:
        return
    path = data / SETTINGS_REL
    if path.exists():
        st["kept"] = f"{SETTINGS_REL} exists, so its exchange rates and labels stay as they are"
        return
    doc = {"_comment": SETTINGS_COMMENT}
    if custom:
        doc["producers"] = custom
        st["carried"].append("producers")
    if rates:
        doc["fx"] = fx
        st["carried"].append("fx")
    if dry_run:
        return
    try:
        cli_write(SETTINGS_REL, json.dumps(doc, indent=2, ensure_ascii=False) + "\n")
    except CliError as e:
        st["carried"] = []
        report["errors"].append(str(e))


# ---- The report ----------------------------------------------------------------

def load_report(data: pathlib.Path) -> dict:
    try:
        doc = json.loads((data / REPORT_REL).read_text())
        return doc if isinstance(doc, dict) else {}
    except (OSError, ValueError):
        return {}


def save_report(data: pathlib.Path, report: dict) -> None:
    """Kept on disk, written directly as plugin state is, and only when it
    says something new, so an hourly run that changes nothing writes nothing."""
    path = data / REPORT_REL
    old = load_report(data)
    body = {k: v for k, v in report.items() if k != "updated"}
    if {k: v for k, v in old.items() if k != "updated"} == body:
        report["updated"] = old.get("updated")
        return
    report["updated"] = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    os.replace(tmp, path)


def summary(report: dict) -> str:
    s = report["status"]
    if s == "no-legacy":
        return f"price migration: no {LEGACY_REL}, nothing to do"
    if s == "busy":
        return "price migration: another run holds the lock, skipped"
    parts = []
    moved = report["migrated"]
    if moved:
        verb = "would move" if s == "dry-run" else "moved"
        parts.append(f"{verb} {len(moved)} card(s) for {len({e['model'] for e in moved})} model(s) "
                     f"from {LEGACY_REL} into {OVERRIDE_REL}")
    for key, label in (("already", "moved before"), ("covered", "priced by the price table"),
                       ("removed", "deleted after the move, left out"), ("skipped", "skipped"),
                       ("unsupported", "NOT moved")):
        if report[key]:
            parts.append(f"{len(report[key])} {label}")
    if report["settings"]["carried"]:
        parts.append(f"carried {' and '.join(report['settings']['carried'])} into {SETTINGS_REL}")
    if report["settings"]["unsupported"]:
        parts.append("NOT moved: " + ", ".join(e["field"] for e in report["settings"]["unsupported"]))
    parts += [f"error: {e}" for e in report["errors"]]
    return f"price migration ({s}): " + ("; ".join(parts) or "nothing to move")


def run_quietly(ws):
    """For the rollup and the snapshot: one summary line, or None when there
    is no legacy file. Never raises, so it can never stop the run."""
    try:
        report = migrate(ws)
    except Exception as e:  # noqa: BLE001 - nothing here may stop a rollup
        return f"price migration failed: {e}"
    if report["status"] == "no-legacy":
        return None
    return summary(report)


def main(argv) -> int:
    ws = os.environ.get("LUCIDOS_WORKSPACE")
    if not ws:
        print("LUCIDOS_WORKSPACE is not set: run this from a Lucidos trigger, run_python or run_bash", file=sys.stderr)
        return 2
    report = migrate(ws, dry_run="--dry-run" in argv)
    print(summary(report))
    if "--json" in argv:
        print(json.dumps(report, indent=2, ensure_ascii=False))
    return 1 if report["status"] in ("error", "blocked", "retry") else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
