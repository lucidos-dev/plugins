const test = require('node:test');
const assert = require('node:assert/strict');
const Replay = require('../../js/core/replay.js');
const Game = require('../../js/core/game.js');

test('a recording plays back the same moves and food', () => {
  const rec = Replay.createRecorder();
  const { up, right, down, left } = Game.DIRECTIONS;
  rec.start({ x: 3, y: 4 });
  [right, up, left, down].forEach(d => rec.tick(d));
  rec.foodEaten({ x: 7, y: 8 });
  const data = rec.stop();
  assert.deepEqual(data, { f0: [3, 4], fs: [[7, 8]], ts: 'RULD' });

  const pb = Replay.createPlayback(data);
  assert.deepEqual(pb.firstFood, { x: 3, y: 4 });
  assert.deepEqual([pb.nextDirection(), pb.nextDirection(), pb.nextDirection(), pb.nextDirection()], [right, up, left, down]);
  assert.equal(pb.nextDirection(), null);
  assert.deepEqual(pb.nextFood(), { x: 7, y: 8 });
  assert.equal(pb.nextFood(), null);
});

test('stop without start returns null, and ticks after stop are ignored', () => {
  const rec = Replay.createRecorder();
  assert.equal(rec.stop(), null);
  rec.tick(Game.DIRECTIONS.up);
  assert.equal(rec.stop(), null);
});

test('parseDir falls back to right for unknown letters', () => {
  assert.deepEqual(Replay.parseDir('?'), { x: 1, y: 0 });
});
