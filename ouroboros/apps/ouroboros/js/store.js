// Ouroboros: storage backends for highscores and players.
//
// Backends:
//   - 'local'  → reads/writes to the local Lucidos workspace via lucidos.data.
//                Highscores stay private to this user.
//   - 'shared' → reads/writes through a Lucidos proxy entry (e.g. `snake-storage-family`).
//                The proxy points at a Firebase Realtime Database (RTDB) the
//                user controls. Anyone whose workspace has the same proxy
//                wired up sees the same scoreboard.
//
// A user can be in MULTIPLE shared scoreboards (family, work, friends, …).
// Each board is a (friendly label, proxy name) pair. Boards come from two
// places:
//   - Discovered: every proxy in data/config/apis.json whose name starts with
//     `snake-storage-` is a board. Setting up the proxy is all it takes; the
//     label comes from the rest of the name ('snake-storage-familien' → 'Familien').
//   - Registered: boards added by hand on this device (older versions had a
//     form for it). Kept so existing setups keep working.
// The active board's proxy is what `lucidos.proxy(<name>).fetch(...)` is
// called against. Local is always available as the implicit "private" board.
//
// What lives in localStorage:
//   snake-store-mode    → 'local' | 'shared'
//   snake-store-active  → proxy name of the active shared board, e.g. 'snake-storage-family'
//   snake-store-boards  → JSON array of hand-registered { label, proxy } pairs
// Which scoreboard a device is looking at is a per-device setting, so it stays
// in localStorage rather than lucidos.data (workspace-wide). In frames where
// localStorage is unavailable, the store falls back to 'local' mode and still
// works.
//
// What does NOT live in localStorage or the iframe's state:
//   The auth token. It lives in the engine credential store and is applied
//   server-side by lucidos.proxy(<name>).fetch(...). Discovery reads only the
//   proxy names out of apis.json and keeps nothing else.
//
// RTDB layout (rooted at the proxy's base_url):
//   /snake/highscores.json  → { highscores, dailyScores, dailyDate }
//   /snake/players.json     → string[] of known player names
//
// Setup: ask Lucidos to add a proxy entry like `snake-storage-family` to
// data/config/apis.json (see apps/ouroboros/knowhow/storage-backends.md
// for the snippet). The board then shows up in the storage screen by itself.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.Ouroboros = root.Ouroboros || {}).createStore = factory().createStore;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LS_MODE   = 'snake-store-mode';     // 'local' | 'shared'
  const LS_ACTIVE = 'snake-store-active';   // proxy name of active shared board
  const LS_BOARDS = 'snake-store-boards';   // JSON: [{label, proxy}, ...]

  const HIGHSCORES_PATH = 'artifacts/games/snake-highscores.json';
  const PLAYERS_PATH    = 'artifacts/games/players.json';
  const LOCAL_LABEL     = 'Lokalt';
  const APIS_PATH       = 'config/apis.json';
  const BOARD_PROXY_RE  = /^snake-storage-([a-z0-9_-]+)$/i;

  // 'snake-storage-familien' → 'Familien', 'snake-storage-jobb_gjeng' → 'Jobb gjeng'
  function labelForProxy(proxy) {
    const m = BOARD_PROXY_RE.exec(proxy || '');
    if (!m) return proxy;
    const words = m[1].replace(/[-_]+/g, ' ').trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  // Board proxies named in an apis.json document (object keyed by name, or a
  // list of entries with a `name`).
  function boardsFromApis(apis) {
    const names = Array.isArray(apis) ? apis.map(a => a && a.name) : Object.keys(apis || {});
    return names
      .filter(n => typeof n === 'string' && BOARD_PROXY_RE.test(n))
      .sort()
      .map(proxy => ({ label: labelForProxy(proxy), proxy, discovered: true }));
  }

  // deps.lucidos: () => the lucidos SDK object (read lazily; the SDK may load late)
  // deps.storage: a SafeStorage-shaped { get, set, remove }
  function createStore({ lucidos, storage }) {

    // ===== Local backend (lucidos.data) =====
    const localBackend = {
      name: 'local',
      proxy: null,
      label: LOCAL_LABEL,
      async readHighscores() {
        try {
          const data = await lucidos().data.read(HIGHSCORES_PATH);
          return data ? JSON.parse(data) : null;
        } catch (e) { return null; }
      },
      async writeHighscores(payload) {
        await lucidos().data.write(HIGHSCORES_PATH, JSON.stringify(payload, null, 2));
      },
      async readPlayers() {
        try {
          const data = await lucidos().data.read(PLAYERS_PATH);
          return data ? JSON.parse(data) : [];
        } catch (e) { return []; }
      },
      async writePlayers(players) {
        await lucidos().data.write(PLAYERS_PATH, JSON.stringify(players, null, 2));
      }
    };

    // ===== Shared backend (Lucidos proxy → Firebase RTDB) =====
    function makeSharedBackend(proxyName, label) {
      async function rtdb(method, path, body) {
        const init = { method, headers: { 'Content-Type': 'application/json' } };
        if (body !== undefined) init.body = JSON.stringify(body);
        const res = await lucidos().proxy(proxyName).fetch(`/${path}.json`, init);
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const hint = (res.status === 404 || res.status === 502)
            ? ` (proxy \`${proxyName}\` not configured — be Lucidos legge den til i data/config/apis.json)`
            : '';
          throw new Error(`Delt lager (${label}) ${method} /${path}: ${res.status}${hint} ${text}`.trim());
        }
        const text = await res.text();
        if (!text || text === 'null') return method === 'GET' ? null : undefined;
        return JSON.parse(text);
      }

      return {
        name: 'shared',
        proxy: proxyName,
        label,
        async readHighscores()   { return await rtdb('GET', 'snake/highscores'); },
        async writeHighscores(p) { await rtdb('PUT', 'snake/highscores', p); },
        async readPlayers()      { return (await rtdb('GET', 'snake/players')) || []; },
        async writePlayers(p)    { await rtdb('PUT', 'snake/players', p); }
      };
    }

    // ===== Boards registry =====
    function loadBoards() {
      try {
        const arr = JSON.parse(storage.get(LS_BOARDS) || '[]');
        return Array.isArray(arr) ? arr.filter(b => b && b.proxy && b.label) : [];
      } catch (e) { return []; }
    }

    function saveBoards(list) {
      storage.set(LS_BOARDS, JSON.stringify(list));
    }

    let boards = loadBoards();      // registered by hand on this device
    let discovered = [];            // found in apis.json by refreshBoards()
    let mode = 'local';
    let activeProxy = null;
    let backend = localBackend;

    function useLocal() {
      mode = 'local';
      activeProxy = null;
      backend = localBackend;
    }

    function useShared(board) {
      mode = 'shared';
      activeProxy = board.proxy;
      backend = makeSharedBackend(board.proxy, board.label);
    }

    // Every board, discovered first; a hand-registered duplicate is dropped.
    function allBoards() {
      const seen = new Set(discovered.map(b => b.proxy));
      return [...discovered, ...boards.filter(b => !seen.has(b.proxy)).map(b => ({ ...b, discovered: false }))];
    }

    function findBoard(proxyName) {
      const known = allBoards().find(b => b.proxy === proxyName);
      if (known) return known;
      // A board proxy we have not discovered yet (discovery is async)
      return BOARD_PROXY_RE.test(proxyName || '') ? { label: labelForProxy(proxyName), proxy: proxyName, discovered: true } : null;
    }

    // Restore the last choice on this device
    const saved = findBoard(storage.get(LS_ACTIVE));
    if (storage.get(LS_MODE) === 'shared' && saved) useShared(saved);

    return {
      getMode()        { return mode; },
      isShared()       { return mode === 'shared'; },
      getActiveProxy() { return activeProxy; },
      getActiveLabel() { return backend.label; },
      // [{ label, proxy, discovered }]. Discovered boards cannot be removed here.
      listBoards()     { return allBoards(); },

      // Look up the workspace's snake-storage-* proxies. Never throws: when
      // apis.json cannot be read, only hand-registered boards are listed.
      async refreshBoards() {
        try {
          const raw = await lucidos().data.read(APIS_PATH);
          discovered = raw ? boardsFromApis(JSON.parse(raw)) : [];
        } catch (e) {
          console.warn('Could not read the proxy list', e);
          discovered = [];
        }
        return allBoards();
      },

      setLocal() {
        storage.set(LS_MODE, 'local');
        storage.remove(LS_ACTIVE);
        useLocal();
      },

      // Activate one of the registered shared boards by proxy name.
      setActiveBoard(proxyName) {
        const board = findBoard(proxyName);
        if (!board) throw new Error(`Ukjent toppliste: ${proxyName}`);
        storage.set(LS_MODE, 'shared');
        storage.set(LS_ACTIVE, proxyName);
        useShared(board);
      },

      // Add a new shared board to the registry. Does NOT activate it.
      addBoard({ label, proxy }) {
        const cleanLabel = (label || '').trim();
        const cleanProxy = (proxy || '').trim();
        if (!cleanLabel) throw new Error('Etikett kreves');
        if (!cleanProxy) throw new Error('Proxy-navn kreves');
        if (!/^[a-z0-9_-]+$/i.test(cleanProxy)) {
          throw new Error('Proxy-navn kan bare ha bokstaver, tall, _ og -');
        }
        if (allBoards().some(b => b.proxy === cleanProxy)) {
          throw new Error(`Toppliste \`${cleanProxy}\` finnes allerede`);
        }
        boards.push({ label: cleanLabel, proxy: cleanProxy });
        saveBoards(boards);
      },

      removeBoard(proxyName) {
        boards = boards.filter(b => b.proxy !== proxyName);
        saveBoards(boards);
        if (activeProxy === proxyName) this.setLocal();
      },

      // Verify a proxy is reachable + writable. Reads /snake/highscores and
      // PUTs/DELETEs a probe at /snake/_probe so we exercise both perms.
      async testBoard(proxyName) {
        const probePath = '/snake/_probe.json';
        const proxy = lucidos().proxy(proxyName);
        let res = await proxy.fetch('/snake/highscores.json');
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const hint = (res.status === 404 || res.status === 502)
            ? `\n\nProxy \`${proxyName}\` finnes nok ikke i data/config/apis.json. Be Lucidos sette den opp.`
            : '';
          throw new Error(`Lesing feilet: ${res.status} ${text}${hint}`.trim());
        }
        res = await proxy.fetch(probePath, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ at: Date.now() })
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`Skriving feilet: ${res.status} ${text}`);
        }
        proxy.fetch(probePath, { method: 'DELETE' }).catch(() => {});
        return true;
      },

      readHighscores()   { return backend.readHighscores(); },
      writeHighscores(p) { return backend.writeHighscores(p); },
      readPlayers()      { return backend.readPlayers(); },
      writePlayers(p)    { return backend.writePlayers(p); }
    };
  }

  return { createStore, labelForProxy, boardsFromApis, HIGHSCORES_PATH, PLAYERS_PATH, APIS_PATH };
});
