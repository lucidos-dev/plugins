// Ouroboros, leaderboards: "Legender" (all time) and "Dagens beste" (today).
//
// A board is { highscores, dailyScores, dailyDate }. Entries are
// { name, score, date, replay? }; daily entries also carry a local "HH:MM" time.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./config.js'));
  else (root.Ouroboros = root.Ouroboros || {}).Scores = factory(root.Ouroboros.config);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (config) {
  'use strict';

  const SIZE = config.SCOREBOARD_SIZE;

  // The daily board rolls over on the UTC date, as it always has.
  function todayStr(now = new Date()) {
    return now.toISOString().slice(0, 10);
  }

  function timeStr(now = new Date()) {
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  }

  function emptyBoard(today) {
    return { highscores: [], dailyScores: [], dailyDate: today };
  }

  // Accept whatever the store returned (null, partial, stale) and give back a
  // board whose daily list belongs to `today`.
  function normalizeBoard(payload, today) {
    const board = {
      highscores: Array.isArray(payload?.highscores) ? payload.highscores : [],
      dailyScores: Array.isArray(payload?.dailyScores) ? payload.dailyScores : [],
      dailyDate: payload?.dailyDate || ''
    };
    if (board.dailyDate !== today) { board.dailyScores = []; board.dailyDate = today; }
    return board;
  }

  // Where a score would land: { type: 'legend' | 'daily', rank } or null.
  // The all-time board wins when the score makes both.
  function placement(score, board, today) {
    if (!score || score <= 0) return null;
    const legendRank = board.highscores.filter(h => h.score > score).length + 1;
    if (legendRank <= SIZE) return { type: 'legend', rank: legendRank };
    const todays = board.dailyDate === today ? board.dailyScores : [];
    const dailyRank = todays.filter(h => h.score > score).length + 1;
    if (dailyRank <= SIZE) return { type: 'daily', rank: dailyRank };
    return null;
  }

  function insertSorted(list, entry) {
    // Array#sort is stable, so a new entry lands after existing equal scores.
    return [...list, entry].sort((a, b) => b.score - a.score).slice(0, SIZE);
  }

  // Add a finished round to both boards. Returns { board, entry }; `entry` is
  // what the UI highlights.
  function addEntry(board, { name, score, replay }, now = new Date()) {
    const today = todayStr(now);
    const entry = { name: (name || 'Anonym').toUpperCase(), score, date: today };
    if (replay) entry.replay = replay;
    const fresh = normalizeBoard(board, today);
    return {
      entry,
      board: {
        highscores: insertSorted(fresh.highscores, entry),
        dailyScores: insertSorted(fresh.dailyScores, { ...entry, time: timeStr(now) }),
        dailyDate: today
      }
    };
  }

  // Competition ranking: equal scores share a rank, the next rank skips.
  function ranks(scores) {
    const out = [];
    for (let i = 0; i < scores.length; i++) {
      out.push(i === 0 ? 1 : scores[i].score === scores[i - 1].score ? out[i - 1] : i + 1);
    }
    return out;
  }

  // '2026-09-27' → '27.09.26'
  function formatDate(date) {
    const p = (date || '').split('-');
    return p.length === 3 ? `${p[2]}.${p[1]}.${p[0].slice(2)}` : (date || '');
  }

  function isSameEntry(a, b) {
    return !!a && !!b && a.name === b.name && a.score === b.score && a.date === b.date;
  }

  function placementLabel(p) {
    if (!p) return '';
    return p.type === 'legend' ? `NR ${p.rank}, DU ER EN LEGENDE!` : `DAGENS ${p.rank}. BESTE!`;
  }

  return { todayStr, timeStr, emptyBoard, normalizeBoard, placement, addEntry, ranks, formatDate, isSameEntry, placementLabel };
});
