# Lucidos Plugins

Curated plugins for [Lucidos](https://lucidos.dev) workspaces.

Each subdirectory is an installable plugin. There are two ways to get one into a workspace.

**Point Lucidos at a plugin URL.** Copy the plugin's GitHub tree URL and tell your assistant to install it:

```
Install https://github.com/lucidos-dev/plugins/tree/main/super-slides
```

**Or register this repo as a marketplace, once.** Then every plugin here shows up in the UI:

```
Set up https://github.com/lucidos-dev/plugins as a plugin marketplace
```

Open the **Plugins** panel, uncheck "Installed only", and install what you want from the list. Lucidos always shows a confirmation panel before a plugin lands.

## Available plugins

| Plugin | Description |
|---|---|
| [`ouroboros`](./ouroboros/apps/ouroboros/README.md) | Classic Snake game with a polished highscore board, replays, and custom victory audio. Plays fully local out of the box; optionally syncs a shared family/friends scoreboard through a Lucidos proxy you configure. |
| [`super-slides`](./super-slides/) | Presentation engine with semantic `.slides` JSON, themed components, sectioned decks, slide picker, embedded speaker-remote mode, and a phone remote. Auto-discovers any `.slides` file under `artifacts/presentations/`. |
| [`notify-when-needed`](./notify-when-needed/) | Pushes a deep-linking notification whenever Lucidos or a coding agent is blocked waiting on you — a question, permission prompt, credential request, or MCP consent. Tapping the push lands on the exact card to act on. Ships an event-driven trigger that auto-registers on install. |

## Authoring

See [`system-knowhow/building-a-plugin.md`](https://github.com/lucidos-dev/lucidos/blob/main/system-knowhow/building-a-plugin.md) in the Lucidos engine for the manifest schema and validation rules.
