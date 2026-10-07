// Ouroboros: the two highscore side panels.
(function (O) {
  'use strict';

  const { escapeHtml } = O.Text;
  const Scores = O.Scores;

  const EMPTY = { daily: 'Ingen runder i dag', legends: 'HAR IKKE SETT NOEN' };

  let lists;

  // els: { daily, legends }; onReplay(listName, index) fires on a ▶ / ■ click.
  function init(els, onReplay) {
    lists = { daily: els.daily, legends: els.legends };
    Object.entries(lists).forEach(([name, el]) => {
      el.addEventListener('click', e => {
        const btn = e.target.closest('.hs-replay');
        if (!btn) return;
        e.stopPropagation();
        onReplay(name, parseInt(btn.dataset.idx, 10));
      });
    });
  }

  function rowHtml(hs, i, rank, listName, highlight, replaying) {
    const isHl = Scores.isSameEntry(hs, highlight);
    const isReplaying = !!replaying && replaying.list === listName && replaying.index === i;
    const rankHtml = rank <= 3
      ? `<span class="hs-medal hs-medal-${rank}">${rank}</span>`
      : `<span class="hs-rank">${rank}</span>`;
    const replayBtn = hs.replay
      ? `<button class="hs-replay${isReplaying ? ' hs-stop' : ''}" data-idx="${i}" title="${isReplaying ? 'Stopp' : 'Se replay'}">${isReplaying ? '■' : '▶'}</button>`
      : '<span class="hs-replay-spacer"></span>';
    const timeLabel = listName === 'daily' ? (hs.time || '') : Scores.formatDate(hs.date);
    const cls = `hs-row${isHl ? ' hs-highlight' : ''}${isReplaying ? ' hs-replaying' : ''}`;
    return `<div class="${cls}">
        ${rankHtml}<span class="hs-name">${escapeHtml(hs.name)}</span>
        <span class="hs-score">${escapeHtml(hs.score)}</span><span class="hs-date">${escapeHtml(timeLabel)}</span>${replayBtn}</div>`;
  }

  function renderList(listName, scores, highlight, replaying) {
    const el = lists[listName];
    if (!scores.length) {
      el.innerHTML = `<div class="empty-state">${EMPTY[listName]}</div>`;
      return;
    }
    const ranks = Scores.ranks(scores);
    el.innerHTML = scores.map((hs, i) => rowHtml(hs, i, ranks[i], listName, highlight, replaying)).join('');
  }

  // board: { highscores, dailyScores }; opts: { highlight?, replaying?: { list, index } }
  function render(board, { highlight = null, replaying = null } = {}) {
    renderList('daily', board.dailyScores, highlight, replaying);
    renderList('legends', board.highscores, highlight, replaying);
  }

  O.Scoreboard = { init, render };
})(window.Ouroboros);
