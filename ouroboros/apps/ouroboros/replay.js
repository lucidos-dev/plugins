// Snake Game — Replay Recording & Parsing
window.SnakeReplay = (function () {
  let rec = null;

  function startRecording(food) {
    rec = { f0: [food.x, food.y], fs: [], ts: [] };
  }

  function tick(dir) {
    if (!rec) return;
    rec.ts.push(dir.x === 1 ? 'R' : dir.x === -1 ? 'L' : dir.y === -1 ? 'U' : 'D');
  }

  function foodEaten(newFood) {
    if (!rec) return;
    rec.fs.push([newFood.x, newFood.y]);
  }

  function stop() {
    if (!rec) return null;
    const data = { f0: rec.f0, fs: rec.fs, ts: rec.ts.join('') };
    rec = null;
    return data;
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

  return { startRecording, tick, foodEaten, stop, parseDir };
})();
