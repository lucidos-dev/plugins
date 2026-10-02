/* ══════════════════════════════════════
   Zoom / UI scale
   ══════════════════════════════════════
   Scales the slide stage (#app) with CSS zoom. Slides are px-sized, so zoom
   is the one knob that scales text, cards and spacing together. The stage
   height is divided by the zoom (see styles.css) so it still fills the
   viewport. Persisted in SS.appState under 'zoom'.

   Keys:   Ctrl/Cmd + "+"  /  "-"  /  "0"
   Wheel:  Ctrl/Cmd + wheel (also pinch on a trackpad)
   Menu:   the −/+ buttons in the bottom bar
*/
(function () {
  const MIN = 0.5, MAX = 2.5, STEP = 0.1;
  let zoom = 1;

  function clamp(z) { return Math.min(MAX, Math.max(MIN, Math.round(z * 100) / 100)); }

  function apply(persist) {
    document.documentElement.style.setProperty('--ss-zoom', String(zoom));
    const label = document.getElementById('ssZoomLabel');
    if (label) label.textContent = Math.round(zoom * 100) + '%';
    // The title scroller positions itself from the viewport height.
    window.dispatchEvent(new Event('resize'));
    if (persist && SS.appState) SS.appState.set('zoom', zoom);
  }

  function set(z, persist) { zoom = clamp(z); apply(persist !== false); }

  SS.zoom = {
    get value() { return zoom; },
    set: set,
    in: () => set(zoom + STEP),
    out: () => set(zoom - STEP),
    reset: () => set(1),
  };

  // Bottom-bar controls
  const bar = document.querySelector('.bottom-bar');
  if (bar) {
    const box = document.createElement('div');
    box.className = 'ss-zoom-ctl';
    box.innerHTML =
      '<button type="button" id="ssZoomOut" title="Zoom out (Ctrl -)">−</button>' +
      '<button type="button" id="ssZoomLabel" title="Reset zoom (Ctrl 0)">100%</button>' +
      '<button type="button" id="ssZoomIn" title="Zoom in (Ctrl +)">+</button>';
    bar.appendChild(box);
    box.querySelector('#ssZoomOut').addEventListener('click', SS.zoom.out);
    box.querySelector('#ssZoomIn').addEventListener('click', SS.zoom.in);
    box.querySelector('#ssZoomLabel').addEventListener('click', SS.zoom.reset);
  }

  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    if (e.key === '+' || e.key === '=') { e.preventDefault(); SS.zoom.in(); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); SS.zoom.out(); }
    else if (e.key === '0') { e.preventDefault(); SS.zoom.reset(); }
  });

  document.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    set(zoom * Math.exp(-e.deltaY * 0.01));
  }, { passive: false });

  // Restore the saved zoom once the (async) state document has been read.
  if (SS.appState) {
    SS.appState.ready().then(() => {
      const saved = SS.appState.get('zoom', 1);
      if (typeof saved === 'number' && isFinite(saved)) set(saved, false);
    }).catch((err) => console.warn('[SS] could not read the saved zoom:', err));
  }
})();
