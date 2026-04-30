/* ══════════════════════════════════════════════════════
   Test Suite: Presentation Switching
   ══════════════════════════════════════════════════════
   Tests the multi-presentation workflow under the
   absolute-state protocol — every command carries the
   full target { presentationId, slideIndex, cardIndex }.
   ══════════════════════════════════════════════════════ */

suite('Presentation Switching', (t) => {
  const REG = () => [
    mockPresentation('pres-a', 5, { title: 'Presentation A' }),
    mockPresentation('pres-b', 8, { title: 'Presentation B' }),
    mockPresentation('pres-c', 3, { title: 'Presentation C' }),
  ];

  t.test('Remote can switch to a different presentation via picker', () => {
    const reg = REG();
    const bus = createMockEventBus();
    const pres = createPresenter(bus, reg);
    const remote = createRemote(bus, reg);
    remote.ping();
    assertEqual(remote.state.presentationId, 'pres-a', 'starts with pres-a');

    remote.switchPresentation('pres-b');
    assertEqual(pres.presId, 'pres-b', 'presenter switched to pres-b');
    assertEqual(pres.current, 0, 'presenter at slide 0');
    assertEqual(remote.state.presentationId, 'pres-b', 'remote shows pres-b');
    assertEqual(remote.state.slideCount, 8, 'remote has 8 slides');
  });

  t.test('next/prev after switch use new presentation ID', () => {
    const reg = REG();
    const bus = createMockEventBus();
    const pres = createPresenter(bus, reg);
    const remote = createRemote(bus, reg);
    remote.ping();

    remote.switchPresentation('pres-b');
    remote.next();
    assertEqual(pres.presId, 'pres-b', 'still on pres-b');
    assertEqual(pres.current, 1, 'advanced to slide 1 in pres-b');
    remote.next();
    assertEqual(pres.current, 2, 'advanced to slide 2 in pres-b');
  });

  t.test('setState with current presentationId reconciles slide+card', () => {
    const reg = REG();
    const bus = createMockEventBus();
    const pres = createPresenter(bus, reg);

    bus.emit('SlideRemoteCommand', {
      action: 'setState',
      presentationId: 'pres-a',
      slideIndex: 3,
      cardIndex: -1,
      summary: 'jump to slide 3',
    });
    assertEqual(pres.presId, 'pres-a', 'still pres-a');
    assertEqual(pres.current, 3, 'at slide 3');
  });

  t.test('setState with different known presentationId switches presentation', () => {
    const reg = REG();
    const bus = createMockEventBus();
    const pres = createPresenter(bus, reg);

    bus.emit('SlideRemoteCommand', {
      action: 'setState',
      presentationId: 'pres-b',
      slideIndex: 4,
      cardIndex: -1,
      summary: 'switch to pres-b slide 4',
    });
    assertEqual(pres.presId, 'pres-b', 'switched to pres-b');
    assertEqual(pres.current, 4, 'at slide 4');
  });

  t.test('setState with unknown presentationId is ignored', () => {
    const reg = REG();
    const bus = createMockEventBus();
    const pres = createPresenter(bus, reg);

    bus.emit('SlideRemoteCommand', {
      action: 'setState',
      presentationId: 'nonexistent',
      slideIndex: 0,
      cardIndex: -1,
      summary: 'bad switch',
    });
    assertEqual(pres.presId, 'pres-a', 'stays on pres-a');
    assertEqual(pres.current, 0, 'stays at slide 0');
  });

  t.test('Unknown action is ignored', () => {
    const reg = REG();
    const bus = createMockEventBus();
    const pres = createPresenter(bus, reg);

    bus.emit('SlideRemoteCommand', {
      action: 'mystery',
      presentationId: 'pres-a',
      slideIndex: 2,
      summary: 'unknown',
    });
    assertEqual(pres.current, 0, 'did not move');
  });

  t.test('sync action triggers re-broadcast without state change', () => {
    const reg = REG();
    const bus = createMockEventBus();
    const pres = createPresenter(bus, reg);
    const seqBefore = pres.seq;

    bus.emit('SlideRemoteCommand', {
      action: 'sync',
      presentationId: 'pres-a',
      summary: 'sync',
    });
    assertEqual(pres.current, 0, 'no slide change');
    assertGreater(pres.seq, seqBefore, 'broadcast happened');
  });

  t.test('Switch preserves target slideIndex', () => {
    const reg = REG();
    const bus = createMockEventBus();
    const pres = createPresenter(bus, reg);

    bus.emit('SlideRemoteCommand', {
      action: 'setState',
      presentationId: 'pres-b',
      slideIndex: 3,
      cardIndex: -1,
      summary: 'switch to slide 3',
    });
    assertEqual(pres.presId, 'pres-b', 'switched');
    assertEqual(pres.current, 3, 'at slide 3');
  });

  t.test('Switching presentation to the same one is a no-op', () => {
    const reg = REG();
    const bus = createMockEventBus();
    const pres = createPresenter(bus, reg);
    const remote = createRemote(bus, reg);
    remote.ping();
    remote.switchPresentation('pres-a'); // already on pres-a
    assertEqual(pres.presId, 'pres-a', 'still pres-a');
  });

  t.test('Remote optimistically updates state on switch', () => {
    const reg = REG();
    const bus = createMockEventBus();
    const pres = createPresenter(bus, reg);
    const remote = createRemote(bus, reg);
    remote.ping();

    // Navigate to slide 3 in pres-a first
    remote.goto(3);
    assertEqual(remote.state.slideIndex, 3, 'at slide 3');

    // Now switch — remote should optimistically show pres-b slide 0
    bus.dropEvents(); // prevent presenter confirmation from arriving
    remote.switchPresentation('pres-b');
    assertEqual(remote.state.presentationId, 'pres-b', 'optimistic pres-b');
    assertEqual(remote.state.slideIndex, 0, 'optimistic slide 0');
    assertEqual(remote.state.slideCount, 8, 'optimistic count 8');
  });

  t.test('Convergence: presenter and remote end up in same state after switch + next', () => {
    const reg = REG();
    const bus = createMockEventBus();
    const pres = createPresenter(bus, reg);
    const remote = createRemote(bus, reg);
    remote.ping();

    remote.switchPresentation('pres-c');
    remote.next();
    remote.next();

    assertEqual(pres.presId, remote.state.presentationId, 'presIds match');
    assertEqual(pres.current, remote.state.slideIndex, 'slide indices match');
  });
});
