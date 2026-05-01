/* ══════════════════════════════════════════════════════
   Super Slides — Engine
   ══════════════════════════════════════════════════════
   Reads from the presentation registry, renders the
   active presentation, and drives all navigation +
   title-scroller + card-focus logic.
   ══════════════════════════════════════════════════════ */

SS.initEngine = function() {
  const registry = window._superSlidesRegistry || [];
  if (!registry.length) {
    SS.showError(
      'No Presentations',
      'The engine started but no presentations were registered. Check that your <code>.slides</code> files loaded correctly.',
      null,
      'engine.js → initEngine()'
    );
    return;
  }

  const app = document.getElementById('app');
  const menuItems = document.getElementById('menuItems');
  const menuBtn = document.getElementById('menuBtn');
  const menuDropdown = document.getElementById('menuDropdown');

  let currentPres = null;
  let slides = [];
  let current = 0;
  let focusedCardIndex = -1;
  let stateSeq = 0;

  // DOM refs populated after render
  let deck, progress, counter, scroller, titleItems, disclaimer, slidePicker, sectionIndicator;

  /* ══════════════════════════════════════
     Menu
     ══════════════════════════════════════ */

  function buildMenu() {
    const items = registry.map((p, i) =>
      `<div class="menu-item${i === 0 ? ' active' : ''}" data-pres="${i}">
        <span class="menu-dot"></span>
        ${p.title}
      </div>`
    ).join('');
    menuItems.innerHTML = items + `
      <div class="menu-separator"></div>
      <div class="menu-item menu-item-action" data-action="remote-mode">
        <span class="menu-dot menu-dot-remote">📱</span>
        Remote mode
      </div>
      <div class="menu-item menu-item-action" data-action="remote">
        <span class="menu-dot menu-dot-remote">⌘</span>
        Open speaker remote
      </div>`;
  }

  function showRemoteModal(url) {
    // Remove existing modal if any
    const existing = document.getElementById('ssRemoteModal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'ssRemoteModal';
    modal.innerHTML = `
      <div class="remote-modal-backdrop"></div>
      <div class="remote-modal-card">
        <h3>Open Speaker Remote</h3>
        <p class="remote-modal-hint">Copy the link and open it in Safari, or use Share to send it to another app.</p>
        <div class="remote-modal-url">${url}</div>
        <div class="remote-modal-actions">
          <button class="remote-modal-btn" data-action="copy">
            <span class="remote-modal-btn-icon">📋</span> Copy Link
          </button>
          ${navigator.share ? `<button class="remote-modal-btn" data-action="share">
            <span class="remote-modal-btn-icon">↗</span> Share
          </button>` : ''}
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    // Close on backdrop click
    modal.querySelector('.remote-modal-backdrop').addEventListener('click', () => modal.remove());

    // Copy
    const copyBtn = modal.querySelector('[data-action="copy"]');
    if (copyBtn) copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(url).then(() => {
        copyBtn.innerHTML = '<span class="remote-modal-btn-icon">✓</span> Copied!';
        setTimeout(() => modal.remove(), 1200);
      });
    });

    // Share (fallback — still available if user wants it)
    const shareBtn = modal.querySelector('[data-action="share"]');
    if (shareBtn) shareBtn.addEventListener('click', () => {
      navigator.share({ title: 'Speaker Remote', url }).catch(() => {});
      modal.remove();
    });
  }

  // Counter (slide-picker) virker perfekt med ÉN click-handler via
  // document-delegering: toggle-på-knapp + close-on-outside i samme
  // listener, med `return` mellom for å hindre at de slår hverandre ut.
  // Speil det mønsteret her — ikke to separate listeners (stopPropagation
  // stopper bare bubbling, ikke andre handlere på samme element, så en
  // close-listener etter en toggle-listener vil alltid vinne).
  // Direct listener on the wrapper itself — iOS Safari sometimes swallows
  // synthetic click events that bubble to document when the original tap
  // lands on padding (halo) rather than a clickable element. Attaching
  // directly to the wrapper bypasses that quirk completely.
  const menuWrapper = document.querySelector('.menu-wrapper');
  if (menuWrapper) {
    // Use pointerup so we react on touch-release without waiting for the
    // synthetic click. Fall back to click for browsers without pointer
    // events. Dedupe via a 400ms guard so both don't fire the toggle.
    let lastToggle = 0;
    function toggleMenu(e) {
      if (e.target.closest('#menuDropdown')) return; // let menu-item handler decide
      const now = Date.now();
      if (now - lastToggle < 400) { e.preventDefault(); return; }
      lastToggle = now;
      e.preventDefault();
      e.stopPropagation();
      menuDropdown.classList.toggle('open');
      if (slidePicker) slidePicker.classList.remove('open');
    }
    menuWrapper.addEventListener('pointerup', toggleMenu);
    menuWrapper.addEventListener('click', toggleMenu);
  }

  // Outside-click closer (separate from the toggle so they can't race).
  document.addEventListener('click', (e) => {
    if (e.target.closest('#menuBtn, .menu-wrapper, #menuDropdown')) return;
    menuDropdown.classList.remove('open');
  });

  menuItems.addEventListener('click', (e) => {
    const item = e.target.closest('.menu-item');
    if (!item) return;
    if (item.dataset.action === 'remote-mode') {
      if (SS.toggleRemoteMode) SS.toggleRemoteMode();
      menuDropdown.classList.remove('open');
      return;
    }
    if (item.dataset.action === 'remote') {
      const remoteUrl = new URL('remote.html', location.href).href;
      const isIOSPwa = /iP(hone|ad|od)/.test(navigator.userAgent) && navigator.standalone;
      if (isIOSPwa) {
        showRemoteModal(remoteUrl);
      } else {
        window.open(remoteUrl, '_blank');
      }
      menuDropdown.classList.remove('open');
      return;
    }
    const idx = parseInt(item.dataset.pres);
    if (registry[idx] && registry[idx] !== currentPres) {
      loadPresentation(registry[idx]);
      menuItems.querySelectorAll('.menu-item').forEach((el, i) => {
        if (el.dataset.action) return;
        el.classList.toggle('active', i === idx);
      });
    }
    menuDropdown.classList.remove('open');
  });

  /* ══════════════════════════════════════
     Render presentation
     ══════════════════════════════════════ */

  function loadPresentation(pres, startSlide) {
    currentPres = pres;
    SS._currentPres = pres;
    startSlide = (startSlide && startSlide > 0 && startSlide < pres.slides.length) ? startSlide : 0;
    current = startSlide;
    focusedCardIndex = -1;

    // Persist active presentation by ID (index is non-deterministic due to parallel loading)
    if (pres.id) localStorage.setItem('ss-pres', pres.id);
    localStorage.setItem('ss-slide', String(current));
    localStorage.setItem('ss-card', '-1');

    // Clear timers from previous presentation
    clearAllTimers();

    let html = '<div class="bg-dots"></div>';
    html += '<div class="progress" id="ssProgress"></div>';
    html += '<div class="counter" id="ssCounter"></div>';
    html += '<div class="slide-picker" id="ssSlidePicker"></div>';

    // Section indicator (only for presentations with sections)
    if (pres.sections) {
      html += '<div class="section-indicator" id="ssSectionIndicator"></div>';
    }

    // Title scroller
    const ts = pres.titleScroller;
    if (ts) {
      html += `<div class="title-scroller" id="ssTitleScroller">
        <p class="persistent-title ss-editable" data-ss-path="titleScroller" data-ss-prop="persistentTitle">${ts.persistentTitle}</p>
        ${pres.subtitle ? `<p class="persistent-subtitle ss-editable" data-ss-path="" data-ss-prop="subtitle">${pres.subtitle}</p>` : ''}
        <div class="title-viewport">
          ${ts.titles.map((t, i) => {
            // Wrap the trailing dot of the first title (e.g. "lucidos.") so it can pulse like a "ready for input" indicator.
            const display = (i === 0 && /\.$/.test(t.text))
              ? t.text.slice(0, -1) + '<span class="lucidos-dot">.</span>'
              : t.text;
            return `<div class="title-item ss-editable" data-title="${i}" data-ss-path="titleScroller.titles[${i}]" data-ss-prop="text">${display}</div>`;
          }).join('')}
        </div>
        ${ts.asterisk ? '<div class="floating-asterisk" id="ssFloatingAsterisk">*</div>' : ''}
        <div class="team-badge"><div class="dot"></div><span class="ss-editable" data-ss-path="titleScroller" data-ss-prop="badge">${ts.badge}</span></div>
      </div>`;
      if (ts.disclaimer) {
        html += `<p class="results-may-vary ss-editable" id="ssDisclaimer" data-ss-path="titleScroller" data-ss-prop="disclaimer">${ts.disclaimer}</p>`;
      }
    }

    // Deck
    html += '<div class="deck" id="ssDeck">';
    pres.slides.forEach((s, i) => {
      const heroClass = s.hero ? ' slide-hero' : '';
      const activeClass = i === current ? ' active' : '';
      html += `<div class="slide${heroClass} center${activeClass}" data-slide="${i}">${s.html}</div>`;
    });
    html += '</div>';

    app.innerHTML = html;

    // Cache refs
    deck = document.getElementById('ssDeck');
    progress = document.getElementById('ssProgress');
    counter = document.getElementById('ssCounter');
    scroller = document.getElementById('ssTitleScroller');
    titleItems = scroller ? scroller.querySelectorAll('.title-item') : [];
    disclaimer = document.getElementById('ssDisclaimer');
    slidePicker = document.getElementById('ssSlidePicker');
    sectionIndicator = document.getElementById('ssSectionIndicator');
    slides = deck.querySelectorAll('.slide');

    // Build section indicator
    buildSectionIndicator(pres);

    // Build slide picker
    buildSlidePicker(pres);

    updateTitleScroller(current);
    updateUI();
    if (SS._broadcastState) SS._broadcastState();
  }

  /* ── App-level tap / swipe navigation ──
     Attached to #app so taps work even when title-scroller
     or other overlays sit on top of the deck.               */
  (function initNavGestures() {
    let touchStartX = 0, touchStartY = 0, touchStartTime = 0, touchMoved = false;
    let touchHandled = false;
    const TAP_MAX_DURATION = 400; // ms — longer holds are not taps

    function isInteractive(e) {
      return e.target.closest('.bottom-bar, .menu-dropdown, .slide-picker, .section-pip, #ssCounter, #menuBtn, .ss-editing');
    }

    app.addEventListener('touchstart', (e) => {
      if (isInteractive(e)) return;
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      touchStartTime = Date.now();
      touchMoved = false;
    }, { passive: true });

    app.addEventListener('touchmove', () => { touchMoved = true; }, { passive: true });

    // True if a picker / menu overlay is currently open. A tap-outside in this
    // state must ONLY dismiss the overlay — it must not navigate slides.
    function overlayOpen() {
      return (slidePicker && slidePicker.classList.contains('open')) ||
             (menuDropdown && menuDropdown.classList.contains('open'));
    }

    function closeOverlays() {
      if (slidePicker) slidePicker.classList.remove('open');
      if (menuDropdown) menuDropdown.classList.remove('open');
    }

    app.addEventListener('touchend', (e) => {
      if (isInteractive(e)) return;
      if (SS.isEditing && SS.isEditing()) return;
      touchHandled = true;
      // If an overlay (picker / menu) is open, a tap outside it just closes it.
      if (overlayOpen()) { closeOverlays(); return; }
      const dx = e.changedTouches[0].clientX - touchStartX;
      const dy = e.changedTouches[0].clientY - touchStartY;
      const holdDuration = Date.now() - touchStartTime;
      // Swipe (horizontal dominant, > 50px)
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
        dx < 0 ? goTo(current + 1) : goTo(current - 1);
        return;
      }
      // Tap (no significant movement AND short hold — reject long-press attempts)
      if (holdDuration < TAP_MAX_DURATION && (!touchMoved || (Math.abs(dx) < 10 && Math.abs(dy) < 10))) {
        const x = e.changedTouches[0].clientX / window.innerWidth;
        if (x > 0.5) goTo(current + 1); else goTo(current - 1);
      }
    });

    // Desktop click fallback (non-touch)
    app.addEventListener('click', (e) => {
      // Suppress synthetic click fired after touchend
      if (touchHandled) { touchHandled = false; return; }
      if (isInteractive(e)) return;
      if (SS.isEditing && SS.isEditing()) return;
      // If an overlay (picker / menu) is open, a click outside it just closes it.
      if (overlayOpen()) { closeOverlays(); return; }
      // Don't navigate when clicking editable text on desktop —
      // single click activates the editor instead.
      // In fullscreen (ss-editing-disabled) editing is off, so navigate normally.
      if (!document.body.classList.contains('ss-editing-disabled') && e.target.closest('.ss-editable, .ss-editing')) return;
      const x = e.clientX / window.innerWidth;
      if (x > 0.5) goTo(current + 1); else goTo(current - 1);
    });
  })();

  /* ══════════════════════════════════════
     Title scroller
     ══════════════════════════════════════ */

  function clearAllTimers() {
    clearTimeout(window._asteriskTimeout);
    clearTimeout(window._pulseTimeout);
    clearTimeout(window._disclaimerTimeout);
    clearTimeout(window._blinkTimeout);
    if (window._disclaimerAnim) { window._disclaimerAnim.cancel(); window._disclaimerAnim = null; }
  }

  function updateTitleScroller(slideIndex) {
    if (!currentPres.titleScroller || !scroller) return;
    const ts = currentPres.titleScroller;
    const TITLE_SLIDE_COUNT = ts.heroSlideCount;

    if (slideIndex >= TITLE_SLIDE_COUNT) {
      scroller.classList.add('hidden');
      clearAllTimers();
      const asterisk = document.getElementById('ssFloatingAsterisk');
      if (asterisk) { asterisk.classList.remove('pulse'); asterisk.style.opacity = '0'; }
      if (disclaimer) { disclaimer.style.opacity = '0'; disclaimer.style.transform = 'none'; }
      return;
    }
    scroller.classList.remove('hidden');

    const vh = window.innerHeight;
    const centerY = vh * 0.48;

    titleItems.forEach((el, i) => {
      const offset = i - slideIndex;
      const t = ts.titles[i];

      const yOff = t.yOffset || 0;

      if (offset === 0) {
        el.style.color = 'var(--accent)';
        el.style.opacity = '1';
        el.style.transform = `translateY(${centerY + yOff}px) translateY(-50%) scale(1)`;
        el.style.textShadow = '0 0 80px rgba(106,150,224,0.35), 0 0 160px rgba(106,150,224,0.15)';
        el.style.filter = 'none';
        el.style.pointerEvents = 'auto';
      } else if (offset < 0) {
        const upDistance = 90 * Math.abs(offset);
        // Keep accent color for already-shown titles — only fade & blur them.
        el.style.color = 'var(--accent)';
        el.style.opacity = Math.max(0.18, 0.45 - Math.abs(offset) * 0.12) + '';
        el.style.transform = `translateY(${centerY + yOff - 80 - upDistance}px) translateY(-50%) scale(${t.restScale})`;
        el.style.textShadow = 'none';
        el.style.filter = 'blur(1px)';
        el.style.pointerEvents = 'none';
      } else {
        const downDistance = 70 * offset;
        // Keep accent color for upcoming titles too — prevents a white flash
        // when navigating backwards (current → upcoming would snap to dim).
        el.style.color = 'var(--accent)';
        el.style.opacity = Math.max(0.05, 0.15 - offset * 0.05) + '';
        el.style.transform = `translateY(${centerY + yOff + 80 + downDistance}px) translateY(-50%) scale(${t.restScale})`;
        el.style.textShadow = 'none';
        el.style.filter = 'blur(1px)';
        el.style.pointerEvents = 'none';
      }
    });

    // Asterisk animation on last title slide
    const asterisk = document.getElementById('ssFloatingAsterisk');
    const marriageWord = document.getElementById('marriageWord');
    const teamBadge = scroller.querySelector('.team-badge');

    if (slideIndex === TITLE_SLIDE_COUNT - 1 && asterisk && marriageWord) {
      asterisk.classList.remove('pulse');
      asterisk.style.opacity = '0';
      if (disclaimer) {
        disclaimer.style.opacity = '0';
        disclaimer.style.transform = 'none';
      }
      if (window._disclaimerAnim) { window._disclaimerAnim.cancel(); window._disclaimerAnim = null; }
      clearAllTimers();

      window._asteriskTimeout = setTimeout(() => {
        const badgeRect = teamBadge.getBoundingClientRect();
        const marriageRect = marriageWord.getBoundingClientRect();
        const titleRect = titleItems[TITLE_SLIDE_COUNT - 1].getBoundingClientRect();

        asterisk.style.left = (marriageRect.right + 2) + 'px';
        asterisk.style.top = (marriageRect.top - 8) + 'px';
        asterisk.classList.add('pulse');

        if (disclaimer) {
          window._disclaimerTimeout = setTimeout(() => {
            const startY = badgeRect.top - 20;
            const targetY = titleRect.bottom + 16;
            const dist = targetY - startY;

            disclaimer.style.top = startY + 'px';
            disclaimer.style.transform = 'none';
            disclaimer.style.opacity = '0';

            window._disclaimerAnim = disclaimer.animate([
              { offset: 0,    opacity: 0,   transform: 'translateY(0)' },
              { offset: 0.08, opacity: 0.1, transform: 'translateY(0)' },
              { offset: 0.20, opacity: 0.4, transform: `translateY(${dist * 0.02}px)` },
              { offset: 0.50, opacity: 0.7, transform: `translateY(${dist * 0.45}px)` },
              { offset: 0.72, opacity: 0.85, transform: `translateY(${dist * 0.92}px)` },
              { offset: 0.82, opacity: 0.9, transform: `translateY(${dist * 1.06}px)` },
              { offset: 0.92, opacity: 0.95, transform: `translateY(${dist * 0.98}px)` },
              { offset: 1,    opacity: 1,   transform: `translateY(${dist}px)` },
            ], { duration: 1600, easing: 'linear', fill: 'forwards' });
          }, 400);
        }
      }, 1250);
    } else {
      clearAllTimers();
      if (asterisk) { asterisk.classList.remove('pulse'); asterisk.style.opacity = '0'; }
      if (disclaimer) { disclaimer.style.opacity = '0'; disclaimer.style.transform = 'none'; }
    }
  }

  /* ══════════════════════════════════════
     Section Indicator
     ══════════════════════════════════════ */

  function buildSectionIndicator(pres) {
    if (!sectionIndicator || !pres.sections) return;
    sectionIndicator.innerHTML = pres.sections.map((sec, i) =>
      `<div class="section-pip" data-section="${i}" style="--sec-color: var(--${sec.color});">
        <span class="pip-dot"></span>
        <span class="pip-label">${sec.title}</span>
      </div>`
    ).join('');
  }

  function getCurrentSection() {
    if (!currentPres || !currentPres.sections) return -1;
    for (let i = currentPres.sections.length - 1; i >= 0; i--) {
      if (current >= currentPres.sections[i].startIndex) return i;
    }
    return 0;
  }

  function updateSectionIndicator() {
    if (!sectionIndicator || !currentPres || !currentPres.sections) return;
    const secIdx = getCurrentSection();
    sectionIndicator.querySelectorAll('.section-pip').forEach((el, i) => {
      el.classList.toggle('active', i === secIdx);
    });
  }

  // Section pip clicks
  document.addEventListener('click', (e) => {
    const pip = e.target.closest('.section-pip');
    if (!pip || !currentPres || !currentPres.sections) return;
    e.stopPropagation();
    const idx = parseInt(pip.dataset.section);
    const sec = currentPres.sections[idx];
    if (sec && current !== sec.startIndex) goTo(sec.startIndex);
  });

  /* ══════════════════════════════════════
     Slide Picker
     ══════════════════════════════════════ */

  function getSlideLabel(pres, i) {
    const s = pres.slides[i];
    // Try to extract a title from the slide data
    if (s.title) return s.title;
    // Fallback: parse the first h2 or h3 from html
    const m = s.html.match(/<h[12][^>]*>(.*?)<\/h[12]>/);
    if (m) return m[1].replace(/<[^>]+>/g, '');
    if (i === 0) return 'Title';
    return 'Slide ' + (i + 1);
  }

  function buildSlidePicker(pres) {
    if (!slidePicker) return;
    if (pres.sections) {
      slidePicker.innerHTML = pres.sections.map((sec) => {
        const items = [];
        for (let i = sec.startIndex; i <= sec.endIndex; i++) {
          items.push(
            `<div class="slide-picker-item${i === current ? ' active' : ''}" data-slide="${i}">
              <span class="picker-num">${i + 1}</span>
              <span>${getSlideLabel(pres, i)}</span>
            </div>`
          );
        }
        return `<div class="picker-section">
          <div class="picker-section-label" style="color: var(--${sec.color});">${sec.title}</div>
          ${items.join('')}
        </div>`;
      }).join('');
    } else {
      slidePicker.innerHTML = pres.slides.map((_, i) =>
        `<div class="slide-picker-item${i === current ? ' active' : ''}" data-slide="${i}">
          <span class="picker-num">${i + 1}</span>
          <span>${getSlideLabel(pres, i)}</span>
        </div>`
      ).join('');
    }
  }

  function updatePickerActive() {
    if (!slidePicker) return;
    slidePicker.querySelectorAll('.slide-picker-item').forEach((el, i) => {
      el.classList.toggle('active', i === current);
    });
    // Scroll active item into view
    const active = slidePicker.querySelector('.slide-picker-item.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  // Counter click toggles picker
  document.addEventListener('click', (e) => {
    if (e.target.closest('#ssCounter')) {
      e.stopPropagation();
      if (slidePicker) slidePicker.classList.toggle('open');
      menuDropdown.classList.remove('open');
      return;
    }
    const pickerItem = e.target.closest('.slide-picker-item');
    if (pickerItem) {
      e.stopPropagation();
      const idx = parseInt(pickerItem.dataset.slide);
      if (idx !== current) goTo(idx);
      slidePicker.classList.remove('open');
      return;
    }
    // Close picker on outside click
    if (slidePicker) slidePicker.classList.remove('open');
  });

  /* ══════════════════════════════════════
     Navigation
     ══════════════════════════════════════ */

  function goTo(n) {
    if (n < 0 || n >= slides.length || n === current) return;
    const oldSlide = slides[current];
    focusedCardIndex = -1;
    localStorage.setItem('ss-card', '-1');
    oldSlide.classList.remove('active');
    setTimeout(() => {
      oldSlide.classList.remove('has-card-focus', 'insight-focused');
      delete oldSlide.dataset.cardFocus;
      oldSlide.querySelectorAll('.card-focused').forEach(c => c.classList.remove('card-focused'));
    }, 450);
    current = n;
    localStorage.setItem('ss-slide', current);
    slides[current].classList.add('active');
    if (slidePicker) slidePicker.classList.remove('open');
    updateTitleScroller(current);
    updateUI();
    broadcastState();
  }

  function updateUI() {
    if (progress) progress.style.width = ((current + 1) / slides.length) * 100 + '%';
    if (counter) counter.textContent = (current + 1) + ' / ' + slides.length;
    updatePickerActive();
    updateSectionIndicator();

    // Tint progress bar to current section color
    if (currentPres && currentPres.sections) {
      const secIdx = getCurrentSection();
      if (secIdx >= 0) {
        const sec = currentPres.sections[secIdx];
        progress.style.background = `linear-gradient(90deg, var(--${sec.color}), var(--${sec.color === 'accent' ? 'cyan' : sec.color}))`;
      }
    } else {
      if (progress) progress.style.background = '';
    }
  }

  /* ══════════════════════════════════════
     Card focus system
     ══════════════════════════════════════ */

  function getFocusables(slide) {
    const items = Array.from(slide.querySelectorAll('.card'));
    const takeaways = Array.from(slide.querySelectorAll('.takeaway-item'));
    items.push(...takeaways);
    const insight = slide.querySelector('.insight');
    if (insight) items.push(insight);
    return items;
  }

  function clearCardFocus() {
    const slide = slides[current];
    slide.classList.remove('has-card-focus', 'insight-focused');
    delete slide.dataset.cardFocus;
    slide.querySelectorAll('.card-focused').forEach(c => c.classList.remove('card-focused'));
    focusedCardIndex = -1;
    localStorage.setItem('ss-card', '-1');
  }

  function focusCard(index) {
    const slide = slides[current];
    const items = getFocusables(slide);
    if (!items.length) return false;
    if (index < 0 || index >= items.length) return false;

    slide.classList.add('has-card-focus');
    slide.dataset.cardFocus = String(index);
    items.forEach(c => c.classList.remove('card-focused'));
    items[index].classList.add('card-focused');
    focusedCardIndex = index;
    localStorage.setItem('ss-card', index);

    if (items[index].classList.contains('insight')) {
      slide.classList.add('insight-focused');
    } else {
      slide.classList.remove('insight-focused');
    }
    return true;
  }

  function isMultiCardSlide() {
    return getFocusables(slides[current]).length >= 2;
  }

  /* ══════════════════════════════════════
     Keyboard
     ══════════════════════════════════════ */

  document.addEventListener('keydown', (e) => {
    if (!currentPres) return;
    // Don't navigate while editing text
    if (SS.isEditing && SS.isEditing()) return;

    if (e.key === 'ArrowUp' || e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      goTo(current + 1);
    } else if (e.key === 'ArrowDown' || e.key === 'Backspace') {
      e.preventDefault();
      goTo(current - 1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (isMultiCardSlide()) {
        const items = getFocusables(slides[current]);
        if (focusedCardIndex === -1) {
          focusCard(0); broadcastState();
        } else if (focusedCardIndex < items.length - 1) {
          focusCard(focusedCardIndex + 1); broadcastState();
        } else {
          goTo(current + 1);
        }
      } else {
        goTo(current + 1);
      }
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (isMultiCardSlide()) {
        if (focusedCardIndex > 0) {
          focusCard(focusedCardIndex - 1); broadcastState();
        } else if (focusedCardIndex === 0) {
          clearCardFocus(); broadcastState();
        } else {
          goTo(current - 1);
        }
      } else {
        goTo(current - 1);
      }
    }
  });

  window.addEventListener('resize', () => {
    if (currentPres) updateTitleScroller(current);
  });

  /* ══════════════════════════════════════
     Init
     ══════════════════════════════════════ */

  buildMenu();

  // Restore saved state (saved by presentation ID, not index)
  const savedPresId = localStorage.getItem('ss-pres');
  const savedSlide = parseInt(localStorage.getItem('ss-slide')) || 0;
  const savedCard = parseInt(localStorage.getItem('ss-card'));
  const startPres = savedPresId
    ? Math.max(0, registry.findIndex(p => p.id === savedPresId))
    : 0;

  loadPresentation(registry[startPres], savedSlide);

  if (startPres > 0) {
    menuItems.querySelectorAll('.menu-item').forEach((el, i) => {
      if (el.dataset.action) return;
      el.classList.toggle('active', i === startPres);
    });
  }

  if (savedCard >= 0) {
    focusCard(savedCard);
  }

  /* ══════════════════════════════════════
     Remote control via SSE
     ══════════════════════════════════════ */

  // Broadcast the current presenter state (called after navigation
  // and on a heartbeat so a freshly-opened remote can sync up).
  function broadcastState() {
    if (!currentPres || !window.lucidos) return;
    stateSeq++;
    const cardCount = getFocusables(slides[current]).length;
    lucidos.events.emit('SlidePresenterState', {
      summary: `Slide ${current + 1}/${slides.length}: ${currentPres.title}`,
      presentationId: currentPres.id,
      presentationTitle: currentPres.title,
      slideIndex: current,
      slideCount: slides.length,
      slideTitle: getSlideLabel(currentPres, current),
      cardIndex: focusedCardIndex,
      cardCount: cardCount,
      seq: stateSeq,
    }, { transient: true }).catch(err => console.warn('[SS] broadcast failed:', err));
  }

  // Expose for inner functions added before this point
  SS._broadcastState = broadcastState;

  // Listen for remote commands
  if (window.lucidos) {
    lucidos.sse.connect();

    lucidos.sse.on('SlideRemoteCommand', (data) => {
      if (!data || !currentPres) return;

      // ── Absolute-state protocol ────────────────────────
      // Every command carries the full target state:
      //   { action: 'setState', presentationId, slideIndex, cardIndex }
      // The presenter reconciles to that state — no relative ops, no drift.
      //
      // Legacy 'sync' is also accepted (remote asking for a re-broadcast).
      if (data.action === 'sync') { broadcastState(); return; }
      if (data.action !== 'setState') return; // ignore unknown / legacy actions

      const targetPresId   = data.presentationId;
      const targetSlideIdx = typeof data.slideIndex === 'number' ? data.slideIndex : current;
      const targetCardIdx  = typeof data.cardIndex  === 'number' ? data.cardIndex  : -1;

      // 1. Reconcile presentation
      if (targetPresId && targetPresId !== currentPres.id) {
        const idx = registry.findIndex(p => p.id === targetPresId);
        if (idx >= 0) {
          loadPresentation(registry[idx], targetSlideIdx);
          menuItems.querySelectorAll('.menu-item').forEach((el, i) => {
            if (el.dataset.action) return;
            el.classList.toggle('active', i === idx);
          });
          // loadPresentation broadcasts; now reconcile card if requested.
          if (targetCardIdx >= 0) {
            if (focusCard(targetCardIdx)) broadcastState();
          }
          return;
        }
        // Unknown presentation — ignore (don't move within current deck either).
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

    // Re-broadcast on resync requests (remote opens later — ping is transient)
    lucidos.sse.on('SlidePresenterPing', () => broadcastState());

    // Initial announce so any open remote picks us up
    setTimeout(broadcastState, 200);
  }
};
