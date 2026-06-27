// Snake Game — Renderer (drawing, particles, trails, visual effects)
window.SnakeRenderer = (function () {
  const GRID_SIZE = 20;

  // Colors
  const SNAKE_HEAD = '#4ade80';
  const SNAKE_BODY_START = '#22c55e';
  const SNAKE_BODY_END = '#064e3b';
  const FOOD_COLOR = '#ef4444';
  const FOOD_GLOW = '#f87171';
  const EYE_COLOR = '#fff';
  const PUPIL_COLOR = '#111';
  const GRID_COLOR = 'rgba(74, 222, 128, 0.025)';

  let canvas, ctx;
  let screenFlash, canvasWrapper, scoreEl, gameOverSvg, goHighscore;
  let particles = [];
  let trail = [];
  let foodBobPhase = 0;
  let mousePos = null;
  let mouseOverCanvas = false;
  let drawingState = {};

  // Game Over fall physics
  let goFall = null;

  function initGameOverFall() {
    const startY = -250;
    goFall = {
      words: [
        { y: startY, vy: 0, rot: -6 + Math.random() * 3, vrot: -0.15 - Math.random() * 0.3,
          restRot: -5 - Math.random() * 3, bounces: 0, settled: false, settledAt: 0, delay: 0,
          swing: 0, swingVel: 0, pivotOffset: -64 + Math.random() * 6 },
        { y: startY, vy: 0, rot: 3 + Math.random() * 4, vrot: 0.15 + Math.random() * 0.3,
          restRot: 3 + Math.random() * 4, bounces: 0, settled: false, settledAt: 0, delay: 5,
          swing: 0, swingVel: 0, pivotOffset: -58 + Math.random() * 6 }
      ],
      gravity: 0.18,
      restitution: 0.48,
      allSettled: false,
      settledTime: 0
    };
  }

  function updateGameOverFall() {
    if (!goFall || !gameOverSvg) return;
    const texts = gameOverSvg.querySelectorAll('text');
    const origins = [72, 142];

    goFall.words.forEach((w, i) => {
      if (w.delay > 0) { w.delay--; texts[i].style.opacity = '0'; return; }
      texts[i].style.opacity = '0.95';

      if (!w.settled) {
        w.vy += goFall.gravity;
        w.y += w.vy;
        w.rot += w.vrot;
        w.rot = Math.max(-25, Math.min(25, w.rot));
        w.vrot *= 0.98;

        if (w.y >= 0 && w.vy > 0) {
          w.y = 0;
          w.bounces++;
          w.vy = -Math.abs(w.vy) * goFall.restitution;
          w.vrot += (Math.random() - 0.5) * (3 / w.bounces);
          if (Math.abs(w.vy) < 0.8) {
            w.vy = 0; w.y = 0; w.settled = true; w.settledAt = Date.now();
            w.swing = w.rot * 0.7;
            w.swingVel = 0;
          }
        }
      }

      if (w.settled) {
        // Pendel rundt et ankerpunkt over teksten
        w.swingVel += (-w.swing * 0.035);
        w.swingVel *= 0.92;
        w.swing += w.swingVel;
        const t = (Date.now() - w.settledAt) / 1000;
        const sway = Math.sin(t * 1.6 + i * 1.2) * 1.4 * Math.exp(-t * 0.35);
        const targetRot = w.restRot + w.swing + sway;
        w.rot += (targetRot - w.rot) * 0.12;
        w.y = Math.sin(w.swing * 0.08) * 1.2;
      } else if (w.bounces > 3) {
        w.rot += (w.restRot - w.rot) * 0.08;
        w.vrot *= 0.86;
      }

      const clampedRot = Math.max(-25, Math.min(25, w.rot));
      const pivotY = origins[i] + (w.pivotOffset || -60);
      texts[i].setAttribute('transform', `translate(0, ${w.y}) rotate(${clampedRot}, 150, ${pivotY})`);
    });
  }

  function init(canvasEl) {
    canvas = canvasEl;
    ctx = canvas.getContext('2d');
    screenFlash = document.getElementById('screen-flash');
    canvasWrapper = canvas.parentElement;
    scoreEl = document.getElementById('current-score');
    gameOverSvg = document.getElementById('game-over-svg');
    goHighscore = document.getElementById('go-highscore');

    canvas.addEventListener('mousemove', e => {
      const rect = canvas.getBoundingClientRect();
      mousePos = { x: (e.clientX - rect.left) / rect.width * canvas.width, y: (e.clientY - rect.top) / rect.height * canvas.height };
      mouseOverCanvas = true;
    });
    canvas.addEventListener('mouseleave', () => { mouseOverCanvas = false; });
  }

  function resizeCanvas() {
    const wrapper = canvas.parentElement;
    const size = wrapper.clientWidth;
    canvas.width = GRID_SIZE * Math.floor(size / GRID_SIZE);
    canvas.height = canvas.width;
  }

  function cs() {
    return canvas.width / GRID_SIZE;
  }

  function resetVisuals() {
    particles = [];
    trail = [];
    foodBobPhase = 0;
    if (gameOverSvg) {
      gameOverSvg.style.opacity = '0';
      gameOverSvg.classList.remove('falling', 'dissolving');
      gameOverSvg.querySelectorAll('text').forEach(t => { t.removeAttribute('transform'); t.style.opacity = '0'; });
    }
    if (goHighscore) { goHighscore.textContent = ''; goHighscore.style.opacity = '0'; goHighscore.classList.remove('dissolving'); delete goHighscore.dataset.set; }
    goFall = null;
  }

  // === COLOR UTILS ===
  function lerpColor(a, b, t) {
    const ar = parseInt(a.slice(1, 3), 16), ag = parseInt(a.slice(3, 5), 16), ab = parseInt(a.slice(5, 7), 16);
    const br = parseInt(b.slice(1, 3), 16), bg = parseInt(b.slice(3, 5), 16), bb = parseInt(b.slice(5, 7), 16);
    const r = Math.round(ar + (br - ar) * t);
    const g = Math.round(ag + (bg - ag) * t);
    const bl = Math.round(ab + (bb - ab) * t);
    return `rgb(${r},${g},${bl})`;
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  // === PARTICLES ===
  function spawnEatParticles(x, y) {
    const c = cs();
    const cx = x * c + c / 2;
    const cy = y * c + c / 2;
    // Splat particles
    for (let i = 0; i < 12; i++) {
      const angle = (Math.PI * 2 / 12) * i + Math.random() * 0.5;
      const spd = 2 + Math.random() * 3.5;
      particles.push({
        x: cx, y: cy,
        vx: Math.cos(angle) * spd, vy: Math.sin(angle) * spd,
        life: 1, decay: 0.02 + Math.random() * 0.015,
        size: 2 + Math.random() * 3,
        color: Math.random() > 0.5 ? FOOD_COLOR : FOOD_GLOW,
        type: 'droplet', gravity: 0.06
      });
    }
    // Green splash
    for (let i = 0; i < 6; i++) {
      const angle = Math.random() * Math.PI * 2;
      const spd = 1.5 + Math.random() * 2.5;
      particles.push({
        x: cx, y: cy,
        vx: Math.cos(angle) * spd, vy: Math.sin(angle) * spd,
        life: 1, decay: 0.025 + Math.random() * 0.02,
        size: 1.5 + Math.random() * 2.5,
        color: Math.random() > 0.4 ? SNAKE_HEAD : '#88eaaa',
        type: 'droplet', gravity: 0.04
      });
    }
  }

  function spawnDeathParticles(snake) {
    const c = cs();
    const headSeg = snake[0];
    const hx = headSeg.x * c + c / 2;
    const hy = headSeg.y * c + c / 2;

    // Big splash droplets from impact point
    for (let j = 0; j < 18; j++) {
      const angle = Math.random() * Math.PI * 2;
      const spd = 3 + Math.random() * 6;
      particles.push({
        x: hx, y: hy,
        vx: Math.cos(angle) * spd, vy: Math.sin(angle) * spd - 2,
        life: 1, decay: 0.012 + Math.random() * 0.01,
        size: 2.5 + Math.random() * 4,
        color: Math.random() > 0.4 ? SNAKE_HEAD : '#88eaaa',
        type: 'droplet', gravity: 0.12
      });
    }
    // Small splatter particles
    for (let j = 0; j < 12; j++) {
      const angle = Math.random() * Math.PI * 2;
      const spd = 1.5 + Math.random() * 3;
      particles.push({
        x: hx, y: hy,
        vx: Math.cos(angle) * spd, vy: Math.sin(angle) * spd - 1,
        life: 1, decay: 0.018 + Math.random() * 0.015,
        size: 1 + Math.random() * 2,
        color: Math.random() > 0.5 ? '#66dd99' : '#aaf5cc',
        type: 'droplet', gravity: 0.08
      });
    }

    // Segments dissolve with drips
    snake.forEach((seg, i) => {
      const cx = seg.x * c + c / 2;
      const cy = seg.y * c + c / 2;
      const delay = Math.round(i * 5);
      for (let j = 0; j < 4; j++) {
        const angle = Math.random() * Math.PI * 2;
        const spd = 1 + Math.random() * 2;
        particles.push({
          x: cx, y: cy,
          vx: Math.cos(angle) * spd, vy: Math.sin(angle) * spd + 0.5,
          life: 1, decay: 0.015 + Math.random() * 0.01,
          size: 1.5 + Math.random() * 2.5,
          color: i === 0 ? FOOD_COLOR : SNAKE_HEAD,
          type: 'droplet', delay: delay, gravity: 0.1
        });
      }
    });
  }

  function updateParticles() {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      if (p.delay && p.delay > 0) { p.delay--; continue; }
      if (p.type === 'spark') { p.px = p.x; p.py = p.y; }
      p.x += p.vx;
      p.y += p.vy;
      if (p.gravity) p.vy += p.gravity;
      const friction = p.type === 'spark' ? 0.98 : 0.96;
      p.vx *= friction;
      p.vy *= friction;
      p.life -= p.decay;
      if (p.life <= 0) particles.splice(i, 1);
    }
  }

  function drawParticles() {
    particles.forEach(p => {
      if (p.delay && p.delay > 0) return;
      if (p.type === 'spark') {
        ctx.globalAlpha = p.life * 0.9;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = p.size * p.life;
        ctx.beginPath();
        ctx.moveTo(p.px !== undefined ? p.px : p.x, p.py !== undefined ? p.py : p.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.globalAlpha = p.life * 0.7;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * p.life * 0.6, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.type === 'droplet') {
        // Round wet blobs that stretch slightly in direction of movement
        const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
        const stretch = Math.min(1.6, 1 + speed * 0.08);
        const angle = Math.atan2(p.vy, p.vx);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(angle);
        ctx.scale(stretch, 1 / Math.sqrt(stretch));
        ctx.globalAlpha = p.life * 0.85;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(0, 0, p.size * Math.max(0.3, p.life), 0, Math.PI * 2);
        ctx.fill();
        // Highlight
        ctx.globalAlpha = p.life * 0.4;
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(-p.size * 0.2, -p.size * 0.2, p.size * p.life * 0.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      } else if (p.type === 'ember') {
        ctx.globalAlpha = p.life * 0.3;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * p.life * 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = p.life * 0.9;
        ctx.fillStyle = p.life > 0.5 ? '#fff' : p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.globalAlpha = p.life * 0.8;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
        ctx.fill();
      }
    });
    ctx.globalAlpha = 1;
  }

  // === TRAIL ===
  function addTrail(seg) {
    const c = cs();
    trail.push({
      x: seg.x * c + c / 2,
      y: seg.y * c + c / 2,
      life: 1, size: c * 0.3
    });
    if (trail.length > 60) trail.shift();
  }

  function drawTrail(frozen) {
    trail.forEach(t => {
      t.life -= frozen ? 0.012 : 0.018;
      if (t.life <= 0) return;
      ctx.globalAlpha = t.life * (frozen ? 0.25 : 0.15);
      ctx.fillStyle = SNAKE_HEAD;
      ctx.beginPath();
      ctx.arc(t.x, t.y, t.size * t.life, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
    while (trail.length > 0 && trail[0].life <= 0) trail.shift();
  }

  // === FLASH / SHAKE ===
  function flashEat(fx, fy) {
    const c = cs();
    const px = ((fx * c + c / 2) / canvas.width) * 100;
    const py = ((fy * c + c / 2) / canvas.height) * 100;
    screenFlash.style.setProperty('--flash-x', px + '%');
    screenFlash.style.setProperty('--flash-y', py + '%');
    screenFlash.className = 'screen-flash';
    requestAnimationFrame(() => screenFlash.classList.add('flash-eat'));
  }

  function flashDeath() {
    screenFlash.className = 'screen-flash';
    requestAnimationFrame(() => screenFlash.classList.add('flash-death'));
    canvasWrapper.classList.remove('shake');
    requestAnimationFrame(() => canvasWrapper.classList.add('shake'));
    setTimeout(() => canvasWrapper.classList.remove('shake'), 450);
  }

  function popScore() {
    scoreEl.classList.add('score-pop');
    setTimeout(() => scoreEl.classList.remove('score-pop'), 150);
  }

  // === DRAWING ===
  function drawGrid() {
    const c = cs();
    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 1;
    for (let i = 0; i <= GRID_SIZE; i++) {
      ctx.beginPath(); ctx.moveTo(i * c, 0); ctx.lineTo(i * c, canvas.height); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i * c); ctx.lineTo(canvas.width, i * c); ctx.stroke();
    }
  }

  function drawWalls() {
    ctx.save();
    // Soft neon glow
    ctx.shadowColor = '#4ade80';
    ctx.shadowBlur = 14;
    ctx.strokeStyle = 'rgba(74, 222, 128, 0.25)';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
    ctx.restore();
  }

  function drawEyes(hx, hy, headR, direction) {
    const eyeSize = headR * 0.22;
    const eyeSpacing = headR * 0.42;
    const eyeForward = headR * 0.25;

    const perpX = -direction.y;
    const perpY = direction.x;

    const ex1 = hx + direction.x * eyeForward + perpX * eyeSpacing;
    const ey1 = hy + direction.y * eyeForward + perpY * eyeSpacing;
    const ex2 = hx + direction.x * eyeForward - perpX * eyeSpacing;
    const ey2 = hy + direction.y * eyeForward - perpY * eyeSpacing;

    // Yellowish-green reptile eyes
    const eyeGrad1 = ctx.createRadialGradient(ex1, ey1, 0, ex1, ey1, eyeSize);
    eyeGrad1.addColorStop(0, '#e8e44a');
    eyeGrad1.addColorStop(0.6, '#c4a820');
    eyeGrad1.addColorStop(1, '#8a7a10');
    ctx.fillStyle = eyeGrad1;
    ctx.beginPath(); ctx.arc(ex1, ey1, eyeSize, 0, Math.PI * 2); ctx.fill();

    const eyeGrad2 = ctx.createRadialGradient(ex2, ey2, 0, ex2, ey2, eyeSize);
    eyeGrad2.addColorStop(0, '#e8e44a');
    eyeGrad2.addColorStop(0.6, '#c4a820');
    eyeGrad2.addColorStop(1, '#8a7a10');
    ctx.fillStyle = eyeGrad2;
    ctx.beginPath(); ctx.arc(ex2, ey2, eyeSize, 0, Math.PI * 2); ctx.fill();

    // Vertical slit pupils — always vertical, eyes at rest
    const slitW = eyeSize * 0.22;
    const slitH = eyeSize * 0.85;
    ctx.fillStyle = PUPIL_COLOR;

    ctx.beginPath();
    ctx.ellipse(ex1, ey1, slitW, slitH, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.ellipse(ex2, ey2, slitW, slitH, 0, 0, Math.PI * 2);
    ctx.fill();

    // Tiny eye highlights
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.beginPath(); ctx.arc(ex1 - slitW * 0.8, ey1 - slitH * 0.3, eyeSize * 0.12, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(ex2 - slitW * 0.8, ey2 - slitH * 0.3, eyeSize * 0.12, 0, Math.PI * 2); ctx.fill();
  }

  function drawSnake(snake, direction) {
    const c = cs();
    const len = snake.length;

    // Draw body segments (skip head, drawn last on top)
    for (let i = len - 1; i >= 1; i--) {
      const seg = snake[i];
      const t = len > 1 ? i / (len - 1) : 0;
      const px = seg.x * c;
      const py = seg.y * c;
      const color = lerpColor(SNAKE_BODY_START, SNAKE_BODY_END, t);
      const padding = 1;
      const radius = c * 0.28;

      if (i > 0) {
        const prev = snake[i - 1];
        const bridgeColor = lerpColor(SNAKE_BODY_START, SNAKE_BODY_END, (i - 0.5) / (len - 1));
        ctx.fillStyle = bridgeColor;
        if (prev.x !== seg.x) {
          const bx = Math.min(prev.x, seg.x) * c + c / 2;
          ctx.fillRect(bx, py + padding + 1, c, c - padding * 2 - 2);
        } else {
          const by = Math.min(prev.y, seg.y) * c + c / 2;
          ctx.fillRect(px + padding + 1, by, c - padding * 2 - 2, c);
        }
      }

      ctx.fillStyle = color;
      roundRect(ctx, px + padding, py + padding, c - padding * 2, c - padding * 2, radius);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      roundRect(ctx, px + padding + 1, py + padding + 1, c - padding * 2 - 2, (c - padding * 2) * 0.4, radius);
      ctx.fill();
    }

    // Draw head — wider triangular reptile shape
    if (len > 0) {
      const head = snake[0];
      const px = head.x * c;
      const py = head.y * c;
      const hx = px + c / 2;
      const hy = py + c / 2;

      // Head follows mouse only on intro/idle, not during gameplay
      let headDir = direction;
      if (!drawingState.isPlaying && mouseOverCanvas && mousePos) {
        const mdx = mousePos.x - hx;
        const mdy = mousePos.y - hy;
        const dist = Math.sqrt(mdx * mdx + mdy * mdy);
        if (dist > 2) headDir = { x: mdx / dist, y: mdy / dist };
      }

      const headW = c * 0.58; // half-width (wider than body)
      const headL = c * 0.52; // half-length

      const angle = Math.atan2(headDir.y, headDir.x);
      const perpX = -headDir.y;
      const perpY = headDir.x;

      // Snout tip (narrower)
      const snoutW = headW * 0.55;
      const tipX = hx + headDir.x * headL;
      const tipY = hy + headDir.y * headL;
      // Rear (wide)
      const rearX = hx - headDir.x * headL * 0.8;
      const rearY = hy - headDir.y * headL * 0.8;
      // Jaw bulge points
      const jawBulgeForward = 0.15;
      const jaw1X = hx + headDir.x * headL * jawBulgeForward + perpX * headW;
      const jaw1Y = hy + headDir.y * headL * jawBulgeForward + perpY * headW;
      const jaw2X = hx + headDir.x * headL * jawBulgeForward - perpX * headW;
      const jaw2Y = hy + headDir.y * headL * jawBulgeForward - perpY * headW;

      ctx.save();
      ctx.shadowColor = SNAKE_HEAD;
      ctx.shadowBlur = 12;

      // Head shape — hexagonal/triangular
      const headGrad = ctx.createRadialGradient(hx, hy, 0, hx, hy, headW * 1.3);
      headGrad.addColorStop(0, '#5ce892');
      headGrad.addColorStop(0.5, SNAKE_HEAD);
      headGrad.addColorStop(1, '#1a9a4a');
      ctx.fillStyle = headGrad;

      ctx.beginPath();
      // Start from snout, go around
      ctx.moveTo(tipX + perpX * snoutW, tipY + perpY * snoutW);
      ctx.quadraticCurveTo(
        jaw1X + headDir.x * headL * 0.3, jaw1Y + headDir.y * headL * 0.3,
        jaw1X, jaw1Y
      );
      ctx.quadraticCurveTo(
        rearX + perpX * headW * 0.8, rearY + perpY * headW * 0.8,
        rearX, rearY
      );
      ctx.quadraticCurveTo(
        rearX - perpX * headW * 0.8, rearY - perpY * headW * 0.8,
        jaw2X, jaw2Y
      );
      ctx.quadraticCurveTo(
        jaw2X + headDir.x * headL * 0.3, jaw2Y + headDir.y * headL * 0.3,
        tipX - perpX * snoutW, tipY - perpY * snoutW
      );
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;

      // Scale ridge lines
      ctx.strokeStyle = 'rgba(0,0,0,0.12)';
      ctx.lineWidth = 0.7;
      for (let s = 0.15; s < 0.7; s += 0.18) {
        const rx = hx + headDir.x * headL * (0.3 - s);
        const ry = hy + headDir.y * headL * (0.3 - s);
        const sw = headW * (0.9 - s * 0.4);
        ctx.beginPath();
        ctx.moveTo(rx + perpX * sw, ry + perpY * sw);
        ctx.quadraticCurveTo(
          rx - headDir.x * headL * 0.08, ry - headDir.y * headL * 0.08,
          rx - perpX * sw, ry - perpY * sw
        );
        ctx.stroke();
      }

      // Top highlight
      ctx.fillStyle = 'rgba(255,255,255,0.1)';
      ctx.beginPath();
      ctx.ellipse(
        hx + headDir.x * headL * 0.1,
        hy + headDir.y * headL * 0.1,
        headW * 0.5, headL * 0.35,
        angle, 0, Math.PI * 2
      );
      ctx.fill();

      // Nostrils
      const nostrilDist = snoutW * 0.5;
      const nostrilForward = headL * 0.75;
      const n1x = hx + headDir.x * nostrilForward + perpX * nostrilDist;
      const n1y = hy + headDir.y * nostrilForward + perpY * nostrilDist;
      const n2x = hx + headDir.x * nostrilForward - perpX * nostrilDist;
      const n2y = hy + headDir.y * nostrilForward - perpY * nostrilDist;
      const nostrilR = headW * 0.06;

      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.beginPath(); ctx.arc(n1x, n1y, nostrilR, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(n2x, n2y, nostrilR, 0, Math.PI * 2); ctx.fill();

      ctx.restore();

      // Eyes
      drawEyes(hx, hy, headW, headDir);
    }
  }

  function drawFood(food) {
    if (!food) return;
    const c = cs();
    const fx = food.x * c + c / 2;
    const fy = food.y * c + c / 2;

    foodBobPhase += 0.06;
    const bob = Math.sin(foodBobPhase) * 1.5;
    const pulse = 1 + Math.sin(foodBobPhase * 1.5) * 0.08;
    const r = (c / 2 - 3) * pulse;

    const grd = ctx.createRadialGradient(fx, fy + bob, r * 0.3, fx, fy + bob, r * 2.5);
    grd.addColorStop(0, 'rgba(239, 68, 68, 0.15)');
    grd.addColorStop(1, 'rgba(239, 68, 68, 0)');
    ctx.fillStyle = grd;
    ctx.beginPath(); ctx.arc(fx, fy + bob, r * 2.5, 0, Math.PI * 2); ctx.fill();

    const foodGrad = ctx.createRadialGradient(fx - r * 0.3, fy + bob - r * 0.3, r * 0.1, fx, fy + bob, r);
    foodGrad.addColorStop(0, FOOD_GLOW);
    foodGrad.addColorStop(1, FOOD_COLOR);
    ctx.fillStyle = foodGrad;
    ctx.beginPath(); ctx.arc(fx, fy + bob, r, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.beginPath(); ctx.arc(fx - r * 0.25, fy + bob - r * 0.25, r * 0.25, 0, Math.PI * 2); ctx.fill();
  }

  function drawDeathAnim(deathSegments, deathAnimFrame, currentPlacement, snakeLen) {
    const c = cs();
    const progress = deathAnimFrame / 60;

    deathSegments.forEach((seg, i) => {
      const delay = i * 0.06;
      const t = Math.max(0, Math.min(1, (progress - delay) * 1.2));

      if (t <= 0) {
        const color = i === 0 ? FOOD_COLOR : lerpColor(SNAKE_BODY_START, SNAKE_BODY_END, snakeLen > 1 ? i / (snakeLen - 1) : 0);
        ctx.globalAlpha = 1;
        ctx.fillStyle = color;
        roundRect(ctx, seg.x * c + 1.5, seg.y * c + 1.5, c - 3, c - 3, c * 0.28);
        ctx.fill();
      } else if (t < 1) {
        const scale = 1 - t;
        const alpha = 1 - t;
        const cx = seg.x * c + c / 2;
        const cy = seg.y * c + c / 2;
        const size = (c - 3) * scale;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = i === 0 ? FOOD_COLOR : SNAKE_HEAD;
        roundRect(ctx, cx - size / 2, cy - size / 2, size, size, size * 0.3);
        ctx.fill();
      }
    });
    ctx.globalAlpha = 1;

    // GAME OVER + placement text — JS physics driven
    if (deathAnimFrame === 0) {
      gameOverSvg.style.opacity = '';
      gameOverSvg.classList.add('falling');
      initGameOverFall();
    }
    if (goFall) updateGameOverFall();
    if (currentPlacement && deathAnimFrame > 30) {
      // Set placement text
      if (!goHighscore.dataset.set) {
        if (currentPlacement.type === 'legend') {
          goHighscore.textContent = `NO ${currentPlacement.rank}, YOU'RE A LEGEND!`;
        } else {
          goHighscore.textContent = `TODAY'S #${currentPlacement.rank} BEST!`;
        }
        goHighscore.dataset.set = '1';
      }
      goHighscore.style.opacity = Math.min(1, (deathAnimFrame - 30) / 30);
    }

    // Check if death animation is complete
    const lastSegDelay = (deathSegments.length - 1) * 0.06;
    const allDissolvedFrame = Math.ceil(60 * (lastSegDelay + 1 / 1.2));
    const totalWaitFrames = allDissolvedFrame + 8;
    return deathAnimFrame > totalWaitFrames;
  }

  // === MAIN DRAW ===
  function draw(state) {
    drawingState = state;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const vignette = ctx.createRadialGradient(
      canvas.width / 2, canvas.height / 2, canvas.width * 0.3,
      canvas.width / 2, canvas.height / 2, canvas.width * 0.7
    );
    vignette.addColorStop(0, 'transparent');
    vignette.addColorStop(1, 'rgba(0,0,0,0.25)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    drawGrid();
    drawWalls();
    drawTrail(state.isDeathAnim);

    if (state.isDeathAnim) {
      const done = drawDeathAnim(state.deathSegments, state.deathAnimFrame, state.currentPlacement, state.snakeLen);
      drawParticles();
      updateParticles();
      return done;
    }

    drawFood(state.food);
    drawSnake(state.snake, state.direction);
    drawParticles();
    updateParticles();
    return false;
  }

  // === SWIPE TRANSITION ===
  let swipeCanvas, swipeCtx;
  let swipeActive = false;
  let swipeDone = false;

  function startGameOverDissolve() {
    if (gameOverSvg) {
      gameOverSvg.style.opacity = '';
      gameOverSvg.classList.add('dissolving');
    }
    if (goHighscore && goHighscore.dataset.set) {
      goHighscore.style.opacity = '';
      goHighscore.classList.add('dissolving');
    }
  }

  function initDissolution(c) {
    swipeCanvas = c;
    swipeCtx = c.getContext('2d');
  }

  function startDissolution() {
    if (!swipeCanvas) return;
    swipeCanvas.width = canvas.width;
    swipeCanvas.height = canvas.height;
    swipeCtx.drawImage(canvas, 0, 0);
    swipeCanvas.classList.remove('hidden', 'fade-away');
    swipeDone = false;
    swipeActive = true;
    requestAnimationFrame(() => swipeCanvas.classList.add('fade-away'));
    swipeCanvas.addEventListener('animationend', () => {
      swipeActive = false;
      swipeDone = true;
      swipeCanvas.classList.add('hidden');
      swipeCanvas.classList.remove('fade-away');
    }, { once: true });
  }

  function updateDissolution() {}

  function cancelDissolution() {
    swipeActive = false;
    swipeDone = true;
    if (swipeCanvas) {
      swipeCanvas.classList.add('hidden');
      swipeCanvas.classList.remove('fade-away');
    }
    if (gameOverSvg) gameOverSvg.classList.remove('dissolving');
    if (goHighscore) goHighscore.classList.remove('dissolving');
  }

  function getDissolutionProgress() {
    return (!swipeActive || swipeDone) ? 1 : 0;
  }

  function clearTrail() { trail = []; particles = []; }

  return {
    init, resizeCanvas, cs, resetVisuals, clearTrail,
    spawnEatParticles, spawnDeathParticles,
    addTrail, flashEat, flashDeath, popScore,
    draw, startGameOverDissolve, initDissolution, startDissolution, updateDissolution, cancelDissolution,
    getDissolutionProgress
  };
})();
