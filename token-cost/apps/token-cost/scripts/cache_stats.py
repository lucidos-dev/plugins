"""Evidence for the cache views, without prompts, prices or provider defaults.

Source: lucidos v0.51.0 engine/cache_ttl.rs, llm/cache_lifetime.rs,
thread_events/keep_alive_status.rs and event_wait/keep_alive.rs::read_run_end.
The app prices these token records against its dated price table.

A workspace holds millions of calls, so the scan streams them in sequence
order and keeps only per-stream state, and the file holds one summed row per
day, thread, producer, model, effort, tier and evidence class, not one per call.
"""
from datetime import datetime, timezone
import re
from zoneinfo import ZoneInfo
import pathlib
import sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[3] / "scripts" / "token-cost"))
from cache_usage import TTLS, write_parts

VERSION = 2
# One summed row per distinct key; `calls` onwards are sums.
CALL_FIELDS = ("day", "thread", "producer", "model", "effort", "tier", "long", "ping", "cause",
               "ttl_known", "calls", "in", "cache_read", "cache_write", "out",
               "cache_write_1h", "cache_write_12h")
KEY_LEN = CALL_FIELDS.index("calls")
# What a cache write was. Only `unknown` and the three named causes are cold
# rewrites of a context that existed; `first` had none, and `partial` read
# some cache, so it extended a warm prefix rather than rewrote one.
CAUSES = ("ttl_expiry", "handoff", "model_switch", "unknown", "first", "partial")


def stamp(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def shortest(parts):
    """The lifetime CacheTtl::of_write gives a write: its shortest part."""
    return min(parts, key=TTLS.get) if parts else None


def keep_alive_runs(statuses):
    """Runs by (thread, since), each its last status: an ended repeat replaces
    the same run rather than adds a saving."""
    runs = {}
    for e in sorted(statuses, key=lambda e: e["seq"]):
        s = e.get("status") or {}
        if s.get("since"):
            runs[(e["thread"], s["since"])] = (e, s)
    return runs


def scan(events, statuses=(), tz="UTC", on_call=None):
    """Classify each call of sequence-ordered `events`, handing one row per
    call to `on_call`, and return the keep-alive savings of `statuses`.

    A write call is not necessarily a full rewrite. Only a cold write with a
    prior context and one unambiguous boundary gets a named cause. Overlapping
    boundaries and missing evidence stay unknown; first and partial writes are
    their own classes. Refreshes use request start time, never completion.
    """
    runs = {}
    for (tid, since), (e, s) in keep_alive_runs(statuses).items():
        if s.get("beats"):
            runs.setdefault(tid, []).append({"since": stamp(since), "end": stamp(s.get("at") or e["at"]),
                                             "event": e, "status": s, "first": None, "ping": None,
                                             "wake": None, "write": None})
    anchors, prior, contexts, frames, boundaries, predecessors, last_write = set(), {}, {}, {}, {}, {}, {}
    for e in events:
        tid, kind = e["thread"], e["type"]
        if kind == "PromptInjected":
            if e.get("keep_alive"):
                anchors.add(e["id"])
            continue
        if kind == "SessionStarted":
            boundaries[tid] = e.get("continuity")
            continue
        if kind == "SuccessorThreadSpawned":
            boundaries[e.get("successor")] = "handoff"
            predecessors[e.get("successor")] = tid
            continue
        if kind != "ContextCaptured" or not e.get("usage"):
            continue
        u = e["usage"]
        producer = e.get("producer") or "unknown"
        scope = (tid, e.get("session"), producer, e.get("parent"))
        signature = tuple(u.get(f, 0) or 0 for f in
                          ("input_tokens", "cache_read_tokens", "cache_creation_tokens", "output_tokens"))
        if producer == "claude_code" and frames.get(scope) == signature:
            continue
        frames[scope] = signature
        ping = e.get("purpose") == "cache_keep_alive" or e.get("anchor") in anchors
        main = (not e.get("parent") and e.get("purpose") in (None, "turn")
                and u.get("input_tokens") is not None)
        # Purpose-scoped auxiliary calls never borrow the main context's TTL.
        stream = (tid, producer, e.get("parent"), e.get("purpose") if producer == "auxiliary" else None)
        old = prior.get(stream)
        own_context = old is not None
        if not old and main and boundaries.get(tid) == "handoff":
            old = prior.get((predecessors.get(tid), *stream[1:]))
        parts = write_parts(u)
        started = stamp(e["at"]) - (e.get("duration_ms") or 0) / 1000
        cause = None
        if signature[2]:
            cause = "partial" if signature[1] else "unknown" if old else "first"
        if main and cause == "unknown":
            reasons = []
            if boundaries.get(tid) == "handoff":
                reasons.append("handoff")
            if old["model"] != e["model"]:
                reasons.append("model_switch")
            if (own_context and old["session"] is not None and old["session"] == e.get("session") and old["model"] == e["model"]
                    and old["ttl"] and started - old["refresh"] > old["ttl"]):
                reasons.append("ttl_expiry")
            if len(reasons) == 1:
                cause = reasons[0]
        if main and not ping:
            boundaries.pop(tid, None)
        # All parts must have expired before a full cold write can be named
        # TTL expiry. The engine uses the shortest for scheduling its beats.
        ttl = max((TTLS[t] for t in parts), default=None) if parts else None
        same = old and old["session"] == e.get("session") and old["model"] == e["model"]
        if signature[1] and signature[2]:
            # The read refreshed the retained prefix at its own lifetime and
            # the append has another, so the whole context lives to the longer
            # one. Either unknown leaves the context's lifetime unknown.
            ttl = max(ttl, old["ttl"]) if ttl and same and old["ttl"] else None
        if not signature[2] and same:
            ttl = old["ttl"]
        if main or signature[2] or signature[1]:
            prior[stream] = {"model": e["model"], "session": e.get("session"),
                             "ttl": ttl, "refresh": started}
            contexts.setdefault(tid, {})[stream] = prior[stream]
        # Copy/prefill beats have an auxiliary producer and may omit the
        # session stamp, but their purpose explicitly names the shared prefix.
        # They must prevent an expiry being inferred from the last real turn.
        if ping and not e.get("parent") and (signature[1] or signature[2]):
            for key, context in contexts.get(tid, {}).items():
                if (key[0] == tid and key[2] is None and key[3] is None
                        and context["model"] == e["model"]):
                    context["refresh"] = max(context["refresh"], started)
        row = {"day": e["day"], "thread": tid,
               "producer": "cache_keep_alive" if ping else
                   "auxiliary:" + re.sub(r"[^A-Za-z0-9_.-]", "_", e["purpose"])
                   if producer == "auxiliary" and e.get("purpose") else producer,
               "model": e["model"] or "unknown", "effort": e.get("effort") or "",
               "tier": u.get("service_tier") or "", "long": bool(e.get("long")), "ping": ping,
               "cause": cause, "ttl_known": parts is not None if signature[2] else True,
               "calls": 1, "in": signature[0], "cache_read": signature[1], "cache_write": signature[2],
               "out": signature[3],
               "cache_write_1h": (parts or {}).get("1h", 0), "cache_write_12h": (parts or {}).get("12h", 0)}
        if on_call:
            on_call(row)
        # The run's wake is its first real request after its first ping, as
        # the engine's run_end_sql finds it; its write is the thread's last
        # cache write before the wake, as last_cache_write reads it.
        call = {"model": e["model"], "session": e.get("session"), "effort": row["effort"],
                "read": signature[1], "parts": parts}
        for run in runs.get(tid, ()):
            if run["wake"] or started > run["end"]:
                continue
            if ping:
                if started >= run["since"]:
                    run["first"] = started if run["first"] is None else min(run["first"], started)
                    run["ping"] = call
            elif main and run["first"] is not None and started > run["first"]:
                run["wake"], run["write"] = call, last_write.get(tid)
        if main and signature[2]:
            last_write[tid] = call

    savings = []
    for tid, own in runs.items():
        for run in own:
            s, wake, write = run["status"], run["wake"], run["write"]
            # The engine claims a saving only when the wake read a warm cache
            # whose lifetime it knew. The plugin re-prices that rewrite of the
            # run's context at the lifetime the engine read, never its dollars.
            known = (s.get("state") == "ended" and s.get("saved_usd") is not None and s["saved_usd"] >= 0
                     and s.get("context_tokens") and wake and write and write["parts"]
                     and wake["read"] > 0 and wake["model"] == write["model"]
                     and wake["session"] is not None and wake["session"] == write["session"])
            model_row = wake or run["ping"]
            savings.append({"day": datetime.fromtimestamp(run["end"], ZoneInfo(tz)).date().isoformat(), "thread": tid,
                            "model": model_row["model"] if model_row else "unknown",
                            "effort": model_row["effort"] if model_row else "",
                            "producer": "cache_keep_alive",
                            "tokens": s["context_tokens"] if known else None,
                            "ttl": shortest(write["parts"]) if known else None})
    return savings


def build_cache(events, tz="UTC", statuses=None, relabel=None):
    """The cache.json document. `events` is sequence-ordered; a list is
    sorted, and its keep-alive statuses read, so a test can pass one list.
    `relabel(producer, thread)` files a call under the rollup's producer id."""
    last = 0
    if statuses is None:
        events = sorted(events, key=lambda e: e["seq"])
        statuses = [e for e in events if e["type"] == "CacheKeepAliveStatusChanged"]
    sums = {}

    def add(row):
        if relabel:
            row["producer"] = relabel(row["producer"], row["thread"])
        key = tuple(row[f] for f in CALL_FIELDS[:KEY_LEN])
        acc = sums.get(key)
        if acc is None:
            sums[key] = [row[f] for f in CALL_FIELDS[KEY_LEN:]]
        else:
            for i, f in enumerate(CALL_FIELDS[KEY_LEN:]):
                acc[i] += row[f]

    def ordered():
        nonlocal last
        for e in events:
            last = max(last, e["seq"])
            yield e

    statuses = list(statuses)
    savings = scan(ordered(), statuses, tz, add)
    last = max([last, *(e["seq"] for e in statuses)])
    return {"version": VERSION, "generated": datetime.now(timezone.utc).isoformat(),
            "last_sequence": last, "fields": list(CALL_FIELDS),
            "calls": [[*k, *v] for k, v in sorted(sums.items(), key=lambda kv: kv[0][:2])],
            "savings": savings}


def call_rows(doc):
    """The document's call rows as dicts, for readers and tests."""
    return [dict(zip(doc["fields"], r)) for r in doc["calls"]]
