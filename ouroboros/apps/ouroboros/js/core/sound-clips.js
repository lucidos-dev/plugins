// Ouroboros: built-in jingle scores.
//
// audio/clips/*.json can override these at startup (see main.js). The timing
// of the Game Over sequence is derived from whichever notes are active.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.Ouroboros = root.Ouroboros || {}).SoundClips = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // da-da-da-da daa daa daaaaa, a pompous fanfare for a leaderboard placement
  const FANFARE_NOTES = [
    { freq: 261.63, dur: 0.12, gap: 0.03, vol: 0.45 },
    { freq: 261.63, dur: 0.12, gap: 0.03, vol: 0.48 },
    { freq: 329.63, dur: 0.12, gap: 0.03, vol: 0.50 },
    { freq: 392.00, dur: 0.12, gap: 0.05, vol: 0.52 },
    { freq: 523.25, dur: 0.28, gap: 0.05, vol: 0.58 },
    { freq: 659.25, dur: 0.38, gap: 0.07, vol: 0.64 },
    { freq: 783.99, dur: 2.22, gap: 0, vol: 0.75, final: true }
  ];

  const FANFARE_HARMONICS = [0, 1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.15, 0.1, 0.08, 0.06, 0.04, 0.03];

  const FANFARE_FINALE = { vibRate: 5.2, vibDepth: 0.006, swell: 1.7, filterPeak: 8000 };

  // Chord under the final fanfare note, as fractions of that note's volume
  const FANFARE_CHORD = [
    { freq: 659.25, gain: 0.65 },
    { freq: 523.25, gain: 0.55 },
    { freq: 392.00, gain: 0.45 },
    { freq: 329.63, gain: 0.40 },
    { freq: 261.63, gain: 0.35 },
    { freq: 1046.50, gain: 0.28 },
    { freq: 130.81, gain: 0.30 },
    { freq: 196.00, gain: 0.25 }
  ];

  // The sad trombone: wah, wah, wah, waaaah
  const TROMBONE_NOTES = [
    { freq: 262, endFreq: 256, dur: 0.44, gap: 0.05, press: 0.7, vibRate: 4.5, vibDepth: 0.005 },
    { freq: 247, endFreq: 242, dur: 0.46, gap: 0.05, press: 0.8, vibRate: 5.0, vibDepth: 0.006 },
    { freq: 233, endFreq: 228, dur: 0.62, gap: 0.06, press: 0.9, vibRate: 5.5, vibDepth: 0.007 },
    { freq: 220, endFreq: 208, dur: 1.96, gap: 0.08, press: 1.0, vibRate: 5.0, vibDepth: 0.010 }
  ];

  const TROMBONE_HARMONICS = [0, 1.0, 0.85, 0.7, 0.55, 0.45, 0.35, 0.25, 0.18, 0.12, 0.08, 0.06, 0.04, 0.03, 0.02, 0.015];

  return {
    FANFARE_NOTES, FANFARE_HARMONICS, FANFARE_FINALE, FANFARE_CHORD,
    TROMBONE_NOTES, TROMBONE_HARMONICS
  };
});
