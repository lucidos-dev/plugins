// Ouroboros: shared constants.
//
// Every file under js/core/ is plain logic with no DOM access. Each one
// registers itself on window.Ouroboros in the browser and exports through
// module.exports under Node, so the unit tests in tests/unit/ can load it
// without a build step. (Native ES modules are not an option: the app frame
// has an opaque origin, and module scripts are fetched with CORS, which the
// engine does not grant for app files.)
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.Ouroboros = root.Ouroboros || {}).config = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  return Object.freeze({
    GRID_SIZE: 20,

    // Tick length in ms. The game speeds up by SPEED_INCREASE per point.
    INITIAL_SPEED: 140,
    SPEED_INCREASE: 2,
    MIN_SPEED: 55,

    // Both leaderboards keep this many entries.
    SCOREBOARD_SIZE: 10,

    // The death animation runs on a fixed 60 Hz clock. Its physics constants
    // are tuned per 60 Hz step, and rAF rates differ between browsers.
    FRAME_MS: 1000 / 60,
    // Cap catch-up after a stall (hidden tab, long GC) so nothing teleports.
    MAX_CATCH_UP_STEPS: 6,

    // Music and hiss tempo at INITIAL_SPEED.
    BASE_BPM: 128
  });
});
