// Ouroboros, storage screen: pick the local or a shared scoreboard.
(function (O) {
  'use strict';

  const { escapeHtml } = O.Text;
  const $ = id => document.getElementById(id);

  const ADD_BOARD_PROMPT = `Set up a new shared highscore board for Ouroboros.\n\n1. Ask me for the board's name (e.g. "Family") and the Firebase Realtime Database URL.\n2. Add a proxy entry to data/config/apis.json named snake-storage-<slug>.\n3. If the database requires an auth token: ask for the token via request_credential and add the query_param auth layer to the proxy.\n4. Test the proxy with a GET against /snake/highscores.json.\n5. Tell me when it is ready. The board shows up by itself under 💾 in Ouroboros.\n\nSee apps/ouroboros/knowhow/storage-backends.md for the details.`;

  let store, onBoardChanged, statusEl, listEl, badgeEl;

  // opts: { store, onBoardChanged(): Promise (reload scores and players), onClose() }
  function init(opts) {
    store = opts.store;
    onBoardChanged = opts.onBoardChanged;
    statusEl = $('storage-status');
    listEl = $('board-list');
    badgeEl = $('btn-storage');

    $('btn-storage-close').addEventListener('click', opts.onClose);
    $('btn-add-board').addEventListener('click', copyAddBoardPrompt);
    listEl.addEventListener('click', onListClick);
  }

  function syncBadge() {
    badgeEl.textContent = store.isShared() ? '☁' : '💾';
    const label = store.isShared()
      ? `Leaderboard: ${store.getActiveLabel()} (proxy: ${store.getActiveProxy()})`
      : 'Leaderboard: Local';
    badgeEl.dataset.tooltip = label;
    badgeEl.setAttribute('aria-label', label);
  }

  function setStatus(msg, kind) {
    statusEl.className = 'firebase-status' + (kind ? ' ' + kind : '');
    statusEl.textContent = msg || '';
  }

  // shared: show the proxy name and a ⚡ test button; removable: also a ✕.
  function boardRowHtml({ icon, label, proxy, active, action, shared, removable }) {
    const safeLabel = escapeHtml(label);
    const safeProxy = escapeHtml(proxy);
    const removeBtn = removable
      ? `<button class="board-action-btn danger" type="button" data-action="remove" data-proxy="${safeProxy}" data-tooltip="Remove" aria-label="Remove ${safeProxy}">✕</button>`
      : '';
    const actions = shared ? `
        <div class="board-actions">
          <button class="board-action-btn" type="button" data-action="test" data-proxy="${safeProxy}" data-tooltip="Test connection" aria-label="Test ${safeProxy}">⚡</button>
          ${removeBtn}
        </div>` : '';
    return `
      <li class="board-row${active ? ' active' : ''}">
        <button class="board-pick" type="button" data-action="${action}" data-proxy="${safeProxy}">
          <span class="board-icon">${icon}</span>
          <span class="board-meta">
            <span class="board-label">${safeLabel}</span>
            <span class="board-proxy">${shared ? safeProxy : 'private, only you'}</span>
          </span>
          <span class="board-active-mark">${active ? '✓' : ''}</span>
        </button>${actions}
      </li>`;
  }

  function renderList() {
    const isLocal = store.getMode() === 'local';
    const activeProxy = store.getActiveProxy();
    const rows = [boardRowHtml({ icon: '💾', label: 'Local', proxy: '', active: isLocal, action: 'pick-local', shared: false })];
    for (const b of store.listBoards()) {
      rows.push(boardRowHtml({
        icon: '☁', label: b.label, proxy: b.proxy,
        active: !isLocal && activeProxy === b.proxy, action: 'pick-shared',
        shared: true, removable: !b.discovered
      }));
    }
    listEl.innerHTML = rows.join('');
  }

  // Render right away, then again once the workspace's proxies are known.
  async function show() {
    setStatus('');
    renderList();
    await store.refreshBoards();
    syncBadge();
    renderList();
  }

  async function copyAddBoardPrompt() {
    try {
      await navigator.clipboard.writeText(ADD_BOARD_PROMPT);
      setStatus('✓ Prompt copied. Paste it into a new Lucidos chat and Lucidos will set up the proxy.', 'ok');
    } catch (e) {
      setStatus(`Could not copy: ${e.message || e}\n\nCopy it by hand:\n\n${ADD_BOARD_PROMPT}`, 'error');
    }
  }

  async function afterSwitch() {
    syncBadge();
    await onBoardChanged();
    renderList();
  }

  async function onListClick(e) {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const proxy = btn.dataset.proxy;

    switch (btn.dataset.action) {
      case 'pick-local':
        store.setLocal();
        setStatus('');
        await afterSwitch();
        return;

      case 'pick-shared':
        try {
          store.setActiveBoard(proxy);
          setStatus(`Testing ${proxy}…`);
          await store.testBoard(proxy);
          setStatus('');
          await afterSwitch();
        } catch (err) {
          setStatus(err.message || String(err), 'error');
          store.setLocal();
          syncBadge();
          renderList();
        }
        return;

      case 'test':
        setStatus(`Testing ${proxy}…`);
        try {
          await store.testBoard(proxy);
          setStatus(`✓ ${proxy} OK: read and write work.`, 'ok');
        } catch (err) {
          setStatus(err.message || String(err), 'error');
        }
        return;

      case 'remove': {
        const ok = await window.lucidos.ui.confirm({
          message: `Remove leaderboard "${proxy}"? The data in Firebase stays untouched; only the choice here in the app goes.`,
          okLabel: 'Remove',
          danger: true
        });
        if (!ok) return;
        store.removeBoard(proxy);
        setStatus('');
        await afterSwitch();
        return;
      }
    }
  }

  O.StorageScreen = { init, show, syncBadge };
})(window.Ouroboros);
