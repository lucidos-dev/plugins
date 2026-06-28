#!/usr/bin/env python3
"""Push a deep-linking notification for any event the trigger subscribes to.

The trigger's `on:` list decides which events fire this — the script
treats them uniformly. Title and message come from the payload's
common fields (`title`, `message`, `summary`, `question`); the event
type is only the fallback title. `--tap navigate` + the source event's
thread id (and event id when present) make the push land on the exact
card the user needs to act on. The CLI infers `tap.to.target=thread`
from `--thread-id`.

The trigger currently subscribes to four blocking-request events:
  - UserQuestionAsked
  - CodingAgentPermissionRequest
  - CredentialRequested
  - McpConsentRequested

All four carry a `thread_id` (via TRIGGER_EVENT_THREAD_ID) and an event id,
so every fire deep-links into the originating thread and pulses the exact
card the user needs to act on.
"""
import json
import os
import subprocess

event_type = os.environ["TRIGGER_EVENT_TYPE"]
payload = json.loads(os.environ.get("TRIGGER_EVENT_PAYLOAD", "{}"))
thread_id = os.environ.get("TRIGGER_EVENT_THREAD_ID")
event_id = os.environ.get("TRIGGER_EVENT_ID")

# Per-event title/message rendering: prefer the most specific human-readable
# field the payload carries; fall back to the event type for the title and a
# generic action message for the body.
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

args = ["lucidos", "notify", "--title", title, "--message", message]
if thread_id:
    args += ["--tap", "navigate", "--thread-id", thread_id]
    if event_id:
        args += ["--event-id", event_id]

subprocess.run(args, check=True)
