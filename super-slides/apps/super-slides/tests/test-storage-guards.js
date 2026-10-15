/* ══════════════════════════════════════════════════════
   Storage guards — regression coverage for the opaque-origin
   startup crash
   ══════════════════════════════════════════════════════
   The app runs in an iframe. Some hosts give it an opaque origin, where
   `localStorage` throws SecurityError on every access, not just on a
   missing key. Before this fix, engine.js's startup restore
   (`localStorage.getItem('ss-pres')`, etc.) had no try/catch, so the
   throw aborted initEngine() and the app never rendered — the user saw
   "Engine Error — The operation is insecure." and nothing else.

   These tests install a `localStorage` that throws exactly that error,
   then run the real startup code and assert it never reaches for it:
   workspace state lives in SS.appState, and the per-device presenter or
   remote mode lives in lucidos.storage.local (device-mode.js).
   ══════════════════════════════════════════════════════ */

// localStorage is a configurable accessor property on window, so we can
// swap its getter for one that throws — the same failure mode as an
// opaque-origin iframe — and restore the original afterwards.
function withThrowingLocalStorage(fn) {
  const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get() { throw new DOMException('The operation is insecure.', 'SecurityError'); },
  });
  try {
    return fn();
  } finally {
    Object.defineProperty(window, 'localStorage', original);
  }
}

/* ── engine.js: the actual blocker ──────────────────────
   Drives the real, unmodified SS.initEngine() end to end. */
suite('Storage guards — engine.js startup restore', (t) => {
  let host;

  t.beforeEach(() => {
    // Mirrors index.html's structure closely enough for initEngine() to
    // find every element it looks up by id.
    host = document.createElement('div');
    host.innerHTML = `
      <div class="menu-wrapper">
        <button class="menu-btn" id="menuBtn"></button>
        <div class="menu-dropdown" id="menuDropdown">
          <div class="menu-items" id="menuItems"></div>
        </div>
      </div>
      <div id="app"></div>
    `;
    document.body.appendChild(host);
    window._superSlidesRegistry = [mockPresentation('pres-a', 3), mockPresentation('pres-b', 3)];
  });

  t.afterEach(() => {
    host.remove();
    delete window._superSlidesRegistry;
    delete SS._currentPres;
  });

  t.test('initEngine() survives a SecurityError and renders sane defaults', () => {
    withThrowingLocalStorage(() => {
      SS.initEngine();
    });

    const active = host.querySelector('#app .slide.active');
    assert(active, 'a slide rendered instead of the engine dying at startup');
    assertEqual(SS._currentPres.id, 'pres-a', 'defaulted to the first registered presentation');
    assertEqual(active.dataset.slide, '0', 'defaulted to slide 0');
  });
});

/* ── device-mode.js: presenter vs remote, per device ──
   `ss-mode` is a per-device fact, so it lives in lucidos.storage.local, the
   SDK's per-device store for an app frame. The frame's own localStorage is
   never touched: these tests make it throw, and nothing catches that. */

// Like withThrowingLocalStorage, but for an async body.
async function withThrowingLocalStorageAsync(fn) {
  const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get() { throw new DOMException('The operation is insecure.', 'SecurityError'); },
  });
  try {
    return await fn();
  } finally {
    Object.defineProperty(window, 'localStorage', original);
  }
}

// The shape of lucidos.storage: a read sees nothing until the host has primed
// this app's values, which is when `ready` resolves.
function fakeDeviceStorage(stored) {
  const mirror = new Map();
  let prime;
  const ready = new Promise((resolve) => {
    prime = () => {
      Object.entries(stored || {}).forEach(([k, v]) => mirror.set(k, v));
      resolve();
    };
  });
  return {
    prime,
    storage: {
      ready,
      local: {
        getItem: (k) => (mirror.has(k) ? mirror.get(k) : null),
        setItem: (k, v) => { mirror.set(k, String(v)); },
        removeItem: (k) => { mirror.delete(k); },
      },
    },
  };
}

asuite('Storage guards — device mode in lucidos.storage.local', (t) => {
  let savedLucidos;
  t.beforeEach(() => { savedLucidos = window.lucidos; });
  t.afterEach(() => { window.lucidos = savedLucidos; });

  t.test('restore() waits for lucidos.storage.ready, then reads the saved remote mode', async () => {
    const fake = fakeDeviceStorage({ 'ss-mode': 'remote' });
    window.lucidos = { storage: fake.storage };
    await withThrowingLocalStorageAsync(async () => {
      const restoring = SS.deviceMode.restore();
      await Promise.resolve();
      fake.prime();
      assertEqual(await restoring, 'remote', 'the mode saved on this device');
    });
  });

  t.test('restore() starts in presenter mode when this device saved nothing', async () => {
    const fake = fakeDeviceStorage({});
    fake.prime();
    window.lucidos = { storage: fake.storage };
    assertEqual(await SS.deviceMode.restore(), 'presenter', 'the default mode');
  });

  t.test('remember() writes lucidos.storage.local, never the frame localStorage', async () => {
    const fake = fakeDeviceStorage({});
    fake.prime();
    window.lucidos = { storage: fake.storage };
    await withThrowingLocalStorageAsync(async () => {
      SS.deviceMode.remember('remote');
    });
    assertEqual(fake.storage.local.getItem('ss-mode'), 'remote', 'stored per device');
  });
});
