/* ══════════════════════════════════════════════════════
   Test Suite: Desync Scenarios
   ══════════════════════════════════════════════════════
   Real-world races between presenter (desktop) and
   remote (mobile) — independent moves, presentation
   switches mid-pending, rapid input bursts.

   These tests target the class of bugs where mobile and
   desktop fall out of sync because the remote rejects
   broadcasts that legitimately reflect the presenter's
   new state.
   ══════════════════════════════════════════════════════ */

suite('Desync Scenarios', (t) => {
  const REG = () => [
    mockPresentation('pres-a', 5, { title: 'Presentation A' }),
    mockPresentation('pres-b', 8, { title: 'Presentation B' }),
    mockPresentation('pres-c', 3, { title: 'Presentation C' }),
  ];

  t.test('Presentation switch on presenter clears stale pending goto', () => {
    const reg = REG();
    const bus = createMockEventBus();
    const pres = createPresenter(bus, reg);
    const remote = createRemote(bus, reg);
    remote.ping();

    // Remote starts an optimistic goto — pending=3
    bus.dropEvents();
    remote.goto(3);
    assertEqual(remote.state.slideIndex, 3, 'optimistic at 3');

    // Meanwhile the desktop user picks pres-b from the menu
    bus.resumeEvents();
    pres.loadPresentation(reg[1]);

    // The new-presentation broadcast must NOT be blocked by the
    // stale pending — presentation change always wins.
    assertEqual(remote.state.presentationId, 'pres-b', 'remote follows pres switch');
    assertEqual(remote.state.slideIndex, 0, 'at slide 0 of pres-b');
    assertEqual(remote.state.slideCount, 8, 'count updated to 8');
  });

  t.test('Broadcast for new presentation overrides pending from old presentation', () => {
    const reg = REG();
    const bus = createMockEventBus();
    const pres = createPresenter(bus, reg);
    const remote = createRemote(bus, reg);
    remote.ping();

    // Remote sets pending on pres-a slide 2
    bus.dropEvents();
    remote.goto(2);
    assertEqual(remote.state.presentationId, 'pres-a', 'on pres-a');

    // Out-of-band broadcast: presenter is now on pres-b slide 5
    // (could be from desktop menu pick, or a different remote)
    bus.resumeEvents();
    bus.emit('SlidePresenterState', {
      presentationId: 'pres-b',
      presentationTitle: 'Presentation B',
      slideIndex: 5,
      slideCount: 8,
      cardIndex: -1,
      cardCount: 0,
      seq: 100,
    });

    assertEqual(remote.state.presentationId, 'pres-b', 'switched to pres-b');
    assertEqual(remote.state.slideIndex, 5, 'at slide 5');
    assertEqual(remote.state.slideCount, 8, 'count is 8');
  });

  t.test('Independent presenter navigation eventually reconciles after timeout', () => {
    const reg = REG();
    const bus = createMockEventBus();
    const pres = createPresenter(bus, reg);
    const remote = createRemote(bus, reg);
    remote.ping();

    // Remote optimistically goes to slide 2 (drop the actual command
    // so the presenter never processes it)
    bus.dropEvents();
    remote.goto(2);
    assertEqual(remote.state.slideIndex, 2, 'optimistic at 2');

    // Presenter independently navigates to slide 4 via keyboard
    bus.resumeEvents();
    pres.goTo(4);

    // While pending is fresh, remote refuses the conflicting broadcast
    assertEqual(remote.state.slideIndex, 2, 'still pending at 2');

    // After timeout, the next broadcast wins
    remote._setPendingTime(Date.now() - 4000);
    pres.broadcastState();

    assertEqual(remote.state.slideIndex, 4, 'reconciled to presenter position');
    assertEqual(remote._getPendingSlide(), null, 'pending cleared');
  });

  t.test('Rapid remote next bursts converge with presenter', () => {
    const reg = REG();
    const bus = createMockEventBus();
    const pres = createPresenter(bus, reg);
    const remote = createRemote(bus, reg);
    remote.ping();

    // Three quick taps before any broadcast can settle
    remote.next();
    remote.next();
    remote.next();

    assertEqual(remote.state.slideIndex, 3, 'remote at 3 after 3 nexts');
    assertEqual(pres.current, 3, 'presenter at 3 after 3 nexts');
    assertEqual(remote._getPendingSlide(), null, 'pending cleared (final matched)');
  });

  t.test('Remote next then prev quickly settles correctly', () => {
    const reg = REG();
    const bus = createMockEventBus();
    const pres = createPresenter(bus, reg);
    const remote = createRemote(bus, reg);
    remote.ping();
    remote.goto(3);

    remote.next();   // optimistic 4
    remote.prev();   // optimistic 3 — pending replaced

    assertEqual(remote.state.slideIndex, 3, 'remote at 3');
    assertEqual(pres.current, 3, 'presenter at 3');
  });

  t.test('Picker switch + presenter-side load both end at slide 0 of new pres', () => {
    const reg = REG();
    const bus = createMockEventBus();
    const pres = createPresenter(bus, reg);
    const remote = createRemote(bus, reg);
    remote.ping();
    remote.goto(2);

    remote.switchPresentation('pres-b');
    assertEqual(remote.state.presentationId, 'pres-b', 'remote switched');
    assertEqual(remote.state.slideIndex, 0, 'remote at slide 0');
    assertEqual(pres.presId, 'pres-b', 'presenter switched');
    assertEqual(pres.current, 0, 'presenter at slide 0');
  });

  t.test('Remote that joined late sees presenter mid-presentation', () => {
    const reg = REG();
    const bus = createMockEventBus();
    const pres = createPresenter(bus, reg);

    // Presenter has been moving around without a remote
    pres.loadPresentation(reg[1]);
    pres.goTo(5);

    // Remote joins now
    const remote = createRemote(bus, reg);
    remote.ping();

    assertEqual(remote.state.presentationId, 'pres-b', 'caught up to pres-b');
    assertEqual(remote.state.slideIndex, 5, 'caught up to slide 5');
    assertEqual(remote.state.slideCount, 8, 'count 8');
  });

  t.test('Stale broadcast at same slide+pending does not break next pending', () => {
    // Regression: confirm that after pending clears via match,
    // a follow-up command reinstates pending correctly.
    const reg = REG();
    const bus = createMockEventBus();
    const pres = createPresenter(bus, reg);
    const remote = createRemote(bus, reg);
    remote.ping();

    remote.goto(2);
    assertEqual(remote._getPendingSlide(), null, 'pending cleared after match');

    bus.dropEvents();
    remote.goto(4);
    assertEqual(remote._getPendingSlide(), 4, 'pending=4 again');

    bus.resumeEvents();
    pres.broadcastState(); // re-broadcasts current=2 (presenter never received goto(4))
    // Old position would be rejected - this is correct
    assertEqual(remote.state.slideIndex, 4, 'still optimistic 4');
  });

  t.test('Card focus persists when presenter broadcasts unrelated state', () => {
    const reg = REG();
    const cardReg = [mockPresentation('cards', 4, {
      cardSlides: [1],
      cardsPerSlide: 3,
      title: 'Cards',
    })];
    const bus = createMockEventBus();
    const pres = createPresenter(bus, cardReg);
    const remote = createRemote(bus, cardReg);
    remote.ping();

    pres.goTo(1);
    pres.focusCard(1);
    assertEqual(remote.state.cardIndex, 1, 'remote sees card 1');

    pres.broadcastState();
    assertEqual(remote.state.cardIndex, 1, 'still card 1 after re-broadcast');
  });

  t.test('Remote ping during pending does not corrupt pending state', () => {
    const reg = REG();
    const bus = createMockEventBus();
    const pres = createPresenter(bus, reg);
    const remote = createRemote(bus, reg);
    remote.ping();

    bus.dropEvents();
    remote.goto(3);

    bus.resumeEvents();
    remote.ping(); // presenter responds with current state (slide 0)

    // Ping response is at slide 0 - pending=3 conflicts
    // Remote should still hold its optimistic 3
    assertEqual(remote.state.slideIndex, 3, 'pending preserved across ping');
  });
});
