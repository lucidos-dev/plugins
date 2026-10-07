// Ouroboros, sound effects: snake hiss, eating, fanfare and sad trombone.
(function (O) {
  'use strict';

  const A = O.AudioEngine;
  const { musicBpm, fanfareTiming, tromboneTiming, JINGLE_OFFSET } = O.Timing;
  const Clips = O.SoundClips;

  // --- Snake hiss: a rhythmic "hysj" pattern locked to the music grid ---
  let hissSrc = null, hissGn = null;
  let hissTimers = [];
  let hissGeneration = 0;

  function startHiss() {
    const ctx = A.ctx;
    if (!ctx || !A.sfxVol || hissSrc || !A.sfxEnabled) return Promise.resolve();
    hissGeneration++;
    const gen = hissGeneration;
    let resolveReady = null;
    const readyPromise = new Promise(r => { resolveReady = r; });

    // Continuous looping noise source
    hissSrc = ctx.createBufferSource();
    hissSrc.buffer = A.noiseBuf(2);
    hissSrc.loop = true;

    // Highpass removes low rumble, pure airy sibilance
    const hissHp = ctx.createBiquadFilter();
    hissHp.type = 'highpass'; hissHp.frequency.value = 3500; hissHp.Q.value = 0.5;

    // Bandpass shapes the "sh" character, breathy whisper
    const hissBp = ctx.createBiquadFilter();
    hissBp.type = 'bandpass'; hissBp.frequency.value = 7000; hissBp.Q.value = 0.5;

    hissGn = ctx.createGain();
    hissGn.gain.value = 0;

    hissSrc.connect(hissHp);
    hissHp.connect(hissBp);
    hissBp.connect(hissGn);
    hissGn.connect(A.sfxVol);
    hissSrc.start();

    let nextHissBar = 0; // absolute audio time for next bar

    // First bar boundary on the music grid that is still ahead of us
    function alignToGrid(barDur) {
      if (A.musicOrigin > 0) {
        const elapsed = ctx.currentTime - A.musicOrigin;
        let bar = A.musicOrigin + Math.ceil(elapsed / barDur) * barDur;
        if (bar < ctx.currentTime + 0.02) bar += barDur;
        return bar;
      }
      return ctx.currentTime + 0.05;
    }

    function schedulePattern() {
      if (gen !== hissGeneration) return;
      // Use gameSpeed (committed at music loop start), not pendingSpeed
      const bt = 60 / musicBpm(A.gameSpeed || A.pendingSpeed);
      const barDur = 4 * bt;
      const fadeIn = 0.02;
      const fadeOut = 0.04;
      const gap = bt * 0.15;
      const vol = 0.025;

      // Snap to the grid on the first bar, and skip ahead if we fell behind
      // (e.g. the tab was suspended)
      if (nextHissBar === 0 || nextHissBar < ctx.currentTime + 0.02) nextHissBar = alignToGrid(barDur);

      // One bar (4 beats): sh(2), sh(1), sh(1)
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
    const ctx = A.ctx;
    hissGeneration++;
    hissTimers.forEach(t => clearTimeout(t));
    hissTimers = [];
    hissGn.gain.cancelScheduledValues(ctx.currentTime);
    hissGn.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.1);
    const s = hissSrc;
    hissSrc = null;
    setTimeout(() => { try { s.stop(); } catch (e) {} }, 150);
  }

  // --- Eat sound (wet slurp + Mario-style coin) ---
  function playEat() {
    const ctx = A.ctx, sfxVol = A.sfxVol;
    if (!ctx || !A.sfxEnabled) return;
    const t = ctx.currentTime;

    // 1) Slurp, short wet mouth sound (wider filter, more body)
    const slurp = ctx.createBufferSource(); slurp.buffer = A.noiseBuf(0.15);
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

    // Body, a little weight underneath
    const body = ctx.createOscillator(); body.type = 'sine';
    body.frequency.setValueAtTime(250, t);
    body.frequency.exponentialRampToValueAtTime(120, t + 0.08);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.2, t);
    bg.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    body.connect(bg); bg.connect(sfxVol);
    body.start(t); body.stop(t + 0.1);

    // 2) Mario coin, two quick notes up (B5 → E6), muted
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

  // --- Celebration fanfare for a leaderboard placement ---
  // Returns { lastNoteStart, soundEnd } in seconds, even when muted, so the
  // Game Over sequence keeps the same pacing without sound.
  function playCelebrate() {
    const fc = A.customConfig?.fanfare;
    const fanfare = fc?.notes || Clips.FANFARE_NOTES;
    const timing = fanfareTiming(fanfare);

    const ctx = A.ctx, sfxVol = A.sfxVol;
    if (!ctx || !A.sfxEnabled) return timing;
    const t = ctx.currentTime;

    const brassWave = A.harmonicWave(fc?.harmonics || Clips.FANFARE_HARMONICS);
    const finale = fc?.finale || Clips.FANFARE_FINALE;

    function playTrumpet(freq, startTime, duration, volume, isLast) {
      const o = ctx.createOscillator();
      o.setPeriodicWave(brassWave);
      o.frequency.setValueAtTime(freq, startTime);

      const g = ctx.createGain();
      g.gain.setValueAtTime(0, startTime);
      g.gain.linearRampToValueAtTime(volume, startTime + 0.015);

      if (isLast) {
        const vib = ctx.createOscillator();
        vib.frequency.value = finale.vibRate;
        const vG = ctx.createGain();
        vG.gain.value = freq * finale.vibDepth;
        vib.connect(vG); vG.connect(o.frequency);
        vib.start(startTime + 0.3);
        vib.stop(startTime + duration);

        // Massive crescendo swell, builds to super pompous
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

    let nt = t + JINGLE_OFFSET;
    fanfare.forEach(note => {
      const isLast = !!note.final;
      playTrumpet(note.freq, nt, note.dur, note.vol, isLast);

      if (isLast) {
        const chord = fc?.chord || Clips.FANFARE_CHORD.map(c => ({ freq: c.freq, vol: note.vol * c.gain }));
        chord.forEach(c => playTrumpet(c.freq, nt, note.dur, c.vol, true));
      }

      nt += note.dur + note.gap;
    });

    return timing;
  }

  // --- Death sound (splash + sad trombone) ---
  // Returns { lastNoteStart, soundEnd } like playCelebrate().
  function playDeath() {
    const tc = A.customConfig?.trombone;
    const notes = tc?.notes || Clips.TROMBONE_NOTES;
    const timing = tromboneTiming(notes);

    const ctx = A.ctx, sfxVol = A.sfxVol, echoSend = A.echoSend;
    if (!ctx || !A.sfxEnabled) return timing;
    const t = ctx.currentTime;

    // === SPLASH, wet splat ===
    const splat = ctx.createBufferSource(); splat.buffer = A.noiseBuf(0.2);
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
    const splat2 = ctx.createBufferSource(); splat2.buffer = A.noiseBuf(0.12);
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
    // Custom periodic wave, trumpet harmonic series (bright, brassy)
    const brassWave = A.harmonicWave(tc?.harmonics || Clips.TROMBONE_HARMONICS);

    let nt = t + JINGLE_OFFSET;
    notes.forEach((note, ni) => {
      const atk = 0.03 + ni * 0.008;
      const isLong = note.dur > 1.0;

      // Main osc, custom brass wave
      const o = ctx.createOscillator();
      o.setPeriodicWave(brassWave);
      if (isLong) {
        // Pitch drift, stable sustain first, then embouchure meltdown from ~0.7s
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
      if (isLong) {
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

      // Formant 1, warm brass body
      const f1 = ctx.createBiquadFilter(); f1.type = 'peaking';
      f1.frequency.value = tc?.formant1 || 620; f1.Q.value = 2.0; f1.gain.value = tc?.formant1Gain || 7;

      // Formant 2, upper brass presence (toned down)
      const f2 = ctx.createBiquadFilter(); f2.type = 'peaking';
      f2.frequency.value = tc?.formant2 || 1600; f2.Q.value = 2.5; f2.gain.value = tc?.formant2Gain || 3;

      // Lowpass, opens on attack, kept warm
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.7;
      lp.frequency.setValueAtTime(900, nt);
      lp.frequency.linearRampToValueAtTime(tc?.lpOpen || 2600, nt + atk);
      if (isLong) {
        // Simulate embouchure wavering, filter opens/closes subtly
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

      // Lip buzz, filtered noise near fundamental gives organic texture
      const buzz = ctx.createBufferSource(); buzz.buffer = A.noiseBuf(note.dur + 0.02);
      const buzzBp = ctx.createBiquadFilter(); buzzBp.type = 'bandpass';
      buzzBp.frequency.value = note.freq * 2; buzzBp.Q.value = 3.5;
      const buzzG = ctx.createGain();
      buzzG.gain.setValueAtTime(0, nt);
      buzzG.gain.linearRampToValueAtTime(0.07 * note.press, nt + atk);
      buzzG.gain.setValueAtTime(0.05 * note.press, nt + note.dur * 0.5);
      buzzG.gain.linearRampToValueAtTime(0, nt + note.dur);
      buzz.connect(buzzBp); buzzBp.connect(buzzG); buzzG.connect(f1);

      // Breath air, lighter, just a touch
      const breath = ctx.createBufferSource(); breath.buffer = A.noiseBuf(note.dur);
      const breathBp = ctx.createBiquadFilter(); breathBp.type = 'bandpass';
      breathBp.frequency.value = note.freq * 1.5; breathBp.Q.value = 1.5;
      const breathG = ctx.createGain();
      if (isLong) {
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

      // Main gain, fades out from halfway
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
      o.start(nt); o2.start(nt);
      o.stop(nt + note.dur + 0.02);
      o2.stop(nt + note.dur + 0.02);

      nt += note.dur + (note.gap || 0.06);
    });

    return timing;
  }

  O.Sfx = { startHiss, stopHiss, playEat, playCelebrate, playDeath };
})(window.Ouroboros);
