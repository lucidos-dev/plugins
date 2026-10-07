// Ouroboros: timing for the death sequence and the music tempo.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./config.js'));
  else (root.Ouroboros = root.Ouroboros || {}).Timing = factory(root.Ouroboros.config);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (config) {
  'use strict';

  // Both jingles start this long after the crash, leaving room for the splash.
  const JINGLE_OFFSET = 0.35;

  // Turns rAF timestamps into fixed-rate frames. tick() returns the current
  // frame number and how many simulation steps to run since the last tick, so
  // animations run at the same speed at 30, 60 or 120 Hz.
  function createFixedStepClock(frameMs = config.FRAME_MS, maxSteps = config.MAX_CATCH_UP_STEPS) {
    let start = null, last = -1;
    return {
      reset() { start = null; last = -1; },
      tick(timestamp) {
        if (start === null) start = timestamp;
        const frame = Math.floor((timestamp - start) / frameMs);
        const steps = Math.max(0, Math.min(maxSteps, frame - last));
        last = Math.max(last, frame);
        return { frame, steps };
      }
    };
  }

  // Timing of the celebration fanfare, in seconds after the crash.
  function fanfareTiming(notes, offset = JINGLE_OFFSET) {
    const sum = notes.reduce((acc, n) => acc + n.dur + (n.gap || 0), 0);
    const last = notes[notes.length - 1];
    return { lastNoteStart: offset + sum - last.dur, soundEnd: offset + sum };
  }

  // Timing of the sad trombone. A missing gap means 0.06 s, and the trailing
  // gap after the last note is not part of the sound.
  function tromboneTiming(notes, offset = JINGLE_OFFSET) {
    const sum = notes.reduce((acc, n) => acc + n.dur + (n.gap || 0.06), 0);
    const last = notes[notes.length - 1];
    const lastGap = last.gap || 0.06;
    return { lastNoteStart: offset + sum - last.dur - lastGap, soundEnd: offset + sum - lastGap };
  }

  // The Game Over text starts to dissolve halfway through the last note.
  function dissolveDelay(timing) {
    return (timing.lastNoteStart + timing.soundEnd) / 2;
  }

  // 0 → 1 as body segment `index` shrinks away; segments go one after another.
  function segmentDissolve(index, frame) {
    const progress = frame / 60;
    return Math.max(0, Math.min(1, (progress - index * 0.06) * 1.2));
  }

  // The placement label fades in over the second half-second.
  function placementOpacity(frame) {
    return frame > 30 ? Math.min(1, (frame - 30) / 30) : 0;
  }

  // Music and hiss speed up with the game, but less than linearly.
  function musicBpm(speed) {
    return config.BASE_BPM * Math.pow(config.INITIAL_SPEED / speed, 0.6);
  }

  return {
    JINGLE_OFFSET, createFixedStepClock, fanfareTiming, tromboneTiming, dissolveDelay,
    segmentDissolve, placementOpacity, musicBpm
  };
});
