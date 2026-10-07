// Ouroboros: canvas colours and small drawing helpers.
(function (O) {
  'use strict';

  O.Palette = Object.freeze({
    SNAKE_HEAD: '#4ade80',
    SNAKE_BODY_START: '#22c55e',
    SNAKE_BODY_END: '#064e3b',
    FOOD_COLOR: '#ef4444',
    FOOD_GLOW: '#f87171',
    PUPIL_COLOR: '#111',
    GRID_COLOR: 'rgba(74, 222, 128, 0.025)',

    // Blend two '#rrggbb' colours; t = 0 gives a, t = 1 gives b.
    lerpColor(a, b, t) {
      const ar = parseInt(a.slice(1, 3), 16), ag = parseInt(a.slice(3, 5), 16), ab = parseInt(a.slice(5, 7), 16);
      const br = parseInt(b.slice(1, 3), 16), bg = parseInt(b.slice(3, 5), 16), bb = parseInt(b.slice(5, 7), 16);
      const r = Math.round(ar + (br - ar) * t);
      const g = Math.round(ag + (bg - ag) * t);
      const bl = Math.round(ab + (bb - ab) * t);
      return `rgb(${r},${g},${bl})`;
    },

    // Rounded-rectangle path. Hand-rolled because ctx.roundRect needs Safari 16.
    roundRect(ctx, x, y, w, h, r) {
      r = Math.min(r, w / 2, h / 2);
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h - r);
      ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x + r, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
    }
  });
})(window.Ouroboros);
