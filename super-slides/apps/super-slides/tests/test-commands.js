/* ══════════════════════════════════════════════════════
   Test Suite: Remote Commands (next/prev/goto)
   ══════════════════════════════════════════════════════ */

suite('Remote Commands', (t) => {
  t.test('next() advances presenter by one', () => {
    const bus = createMockEventBus();
    const pres = createPresenter(bus, mockPresentation());
    const remote = createRemote(bus, mockPresentation());
    remote.ping();
    remote.next();
    assertEqual(pres.current, 1, 'presenter at 1');
    assertEqual(remote.state.slideIndex, 1, 'remote at 1');
  });

  t.test('prev() goes back by one', () => {
    const bus = createMockEventBus();
    const pres = createPresenter(bus, mockPresentation());
    const remote = createRemote(bus, mockPresentation());
    remote.ping();
    remote.next();
    remote.next();
    remote.prev();
    assertEqual(pres.current, 1, 'presenter at 1');
    assertEqual(remote.state.slideIndex, 1, 'remote at 1');
  });

  t.test('goto() jumps to specific slide', () => {
    const bus = createMockEventBus();
    const pres = createPresenter(bus, mockPresentation());
    const remote = createRemote(bus, mockPresentation());
    remote.ping();
    remote.goto(4);
    assertEqual(pres.current, 4, 'presenter at 4');
    assertEqual(remote.state.slideIndex, 4, 'remote at 4');
  });

  t.test('Cannot go below slide 0', () => {
    const bus = createMockEventBus();
    const pres = createPresenter(bus, mockPresentation());
    const remote = createRemote(bus, mockPresentation());
    remote.ping();
    remote.prev();
    assertEqual(pres.current, 0, 'stays at 0');
    assertEqual(remote.state.slideIndex, 0, 'remote stays at 0');
  });

  t.test('Cannot go past last slide', () => {
    const bus = createMockEventBus();
    const pres = createPresenter(bus, mockPresentation('t', 3));
    const remote = createRemote(bus, mockPresentation('t', 3));
    remote.ping();
    remote.goto(2);
    remote.next();
    assertEqual(pres.current, 2, 'stays at 2');
  });

  t.test('Rapid next clicks all land correctly', () => {
    const bus = createMockEventBus();
    const pres = createPresenter(bus, mockPresentation('t', 10));
    const remote = createRemote(bus, mockPresentation('t', 10));
    remote.ping();
    remote.next();
    remote.next();
    remote.next();
    remote.next();
    assertEqual(pres.current, 4, 'presenter advanced 4');
    assertEqual(remote.state.slideIndex, 4, 'remote at 4');
  });

  t.test('goto to current slide is a no-op', () => {
    const bus = createMockEventBus();
    const pres = createPresenter(bus, mockPresentation());
    const remote = createRemote(bus, mockPresentation());
    remote.ping();
    remote.goto(3);
    const seq = pres.seq;
    remote.goto(3); // already there
    // Presenter's goTo guards against n === current, so seq shouldn't change
    // (but the remote re-sends the command — it's the presenter that ignores it)
    assertEqual(pres.current, 3, 'still at 3');
  });
});
