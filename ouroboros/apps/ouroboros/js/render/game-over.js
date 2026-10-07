// Ouroboros, the Game Over overlay: falling SVG words, the gold placement
// label, and the dissolve back to the start screen.
//
// WebKit notes (the reason this sequence once broke in Safari):
//   - The SVG carries a CSS filter. WebKit clips a filtered <svg> to its
//     viewport and ignores overflow:visible, so the viewBox in index.html
//     reaches up over the whole fall path instead of relying on overflow.
//   - Physics steps come from the fixed 60 Hz clock in main.js, never from
//     the rAF count, because Safari caps rAF at 60 Hz (30 Hz in Low Power
//     Mode) while Chrome follows the display.
(function (O) {
  'use strict';

  const Fall = O.FallPhysics;
  const { placementOpacity } = O.Timing;
  const { placementLabel } = O.Scores;

  let svg, words, label, fadeCanvas, fadeCtx;
  let fall = null;
  let fadeActive = false;

  function init({ svgEl, labelEl, fadeCanvasEl }) {
    svg = svgEl;
    words = Array.from(svg.querySelectorAll('text'));
    label = labelEl;
    fadeCanvas = fadeCanvasEl;
    fadeCtx = fadeCanvas.getContext('2d');
  }

  function reset() {
    fall = null;
    svg.style.opacity = '0';
    svg.classList.remove('falling', 'dissolving');
    words.forEach(t => { t.removeAttribute('transform'); t.style.opacity = '0'; });
    label.textContent = '';
    label.style.opacity = '0';
    label.classList.remove('dissolving');
    delete label.dataset.set;
  }

  // Called every frame of the death animation. `frame` is the 60 Hz frame
  // number, `steps` how many physics steps to run since the last call.
  function update(frame, steps, placement, nowMs = Date.now()) {
    if (!fall) {
      svg.style.opacity = '';
      svg.classList.add('falling');
      fall = Fall.createFall();
    }
    for (let s = 0; s < steps; s++) Fall.step(fall, nowMs);
    words.forEach((el, i) => {
      const pose = Fall.poseOf(fall, i);
      el.style.opacity = pose.visible ? '0.95' : '0';
      if (pose.visible) el.setAttribute('transform', Fall.svgTransform(pose));
    });

    if (placement && frame > 30) {
      if (!label.dataset.set) {
        label.textContent = placementLabel(placement);
        label.dataset.set = '1';
      }
      label.style.opacity = placementOpacity(frame);
    }
  }

  // Blur the words and the label away (CSS go-dissolve).
  function startDissolve() {
    svg.style.opacity = '';
    svg.classList.add('dissolving');
    if (label.dataset.set) {
      label.style.opacity = '';
      label.classList.add('dissolving');
    }
  }

  // Freeze the board into a snapshot canvas above the overlay and fade it out.
  function startSnapshotFade(sourceCanvas) {
    fadeCanvas.width = sourceCanvas.width;
    fadeCanvas.height = sourceCanvas.height;
    fadeCtx.drawImage(sourceCanvas, 0, 0);
    fadeCanvas.classList.remove('hidden', 'fade-away');
    fadeActive = true;
    requestAnimationFrame(() => fadeCanvas.classList.add('fade-away'));
    fadeCanvas.addEventListener('animationend', () => {
      fadeActive = false;
      fadeCanvas.classList.add('hidden');
      fadeCanvas.classList.remove('fade-away');
    }, { once: true });
  }

  function isFadeDone() {
    return !fadeActive;
  }

  function cancel() {
    fadeActive = false;
    fadeCanvas.classList.add('hidden');
    fadeCanvas.classList.remove('fade-away');
    svg.classList.remove('dissolving');
    label.classList.remove('dissolving');
  }

  O.GameOver = { init, reset, update, startDissolve, startSnapshotFade, isFadeDone, cancel };
})(window.Ouroboros);
