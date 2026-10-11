/* ══════════════════════════════════════════════════════
   Super Slides — Deep link tests
   ══════════════════════════════════════════════════════
   Locks in SS.navLogic.parseDeepLink, the pure parser behind
   the app's location.hash routes:
     #menu                      open the presentation chooser
     #remote                    open the embedded speaker remote
     #deck=<id>&slide=<n>       open a deck at slide n (1-based)
   ══════════════════════════════════════════════════════ */

suite('Deep link parsing', (t) => {
  const parse = (h) => SS.navLogic.parseDeepLink(h);

  t.test('empty hash asks for nothing', () => {
    const l = parse('');
    assertEqual(l.deck, null, 'deck');
    assertEqual(l.slideIndex, 0, 'slideIndex');
    assertEqual(l.menu, false, 'menu');
    assertEqual(l.remote, false, 'remote');
  });

  t.test('undefined hash is safe', () => {
    assertEqual(parse(undefined).deck, null, 'deck');
  });

  t.test('#menu opens the chooser', () => {
    assertEqual(parse('#menu').menu, true, 'menu');
    assertEqual(parse('#menu').remote, false, 'remote');
  });

  t.test('#remote opens remote mode', () => {
    assertEqual(parse('#remote').remote, true, 'remote');
  });

  t.test('deck and 1-based slide become a 0-based index', () => {
    const l = parse('#deck=welcome-to-super-slides&slide=2');
    assertEqual(l.deck, 'welcome-to-super-slides', 'deck');
    assertEqual(l.slideIndex, 1, 'slideIndex');
  });

  t.test('deck without slide starts at the first slide', () => {
    assertEqual(parse('#deck=intro').slideIndex, 0, 'slideIndex');
  });

  t.test('bad slide values fall back to the first slide', () => {
    assertEqual(parse('#deck=a&slide=0').slideIndex, 0, 'zero');
    assertEqual(parse('#deck=a&slide=-3').slideIndex, 0, 'negative');
    assertEqual(parse('#deck=a&slide=abc').slideIndex, 0, 'text');
  });

  t.test('flags combine with a deck', () => {
    const l = parse('#deck=a&slide=3&remote');
    assertEqual(l.deck, 'a', 'deck');
    assertEqual(l.slideIndex, 2, 'slideIndex');
    assertEqual(l.remote, true, 'remote');
  });

  t.test('deck id is URL-decoded', () => {
    assertEqual(parse('#deck=my%20deck').deck, 'my deck', 'deck');
  });

  t.test('hash without the leading # still parses', () => {
    assertEqual(parse('menu').menu, true, 'menu');
  });

  t.test('unknown keys are ignored', () => {
    const l = parse('#foo=bar&baz');
    assertEqual(l.deck, null, 'deck');
    assertEqual(l.menu, false, 'menu');
    assertEqual(l.remote, false, 'remote');
  });
});
