const test = require('node:test');
const assert = require('node:assert/strict');
const Scores = require('../../js/core/scores.js');

const TODAY = '2026-09-27';
const entry = (name, score, date = TODAY) => ({ name, score, date });
const boardWith = (highscores, dailyScores = [], dailyDate = TODAY) => ({ highscores, dailyScores, dailyDate });
const tenOf = score => Array.from({ length: 10 }, (_, i) => entry('P' + i, score));

test('placement: no placement for a zero score', () => {
  assert.equal(Scores.placement(0, boardWith([]), TODAY), null);
});

test('placement: an empty board makes you legend #1', () => {
  assert.deepEqual(Scores.placement(3, boardWith([]), TODAY), { type: 'legend', rank: 1 });
});

test('placement: ties do not push you down', () => {
  const b = boardWith([entry('A', 9), entry('B', 5), entry('C', 5)]);
  assert.deepEqual(Scores.placement(5, b, TODAY), { type: 'legend', rank: 2 });
});

test('placement: falls back to the daily board when the legends are full', () => {
  const b = boardWith(tenOf(50), [entry('X', 10)]);
  assert.deepEqual(Scores.placement(5, b, TODAY), { type: 'daily', rank: 2 });
});

test('placement: yesterday\'s daily board does not count', () => {
  const b = boardWith(tenOf(50), tenOf(40), '2026-09-26');
  assert.deepEqual(Scores.placement(5, b, TODAY), { type: 'daily', rank: 1 });
});

test('placement: null when both boards are full of better scores', () => {
  assert.equal(Scores.placement(5, boardWith(tenOf(50), tenOf(40)), TODAY), null);
});

test('normalizeBoard handles null and stale input', () => {
  assert.deepEqual(Scores.normalizeBoard(null, TODAY), Scores.emptyBoard(TODAY));
  const stale = Scores.normalizeBoard(boardWith([entry('A', 1)], [entry('A', 1)], '2026-01-01'), TODAY);
  assert.deepEqual(stale.dailyScores, []);
  assert.equal(stale.dailyDate, TODAY);
  assert.equal(stale.highscores.length, 1);
});

test('addEntry inserts sorted, keeps ten, and stamps date and time', () => {
  const now = new Date('2026-09-27T12:34:00Z');
  const { board, entry: added } = Scores.addEntry(boardWith(tenOf(5), []), { name: 'kenneth', score: 7, replay: { ts: 'R' } }, now);
  assert.equal(added.name, 'KENNETH');
  assert.equal(added.date, TODAY);
  assert.deepEqual(added.replay, { ts: 'R' });
  assert.equal(board.highscores.length, 10);
  assert.equal(board.highscores[0].name, 'KENNETH');
  assert.match(board.dailyScores[0].time, /^\d\d:\d\d$/);
});

test('addEntry places a new entry after existing equal scores', () => {
  const { board } = Scores.addEntry(boardWith([entry('OLD', 5)]), { name: 'NEW', score: 5 }, new Date(TODAY + 'T10:00:00Z'));
  assert.deepEqual(board.highscores.map(e => e.name), ['OLD', 'NEW']);
});

test('addEntry names a blank player ANONYM', () => {
  assert.equal(Scores.addEntry(boardWith([]), { name: '', score: 1 }).entry.name, 'ANONYM');
});

test('ranks uses competition ranking', () => {
  assert.deepEqual(Scores.ranks([{ score: 9 }, { score: 7 }, { score: 7 }, { score: 3 }]), [1, 2, 2, 4]);
});

test('formatDate turns ISO dates into dd.mm.yy', () => {
  assert.equal(Scores.formatDate('2026-09-27'), '27.09.26');
  assert.equal(Scores.formatDate('garbage'), 'garbage');
  assert.equal(Scores.formatDate(undefined), '');
});

test('placementLabel', () => {
  assert.equal(Scores.placementLabel({ type: 'legend', rank: 1 }), 'NR 1, DU ER EN LEGENDE!');
  assert.equal(Scores.placementLabel({ type: 'daily', rank: 3 }), 'DAGENS 3. BESTE!');
  assert.equal(Scores.placementLabel(null), '');
});
