/* ══════════════════════════════════════════════════════
   Super Slides — Test Models
   ══════════════════════════════════════════════════════
   Mock Presenter and Remote that mirror the actual
   engine.js and remote-mode.js logic. Keep in sync
   when the real code changes.
   ══════════════════════════════════════════════════════ */

/* ── Mock Event Bus ──────────────────────────────── */

function createMockEventBus() {
  const listeners = {};
  let dropped = false;

  return {
    on(type, cb) {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push(cb);
    },
    async emit(type, payload) {
      if (dropped) return;
      const cbs = listeners[type] || [];
      cbs.forEach(cb => cb({ ...payload }));
    },
    dropEvents() { dropped = true; },
    resumeEvents() { dropped = false; },
    reset() {
      Object.keys(listeners).forEach(k => delete listeners[k]);
      dropped = false;
    },
  };
}

/* ── Mock Presentation ───────────────────────────── */

function mockPresentation(id, slideCount, opts) {
  opts = opts || {};
  const slides = Array.from({ length: slideCount || 5 }, (_, i) => ({
    title: `Slide ${i + 1}`,
    html: `<h2>Slide ${i + 1}</h2>`,
    notes: opts.notes ? `Notes for slide ${i + 1}` : undefined,
    cardNotes: opts.cardNotes ? [`Card 0 notes`, `Card 1 notes`] : undefined,
  }));
  // Optionally mark some slides as having focusable cards
  if (opts.cardSlides) {
    opts.cardSlides.forEach(si => {
      slides[si]._cardCount = opts.cardsPerSlide || 3;
    });
  }
  const pres = {
    id: id || 'test-pres',
    title: opts.title || 'Test Presentation',
    slides,
  };
  if (opts.sections) {
    pres.sections = opts.sections;
  }
  return pres;
}

/* ── Presenter Model (mirrors engine.js) ─────────── */

function createPresenter(bus, registry) {
  // Accept a single pres or array
  if (!Array.isArray(registry)) registry = [registry];

  let currentPres = null;
  let slides = [];
  let current = 0;
  let focusedCardIndex = -1;
  let stateSeq = 0;

  function getFocusables(slideIndex) {
    // In real engine this queries DOM; here we use _cardCount
    const s = currentPres.slides[slideIndex];
    return s && s._cardCount ? s._cardCount : 0;
  }

  function broadcastState() {
    stateSeq++;
    const cardCount = getFocusables(current);
    bus.emit('SlidePresenterState', {
      presentationId: currentPres.id,
      presentationTitle: currentPres.title,
      slideIndex: current,
      slideCount: slides.length,
      slideTitle: slides[current].title,
      cardIndex: focusedCardIndex,
      cardCount: cardCount,
      seq: stateSeq,
    });
  }

  function loadPresentation(pres, startSlide) {
    currentPres = pres;
    slides = pres.slides;
    startSlide = (startSlide && startSlide > 0 && startSlide < slides.length) ? startSlide : 0;
    current = startSlide;
    focusedCardIndex = -1;
    broadcastState();
  }

  function goTo(n) {
    if (n < 0 || n >= slides.length || n === current) return;
    focusedCardIndex = -1;
    current = n;
    broadcastState();
  }

  function focusCard(index) {
    const count = getFocusables(current);
    if (!count || index < 0 || index >= count) return false;
    focusedCardIndex = index;
    broadcastState();
    return true;
  }

  function clearCardFocus() {
    focusedCardIndex = -1;
    broadcastState();
  }

  // Listen for remote commands — matches engine.js logic exactly
  bus.on('SlideRemoteCommand', (data) => {
    if (!data || !currentPres) return;

    // Legacy 'sync' — re-broadcast current state
    if (data.action === 'sync') { broadcastState(); return; }
    if (data.action !== 'setState') return; // ignore unknown actions

    const targetPresId   = data.presentationId;
    const targetSlideIdx = typeof data.slideIndex === 'number' ? data.slideIndex : current;
    const targetCardIdx  = typeof data.cardIndex  === 'number' ? data.cardIndex  : -1;

    // 1. Reconcile presentation
    if (targetPresId && targetPresId !== currentPres.id) {
      const idx = registry.findIndex(p => p.id === targetPresId);
      if (idx >= 0) {
        loadPresentation(registry[idx], targetSlideIdx);
        if (targetCardIdx >= 0) {
          if (focusCard(targetCardIdx)) broadcastState();
        }
      }
      return;
    }

    // 2. Reconcile slide
    if (targetSlideIdx !== current) goTo(targetSlideIdx);

    // 3. Reconcile card
    if (targetCardIdx !== focusedCardIndex) {
      if (targetCardIdx < 0) {
        if (focusedCardIndex !== -1) { clearCardFocus(); broadcastState(); }
      } else {
        if (focusCard(targetCardIdx)) broadcastState();
      }
    }
  });

  bus.on('SlidePresenterPing', () => broadcastState());

  // Init: load first presentation
  loadPresentation(registry[0]);

  return {
    get current() { return current; },
    get seq() { return stateSeq; },
    get presId() { return currentPres.id; },
    get focusedCard() { return focusedCardIndex; },
    get registry() { return registry; },
    goTo,
    focusCard,
    clearCardFocus,
    broadcastState,
    loadPresentation,
  };
}

/* ── Remote Model (mirrors remote-mode.js) ───────── */

function createRemote(bus, registry) {
  if (!Array.isArray(registry)) registry = [registry];

  const S = {
    active: true,
    connected: false,
    presentationId: null,
    presentationTitle: null,
    slideIndex: 0,
    slideCount: 0,
    cardIndex: -1,
    cardCount: 0,
    pres: null,
    renderCount: 0,
  };

  let pendingSlide = null;
  let pendingTime = 0;
  const PENDING_TIMEOUT = 3000;

  function getPresById(id) {
    return registry.find(p => p.id === id) || null;
  }

  function render() {
    S.renderCount++;
  }

  function send(extra) {
    bus.emit('SlideRemoteCommand', Object.assign({
      summary: 'Remote: setState',
      action: 'setState',
      presentationId: S.presentationId,
      slideIndex: S.slideIndex,
      cardIndex: S.cardIndex,
    }, extra || {}));
  }

  function optimisticGoto(idx) {
    if (S.slideCount && (idx < 0 || idx >= S.slideCount)) return false;
    S.slideIndex = idx;
    S.cardIndex = -1;
    S.cardCount = 0;
    S.pres = getPresById(S.presentationId) || S.pres;
    pendingSlide = idx;
    pendingTime = Date.now();
    render();
    return true;
  }

  function applyState(data) {
    if (!data) return;
    S.connected = true;

    const presChanged = data.presentationId && data.presentationId !== S.presentationId;

    // Reject stale broadcasts during pending goto — but only when the
    // presentation hasn't changed. A presentation switch always wins
    // (otherwise a desktop-side menu pick would be ignored on the remote).
    if (!presChanged && pendingSlide !== null && typeof data.slideIndex === 'number') {
      if (data.slideIndex === pendingSlide) {
        pendingSlide = null;
      } else if (Date.now() - pendingTime < PENDING_TIMEOUT) {
        return;
      } else {
        pendingSlide = null;
      }
    } else if (presChanged) {
      // Drop pending — it referred to the old presentation
      pendingSlide = null;
    }

    S.presentationId    = data.presentationId    || S.presentationId;
    S.presentationTitle = data.presentationTitle || S.presentationTitle;
    S.slideIndex        = typeof data.slideIndex === 'number' ? data.slideIndex : S.slideIndex;
    S.slideCount        = data.slideCount        || S.slideCount;
    S.cardIndex         = typeof data.cardIndex === 'number' ? data.cardIndex : -1;
    S.cardCount         = typeof data.cardCount === 'number' ? data.cardCount : 0;

    if (presChanged || !S.pres || S.pres.id !== S.presentationId) {
      S.pres = getPresById(S.presentationId);
    }

    render();
  }

  // SSE listener
  bus.on('SlidePresenterState', (data) => {
    if (!S.active) return;
    applyState(data);
  });

  function next() {
    if (!optimisticGoto(S.slideIndex + 1)) return;
    send();
  }

  function prev() {
    if (!optimisticGoto(S.slideIndex - 1)) return;
    send();
  }

  function goto(idx) {
    if (!optimisticGoto(idx)) return;
    send();
  }

  function switchPresentation(id) {
    // Mirrors remote-mode.js picker pres click
    if (id === S.presentationId) return;
    S.presentationId = id;
    S.presentationTitle = getPresById(id)?.title || id;
    S.pres = getPresById(id) || S.pres;
    S.slideIndex = 0;
    S.slideCount = S.pres?.slides?.length || 0;
    S.cardIndex = -1;
    S.cardCount = 0;
    pendingSlide = 0;
    pendingTime = Date.now();
    render();
    send();
  }

  function focusCard(idx) {
    S.cardIndex = idx;
    render();
    send();
  }

  function clearCardFocus() {
    S.cardIndex = -1;
    render();
    send();
  }

  function ping() {
    bus.emit('SlidePresenterPing', {});
  }

  return {
    get state() { return { ...S }; },
    next, prev, goto, ping,
    switchPresentation,
    focusCard, clearCardFocus,
    // Test internals
    _setPendingTime(t) { pendingTime = t; },
    _getPendingSlide() { return pendingSlide; },
    _setActive(v) { S.active = v; },
  };
}
