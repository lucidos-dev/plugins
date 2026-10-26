"""Evidence for the cache views, without prompts, prices or provider defaults.

Source: lucidos v0.51.0 engine/cache_ttl.rs, llm/cache_lifetime.rs,
thread_events/keep_alive_status.rs and event_wait/keep_alive.rs::read_run_end.
The app prices these token records against its dated price table.
"""
from datetime import datetime, timezone
import re
from zoneinfo import ZoneInfo
import pathlib
import sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[3] / "scripts" / "token-cost"))
from cache_usage import TTLS, write_parts


def stamp(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def build_cache(events, tz="UTC"):
    """Fold sequence-ordered, compact event projections, rebuilding on each run.

    A write call is not necessarily a full rewrite. Only a cold write with a
    prior context and one unambiguous boundary gets a named cause. Partial
    writes, first writes, overlapping boundaries and missing evidence remain
    unknown. Refreshes use request start time, never response completion.
    """
    events = sorted(events, key=lambda e: e["seq"])
    anchors = {e["id"] for e in events if e["type"] == "PromptInjected" and e.get("keep_alive")}
    prior, contexts, frames, boundaries, runs, predecessors = {}, {}, {}, {}, {}, {}
    calls, savings = [], []
    for e in events:
        tid, kind = e["thread"], e["type"]
        if kind == "SessionStarted":
            boundaries[tid] = e.get("continuity")
            continue
        if kind == "SuccessorThreadSpawned":
            boundaries[e.get("successor")] = "handoff"
            predecessors[e.get("successor")] = tid
            continue
        if kind == "CacheKeepAliveStatusChanged":
            s = e.get("status") or {}
            if s.get("since"):
                # Ended repeats replace the same run rather than add a saving.
                runs[(tid, s["since"])] = (e, s)
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
        cause = "unknown"
        if main and signature[2] > 0 and signature[1] == 0 and old:
            reasons = []
            if main and boundaries.get(tid) == "handoff":
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
        if signature[1] and signature[2]:
            ttl = None  # The retained prefix and appended write can have different lifetimes.
        same = old and old["session"] == e.get("session") and old["model"] == e["model"]
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
        row = {"day": e["day"], "thread": tid, "session": e.get("session") or "",
               "producer": "cache_keep_alive" if ping else
                   "auxiliary:" + re.sub(r"[^A-Za-z0-9_.-]", "_", e["purpose"])
                   if producer == "auxiliary" and e.get("purpose") else producer,
               "model": e["model"] or "unknown", "effort": e.get("effort") or "", "usage": u,
               "parts": parts, "ping": ping, "cause": cause if signature[2] else None}
        calls.append((e, row, started, main, ping))

    by_thread = {}
    for c in calls:
        by_thread.setdefault(c[0]["thread"], []).append(c)
    for (tid, since), (e, s) in runs.items():
        if not s.get("beats"):
            continue
        # Match the engine's first real request after the first ping. The
        # emitted saved_usd is evidence only; its dollars are never imported.
        own = by_thread.get(tid, [])
        end = stamp(s.get("at") or e["at"])
        pings = [c for c in own if c[4] and stamp(since) <= c[2] <= end]
        first = min((c[2] for c in pings), default=None)
        wake = next((c for c in own if c[3] and not c[4]
                     and first is not None and first < c[2] <= end), None)
        writes = [c for c in own if c[3] and wake
                  and c[0]["seq"] < wake[0]["seq"] and c[1]["usage"].get("cache_creation_tokens")]
        write = writes[-1] if writes else None
        # A mixed-lifetime context has no single proven rewrite price.
        known = (s.get("state") == "ended" and s.get("saved_usd") is not None
                 and s["saved_usd"] >= 0 and s.get("context_tokens") and wake and write
                 and wake[1]["usage"].get("cache_read_tokens", 0) >= s["context_tokens"]
                 and write[1]["usage"].get("cache_creation_tokens", 0) >= s["context_tokens"]
                 and not write[1]["usage"].get("cache_read_tokens", 0)
                 and wake[1]["model"] == write[1]["model"]
                 and wake[1]["session"] and wake[1]["session"] == write[1]["session"]
                 and write[1]["parts"] and len(write[1]["parts"]) == 1)
        model_row = wake[1] if wake else (pings[-1][1] if pings else None)
        savings.append({"day": datetime.fromtimestamp(end, ZoneInfo(tz)).date().isoformat(), "thread": tid,
                        "model": model_row["model"] if model_row else "unknown",
                        "effort": model_row["effort"] if model_row else "",
                        "producer": "cache_keep_alive", "session": model_row["session"] if model_row else "",
                        "tokens": s["context_tokens"] if known else None,
                        "ttl": next(iter(write[1]["parts"])) if known else None,
                        "prompt": wake[1]["usage"].get("input_tokens", 0) if known else 0,
                        "tier": wake[1]["usage"].get("service_tier") if known else None})
    return {"version": 1, "generated": datetime.now(timezone.utc).isoformat(),
            "last_sequence": max((e["seq"] for e in events), default=0),
            "calls": [c[1] for c in calls], "savings": savings}
