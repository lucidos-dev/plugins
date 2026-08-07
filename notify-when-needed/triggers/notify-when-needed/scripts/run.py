#!/usr/bin/env python3
"""Push a deep-linking notification for any event the trigger subscribes to.

The trigger's `on:` list decides which events fire this — the script
treats them uniformly. Title and message come from the payload's
common fields (`title`, `message`, `summary`, `question`); the event
type is only the fallback title. `--tap navigate` + the source event's
thread id (and event id when present) make the push land on the exact
card the user needs to act on. The CLI infers `tap.to.target=thread`
from `--thread-id`.

The trigger subscribes to two families:

Blocking requests (the agent is waiting on an answer):
  - UserQuestionAsked
  - CodingAgentPermissionRequest
  - CredentialRequested
  - McpConsentRequested

Turn failures (the turn died and nothing is waiting on the user, but the
work stopped):
  - ResponseFailed

All of them carry a `thread_id` (via TRIGGER_EVENT_THREAD_ID) and an event id,
so every fire deep-links into the originating thread and pulses the exact
card the user needs to act on.

Dedupe: a single failing turn can emit `ResponseFailed` twice (once stamped
with `request_event_id`, once without — seen on the chat path). Identical
(thread, error) pairs inside DEDUPE_WINDOW_SECS collapse to one push. Per-trigger
concurrency is 1, so the two fires are serialized and the second one reads the
state the first wrote.
"""
import json
import os
import subprocess
import time

DEDUPE_WINDOW_SECS = 300
DEDUPE_RETENTION_SECS = 3600
MAX_MESSAGE_CHARS = 240

event_type = os.environ["TRIGGER_EVENT_TYPE"]
payload = json.loads(os.environ.get("TRIGGER_EVENT_PAYLOAD", "{}"))
thread_id = os.environ.get("TRIGGER_EVENT_THREAD_ID")
event_id = os.environ.get("TRIGGER_EVENT_ID")

# State lives beside the script under data/, anchored on LUCIDOS_WORKSPACE.
# __file__ is NOT safe here: the engine copies the source into
# .lucidos/exhaust/<run-id>/ and runs that copy, so a __file__-relative path
# writes to a phantom directory. See knowhow/script-state-paths.md.
_WS = os.environ.get("LUCIDOS_WORKSPACE")
_STATE_DIR = (
    os.path.join(_WS, "data", "triggers", "notify-when-needed", "state")
    if _WS
    else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "state")
)
_SEEN_PATH = os.path.join(_STATE_DIR, "seen.json")


def already_pushed(key):
    """True when an identical push went out inside the dedupe window.

    Records the key either way, and prunes anything older than the retention
    window so the file can't grow without bound.
    """
    now = time.time()
    try:
        with open(_SEEN_PATH, "r", encoding="utf-8") as fh:
            seen = json.load(fh)
        if not isinstance(seen, dict):
            seen = {}
    except (OSError, ValueError):
        seen = {}

    last = seen.get(key)
    duplicate = isinstance(last, (int, float)) and (now - last) < DEDUPE_WINDOW_SECS

    seen = {
        k: v
        for k, v in seen.items()
        if isinstance(v, (int, float)) and (now - v) < DEDUPE_RETENTION_SECS
    }
    seen[key] = now

    try:
        os.makedirs(_STATE_DIR, exist_ok=True)
        tmp = _SEEN_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(seen, fh)
        os.replace(tmp, _SEEN_PATH)
    except OSError:
        # A state write failure must never swallow the notification.
        pass

    return duplicate


# Per-event title/message rendering: prefer the most specific human-readable
# field the payload carries; fall back to the event type for the title and a
# generic action message for the body.
dedupe_key = None

if event_type == "UserQuestionAsked":
    title = "Lucidos is asking"
    message = payload.get("question") or "Lucidos has a question for you."
elif event_type == "CodingAgentPermissionRequest":
    title = "Permission needed"
    message = payload.get("summary") or (
        f"Lucidos wants to run {payload.get('tool_name', 'a tool')}."
    )
elif event_type == "CredentialRequested":
    provider = payload.get("provider") or "a service"
    title = "Credential needed"
    message = payload.get("summary") or f"Sign in to {provider}."
elif event_type == "McpConsentRequested":
    title = "MCP consent needed"
    message = payload.get("summary") or "An MCP tool wants to run."
elif event_type == "ResponseFailed":
    # The scheduler already auto-creates an error notification when a trigger
    # run fails, so a trigger-channel failure would double-notify.
    if payload.get("channel") == "trigger":
        print("trigger-channel ResponseFailed skipped (scheduler notifies)")
        raise SystemExit(0)
    error = (payload.get("error") or "").strip() or "The turn failed with no error text."
    if len(error) > MAX_MESSAGE_CHARS:
        error = error[: MAX_MESSAGE_CHARS - 1].rstrip() + "…"
    # `claude_code` is the coding-agent channel for both Claude Code and Codex.
    title = (
        "Coding agent stopped on an error"
        if payload.get("channel") == "claude_code"
        else "Lucidos stopped on an error"
    )
    message = error
    dedupe_key = f"ResponseFailed|{thread_id or '-'}|{error}"
else:
    # Event-agnostic fallback so new on: entries keep working without a code
    # change here.
    title = payload.get("title") or event_type
    message = (
        payload.get("message")
        or payload.get("question")
        or payload.get("summary")
        or f"{event_type} needs your attention"
    )

if dedupe_key and already_pushed(dedupe_key):
    print(f"duplicate {event_type} suppressed: {message}")
    raise SystemExit(0)

args = ["lucidos", "notify", "--title", title, "--message", message]
if thread_id:
    args += ["--tap", "navigate", "--thread-id", thread_id]
    if event_id:
        args += ["--event-id", event_id]

subprocess.run(args, check=True)
print(f"pushed {event_type}: {title}")
