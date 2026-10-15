const test = require('node:test');
const assert = require('node:assert/strict');
const { createSafeStorage, ready } = require('../../js/core/safe-storage.js');

// The shape of lucidos.storage: reads see nothing until the host has primed
// this app's values, which is when `ready` resolves.
function fakeLucidosStorage(stored = {}) {
  const mirror = new Map();
  let prime;
  const readyPromise = new Promise(resolve => {
    prime = () => { for (const [k, v] of Object.entries(stored)) mirror.set(k, v); resolve(); };
  });
  return {
    prime,
    storage: {
      ready: readyPromise,
      local: {
        getItem: k => (mirror.has(k) ? mirror.get(k) : null),
        setItem: (k, v) => { mirror.set(k, String(v)); },
        removeItem: k => { mirror.delete(k); }
      }
    }
  };
}

function withLucidos(lucidos, fn) {
  const saved = globalThis.lucidos;
  globalThis.lucidos = lucidos;
  return Promise.resolve(fn()).finally(() => { globalThis.lucidos = saved; });
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('by default it keeps values in lucidos.storage.local, per device', () => {
  const fake = fakeLucidosStorage();
  fake.prime();
  return withLucidos({ storage: fake.storage }, () => {
    const storage = createSafeStorage();
    storage.set('snake-player', 'ANNA');
    assert.equal(fake.storage.local.getItem('snake-player'), 'ANNA');
    assert.equal(storage.get('snake-player'), 'ANNA');
    storage.remove('snake-player');
    assert.equal(fake.storage.local.getItem('snake-player'), null);
  });
});

test('it never touches the frame\'s own localStorage, which throws in an app frame', () => {
  const fake = fakeLucidosStorage({ 'snake-player': 'ANNA' });
  fake.prime();
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new Error('the frame\'s localStorage was read'); }
  });
  return withLucidos({ storage: fake.storage }, () => {
    assert.equal(createSafeStorage().get('snake-player'), 'ANNA');
  }).finally(() => {
    if (saved) Object.defineProperty(globalThis, 'localStorage', saved);
    else delete globalThis.localStorage;
  });
});

test('ready() waits for lucidos.storage.ready, so the first read sees the saved player', async () => {
  const fake = fakeLucidosStorage({ 'snake-player': 'ANNA' });
  await withLucidos({ storage: fake.storage }, async () => {
    const storage = createSafeStorage();
    let settled = false;
    const waiting = ready().then(() => { settled = true; });
    await tick();
    assert.equal(settled, false, 'ready() resolved before the host primed the values');
    assert.equal(storage.get('snake-player'), null, 'a read before ready sees nothing stored');
    fake.prime();
    await waiting;
    assert.equal(storage.get('snake-player'), 'ANNA');
  });
});

test('ready() still resolves when the host cannot hand the values over, so the game starts', async () => {
  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    await withLucidos({ storage: { ready: Promise.reject(new Error('host refused')), local: {} } }, () => ready());
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.length, 1, 'the failure is logged, not hidden');
});
