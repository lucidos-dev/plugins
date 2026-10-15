/* ══════════════════════════════════════════════════════
   Controls — the app's own buttons follow the shared Lucidos UI
   ══════════════════════════════════════════════════════
   - A tooltip is `data-tooltip`, painted by the SDK. A browser `title`
     tooltip never shows on a phone and does not match the theme. A button
     that shows only a glyph also carries an `aria-label`.
   - Toasts go straight to lucidos.ui.toast.
   - A save in flight shows the shared `.mini-spinner`.
   - Every hover waits for a real pointer, so a tap leaves none behind.
   - The device's presenter or remote mode is kept in lucidos.storage.local.
   ══════════════════════════════════════════════════════ */

function assertTooltip(el, text, ariaLabel, what) {
  assert(el, `${what} exists`);
  assertEqual(el.getAttribute('title'), null, `${what} has no title tooltip`);
  assertEqual(el.getAttribute('data-tooltip'), text, `${what} data-tooltip`);
  assertEqual(el.getAttribute('aria-label'), ariaLabel, `${what} aria-label`);
}

async function waitFor(fn, what) {
  for (let i = 0; i < 100; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function fetchText(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.text();
}

async function fetchDoc(path) {
  return new DOMParser().parseFromString(await fetchText(path), 'text/html');
}

// Every rule whose selector names :hover, with the at-rule preludes around it.
function hoverRules(css) {
  const rules = [];
  const stack = [];
  let prelude = '';
  for (const ch of css.replace(/\/\*[\s\S]*?\*\//g, '')) {
    if (ch === '{') {
      const p = prelude.trim();
      if (!p.startsWith('@') && p.includes(':hover')) rules.push({ selector: p, within: stack.slice() });
      stack.push(p);
      prelude = '';
    } else if (ch === '}') {
      stack.pop();
      prelude = '';
    } else if (ch === ';') {
      prelude = '';
    } else {
      prelude += ch;
    }
  }
  return rules;
}

function hoverGated(rule) {
  return rule.within.some((p) => /^@media[^{]*\(\s*hover\s*:\s*hover\s*\)/.test(p));
}

asuite('Controls — remote mode', (t) => {
  t.test('the remote nav buttons use data-tooltip, with a name for each glyph button', () => {
    assertTooltip(document.getElementById('rmSlidePrev'), 'Prev slide', 'Prev slide', 'Prev slide');
    assertTooltip(document.getElementById('rmCardPrev'), 'Prev card', 'Prev card', 'Prev card');
    assertTooltip(document.getElementById('rmCardNext'), 'Next card', 'Next card', 'Next card');
    assertTooltip(document.getElementById('rmSlideNext'), 'Next slide', 'Next slide', 'Next slide');
    assertTooltip(document.getElementById('rmExit'), 'Exit', 'Exit', 'Exit');
    // Shows the slide counter as its text, so it needs no aria-label.
    assertTooltip(document.getElementById('rmCounter'), 'Jump to slide', null, 'Slide counter');
  });

  t.test('entering and leaving remote mode is remembered on this device', () => {
    SS.toggleRemoteMode();
    assertEqual(lucidos.storage.local.getItem('ss-mode'), 'remote', 'after entering remote mode');
    SS.closeRemoteMode();
    assertEqual(lucidos.storage.local.getItem('ss-mode'), 'presenter', 'after leaving remote mode');
  });
});

asuite('Controls — zoom', (t) => {
  t.test('the zoom buttons use data-tooltip, with a name for each glyph button', () => {
    assertTooltip(document.getElementById('ssZoomOut'), 'Zoom out (Ctrl -)', 'Zoom out', 'Zoom out');
    assertTooltip(document.getElementById('ssZoomIn'), 'Zoom in (Ctrl +)', 'Zoom in', 'Zoom in');
    // Shows the zoom level as its text.
    assertTooltip(document.getElementById('ssZoomLabel'), 'Reset zoom (Ctrl 0)', null, 'Reset zoom');
  });
});

asuite('Controls — Google Drive', (t) => {
  t.afterEach(() => {
    SS.driveUI.close();
    delete SS._currentPres;
  });

  t.test('drive.js keeps no toast helper of its own', () => {
    assertEqual(SS.drive.toast, undefined, 'SS.drive.toast');
  });

  t.test('saving with no deck open says so through lucidos.ui.toast', async () => {
    window.__toasts.length = 0;
    await SS.driveUI.saveCurrent();
    assertDeepEqual(window.__toasts, [['No presentation open', 'warning']], 'the toast');
  });

  t.test('the folder browser buttons use data-tooltip', async () => {
    SS._currentPres = { id: 'deck', title: 'Deck', sourceFile: 'artifacts/presentations/deck.slides' };
    await SS.driveUI.saveCurrent();
    const pin = await waitFor(() => document.getElementById('ssPinHere'), 'the pin button');
    assertTooltip(pin, 'Open the browser here by default', null, 'Pin as default');
    assertTooltip(document.getElementById('ssNewFolder'), 'Create a folder here', null, 'New folder');
  });

  t.test('a save in flight shows the shared mini spinner', async () => {
    SS._currentPres = { id: 'deck', title: 'Deck', sourceFile: 'artifacts/presentations/deck.slides' };
    await SS.driveUI.saveCurrent();
    (await waitFor(() => document.getElementById('ssSaveHere'), 'the save button')).click();
    const busy = await waitFor(() => document.querySelector('#ssDriveModal .ss-drive-busy'), 'the busy card');
    const spinner = busy.querySelector('.mini-spinner');
    assert(spinner, 'the busy card holds a .mini-spinner');
    assertEqual(spinner.getAttribute('aria-hidden'), 'true', 'the spinner is decoration beside its text');
    assertEqual(busy.querySelector('.ss-loading-spinner'), null, 'no hand-drawn spinner');
  });
});

asuite('Controls — pages and stylesheets', (t) => {
  t.test('index.html: the menu button uses data-tooltip and a name, and no title is left', async () => {
    const doc = await fetchDoc('../index.html');
    assertTooltip(doc.getElementById('menuBtn'), 'Choose presentation', 'Choose presentation', 'Menu button');
    assertEqual(doc.querySelectorAll('body [title]').length, 0, 'elements with a title tooltip');
  });

  t.test('index.html links the shared stylesheet before its own, so tooltips and spinners are painted', async () => {
    const html = await fetchText('../index.html');
    const shared = html.indexOf('href="/api/v1/sdk-iframe.css"');
    assert(shared > 0, 'index.html links /api/v1/sdk-iframe.css');
    assert(shared < html.indexOf('href="styles.css"'), 'before styles.css, so the deck styles win');
  });

  t.test('index.html: loading the decks draws no spinner', async () => {
    const doc = await fetchDoc('../index.html');
    assertEqual(doc.querySelector('.ss-loading-spinner, .mini-spinner'), null, 'a spinner on the loading screen');
    assert(doc.querySelector('.ss-loading p'), 'the loading text stays');
  });

  t.test('remote.html: the nav buttons use data-tooltip, with a name for the glyph button', async () => {
    const doc = await fetchDoc('../remote.html');
    assertTooltip(doc.getElementById('prevBtn'), 'Previous (←)', 'Previous', 'Previous');
    assertTooltip(doc.getElementById('pickerBtn'), 'Jump to slide', null, 'Slides');
    assertTooltip(doc.getElementById('nextBtn'), 'Next (→ / Space)', null, 'Next');
    assertEqual(doc.querySelectorAll('body [title]').length, 0, 'elements with a title tooltip');
  });

  t.test('the hover check sees an ungated rule', () => {
    const rules = hoverRules('.a:hover { color: red; } @media (hover: hover) { .b:hover { color: blue; } }');
    assertDeepEqual(rules.filter((r) => !hoverGated(r)).map((r) => r.selector), ['.a:hover'], 'ungated');
  });

  t.test('every :hover rule waits for a real pointer, so a tap on a phone leaves no hover behind', async () => {
    const sticky = [];
    let total = 0;
    for (const file of ['styles.css', 'remote.css', 'remote-mode.css']) {
      const rules = hoverRules(await fetchText(`../${file}`));
      total += rules.length;
      rules.filter((r) => !hoverGated(r)).forEach((r) => sticky.push(`${file}: ${r.selector}`));
    }
    assertGreater(total, 0, 'hover rules checked');
    assertDeepEqual(sticky, [], 'hover rules outside @media (hover: hover)');
  });

  t.test('styles.css keeps no hand-drawn spinner', async () => {
    assert(!/\.ss-loading-spinner/.test(await fetchText('../styles.css')), '.ss-loading-spinner is gone');
  });
});
