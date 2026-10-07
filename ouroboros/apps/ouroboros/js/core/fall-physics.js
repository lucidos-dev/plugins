// Ouroboros: the falling "GAME" / "OVER" words.
//
// Each word drops from above, bounces a few times, then swings gently from a
// pivot above it like a hanging sign. One step() is one 60 Hz frame; the
// constants are tuned for that rate. The DOM side reads poseOf() and turns it
// into an SVG transform.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.Ouroboros = root.Ouroboros || {}).FallPhysics = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const START_Y = -250;
  const GRAVITY = 0.18;
  const RESTITUTION = 0.48;
  const MAX_ROT = 25;
  // Resting y of each word's pivot reference in the SVG, and the x it rotates about.
  const ORIGINS = [72, 142];
  const PIVOT_X = 150;

  function clampRot(rot) {
    return Math.max(-MAX_ROT, Math.min(MAX_ROT, rot));
  }

  function createFall(rng = Math.random) {
    const word = (rot, vrot, restRot, delay, pivotOffset) => ({
      y: START_Y, vy: 0, rot, vrot, restRot, bounces: 0,
      settled: false, settledAt: 0, delay, active: false,
      swing: 0, swingVel: 0, pivotOffset
    });
    return {
      rng,
      words: [
        word(-6 + rng() * 3, -0.15 - rng() * 0.3, -5 - rng() * 3, 0, -64 + rng() * 6),
        word(3 + rng() * 4, 0.15 + rng() * 0.3, 3 + rng() * 4, 5, -58 + rng() * 6)
      ]
    };
  }

  function stepWord(w, i, rng, nowMs) {
    if (w.delay > 0) { w.delay--; return; }
    w.active = true;

    if (!w.settled) {
      w.vy += GRAVITY;
      w.y += w.vy;
      w.rot = clampRot(w.rot + w.vrot);
      w.vrot *= 0.98;

      if (w.y >= 0 && w.vy > 0) {
        w.y = 0;
        w.bounces++;
        w.vy = -Math.abs(w.vy) * RESTITUTION;
        w.vrot += (rng() - 0.5) * (3 / w.bounces);
        if (Math.abs(w.vy) < 0.8) {
          w.vy = 0; w.y = 0; w.settled = true; w.settledAt = nowMs;
          w.swing = w.rot * 0.7;
          w.swingVel = 0;
        }
      }
    }

    if (w.settled) {
      // Pendulum around a pivot above the text, plus a slow fading sway
      w.swingVel += -w.swing * 0.035;
      w.swingVel *= 0.92;
      w.swing += w.swingVel;
      const t = (nowMs - w.settledAt) / 1000;
      const sway = Math.sin(t * 1.6 + i * 1.2) * 1.4 * Math.exp(-t * 0.35);
      const targetRot = w.restRot + w.swing + sway;
      w.rot += (targetRot - w.rot) * 0.12;
      w.y = Math.sin(w.swing * 0.08) * 1.2;
    } else if (w.bounces > 3) {
      w.rot += (w.restRot - w.rot) * 0.08;
      w.vrot *= 0.86;
    }
  }

  // Advance one 60 Hz frame. `nowMs` is wall-clock time, used for the sway.
  function step(fall, nowMs) {
    fall.words.forEach((w, i) => stepWord(w, i, fall.rng, nowMs));
  }

  // What to draw for word `i`. Hidden until its start delay has passed.
  function poseOf(fall, i) {
    const w = fall.words[i];
    return {
      visible: w.active,
      y: w.y,
      rot: clampRot(w.rot),
      pivotX: PIVOT_X,
      pivotY: ORIGINS[i] + (w.pivotOffset || -60)
    };
  }

  function svgTransform(pose) {
    return `translate(0, ${pose.y}) rotate(${pose.rot}, ${pose.pivotX}, ${pose.pivotY})`;
  }

  function isSettled(fall) {
    return fall.words.every(w => w.settled);
  }

  return { START_Y, MAX_ROT, createFall, step, poseOf, svgTransform, isSettled };
});
