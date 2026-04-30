/* ══════════════════════════════════════════════════════
   Test Suite: Pending Goto (Anti-flicker)
   ══════════════════════════════════════════════════════ */

suite('Pending Goto (Anti-flicker)', (t) => {
  t.test('Stale broadcast is ignored while goto is pending', () => {
    const bus = createMockEventBus();
    const pres = createPresenter(bus, mockPresentation());
    const remote = createRemote(bus, mockPresentation());
    remote.ping();

    bus.dropEvents();
    remote.goto(4);
    assertEqual(remote.state.slideIndex, 4, 'optimistic at 4');

    bus.resumeEvents();
    // Simulate a stale broadcast from before the goto
    bus.emit('SlidePresenterState', {
      presentationId: 'test-pres',
      slideIndex: 0,
      slideCount: 5,
      seq: 999,
    });
    assertEqual(remote.state.slideIndex, 4, 'still at 4');
  });

  t.test('Matching state clears pending goto', () => {
    const bus = createMockEventBus();
    const pres = createPresenter(bus, mockPresentation());
    const remote = createRemote(bus, mockPresentation());
    remote.ping();

    remote.goto(3);
    assertEqual(remote.state.slideIndex, 3, 'confirmed at 3');
    assertEqual(remote._getPendingSlide(), null, 'pending cleared');
  });

  t.test('Pending goto times out after PENDING_TIMEOUT', () => {
    const bus = createMockEventBus();
    const pres = createPresenter(bus, mockPresentation());
    const remote = createRemote(bus, mockPresentation());
    remote.ping();

    bus.dropEvents();
    remote.goto(4);
    bus.resumeEvents();

    // Simulate timeout (>3s elapsed)
    remote._setPendingTime(Date.now() - 4000);

    bus.emit('SlidePresenterState', {
      presentationId: 'test-pres',
      slideIndex: 2,
      slideCount: 5,
      seq: 100,
    });

    assertEqual(remote.state.slideIndex, 2, 'accepted after timeout');
    assertEqual(remote._getPendingSlide(), null, 'pending cleared');
  });

  t.test('Optimistic goto at boundary is rejected', () => {
    const bus = createMockEventBus();
    const pres = createPresenter(bus, mockPresentation('t', 5));
    const remote = createRemote(bus, mockPresentation('t', 5));
    remote.ping();
    remote.goto(4); // last slide

    const rc = remote.state.renderCount;
    remote.next(); // should fail — index 5 is out of bounds
    assertEqual(remote.state.slideIndex, 4, 'stayed at 4');
  });
});

/* ══════════════════════════════════════════════════════
   Test Suite: Missed Events & Recovery
   ══════════════════════════════════════════════════════ */

suite('Missed Events & Recovery', (t) => {
  t.test('Remote recovers from missed events via heartbeat', () => {
    const bus = createMockEventBus();
    const pres = createPresenter(bus, mockPresentation());
    const remote = createRemote(bus, mockPresentation());
    remote.ping();

    bus.dropEvents();
    pres.goTo(3);
    assertEqual(remote.state.slideIndex, 0, 'remote missed it');

    bus.resumeEvents();
    pres.broadcastState();
    assertEqual(remote.state.slideIndex, 3, 'recovered to 3');
  });

  t.test('Ping triggers re-broadcast from presenter', () => {
    const bus = createMockEventBus();
    const pres = createPresenter(bus, mockPresentation());
    pres.goTo(2);

    const remote = createRemote(bus, mockPresentation());
    assertEqual(remote.state.connected, false, 'not connected');

    remote.ping();
    assertEqual(remote.state.connected, true, 'connected');
    assertEqual(remote.state.slideIndex, 2, 'synced to 2');
  });

  t.test('Late-joining remote gets full state', () => {
    const bus = createMockEventBus();
    const pres = createPresenter(bus, mockPresentation('p', 10));
    pres.goTo(7);

    // Remote joins late
    const remote = createRemote(bus, mockPresentation('p', 10));
    remote.ping();

    assertEqual(remote.state.presentationId, 'p', 'got pres id');
    assertEqual(remote.state.slideIndex, 7, 'got slide 7');
    assertEqual(remote.state.slideCount, 10, 'got count 10');
  });
});
