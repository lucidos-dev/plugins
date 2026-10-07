// Ouroboros: keyboard, touch and on-screen controls.
(function (O) {
  'use strict';

  const D = O.Game.DIRECTIONS;

  const KEY_DIRS = {
    ArrowUp: D.up, w: D.up,
    ArrowDown: D.down, s: D.down,
    ArrowLeft: D.left, a: D.left,
    ArrowRight: D.right, d: D.right
  };

  const SWIPE_MIN = 20;       // px of finger travel per turn on the board
  const SWIPE_UP_START = 40;  // px of upward swipe on the start screen

  // opts: { canvas, overlay, buttons, canStart(): bool, onDirection(dir), onStart() }
  function bind({ canvas, overlay, buttons, canStart, onDirection, onStart }) {
    document.addEventListener('keydown', e => {
      if (document.activeElement?.tagName === 'INPUT') return;
      if (KEY_DIRS[e.key]) { onDirection(KEY_DIRS[e.key]); e.preventDefault(); }
      if (e.key === 'Enter' && canStart()) onStart();
    });

    buttons.forEach(btn => {
      btn.addEventListener('click', () => { if (D[btn.dataset.dir]) onDirection(D[btn.dataset.dir]); });
    });

    // Swipe on the board; each SWIPE_MIN of travel can make a new turn
    let touchStart = null;
    canvas.addEventListener('touchstart', e => {
      touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }, { passive: true });
    canvas.addEventListener('touchmove', e => {
      if (!touchStart) return;
      e.preventDefault();
      const dx = e.touches[0].clientX - touchStart.x, dy = e.touches[0].clientY - touchStart.y;
      if (Math.abs(dx) > SWIPE_MIN || Math.abs(dy) > SWIPE_MIN) {
        onDirection(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? D.right : D.left) : (dy > 0 ? D.down : D.up));
        touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }
    }, { passive: false });

    // Swipe up on the start screen to play
    let overlayTouch = null;
    overlay.addEventListener('touchstart', e => {
      overlayTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }, { passive: true });
    overlay.addEventListener('touchend', e => {
      if (!overlayTouch) return;
      const dy = e.changedTouches[0].clientY - overlayTouch.y;
      const dx = e.changedTouches[0].clientX - overlayTouch.x;
      overlayTouch = null;
      if (dy < -SWIPE_UP_START && Math.abs(dy) > Math.abs(dx) && canStart()) onStart();
    }, { passive: true });
  }

  O.Input = { bind };
})(window.Ouroboros);
