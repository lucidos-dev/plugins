// Ouroboros, controller: game state, the render loop, replays, the death
// sequence, and wiring between the UI modules.
(function (O) {
  'use strict';

  const { config, Game, Scores, Replay, Timing, Audio, Board, Effects, ScreenFx, GameOver, Screens, Scoreboard, StorageScreen, Input } = O;
  const $ = id => document.getElementById(id);

  const storage = O.SafeStorage.createSafeStorage();
  const store = O.createStore({ lucidos: () => window.lucidos, storage });
  const players = O.createPlayers({ store, storage });
  const recorder = Replay.createRecorder();

  const canvas = $('game-canvas');
  const scoreEl = $('current-score');
  const playerBadge = $('player-badge');
  const playerDisplay = $('player-display');
  const headerReplayBadge = $('header-replay-badge');

  // === STATE ===
  let snake = [], food = null;
  let direction = Game.DIRECTIONS.right, nextDirection = direction;
  let score = 0, speed = config.INITIAL_SPEED;
  let running = false;
  let lastTickTime = 0, tickAccumulator = 0, animFrame = null;
  let board = Scores.emptyBoard(Scores.todayStr());
  // Bumped by resetState(); async start paths bail out when it changes under them
  let session = 0;
  // While a replay runs: { playback, entry, list, index, playing }
  let replay = null;
  // While the death sequence runs: { segments, placement, clock, timers,
  // soundDone, dissolving }
  let death = null;

  Board.init(canvas);
  ScreenFx.init({ flash: $('screen-flash'), wrapper: canvas.parentElement, score: scoreEl });
  GameOver.init({ svgEl: $('game-over-svg'), labelEl: $('go-highscore'), fadeCanvasEl: $('dissolution-canvas') });
  Screens.init();

  // === AUDIO HELPERS ===
  // Audio must never block the game: every audio step gets a deadline.
  async function safeAudio(task, ms = 700) {
    try {
      return await Promise.race([
        Promise.resolve(task()),
        new Promise(resolve => setTimeout(() => resolve(null), ms))
      ]);
    } catch (e) {
      console.warn('Audio task failed', e);
      return null;
    }
  }

  async function prepareAudioForPlay() {
    await safeAudio(() => Audio.init(), 700);
    await safeAudio(() => Audio.waitForRunning(700), 750);
    try { Audio.resetTempo(); } catch (e) {}
  }

  // === STATE TRANSITIONS ===
  function clearDeathTimers() {
    if (death) death.timers.forEach(clearTimeout);
  }

  function showPlayerBadge() {
    headerReplayBadge.classList.add('hidden');
    if (players.current) playerBadge.classList.remove('hidden');
  }

  // Stop everything: game, replay, death sequence, audio.
  function resetState() {
    session++;
    cancelAnimationFrame(animFrame);
    clearDeathTimers();
    running = false; replay = null; death = null;
    Audio.stopHiss(); Audio.stopMusic();
    GameOver.cancel();
    Screens.setOverlayFadeIn(false);
    showPlayerBadge();
  }

  function resetVisuals() {
    Effects.reset();
    Board.reset();
    GameOver.reset();
  }

  function startRound(firstFood) {
    snake = Game.createSnake();
    direction = nextDirection = Game.DIRECTIONS.right;
    score = 0; speed = config.INITIAL_SPEED;
    Audio.setGameSpeed(speed);
    scoreEl.textContent = '0';
    resetVisuals();
    food = firstFood || Game.spawnFood(snake);
  }

  function startLoop() {
    lastTickTime = 0; tickAccumulator = 0;
    animFrame = requestAnimationFrame(renderLoop);
  }

  async function startGame() {
    resetState();
    const mySession = session;
    await prepareAudioForPlay();
    if (session !== mySession) return;
    startRound();
    recorder.start(food);
    Screens.hideOverlay();
    Screens.hideAll();
    drawIdle();
    await Promise.all([safeAudio(() => Audio.startMusic(), 450), safeAudio(() => Audio.startHiss(), 450)]);
    // The snake starts slightly after the audio is confirmed
    setTimeout(() => requestAnimationFrame(() => {
      if (session !== mySession) return;
      running = true;
      startLoop();
    }), 80);
  }

  // === GAME LOGIC ===
  function eatFood() {
    score++;
    scoreEl.textContent = score;
    ScreenFx.popScore();
    Audio.playEat();
    speed = Game.speedForScore(score);
    Audio.setGameSpeed(speed);
    Effects.spawnEat(food.x, food.y, Board.cellSize());
    ScreenFx.flashEat((food.x + 0.5) / config.GRID_SIZE * 100, (food.y + 0.5) / config.GRID_SIZE * 100);
  }

  // Move one cell. Returns false when the snake crashed.
  function step() {
    const r = Game.advance(snake, direction, food);
    if (r.dead) return false;
    Effects.addTrail(r.tail, Board.cellSize());
    snake = r.snake;
    if (r.ate) {
      eatFood();
      const next = replay ? replay.playback.nextFood() : Game.spawnFood(snake);
      if (next) food = next;
      if (!replay) recorder.foodEaten(food);
    }
    return true;
  }

  function update() {
    direction = nextDirection;
    recorder.tick(direction);
    if (!step()) gameOver();
  }

  function replayUpdate() {
    const dir = replay.playback.nextDirection();
    if (dir) direction = dir;
    if (!dir || !step()) startDeathAnim(Scores.placement(replay.entry.score, board, Scores.todayStr()));
  }

  function gameOver() {
    const recording = recorder.stop();
    const placement = score > 0 ? Scores.placement(score, board, Scores.todayStr()) : null;
    if (score > 0) void addHighscore(players.current, score, recording);
    else renderScores();
    startDeathAnim(placement);
  }

  // === DEATH SEQUENCE ===
  // 1. Crash: flash, shake, splash particles, jingle starts.
  // 2. Body dissolves; GAME OVER falls in; the placement label fades in.
  // 3. Halfway through the jingle's last note: dissolve to the start screen.
  // 4. When the jingle and the snapshot fade are both done: back to idle.
  function startDeathAnim(placement) {
    running = false;
    if (replay) replay.playing = false;
    ScreenFx.flashDeath();
    Audio.stopHiss();
    Audio.stopMusic();
    clearDeathTimers();

    const timing = placement ? Audio.playCelebrate() : Audio.playDeath();
    const d = death = {
      segments: [...snake],
      placement,
      clock: Timing.createFixedStepClock(),
      timers: [],
      soundDone: false,
      dissolving: false
    };
    if (timing.soundEnd > 0) {
      d.timers.push(setTimeout(triggerGameOverTransition, Timing.dissolveDelay(timing) * 1000));
      d.timers.push(setTimeout(() => { d.soundDone = true; }, timing.soundEnd * 1000));
    } else {
      d.soundDone = true;
    }
    Effects.spawnDeath(snake, Board.cellSize());
  }

  function triggerGameOverTransition() {
    if (!death || death.dissolving) return;
    death.dissolving = true;
    GameOver.startDissolve();
    Effects.reset();
    snake = [];
    food = null;
    Screens.showStart(players.current);
    Screens.setOverlayFadeIn(true);
    GameOver.startSnapshotFade(Board.canvas);
  }

  function finishDeath() {
    clearDeathTimers();
    death = null;
    replay = null;
    Screens.setOverlayFadeIn(false);
    showPlayerBadge();
    renderScores();
  }

  // === RENDER LOOP ===
  function drawIdle() {
    Board.draw({ snake, food, direction, isPlaying: running || !!replay?.playing });
  }

  function drawFrame(timestamp) {
    if (!death) { drawIdle(); return; }
    const { frame, steps } = death.clock.tick(timestamp);
    Board.draw({ death: { segments: death.segments, frame, steps } });
    GameOver.update(frame, steps, death.placement);
  }

  function renderLoop(timestamp) {
    if (!lastTickTime) lastTickTime = timestamp;
    const delta = timestamp - lastTickTime;
    lastTickTime = timestamp;

    const ticking = () => running || !!replay?.playing;
    if (ticking()) {
      tickAccumulator += delta;
      if (tickAccumulator > speed * 3) tickAccumulator = speed;
      while (tickAccumulator >= speed && ticking()) {
        (running ? update : replayUpdate)();
        tickAccumulator -= speed;
      }
    }

    drawFrame(timestamp);

    if (death) {
      // Fallback in case the dissolve timer never fired
      if (death.soundDone && !death.dissolving) triggerGameOverTransition();
      if (death.dissolving && death.soundDone && GameOver.isFadeDone()) finishDeath();
    }

    animFrame = requestAnimationFrame(renderLoop);
  }

  // === REPLAY ===
  async function startReplay(entry, index, list) {
    resetState();
    const mySession = session;
    const playback = Replay.createPlayback(entry.replay);
    replay = { playback, entry, list, index, playing: false };
    renderScores();
    startRound(playback.firstFood);

    Screens.hideOverlay();
    Screens.hideAll();
    headerReplayBadge.classList.remove('hidden');
    playerBadge.classList.add('hidden');
    drawIdle();

    await prepareAudioForPlay();
    if (session !== mySession) return;
    const musicReady = safeAudio(() => Audio.startMusic(), 450);
    void safeAudio(() => Audio.startHiss(), 350);
    Audio.setGameSpeed(speed);
    replay.playing = true;
    await musicReady;
    // The replay starts on the next frame after the music is confirmed
    requestAnimationFrame(() => { if (session === mySession) startLoop(); });
  }

  function stopReplay() {
    resetState();
    renderScores();
    Screens.showStart(players.current);
    drawIdle();
  }

  function onReplayClick(list, index) {
    if (replay && replay.list === list && replay.index === index) { stopReplay(); return; }
    const source = list === 'legends' ? board.highscores : board.dailyScores;
    if (source[index]?.replay) startReplay(source[index], index, list);
  }

  // === HIGHSCORES ===
  function renderScores(highlight) {
    board = Scores.normalizeBoard(board, Scores.todayStr());
    Scoreboard.render(board, { highlight, replaying: replay ? { list: replay.list, index: replay.index } : null });
  }

  // A null read means "nothing stored yet" for a board we just switched to
  // (the caller clears `board` first), and "keep what we have" otherwise.
  async function loadHighscores() {
    try {
      const payload = await store.readHighscores();
      board = Scores.normalizeBoard(payload || board, Scores.todayStr());
    } catch (e) {
      console.warn('loadHighscores failed', e);
      board = Scores.emptyBoard(Scores.todayStr());
    }
    renderScores();
  }

  async function addHighscore(name, value, recording) {
    // Re-read first so we don't overwrite scores from other tabs or devices
    let fresh = null;
    try { fresh = await store.readHighscores(); } catch (e) {}
    const { board: next, entry } = Scores.addEntry(fresh || board, { name, score: value, replay: recording });
    board = next;
    store.writeHighscores(board).catch(e => console.error('Save failed', e));
    renderScores(entry);
  }

  // === PLAYERS & SCREENS ===
  function setPlayer(name) {
    playerDisplay.textContent = players.setCurrent(name);
    playerBadge.classList.remove('hidden');
  }

  function showStartScreen() {
    Screens.showStart(players.current);
  }

  function showNameScreen(isSwitch) {
    resetState();
    Screens.showName({
      isSwitch,
      players: players.list(),
      onPick: name => { setPlayer(name); showStartScreen(); }
    });
  }

  let storageReturnTo = 'start';

  function showStorageScreen() {
    storageReturnTo = Screens.isNameVisible() ? 'name' : (players.current ? 'start' : 'name');
    resetState();
    Screens.showStorage();
    StorageScreen.show();
  }

  function returnFromStorageScreen() {
    if (storageReturnTo === 'start' && players.current) showStartScreen();
    else showNameScreen(false);
  }

  async function onBoardChanged() {
    board = Scores.emptyBoard(Scores.todayStr());
    await loadHighscores();
    await players.load();
  }

  // === WIRING ===
  Scoreboard.init({ daily: $('daily-list'), legends: $('highscores-list') }, onReplayClick);
  StorageScreen.init({ store, onBoardChanged, onClose: returnFromStorageScreen });

  Input.bind({
    canvas,
    overlay: $('overlay'),
    buttons: document.querySelectorAll('.ctrl-btn'),
    canStart: Screens.isStartVisible,
    onDirection: dir => { if (Game.canTurn(direction, dir)) nextDirection = dir; },
    onStart: startGame
  });

  const nameInput = $('name-input');
  $('btn-name-ok').addEventListener('click', () => {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    setPlayer(name);
    showStartScreen();
  });
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-name-ok').click(); e.stopPropagation(); });
  $('btn-start').addEventListener('click', startGame);
  $('btn-switch').addEventListener('click', () => showNameScreen(true));
  $('btn-storage').addEventListener('click', showStorageScreen);
  playerBadge.addEventListener('click', () => {
    if (Screens.isNameVisible()) showStartScreen();
    else showNameScreen(true);
  });

  const toggleMusic = $('toggle-music'), toggleSfx = $('toggle-sfx');
  function syncToggleUI() {
    const prefs = Audio.loadPrefs();
    toggleMusic.classList.toggle('active', prefs.musicEnabled);
    toggleSfx.classList.toggle('active', prefs.sfxEnabled);
  }
  toggleMusic.addEventListener('click', () => {
    const on = toggleMusic.classList.toggle('active');
    Audio.init(); Audio.setMusicEnabled(on);
    if (on && running) Audio.startMusic();
  });
  toggleSfx.addEventListener('click', () => {
    const on = toggleSfx.classList.toggle('active');
    Audio.init(); Audio.setSfxEnabled(on);
    if (on && running) Audio.startHiss();
  });

  // Recompute the canvas backing store whenever the wrapper's box changes.
  // A ResizeObserver fires for ANY cause, window resize, Chrome zoom, AND
  // Lucidos UI-scale/font changes (which only alter root font-size and never
  // emit a window 'resize' event). Observing the wrapper covers all of them;
  // the window 'resize' listener is a fallback for browsers without it.
  let lastCanvasSize = -1;
  function syncCanvasSize() {
    Board.resize();
    if (canvas.width !== lastCanvasSize) {
      lastCanvasSize = canvas.width;
      if (!running && !death) drawIdle();
    }
  }
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(syncCanvasSize).observe(canvas.parentElement);
  window.addEventListener('resize', syncCanvasSize);
  Board.resize();

  // === BOOT ===
  function waitForLucidos() {
    return new Promise(resolve => {
      const check = () => window.lucidos ? resolve(window.lucidos) : setTimeout(check, 100);
      check();
    });
  }

  // Prefer the clip bundled with the app (read via the SDK bridge, since a
  // relative fetch is CORS-refused in the app's isolated frame); fall back to
  // a user-published clip in the workspace (legacy path).
  async function loadClip(lucidos, name) {
    for (const path of [`apps/ouroboros/audio/clips/${name}.json`, `artifacts/games/audio/clips/${name}.json`]) {
      try {
        const raw = await lucidos.data.read(path);
        if (raw) return JSON.parse(raw);
      } catch (e) {}
    }
    return null;
  }

  waitForLucidos().then(async lucidos => {
    lucidos.ui.applyPreferences();
    lucidos.ui.watchPreferences();
    await loadHighscores();
    await players.load();
    syncToggleUI();
    await store.refreshBoards();
    StorageScreen.syncBadge();

    const [fanfare, trombone] = await Promise.all([loadClip(lucidos, 'fanfare'), loadClip(lucidos, 'trombone')]);
    if (fanfare || trombone) {
      const clips = {};
      if (fanfare) clips.fanfare = fanfare;
      if (trombone) clips.trombone = trombone;
      Audio.setConfig(clips);
    }

    const saved = players.saved();
    if (saved) { setPlayer(saved); showStartScreen(); } else showNameScreen();
    drawIdle();
    // Reveal with fade-in animation (same easing as after game over)
    document.querySelector('.game-container').classList.add('loaded');
  });
})(window.Ouroboros);
