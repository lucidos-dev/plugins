const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore, HIGHSCORES_PATH } = require('../../js/store.js');
const { createSafeStorage } = require('../../js/core/safe-storage.js');
const { createPlayers } = require('../../js/players.js');

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return createSafeStorage(() => ({
    getItem: k => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: k => { delete data[k]; }
  }));
}

function fakeLucidos() {
  const files = {};
  const calls = [];
  return {
    files, calls,
    data: {
      read: async path => files[path] ?? null,
      write: async (path, body) => { files[path] = body; }
    },
    proxy: name => ({
      fetch: async (path, init = {}) => {
        calls.push({ name, path, method: init.method || 'GET' });
        return { ok: true, status: 200, text: async () => 'null' };
      }
    })
  };
}

test('a fresh store is local', () => {
  const store = createStore({ lucidos: fakeLucidos, storage: memoryStorage() });
  assert.equal(store.getMode(), 'local');
  assert.equal(store.isShared(), false);
  assert.equal(store.getActiveLabel(), 'Lokalt');
  assert.deepEqual(store.listBoards(), []);
});

test('the store still works when localStorage throws', () => {
  const broken = createSafeStorage(() => { throw new Error('SecurityError'); });
  const store = createStore({ lucidos: fakeLucidos, storage: broken });
  store.addBoard({ label: 'Familien', proxy: 'snake-storage-familien' });
  store.setActiveBoard('snake-storage-familien');
  assert.equal(store.isShared(), true);
});

test('local backend round-trips highscores through lucidos.data', async () => {
  const lucidos = fakeLucidos();
  const store = createStore({ lucidos: () => lucidos, storage: memoryStorage() });
  assert.equal(await store.readHighscores(), null);
  await store.writeHighscores({ highscores: [1] });
  assert.deepEqual(JSON.parse(lucidos.files[HIGHSCORES_PATH]), { highscores: [1] });
  assert.deepEqual(await store.readHighscores(), { highscores: [1] });
});

test('addBoard validates label and proxy name', () => {
  const store = createStore({ lucidos: fakeLucidos, storage: memoryStorage() });
  assert.throws(() => store.addBoard({ label: '', proxy: 'x' }), /Etikett/);
  assert.throws(() => store.addBoard({ label: 'A', proxy: '' }), /Proxy-navn kreves/);
  assert.throws(() => store.addBoard({ label: 'A', proxy: 'bad name!' }), /bokstaver/);
  store.addBoard({ label: 'A', proxy: 'ok-name' });
  assert.throws(() => store.addBoard({ label: 'B', proxy: 'ok-name' }), /finnes allerede/);
});

test('the active shared board survives a reload', () => {
  const storage = memoryStorage();
  const first = createStore({ lucidos: fakeLucidos, storage });
  first.addBoard({ label: 'Jobb', proxy: 'snake-storage-jobb' });
  first.setActiveBoard('snake-storage-jobb');

  const second = createStore({ lucidos: fakeLucidos, storage });
  assert.equal(second.getMode(), 'shared');
  assert.equal(second.getActiveProxy(), 'snake-storage-jobb');
  assert.equal(second.getActiveLabel(), 'Jobb');
});

test('removing the active board falls back to local', () => {
  const store = createStore({ lucidos: fakeLucidos, storage: memoryStorage() });
  store.addBoard({ label: 'A', proxy: 'a' });
  store.setActiveBoard('a');
  store.removeBoard('a');
  assert.equal(store.getMode(), 'local');
  assert.deepEqual(store.listBoards(), []);
});

test('shared backend reads through the proxy and maps "null" to null', async () => {
  const lucidos = fakeLucidos();
  const store = createStore({ lucidos: () => lucidos, storage: memoryStorage() });
  store.addBoard({ label: 'A', proxy: 'a' });
  store.setActiveBoard('a');
  assert.equal(await store.readHighscores(), null);
  assert.deepEqual(await store.readPlayers(), []);
  assert.deepEqual(lucidos.calls.map(c => c.path), ['/snake/highscores.json', '/snake/players.json']);
});

test('players: setCurrent normalizes, remembers and adds to the known list', async () => {
  const written = [];
  const storage = memoryStorage();
  const players = createPlayers({ store: { readPlayers: async () => ['ANNA'], writePlayers: async l => written.push([...l]) }, storage });
  await players.load();
  assert.equal(players.setCurrent('  kenneth '), 'KENNETH');
  assert.equal(players.current, 'KENNETH');
  assert.equal(players.saved(), 'KENNETH');
  assert.deepEqual(players.list(), ['ANNA', 'KENNETH']);
  assert.deepEqual(written, [['ANNA', 'KENNETH']]);
});

test('players: a blank name is anonymous and never listed', async () => {
  const players = createPlayers({ store: { readPlayers: async () => [], writePlayers: async () => {} }, storage: memoryStorage() });
  assert.equal(players.setCurrent('   '), 'ANONYM');
  assert.deepEqual(players.list(), []);
});

// ===== Board discovery from apis.json =====
const { labelForProxy, boardsFromApis, APIS_PATH } = require('../../js/store.js');

test('labelForProxy turns the proxy name into a friendly label', () => {
  assert.equal(labelForProxy('snake-storage-familien'), 'Familien');
  assert.equal(labelForProxy('snake-storage-jobb_gjeng'), 'Jobb gjeng');
  assert.equal(labelForProxy('something-else'), 'something-else');
});

test('boardsFromApis picks only snake-storage-* entries, in both apis.json shapes', () => {
  const byKey = { binance: {}, 'snake-storage-familien': {}, 'snake-storage-jobb': {}, 'snake-storagex': {} };
  assert.deepEqual(boardsFromApis(byKey).map(b => b.proxy), ['snake-storage-familien', 'snake-storage-jobb']);
  const asList = [{ name: 'openai' }, { name: 'snake-storage-venner' }];
  assert.deepEqual(boardsFromApis(asList), [{ label: 'Venner', proxy: 'snake-storage-venner', discovered: true }]);
});

test('refreshBoards lists discovered boards before hand-registered ones, without duplicates', async () => {
  const lucidos = fakeLucidos();
  lucidos.files[APIS_PATH] = JSON.stringify({ 'snake-storage-familien': { base_url: 'https://x' }, other: {} });
  const store = createStore({ lucidos: () => lucidos, storage: memoryStorage() });
  store.addBoard({ label: 'Gammel', proxy: 'old-board' });
  store.addBoard({ label: 'Dupe', proxy: 'snake-storage-dupe' });
  lucidos.files[APIS_PATH] = JSON.stringify({ 'snake-storage-familien': {}, 'snake-storage-dupe': {} });
  const list = await store.refreshBoards();
  assert.deepEqual(list.map(b => [b.proxy, b.discovered]), [
    ['snake-storage-dupe', true], ['snake-storage-familien', true], ['old-board', false]
  ]);
  assert.equal(JSON.stringify(list).includes('https://'), false, 'no URLs kept');
});

test('a discovered board can be picked, and survives a reload before discovery runs', async () => {
  const lucidos = fakeLucidos();
  lucidos.files[APIS_PATH] = JSON.stringify({ 'snake-storage-familien': {} });
  const storage = memoryStorage();
  const store = createStore({ lucidos: () => lucidos, storage });
  await store.refreshBoards();
  store.setActiveBoard('snake-storage-familien');
  assert.equal(store.getActiveLabel(), 'Familien');

  const again = createStore({ lucidos: () => lucidos, storage });
  assert.equal(again.getMode(), 'shared');
  assert.equal(again.getActiveLabel(), 'Familien');
});

test('refreshBoards survives an unreadable apis.json', async () => {
  const lucidos = fakeLucidos();
  lucidos.data.read = async () => { throw new Error('403'); };
  const store = createStore({ lucidos: () => lucidos, storage: memoryStorage() });
  const warn = console.warn; console.warn = () => {};
  try { assert.deepEqual(await store.refreshBoards(), []); } finally { console.warn = warn; }
});
