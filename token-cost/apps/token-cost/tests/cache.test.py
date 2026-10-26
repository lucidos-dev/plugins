"""Cache evidence regressions using v0.51.0's projected event fields."""
import copy
import json
import pathlib
import re
import sqlite3
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "scripts"))
from cache_stats import build_cache, call_rows, scan, write_parts, CALL_FIELDS
import rollup
from cache_usage import write_bundle, write_sql, WRITE_FIELDS


def call(seq, minute=0, *, write=0, read=0, ttl="5m", **kw):
    u = {"input_tokens": 1000, "output_tokens": seq,
         "cache_creation_tokens": write, "cache_read_tokens": read}
    if ttl is not None:
        u["cache_creation_requested_ttl"] = ttl
    u.update(kw.pop("usage", {}))
    return dict(id=str(seq), seq=seq, type="ContextCaptured", thread="thread",
                day="2026-10-20", at=f"2026-10-20T00:{minute:02d}:00Z",
                model="model", producer="claude_code", session="1", usage=u, **kw)


def run(seq=5, **kw):
    s = dict(state="ended", since="2026-10-20T00:01:00Z", at="2026-10-20T00:09:00Z",
             beats=1, saved_usd=12345, context_tokens=1000)
    s.update(kw)
    return dict(id=str(seq), seq=seq, type="CacheKeepAliveStatusChanged", thread="thread",
                day="2026-10-20", at="2026-10-20T00:10:00Z", status=s)


def calls(events, tz="UTC"):
    """One classified row per call, before build_cache sums them."""
    out = []
    events = sorted(events, key=lambda e: e["seq"])
    scan(events, [e for e in events if e["type"] == "CacheKeepAliveStatusChanged"], tz, out.append)
    return out


def warm_run():
    return [call(1, write=1000), call(2, 4, read=1000, purpose="cache_keep_alive"),
            call(3, 8, read=1000), run()]


class CacheEvidence(unittest.TestCase):
    def test_sql_and_python_preserve_the_same_lifetime_counts(self):
        db = sqlite3.connect(":memory:")
        expressions = ", ".join(write_sql().values()).replace("::bigint", "")
        for u in ({"cache_creation_tokens": 1000},
                  {"cache_creation_tokens": 1000, "cache_creation_requested_ttl": "12h"},
                  {"cache_creation_tokens": 1000, "cache_creation_1h_tokens": 400},
                  {"cache_creation_tokens": 1000, "cache_creation_1h_tokens": 0},
                  {"cache_creation_tokens": 1000, "cache_creation_1h_tokens": 2000},
                  {"cache_creation_tokens": 1000, "cache_creation_30m_tokens": 400},
                  {"cache_creation_tokens": 1000, "cache_creation_30m_tokens": 400, "cache_creation_12h_tokens": 600}):
            row = db.execute(f"SELECT {expressions} FROM (SELECT ? AS payload)", (json.dumps({"usage": u}),)).fetchone()
            self.assertEqual(dict(zip(WRITE_FIELDS, row)), write_bundle(u))

    def test_rollup_sql_keeps_unknown_writes_separate_and_preserves_tiers(self):
        sql = rollup.ROLLUP_SQL
        sql = sql[sql.index("SELECT\n      to_char(local_day"):sql.rindex("\n  ) t")]
        sql = sql.replace(rollup.KEEP_ALIVE, "0").replace(rollup.ASKED, "NULL")
        sql = sql.replace(rollup._USAGE_TUPLE, "json_array(" + rollup._USAGE_TUPLE.strip()[1:-1] + ")")
        sql = sql.replace(rollup.LOCAL_DAY, "date(created)").replace(rollup.LOCAL_HOUR, "cast(strftime('%H', created) AS INTEGER)")
        sql = sql.replace("= ANY (%(days)s)", "IN ('2026-10-20')").replace("%(max_seq)s", "100").replace(rollup.LONG_CUT_MARK, "200000")
        sql = re.sub(r"::(?:bigint|int|text|uuid|date)\b", "", sql)
        db = sqlite3.connect(":memory:"); db.row_factory = sqlite3.Row
        db.create_function("to_char", 2, lambda value, fmt: value)
        db.create_function("regexp_replace", 3, lambda value, pattern, repl: re.sub(pattern, repl, value) if value else value)
        db.create_function("regexp_replace", 4, lambda value, pattern, repl, flags: re.sub(pattern, repl, value) if value else value)
        db.execute("CREATE TABLE events(id, thread_id, sequence, event_type, created, payload)")
        for seq, extra in enumerate(({}, {"input_tokens": 250000}, {"service_tier": "flex"}, {"cache_creation_1h_tokens": None}), 1):
            u = {"input_tokens": 100000, "cache_read_tokens": 30000, "cache_creation_tokens": 50000, "output_tokens": 1000,
                 "cache_creation_1h_tokens": 30000, **extra}
            p = {"model": "cache-model", "producer": "main_llm", "session": 1, "usage": u}
            db.execute("INSERT INTO events VALUES (?,?,?,?,?,?)", (str(seq), "thread", seq, "ContextCaptured", "2026-10-20T12:00:00Z", json.dumps(p)))
        rows = [dict(r) for r in db.execute(sql)]
        self.assertEqual(len(rows), 2)
        known = next(r for r in rows if not r["cache_unknown"])
        unknown = next(r for r in rows if r["cache_unknown"])
        self.assertEqual((known["calls"], unknown["calls"]), (3, 1))
        self.assertEqual((known["cache_write_1h"], known["long_cache_write_1h"], known["flex_cache_write_1h"]), (90000, 30000, 30000))
        self.assertEqual(unknown["cache_write_known"], 0)

    def test_ttl_is_never_a_provider_default(self):
        self.assertIsNone(write_parts({"cache_creation_tokens": 1000}))
        self.assertIsNone(write_parts({"cache_creation_tokens": 1000, "cache_creation_requested_ttl": "24h"}))
        for ttl in ("5m", "30m", "1h", "12h"):
            self.assertEqual(write_parts({"cache_creation_tokens": 1000, "cache_creation_requested_ttl": ttl}), {ttl: 1000})

    def test_reported_splits_override_requested_and_invalid_stays_unknown(self):
        self.assertEqual(write_parts({"cache_creation_tokens": 1000, "cache_creation_1h_tokens": 400,
                                      "cache_creation_requested_ttl": "12h"}), {"1h": 400, "5m": 600})
        self.assertEqual(write_parts({"cache_creation_tokens": 1000, "cache_creation_30m_tokens": 400,
                                      "cache_creation_12h_tokens": 600}), {"30m": 400, "12h": 600})
        self.assertIsNone(write_parts({"cache_creation_tokens": 1000, "cache_creation_30m_tokens": 400}))
        self.assertIsNone(write_parts({"cache_creation_tokens": 1000, "cache_creation_1h_tokens": 1001}))

    def test_full_cold_rewrite_after_real_ttl(self):
        rows = calls([call(1, write=1000), call(2, 6, write=1000)])
        self.assertEqual([r["cause"] for r in rows], ["first", "ttl_expiry"])
        self.assertEqual(calls([call(1, write=1000, ttl=None), call(2, 50, write=1000)])[-1]["cause"], "unknown")
        self.assertEqual(calls([call(1, write=1000, ttl="1h"), call(2, 50, write=1000)])[-1]["cause"], "unknown")
        # The request started at minute 4, before expiry, despite completing at 6.
        self.assertEqual(calls([call(1, write=1000), call(2, 6, write=1000, duration_ms=120000)])[-1]["cause"], "unknown")

    def test_reads_refresh_ttl_and_partial_writes_are_unknown(self):
        events = [call(1, write=1000), call(2, 4, read=1000), call(3, 8, write=1000)]
        self.assertEqual(calls(events)[-1]["cause"], "unknown")

    def test_auxiliary_copy_beat_refreshes_the_shared_prefix(self):
        beat = call(2, 4, read=1000, purpose="cache_keep_alive")
        beat["producer"] = "auxiliary"; beat["session"] = None
        events = [call(1, write=1000), beat, call(3, 8, write=1000)]
        self.assertEqual(calls(events)[-1]["cause"], "unknown")
        events[-1] = call(3, 15, write=500, read=500)
        self.assertEqual(calls(events)[-1]["cause"], "partial")

    def test_mixed_ttl_requires_every_part_expired(self):
        first = call(1, write=1000, usage={"cache_creation_1h_tokens": 400})
        self.assertEqual(calls([first, call(2, 10, write=1000)])[-1]["cause"], "unknown")

    def test_partial_write_does_not_replace_the_prefix_lifetime(self):
        events = [call(1, write=1000, ttl="1h"), call(2, 2, write=100, read=900), call(3, 10, write=1000)]
        self.assertEqual(calls(events)[-1]["cause"], "unknown")

    def test_unstamped_sessions_do_not_prove_expiry(self):
        events = [call(1, write=1000), call(2, 10, write=1000)]
        for e in events:
            e["session"] = None
        self.assertEqual(calls(events)[-1]["cause"], "unknown")

    def test_handoff_and_model_switch_require_evidence(self):
        boundary = dict(id="boundary", seq=2, type="SessionStarted", thread="thread", continuity="handoff")
        second = call(3, 2, write=1000); second["session"] = "2"
        self.assertEqual(calls([call(1, write=1000), boundary, second])[-1]["cause"], "handoff")
        self.assertEqual(calls([call(1, write=1000), second])[-1]["cause"], "unknown")
        switched = call(2, 2, write=1000); switched["model"] = "different"
        self.assertEqual(calls([call(1, write=1000), switched])[-1]["cause"], "model_switch")
        switched["seq"] = 4
        self.assertEqual(calls([call(1, write=1000), boundary, switched])[-1]["cause"], "unknown")

    def test_subagents_do_not_borrow_parent_ttl_or_boundary(self):
        child = call(2, 10, write=1000, parent="subagent")
        # Its own first write: never the parent's expiry.
        self.assertEqual(calls([call(1, write=1000), child])[-1]["cause"], "first")

    def test_legacy_successor_thread_has_explicit_handoff_evidence(self):
        boundary = dict(id="boundary", seq=2, type="SuccessorThreadSpawned", thread="thread", successor="successor")
        successor = call(3, 20, write=1000); successor["thread"] = "successor"
        self.assertEqual(calls([call(1, write=1000), boundary, successor])[-1]["cause"], "handoff")

    def test_auxiliary_purpose_matches_existing_type_filter(self):
        e = call(1, read=1000, purpose="title"); e["producer"] = "auxiliary"
        self.assertEqual(calls([e])[0]["producer"], "auxiliary:title")

    def test_ping_anchor_and_native_copy_beat(self):
        anchor = dict(id="anchor", seq=1, type="PromptInjected", thread="thread", keep_alive=True)
        events = [anchor, call(2, read=1000, anchor="anchor"), call(3, 4, read=1000, purpose="cache_keep_alive")]
        rows = calls(events)
        self.assertTrue(all(r["ping"] and r["producer"] == "cache_keep_alive" for r in rows))
        self.assertFalse(calls([call(1, read=1000)])[0]["ping"])

    def test_confirmed_saving_carries_tokens_not_engine_dollars(self):
        s = build_cache(warm_run())["savings"][0]
        self.assertEqual((s["tokens"], s["ttl"], s["model"]), (1000, "5m", "model"))
        self.assertNotIn("saved_usd", s)
        self.assertEqual(s["day"], "2026-10-20")
        es = warm_run(); es[-1]["status"]["saved_usd"] = 0
        self.assertEqual(build_cache(es)["savings"][0]["tokens"], 1000)

    def test_missing_saving_or_ttl_stays_unknown(self):
        for change in (lambda es: es[-1]["status"].pop("saved_usd"),
                       lambda es: es[0]["usage"].pop("cache_creation_requested_ttl"),
                       lambda es: es[-1]["status"].pop("context_tokens"),
                       lambda es: es[2]["usage"].update(cache_read_tokens=0),
                       lambda es: es[2].update(model="different")):
            es = warm_run(); change(es)
            self.assertIsNone(build_cache(es)["savings"][0]["tokens"])
        self.assertIsNone(build_cache([*warm_run()[:-1], run(state="warming")])["savings"][0]["tokens"])

    def test_latest_unknown_write_cannot_borrow_an_old_ttl(self):
        es = warm_run()
        es.insert(2, call(2.5, 5, write=1000, ttl=None))
        self.assertIsNone(build_cache(es)["savings"][0]["tokens"])

    def test_an_append_write_carries_the_lifetime_the_engine_read(self):
        # Real sessions: the last write before a wait is a small append, and
        # the wake reads a token or two under the run's context. The engine
        # confirmed these savings; 0.7.0's first cut marked every one unknown.
        es = warm_run()
        es[0]["usage"].update(cache_creation_tokens=100, cache_read_tokens=900)
        es[2]["usage"]["cache_read_tokens"] = 998
        s = build_cache(es)["savings"][0]
        self.assertEqual((s["tokens"], s["ttl"]), (1000, "5m"))

    def test_a_mixed_lifetime_write_saves_at_its_shortest_part(self):
        es = warm_run()
        es[0]["usage"].update(cache_creation_1h_tokens=400)
        self.assertEqual(build_cache(es)["savings"][0]["ttl"], "5m")
        es[0]["usage"].update(cache_creation_1h_tokens=1000)
        self.assertEqual(build_cache(es)["savings"][0]["ttl"], "1h")

    def test_a_wake_in_another_session_claims_no_saving(self):
        es = warm_run(); es[2]["session"] = "2"
        self.assertIsNone(build_cache(es)["savings"][0]["tokens"])

    def test_repeated_status_and_frame_do_not_duplicate(self):
        es = warm_run()
        duplicate = copy.deepcopy(es[0]); duplicate.update(id="duplicate", seq=1.5)
        es.insert(1, duplicate)
        es.append(run(6))
        doc = build_cache(es)
        self.assertEqual(len(calls(es)), 3)
        self.assertEqual(sum(r["calls"] for r in call_rows(doc)), 3)
        self.assertEqual(len(doc["savings"]), 1)
        # Identical usage in a successor session is a real new call.
        duplicate["session"] = "2"
        self.assertEqual(len(calls(es)), 4)

    def test_day_is_local_wake_day_and_empty_history_is_valid(self):
        es = warm_run(); es[-1]["status"]["at"] = "2026-10-20T23:30:00Z"
        self.assertEqual(build_cache(es, "Europe/Oslo")["savings"][0]["day"], "2026-10-21")
        self.assertEqual(calls([]), [])
        self.assertEqual(build_cache([])["savings"], [])

    def test_sql_projects_real_payload_fields_without_prompt_content(self):
        # Execute the shipped projection, adapting only Postgres casts/date
        # formatting and regexp_replace to SQLite, as the rollup suite does.
        sql = rollup.CACHE_SQL.split("FROM (", 1)[1].rsplit(") t;", 1)[0]
        sql = sql.replace(rollup.LOCAL_DAY, "'2026-10-20'").replace("created AT TIME ZONE 'UTC'", "created")
        sql = sql.replace(rollup.LONG_CUT_MARK, "50")
        sql = re.sub(r"::(?:text|float8|bigint)", "", sql)
        db = sqlite3.connect(":memory:"); db.row_factory = sqlite3.Row
        db.create_function("to_char", 2, lambda value, fmt: value)
        db.create_function("regexp_replace", 3, lambda value, pattern, replacement: re.sub(pattern, replacement, value) if value else value)
        db.execute("CREATE TABLE events(id, thread_id, sequence, event_type, created, payload)")
        payload = dict(model="sent", served_model="served", producer="claude_code", session=2,
                       usage={"input_tokens": 100, "cache_creation_tokens": 100, "cache_creation_1h_tokens": 0},
                       sections=[{"content": "PRIVATE PROMPT"}], duration_ms=123)
        db.execute("INSERT INTO events VALUES (?,?,?,?,?,?)", ("call", "thread", 1, "ContextCaptured", "2026-10-20T00:00:00Z", json.dumps(payload)))
        row = dict(db.execute(sql).fetchone())
        self.assertEqual((row["model"], row["session"], row["duration_ms"], row["long"]), ("served", 2, 123, 1))
        self.assertEqual(json.loads(row["usage"]), payload["usage"])
        self.assertNotIn("PRIVATE PROMPT", json.dumps(row))

    def test_partial_and_first_writes_are_their_own_classes(self):
        rows = calls([call(1, write=1000), call(2, 2, write=100, read=1000), call(3, 3, read=1100)])
        self.assertEqual([r["cause"] for r in rows], ["first", "partial", None])

    def test_an_append_keeps_the_context_lifetime_so_expiry_can_be_named(self):
        # A normal turn reads the prefix and appends. 0.7.0's first cut then
        # forgot the context's lifetime, so no real session could show expiry.
        events = [call(1, write=1000), call(2, 2, write=100, read=1000), call(3, 9, write=1100)]
        self.assertEqual(calls(events)[-1]["cause"], "ttl_expiry")
        # The append's lifetime unknown: the context's is too.
        events[1] = call(2, 2, write=100, read=1000, ttl=None)
        self.assertEqual(calls(events)[-1]["cause"], "unknown")

    def test_rows_sum_per_key_without_sessions_or_prompts(self):
        es = [call(1, write=1000), call(2, 2, read=1000), call(3, 3, read=1000)]
        es[2]["session"] = "2"
        doc = build_cache(es)
        self.assertEqual(doc["version"], 2)
        self.assertEqual(doc["fields"], list(CALL_FIELDS))
        rows = call_rows(doc)
        self.assertEqual(len(rows), 2)
        reads = next(r for r in rows if r["cause"] is None)
        self.assertEqual((reads["calls"], reads["cache_read"], reads["in"]), (2, 2000, 2000))
        self.assertNotIn("session", doc["fields"])
        self.assertNotIn("usage", doc["fields"])

    def test_an_unknown_lifetime_write_is_its_own_row(self):
        doc = build_cache([call(1, write=1000), call(2, 9, write=1000, ttl=None)])
        rows = sorted(call_rows(doc), key=lambda r: r["ttl_known"])
        self.assertEqual([(r["ttl_known"], r["calls"]) for r in rows], [(False, 1), (True, 1)])

    def test_scan_streams_without_a_list(self):
        events = warm_run()
        doc = build_cache(iter([e for e in events if e["type"] != "CacheKeepAliveStatusChanged"]),
                          statuses=[e for e in events if e["type"] == "CacheKeepAliveStatusChanged"])
        self.assertEqual(doc["savings"][0]["tokens"], 1000)
        self.assertEqual(doc["last_sequence"], 5)


if __name__ == "__main__":
    unittest.main()
