/* ══════════════════════════════════════════════════════
   Super Slides — Embedded Remote Mode (v2)
   Minimalist remote control overlay.
   ══════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── Inject DOM ──────────────────────────────────── */

  const container = document.createElement('div');
  container.className = 'rm-container';
  container.id = 'rmContainer';
  container.hidden = true;
  container.innerHTML = `
    <!-- Connection overlay -->
    <div class="rm-conn" id="rmConn">
      <div class="rm-conn-dot"></div>
      <p class="rm-conn-msg" id="rmConnMsg">Connecting…</p>
      <button class="rm-retry" id="rmRetry" hidden>Try again</button>
    </div>

    <!-- Main UI (shown when connected) -->
    <div class="rm-main" id="rmMain" hidden>
      <nav class="rm-nav">
        <button class="rm-nav-btn rm-slide-btn" id="rmSlidePrev" title="Prev slide">«</button>
        <button class="rm-nav-btn rm-card-btn" id="rmCardPrev" title="Prev card">‹</button>
        <button class="rm-counter" id="rmCounter" title="Jump to slide">—</button>
        <button class="rm-nav-btn rm-card-btn" id="rmCardNext" title="Next card">›</button>
        <button class="rm-nav-btn rm-slide-btn" id="rmSlideNext" title="Next slide">»</button>
        <button class="rm-exit" id="rmExit" title="Exit">✕</button>
      </nav>

      <div class="rm-timer" id="rmTimer">
        <div class="rm-timer-row">
          <button class="rm-timer-start" id="rmTimerStart">Start</button>
          <span class="rm-timer-elapsed" id="rmElapsed">0:00</span>
          <span class="rm-timer-pace" id="rmPace"></span>
          <span class="rm-timer-est" id="rmEst"></span>
        </div>
        <div class="rm-timer-track">
          <div class="rm-timer-fill" id="rmTimerFill"></div>
        </div>
      </div>

      <div class="rm-body">
        <section class="rm-slide-info">
          <span class="rm-section" id="rmSection" hidden></span>
          <h1 class="rm-title" id="rmTitle"></h1>
          <p class="rm-next" id="rmNext" hidden></p>
        </section>

        <div class="rm-notes">
          <div class="rm-notes-bar">
            <span class="rm-notes-label" id="rmNotesLabel">Notes</span>
            <button class="rm-save" id="rmSave" hidden>Save</button>
          </div>
          <textarea class="rm-editor" id="rmEditor"
                    placeholder="No notes for this slide…"></textarea>
        </div>
      </div>
    </div>

    <!-- Picker overlay -->
    <div class="rm-picker" id="rmPicker" hidden>
      <div class="rm-picker-sheet">
        <header class="rm-picker-head">
          <div class="rm-tabs">
            <button class="rm-tab active" data-tab="slides">Slides</button>
            <button class="rm-tab" data-tab="presentations">Presentations</button>
          </div>
          <button class="rm-picker-x" id="rmPickerX">✕</button>
        </header>
        <div class="rm-picker-body" id="rmPickerBody"></div>
      </div>
    </div>`;
  document.body.appendChild(container);

  /* ── Element refs ────────────────────────────────── */

  const $ = (id) => document.getElementById(id);
  const el = {
    container,
    conn:       $('rmConn'),
    connMsg:    $('rmConnMsg'),
    retry:      $('rmRetry'),
    main:       $('rmMain'),
    exit:       $('rmExit'),
    slidePrev:  $('rmSlidePrev'),
    slideNext:  $('rmSlideNext'),
    cardPrev:   $('rmCardPrev'),
    cardNext:   $('rmCardNext'),
    counter:    $('rmCounter'),
    section:    $('rmSection'),
    title:      $('rmTitle'),
    next:       $('rmNext'),
    editor:     $('rmEditor'),
    save:       $('rmSave'),
    notesLabel: $('rmNotesLabel'),
    picker:     $('rmPicker'),
    pickerBody: $('rmPickerBody'),
    tabs:       container.querySelectorAll('.rm-tab'),
    timerStart: $('rmTimerStart'),
    elapsed:    $('rmElapsed'),
    pace:       $('rmPace'),
    est:        $('rmEst'),
    timerFill:  $('rmTimerFill'),
  };

  /* ── State ───────────────────────────────────────── */

  const S = {
    active: false,
    connected: false,
    presentationId: null,
    presentationTitle: null,
    slideIndex: 0,
    slideCount: 0,
    cardIndex: -1,
    cardCount: 0,
    pres: null,          // registry entry
    notesDirty: false,
    notesOriginal: '',
    pickerTab: 'slides',
    timerRunning: false,
    timerStart: null,      // Date.now() when started
    timerElapsed: 0,       // ms elapsed (accumulated across pauses)
  };

  let connTimer = null;
  const CONN_TIMEOUT = 5000;

  /* ── Helpers ─────────────────────────────────────── */

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  function getPresById(id) {
    return (window._superSlidesRegistry || []).find(p => p.id === id) || null;
  }

  function getSectionFor(pres, idx) {
    if (!pres?.sections) return null;
    for (let i = pres.sections.length - 1; i >= 0; i--) {
      if (idx >= pres.sections[i].startIndex) return pres.sections[i];
    }
    return null;
  }

  function slideTitle(pres, idx) {
    if (!pres?.slides[idx]) return `Slide ${idx + 1}`;
    const s = pres.slides[idx];
    if (s.title) return s.title;
    const m = (s.html || '').match(/<h[12][^>]*>(.*?)<\/h[12]>/);
    if (m) return m[1].replace(/<[^>]+>/g, '');
    return idx === 0 ? 'Title' : `Slide ${idx + 1}`;
  }

  /* ── Commands ────────────────────────────────────── */

  // Absolute-state protocol: every command carries the full target state.
  // The presenter reconciles to it. No relative ops, no drift.
  function sendState(extra) {
    const payload = Object.assign({
      summary: 'Remote: setState',
      action: 'setState',
      presentationId: S.presentationId,
      slideIndex: S.slideIndex,
      cardIndex: S.cardIndex,
    }, extra || {});
    lucidos.events.emit('SlideRemoteCommand', payload, { transient: true })
      .catch(e => console.warn('[rm] send failed:', e));
  }

  function sendSync() {
    lucidos.events.emit('SlideRemoteCommand', {
      summary: 'Remote: sync',
      action: 'sync',
      presentationId: S.presentationId,
    }, { transient: true }).catch(() => {});
  }

  /* ── Connection state ────────────────────────────── */

  function showConnecting() {
    S.connected = false;
    el.conn.classList.remove('rm-fail');
    el.connMsg.textContent = 'Connecting…';
    el.retry.hidden = true;
    el.conn.hidden = false;
    el.main.hidden = true;

    clearTimeout(connTimer);
    connTimer = setTimeout(() => {
      if (!S.connected && S.active) showFailed();
    }, CONN_TIMEOUT);
  }

  function showFailed() {
    el.conn.classList.add('rm-fail');
    el.connMsg.textContent = 'Could not connect';
    el.retry.hidden = false;
  }

  function showConnected() {
    S.connected = true;
    clearTimeout(connTimer);
    el.conn.hidden = true;
    el.main.hidden = false;
  }

  function ping() {
    lucidos.events.emit('SlidePresenterPing', {
      summary: 'Embedded remote requesting state',
    }, { transient: true }).catch(() => {});
  }

  el.retry.addEventListener('click', () => {
    showConnecting();
    ping();
  });

  /* ── Render ──────────────────────────────────────── */

  function render() {
    const p = S.pres;
    const hasCards = S.cardCount >= 2;

    // Counter: "x / y" or "x / y · c"
    let ctr = S.slideCount ? `${S.slideIndex + 1} / ${S.slideCount}` : '—';
    if (hasCards && S.cardIndex >= 0) ctr += ` · ${S.cardIndex + 1}`;
    el.counter.textContent = ctr;

    // Card buttons — stay white as long as there is more content
    // in that direction (either another card on this slide, or another
    // slide to fall through to). Only dim when there's nothing further.
    const hasPrev =
      (hasCards && S.cardIndex >= 0) || S.slideIndex > 0;
    const hasNext =
      (hasCards && S.cardIndex + 1 < S.cardCount) ||
      (S.slideCount > 0 && S.slideIndex + 1 < S.slideCount);
    el.cardPrev.classList.toggle('rm-no-cards', !hasPrev);
    el.cardNext.classList.toggle('rm-no-cards', !hasNext);

    // Section
    if (p) {
      const sec = getSectionFor(p, S.slideIndex);
      if (sec) {
        el.section.hidden = false;
        el.section.textContent = sec.title;
        el.section.style.setProperty('--rm-sec-color', 'var(--' + (sec.color || 'accent') + ')');
      } else {
        el.section.hidden = true;
      }
      el.title.textContent = slideTitle(p, S.slideIndex);

      // Next up
      const ni = S.slideIndex + 1;
      if (ni < p.slides.length) {
        el.next.textContent = 'Next: ' + slideTitle(p, ni);
        el.next.hidden = false;
      } else {
        el.next.hidden = true;
      }
    } else {
      el.section.hidden = true;
      el.title.textContent = S.presentationTitle || '';
      el.next.hidden = true;
    }

    // Notes
    loadNotesIfChanged();

    // Timer
    renderTimer();

    // Picker (if open)
    if (!el.picker.hidden) buildPickerContent();
  }

  /* ── Notes ───────────────────────────────────────── */

  let lastNK = null;
  function nk() { return S.presentationId + ':' + S.slideIndex + ':' + S.cardIndex; }

  function loadNotesIfChanged() {
    const key = nk();
    if (key === lastNK) return;
    if (S.notesDirty) saveNotes();
    lastNK = key;
    S.notesDirty = false;
    el.save.hidden = true;
    el.save.classList.remove('rm-saved');
    el.save.textContent = 'Save';

    const slide = S.pres?.slides[S.slideIndex];
    let notes = '';
    if (S.cardIndex >= 0 && slide?.cardNotes?.[S.cardIndex]) {
      notes = slide.cardNotes[S.cardIndex];
    } else if (S.cardIndex >= 0) {
      notes = '';
    } else {
      notes = slide?.notes || '';
    }

    if (S.cardIndex >= 0) {
      el.notesLabel.textContent = `Notes · Card ${S.cardIndex + 1}`;
      el.editor.placeholder = 'No notes for this card…';
    } else {
      el.notesLabel.textContent = 'Notes';
      el.editor.placeholder = 'No notes for this slide…';
    }

    el.editor.value = notes;
    S.notesOriginal = notes;
  }

  async function saveNotes() {
    const slide = S.pres?.slides[S.slideIndex];
    if (!slide) return;
    const val = el.editor.value;
    const isCardNote = S.cardIndex >= 0;
    try {
      if (isCardNote) {
        const cn = Array.isArray(slide.cardNotes) ? [...slide.cardNotes] : [];
        while (cn.length <= S.cardIndex) cn.push('');
        cn[S.cardIndex] = val;
        await lucidos.data.edit(S.pres.sourceFile, [
          { json_path: slide.path + '.cardNotes', json_value: cn }
        ]);
        slide.cardNotes = cn;
      } else {
        await lucidos.data.edit(S.pres.sourceFile, [
          { json_path: slide.path + '.notes', json_value: val || '' }
        ]);
        slide.notes = val;
      }
      S.notesOriginal = val;
      S.notesDirty = false;
      el.save.textContent = 'Saved ✓';
      el.save.classList.add('rm-saved');
      setTimeout(() => {
        if (!S.notesDirty) el.save.hidden = true;
        el.save.classList.remove('rm-saved');
        el.save.textContent = 'Save';
      }, 1500);
    } catch (e) {
      console.error('[rm] save notes failed:', e);
      el.save.textContent = 'Error';
      setTimeout(() => { el.save.textContent = 'Save'; }, 2000);
    }
  }

  el.editor.addEventListener('input', () => {
    const changed = el.editor.value !== S.notesOriginal;
    S.notesDirty = changed;
    el.save.hidden = !changed;
    el.save.classList.remove('rm-saved');
    el.save.textContent = 'Save';
  });
  el.save.addEventListener('click', saveNotes);

  /* ── Picker ──────────────────────────────────────── */

  function openPicker() {
    S.pickerTab = 'slides';
    syncTabs();
    buildPickerContent();
    el.picker.hidden = false;
  }

  function closePicker() {
    el.picker.hidden = true;
  }

  function syncTabs() {
    el.tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === S.pickerTab));
  }

  // Tab clicks
  container.querySelector('.rm-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.rm-tab');
    if (!tab) return;
    S.pickerTab = tab.dataset.tab;
    syncTabs();
    buildPickerContent();
  });

  function buildPickerContent() {
    if (S.pickerTab === 'presentations') {
      buildPresPicker();
    } else {
      buildSlidePicker();
    }
  }

  function buildSlidePicker() {
    const p = S.pres;
    if (!p) {
      el.pickerBody.innerHTML = '<div style="padding:24px;text-align:center;color:#52525b">No presentation loaded</div>';
      return;
    }
    let html = '';
    if (p.sections) {
      p.sections.forEach(sec => {
        html += `<div class="rm-picker-section" style="color:var(--${sec.color || 'accent'})">${esc(sec.title)}</div>`;
        for (let i = sec.startIndex; i <= sec.endIndex; i++) html += slideItem(p, i);
      });
    } else {
      p.slides.forEach((_, i) => { html += slideItem(p, i); });
    }
    el.pickerBody.innerHTML = html;
    const active = el.pickerBody.querySelector('.rm-picker-item.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  function slideItem(p, i) {
    const act = i === S.slideIndex;
    return `<button class="rm-picker-item${act ? ' active' : ''}" data-action="slide" data-index="${i}">
      <span class="rm-picker-num">${i + 1}</span>
      <span class="rm-picker-label">${esc(slideTitle(p, i))}</span>
    </button>`;
  }

  function buildPresPicker() {
    const reg = window._superSlidesRegistry || [];
    if (!reg.length) {
      el.pickerBody.innerHTML = '<div style="padding:24px;text-align:center;color:#52525b">No presentations found</div>';
      return;
    }
    el.pickerBody.innerHTML = reg.map((p, i) => {
      const act = p.id === S.presentationId;
      return `<button class="rm-picker-item${act ? ' active' : ''}" data-action="pres" data-id="${esc(p.id)}">
        <span class="rm-picker-num">${i + 1}</span>
        <span class="rm-picker-label">${esc(p.title)}</span>
      </button>`;
    }).join('');
  }

  // Picker item clicks (optimistic update for slides)
  el.pickerBody.addEventListener('click', (e) => {
    const btn = e.target.closest('.rm-picker-item');
    if (!btn) return;
    if (btn.dataset.action === 'slide') {
      const idx = parseInt(btn.dataset.index);
      if (optimisticGoto(idx)) sendState();
    } else if (btn.dataset.action === 'pres') {
      const id = btn.dataset.id;
      if (id !== S.presentationId) {
        // Optimistically update so subsequent next/prev carry the new ID
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
        sendState();
      }
    }
    closePicker();
  });

  $('rmPickerX').addEventListener('click', closePicker);
  el.picker.addEventListener('click', (e) => {
    if (e.target === el.picker) closePicker();
  });

  el.counter.addEventListener('click', openPicker);

  /* ── Navigation ──────────────────────────────────── */

  // Optimistically update local state so subsequent clicks see the
  // intended state instead of stale values from before the next
  // SlidePresenterState broadcast (~80ms round-trip).
  let pendingSlide = null;
  let pendingTime = 0;
  const PENDING_TIMEOUT = 3000;

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
  function optimisticFocusCard(idx) {
    S.cardIndex = idx;
    render();
  }
  function optimisticClearCard() {
    S.cardIndex = -1;
    render();
  }

  el.slidePrev.addEventListener('click', () => {
    if (!optimisticGoto(S.slideIndex - 1)) return;
    sendState();
  });
  el.slideNext.addEventListener('click', () => {
    if (!optimisticGoto(S.slideIndex + 1)) return;
    sendState();
  });
  el.exit.addEventListener('click', () => SS.closeRemoteMode());

  el.cardPrev.addEventListener('click', () => {
    if (S.cardCount >= 2 && S.cardIndex > 0) {
      optimisticFocusCard(S.cardIndex - 1);
      sendState();
    } else if (S.cardCount >= 2 && S.cardIndex === 0) {
      optimisticClearCard();
      sendState();
    } else {
      if (!optimisticGoto(S.slideIndex - 1)) return;
      sendState();
    }
  });
  el.cardNext.addEventListener('click', () => {
    if (S.cardCount >= 2) {
      const next = S.cardIndex + 1;
      if (next < S.cardCount) {
        optimisticFocusCard(next);
        sendState();
      } else {
        if (!optimisticGoto(S.slideIndex + 1)) return;
        sendState();
      }
    } else {
      if (!optimisticGoto(S.slideIndex + 1)) return;
      sendState();
    }
  });

  /* ── Keyboard ────────────────────────────────────── */

  document.addEventListener('keydown', (e) => {
    if (!S.active) return;
    if (e.target.matches('input, textarea, [contenteditable]')) return;

    if (e.key === 'ArrowRight' || e.key === ' ') {
      e.preventDefault();
      if (optimisticGoto(S.slideIndex + 1)) sendState();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (optimisticGoto(S.slideIndex - 1)) sendState();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (!el.picker.hidden) closePicker();
      else SS.closeRemoteMode();
    } else if (e.key === 'g') {
      e.preventDefault(); openPicker();
    }
  });

  /* ── Touch swipe ─────────────────────────────────── */

  let tx = 0, moved = false;
  el.container.addEventListener('touchstart', (e) => {
    if (e.target.closest('button, textarea, .rm-picker')) return;
    tx = e.touches[0].clientX;
    moved = false;
  }, { passive: true });
  el.container.addEventListener('touchmove', () => { moved = true; }, { passive: true });
  el.container.addEventListener('touchend', (e) => {
    if (e.target.closest('button, textarea, .rm-picker')) return;
    if (!moved) return;
    const dx = e.changedTouches[0].clientX - tx;
    if (Math.abs(dx) > 50) {
      const target = dx < 0 ? S.slideIndex + 1 : S.slideIndex - 1;
      if (optimisticGoto(target)) sendState();
    }
  });

  /* ── SSE: receive presenter state ────────────────── */

  let debounce = null, pending = null;

  lucidos.sse.on('SlidePresenterState', (data) => {
    if (!S.active) return;
    pending = data;
    if (!debounce) {
      debounce = setTimeout(() => {
        debounce = null;
        applyState(pending);
        pending = null;
      }, 80);
    }
  });

  function applyState(data) {
    if (!data) return;
    if (!S.connected) showConnected();

    const presChanged = data.presentationId && data.presentationId !== S.presentationId;

    // Reject stale broadcasts that disagree with our pending optimistic goto.
    // Without this, a broadcast in flight from before the goto reaches the
    // presenter will revert the UI to an earlier slide.
    //
    // EXCEPTION: when the broadcast carries a different presentationId, the
    // presenter has switched presentations (e.g. desktop user picked a new
    // one from the menu). A presentation switch always wins — otherwise the
    // remote stays stuck on the old presentation while the desktop moved on.
    if (!presChanged && pendingSlide !== null && typeof data.slideIndex === 'number') {
      if (data.slideIndex === pendingSlide) {
        pendingSlide = null;
      } else if (Date.now() - pendingTime < PENDING_TIMEOUT) {
        return;
      } else {
        pendingSlide = null;
      }
    } else if (presChanged) {
      // Pending referred to the old presentation — drop it.
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

  /* ── Timer ─────────────────────────────────────── */

  const SECS_PER_SLIDE = 120; // 2 min per slide estimate
  let timerInterval = null;

  function fmtTime(ms) {
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  function getElapsedMs() {
    if (!S.timerRunning) return S.timerElapsed;
    return S.timerElapsed + (Date.now() - S.timerStart);
  }

  function estimatedMs() {
    return (S.slideCount || 1) * SECS_PER_SLIDE * 1000;
  }

  function renderTimer() {
    const elapsed = getElapsedMs();
    const est = estimatedMs();
    el.elapsed.textContent = fmtTime(elapsed);
    el.est.textContent = fmtTime(est);

    const pct = Math.min(100, (elapsed / est) * 100);
    el.timerFill.style.width = pct + '%';

    // Pace: compare expected slide position vs actual
    if (S.timerRunning && S.slideCount > 0 && elapsed > 0) {
      const expectedSlide = (elapsed / est) * S.slideCount;
      const actual = S.slideIndex + 1;
      const diff = actual - expectedSlide;
      if (diff >= -0.5) {
        el.pace.textContent = 'On track';
        el.pace.className = 'rm-timer-pace rm-pace-ok';
        el.timerFill.className = 'rm-timer-fill rm-fill-ok';
      } else {
        el.pace.textContent = 'Speed up';
        el.pace.className = 'rm-timer-pace rm-pace-slow';
        el.timerFill.className = 'rm-timer-fill rm-fill-slow';
      }
    } else if (!S.timerRunning && S.timerElapsed > 0) {
      // paused — keep last label
    } else {
      el.pace.textContent = '';
      el.timerFill.className = 'rm-timer-fill';
    }

    // Over time
    if (elapsed > est) {
      el.timerFill.className = 'rm-timer-fill rm-fill-over';
      el.pace.textContent = 'Over time';
      el.pace.className = 'rm-timer-pace rm-pace-slow';
    }
  }

  function startTimer() {
    S.timerRunning = true;
    S.timerStart = Date.now();
    el.timerStart.textContent = 'Pause';
    el.timerStart.classList.add('rm-timer-running');
    timerInterval = setInterval(renderTimer, 1000);
    renderTimer();
  }

  function pauseTimer() {
    S.timerElapsed += Date.now() - S.timerStart;
    S.timerRunning = false;
    S.timerStart = null;
    el.timerStart.textContent = 'Resume';
    el.timerStart.classList.remove('rm-timer-running');
    clearInterval(timerInterval);
    timerInterval = null;
    renderTimer();
  }

  function resetTimer() {
    S.timerRunning = false;
    S.timerStart = null;
    S.timerElapsed = 0;
    el.timerStart.textContent = 'Start';
    el.timerStart.classList.remove('rm-timer-running');
    clearInterval(timerInterval);
    timerInterval = null;
    el.pace.textContent = '';
    el.pace.className = 'rm-timer-pace';
    el.timerFill.className = 'rm-timer-fill';
    el.timerFill.style.width = '0%';
    renderTimer();
  }

  el.timerStart.addEventListener('click', () => {
    if (S.timerRunning) pauseTimer();
    else startTimer();
  });

  /* ── Public API ──────────────────────────────────── */

  SS.toggleRemoteMode = function () {
    if (S.active) {
      SS.closeRemoteMode();
    } else {
      S.active = true;
      container.hidden = false;
      localStorage.setItem('ss-mode', 'remote');
      showConnecting();
      ping();
    }
  };

  SS.closeRemoteMode = function () {
    if (S.notesDirty) saveNotes();
    S.active = false;
    S.connected = false;
    clearTimeout(connTimer);
    resetTimer();
    localStorage.setItem('ss-mode', 'presenter');
    container.hidden = true;
  };
})();
