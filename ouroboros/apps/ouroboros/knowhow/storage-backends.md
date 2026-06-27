---
name: Snake Storage Backends
description: How Ouroboros (snake-game) stores highscores and players — local-only via lucidos.data, or one of N shared scoreboards via Lucidos proxies. Covers the store.js abstraction, the multi-board picker UI, the proxy contract, the RTDB layout, and recommended security rules.
---

## Why this design exists

Ouroboros started as a single-user app reading/writing JSON in the local Lucidos workspace (`artifacts/games/snake-highscores.json`, `artifacts/games/snake-players.json`). For a shared family/friends scoreboard the data needs to live somewhere accessible from every player's machine, but:

- **No URLs or auth tokens may live in the iframe.** Plugin recipients install the app and immediately see somebody else's Firebase URL and token unless we keep both server-side. Same reason the heatpump app talks to Comfort Cloud through a proxy entry — the iframe never sees credentials.
- **A user can play in several scoreboards.** Family list, work-friends list, public list — all different Firebase backends, all simultaneously available, the user picks which one is "active" right now.

So the app keeps a *list of boards*. One is always "Lokalt" (private, lucidos.data). Each additional board is a **named pointer to a Lucidos proxy entry** — the proxy holds the real URL + auth, the app just calls `lucidos.proxy(<name>).fetch(...)`.

## File layout

```
apps/snake-game/
  store.js              ← backend abstraction (this contract)
  knowhow/
    storage-backends.md ← this doc
  index.html            ← storage-screen UI (board list + add form)
  script.js             ← board-list rendering, add/test/remove handlers
  styles.css            ← .board-list, .board-row, .add-board-form
```

## store.js public API

```
SnakeStore.getMode()          → 'local' | 'shared'
SnakeStore.isShared()         → boolean
SnakeStore.getActiveProxy()   → string | null  (e.g. 'snake-storage-familien')
SnakeStore.getActiveLabel()   → string         (e.g. 'Familien' or 'Lokalt')

SnakeStore.listBoards()       → [{ label, proxy }]   shared boards only
SnakeStore.addBoard({label, proxy})
SnakeStore.removeBoard(proxy)
SnakeStore.setLocal()
SnakeStore.setActiveBoard(proxy)
SnakeStore.testBoard(proxy)   → throws on failure (read + throwaway write)

SnakeStore.loadHighscores()   → [{name, score, date}, ...]
SnakeStore.saveHighscores(arr)
SnakeStore.loadPlayers()      → [name, ...]
SnakeStore.addPlayer(name)
```

`script.js` calls only these. Mode/board switches re-fetch highscores and players so the UI repaints.

### Storage of the board list itself

The board list and the active selection are kept in the iframe's `localStorage`:

| key                       | value                                          |
| ------------------------- | ---------------------------------------------- |
| `snake-storage-mode`      | `'local'` or `'shared'`                        |
| `snake-active-proxy`      | proxy name when mode is `'shared'`             |
| `snake-boards`            | JSON `[{label, proxy}, ...]`                   |

This is per-device. A user who plays on two laptops sets up the same boards twice — that's fine because the proxy entries are also per-workspace.

## Backends

### Local (`mode = 'local'`)

Reads/writes `artifacts/games/snake-highscores.json` and `artifacts/games/snake-players.json` via `lucidos.data.read/write`. Same behavior the app had before any of this existed. Default mode.

### Shared (`mode = 'shared'`, `activeProxy = '<name>'`)

All reads/writes go through `lucidos.proxy(name).fetch(path)`. The proxy entry in `data/config/apis.json` rewrites the request to a Firebase Realtime Database URL and (optionally) attaches an auth token from the secret store.

Paths the app uses:

| path                           | method | purpose                              |
| ------------------------------ | ------ | ------------------------------------ |
| `/snake/highscores.json`       | `GET`  | load highscores doc                  |
| `/snake/highscores.json`       | `PUT`  | overwrite highscores doc             |
| `/snake/players.json`          | `GET`  | load players list                    |
| `/snake/players.json`          | `PUT`  | overwrite players list               |
| `/snake/_probe.json`           | `PUT`+`GET`+`DELETE` | connection test            |

Highscores doc shape (matches local format exactly so callers don't branch):
```json
{
  "highscores": [{"name":"KENNETH","score":56,"date":"2026-02-15T12:00:00Z"}, ...],
  "dailyScores": [{"name":"KENNETH","score":16,"date":"2026-05-13T11:31:00Z"}],
  "dailyDate": "2026-05-13"
}
```

Players doc shape:
```json
{ "players": ["KENNETH","EMIL"] }
```

## Proxy contract (data/config/apis.json)

A shared board is just a Lucidos proxy entry. Suggested naming: `snake-storage-<group>` (e.g. `snake-storage-familien`). The user enters that name in the app's "Add board" form; the proxy entry must already exist in `apis.json`.

Minimal, no auth (open RTDB rules — fine for low-stakes lists):
```json
"snake-storage-familien": {
  "base_url": "https://snake-familien-default-rtdb.firebaseio.com"
}
```

With a Firebase database secret as RTDB query-param auth:
```json
"snake-storage-familien": {
  "base_url": "https://snake-familien-default-rtdb.firebaseio.com",
  "auth": {
    "pipeline": [
      { "type": "static_credential",
        "kind": "query_param",
        "param_name": "auth",
        "credential": "snake-storage-familien-token" }
    ]
  }
}
```

The `credential` value is the name of an entry in the Lucidos secret store (added via `request_credential`). The token never appears in `apis.json`, in script source, or in the iframe.

## Connection test (`testBoard`)

Run when adding a board, when switching to one, and on demand from the action button. Sequence:

1. `GET /snake/_probe.json` — proves the proxy resolves and (if auth is required) the credential is good.
2. `PUT /snake/_probe.json` with body `true` — proves writes are allowed.
3. `DELETE /snake/_probe.json` — cleanup; failure here is logged but not fatal.

Any non-2xx in steps 1–2 surfaces as the error message in the storage screen status area. The app falls back to local mode and re-renders the badge (💾) so the user isn't stuck in a broken shared state.

## Recommended Firebase RTDB security rules

For an open family/friends list (anyone with the URL can read/write the snake namespace):
```json
{ "rules": {
    "snake": { ".read": true, ".write": true }
  }
}
```

For a private list (Firebase database secret only — what the `query_param auth` recipe above expects):
```json
{ "rules": { ".read": false, ".write": false } }
```
The Lucidos proxy attaches `?auth=<secret>` and the database secret bypasses rules.

For a multi-user setup with per-user auth, switch the proxy to use a Google ID token (`script_handshake`) and tighten the rules to `auth != null` — out of scope here, see `system-knowhow/building-an-auth-handshake.md`.

## When packaging as a plugin

The plugin ships:
- `apps/snake-game/` (UI, store.js, knowhow)
- `knowhow/snake/storage-backends.md` (optional, if you want it discoverable workspace-wide)

It does **not** ship:
- Any `apis.json` snippet with hardcoded URLs.
- Any Firebase tokens.

The plugin manifest's `setup` field should walk the installer LLM through:
1. Asking whether they want only-local, want to join an existing scoreboard (paste proxy name), or want to set up a new one.
2. If new: ask for the Firebase RTDB URL, write a `snake-storage-<group>` entry to `data/config/apis.json`, optionally request the database secret via `request_credential` and wire the `query_param` auth layer.
3. Tell the user to open Ouroboros → 💾 → "Legg til delt liste" and enter the proxy name.

That keeps the plugin install ceremony explicit — every recipient picks their own backend instead of inheriting the author's.

## Common failure modes

| Symptom                                  | Cause                                                                |
| ---------------------------------------- | -------------------------------------------------------------------- |
| `404 Proxy 'snake-storage-x' not found`  | Proxy entry missing in `data/config/apis.json`. Add it, no restart needed. |
| `401 Permission denied`                  | Auth credential wrong/missing for the configured RTDB rules.         |
| `400 Invalid data; couldn't parse JSON`  | RTDB requires `.json` suffix on every path — store.js does this; check you didn't add a custom path that drops it. |
| Highscores merge instead of replace      | RTDB `PUT` overwrites. If you ever need partial updates, switch to `PATCH`. |
| Two players race to save and lose scores | Pre-write read merge is in `addHighscore` — keep it. Concurrent writes within the same second can still drop a row; acceptable for a family game. |
