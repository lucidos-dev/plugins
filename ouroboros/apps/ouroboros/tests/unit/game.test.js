const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../../js/core/config.js');
const Game = require('../../js/core/game.js');

const { up, down, left, right } = Game.DIRECTIONS;
const N = config.GRID_SIZE;

test('createSnake puts three segments mid-board, heading right', () => {
  assert.deepEqual(Game.createSnake(20), [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }]);
});

test('isCollision catches all four walls', () => {
  for (const head of [{ x: -1, y: 5 }, { x: N, y: 5 }, { x: 5, y: -1 }, { x: 5, y: N }]) {
    assert.equal(Game.isCollision(head, [], N), true, JSON.stringify(head));
  }
  assert.equal(Game.isCollision({ x: 0, y: 0 }, [], N), false);
  assert.equal(Game.isCollision({ x: N - 1, y: N - 1 }, [], N), false);
});

test('isCollision counts the tail cell as occupied', () => {
  const snake = [{ x: 5, y: 5 }, { x: 5, y: 6 }, { x: 4, y: 6 }, { x: 4, y: 5 }];
  assert.equal(Game.isCollision({ x: 4, y: 5 }, snake, N), true);
});

test('canTurn refuses only a straight reversal', () => {
  assert.equal(Game.canTurn(right, left), false);
  assert.equal(Game.canTurn(up, down), false);
  assert.equal(Game.canTurn(right, up), true);
  assert.equal(Game.canTurn(right, right), true);
});

test('advance moves the snake and reports the tail it left', () => {
  const snake = Game.createSnake(N);
  const r = Game.advance(snake, right, { x: 0, y: 0 }, N);
  assert.equal(r.dead, false);
  assert.equal(r.ate, false);
  assert.deepEqual(r.snake, [{ x: 11, y: 10 }, { x: 10, y: 10 }, { x: 9, y: 10 }]);
  assert.deepEqual(r.tail, { x: 8, y: 10 });
  assert.equal(snake.length, 3, 'input is not mutated');
});

test('advance grows the snake when it eats', () => {
  const r = Game.advance(Game.createSnake(N), right, { x: 11, y: 10 }, N);
  assert.equal(r.ate, true);
  assert.equal(r.snake.length, 4);
});

test('advance reports death on a crash', () => {
  const snake = [{ x: N - 1, y: 0 }, { x: N - 2, y: 0 }];
  assert.deepEqual(Game.advance(snake, right, null, N), { dead: true });
});

test('spawnFood never lands on the snake', () => {
  const snake = Game.createSnake(N);
  let calls = 0;
  // First two candidates are on the snake, the third is free
  const seq = [10 / N, 10 / N, 9 / N, 10 / N, 0, 0];
  const food = Game.spawnFood(snake, N, () => seq[calls++]);
  assert.deepEqual(food, { x: 0, y: 0 });
});

test('spawnFood returns null on a full board', () => {
  const full = [];
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) full.push({ x, y });
  assert.equal(Game.spawnFood(full, 2), null);
});

test('speedForScore speeds up and stops at MIN_SPEED', () => {
  assert.equal(Game.speedForScore(0), config.INITIAL_SPEED);
  assert.equal(Game.speedForScore(1), config.INITIAL_SPEED - config.SPEED_INCREASE);
  assert.equal(Game.speedForScore(10_000), config.MIN_SPEED);
});
