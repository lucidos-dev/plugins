// Ouroboros: replay recording and playback.
//
// Stored format (kept compact, it lives in every highscore entry):
//   { f0: [x, y],          first food
//     fs: [[x, y], ...],   each food spawned after one was eaten
//     ts: 'RRUULD...' }    one direction letter per tick
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.Ouroboros = root.Ouroboros || {}).Replay = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function dirToChar(dir) {
    return dir.x === 1 ? 'R' : dir.x === -1 ? 'L' : dir.y === -1 ? 'U' : 'D';
  }

  function parseDir(ch) {
    switch (ch) {
      case 'R': return { x: 1, y: 0 };
      case 'L': return { x: -1, y: 0 };
      case 'U': return { x: 0, y: -1 };
      case 'D': return { x: 0, y: 1 };
      default: return { x: 1, y: 0 };
    }
  }

  function createRecorder() {
    let rec = null;
    return {
      start(food) { rec = { f0: [food.x, food.y], fs: [], ts: [] }; },
      tick(dir) { if (rec) rec.ts.push(dirToChar(dir)); },
      foodEaten(food) { if (rec) rec.fs.push([food.x, food.y]); },
      // Finish and return the stored format, or null if nothing was recording.
      stop() {
        if (!rec) return null;
        const data = { f0: rec.f0, fs: rec.fs, ts: rec.ts.join('') };
        rec = null;
        return data;
      }
    };
  }

  function createPlayback(data) {
    let tick = 0, foodIdx = 0;
    return {
      firstFood: { x: data.f0[0], y: data.f0[1] },
      // Next recorded direction, or null when the recording has run out.
      nextDirection() { return tick < data.ts.length ? parseDir(data.ts[tick++]) : null; },
      // Next recorded food, or null when none is left.
      nextFood() {
        if (foodIdx >= data.fs.length) return null;
        const [x, y] = data.fs[foodIdx++];
        return { x, y };
      }
    };
  }

  return { dirToChar, parseDir, createRecorder, createPlayback };
});
