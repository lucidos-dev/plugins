// Snake Game — Main Controller
(function () {
  const GRID_SIZE = 20;
  const INITIAL_SPEED = 140;
  const SPEED_INCREASE = 2;
  const MIN_SPEED = 55;
  const DATA_PATH = 'artifacts/games/snake-highscores.json';
  const PLAYERS_PATH = 'artifacts/games/players.json';

  const SFX = window.SnakeAudio;
  const R = window.SnakeRenderer;
  const Replay = window.SnakeReplay;
  const Store = window.SnakeStore.init();

  // State
  let snake = [], food = null;
  let direction = { x: 1, y: 0 }, nextDirection = { x: 1, y: 0 };
  let score = 0, speed = INITIAL_SPEED;
  let lastTickTime = 0, tickAccumulator = 0;
  let running = false, animFrame = null;
  let highscores = [], dailyScores = [], dailyDate = '';
  let lucidos = null, currentPlayer = '';
  let knownPlayers = [];
  let deathAnimFrame = 0, deathSegments = [];
  let isDeathAnim = false, currentPlacement = null;
  let deathTrumpetTimer = null, deathFadeTimer = null, trumpetDone = false, dissolutionTriggered = false;
  let replayMode = false, replayData = null;
  let replayTick = 0, replayFoodIdx = 0;
  let replayingIdx = -1, replayingList = '';
  let replayEntry = null;

  // Elements
  const $ = id => document.getElementById(id);
  const canvas = $('game-canvas'), scoreEl = $('current-score');
  const overlay = $('overlay'), nameScreen = $('name-screen'), startScreen = $('start-screen');
  const nameInput = $('name-input'), playerBadge = $('player-badge'), playerDisplay = $('player-display');
  const highscoresList = $('highscores-list'), dailyList = $('daily-list');
  const knownPlayersEl = $('known-players'), nameDivider = $('name-divider');
  const headerReplayBadge = $('header-replay-badge');

  R.init(canvas);
  R.initDissolution($('dissolution-canvas'));


  function audioTimeout(promise, ms) {
    return Promise.race([
      Promise.resolve(promise),
      new Promise(resolve => setTimeout(() => resolve(null), ms))
    ]);
  }

  async function safeAudio(task, ms = 700) {
    try {
      return await audioTimeout(typeof task === 'function' ? task() : task, ms);
    } catch (e) {
      console.warn('Audio task failed', e);
      return null;
    }
  }

  async function prepareAudioForPlay() {
    if (!SFX) return false;
    await safeAudio(() => SFX.init(), 700);
    if (SFX.waitForRunning) await safeAudio(() => SFX.waitForRunning(700), 750);
    try { SFX.resetTempo(); } catch (e) {}
    return true;
  }

  function waitForLucidos() {
    return new Promise(resolve => {
      const check = () => window.lucidos ? (lucidos = window.lucidos, resolve()) : setTimeout(check, 100);
      check();
    });
  }

  // === HELPERS ===
  function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function getTodayStr() { return new Date().toISOString().slice(0, 10); }

  function initSnake() {
    const mid = Math.floor(GRID_SIZE / 2);
    snake = [{ x: mid, y: mid }, { x: mid - 1, y: mid }, { x: mid - 2, y: mid }];
    direction = { x: 1, y: 0 };
    nextDirection = { x: 1, y: 0 };
  }

  function isCollision(head) {
    return head.x < 0 || head.x >= GRID_SIZE || head.y < 0 || head.y >= GRID_SIZE ||
      snake.some(s => s.x === head.x && s.y === head.y);
  }

  function resetState() {
    cancelAnimationFrame(animFrame);
    if (deathTrumpetTimer) { clearTimeout(deathTrumpetTimer); deathTrumpetTimer = null; }
    if (deathFadeTimer) { clearTimeout(deathFadeTimer); deathFadeTimer = null; }
    running = false; replayMode = false; replayData = null;
    replayingIdx = -1; replayingList = ''; replayEntry = null;
    isDeathAnim = false; dissolutionTriggered = false;
    SFX.stopHiss(); SFX.stopMusic(); R.cancelDissolution();
    overlay.classList.remove('dissolve-fade-in');
    headerReplayBadge.classList.add('hidden');
    if (currentPlayer) playerBadge.classList.remove('hidden');
  }

  function startDeathAnim(placement) {
    running = false; replayMode = false; dissolutionTriggered = false;
    R.flashDeath(); SFX.stopHiss();
    SFX.stopMusic();
    trumpetDone = false;
    if (deathFadeTimer) { clearTimeout(deathFadeTimer); deathFadeTimer = null; }
    const timing = placement ? SFX.playCelebrate() : SFX.playDeath();
    if (timing.soundEnd > 0) {
      // Start fade-out halfway through the last trombone note
      const lastNoteMid = (timing.lastNoteStart + timing.soundEnd) / 2;
      deathFadeTimer = setTimeout(() => {
        triggerGameOverTransition();
      }, lastNoteMid * 1000);
      // Mark done when sound ends
      deathTrumpetTimer = setTimeout(() => { trumpetDone = true; }, timing.soundEnd * 1000);
    } else {
      trumpetDone = true;
    }
    R.spawnDeathParticles(snake);
    deathSegments = [...snake]; deathAnimFrame = 0;
    isDeathAnim = true; currentPlacement = placement;
  }

  function triggerGameOverTransition() {
    if (dissolutionTriggered) return;
    dissolutionTriggered = true;
    R.startGameOverDissolve();
    R.clearTrail();
    snake = [];
    food = null;
    hideAllScreens();
    $('start-title').textContent = 'ARE YOU READY?';
    $('btn-start').textContent = `START AS ${currentPlayer.toUpperCase()}`;
    startScreen.classList.remove('hidden');
    overlay.classList.remove('hidden');
    overlay.classList.add('dissolve-fade-in');
    R.startDissolution();
  }

  function moveSnake() {
    const head = { x: snake[0].x + direction.x, y: snake[0].y + direction.y };
    if (isCollision(head)) return null;
    R.addTrail(snake[snake.length - 1]);
    snake.unshift(head);
    return head;
  }

  function eatFood() {
    score++;
    scoreEl.textContent = score;
    R.popScore(); SFX.playEat();
    speed = Math.max(MIN_SPEED, INITIAL_SPEED - score * SPEED_INCREASE);
    SFX.setGameSpeed(speed);
    R.spawnEatParticles(food.x, food.y);
    R.flashEat(food.x, food.y);
  }

  function drawState() {
    return R.draw({ snake, food, direction, isDeathAnim, deathSegments, deathAnimFrame, currentPlacement, snakeLen: snake.length, isPlaying: running || replayMode });
  }

  // === PLAYER MANAGEMENT ===
  function setPlayer(name) {
    currentPlayer = (name.trim() || 'Anonym').toUpperCase();
    playerDisplay.textContent = currentPlayer;
    playerBadge.classList.remove('hidden');
    addKnownPlayer(currentPlayer);
    try { localStorage.setItem('snake-player', currentPlayer); } catch (e) {}
  }

  function getSavedPlayer() { try { return localStorage.getItem('snake-player') || ''; } catch (e) { return ''; } }

  async function loadPlayers() {
    try {
      const list = await Store.readPlayers();
      if (Array.isArray(list)) knownPlayers = list;
    } catch (e) { console.warn('loadPlayers failed', e); }
  }

  async function addKnownPlayer(name) {
    const n = name.trim().toUpperCase();
    if (!n || n === 'ANONYM') return;
    if (knownPlayers.includes(n)) return;
    knownPlayers.push(n);
    try { await Store.writePlayers(knownPlayers); } catch (e) { console.warn('writePlayers failed', e); }
  }

  function renderKnownPlayers() {
    const players = knownPlayers.filter(p => p && p !== 'ANONYM');
    knownPlayersEl.classList.toggle('hidden', !players.length);
    nameDivider.classList.add('hidden');
    if (!players.length) return;
    knownPlayersEl.innerHTML = players.map(p =>
      `<button class="player-chip" data-player="${escapeHtml(p)}">${escapeHtml(p)}</button>`
    ).join('');
    knownPlayersEl.querySelectorAll('.player-chip').forEach(chip => {
      chip.addEventListener('click', () => { setPlayer(chip.dataset.player); showStartScreen(); });
    });
  }

  // === SCREENS ===
  function hideAllScreens() { nameScreen.classList.add('hidden'); startScreen.classList.add('hidden'); $('storage-screen').classList.add('hidden'); }

  function showNameScreen(isSwitch) {
    resetState();
    hideAllScreens();
    const titleEl = $('name-screen-title');
    titleEl.textContent = isSwitch ? 'SWITCH PLAYER' : 'Ouroboros';
    titleEl.classList.toggle('venom-title', isSwitch);
    const prompt = $('name-screen-prompt');
    prompt.textContent = isSwitch ? '' : 'What\'s your name?';
    prompt.classList.toggle('hidden', isSwitch);
    $('btn-name-ok').textContent = isSwitch ? 'Switch' : 'Start';
    nameScreen.classList.remove('hidden');
    overlay.classList.remove('hidden');
    renderKnownPlayers();
    nameInput.value = '';
    nameInput.placeholder = 'YOUR NAME';
    setTimeout(() => nameInput.focus(), 100);
  }

  function showStartScreen() {
    hideAllScreens();
    $('start-title').textContent = 'ARE YOU READY?';
    $('btn-start').textContent = `START AS ${currentPlayer.toUpperCase()}`;
    startScreen.classList.remove('hidden');
    overlay.classList.remove('hidden');
  }

  // === HIGHSCORES ===
  async function loadHighscores() {
    try {
      const p = await Store.readHighscores();
      if (p) {
        highscores = p.highscores || [];
        dailyScores = p.dailyScores || [];
        dailyDate = p.dailyDate || '';
      }
    } catch (e) { console.warn('loadHighscores failed', e); highscores = []; dailyScores = []; dailyDate = ''; }
    const today = getTodayStr();
    if (dailyDate !== today) { dailyScores = []; dailyDate = today; }
    renderHighscores();
  }

  async function saveHighscores() {
    try { await Store.writeHighscores({ highscores, dailyScores, dailyDate }); }
    catch (e) { console.error('Save failed', e); }
  }

  function getPlacement(s) {
    if (s <= 0) return null;
    // Check all-time placement
    const legendRank = highscores.filter(h => h.score > s).length + 1;
    if (legendRank <= 10) return { type: 'legend', rank: legendRank };
    // Check daily placement
    const today = getTodayStr();
    const todayScores = dailyDate === today ? dailyScores : [];
    const dailyRank = todayScores.filter(h => h.score > s).length + 1;
    if (dailyRank <= 10) return { type: 'daily', rank: dailyRank };
    return null;
  }

  async function addHighscore(name, s, replay) {
    const today = getTodayStr();
    const entry = { name: (name || 'Anonym').toUpperCase(), score: s, date: today };
    if (replay) entry.replay = replay;

    // Re-read fresh data to avoid overwriting scores from other tabs/clients
    try {
      const p = await Store.readHighscores();
      if (p) {
        highscores = p.highscores || [];
        dailyScores = p.dailyScores || [];
        dailyDate = p.dailyDate || '';
      }
    } catch (e) {}

    highscores.push(entry);
    highscores.sort((a, b) => b.score - a.score);
    highscores = highscores.slice(0, 10);
    if (dailyDate !== today) { dailyScores = []; dailyDate = today; }
    const now = new Date();
    const dailyEntry = { ...entry, time: `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}` };
    dailyScores.push(dailyEntry);
    dailyScores.sort((a, b) => b.score - a.score);
    dailyScores = dailyScores.slice(0, 10);
    saveHighscores();
    renderHighscores(entry);
  }

  function renderScoreList(container, scores, hl, listName) {
    if (!scores.length) {
      container.innerHTML = `<div class="empty-state">${listName === 'daily' ? 'No rounds today' : 'NOTHING HERE YET'}</div>`;
      return;
    }
    const ranks = [];
    for (let i = 0; i < scores.length; i++)
      ranks.push(i === 0 ? 1 : scores[i].score === scores[i - 1].score ? ranks[i - 1] : i + 1);

    container.innerHTML = scores.map((hs, i) => {
      const isHl = hl && hs.name === hl.name && hs.score === hl.score && hs.date === hl.date;
      const isReplaying = i === replayingIdx && listName === replayingList;
      const rank = ranks[i];
      const rankHtml = rank <= 3
        ? `<span class="hs-medal hs-medal-${rank}">${rank}</span>`
        : `<span class="hs-rank">${rank}</span>`;
      const replayBtn = hs.replay
        ? `<button class="hs-replay${isReplaying ? ' hs-stop' : ''}" data-idx="${i}" data-list="${listName}" title="${isReplaying ? 'Stop' : 'Watch replay'}">${isReplaying ? '■' : '▶'}</button>`
        : '<span class="hs-replay-spacer"></span>';
      const timeLabel = listName === 'daily' ? (hs.time || '') : (() => {
        const p = (hs.date || '').split('-');
        return p.length === 3 ? `${p[2]}.${p[1]}.${p[0].slice(2)}` : hs.date;
      })();
      return `<div class="hs-row${isHl ? ' hs-highlight' : ''}${isReplaying ? ' hs-replaying' : ''}">
        ${rankHtml}<span class="hs-name">${escapeHtml(hs.name)}</span>
        <span class="hs-score">${hs.score}</span><span class="hs-date">${timeLabel}</span>${replayBtn}</div>`;
    }).join('');
  }

  function renderHighscores(hl) {
    const today = getTodayStr();
    if (dailyDate !== today) { dailyScores = []; dailyDate = today; }
    renderScoreList(dailyList, dailyScores, hl, 'daily');
    renderScoreList(highscoresList, highscores, hl, 'legends');
    document.querySelectorAll('.hs-replay').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.idx), list = btn.dataset.list;
        if (idx === replayingIdx && list === replayingList) { stopReplay(); return; }
        const source = list === 'legends' ? highscores : dailyScores;
        if (source[idx]?.replay) startReplay(source[idx], idx, list);
      });
    });
  }

  // === GAME LOGIC ===
  function initGame() {
    initSnake();
    score = 0; speed = INITIAL_SPEED;
    SFX.setGameSpeed(speed);
    scoreEl.textContent = '0';
    isDeathAnim = false; currentPlacement = null; deathSegments = [];
    R.resetVisuals();
    spawnFood();
    Replay.startRecording(food);
  }

  function spawnFood() {
    const occupied = new Set(snake.map(s => s.y * GRID_SIZE + s.x));
    if (occupied.size >= GRID_SIZE * GRID_SIZE) return false;
    let pos;
    do { pos = { x: Math.floor(Math.random() * GRID_SIZE), y: Math.floor(Math.random() * GRID_SIZE) }; }
    while (occupied.has(pos.y * GRID_SIZE + pos.x));
    food = pos;
    return true;
  }

  function update() {
    direction = { ...nextDirection };
    Replay.tick(direction);
    const head = moveSnake();
    if (!head) { gameOver(); return; }
    if (head.x === food.x && head.y === food.y) {
      eatFood(); spawnFood(); Replay.foodEaten(food);
    } else snake.pop();
  }

  function gameOver() {
    const replay = Replay.stop();
    const placement = score > 0 ? getPlacement(score) : null;
    if (score > 0) addHighscore(currentPlayer, score, replay);
    else renderHighscores();
    startDeathAnim(placement);
  }

  // === GAME LOOP ===
  function renderLoop(timestamp) {
    if (!lastTickTime) lastTickTime = timestamp;
    const delta = timestamp - lastTickTime;
    lastTickTime = timestamp;

    if (running || replayMode) {
      tickAccumulator += delta;
      if (tickAccumulator > speed * 3) tickAccumulator = speed;
      const tick = running ? update : replayUpdate;
      while (tickAccumulator >= speed && (running || replayMode)) {
        tick();
        tickAccumulator -= speed;
      }
    }

    drawState();
    if (isDeathAnim) deathAnimFrame++;
    R.updateDissolution();

    if (isDeathAnim && trumpetDone && !dissolutionTriggered) {
      // Fallback: if deathFadeTimer didn't fire, trigger now
      triggerGameOverTransition();
    }

    if (isDeathAnim && dissolutionTriggered && trumpetDone && R.getDissolutionProgress() >= 1) {
      isDeathAnim = false; dissolutionTriggered = false;
      overlay.classList.remove('dissolve-fade-in');
      headerReplayBadge.classList.add('hidden');
      if (currentPlayer) playerBadge.classList.remove('hidden');
      replayData = null; replayingIdx = -1; replayingList = '';
      renderHighscores();
      if (deathTrumpetTimer) clearTimeout(deathTrumpetTimer);
      if (deathFadeTimer) clearTimeout(deathFadeTimer);
    }

    animFrame = requestAnimationFrame(renderLoop);
  }

  async function startGame() {
    resetState();
    await prepareAudioForPlay();
    initGame();
    overlay.classList.add('hidden');
    hideAllScreens();
    drawState();
    const musicReady = safeAudio(() => SFX.startMusic(), 450);
    const hissReady = safeAudio(() => SFX.startHiss(), 450);
    await Promise.all([musicReady, hissReady]);
    // rAF gate: snake starts slightly after audio is confirmed
    setTimeout(() => {
      requestAnimationFrame(() => {
        lastTickTime = 0; tickAccumulator = 0;
        running = true;
        animFrame = requestAnimationFrame(renderLoop);
      });
    }, 80);
  }

  // === REPLAY ===
  async function startReplay(entry, idx, list) {
    resetState();
    replayingIdx = typeof idx === 'number' ? idx : -1;
    replayingList = list || '';
    replayEntry = entry;
    renderHighscores();

    replayData = entry.replay;
    replayTick = 0; replayFoodIdx = 0;
    score = 0; speed = INITIAL_SPEED;
    scoreEl.textContent = '0';
    isDeathAnim = false; currentPlacement = null; deathSegments = [];
    R.resetVisuals();
    initSnake();
    food = { x: replayData.f0[0], y: replayData.f0[1] };

    overlay.classList.add('hidden');
    hideAllScreens();
    headerReplayBadge.classList.remove('hidden');
    playerBadge.classList.add('hidden');
    drawState();

    await prepareAudioForPlay();
    const musicReady = safeAudio(() => SFX.startMusic(), 450);
    void safeAudio(() => SFX.startHiss(), 350);
    SFX.setGameSpeed(speed);
    replayMode = true;
    await musicReady;
    // rAF gate: replay starts on next frame after music is confirmed
    requestAnimationFrame(() => {
      lastTickTime = 0; tickAccumulator = 0;
      animFrame = requestAnimationFrame(renderLoop);
    });
  }

  function stopReplay() {
    resetState();
    renderHighscores();
    showStartScreen();
    drawState();
  }

  function getReplayPlacement() {
    if (!replayEntry || !replayEntry.score) return null;
    const s = replayEntry.score;
    const legendRank = highscores.filter(h => h.score > s).length + 1;
    if (legendRank <= 10) return { type: 'legend', rank: legendRank };
    const today = getTodayStr();
    const todayScores = dailyDate === today ? dailyScores : [];
    const dailyRank = todayScores.filter(h => h.score > s).length + 1;
    if (dailyRank <= 10) return { type: 'daily', rank: dailyRank };
    return null;
  }

  function replayUpdate() {
    if (!replayData || replayTick >= replayData.ts.length) { startDeathAnim(getReplayPlacement()); return; }
    direction = Replay.parseDir(replayData.ts[replayTick++]);
    const head = moveSnake();
    if (!head) { startDeathAnim(getReplayPlacement()); return; }
    if (head.x === food.x && head.y === food.y) {
      eatFood();
      if (replayFoodIdx < replayData.fs.length) {
        food = { x: replayData.fs[replayFoodIdx][0], y: replayData.fs[replayFoodIdx][1] };
        replayFoodIdx++;
      }
    } else snake.pop();
  }

  // === INPUT ===
  function setDirection(dx, dy) {
    if (direction.x !== -dx || direction.y !== -dy) nextDirection = { x: dx, y: dy };
  }

  const keyDirs = { ArrowUp: [0,-1], w: [0,-1], ArrowDown: [0,1], s: [0,1], ArrowLeft: [-1,0], a: [-1,0], ArrowRight: [1,0], d: [1,0] };
  document.addEventListener('keydown', e => {
    if (document.activeElement?.tagName === 'INPUT') return;
    if (keyDirs[e.key]) { setDirection(...keyDirs[e.key]); e.preventDefault(); }
    if (e.key === 'Enter' && !startScreen.classList.contains('hidden')) startGame();
  });

  const btnDirs = { up: [0,-1], down: [0,1], left: [-1,0], right: [1,0] };
  document.querySelectorAll('.ctrl-btn').forEach(btn => {
    btn.addEventListener('click', () => { if (btnDirs[btn.dataset.dir]) setDirection(...btnDirs[btn.dataset.dir]); });
  });

  let touchStart = null;
  canvas.addEventListener('touchstart', e => { touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }, { passive: true });
  canvas.addEventListener('touchmove', e => {
    if (!touchStart) return;
    e.preventDefault();
    const dx = e.touches[0].clientX - touchStart.x, dy = e.touches[0].clientY - touchStart.y;
    if (Math.abs(dx) > 20 || Math.abs(dy) > 20) {
      Math.abs(dx) > Math.abs(dy) ? setDirection(dx > 0 ? 1 : -1, 0) : setDirection(0, dy > 0 ? 1 : -1);
      touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
  }, { passive: false });

  // === STORAGE SCREEN ===
  const storageScreen = $('storage-screen');
  const storageStatus = $('storage-status');
  const boardListEl = $('board-list');
  let storageReturnTo = 'start'; // 'start' | 'name'

  function syncStorageBadge() {
    const btn = $('btn-storage');
    if (!btn) return;
    btn.textContent = Store.isShared() ? '☁' : '💾';
    btn.title = Store.isShared()
      ? `Leaderboard: ${Store.getActiveLabel()} (proxy: ${Store.getActiveProxy()})`
      : 'Leaderboard: Local';
  }

  function setStatus(msg, kind) {
    storageStatus.className = 'firebase-status' + (kind ? ' ' + kind : '');
    storageStatus.textContent = msg || '';
  }

  function renderBoardList() {
    const activeProxy = Store.getActiveProxy();
    const isLocal = Store.getMode() === 'local';
    const boards = Store.listBoards();

    boardListEl.innerHTML = '';

    // Local row — always present
    const localLi = document.createElement('li');
    localLi.className = 'board-row' + (isLocal ? ' active' : '');
    localLi.dataset.proxy = '__local__';
    localLi.innerHTML = `
      <button class="board-pick" type="button" data-action="pick-local">
        <span class="board-icon">💾</span>
        <span class="board-meta">
          <span class="board-label">Local</span>
          <span class="board-proxy">privat — kun deg</span>
        </span>
        <span class="board-active-mark">${isLocal ? '✓' : ''}</span>
      </button>
    `;
    boardListEl.appendChild(localLi);

    // Shared boards
    for (const b of boards) {
      const isActive = !isLocal && activeProxy === b.proxy;
      const li = document.createElement('li');
      li.className = 'board-row' + (isActive ? ' active' : '');
      li.dataset.proxy = b.proxy;
      const safeLabel = lucidos.utils.escapeHtml(b.label);
      const safeProxy = lucidos.utils.escapeHtml(b.proxy);
      li.innerHTML = `
        <button class="board-pick" type="button" data-action="pick-shared" data-proxy="${safeProxy}">
          <span class="board-icon">☁</span>
          <span class="board-meta">
            <span class="board-label">${safeLabel}</span>
            <span class="board-proxy">${safeProxy}</span>
          </span>
          <span class="board-active-mark">${isActive ? '✓' : ''}</span>
        </button>
        <div class="board-actions">
          <button class="board-action-btn" type="button" data-action="test" data-proxy="${safeProxy}" title="Test tilkobling">⚡</button>
          <button class="board-action-btn danger" type="button" data-action="remove" data-proxy="${safeProxy}" title="Remove">✕</button>
        </div>
      `;
      boardListEl.appendChild(li);
    }
  }

  function showStorageScreen() {
    storageReturnTo = !nameScreen.classList.contains('hidden') ? 'name'
                    : (currentPlayer ? 'start' : 'name');
    resetState();
    hideAllScreens();
    overlay.classList.remove('hidden');
    storageScreen.classList.remove('hidden');
    addBoardForm.classList.add('hidden');
    setStatus('');
    renderBoardList();
  }

  function returnFromStorageScreen() {
    storageScreen.classList.add('hidden');
    if (storageReturnTo === 'start' && currentPlayer) showStartScreen();
    else showNameScreen(false);
  }

  $('btn-storage').addEventListener('click', showStorageScreen);
  $('btn-storage-close').addEventListener('click', returnFromStorageScreen);

  $('btn-add-board').addEventListener('click', async () => {
    const prompt = `Set up a new shared highscore board for Ouroboros.\n\n1. Ask me for the board's name (e.g. "Family") and the Firebase Realtime Database URL.\n2. Add a proxy entry to data/config/apis.json named snake-storage-<slug>.\n3. If the database requires an auth token: ask for the token via request_credential and add the query_param auth layer to the proxy.\n4. Test the proxy with a GET against /snake/highscores.json.\n5. Tell me what the proxy name ended up being — then I'll open Ouroboros and add it under the storage menu.\n\nSee apps/ouroboros/knowhow/storage-backends.md for the details.`;
    try {
      await navigator.clipboard.writeText(prompt);
      setStatus('✓ Prompt copied. Paste it into a new Lucidos chat and Lucidos will set up the proxy.', 'ok');
    } catch (e) {
      setStatus(`Kunne ikke kopiere: ${e.message || e}\n\nKopier manuelt:\n\n${prompt}`, 'error');
    }
  });

  // Board list — event delegation
  boardListEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const proxy = btn.dataset.proxy;

    if (action === 'pick-local') {
      Store.setLocal();
      setStatus('');
      syncStorageBadge();
      await loadHighscores();
      await loadPlayers();
      renderBoardList();
      return;
    }

    if (action === 'pick-shared') {
      try {
        Store.setActiveBoard(proxy);
        setStatus(`Tester ${proxy}…`);
        await Store.testBoard(proxy);
        setStatus('');
        syncStorageBadge();
        await loadHighscores();
        await loadPlayers();
        renderBoardList();
      } catch (err) {
        setStatus(err.message || String(err), 'error');
        Store.setLocal();
        syncStorageBadge();
        renderBoardList();
      }
      return;
    }

    if (action === 'test') {
      setStatus(`Tester ${proxy}…`);
      try {
        await Store.testBoard(proxy);
        setStatus(`✓ ${proxy} OK — lese + skrive virker.`, 'ok');
      } catch (err) {
        setStatus(err.message || String(err), 'error');
      }
      return;
    }

    if (action === 'remove') {
      const ok = confirm(`Remove leaderboard "${proxy}"? We won't touch the data in Firebase — only the choice here in the app.`);
      if (!ok) return;
      Store.removeBoard(proxy);
      setStatus('');
      syncStorageBadge();
      await loadHighscores();
      await loadPlayers();
      renderBoardList();
      return;
    }
  });

  // === EVENTS ===
  $('btn-name-ok').addEventListener('click', () => {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    setPlayer(name); showStartScreen();
  });
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-name-ok').click(); e.stopPropagation(); });
  $('btn-start').addEventListener('click', startGame);
  $('btn-switch').addEventListener('click', () => showNameScreen(true));
  playerBadge.addEventListener('click', () => {
    if (!nameScreen.classList.contains('hidden')) showStartScreen();
    else showNameScreen(true);
  });

  const toggleMusic = $('toggle-music'), toggleSfx = $('toggle-sfx');
  function syncToggleUI() {
    if (!SFX || !SFX.loadPrefs) return;
    const prefs = SFX.loadPrefs();
    toggleMusic.classList.toggle('active', prefs.musicEnabled);
    toggleSfx.classList.toggle('active', prefs.sfxEnabled);
  }
  toggleMusic.addEventListener('click', () => {
    if (!SFX) return;
    const on = toggleMusic.classList.toggle('active');
    SFX.init(); SFX.setMusicEnabled(on);
    if (on && running) SFX.startMusic();
  });
  toggleSfx.addEventListener('click', () => {
    if (!SFX) return;
    const on = toggleSfx.classList.toggle('active');
    SFX.init(); SFX.setSfxEnabled(on);
    if (on && running) SFX.startHiss();
  });

  let overlayTouch = null;
  overlay.addEventListener('touchstart', e => { overlayTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }, { passive: true });
  overlay.addEventListener('touchend', e => {
    if (!overlayTouch) return;
    const dy = e.changedTouches[0].clientY - overlayTouch.y;
    const dx = e.changedTouches[0].clientX - overlayTouch.x;
    overlayTouch = null;
    if (dy < -40 && Math.abs(dy) > Math.abs(dx) && !startScreen.classList.contains('hidden')) startGame();
  }, { passive: true });

  // Recompute the canvas backing store whenever the wrapper's box changes.
  // A ResizeObserver fires for ANY cause — window resize, Chrome zoom, AND
  // Lucidos UI-scale/font changes (which only alter root font-size and never
  // emit a window 'resize' event). Relying on 'resize' alone left the canvas
  // backing store stale on UI-scale changes, so it got CSS-stretched and the
  // pointer-coordinate math drifted. Observing the wrapper fixes all cases.
  let lastCanvasSize = -1;
  function syncCanvasSize() {
    R.resizeCanvas();
    if (canvas.width !== lastCanvasSize) {
      lastCanvasSize = canvas.width;
      if (!running && !isDeathAnim) drawState();
    }
  }
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => syncCanvasSize());
    ro.observe(canvas.parentElement);
  }
  // Keep the window 'resize' fallback for environments without ResizeObserver.
  window.addEventListener('resize', syncCanvasSize);
  R.resizeCanvas();

  waitForLucidos().then(async () => {
    lucidos.ui.applyPreferences();
    lucidos.ui.watchPreferences();
    await loadHighscores();
    await loadPlayers();
    syncToggleUI();
    syncStorageBadge();
    // Load custom audio config. Prefer the clip bundled with the app
    // (audio/clips/*.json, shipped with the plugin); fall back to a
    // user-published clip in the workspace (legacy path) for back-compat.
    try {
      async function loadClip(name) {
        try {
          const res = await fetch(`audio/clips/${name}.json`);
          if (res.ok) return await res.json();
        } catch (e) {}
        try {
          const data = await lucidos.data.read(`artifacts/games/audio/clips/${name}.json`);
          if (data) return JSON.parse(data);
        } catch (e) {}
        return null;
      }
      const [fanfare, trombone] = await Promise.all([loadClip('fanfare'), loadClip('trombone')]);
      const config = {};
      if (fanfare) config.fanfare = fanfare;
      if (trombone) config.trombone = trombone;
      if (config.fanfare || config.trombone) SFX.setConfig(config);
    } catch (e) {}
    const saved = getSavedPlayer();
    if (saved) { setPlayer(saved); showStartScreen(); } else showNameScreen();
    drawState();
    // Reveal with fade-in animation (same easing as after game over)
    document.querySelector('.game-container').classList.add('loaded');
  });
})();
