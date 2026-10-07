const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Fall = require('../../js/core/fall-physics.js');
const Timing = require('../../js/core/timing.js');
const Clips = require('../../js/core/sound-clips.js');

// Small deterministic PRNG so every run is the same
function seeded(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

// Step until both words settle; returns the step count.
function stepsToSettle(fall) {
  let n = 0;
  while (!Fall.isSettled(fall) && n < 1000) Fall.step(fall, n * (1000 / 60)), n++;
  return n;
}

test('both words settle before the Game Over text starts to dissolve', () => {
  const dissolveFrame = Timing.dissolveDelay(Timing.tromboneTiming(Clips.TROMBONE_NOTES)) * 60;
  for (let seed = 1; seed <= 50; seed++) {
    const n = stepsToSettle(Fall.createFall(seeded(seed)));
    assert.ok(n < dissolveFrame, `seed ${seed}: settled after ${n} steps, dissolve at ${dissolveFrame}`);
  }
});

test('"OVER" starts five steps after "GAME"', () => {
  const fall = Fall.createFall(seeded(7));
  assert.equal(Fall.poseOf(fall, 0).visible, false);
  Fall.step(fall, 0);
  assert.equal(Fall.poseOf(fall, 0).visible, true);
  assert.equal(Fall.poseOf(fall, 1).visible, false);
  for (let i = 0; i < 5; i++) Fall.step(fall, 0);
  assert.equal(Fall.poseOf(fall, 1).visible, true);
});

test('rotation stays within the clamp and words come to rest at y ≈ 0', () => {
  const fall = Fall.createFall(seeded(3));
  for (let i = 0; i < 400; i++) {
    Fall.step(fall, i * 16.7);
    for (const idx of [0, 1]) {
      const pose = Fall.poseOf(fall, idx);
      assert.ok(Math.abs(pose.rot) <= Fall.MAX_ROT);
      assert.ok(pose.y >= Fall.START_Y && pose.y <= 2, `y=${pose.y}`);
    }
  }
  assert.ok(Math.abs(Fall.poseOf(fall, 0).y) < 1.5);
});

test('the falling words start inside the SVG viewBox', () => {
  // WebKit clips the CSS-filtered SVG to its viewBox and ignores
  // overflow:visible, so the whole fall path must lie inside it.
  const html = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  const [, minY] = html.match(/id="game-over-svg"[^>]*viewBox="[\d.-]+ ([\d.-]+)/).map(Number);
  // Top of "GAME" at the start: baseline 78, half of the 70-unit font above it,
  // plus up to ~42 units of lift from rotating about the pivot.
  const topOfGame = Fall.START_Y + 78 - 35 - 42;
  assert.ok(topOfGame > minY, `GAME starts at y=${topOfGame}, viewBox starts at y=${minY}`);
});

test('svgTransform formats translate + rotate about the pivot', () => {
  assert.equal(Fall.svgTransform({ y: 2, rot: -5, pivotX: 150, pivotY: 10 }), 'translate(0, 2) rotate(-5, 150, 10)');
});
