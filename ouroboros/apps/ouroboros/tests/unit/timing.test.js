const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../../js/core/config.js');
const Timing = require('../../js/core/timing.js');
const Clips = require('../../js/core/sound-clips.js');

// Drive a clock with rAF timestamps at `hz` for `ms` and total up the steps.
function run(hz, ms) {
  const clock = Timing.createFixedStepClock();
  let steps = 0, frame = 0;
  for (let t = 1000; t <= 1000 + ms; t += 1000 / hz) {
    const r = clock.tick(t);
    steps += r.steps;
    frame = r.frame;
  }
  return { steps, frame };
}

test('the fixed-step clock runs at the same speed at 30, 60 and 120 Hz', () => {
  const at60 = run(60, 2000);
  for (const hz of [30, 120, 144]) {
    const r = run(hz, 2000);
    assert.ok(Math.abs(r.frame - at60.frame) <= 1, `${hz} Hz frame ${r.frame} vs ${at60.frame}`);
    assert.ok(Math.abs(r.steps - at60.steps) <= 2, `${hz} Hz steps ${r.steps} vs ${at60.steps}`);
  }
  // One step per 60 Hz frame, including frame 0
  assert.equal(at60.steps, at60.frame + 1);
});

test('the first tick is frame 0 with one step', () => {
  assert.deepEqual(Timing.createFixedStepClock().tick(5000), { frame: 0, steps: 1 });
});

test('catch-up after a stall is capped', () => {
  const clock = Timing.createFixedStepClock();
  clock.tick(0);
  const r = clock.tick(5000);
  assert.equal(r.steps, config.MAX_CATCH_UP_STEPS);
  assert.equal(r.frame, 300);
  assert.equal(clock.tick(5000).steps, 0, 'no steps without time passing');
});

test('reset starts the clock over', () => {
  const clock = Timing.createFixedStepClock();
  clock.tick(0); clock.tick(1000);
  clock.reset();
  assert.deepEqual(clock.tick(9999), { frame: 0, steps: 1 });
});

test('trombone timing for the built-in notes', () => {
  const t = Timing.tromboneTiming(Clips.TROMBONE_NOTES);
  assert.ok(Math.abs(t.lastNoteStart - 2.03) < 1e-9);
  assert.ok(Math.abs(t.soundEnd - 3.99) < 1e-9);
  assert.ok(Math.abs(Timing.dissolveDelay(t) - 3.01) < 1e-9);
});

test('fanfare timing for the built-in notes', () => {
  const t = Timing.fanfareTiming(Clips.FANFARE_NOTES);
  assert.ok(Math.abs(t.soundEnd - (0.35 + 3.62)) < 1e-9);
  assert.ok(Math.abs(t.lastNoteStart - (t.soundEnd - 2.22)) < 1e-9);
});

test('trombone gaps default to 0.06 s', () => {
  const t = Timing.tromboneTiming([{ dur: 1 }, { dur: 1 }], 0);
  assert.ok(Math.abs(t.soundEnd - 2.06) < 1e-9);
  assert.ok(Math.abs(t.lastNoteStart - 1.06) < 1e-9);
});

test('segments dissolve one after another', () => {
  assert.equal(Timing.segmentDissolve(0, 0), 0);
  assert.equal(Timing.segmentDissolve(0, 60), 1);
  assert.ok(Timing.segmentDissolve(0, 30) > Timing.segmentDissolve(5, 30));
});

test('placement label fades in during the second half-second', () => {
  assert.equal(Timing.placementOpacity(30), 0);
  assert.equal(Timing.placementOpacity(45), 0.5);
  assert.equal(Timing.placementOpacity(90), 1);
});

test('music tempo rises with game speed', () => {
  assert.equal(Timing.musicBpm(config.INITIAL_SPEED), config.BASE_BPM);
  assert.ok(Timing.musicBpm(config.MIN_SPEED) > config.BASE_BPM);
});
