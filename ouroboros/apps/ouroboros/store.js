// Snake Game — Storage Backend Abstraction
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
// Each board is a (friendly label, proxy name) pair persisted in localStorage.
// The active board's proxy is what `lucidos.proxy(<name>).fetch(...)` is
// called against. Local is always available as the implicit "private" board.
//
// What lives in localStorage:
//   snake-store-mode    → 'local' | 'shared'
//   snake-store-active  → proxy name of the active shared board, e.g. 'snake-storage-family'
//   snake-store-boards  → JSON array of { label, proxy } pairs
// What does NOT live in localStorage or the iframe:
//   The Firebase URL or auth token — those live in data/config/apis.json
//   (URL) and the engine credential store (token), reached only via
//   lucidos.proxy(<name>).fetch(...). The iframe never sees either.
//
// RTDB layout (rooted at the proxy's base_url):
//   /snake/highscores.json  → { highscores, dailyScores, dailyDate }
//   /snake/players.json     → string[] of known player names
//
// Setup: ask Lucidos to add a proxy entry like `snake-storage-family` to
// data/config/apis.json (see apps/snake-game/knowhow/storage-backends.md
// for the snippet), then add the board in the storage screen.
(function () {
  const LS_MODE         = 'snake-store-mode';     // 'local' | 'shared'
  const LS_ACTIVE       = 'snake-store-active';   // proxy name of active shared board
  const LS_BOARDS       = 'snake-store-boards';   // JSON: [{label, proxy}, ...]

  const HIGHSCORES_PATH = 'artifacts/games/snake-highscores.json';
  const PLAYERS_PATH    = 'artifacts/games/players.json';

  // ===== Local backend (lucidos.data) =====
  const localBackend = {
    name: 'local',
    proxy: null,
    label: 'Lokalt',
    async readHighscores() {
      try {
        const data = await window.lucidos.data.read(HIGHSCORES_PATH);
        return data ? JSON.parse(data) : null;
      } catch (e) { return null; }
    },
    async writeHighscores(payload) {
      await window.lucidos.data.write(HIGHSCORES_PATH, JSON.stringify(payload, null, 2));
    },
    async readPlayers() {
      try {
        const data = await window.lucidos.data.read(PLAYERS_PATH);
        return data ? JSON.parse(data) : [];
      } catch (e) { return []; }
    },
    async writePlayers(players) {
      await window.lucidos.data.write(PLAYERS_PATH, JSON.stringify(players, null, 2));
    }
  };

  // ===== Shared backend factory (Lucidos proxy → Firebase RTDB) =====
  function makeSharedBackend(proxyName, label) {
    async function rtdb(method, path, body) {
      const init = { method, headers: { 'Content-Type': 'application/json' } };
      if (body !== undefined) init.body = JSON.stringify(body);
      const res = await window.lucidos.proxy(proxyName).fetch(`/${path}.json`, init);
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
      label: label,
      async readHighscores()   { return await rtdb('GET',  'snake/highscores'); },
      async writeHighscores(p) { await rtdb('PUT', 'snake/highscores', p); },
      async readPlayers()      { return (await rtdb('GET', 'snake/players')) || []; },
      async writePlayers(p)    { await rtdb('PUT', 'snake/players', p); }
    };
  }

  // ===== Boards registry =====
  function loadBoards() {
    try {
      const raw = localStorage.getItem(LS_BOARDS);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter(b => b && b.proxy && b.label) : [];
    } catch (e) { return []; }
  }

  function saveBoards(boards) {
    localStorage.setItem(LS_BOARDS, JSON.stringify(boards));
  }

  // ===== Public Store API =====
  const Store = {
    _backend: null,
    _mode: 'local',
    _activeProxy: null,
    _boards: [],

    init() {
      this._boards = loadBoards();
      const mode = localStorage.getItem(LS_MODE) || 'local';
      const active = localStorage.getItem(LS_ACTIVE) || '';
      const board = this._boards.find(b => b.proxy === active);
      if (mode === 'shared' && board) {
        this._mode = 'shared';
        this._activeProxy = board.proxy;
        this._backend = makeSharedBackend(board.proxy, board.label);
      } else {
        this._mode = 'local';
        this._activeProxy = null;
        this._backend = localBackend;
      }
      return this;
    },

    getMode()        { return this._mode; },
    isShared()       { return this._mode === 'shared'; },
    getActiveProxy() { return this._activeProxy; },
    getActiveLabel() { return this._backend ? this._backend.label : 'Lokalt'; },
    listBoards()     { return this._boards.slice(); },

    // Activate local mode.
    setLocal() {
      localStorage.setItem(LS_MODE, 'local');
      localStorage.removeItem(LS_ACTIVE);
      this._mode = 'local';
      this._activeProxy = null;
      this._backend = localBackend;
    },

    // Activate one of the registered shared boards by proxy name.
    setActiveBoard(proxyName) {
      const board = this._boards.find(b => b.proxy === proxyName);
      if (!board) throw new Error(`Ukjent toppliste: ${proxyName}`);
      localStorage.setItem(LS_MODE, 'shared');
      localStorage.setItem(LS_ACTIVE, proxyName);
      this._mode = 'shared';
      this._activeProxy = proxyName;
      this._backend = makeSharedBackend(board.proxy, board.label);
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
      if (this._boards.some(b => b.proxy === cleanProxy)) {
        throw new Error(`Toppliste \`${cleanProxy}\` finnes allerede`);
      }
      this._boards.push({ label: cleanLabel, proxy: cleanProxy });
      saveBoards(this._boards);
    },

    removeBoard(proxyName) {
      this._boards = this._boards.filter(b => b.proxy !== proxyName);
      saveBoards(this._boards);
      if (this._activeProxy === proxyName) {
        this.setLocal();
      }
    },

    // Verify a proxy is reachable + writable. Reads /snake/highscores and
    // PUTs/DELETEs a probe at /snake/_probe so we exercise both perms.
    async testBoard(proxyName) {
      const probePath = '/snake/_probe.json';
      let res = await window.lucidos.proxy(proxyName).fetch('/snake/highscores.json');
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const hint = (res.status === 404 || res.status === 502)
          ? `\n\nProxy \`${proxyName}\` finnes nok ikke i data/config/apis.json. Be Lucidos sette den opp.`
          : '';
        throw new Error(`Lesing feilet: ${res.status} ${text}${hint}`.trim());
      }
      res = await window.lucidos.proxy(proxyName).fetch(probePath, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ at: Date.now() })
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Skriving feilet: ${res.status} ${text}`);
      }
      window.lucidos.proxy(proxyName).fetch(probePath, { method: 'DELETE' }).catch(() => {});
      return true;
    },

    // Pass-through helpers used by script.js
    async readHighscores()   { return await this._backend.readHighscores(); },
    async writeHighscores(p) { return await this._backend.writeHighscores(p); },
    async readPlayers()      { return await this._backend.readPlayers(); },
    async writePlayers(p)    { return await this._backend.writePlayers(p); }
  };

  window.SnakeStore = Store;
})();
