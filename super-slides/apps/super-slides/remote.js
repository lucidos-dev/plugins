/* ══════════════════════════════════════════════════════
   Super Slides — Remote (speaker view)
   ══════════════════════════════════════════════════════
   A stripped-down companion UI that:
   - Shows current slide title, section, and speaker notes
   - Sends SlideRemoteCommand events to drive the presenter
   - Listens for SlidePresenterState to mirror live position
   ══════════════════════════════════════════════════════ */

(function () {
  const STATE = {
    presentationId: null,
    presentationTitle: null,
    slideIndex: 0,
    slideCount: 0,
    cardIndex: -1,
    presentation: null,    // full loaded presentation (for notes, picker)
  };

  function showRemoteError(msg) {
    els.notesBody.innerHTML =
      `<div style="color:var(--rose,#f87171);white-space:pre-wrap;font-size:.85rem;line-height:1.5;">${
        msg.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))
      }</div>`;
    els.slideTitle.textContent = 'Error loading presentation';
    els.pickerBtn.disabled = true;
  }

  // Match the presenter's persistence key — we use it as a sensible default
  // when the remote opens before the presenter has broadcast.
  const SAVED_PRES_ID = localStorage.getItem('ss-pres');
  const SAVED_SLIDE   = parseInt(localStorage.getItem('ss-slide')) || 0;

  const els = {
    presTitle: document.getElementById('presTitle'),
    connStatus: document.getElementById('connStatus'),
    counter: document.getElementById('counter'),
    sectionPill: document.getElementById('sectionPill'),
    slideTitle: document.getElementById('slideTitle'),
    nextUp: document.getElementById('nextUp'),
    notesBody: document.getElementById('notesBody'),
    prevBtn: document.getElementById('prevBtn'),
    nextBtn: document.getElementById('nextBtn'),
    pickerBtn: document.getElementById('pickerBtn'),
    pickerOverlay: document.getElementById('pickerOverlay'),
    pickerCloseBtn: document.getElementById('pickerCloseBtn'),
    pickerList: document.getElementById('pickerList'),
  };

  /* ── Load a presentation file directly (for notes + picker) ────────── */

  // Maintain our own registry; SS.loadPresentation appends to the global one.
  async function ensurePresentationLoaded(presentationId) {
    const reg = window._superSlidesRegistry || [];
    let pres = reg.find(p => p.id === presentationId);
    if (pres) return pres;

    const errors = [];

    // Try direct load first — fast, no glob needed
    const directPath = `artifacts/presentations/${presentationId}.slides`;
    try {
      await SS.loadPresentation(directPath);
      pres = (window._superSlidesRegistry || []).find(p => p.id === presentationId);
      if (pres) return pres;
    } catch (e) {
      errors.push(`Direct load failed (${directPath}): ${e.message}`);
    }

    // Fall back to listing all presentations
    let files = [];
    try {
      files = await lucidos.data.list('artifacts/presentations/*.slides');
    } catch (e) {
      errors.push(`Could not list presentations: ${e.message}`);
    }
    for (const path of files) {
      try {
        await SS.loadPresentation(path);
      } catch (e) {
        errors.push(`Failed to load ${path}: ${e.message}`);
      }
    }
    pres = (window._superSlidesRegistry || []).find(p => p.id === presentationId) || null;
    if (!pres) {
      const knownIds = (window._superSlidesRegistry || []).map(p => p.id);
      const errMsg = `Could not load presentation "${presentationId}".\n` +
        (errors.length ? errors.join('\n') : 'No errors, but ID not found.') +
        (knownIds.length ? `\nLoaded IDs: ${knownIds.join(', ')}` : '\nNo presentations loaded.');
      console.error('[remote]', errMsg);
      showRemoteError(errMsg);
    }
    return pres;
  }

  /* ── Find which section a flat slide index belongs to ──────────────── */

  function getSectionFor(pres, idx) {
    if (!pres || !pres.sections) return null;
    for (let i = pres.sections.length - 1; i >= 0; i--) {
      if (idx >= pres.sections[i].startIndex) return pres.sections[i];
    }
    return null;
  }

  function slideTitleFor(pres, idx) {
    if (!pres || !pres.slides[idx]) return `Slide ${idx + 1}`;
    const s = pres.slides[idx];
    if (s.title) return s.title;
    const m = (s.html || '').match(/<h[12][^>]*>(.*?)<\/h[12]>/);
    if (m) return m[1].replace(/<[^>]+>/g, '');
    return idx === 0 ? 'Title' : `Slide ${idx + 1}`;
  }

  /* ── Render the remote UI for the current state ────────────────────── */

  function render() {
    const pres = STATE.presentation;
    els.presTitle.textContent = STATE.presentationTitle || (pres && pres.title) || '—';

    const total = STATE.slideCount || (pres ? pres.slides.length : 0);
    els.counter.textContent = total
      ? `${STATE.slideIndex + 1} / ${total}`
      : '— / —';

    // Re-enable controls once presentation loads (clears any earlier error state)
    els.pickerBtn.disabled = !pres;

    if (pres) {
      const sec = getSectionFor(pres, STATE.slideIndex);
      if (sec) {
        els.sectionPill.hidden = false;
        els.sectionPill.textContent = sec.title;
        els.sectionPill.style.setProperty('--pill-color', `var(--${sec.color || 'accent'})`);
      } else {
        els.sectionPill.hidden = true;
      }
      els.slideTitle.textContent = slideTitleFor(pres, STATE.slideIndex);

      const next = STATE.slideIndex + 1;
      if (next < pres.slides.length) {
        els.nextUp.textContent = `Next: ${slideTitleFor(pres, next)}`;
        els.nextUp.hidden = false;
      } else {
        els.nextUp.hidden = true;
      }

      const slide = pres.slides[STATE.slideIndex];
      let notes = '';
      if (STATE.cardIndex >= 0 && slide?.cardNotes?.[STATE.cardIndex]) {
        notes = slide.cardNotes[STATE.cardIndex].trim();
      } else if (slide?.notes) {
        notes = slide.notes.trim();
      }
      if (notes) {
        // Notes may contain simple inline markup; treat as semi-trusted (presenter's own file).
        // Convert plain newlines to <br> for readability.
        els.notesBody.innerHTML = notes
          .split(/\n{2,}/)
          .map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`)
          .join('');
      } else {
        els.notesBody.innerHTML = '<em class="remote-notes-empty">No notes for this slide.</em>';
      }
    } else {
      els.sectionPill.hidden = true;
      els.slideTitle.textContent = STATE.presentationTitle ? 'Loading…' : 'Waiting for presenter';
      els.nextUp.hidden = true;
      els.notesBody.innerHTML = '<em class="remote-notes-empty">No notes for this slide.</em>';
    }

    // Picker (rebuild if open)
    if (!els.pickerOverlay.hidden) buildPicker();
  }

  /* ── Slide picker ──────────────────────────────────────────────────── */

  function buildPicker() {
    const pres = STATE.presentation;
    if (!pres) {
      els.pickerList.innerHTML = '<div class="remote-picker-empty">No presentation loaded.</div>';
      return;
    }
    let html = '';
    if (pres.sections) {
      pres.sections.forEach(sec => {
        html += `<div class="remote-picker-section-label" style="color: var(--${sec.color || 'accent'})">${sec.title}</div>`;
        for (let i = sec.startIndex; i <= sec.endIndex; i++) {
          html += pickerItem(pres, i);
        }
      });
    } else {
      pres.slides.forEach((_, i) => { html += pickerItem(pres, i); });
    }
    els.pickerList.innerHTML = html;
    const active = els.pickerList.querySelector('.remote-picker-item.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  function pickerItem(pres, i) {
    const isActive = i === STATE.slideIndex;
    return `<button class="remote-picker-item${isActive ? ' active' : ''}" data-slide="${i}">
      <span class="remote-picker-num">${i + 1}</span>
      <span class="remote-picker-title">${escapeHtml(slideTitleFor(pres, i))}</span>
    </button>`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  function openPicker() {
    buildPicker();
    els.pickerOverlay.hidden = false;
  }
  function closePicker() {
    els.pickerOverlay.hidden = true;
  }

  /* ── Commands → presenter ──────────────────────────────────────────── */

  // Absolute-state protocol: every command carries the full target state.
  function sendState(extra) {
    const payload = Object.assign({
      summary: 'Remote: setState',
      action: 'setState',
      presentationId: STATE.presentationId,
      slideIndex: STATE.slideIndex,
      cardIndex: STATE.cardIndex,
    }, extra || {});
    lucidos.events.emit('SlideRemoteCommand', payload, { transient: true }).catch(err => {
      console.warn('[remote] send failed:', err);
    });
  }

  function next() {
    const target = STATE.slideIndex + 1;
    if (STATE.slideCount && target >= STATE.slideCount) return;
    pendingGoto = target;
    pendingTime = Date.now();
    STATE.slideIndex = target;
    STATE.cardIndex = -1;
    render();
    sendState();
  }
  function prev() {
    const target = STATE.slideIndex - 1;
    if (target < 0) return;
    pendingGoto = target;
    pendingTime = Date.now();
    STATE.slideIndex = target;
    STATE.cardIndex = -1;
    render();
    sendState();
  }
  let pendingGoto = null;
  let pendingTime = 0;
  const PENDING_TIMEOUT = 3000; // accept presenter state after 3s even if unacknowledged

  function goto(idx) {
    // Optimistic update so the UI feels responsive
    pendingGoto = idx;
    pendingTime = Date.now();
    STATE.slideIndex = idx;
    STATE.cardIndex = -1;
    render();
    sendState();
  }

  /* ── Wire up controls ──────────────────────────────────────────────── */

  els.nextBtn.addEventListener('click', next);
  els.prevBtn.addEventListener('click', prev);
  els.pickerBtn.addEventListener('click', openPicker);
  els.pickerCloseBtn.addEventListener('click', closePicker);
  els.pickerOverlay.addEventListener('click', (e) => {
    if (e.target === els.pickerOverlay) closePicker();
  });
  els.pickerList.addEventListener('click', (e) => {
    const btn = e.target.closest('.remote-picker-item');
    if (!btn) return;
    const idx = parseInt(btn.dataset.slide);
    goto(idx);
    closePicker();
  });

  document.addEventListener('keydown', (e) => {
    // Don't intercept while typing in inputs (none today, but future-proof)
    if (e.target.matches('input, textarea, [contenteditable]')) return;
    if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') {
      e.preventDefault(); next();
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      e.preventDefault(); prev();
    } else if (e.key === 'Escape' && !els.pickerOverlay.hidden) {
      e.preventDefault(); closePicker();
    } else if (e.key === 'g') {
      e.preventDefault(); openPicker();
    }
  });

  // Touch swipes for phone use
  let touchStartX = 0, touchStartY = 0, touchMoved = false;
  document.addEventListener('touchstart', (e) => {
    if (e.target.closest('.remote-nav, .remote-picker-overlay, button')) return;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    touchMoved = false;
  }, { passive: true });
  document.addEventListener('touchmove', () => { touchMoved = true; }, { passive: true });
  document.addEventListener('touchend', (e) => {
    if (e.target.closest('.remote-nav, .remote-picker-overlay, button')) return;
    if (!touchMoved) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
      dx < 0 ? next() : prev();
    }
  });

  /* ── State sync via SSE ────────────────────────────────────────────── */

  function setStatus(text, ok) {
    els.connStatus.textContent = text;
    els.connStatus.dataset.ok = ok ? '1' : '0';
  }

  async function applyPresenterState(data) {
    if (!data) return;
    setStatus('connected', true);

    // If we have a pending goto, check whether this state confirms or conflicts
    if (pendingGoto !== null) {
      const elapsed = Date.now() - pendingTime;
      if (typeof data.slideIndex === 'number' && data.slideIndex === pendingGoto) {
        // Presenter confirmed our goto — clear pending
        pendingGoto = null;
      } else if (elapsed < PENDING_TIMEOUT) {
        // Stale heartbeat from before the goto reached the presenter — ignore
        return;
      } else {
        // Timed out — accept the presenter's authoritative state
        pendingGoto = null;
      }
    }

    const presChanged = data.presentationId && data.presentationId !== STATE.presentationId;
    STATE.presentationId    = data.presentationId    || STATE.presentationId;
    STATE.presentationTitle = data.presentationTitle || STATE.presentationTitle;
    STATE.slideIndex        = typeof data.slideIndex === 'number' ? data.slideIndex : STATE.slideIndex;
    STATE.slideCount        = data.slideCount        || STATE.slideCount;
    STATE.cardIndex         = typeof data.cardIndex === 'number' ? data.cardIndex : -1;

    if (presChanged || !STATE.presentation || STATE.presentation.id !== STATE.presentationId) {
      try {
        STATE.presentation = await ensurePresentationLoaded(STATE.presentationId);
      } catch (e) {
        showRemoteError(`Failed to load presentation: ${e.message}`);
        return;
      }
    }
    render();
  }

  lucidos.sse.connect();

  // Debounce incoming state events — SSE may replay a burst of stored events
  // on connect. We only care about the latest one.
  let pendingStateData = null;
  let stateDebounce = null;
  lucidos.sse.on('SlidePresenterState', (data) => {
    pendingStateData = data;
    if (!stateDebounce) {
      stateDebounce = setTimeout(() => {
        stateDebounce = null;
        applyPresenterState(pendingStateData);
        pendingStateData = null;
      }, 150);
    }
  });

  // Ask the presenter to re-broadcast — handles "remote opened after presenter"
  function pingPresenter() {
    lucidos.events.emit('SlidePresenterPing', {
      summary: 'Remote requesting presenter state',
    }, { transient: true }).catch(() => {});
  }

  /* ── Bootstrap ─────────────────────────────────────────────────────── */

  let connected = false;
  let connectTimeout = null;

  // Override setStatus to track connection
  const _origSetStatus = setStatus;
  setStatus = function(text, ok) {
    if (ok) {
      connected = true;
      if (connectTimeout) { clearTimeout(connectTimeout); connectTimeout = null; }
    }
    _origSetStatus(text, ok);
  };

  (async function init() {
    setStatus('connecting…', false);

    // Optimistically load the last presentation the user had open
    if (SAVED_PRES_ID) {
      STATE.presentationId = SAVED_PRES_ID;
      STATE.slideIndex = SAVED_SLIDE;
      try {
        STATE.presentation = await ensurePresentationLoaded(SAVED_PRES_ID);
      } catch (e) {
        showRemoteError(`Bootstrap load failed: ${e.message}`);
      }
      if (STATE.presentation) {
        STATE.presentationTitle = STATE.presentation.title;
        STATE.slideCount = STATE.presentation.slides.length;
        render();
      }
    } else {
      render();
    }

    // Ask the live presenter for authoritative state via ping
    // (SlidePresenterState is transient — no stored events to query)
    pingPresenter();
    setTimeout(pingPresenter, 800); // retry once in case SSE was still connecting

    // If no presenter responds within 5s, show a helpful message
    connectTimeout = setTimeout(() => {
      if (!connected) {
        setStatus = _origSetStatus; // restore
        _origSetStatus('no presenter found', false);
        els.slideTitle.textContent = 'Presenter not detected';
        els.notesBody.innerHTML =
          '<p style="color:var(--text-dim);">Make sure Super Slides is open in another window or tab.</p>' +
          '<p style="margin-top:.75rem"><button id="retryBtn" style="' +
            'background:var(--accent);color:#fff;border:none;padding:.5rem 1.25rem;' +
            'border-radius:.5rem;font-size:.95rem;cursor:pointer">Retry</button></p>';
        document.getElementById('retryBtn').addEventListener('click', () => {
          connected = false;
          _origSetStatus('connecting…', false);
          els.slideTitle.textContent = 'Reconnecting…';
          els.notesBody.innerHTML = '<em class="remote-notes-empty">No notes for this slide.</em>';
          pingPresenter();
          setTimeout(pingPresenter, 800);
          connectTimeout = setTimeout(() => {
            if (!connected) {
              _origSetStatus('no presenter found', false);
              els.slideTitle.textContent = 'Presenter not detected';
              els.notesBody.innerHTML =
                '<p style="color:var(--text-dim);">Still no presenter. Check that Super Slides is open.</p>' +
                '<p style="margin-top:.75rem"><button onclick="location.reload()" style="' +
                  'background:var(--accent);color:#fff;border:none;padding:.5rem 1.25rem;' +
                  'border-radius:.5rem;font-size:.95rem;cursor:pointer">Reload</button></p>';
            }
          }, 5000);
        });
      }
    }, 5000);
  })();
})();
