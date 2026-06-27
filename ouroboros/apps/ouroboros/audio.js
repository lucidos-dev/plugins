// Snake Game — Audio System (Procedural Web Audio)
window.SnakeAudio = (function () {
  const INITIAL_SPEED = 140;
  const SPEED_STEP = 2;

  let ctx = null;
  let masterVol, musicVol, sfxVol;
  let hissSrc = null, hissGn = null, hissBp = null, hissHp = null;
  let hissTimers = [];
  let hissGeneration = 0;
  let echoDelay = null, echoFeedback = null, echoFilter = null, echoSend = null;
  let musicOn = false;
  let musicTimers = [];
  let activeMusicNodes = [];
  let musicRound = 0;
  let musicGeneration = 0;
  let musicEnabled = true;
  let sfxEnabled = true;
  let _gameSpeed = INITIAL_SPEED;
  let _pendingSpeed = INITIAL_SPEED;
  let _musicOrigin = 0;
  let _customConfig = null;

  function stepSpeed() {
    _gameSpeed = _pendingSpeed;
  }

  let _audioUnlocked = false;

  function runSilentUnlock() {
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
        try { src.disconnect(); } catch(e) {}
        try { gain.disconnect(); } catch(e) {}
      }, 60);
      _audioUnlocked = true;
    } catch(e) {}
  }

  async function unlockAudio() {
    if (!ctx) return false;
    if (ctx.state === 'closed') {
      ctx = null;
      _audioUnlocked = false;
      return false;
    }

    // Must be attempted synchronously from gestures on iOS before any awaits.
    if (!_audioUnlocked || ctx.state !== 'running') runSilentUnlock();

    if (ctx.state !== 'running') {
      try { await ctx.resume(); } catch (e) {}
    }

    if (!_audioUnlocked || ctx.state !== 'running') runSilentUnlock();
    return ctx.state === 'running';
  }

  function waitForRunning(timeoutMs = 900) {
    if (!ctx) return Promise.resolve(false);
    if (ctx.state === 'running') return Promise.resolve(true);

    return new Promise(resolve => {
      let done = false;
      const finish = ok => {
        if (done) return;
        done = true;
        try { ctx.removeEventListener?.('statechange', onState); } catch(e) {}
        resolve(ok);
      };
      const onState = () => {
        if (ctx && ctx.state === 'running') finish(true);
      };
      const tick = () => {
        if (done || !ctx) return finish(false);
        if (ctx.state === 'running') return finish(true);
        runSilentUnlock();
        try { ctx.resume(); } catch (e) {}
        requestAnimationFrame(tick);
      };

      ctx.addEventListener?.('statechange', onState);
      setTimeout(() => finish(!!ctx && ctx.state === 'running'), timeoutMs);
      tick();
    });
  }

  // iOS Safari: keep trying to unlock on every user gesture (never remove)
  ['pointerdown','touchstart','touchend','mousedown','click','keydown'].forEach(evt => {
    document.addEventListener(evt, () => {
      if (ctx) void unlockAudio(); else void init();
    }, { capture: true, passive: true });
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && ctx && ctx.state !== 'running') {
      _audioUnlocked = false;
      void waitForRunning(900);
    }
  });

  async function init() {
    if (ctx && ctx.state !== 'closed') {
      await unlockAudio();
      return ctx;
    }

    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return null;

    ctx = new AudioCtor({ latencyHint: 'interactive' });
    ctx.onstatechange = () => { if (ctx && ctx.state !== 'running') _audioUnlocked = false; };

    masterVol = ctx.createGain(); masterVol.gain.value = 0.92; masterVol.connect(ctx.destination);
    musicVol = ctx.createGain(); musicVol.gain.value = 0.48; musicVol.connect(masterVol);
    sfxVol = ctx.createGain(); sfxVol.gain.value = 0.38; sfxVol.connect(masterVol);
    echoDelay = ctx.createDelay(1.0); echoDelay.delayTime.value = 0.16;
    echoFeedback = ctx.createGain(); echoFeedback.gain.value = 0.25;
    echoFilter = ctx.createBiquadFilter(); echoFilter.type = 'lowpass'; echoFilter.frequency.value = 2600; echoFilter.Q.value = 0.9;
    echoSend = ctx.createGain(); echoSend.gain.value = 0.3;
    echoSend.connect(echoDelay);
    echoDelay.connect(echoFilter);
    echoFilter.connect(echoFeedback);
    echoFeedback.connect(echoDelay);
    echoDelay.connect(masterVol);

    await unlockAudio();
    return ctx;
  }

  function noiseBuf(dur) {
    const n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  // --- Snake hiss — rhythmic "hysj" pattern: sh(4), sh(2), sh(2) ---
  function startHiss() {
    if (!ctx || !sfxVol || hissSrc || !sfxEnabled) return Promise.resolve();
    hissGeneration++;
    const gen = hissGeneration;
    let resolveReady = null;
    const readyPromise = new Promise(r => { resolveReady = r; });

    // Continuous looping noise source
    hissSrc = ctx.createBufferSource();
    hissSrc.buffer = noiseBuf(2);
    hissSrc.loop = true;

    // Highpass removes low rumble — pure airy sibilance
    hissHp = ctx.createBiquadFilter();
    hissHp.type = 'highpass'; hissHp.frequency.value = 3500; hissHp.Q.value = 0.5;

    // Bandpass shapes the "sh" character — breathy whisper
    hissBp = ctx.createBiquadFilter();
    hissBp.type = 'bandpass'; hissBp.frequency.value = 7000; hissBp.Q.value = 0.5;

    hissGn = ctx.createGain();
    hissGn.gain.value = 0;

    hissSrc.connect(hissHp);
    hissHp.connect(hissBp);
    hissBp.connect(hissGn);
    hissGn.connect(sfxVol);
    hissSrc.start();

    let nextHissBar = 0; // absolute audio time for next bar

    function schedulePattern() {
      if (gen !== hissGeneration) return;
      // Use _gameSpeed (committed at music loop start), not _pendingSpeed
      const speed = _gameSpeed || _pendingSpeed;
      // Same BPM formula as music — keeps hiss in tempo
      const bpm = 128 * Math.pow(INITIAL_SPEED / speed, 0.6);
      const bt = 60 / bpm;
      const barDur = 4 * bt;
      const fadeIn = 0.02;
      const fadeOut = 0.04;
      const gap = bt * 0.15;
      const vol = 0.025;

      // Snap to music bar grid if music is playing
      if (nextHissBar === 0) {
        if (_musicOrigin > 0) {
          // Align to next bar boundary on the music grid
          const elapsed = ctx.currentTime - _musicOrigin;
          const barsElapsed = Math.ceil(elapsed / barDur);
          nextHissBar = _musicOrigin + barsElapsed * barDur;
          if (nextHissBar < ctx.currentTime + 0.02) nextHissBar += barDur;
        } else {
          nextHissBar = ctx.currentTime + 0.05;
        }
      }

      // If we fell behind (e.g. tab was suspended), skip ahead
      if (nextHissBar < ctx.currentTime + 0.02) {
        if (_musicOrigin > 0) {
          const elapsed = ctx.currentTime - _musicOrigin;
          const barsElapsed = Math.ceil(elapsed / barDur);
          nextHissBar = _musicOrigin + barsElapsed * barDur;
          if (nextHissBar < ctx.currentTime + 0.02) nextHissBar += barDur;
        } else {
          nextHissBar = ctx.currentTime + 0.05;
        }
      }

      // 1 takt (4 beats): sh(2), sh(1), sh(1)
      const pattern = [2, 1, 1];
      let t = nextHissBar;

      hissGn.gain.cancelScheduledValues(t - 0.01);
      hissGn.gain.setValueAtTime(0, t - 0.005);

      pattern.forEach(beats => {
        const dur = beats * bt;
        const shDur = dur - gap;
        hissGn.gain.setValueAtTime(0, t);
        hissGn.gain.linearRampToValueAtTime(vol, t + fadeIn);
        hissGn.gain.setValueAtTime(vol, t + shDur - fadeOut);
        hissGn.gain.linearRampToValueAtTime(0, t + shDur);
        t += dur;
      });

      // Advance to next bar (absolute)
      nextHissBar += barDur;

      // Resolve ready promise AFTER first bar actually starts playing (+30ms safety)
      if (resolveReady) {
        const waitMs = Math.max(0, (nextHissBar - barDur - ctx.currentTime) * 1000) + 30;
        const r = resolveReady; resolveReady = null;
        setTimeout(r, waitMs);
      }

      // Schedule next call before this bar ends
      const msUntilEnd = (nextHissBar - ctx.currentTime - 0.08) * 1000;
      hissTimers.push(setTimeout(schedulePattern, Math.max(30, msUntilEnd)));
    }

    schedulePattern();
    return readyPromise;
  }

  function stopHiss() {
    if (!hissSrc) return;
    hissGeneration++;
    hissTimers.forEach(t => clearTimeout(t));
    hissTimers = [];
    hissGn.gain.cancelScheduledValues(ctx.currentTime);
    hissGn.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.1);
    const s = hissSrc;
    hissSrc = null; hissBp = null; hissHp = null;
    setTimeout(() => { try { s.stop(); } catch(e){} }, 150);
  }

  // --- Eat sound (wet slurp + Mario-style coin) ---
  function playEat() {
    if (!ctx || !sfxEnabled) return 0;
    const t = ctx.currentTime;

    // 1) Chomp — short wet mouth sound (wider filter, more body)
    const slurp = ctx.createBufferSource(); slurp.buffer = noiseBuf(0.15);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1200, t);
    bp.frequency.exponentialRampToValueAtTime(300, t + 0.12);
    bp.Q.value = 3;
    const wobble = ctx.createOscillator(); wobble.type = 'sine'; wobble.frequency.value = 18;
    const wobG = ctx.createGain(); wobG.gain.value = 300;
    wobble.connect(wobG); wobG.connect(bp.frequency);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.5, t);
    sg.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
    slurp.connect(bp); bp.connect(sg); sg.connect(sfxVol);
    slurp.start(t); slurp.stop(t + 0.15);
    wobble.start(t); wobble.stop(t + 0.16);

    // Slafs body — litt tyngde under
    const body = ctx.createOscillator(); body.type = 'sine';
    body.frequency.setValueAtTime(250, t);
    body.frequency.exponentialRampToValueAtTime(120, t + 0.08);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.2, t);
    bg.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    body.connect(bg); bg.connect(sfxVol);
    body.start(t); body.stop(t + 0.1);

    // 2) Mario coin — to raske toner opp (B5 → E6), dempet
    const coin1 = ctx.createOscillator(); coin1.type = 'square';
    const c1g = ctx.createGain();
    c1g.gain.setValueAtTime(0.03, t);
    c1g.gain.setValueAtTime(0.03, t + 0.06);
    c1g.gain.linearRampToValueAtTime(0, t + 0.07);
    coin1.frequency.value = 988; // B5
    coin1.connect(c1g); c1g.connect(sfxVol);
    coin1.start(t); coin1.stop(t + 0.08);

    const coin2 = ctx.createOscillator(); coin2.type = 'square';
    const c2g = ctx.createGain();
    c2g.gain.setValueAtTime(0.03, t + 0.07);
    c2g.gain.setValueAtTime(0.02, t + 0.2);
    c2g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    coin2.frequency.value = 1319; // E6
    coin2.connect(c2g); c2g.connect(sfxVol);
    coin2.start(t + 0.07); coin2.stop(t + 0.36);
  }

  // --- Celebration sound (da-da-da-da daa daa daaaaa — pompous fanfare) ---
  function playCelebrate() {
    const tStartOffset = 0.35;
    const fc = _customConfig?.fanfare;
    const fanfare = fc?.notes || [
      { freq: 261.63, dur: 0.12, gap: 0.03, vol: 0.45 },
      { freq: 261.63, dur: 0.12, gap: 0.03, vol: 0.48 },
      { freq: 329.63, dur: 0.12, gap: 0.03, vol: 0.50 },
      { freq: 392.00, dur: 0.12, gap: 0.05, vol: 0.52 },
      { freq: 523.25, dur: 0.28, gap: 0.05, vol: 0.58 },
      { freq: 659.25, dur: 0.38, gap: 0.07, vol: 0.64 },
      { freq: 783.99, dur: 2.22, gap: 0, vol: 0.75, final: true }
    ];

    const sumDur = fanfare.reduce((acc, n) => acc + n.dur + (n.gap || 0), 0);
    const lastNote = fanfare[fanfare.length - 1];
    const timing = {
      lastNoteStart: tStartOffset + sumDur - lastNote.dur,
      soundEnd: tStartOffset + sumDur
    };

    if (!ctx || !sfxEnabled) return timing;
    const t = ctx.currentTime;

    const celebHarmonics = fc?.harmonics || [0, 1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.15, 0.1, 0.08, 0.06, 0.04, 0.03];
    const real = new Float32Array(celebHarmonics.length);
    const imag = new Float32Array(celebHarmonics.length);
    celebHarmonics.forEach((v, i) => { imag[i] = v; });
    const brassWave = ctx.createPeriodicWave(real, imag);

    function playTrumpet(freq, startTime, duration, volume, isLast) {
      const o = ctx.createOscillator();
      o.setPeriodicWave(brassWave);
      o.frequency.setValueAtTime(freq, startTime);

      const g = ctx.createGain();
      g.gain.setValueAtTime(0, startTime);
      g.gain.linearRampToValueAtTime(volume, startTime + 0.015);

      const finale = fc?.finale || { vibRate: 5.2, vibDepth: 0.006, swell: 1.7, filterPeak: 8000 };

      if (isLast) {
        const vib = ctx.createOscillator();
        vib.frequency.value = finale.vibRate;
        const vG = ctx.createGain();
        vG.gain.value = freq * finale.vibDepth;
        vib.connect(vG); vG.connect(o.frequency);
        vib.start(startTime + 0.3);
        vib.stop(startTime + duration);

        // Massive crescendo swell — builds to super pompous
        g.gain.linearRampToValueAtTime(volume * 0.9, startTime + 0.1);
        g.gain.linearRampToValueAtTime(volume * 1.1, startTime + duration * 0.3);
        g.gain.linearRampToValueAtTime(volume * ((1 + finale.swell) / 2), startTime + duration * 0.65);
        g.gain.linearRampToValueAtTime(volume * finale.swell, startTime + duration * 0.85);
        g.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
      } else {
        g.gain.setValueAtTime(volume * 0.9, startTime + duration * 0.7);
        g.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
      }

      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(5000, startTime);
      if (isLast) {
        // Filter opens up bright as it swells, then closes
        lp.frequency.linearRampToValueAtTime(finale.filterPeak, startTime + duration * 0.7);
        lp.frequency.exponentialRampToValueAtTime(2400, startTime + duration);
      }

      o.connect(lp);
      lp.connect(g);
      g.connect(sfxVol);

      o.start(startTime);
      o.stop(startTime + duration + 0.05);
    }

    let nt = t + tStartOffset;
    fanfare.forEach((note, i) => {
      const isLast = !!note.final;
      playTrumpet(note.freq, nt, note.dur, note.vol, isLast);

      if (isLast) {
        // Chord from config or default
        const chord = fc?.chord || [
          { freq: 659.25, vol: note.vol * 0.65 },
          { freq: 523.25, vol: note.vol * 0.55 },
          { freq: 392.00, vol: note.vol * 0.45 },
          { freq: 329.63, vol: note.vol * 0.40 },
          { freq: 261.63, vol: note.vol * 0.35 },
          { freq: 1046.50, vol: note.vol * 0.28 },
          { freq: 130.81, vol: note.vol * 0.30 },
          { freq: 196.00, vol: note.vol * 0.25 }
        ];
        chord.forEach(c => playTrumpet(c.freq, nt, note.dur, c.vol, true));
      }

      nt += note.dur + note.gap;
    });

    return timing;
  }

  // --- Death sound (splash + sad trombone fail) ---
  function playDeath() {
    const tStartOffset = 0.35;
    const tc = _customConfig?.trombone;
    const notes = tc?.notes || [
      { freq: 262, endFreq: 256, dur: 0.44, gap: 0.05, press: 0.7, vibRate: 4.5, vibDepth: 0.005 },
      { freq: 247, endFreq: 242, dur: 0.46, gap: 0.05, press: 0.8, vibRate: 5.0, vibDepth: 0.006 },
      { freq: 233, endFreq: 228, dur: 0.62, gap: 0.06, press: 0.9, vibRate: 5.5, vibDepth: 0.007 },
      { freq: 220, endFreq: 208, dur: 1.96,  gap: 0.08, press: 1.0, vibRate: 5.0, vibDepth: 0.010 },
    ];
    const sumDur = notes.reduce((acc, note) => acc + note.dur + (note.gap || 0.06), 0);
    const lastNote = notes[notes.length - 1];
    const lastGap = lastNote.gap || 0.06;
    const timing = {
      lastNoteStart: tStartOffset + sumDur - lastNote.dur - lastGap,
      soundEnd: tStartOffset + sumDur - lastGap
    };
    if (!ctx || !sfxEnabled) return timing;
    const t = ctx.currentTime;

    // === SPLASH — wet splat ===
    const splat = ctx.createBufferSource(); splat.buffer = noiseBuf(0.2);
    const splatBp = ctx.createBiquadFilter(); splatBp.type = 'bandpass';
    splatBp.frequency.setValueAtTime(1600, t);
    splatBp.frequency.exponentialRampToValueAtTime(250, t + 0.18);
    splatBp.Q.value = 2.5;
    const splatG = ctx.createGain();
    splatG.gain.setValueAtTime(0.3, t);
    splatG.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    splat.connect(splatBp); splatBp.connect(splatG); splatG.connect(sfxVol); splatG.connect(echoSend);
    splat.start(t); splat.stop(t + 0.22);

    // Body plop
    const plop = ctx.createOscillator(); plop.type = 'sine';
    plop.frequency.setValueAtTime(280, t);
    plop.frequency.exponentialRampToValueAtTime(60, t + 0.12);
    const plopG = ctx.createGain();
    plopG.gain.setValueAtTime(0.2, t);
    plopG.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
    plop.connect(plopG); plopG.connect(sfxVol);
    plop.start(t); plop.stop(t + 0.15);

    // Wet secondary splatter
    const splat2 = ctx.createBufferSource(); splat2.buffer = noiseBuf(0.12);
    const sp2Bp = ctx.createBiquadFilter(); sp2Bp.type = 'bandpass';
    sp2Bp.frequency.setValueAtTime(2200, t + 0.04);
    sp2Bp.frequency.exponentialRampToValueAtTime(400, t + 0.14);
    sp2Bp.Q.value = 1.8;
    const sp2G = ctx.createGain();
    sp2G.gain.setValueAtTime(0.15, t + 0.04);
    sp2G.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    splat2.connect(sp2Bp); sp2Bp.connect(sp2G); sp2G.connect(sfxVol); sp2G.connect(echoSend);
    splat2.start(t + 0.04); splat2.stop(t + 0.16);

    // Small drip sounds
    for (let i = 0; i < 5; i++) {
      const dt = t + 0.03 + Math.random() * 0.15;
      const drip = ctx.createOscillator(); drip.type = 'sine';
      const freq = 700 + Math.random() * 1100;
      drip.frequency.setValueAtTime(freq, dt);
      drip.frequency.exponentialRampToValueAtTime(freq * 0.3, dt + 0.05);
      const dg = ctx.createGain();
      dg.gain.setValueAtTime(0.04 + Math.random() * 0.04, dt);
      dg.gain.exponentialRampToValueAtTime(0.001, dt + 0.06);
      drip.connect(dg); dg.connect(sfxVol);
      drip.start(dt); drip.stop(dt + 0.07);
    }

    // === SAD TROMBONE ===
    const tStart = t + 0.35;

    // Custom periodic wave — trumpet harmonic series (bright, brassy)
    const deathHarmonics = tc?.harmonics || [0, 1.0, 0.85, 0.7, 0.55, 0.45, 0.35, 0.25, 0.18, 0.12, 0.08, 0.06, 0.04, 0.03, 0.02, 0.015];
    const real = new Float32Array(deathHarmonics.length);
    const imag = new Float32Array(deathHarmonics.length);
    deathHarmonics.forEach((v, i) => { imag[i] = v; });
    const brassWave = ctx.createPeriodicWave(real, imag);

    let nt = tStart;
    notes.forEach((note, ni) => {
      const atk = 0.03 + ni * 0.008;

      // Main osc — custom brass wave
      const o = ctx.createOscillator();
      o.setPeriodicWave(brassWave);
      if (note.dur > 1.0) {
        // Pitch drift — stable sustain first, then embouchure meltdown from ~0.7s
        o.frequency.setValueAtTime(note.freq, nt);
        o.frequency.linearRampToValueAtTime(note.freq * 1.002, nt + 0.25);
        o.frequency.linearRampToValueAtTime(note.freq * 0.999, nt + 0.5);
        o.frequency.linearRampToValueAtTime(note.freq * 1.003, nt + 0.7);
        o.frequency.linearRampToValueAtTime(note.freq * 0.985, nt + 0.95);
        o.frequency.linearRampToValueAtTime(note.freq * 0.970, nt + 1.15);
        o.frequency.linearRampToValueAtTime(note.freq * 0.945, nt + 1.4);
        o.frequency.linearRampToValueAtTime(note.freq * 0.92, nt + 1.6);
        o.frequency.exponentialRampToValueAtTime(note.endFreq * 0.7, nt + note.dur);
      } else {
        o.frequency.setValueAtTime(note.freq, nt);
        o.frequency.exponentialRampToValueAtTime(note.endFreq, nt + note.dur);
      }

      // Detuned second osc for chorus thickness
      const o2 = ctx.createOscillator();
      o2.setPeriodicWave(brassWave);
      if (note.dur > 1.0) {
        o2.frequency.setValueAtTime(note.freq * 1.003, nt);
        o2.frequency.linearRampToValueAtTime(note.freq * 1.005, nt + 0.25);
        o2.frequency.linearRampToValueAtTime(note.freq * 1.002, nt + 0.5);
        o2.frequency.linearRampToValueAtTime(note.freq * 1.006, nt + 0.7);
        o2.frequency.linearRampToValueAtTime(note.freq * 0.982, nt + 0.95);
        o2.frequency.linearRampToValueAtTime(note.freq * 0.960, nt + 1.15);
        o2.frequency.linearRampToValueAtTime(note.freq * 0.935, nt + 1.4);
        o2.frequency.linearRampToValueAtTime(note.freq * 0.903, nt + 1.6);
        o2.frequency.exponentialRampToValueAtTime(note.endFreq * 0.703, nt + note.dur);
      } else {
        o2.frequency.setValueAtTime(note.freq * 1.003, nt);
        o2.frequency.exponentialRampToValueAtTime(note.endFreq * 1.003, nt + note.dur);
      }

      // Vibrato disabled — testing without
      const vib = ctx.createOscillator(); vib.type = 'sine';
      vib.frequency.value = 5;
      const vibG = ctx.createGain();
      vibG.gain.value = 0;
      vib.connect(vibG); vibG.connect(o.frequency); vibG.connect(o2.frequency);

      // Formant 1 — warm brass body
      const f1 = ctx.createBiquadFilter(); f1.type = 'peaking';
      f1.frequency.value = tc?.formant1 || 620; f1.Q.value = 2.0; f1.gain.value = tc?.formant1Gain || 7;

      // Formant 2 — upper brass presence (toned down)
      const f2 = ctx.createBiquadFilter(); f2.type = 'peaking';
      f2.frequency.value = tc?.formant2 || 1600; f2.Q.value = 2.5; f2.gain.value = tc?.formant2Gain || 3;

      // Lowpass — opens on attack, kept warm
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.7;
      lp.frequency.setValueAtTime(900, nt);
      lp.frequency.linearRampToValueAtTime(tc?.lpOpen || 2600, nt + atk);
      if (note.dur > 1.0) {
        // Simulate embouchure wavering — filter opens/closes subtly
        lp.frequency.setValueAtTime(2400, nt + 0.25);
        lp.frequency.linearRampToValueAtTime(2200, nt + 0.5);
        lp.frequency.linearRampToValueAtTime(2400, nt + 0.7);
        lp.frequency.linearRampToValueAtTime(1600, nt + 1.1);
        lp.frequency.linearRampToValueAtTime(1200, nt + 1.5);
        lp.frequency.linearRampToValueAtTime(800, nt + note.dur);
      } else {
        lp.frequency.setValueAtTime(2000, nt + note.dur * 0.5);
        lp.frequency.linearRampToValueAtTime(1000, nt + note.dur);
      }

      // Lip buzz — filtered noise near fundamental gives organic texture
      const buzz = ctx.createBufferSource(); buzz.buffer = noiseBuf(note.dur + 0.02);
      const buzzBp = ctx.createBiquadFilter(); buzzBp.type = 'bandpass';
      buzzBp.frequency.value = note.freq * 2; buzzBp.Q.value = 3.5;
      const buzzG = ctx.createGain();
      buzzG.gain.setValueAtTime(0, nt);
      buzzG.gain.linearRampToValueAtTime(0.07 * note.press, nt + atk);
      buzzG.gain.setValueAtTime(0.05 * note.press, nt + note.dur * 0.5);
      buzzG.gain.linearRampToValueAtTime(0, nt + note.dur);
      buzz.connect(buzzBp); buzzBp.connect(buzzG); buzzG.connect(f1);

      // Breath air — lighter, just a touch
      const breath = ctx.createBufferSource(); breath.buffer = noiseBuf(note.dur);
      const breathBp = ctx.createBiquadFilter(); breathBp.type = 'bandpass';
      breathBp.frequency.value = note.freq * 1.5; breathBp.Q.value = 1.5;
      const breathG = ctx.createGain();
      if (note.dur > 1.0) {
        // Breath swells and wavers on long sustain
        breathG.gain.setValueAtTime(0, nt);
        breathG.gain.linearRampToValueAtTime(0.12 * note.press, nt + atk);
        breathG.gain.linearRampToValueAtTime(0.08 * note.press, nt + 0.4);
        breathG.gain.linearRampToValueAtTime(0.10 * note.press, nt + 0.7);
        breathG.gain.linearRampToValueAtTime(0.14 * note.press, nt + 1.0);
        breathG.gain.linearRampToValueAtTime(0.06 * note.press, nt + 1.4);
        breathG.gain.linearRampToValueAtTime(0.10 * note.press, nt + 1.35);
        breathG.gain.linearRampToValueAtTime(0, nt + note.dur);
      } else {
        breathG.gain.setValueAtTime(0, nt);
        breathG.gain.linearRampToValueAtTime(0.10 * note.press, nt + atk);
        breathG.gain.setValueAtTime(0.07 * note.press, nt + note.dur * 0.5);
        breathG.gain.linearRampToValueAtTime(0, nt + note.dur);
      }
      breath.connect(breathBp); breathBp.connect(breathG); breathG.connect(sfxVol);

      // Main gain — fades out from halfway
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, nt);
      g.gain.linearRampToValueAtTime(0.6 * note.press, nt + atk);
      g.gain.linearRampToValueAtTime(0.35 * note.press, nt + note.dur * 0.5);
      g.gain.exponentialRampToValueAtTime(0.001, nt + note.dur);

      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(0, nt);
      g2.gain.linearRampToValueAtTime(0.22 * note.press, nt + atk);
      g2.gain.linearRampToValueAtTime(0.12 * note.press, nt + note.dur * 0.5);
      g2.gain.exponentialRampToValueAtTime(0.001, nt + note.dur);

      // Chain: oscs → formants → lowpass → gain → out
      o.connect(f1); o2.connect(f1);
      f1.connect(f2); f2.connect(lp);
      lp.connect(g); lp.connect(g2);
      g.connect(sfxVol); g2.connect(sfxVol);

      buzz.start(nt); buzz.stop(nt + note.dur + 0.02);
      breath.start(nt); breath.stop(nt + note.dur + 0.01);
      vib.start(nt); o.start(nt); o2.start(nt);
      vib.stop(nt + note.dur + 0.02);
      o.stop(nt + note.dur + 0.02);
      o2.stop(nt + note.dur + 0.02);

      nt += note.dur + (note.gap || 0.06);
    });

    const lastNoteFinal = notes[notes.length - 1];
    const lastGapFinal = lastNoteFinal.gap || 0.06;
    return { lastNoteStart: nt - t - lastNoteFinal.dur - lastGapFinal, soundEnd: nt - t - lastGapFinal };
  }

  // --- Helper: schedule a note ---
  function mkNote(freq, start, dur, type, dest) {
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(type === 'square' ? 0.11 : 0.16, start + 0.012);
    g.gain.setValueAtTime(type === 'square' ? 0.09 : 0.13, start + dur * 0.8);
    g.gain.linearRampToValueAtTime(0, start + dur);
    o.connect(g); g.connect(dest);
    o.start(start); o.stop(start + dur + 0.01);
    activeMusicNodes.push(o);
  }

  // --- Helper: schedule a drum hit (tabla-style) ---
  function mkDrum(type, start, vol) {
    vol = vol || 1;
    if (type === 'doum') {
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(95, start);
      o.frequency.exponentialRampToValueAtTime(38, start + 0.18);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.32 * vol, start);
      g.gain.setValueAtTime(0.28 * vol, start + 0.04);
      g.gain.exponentialRampToValueAtTime(0.001, start + 0.28);
      o.connect(g); g.connect(musicVol);
      o.start(start); o.stop(start + 0.3);
      activeMusicNodes.push(o);
      const o2 = ctx.createOscillator(); o2.type = 'sine';
      o2.frequency.setValueAtTime(190, start);
      o2.frequency.exponentialRampToValueAtTime(76, start + 0.12);
      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(0.1 * vol, start);
      g2.gain.exponentialRampToValueAtTime(0.001, start + 0.12);
      o2.connect(g2); g2.connect(musicVol);
      o2.start(start); o2.stop(start + 0.14);
      activeMusicNodes.push(o2);
      const ns = ctx.createBufferSource(); ns.buffer = noiseBuf(0.025);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 500;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.12 * vol, start);
      ng.gain.exponentialRampToValueAtTime(0.001, start + 0.018);
      ns.connect(lp); lp.connect(ng); ng.connect(musicVol);
      ns.start(start); ns.stop(start + 0.03);
      activeMusicNodes.push(ns);
    } else if (type === 'tek') {
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(680, start);
      o.frequency.exponentialRampToValueAtTime(420, start + 0.06);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.14 * vol, start);
      g.gain.exponentialRampToValueAtTime(0.001, start + 0.07);
      o.connect(g); g.connect(musicVol);
      o.start(start); o.stop(start + 0.08);
      activeMusicNodes.push(o);
      const ns = ctx.createBufferSource(); ns.buffer = noiseBuf(0.03);
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass';
      hp.frequency.value = 6500; hp.Q.value = 1.0;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.12 * vol, start);
      ng.gain.exponentialRampToValueAtTime(0.001, start + 0.025);
      ns.connect(hp); hp.connect(ng); ng.connect(musicVol);
      ns.start(start); ns.stop(start + 0.04);
      activeMusicNodes.push(ns);
    } else if (type === 'ka') {
      const ns = ctx.createBufferSource(); ns.buffer = noiseBuf(0.02);
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
      bp.frequency.value = 4500; bp.Q.value = 0.8;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.05 * vol, start);
      g.gain.exponentialRampToValueAtTime(0.001, start + 0.015);
      ns.connect(bp); bp.connect(g); g.connect(musicVol);
      ns.start(start); ns.stop(start + 0.025);
      activeMusicNodes.push(ns);
    } else if (type === 'dha') {
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(110, start);
      o.frequency.exponentialRampToValueAtTime(55, start + 0.2);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.3 * vol, start);
      g.gain.exponentialRampToValueAtTime(0.001, start + 0.32);
      o.connect(g); g.connect(musicVol);
      o.start(start); o.stop(start + 0.34);
      activeMusicNodes.push(o);
      const o2 = ctx.createOscillator(); o2.type = 'triangle';
      o2.frequency.setValueAtTime(330, start);
      o2.frequency.exponentialRampToValueAtTime(200, start + 0.1);
      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(0.08 * vol, start);
      g2.gain.exponentialRampToValueAtTime(0.001, start + 0.1);
      o2.connect(g2); g2.connect(musicVol);
      o2.start(start); o2.stop(start + 0.12);
      activeMusicNodes.push(o2);
      const ns = ctx.createBufferSource(); ns.buffer = noiseBuf(0.035);
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
      bp.frequency.value = 800; bp.Q.value = 1.5;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.15 * vol, start);
      ng.gain.exponentialRampToValueAtTime(0.001, start + 0.025);
      ns.connect(bp); bp.connect(ng); ng.connect(musicVol);
      ns.start(start); ns.stop(start + 0.04);
      activeMusicNodes.push(ns);
    } else if (type === 'tin') {
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(950, start);
      o.frequency.exponentialRampToValueAtTime(620, start + 0.09);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.11 * vol, start);
      g.gain.exponentialRampToValueAtTime(0.001, start + 0.1);
      o.connect(g); g.connect(musicVol);
      o.start(start); o.stop(start + 0.12);
      activeMusicNodes.push(o);
      const o2 = ctx.createOscillator(); o2.type = 'sine';
      o2.frequency.setValueAtTime(1900, start);
      o2.frequency.exponentialRampToValueAtTime(1300, start + 0.05);
      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(0.04 * vol, start);
      g2.gain.exponentialRampToValueAtTime(0.001, start + 0.05);
      o2.connect(g2); g2.connect(musicVol);
      o2.start(start); o2.stop(start + 0.06);
      activeMusicNodes.push(o2);
    } else if (type === 'tun') {
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(200, start);
      o.frequency.exponentialRampToValueAtTime(130, start + 0.12);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.2 * vol, start);
      g.gain.exponentialRampToValueAtTime(0.001, start + 0.18);
      o.connect(g); g.connect(musicVol);
      o.start(start); o.stop(start + 0.2);
      activeMusicNodes.push(o);
      const ns = ctx.createBufferSource(); ns.buffer = noiseBuf(0.015);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.09 * vol, start);
      ng.gain.exponentialRampToValueAtTime(0.001, start + 0.012);
      ns.connect(lp); lp.connect(ng); ng.connect(musicVol);
      ns.start(start); ns.stop(start + 0.02);
      activeMusicNodes.push(ns);
    } else if (type === 'slap') {
      const ns = ctx.createBufferSource(); ns.buffer = noiseBuf(0.04);
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
      bp.frequency.value = 2200; bp.Q.value = 2.5;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.18 * vol, start);
      g.gain.exponentialRampToValueAtTime(0.001, start + 0.035);
      ns.connect(bp); bp.connect(g); g.connect(musicVol);
      ns.start(start); ns.stop(start + 0.045);
      activeMusicNodes.push(ns);
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(400, start);
      o.frequency.exponentialRampToValueAtTime(160, start + 0.03);
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.12 * vol, start);
      og.gain.exponentialRampToValueAtTime(0.001, start + 0.04);
      o.connect(og); og.connect(musicVol);
      o.start(start); o.stop(start + 0.05);
      activeMusicNodes.push(o);
    }
  }

  // --- Exotic oriental snake charmer music (Hijaz scale) ---
  function startMusic() {
    if (musicOn || !musicEnabled || !ctx || !musicVol) return Promise.resolve();
    musicOn = true;
    musicGeneration++;
    const thisGen = musicGeneration;
    let nextLoopStart = 0;
    const BASE_BPM = 128;
    let resolveReady = null;
    const readyPromise = new Promise(r => { resolveReady = r; });

    const mel = [
      [294,0.5],[311,0.5],[370,0.75],[392,0.25],
      [440,0.5,{bf:392}],[466,0.25],[440,0.25],[392,1],
      [370,0.5],[311,0.5],[294,0.75,{bf:311}],[311,0.25,{bf:294}],
      [370,0.5],[294,0.5],[294,1],
      [440,0.5],[466,0.5,{bf:440}],[523,0.75,{bf:466}],[466,0.25],
      [440,0.5],[392,0.5],[370,1],
      [311,0.5],[370,0.5],[392,0.5],[370,0.25],[311,0.25],
      [294,1],[294,1],
    ];

    const mel2 = [
      [370,0.5],[392,0.5],[440,0.75],[466,0.25],
      [523,0.5,{bf:466}],[587,0.25],[523,0.25],[466,1],
      [440,0.5],[392,0.5],[370,0.75,{bf:392}],[392,0.25,{bf:370}],
      [440,0.5],[370,0.5],[370,1],
      [523,0.5],[587,0.5,{bf:523}],[622,0.75,{bf:587}],[587,0.25],
      [523,0.5],[466,0.5],[440,1],
      [392,0.5],[440,0.5],[466,0.5],[440,0.25],[392,0.25],
      [370,1],[370,1],
    ];

    const bas = [
      [147,4],[147,2],[196,2],
      [147,4],[220,2],[147,2],
    ];
    const totalBeats = mel.reduce((s,[,b]) => s + b, 0);

    function mkOrientalNote(freq, start, dur, dest, vol, opts) {
      const v = vol || 1;
      const bendFrom = opts && opts.bf ? opts.bf : null;
      const glideTime = Math.min(dur * 0.35, 0.09);
      const startFreq = bendFrom || freq;
      const o1 = ctx.createOscillator(); o1.type = 'sine';
      const o2 = ctx.createOscillator(); o2.type = 'triangle';
      o1.frequency.setValueAtTime(startFreq, start);
      o2.frequency.setValueAtTime(startFreq, start);
      if (bendFrom) {
        o1.frequency.exponentialRampToValueAtTime(freq, start + glideTime);
        o2.frequency.exponentialRampToValueAtTime(freq, start + glideTime);
      }
      const vib = ctx.createOscillator(); vib.type = 'sine'; vib.frequency.value = 5.5;
      const vibG = ctx.createGain(); vibG.gain.value = freq * 0.012;
      vib.connect(vibG); vibG.connect(o1.frequency); vibG.connect(o2.frequency);
      const g1 = ctx.createGain(); const g2 = ctx.createGain();
      g1.gain.setValueAtTime(0, start);
      g1.gain.linearRampToValueAtTime(0.12 * v, start + 0.02);
      g1.gain.setValueAtTime(0.10 * v, start + dur * 0.7);
      g1.gain.linearRampToValueAtTime(0, start + dur);
      g2.gain.setValueAtTime(0, start);
      g2.gain.linearRampToValueAtTime(0.04 * v, start + 0.02);
      g2.gain.setValueAtTime(0.03 * v, start + dur * 0.7);
      g2.gain.linearRampToValueAtTime(0, start + dur);
      o1.connect(g1); g1.connect(dest);
      o2.connect(g2); g2.connect(dest);
      vib.start(start); o1.start(start); o2.start(start);
      vib.stop(start + dur + 0.01); o1.stop(start + dur + 0.01); o2.stop(start + dur + 0.01);
      activeMusicNodes.push(o1, o2, vib);
    }

    function loop() {
      if (!musicOn || thisGen !== musicGeneration) return;
      activeMusicNodes = [];
      stepSpeed();
      const bpm = BASE_BPM * Math.pow(INITIAL_SPEED / _gameSpeed, 0.6);
      const bt = 60 / bpm;
      const now = nextLoopStart > ctx.currentTime ? nextLoopStart : ctx.currentTime + 0.05;
      if (_musicOrigin === 0) _musicOrigin = now;
      const isHarmonyRound = musicRound % 2 === 1;
      musicRound++;

      let t = now;
      mel.forEach(([f,b,opts]) => { const d = b * bt; mkOrientalNote(f, t, d * 0.9, musicVol, 1, opts); t += d; });

      if (isHarmonyRound) {
        let t2h = now;
        mel2.forEach(([f,b,opts]) => { const d = b * bt; mkOrientalNote(f, t2h, d * 0.85, musicVol, 0.55, opts); t2h += d; });
      }

      let t2 = now;
      bas.forEach(([f,b]) => { const d = b * bt; mkNote(f, t2, d * 0.95, 'triangle', musicVol); t2 += d; });

      const drumPatterns = [
        [['doum',0],['tin',1],['slap',2],['tek',3],
         ['dha',4],['ka',5],['tin',5.5],['tek',6],['tin',7],['ka',7.5]],
        [['dha',0],['tun',1],['tek',2],['slap',3],['ka',3.5],
         ['doum',4],['tin',5],['ka',5.5],['tek',6],['tin',7]],
        [['doum',0],['ka',0.5],['tin',1],['tek',1.5],['dha',2],['slap',3],
         ['tun',4],['tin',5],['ka',5.5],['doum',6],['tek',6.5],['tin',7],['ka',7.5]],
        [['dha',0],['slap',1],['tun',1.5],['tek',2],['tin',3],['ka',3.5],
         ['doum',4],['dha',5],['ka',5.5],['slap',6],['tin',6.5],['tek',7]]
      ];
      const barsTotal = Math.floor(totalBeats / 4);
      for (let bar = 0; bar < barsTotal; bar++) {
        const pattern = drumPatterns[Math.floor(bar / 2) % 2];
        pattern.forEach(([type, pos]) => {
          const pt = now + (bar * 4 + pos * 0.5) * bt;
          if (pt >= now + totalBeats * bt) return;
          mkDrum(type, pt, 1);
        });
        const ghosts = [0.75, 1.75, 2.75, 3.75, 4.75, 5.75, 6.75];
        ghosts.forEach(g => {
          if (Math.random() > 0.4) return;
          const pt = now + (bar * 4 + g * 0.5) * bt;
          if (pt >= now + totalBeats * bt) return;
          mkDrum('ka', pt, 0.5 + Math.random() * 0.3);
        });
      }
      const dur = totalBeats * bt;
      nextLoopStart = now + dur;
      const msUntilEnd = (nextLoopStart - ctx.currentTime - 0.1) * 1000;
      musicTimers.push(setTimeout(loop, Math.max(0, msUntilEnd)));
      // Resolve ready promise AFTER music actually starts playing (+30ms safety)
      if (resolveReady) {
        const waitMs = Math.max(0, (now - ctx.currentTime) * 1000) + 30;
        const r = resolveReady; resolveReady = null;
        setTimeout(r, waitMs);
      }
    }
    loop();
    return readyPromise;
  }

  function stopMusic() {
    musicOn = false;
    musicTimers.forEach(t => clearTimeout(t));
    musicTimers = [];
    activeMusicNodes.forEach(n => { try { n.stop(); } catch(e) {} });
    activeMusicNodes = [];
    musicRound = 0;
    _gameSpeed = INITIAL_SPEED;
    _pendingSpeed = INITIAL_SPEED;
    _musicOrigin = 0;
  }

  function fadeInMusic() {
    if (!ctx || !musicVol || !musicEnabled) return Promise.resolve();
    _gameSpeed = INITIAL_SPEED;
    _pendingSpeed = INITIAL_SPEED;
    musicVol.gain.cancelScheduledValues(ctx.currentTime);
    musicVol.gain.setValueAtTime(0, ctx.currentTime);
    musicVol.gain.linearRampToValueAtTime(0.48, ctx.currentTime + 2.5);
    return startMusic();
  }

  function snapMusicVolume() {
    if (!ctx || !musicVol) return;
    musicVol.gain.cancelScheduledValues(ctx.currentTime);
    musicVol.gain.setValueAtTime(0.48, ctx.currentTime);
  }

  function setMusicEnabled(on) {
    musicEnabled = on;
    if (!on) {
      stopMusic();
      if (ctx && musicVol) musicVol.gain.setValueAtTime(0, ctx.currentTime);
    } else {
      if (ctx && musicVol) musicVol.gain.setValueAtTime(0.32, ctx.currentTime);
    }
    try { localStorage.setItem('snake-music', on ? '1' : '0'); } catch(e) {}
  }

  function setSfxEnabled(on) {
    sfxEnabled = on;
    if (ctx && sfxVol) sfxVol.gain.value = on ? 0.38 : 0;
    if (!on) stopHiss();
    try { localStorage.setItem('snake-sfx', on ? '1' : '0'); } catch(e) {}
  }

  function loadPrefs() {
    try {
      const m = localStorage.getItem('snake-music');
      const s = localStorage.getItem('snake-sfx');
      if (m !== null) musicEnabled = m === '1';
      if (s !== null) sfxEnabled = s === '1';
    } catch(e) {}
    return { musicEnabled, sfxEnabled };
  }

  function setGameSpeed(s) {
    _pendingSpeed = s;
  }

  function setConfig(cfg) {
    _customConfig = cfg;
  }

  function resetTempo() {
    _gameSpeed = INITIAL_SPEED;
    _pendingSpeed = INITIAL_SPEED;
    _musicOrigin = 0;
  }

  return { init, waitForRunning, startHiss, stopHiss, playEat, playCelebrate, playDeath, startMusic, stopMusic, fadeInMusic, snapMusicVolume, setMusicEnabled, setSfxEnabled, loadPrefs, setGameSpeed, setConfig, resetTempo };
})();
