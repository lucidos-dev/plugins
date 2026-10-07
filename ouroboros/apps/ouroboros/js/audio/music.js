// Ouroboros, snake-charmer music: a Hijaz-scale melody over bass and tabla.
// The tempo follows the game speed (see Timing.musicBpm).
(function (O) {
  'use strict';

  const A = O.AudioEngine;
  const { musicBpm } = O.Timing;

  let musicOn = false;
  let musicTimers = [];
  let activeMusicNodes = [];
  let musicRound = 0;
  let musicGeneration = 0;

  // --- Helper: schedule a note ---
  function mkNote(freq, start, dur, type, dest) {
    const ctx = A.ctx;
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
    const ctx = A.ctx, musicVol = A.musicVol;
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
      const ns = ctx.createBufferSource(); ns.buffer = A.noiseBuf(0.025);
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
      const ns = ctx.createBufferSource(); ns.buffer = A.noiseBuf(0.03);
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass';
      hp.frequency.value = 6500; hp.Q.value = 1.0;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.12 * vol, start);
      ng.gain.exponentialRampToValueAtTime(0.001, start + 0.025);
      ns.connect(hp); hp.connect(ng); ng.connect(musicVol);
      ns.start(start); ns.stop(start + 0.04);
      activeMusicNodes.push(ns);
    } else if (type === 'ka') {
      const ns = ctx.createBufferSource(); ns.buffer = A.noiseBuf(0.02);
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
      const ns = ctx.createBufferSource(); ns.buffer = A.noiseBuf(0.035);
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
      const ns = ctx.createBufferSource(); ns.buffer = A.noiseBuf(0.015);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.09 * vol, start);
      ng.gain.exponentialRampToValueAtTime(0.001, start + 0.012);
      ns.connect(lp); lp.connect(ng); ng.connect(musicVol);
      ns.start(start); ns.stop(start + 0.02);
      activeMusicNodes.push(ns);
    } else if (type === 'slap') {
      const ns = ctx.createBufferSource(); ns.buffer = A.noiseBuf(0.04);
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
    const ctx = A.ctx, musicVol = A.musicVol;
    if (musicOn || !A.musicEnabled || !ctx || !musicVol) return Promise.resolve();
    musicOn = true;
    musicGeneration++;
    const thisGen = musicGeneration;
    let nextLoopStart = 0;
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
      // Commit the pending tempo only at a loop boundary
      A.gameSpeed = A.pendingSpeed;
      const bt = 60 / musicBpm(A.gameSpeed);
      const now = nextLoopStart > ctx.currentTime ? nextLoopStart : ctx.currentTime + 0.05;
      if (A.musicOrigin === 0) A.musicOrigin = now;
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
    A.resetTempo();
  }

  O.Music = { startMusic, stopMusic };
})(window.Ouroboros);
