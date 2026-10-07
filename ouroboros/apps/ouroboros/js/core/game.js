// Ouroboros, game rules: snake movement, collisions, food and speed.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./config.js'));
  else (root.Ouroboros = root.Ouroboros || {}).Game = factory(root.Ouroboros.config);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (config) {
  'use strict';

  const DIRECTIONS = Object.freeze({
    up: Object.freeze({ x: 0, y: -1 }),
    down: Object.freeze({ x: 0, y: 1 }),
    left: Object.freeze({ x: -1, y: 0 }),
    right: Object.freeze({ x: 1, y: 0 })
  });

  // Three segments in the middle of the board, heading right.
  function createSnake(gridSize = config.GRID_SIZE) {
    const mid = Math.floor(gridSize / 2);
    return [{ x: mid, y: mid }, { x: mid - 1, y: mid }, { x: mid - 2, y: mid }];
  }

  function nextHead(head, direction) {
    return { x: head.x + direction.x, y: head.y + direction.y };
  }

  // The full snake counts, tail included: moving into the cell the tail is
  // about to leave is still a crash.
  function isCollision(head, snake, gridSize = config.GRID_SIZE) {
    return head.x < 0 || head.x >= gridSize || head.y < 0 || head.y >= gridSize ||
      snake.some(s => s.x === head.x && s.y === head.y);
  }

  // A turn is allowed unless it reverses straight into the neck.
  function canTurn(current, next) {
    return current.x !== -next.x || current.y !== -next.y;
  }

  // Move one cell. Returns { dead: true } on a crash; otherwise the new snake,
  // whether it ate, and the tail cell it moved away from (for the trail).
  function advance(snake, direction, food, gridSize = config.GRID_SIZE) {
    const head = nextHead(snake[0], direction);
    if (isCollision(head, snake, gridSize)) return { dead: true };
    const tail = snake[snake.length - 1];
    const ate = !!food && head.x === food.x && head.y === food.y;
    const body = ate ? snake : snake.slice(0, -1);
    return { dead: false, snake: [head, ...body], head, tail, ate };
  }

  // A random free cell, or null when the snake fills the board.
  function spawnFood(snake, gridSize = config.GRID_SIZE, rng = Math.random) {
    const occupied = new Set(snake.map(s => s.y * gridSize + s.x));
    if (occupied.size >= gridSize * gridSize) return null;
    let pos;
    do { pos = { x: Math.floor(rng() * gridSize), y: Math.floor(rng() * gridSize) }; }
    while (occupied.has(pos.y * gridSize + pos.x));
    return pos;
  }

  function speedForScore(score) {
    return Math.max(config.MIN_SPEED, config.INITIAL_SPEED - score * config.SPEED_INCREASE);
  }

  return { DIRECTIONS, createSnake, nextHead, isCollision, canTurn, advance, spawnFood, speedForScore };
});
