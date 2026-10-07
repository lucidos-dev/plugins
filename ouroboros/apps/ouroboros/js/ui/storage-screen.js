// Ouroboros, storage screen: pick the local or a shared scoreboard.
(function (O) {
  'use strict';

  const { escapeHtml } = O.Text;
  const $ = id => document.getElementById(id);

  const ADD_BOARD_PROMPT = `Sett opp en ny delt highscore-liste for Ouroboros.\n\n1. Spør meg om navnet på lista (f.eks. "Familien") og om Firebase Realtime Database-URL.\n2. Legg til et proxy-entry i data/config/apis.json med navn snake-storage-<slug>.\n3. Hvis databasen krever auth-token: be om token via request_credential og legg til query_param-auth-laget i proxyen.\n4. Test proxyen med en GET mot /snake/highscores.json.\n5. Si fra når den er klar. Lista dukker opp av seg selv under 💾 i Ouroboros.\n\nSe apps/ouroboros/knowhow/storage-backends.md for detaljene.`;

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
    badgeEl.title = store.isShared()
      ? `Toppliste: ${store.getActiveLabel()} (proxy: ${store.getActiveProxy()})`
      : 'Toppliste: Lokalt';
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
      ? `<button class="board-action-btn danger" type="button" data-action="remove" data-proxy="${safeProxy}" title="Fjern">✕</button>`
      : '';
    const actions = shared ? `
        <div class="board-actions">
          <button class="board-action-btn" type="button" data-action="test" data-proxy="${safeProxy}" title="Test tilkobling">⚡</button>
          ${removeBtn}
        </div>` : '';
    return `
      <li class="board-row${active ? ' active' : ''}">
        <button class="board-pick" type="button" data-action="${action}" data-proxy="${safeProxy}">
          <span class="board-icon">${icon}</span>
          <span class="board-meta">
            <span class="board-label">${safeLabel}</span>
            <span class="board-proxy">${shared ? safeProxy : 'privat — kun deg'}</span>
          </span>
          <span class="board-active-mark">${active ? '✓' : ''}</span>
        </button>${actions}
      </li>`;
  }

  function renderList() {
    const isLocal = store.getMode() === 'local';
    const activeProxy = store.getActiveProxy();
    const rows = [boardRowHtml({ icon: '💾', label: 'Lokalt', proxy: '', active: isLocal, action: 'pick-local', shared: false })];
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
      setStatus('✓ Prompt kopiert. Lim inn i en ny Lucidos-chat så setter Lucidos opp proxyen.', 'ok');
    } catch (e) {
      setStatus(`Kunne ikke kopiere: ${e.message || e}\n\nKopier manuelt:\n\n${ADD_BOARD_PROMPT}`, 'error');
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
          setStatus(`Tester ${proxy}…`);
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
        setStatus(`Tester ${proxy}…`);
        try {
          await store.testBoard(proxy);
          setStatus(`✓ ${proxy} OK — lese + skrive virker.`, 'ok');
        } catch (err) {
          setStatus(err.message || String(err), 'error');
        }
        return;

      case 'remove':
        if (!confirm(`Fjern toppliste "${proxy}"? Dataene i Firebase rør vi ikke — bare valget her i appen.`)) return;
        store.removeBoard(proxy);
        setStatus('');
        await afterSwitch();
        return;
    }
  }

  O.StorageScreen = { init, show, syncBadge };
})(window.Ouroboros);
