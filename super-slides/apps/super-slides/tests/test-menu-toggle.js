/* ══════════════════════════════════════════════════════
   Menu toggle (FAB) — regression tests
   ══════════════════════════════════════════════════════
   Models the document-delegated click behaviour for the
   mobile FAB / menu button. The bug we keep regressing:
   two separate document `click` listeners — one toggles
   the menu open, the next blanket-closes it — both fire
   on the same event. `stopPropagation()` does NOT prevent
   sibling listeners on the same element from running, so
   the menu opens and instantly closes again.

   The fix is ONE listener that:
     - clicks on #menuBtn       → toggle, return
     - clicks inside dropdown    → ignore (let item handler run)
     - clicks elsewhere          → close
   ══════════════════════════════════════════════════════ */

suite('Menu toggle (FAB)', (t) => {
  let menuBtn, menuDropdown, menuItems, host;

  function attachCorrectHandler() {
    document.addEventListener('click', handler);
  }
  function handler(e) {
    if (e.target.closest('#menuBtn')) {
      menuDropdown.classList.toggle('open');
      return;
    }
    if (e.target.closest('#menuDropdown')) return;
    menuDropdown.classList.remove('open');
  }

  function attachBuggyHandler() {
    document.addEventListener('click', buggyToggle);
    document.addEventListener('click', buggyClose);
  }
  function buggyToggle(e) {
    if (e.target.closest('#menuBtn')) {
      e.stopPropagation();
      menuDropdown.classList.toggle('open');
    }
  }
  function buggyClose() {
    menuDropdown.classList.remove('open');
  }

  function detachAll() {
    document.removeEventListener('click', handler);
    document.removeEventListener('click', buggyToggle);
    document.removeEventListener('click', buggyClose);
  }

  t.beforeEach(() => {
    host = document.createElement('div');
    host.innerHTML = `
      <button id="menuBtn">≡</button>
      <div id="menuDropdown">
        <div class="menu-item" id="item1">Pres A</div>
        <div class="menu-item" id="item2">Pres B</div>
      </div>
      <div id="elsewhere">background</div>
    `;
    document.body.appendChild(host);
    menuBtn = document.getElementById('menuBtn');
    menuDropdown = document.getElementById('menuDropdown');
    menuItems = document.getElementById('item1');
  });

  t.afterEach(() => {
    detachAll();
    host.remove();
  });

  function click(el) {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }

  /* ── Regression: the buggy two-listener pattern ──── */

  t.test('REGRESSION: two-listener pattern (toggle + close) leaves menu CLOSED after btn click', () => {
    attachBuggyHandler();
    assert(!menuDropdown.classList.contains('open'), 'starts closed');
    click(menuBtn);
    // The bug: stopPropagation does NOT stop sibling listeners on document,
    // so close-listener fires and reverts the open. Menu ends up CLOSED.
    assert(!menuDropdown.classList.contains('open'),
      'buggy pattern reproduces — menu is closed despite tap on FAB');
  });

  /* ── Correct behaviour ───────────────────────────── */

  t.test('starts closed', () => {
    attachCorrectHandler();
    assert(!menuDropdown.classList.contains('open'));
  });

  t.test('click on FAB opens the menu', () => {
    attachCorrectHandler();
    click(menuBtn);
    assert(menuDropdown.classList.contains('open'), 'menu should be open');
  });

  t.test('second click on FAB closes the menu (toggle)', () => {
    attachCorrectHandler();
    click(menuBtn);
    click(menuBtn);
    assert(!menuDropdown.classList.contains('open'), 'menu should be closed');
  });

  t.test('click outside closes the menu', () => {
    attachCorrectHandler();
    click(menuBtn);
    assert(menuDropdown.classList.contains('open'), 'open before outside click');
    click(document.getElementById('elsewhere'));
    assert(!menuDropdown.classList.contains('open'), 'closed after outside click');
  });

  t.test('click on menu item does NOT immediately close (item handler decides)', () => {
    attachCorrectHandler();
    click(menuBtn);
    assert(menuDropdown.classList.contains('open'), 'open before item click');
    click(menuItems);
    // Our document-delegated handler must leave it open — only the item's own
    // dedicated handler (in engine.js) closes it after acting.
    assert(menuDropdown.classList.contains('open'),
      'document handler must not close on item click');
  });

  t.test('rapid toggle is reliable (open, close, open, close)', () => {
    attachCorrectHandler();
    click(menuBtn); assert(menuDropdown.classList.contains('open'), 'open 1');
    click(menuBtn); assert(!menuDropdown.classList.contains('open'), 'close 1');
    click(menuBtn); assert(menuDropdown.classList.contains('open'), 'open 2');
    click(menuBtn); assert(!menuDropdown.classList.contains('open'), 'close 2');
  });

  t.test('synthetic click after touchend on the FAB still toggles correctly', () => {
    // iOS dispatches a click after touchend. With document delegation there's
    // no race — both should reach the same handler and produce the same result.
    attachCorrectHandler();
    menuBtn.dispatchEvent(new Event('touchend', { bubbles: true }));
    click(menuBtn); // synthetic click iOS would fire
    assert(menuDropdown.classList.contains('open'), 'touch+click opens menu');
  });

  /* ── Halo-tap regression ──
     The mobile FAB has an invisible `padding`-based halo on `.menu-wrapper`
     so near-misses still hit. But if the click handler matches ONLY `#menuBtn`,
     a tap on the halo (where e.target IS the wrapper, not the button) falls
     through to the "outside" branch and closes the menu. Felt unreliable.
     Fix: handler must also accept `.menu-wrapper`. */
  t.test('REGRESSION: tap on FAB halo (wrapper) opens menu', () => {
    // Re-create host with a wrapper, like the real layout
    host.remove();
    host = document.createElement('div');
    host.innerHTML = `
      <div class="menu-wrapper" id="wrapper" style="padding:20px">
        <button id="menuBtn">≡</button>
        <div id="menuDropdown">
          <div class="menu-item" id="item1">Pres A</div>
        </div>
      </div>
      <div id="elsewhere">background</div>
    `;
    document.body.appendChild(host);
    menuBtn = document.getElementById('menuBtn');
    menuDropdown = document.getElementById('menuDropdown');
    const wrapper = document.getElementById('wrapper');

    // Use a halo-aware handler (matches the engine.js fix)
    function haloHandler(e) {
      if (e.target.closest('#menuBtn, .menu-wrapper')) {
        menuDropdown.classList.toggle('open');
        return;
      }
      if (e.target.closest('#menuDropdown')) return;
      menuDropdown.classList.remove('open');
    }
    document.addEventListener('click', haloHandler);

    // Tap the wrapper halo (e.target === wrapper, NOT the button)
    click(wrapper);
    assert(menuDropdown.classList.contains('open'),
      'halo tap must open menu (regression: was closing because target.closest(#menuBtn) was null)');

    document.removeEventListener('click', haloHandler);
  });
});
