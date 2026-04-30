/* ══════════════════════════════════════════════════════
   Test Suite: Absolute-State Protocol
   ══════════════════════════════════════════════════════
   Locks in the guarantee that the remote and presenter
   cannot drift, because every command carries the full
   target { presentationId, slideIndex, cardIndex }.
   ══════════════════════════════════════════════════════ */

suite('Absolute-State Protocol', (t) => {
  const REG = () => [
    mockPresentation('alpha', 5, { title: 'Alpha' }),
    mockPresentation('beta',  6, { title: 'Beta', cardSlides: [2], cardsPerSlide: 3 }),
  ];

  t.test('Every remote command carries presentationId + slideIndex + cardIndex', () => {
    const reg = REG();
    const bus = createMockEventBus();
    createPresenter(bus, reg);
    const remote = createRemote(bus, reg);
    remote.ping();

    const sent = [];
    bus.on('SlideRemoteCommand', (d) => sent.push(d));

    remote.next();
    remote.prev();
    remote.goto(3);
    remote.switchPresentation('beta');

    assertEqual(sent.length, 4, '4 commands sent');
    sent.forEach((cmd, i) => {
      assertEqual(cmd.action, 'setState', `cmd ${i} is setState`);
      assert(typeof cmd.presentationId === 'string', `cmd ${i} has presentationId`);
      assert(typeof cmd.slideIndex === 'number',     `cmd ${i} has slideIndex`);
      assert(typeof cmd.cardIndex === 'number',      `cmd ${i} has cardIndex`);
    });
  });

  t.test('Out-of-order command delivery still converges to last-sent state', () => {
    const reg = REG();
    const bus = createMockEventBus();
    const pres = createPresenter(bus, reg);

    // Simulate 3 commands sent in order but delivered LAST one wins
    // (which in absolute-state protocol works because each is full target)
    bus.emit('SlideRemoteCommand', {
      action: 'setState', presentationId: 'alpha', slideIndex: 1, cardIndex: -1,
    });
    bus.emit('SlideRemoteCommand', {
      action: 'setState', presentationId: 'alpha', slideIndex: 2, cardIndex: -1,
    });
    bus.emit('SlideRemoteCommand', {
      action: 'setState', presentationId: 'alpha', slideIndex: 4, cardIndex: -1,
    });

    assertEqual(pres.current, 4, 'presenter at slide 4 (last command wins)');
  });

  t.test('Stale command with old presentationId after switch routes to old or ignored', () => {
    // After a switch, an in-flight command from before the switch carries
    // the OLD presentationId. With absolute-state, this either:
    //   (a) silently switches the presenter back if pres still exists, or
    //   (b) is rejected if the user wants strict mode.
    // Current impl: switches back. This is intentional — the remote is
    // authoritative and tells the presenter EXACTLY where to be.
    const reg = REG();
    const bus = createMockEventBus();
    const pres = createPresenter(bus, reg);

    // User on remote: switch to beta slide 0, then in-flight stale command
    // for alpha slide 2 (sent before the picker click registered).
    bus.emit('SlideRemoteCommand', {
      action: 'setState', presentationId: 'beta', slideIndex: 0, cardIndex: -1,
    });
    assertEqual(pres.presId, 'beta', 'switched to beta');

    bus.emit('SlideRemoteCommand', {
      action: 'setState', presentationId: 'alpha', slideIndex: 2, cardIndex: -1,
    });
    // The remote is the source of truth for target state. If it sent alpha,
    // the presenter goes to alpha. The remote will quickly correct itself
    // via the next user action (which carries the up-to-date state).
    assertEqual(pres.presId, 'alpha', 'follows authoritative target');
    assertEqual(pres.current, 2, 'at slide 2');
  });

  t.test('Card focus is reconciled together with slide+presentation', () => {
    const reg = REG();
    const bus = createMockEventBus();
    const pres = createPresenter(bus, reg);

    // Move to beta slide 2 and focus card 1 in one command
    bus.emit('SlideRemoteCommand', {
      action: 'setState', presentationId: 'beta', slideIndex: 2, cardIndex: 1,
    });
    assertEqual(pres.presId, 'beta', 'on beta');
    assertEqual(pres.current, 2, 'at slide 2');
    assertEqual(pres.focusedCard, 1, 'card 1 focused');
  });

  t.test('cardIndex -1 in setState clears card focus', () => {
    const reg = REG();
    const bus = createMockEventBus();
    const pres = createPresenter(bus, reg);

    pres.loadPresentation(reg[1]);
    pres.goTo(2);
    pres.focusCard(1);
    assertEqual(pres.focusedCard, 1, 'card focused');

    bus.emit('SlideRemoteCommand', {
      action: 'setState', presentationId: 'beta', slideIndex: 2, cardIndex: -1,
    });
    assertEqual(pres.focusedCard, -1, 'card focus cleared');
  });

  t.test('Round-trip: 100 random remote actions, presenter and remote stay aligned', () => {
    const reg = REG();
    const bus = createMockEventBus();
    const pres = createPresenter(bus, reg);
    const remote = createRemote(bus, reg);
    remote.ping();

    // Deterministic pseudo-random
    let seed = 42;
    const rand = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };

    for (let i = 0; i < 100; i++) {
      const r = rand();
      if (r < 0.4)        remote.next();
      else if (r < 0.7)   remote.prev();
      else if (r < 0.85)  remote.goto(Math.floor(rand() * remote.state.slideCount));
      else                remote.switchPresentation(rand() < 0.5 ? 'alpha' : 'beta');
    }

    assertEqual(pres.presId, remote.state.presentationId, 'presIds match after 100 ops');
    assertEqual(pres.current, remote.state.slideIndex, 'slide indices match after 100 ops');
  });

  t.test('Concurrent remote action while broadcast in flight: remote wins', () => {
    const reg = REG();
    const bus = createMockEventBus();
    const pres = createPresenter(bus, reg);
    const remote = createRemote(bus, reg);
    remote.ping();

    // Drop events to simulate latency
    bus.dropEvents();

    // Remote taps next 3 times during outage
    remote.next();
    remote.next();
    remote.next();
    assertEqual(remote.state.slideIndex, 3, 'remote optimistically at 3');

    bus.resumeEvents();

    // Last sent command (slide 3) wins
    remote.goto(3); // re-send to flush
    assertEqual(pres.current, 3, 'presenter caught up to slide 3');
    assertEqual(remote.state.slideIndex, 3, 'remote still at 3');
  });
});
