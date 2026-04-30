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

## Authoring

See [`system-knowhow/building-a-plugin.md`](https://github.com/lucidos-dev/lucidos) in the Lucidos engine for the manifest schema and validation rules.
