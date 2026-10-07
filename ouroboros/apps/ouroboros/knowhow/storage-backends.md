---
name: Snake Storage Backends
description: How Ouroboros (snake-game) stores highscores and players — local-only via lucidos.data, or one of N shared scoreboards via Lucidos proxies. Covers the js/store.js abstraction, the multi-board picker UI, the proxy contract, the RTDB layout, and recommended security rules.
---

## Why this design exists

Ouroboros started as a single-user app reading/writing JSON in the local Lucidos workspace (`artifacts/games/snake-highscores.json`, `artifacts/games/snake-players.json`). For a shared family/friends scoreboard the data needs to live somewhere accessible from every player's machine, but:

- **No URLs or auth tokens may live in the iframe.** Plugin recipients install the app and immediately see somebody else's Firebase URL and token unless we keep both server-side. Same reason the heatpump app talks to Comfort Cloud through a proxy entry — the iframe never sees credentials.
- **A user can play in several scoreboards.** Family list, work-friends list, public list — all different Firebase backends, all simultaneously available, the user picks which one is "active" right now.

So the app keeps a *list of boards*. One is always "Lokalt" (private, lucidos.data). Each additional board is a **named pointer to a Lucidos proxy entry**: the proxy holds the real URL + auth, the app just calls `lucidos.proxy(<name>).fetch(...)`.

**Boards are discovered, not entered.** Every proxy in `data/config/apis.json` whose name starts with `snake-storage-` shows up in the 💾 screen by itself (`store.refreshBoards()`). The label is the rest of the name: `snake-storage-familien` → "Familien". To add a shared board, create the proxy; nothing else. Discovery reads only the names from apis.json.

## File layout

```
apps/ouroboros/
  js/store.js               ← backend abstraction (this contract)
  js/players.js             ← current player + known-player list (uses the store)
  js/ui/storage-screen.js   ← board-list rendering, pick/test/remove handlers
  js/main.js                ← creates the store, reloads scores/players on a switch
  css/storage.css           ← .board-list, .board-row, .firebase-status
  index.html                ← storage-screen markup
  tests/unit/store.test.js  ← registry + backend tests (fake lucidos, fake localStorage)
  knowhow/
    storage-backends.md     ← this doc
```

## js/store.js public API

`createStore({ lucidos, storage })` builds the store. `lucidos` is a function
returning the SDK object (read lazily, the SDK loads late); `storage` is a
SafeStorage (`js/core/safe-storage.js`), a localStorage wrapper that never throws.
In the browser it is `window.Ouroboros.createStore`; under Node it is
`require('js/store.js').createStore`.

```
store.getMode()          → 'local' | 'shared'
store.isShared()         → boolean
store.getActiveProxy()   → string | null  (e.g. 'snake-storage-familien')
store.getActiveLabel()   → string         (e.g. 'Familien' or 'Lokalt')

store.listBoards()       → [{ label, proxy, discovered }]   shared boards only
store.refreshBoards()    → re-reads apis.json for snake-storage-* proxies
store.addBoard({label, proxy})     hand-registered board (no UI; kept for old setups)
store.removeBoard(proxy)
store.setLocal()
store.setActiveBoard(proxy)
store.testBoard(proxy)   → throws on failure (read + throwaway write)

store.readHighscores()   → { highscores, dailyScores, dailyDate } | null
store.writeHighscores(board)
store.readPlayers()      → [name, ...]
store.writePlayers(names)
```

The rest of the app calls only these. A board switch clears the in-memory
scoreboard and re-fetches highscores and players, so a new, empty board never
inherits the previous board's scores.

### Storage of the board choice

The active selection, plus any hand-registered boards from older versions, are kept in the iframe's `localStorage`:

| key                       | value                                          |
| ------------------------- | ---------------------------------------------- |
| `snake-store-mode`        | `'local'` or `'shared'`                        |
| `snake-store-active`      | proxy name when mode is `'shared'`             |
| `snake-store-boards`      | JSON `[{label, proxy}, ...]`, hand-registered only |

The choice is per-device. The board list itself comes from the workspace's proxies, so every device in the workspace sees the same boards.

## Backends

### Local (`mode = 'local'`)

Reads/writes `artifacts/games/snake-highscores.json` and `artifacts/games/players.json` via `lucidos.data.read/write`. Same behavior the app had before any of this existed. Default mode.

### Shared (`mode = 'shared'`, `activeProxy = '<name>'`)

All reads/writes go through `lucidos.proxy(name).fetch(path)`. The proxy entry in `data/config/apis.json` rewrites the request to a Firebase Realtime Database URL and (optionally) attaches an auth token from the secret store.

Paths the app uses:

| path                           | method | purpose                              |
| ------------------------------ | ------ | ------------------------------------ |
| `/snake/highscores.json`       | `GET`  | load highscores doc                  |
| `/snake/highscores.json`       | `PUT`  | overwrite highscores doc             |
| `/snake/players.json`          | `GET`  | load players list                    |
| `/snake/players.json`          | `PUT`  | overwrite players list               |
| `/snake/_probe.json`           | `PUT`+`DELETE` | connection test, after a `GET` of the highscores doc |

Highscores doc shape (matches local format exactly so callers don't branch):
```json
{
  "highscores": [{"name":"KENNETH","score":56,"date":"2026-02-15","replay":{...}}, ...],
  "dailyScores": [{"name":"KENNETH","score":16,"date":"2026-05-13","time":"13:31","replay":{...}}],
  "dailyDate": "2026-05-13"
}
```

Players doc shape (a bare array):
```json
["KENNETH","EMIL"]
```

## Proxy contract (data/config/apis.json)

A shared board is just a Lucidos proxy entry. Suggested naming: `snake-storage-<group>` (e.g. `snake-storage-familien`). Once the entry exists, the board appears in the app's 💾 screen; there is nothing to enter in the app.

Minimal, no auth (open RTDB rules — fine for low-stakes lists):
```json
"snake-storage-familien": {
  "base_url": "https://<your-project>-default-rtdb.firebaseio.com"
}
```

With a Firebase database secret as RTDB query-param auth:
```json
"snake-storage-familien": {
  "base_url": "https://<your-project>-default-rtdb.firebaseio.com",
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
- `apps/ouroboros/` (UI, js/store.js, knowhow)
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
| `400 Invalid data; couldn't parse JSON`  | RTDB requires `.json` suffix on every path — js/store.js does this; check you didn't add a custom path that drops it. |
| Highscores merge instead of replace      | RTDB `PUT` overwrites. If you ever need partial updates, switch to `PATCH`. |
| Two players race to save and lose scores | Pre-write read merge is in `addHighscore` — keep it. Concurrent writes within the same second can still drop a row; acceptable for a family game. |
