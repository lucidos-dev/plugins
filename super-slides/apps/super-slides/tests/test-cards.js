/* ══════════════════════════════════════════════════════
   Test Suite: Card Focus
   ══════════════════════════════════════════════════════ */

suite('Card Focus', (t) => {
  const CARD_PRES = () => mockPresentation('cards', 5, {
    cardSlides: [1, 3],
    cardsPerSlide: 3,
  });

  t.test('Presenter focuses card and broadcasts state', () => {
    const bus = createMockEventBus();
    const pres = createPresenter(bus, CARD_PRES());
    const remote = createRemote(bus, CARD_PRES());
    remote.ping();
    pres.goTo(1);
    pres.focusCard(0);
    assertEqual(remote.state.cardIndex, 0, 'card 0 focused');
    assertEqual(remote.state.cardCount, 3, 'card count 3');
  });

  t.test('Presenter clears card focus and broadcasts', () => {
    const bus = createMockEventBus();
    const pres = createPresenter(bus, CARD_PRES());
    const remote = createRemote(bus, CARD_PRES());
    remote.ping();
    pres.goTo(1);
    pres.focusCard(1);
    pres.clearCardFocus();
    assertEqual(remote.state.cardIndex, -1, 'card focus cleared');
  });

  t.test('Remote sends focusCard command', () => {
    const bus = createMockEventBus();
    const pres = createPresenter(bus, CARD_PRES());
    const remote = createRemote(bus, CARD_PRES());
    remote.ping();
    pres.goTo(1);
    remote.focusCard(2);
    assertEqual(pres.focusedCard, 2, 'presenter focused card 2');
    assertEqual(remote.state.cardIndex, 2, 'remote shows card 2');
  });

  t.test('Remote sends clearCardFocus command', () => {
    const bus = createMockEventBus();
    const pres = createPresenter(bus, CARD_PRES());
    const remote = createRemote(bus, CARD_PRES());
    remote.ping();
    pres.goTo(1);
    remote.focusCard(1);
    remote.clearCardFocus();
    assertEqual(pres.focusedCard, -1, 'presenter cleared');
    assertEqual(remote.state.cardIndex, -1, 'remote cleared');
  });

  t.test('Navigating to a new slide resets card focus', () => {
    const bus = createMockEventBus();
    const pres = createPresenter(bus, CARD_PRES());
    const remote = createRemote(bus, CARD_PRES());
    remote.ping();
    pres.goTo(1);
    pres.focusCard(2);
    assertEqual(pres.focusedCard, 2, 'card focused');
    pres.goTo(2);
    assertEqual(pres.focusedCard, -1, 'reset on navigate');
    assertEqual(remote.state.cardIndex, -1, 'remote sees reset');
  });

  t.test('Focus out-of-range card returns false', () => {
    const bus = createMockEventBus();
    const pres = createPresenter(bus, CARD_PRES());
    remote = createRemote(bus, CARD_PRES());
    remote.ping();
    pres.goTo(1); // 3 cards
    assertEqual(pres.focusCard(5), false, 'out of range');
    assertEqual(pres.focusCard(-1), false, 'negative');
  });

  t.test('Focus on slide with no cards returns false', () => {
    const bus = createMockEventBus();
    const pres = createPresenter(bus, CARD_PRES());
    remote = createRemote(bus, CARD_PRES());
    remote.ping();
    pres.goTo(0); // no cards on slide 0
    assertEqual(pres.focusCard(0), false, 'no cards');
  });
});
