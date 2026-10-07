// Ouroboros: audio facade. The rest of the app talks to O.Audio only.
(function (O) {
  'use strict';

  const A = O.AudioEngine;
  const { Sfx, Music } = O;

  function setMusicEnabled(on) {
    A.musicEnabled = on;
    if (!on) {
      Music.stopMusic();
      if (A.ctx && A.musicVol) A.musicVol.gain.setValueAtTime(0, A.ctx.currentTime);
    } else if (A.ctx && A.musicVol) {
      A.musicVol.gain.setValueAtTime(A.MUSIC_LEVEL, A.ctx.currentTime);
    }
    A.savePref('snake-music', on);
  }

  function setSfxEnabled(on) {
    A.sfxEnabled = on;
    if (A.ctx && A.sfxVol) A.sfxVol.gain.value = on ? A.SFX_LEVEL : 0;
    if (!on) Sfx.stopHiss();
    A.savePref('snake-sfx', on);
  }

  O.Audio = {
    init: A.init,
    waitForRunning: A.waitForRunning,
    loadPrefs: A.loadPrefs,
    resetTempo: A.resetTempo,
    setGameSpeed(speed) { A.pendingSpeed = speed; },
    setConfig(cfg) { A.customConfig = cfg; },
    setMusicEnabled,
    setSfxEnabled,
    startMusic: Music.startMusic,
    stopMusic: Music.stopMusic,
    startHiss: Sfx.startHiss,
    stopHiss: Sfx.stopHiss,
    playEat: Sfx.playEat,
    playCelebrate: Sfx.playCelebrate,
    playDeath: Sfx.playDeath
  };
})(window.Ouroboros);
