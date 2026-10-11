# Notify When Needed

Lucidos often works on its own. Sometimes it stops and waits for you. This plugin tells you when that happens, so work does not sit still while you look elsewhere.

## What it notifies you about

You get one notification when a thread is blocked on you:

- **A question.** Lucidos asks you to choose or answer something.
- **A permission prompt.** A coding agent (Claude Code or Codex) wants to run a tool and waits for your yes.
- **A credential request.** Lucidos needs a key or a sign-in before it can continue.
- **An MCP consent.** An MCP tool wants to run and needs your approval.

You also get one when a turn **stops on an error**. Nothing waits for you then, but the work has stopped, and you want to know.

Tap the notification and Lucidos opens the thread at the exact card or failed turn. You do not have to search for it.

## What it never notifies you about

- **Normal progress.** A turn that finishes, a reply, a proposed change or a background task does not trigger it. It only speaks when you are needed.
- **The same error twice.** When one failed turn reports the same error more than once, you get one notification. Repeats inside five minutes are dropped.
- **Failures in trigger runs.** Lucidos already sends its own error notification when a trigger run fails, so this plugin stays quiet there. You never get two notifications for one failure.

## How it works

The plugin ships one event trigger, "Notify when Lucidos needs me". It **registers itself when you install the plugin**, and starts to work at once. There is nothing to set up and no schedule to pick. You can pause it in the Triggers panel at any time. Uninstall removes it.

Lucidos decides where each notification goes. When you have Lucidos open on any device, you see it as a toast. When you do not, it arrives as a push. Either way it also lands in your notification inbox.

The plugin keeps one small file, `artifacts/notify-when-needed/seen.json`, to remember which errors it already reported. Uninstall leaves that file in place.

## Needs

Lucidos 0.48.0 or later.

Source: [github.com/lucidos-dev/plugins](https://github.com/lucidos-dev/plugins/tree/main/notify-when-needed)
