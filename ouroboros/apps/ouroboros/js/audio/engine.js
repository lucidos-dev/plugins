// Ouroboros, audio engine: the AudioContext, its unlock dance, the mix
// buses, and the state shared by sfx.js and music.js.
(function (O) {
  'use strict';

  const { INITIAL_SPEED } = O.config;
  const prefsStorage = O.SafeStorage.createSafeStorage();

  const MUSIC_LEVEL = 0.48;
  const SFX_LEVEL = 0.38;

  const A = O.AudioEngine = {
    ctx: null,
    // Mix buses, created with the context
    masterVol: null, musicVol: null, sfxVol: null, echoSend: null,
    musicEnabled: true,
    sfxEnabled: true,
    // Tempo follows the game speed. Music commits `pendingSpeed` to
    // `gameSpeed` at each loop start so a loop never changes tempo halfway.
    gameSpeed: INITIAL_SPEED,
    pendingSpeed: INITIAL_SPEED,
    // Audio time of the first music bar; the hiss snaps to this grid
    musicOrigin: 0,
    // Clip overrides from audio/clips/*.json: { fanfare?, trombone? }
    customConfig: null,
    MUSIC_LEVEL,
    SFX_LEVEL
  };

  let audioUnlocked = false;

  function runSilentUnlock() {
    const ctx = A.ctx;
    if (!ctx) return;
    try {
      const buf = ctx.createBuffer(1, 1, ctx.sampleRate);
      const src = ctx.createBufferSource();
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.buffer = buf;
      src.connect(gain);
      gain.connect(ctx.destination);
      src.start(0);
      setTimeout(() => {
        try { src.disconnect(); } catch (e) {}
        try { gain.disconnect(); } catch (e) {}
      }, 60);
      audioUnlocked = true;
    } catch (e) {}
  }

  async function unlockAudio() {
    const ctx = A.ctx;
    if (!ctx) return false;
    if (ctx.state === 'closed') {
      A.ctx = null;
      audioUnlocked = false;
      return false;
    }

    // Must be attempted synchronously from gestures on iOS before any awaits.
    if (!audioUnlocked || ctx.state !== 'running') runSilentUnlock();

    if (ctx.state !== 'running') {
      try { await ctx.resume(); } catch (e) {}
    }

    if (!audioUnlocked || ctx.state !== 'running') runSilentUnlock();
    return ctx.state === 'running';
  }

  function waitForRunning(timeoutMs = 900) {
    const ctx = A.ctx;
    if (!ctx) return Promise.resolve(false);
    if (ctx.state === 'running') return Promise.resolve(true);

    return new Promise(resolve => {
      let done = false;
      const finish = ok => {
        if (done) return;
        done = true;
        try { ctx.removeEventListener?.('statechange', onState); } catch (e) {}
        resolve(ok);
      };
      const onState = () => {
        if (A.ctx && A.ctx.state === 'running') finish(true);
      };
      const tick = () => {
        if (done || !A.ctx) return finish(false);
        if (A.ctx.state === 'running') return finish(true);
        runSilentUnlock();
        try { A.ctx.resume(); } catch (e) {}
        requestAnimationFrame(tick);
      };

      ctx.addEventListener?.('statechange', onState);
      setTimeout(() => finish(!!A.ctx && A.ctx.state === 'running'), timeoutMs);
      tick();
    });
  }

  // iOS Safari: keep trying to unlock on every user gesture (never remove)
  ['pointerdown', 'touchstart', 'touchend', 'mousedown', 'click', 'keydown'].forEach(evt => {
    document.addEventListener(evt, () => {
      if (A.ctx) void unlockAudio(); else void init();
    }, { capture: true, passive: true });
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && A.ctx && A.ctx.state !== 'running') {
      audioUnlocked = false;
      void waitForRunning(900);
    }
  });

  async function init() {
    if (A.ctx && A.ctx.state !== 'closed') {
      await unlockAudio();
      return A.ctx;
    }

    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return null;

    const ctx = A.ctx = new AudioCtor({ latencyHint: 'interactive' });
    ctx.onstatechange = () => { if (A.ctx && A.ctx.state !== 'running') audioUnlocked = false; };

    A.masterVol = ctx.createGain(); A.masterVol.gain.value = 0.92; A.masterVol.connect(ctx.destination);
    A.musicVol = ctx.createGain(); A.musicVol.gain.value = MUSIC_LEVEL; A.musicVol.connect(A.masterVol);
    A.sfxVol = ctx.createGain(); A.sfxVol.gain.value = SFX_LEVEL; A.sfxVol.connect(A.masterVol);

    // Feedback echo, fed by the death splash
    const echoDelay = ctx.createDelay(1.0); echoDelay.delayTime.value = 0.16;
    const echoFeedback = ctx.createGain(); echoFeedback.gain.value = 0.25;
    const echoFilter = ctx.createBiquadFilter(); echoFilter.type = 'lowpass'; echoFilter.frequency.value = 2600; echoFilter.Q.value = 0.9;
    A.echoSend = ctx.createGain(); A.echoSend.gain.value = 0.3;
    A.echoSend.connect(echoDelay);
    echoDelay.connect(echoFilter);
    echoFilter.connect(echoFeedback);
    echoFeedback.connect(echoDelay);
    echoDelay.connect(A.masterVol);

    await unlockAudio();
    return ctx;
  }

  function noiseBuf(dur) {
    const ctx = A.ctx;
    const n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  // A periodic wave with the given sine harmonics (index 0 is DC)
  function harmonicWave(harmonics) {
    const real = new Float32Array(harmonics.length);
    const imag = new Float32Array(harmonics.length);
    harmonics.forEach((v, i) => { imag[i] = v; });
    return A.ctx.createPeriodicWave(real, imag);
  }

  function loadPrefs() {
    const m = prefsStorage.get('snake-music');
    const s = prefsStorage.get('snake-sfx');
    if (m !== null) A.musicEnabled = m === '1';
    if (s !== null) A.sfxEnabled = s === '1';
    return { musicEnabled: A.musicEnabled, sfxEnabled: A.sfxEnabled };
  }

  function savePref(key, on) {
    prefsStorage.set(key, on ? '1' : '0');
  }

  function resetTempo() {
    A.gameSpeed = INITIAL_SPEED;
    A.pendingSpeed = INITIAL_SPEED;
    A.musicOrigin = 0;
  }

  Object.assign(A, { init, waitForRunning, noiseBuf, harmonicWave, loadPrefs, savePref, resetTempo });
})(window.Ouroboros);
