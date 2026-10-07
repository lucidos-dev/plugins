// Ouroboros, DOM effects around the board: flashes, shake and the score pop.
(function (O) {
  'use strict';

  let screenFlash, canvasWrapper, scoreEl;

  function init({ flash, wrapper, score }) {
    screenFlash = flash;
    canvasWrapper = wrapper;
    scoreEl = score;
  }

  // Restart a CSS animation class. The forced style flush makes WebKit notice
  // the removal; the class goes back on in the next frame.
  function restartClass(el, reset, cls) {
    reset();
    void el.offsetWidth;
    requestAnimationFrame(() => el.classList.add(cls));
  }

  // Green flash centred on the food that was just eaten
  function flashEat(xPercent, yPercent) {
    screenFlash.style.setProperty('--flash-x', xPercent + '%');
    screenFlash.style.setProperty('--flash-y', yPercent + '%');
    restartClass(screenFlash, () => { screenFlash.className = 'screen-flash'; }, 'flash-eat');
  }

  function flashDeath() {
    restartClass(screenFlash, () => { screenFlash.className = 'screen-flash'; }, 'flash-death');
    restartClass(canvasWrapper, () => canvasWrapper.classList.remove('shake'), 'shake');
    setTimeout(() => canvasWrapper.classList.remove('shake'), 450);
  }

  function popScore() {
    scoreEl.classList.add('score-pop');
    setTimeout(() => scoreEl.classList.remove('score-pop'), 150);
  }

  O.ScreenFx = { init, flashEat, flashDeath, popScore };
})(window.Ouroboros);
