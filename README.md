# Lucidos Plugins

Curated plugins for [Lucidos](https://lucidos.dev) workspaces.

Each subdirectory is an installable plugin. To install one, copy its GitHub tree URL and pass it to `install_plugin` in your Lucidos workspace, e.g.:

```
install_plugin("https://github.com/lucidos-dev/plugins/tree/main/browser-learning")
```

## Available plugins

| Plugin | Description |
|---|---|
| [`browser-learning`](./browser-learning/) | Self-healing site knowhow for browser automation. Agents emit observations during browser tasks; a reflection trigger folds them into per-domain knowhow so the next agent visits with better priors. |
| [`ouroboros`](./ouroboros/) | Classic Snake game with a polished highscore board, replays, and custom victory audio. Plays fully local out of the box; optionally syncs a shared family/friends scoreboard through a Lucidos proxy you configure. |
| [`super-slides`](./super-slides/) | Presentation engine with semantic `.slides` JSON, themed components, sectioned decks, slide picker, embedded speaker-remote mode, and a phone remote. Auto-discovers any `.slides` file under `artifacts/presentations/`. |
| [`notify-when-needed`](./notify-when-needed/) | Pushes a deep-linking notification whenever Lucidos or a coding agent is blocked waiting on you — a question, permission prompt, credential request, or MCP consent. Tapping the push lands on the exact card to act on. Ships an event-driven trigger that auto-registers on install. |

## Authoring

See [`system-knowhow/building-a-plugin.md`](https://github.com/lucidos-dev/lucidos) in the Lucidos engine for the manifest schema and validation rules.
