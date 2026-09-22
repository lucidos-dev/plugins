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
   then run the real restore code and assert it degrades to "no
   remembered position" instead of propagating.
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

/* ── init.js:91 (mirrors the guarded read) ──────────────
   init.js is the app's top-level bootstrap script: it runs a full
   discover → load → init-engine → restore-mode pipeline the moment it
   loads and isn't structured for isolated re-import, so this reproduces
   its guarded read verbatim. Keep this in sync if that line changes. */
suite('Storage guards — init.js device-mode restore (mirrors init.js:91)', (t) => {
  function readSavedMode() {
    let savedMode = null;
    try { savedMode = localStorage.getItem('ss-mode'); } catch (e) {}
    return savedMode;
  }

  t.test('a SecurityError on read yields no saved mode instead of throwing', () => {
    let result;
    withThrowingLocalStorage(() => { result = readSavedMode(); });
    assertEqual(result, null, 'no crash, no remembered device mode');
  });
});

/* ── remote.js:31-32 (mirrors the guarded reads) ────────
   remote.js is the speaker-remote page's bootstrap script (only loaded by
   remote.html): it calls lucidos.sse.connect() and wires up its own DOM
   the moment it loads, so it can't be loaded standalone here either.
   Reproduces its guarded reads verbatim. Keep this in sync if they change. */
suite('Storage guards — remote.js saved position (mirrors remote.js:31-32)', (t) => {
  function ssGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function readSavedPosition() {
    return {
      presId: ssGet('ss-pres'),
      slide: parseInt(ssGet('ss-slide')) || 0,
    };
  }

  t.test('a SecurityError on read yields sane defaults instead of throwing', () => {
    let result;
    withThrowingLocalStorage(() => { result = readSavedPosition(); });
    assertEqual(result.presId, null, 'no remembered presentation id');
    assertEqual(result.slide, 0, 'defaults to slide 0');
  });
});
