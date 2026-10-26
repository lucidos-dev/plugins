"""TTL evidence and write pricing shared by the rollup and widget snapshot."""

TTLS = {"5m": 300, "30m": 1800, "1h": 3600, "12h": 43200}


def write_parts(u):
    """Reported splits win over a requested TTL. None means no evidence."""
    total = u.get("cache_creation_tokens", 0) or 0
    fields = {"30m": "cache_creation_30m_tokens", "1h": "cache_creation_1h_tokens",
              "12h": "cache_creation_12h_tokens"}
    parts = {k: u[f] for k, f in fields.items() if u.get(f) is not None}
    if not total:
        return None
    if not parts:
        ttl = u.get("cache_creation_requested_ttl")
        return {ttl: total} if ttl in TTLS else None
    rest = total - sum(parts.values())
    if rest < 0 or any(n < 0 for n in parts.values()):
        return None
    if rest:
        if "1h" not in parts:
            return None
        parts["5m"] = rest
    return {k: n for k, n in parts.items() if n > 0}


WRITE_FIELDS = ("cache_write_known", "cache_write_1h", "cache_write_12h")


def write_bundle(u):
    parts = write_parts(u) or {}
    return dict(zip(WRITE_FIELDS, (sum(parts.values()), parts.get("1h", 0), parts.get("12h", 0))))


def write_cost(cw, known, hour, twelve, rates):
    """A write with no lifetime evidence prices at the base write rate, the
    lowest any write costs, as the engine's own ApiUsage::usd_on does. That is
    a floor, never a guessed TTL: callers count those calls beside the total."""
    base = rates.get("cache_write") or 0
    h = rates.get("cache_write_1h")
    t = rates.get("cache_write_12h")
    h = base if h is None else h
    t = base if t is None else t
    return ((cw - hour - twelve) * base + hour * h + twelve * t) / 1e6


def write_sql(payload="payload"):
    """Three per-call SQL expressions matching write_bundle's evidence rule."""
    u = f"{payload}->'usage'"
    total = f"coalesce(({u}->>'cache_creation_tokens')::bigint, 0)"
    fields = [f"{u}->>'cache_creation_{ttl}_tokens'" for ttl in ("30m", "1h", "12h")]
    values = [f"coalesce(({f})::bigint, 0)" for f in fields]
    named = "(" + " + ".join(values) + ")"
    reported = "(" + " OR ".join(f"{f} IS NOT NULL" for f in fields) + ")"
    requested = f"{u}->>'cache_creation_requested_ttl'"
    valid = (f"({total} > 0 AND (({reported} AND {named} <= {total} "
             f"AND {' AND '.join(f'{v} >= 0' for v in values)} "
             f"AND ({named} = {total} OR {fields[1]} IS NOT NULL)) "
             f"OR (NOT {reported} AND {requested} IN ('5m', '30m', '1h', '12h'))))")
    out = {"cache_write_known": f"CASE WHEN {valid} THEN {total} ELSE 0 END"}
    for key, index, ttl in (("cache_write_1h", 1, "1h"), ("cache_write_12h", 2, "12h")):
        out[key] = (f"CASE WHEN {valid} THEN CASE WHEN {reported} THEN {values[index]} "
                    f"WHEN {requested} = '{ttl}' THEN {total} ELSE 0 END ELSE 0 END")
    return out

