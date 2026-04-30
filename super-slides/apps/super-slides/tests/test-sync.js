/* ══════════════════════════════════════════════════════
   Test Suite: Basic Sync
   ══════════════════════════════════════════════════════ */

suite('Basic Sync', (t) => {
  t.test('Remote receives initial state via ping', () => {
    const bus = createMockEventBus();
    const pres = createPresenter(bus, mockPresentation());
    const remote = createRemote(bus, mockPresentation());
    remote.ping();
    const s = remote.state;
    assertEqual(s.connected, true, 'connected');
    assertEqual(s.slideIndex, 0, 'slideIndex');
    assertEqual(s.slideCount, 5, 'slideCount');
    assertEqual(s.presentationId, 'test-pres', 'presentationId');
  });

  t.test('Remote tracks presenter navigation', () => {
    const bus = createMockEventBus();
    const pres = createPresenter(bus, mockPresentation());
    const remote = createRemote(bus, mockPresentation());
    remote.ping();
    pres.goTo(3);
    assertEqual(remote.state.slideIndex, 3, 'after goTo(3)');
    pres.goTo(1);
    assertEqual(remote.state.slideIndex, 1, 'after goTo(1)');
  });

  t.test('Sequence numbers increment on each broadcast', () => {
    const bus = createMockEventBus();
    const pres = createPresenter(bus, mockPresentation());
    const remote = createRemote(bus, mockPresentation());
    remote.ping();
    const seq1 = pres.seq;
    pres.goTo(2);
    assertGreater(pres.seq, seq1, 'seq increased');
  });

  t.test('Inactive remote ignores state broadcasts', () => {
    const bus = createMockEventBus();
    const pres = createPresenter(bus, mockPresentation());
    const remote = createRemote(bus, mockPresentation());
    remote.ping();
    remote._setActive(false);
    const rc = remote.state.renderCount;
    pres.goTo(3);
    assertEqual(remote.state.renderCount, rc, 'no renders while inactive');
    assertEqual(remote.state.slideIndex, 0, 'still at 0');
  });
});
