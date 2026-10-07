// Ouroboros, the canvas: grid, walls, snake, food and the dissolving body.
(function (O) {
  'use strict';

  const { GRID_SIZE } = O.config;
  const P = O.Palette;
  const Effects = O.Effects;
  const { segmentDissolve } = O.Timing;

  let canvas, ctx;
  let foodBobPhase = 0;
  // The head follows the pointer on the idle screens
  let mousePos = null;
  let mouseOverCanvas = false;

  function init(canvasEl) {
    canvas = canvasEl;
    ctx = canvas.getContext('2d');
    canvas.addEventListener('mousemove', e => {
      const rect = canvas.getBoundingClientRect();
      mousePos = { x: (e.clientX - rect.left) / rect.width * canvas.width, y: (e.clientY - rect.top) / rect.height * canvas.height };
      mouseOverCanvas = true;
    });
    canvas.addEventListener('mouseleave', () => { mouseOverCanvas = false; });
  }

  // Size the backing store to a whole number of cells.
  function resize() {
    const size = canvas.parentElement.clientWidth;
    canvas.width = GRID_SIZE * Math.floor(size / GRID_SIZE);
    canvas.height = canvas.width;
  }

  function cellSize() {
    return canvas.width / GRID_SIZE;
  }

  function reset() {
    foodBobPhase = 0;
  }

  function drawBackground() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const vignette = ctx.createRadialGradient(
      canvas.width / 2, canvas.height / 2, canvas.width * 0.3,
      canvas.width / 2, canvas.height / 2, canvas.width * 0.7
    );
    vignette.addColorStop(0, 'transparent');
    vignette.addColorStop(1, 'rgba(0,0,0,0.25)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  function drawGrid() {
    const c = cellSize();
    ctx.strokeStyle = P.GRID_COLOR;
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

  function drawEye(x, y, size) {
    // Yellowish-green reptile eye
    const grad = ctx.createRadialGradient(x, y, 0, x, y, size);
    grad.addColorStop(0, '#e8e44a');
    grad.addColorStop(0.6, '#c4a820');
    grad.addColorStop(1, '#8a7a10');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(x, y, size, 0, Math.PI * 2); ctx.fill();
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

    drawEye(ex1, ey1, eyeSize);
    drawEye(ex2, ey2, eyeSize);

    // Vertical slit pupils, always vertical: the eyes are at rest
    const slitW = eyeSize * 0.22;
    const slitH = eyeSize * 0.85;
    ctx.fillStyle = P.PUPIL_COLOR;
    ctx.beginPath(); ctx.ellipse(ex1, ey1, slitW, slitH, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(ex2, ey2, slitW, slitH, 0, 0, Math.PI * 2); ctx.fill();

    // Tiny eye highlights
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.beginPath(); ctx.arc(ex1 - slitW * 0.8, ey1 - slitH * 0.3, eyeSize * 0.12, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(ex2 - slitW * 0.8, ey2 - slitH * 0.3, eyeSize * 0.12, 0, Math.PI * 2); ctx.fill();
  }

  function drawBody(snake) {
    const c = cellSize();
    const len = snake.length;
    const padding = 1;
    const radius = c * 0.28;

    // Tail first, so each segment overlaps the one behind it
    for (let i = len - 1; i >= 1; i--) {
      const seg = snake[i];
      const prev = snake[i - 1];
      const px = seg.x * c;
      const py = seg.y * c;

      // Bridge the gap towards the previous segment
      ctx.fillStyle = P.lerpColor(P.SNAKE_BODY_START, P.SNAKE_BODY_END, (i - 0.5) / (len - 1));
      if (prev.x !== seg.x) {
        const bx = Math.min(prev.x, seg.x) * c + c / 2;
        ctx.fillRect(bx, py + padding + 1, c, c - padding * 2 - 2);
      } else {
        const by = Math.min(prev.y, seg.y) * c + c / 2;
        ctx.fillRect(px + padding + 1, by, c - padding * 2 - 2, c);
      }

      ctx.fillStyle = P.lerpColor(P.SNAKE_BODY_START, P.SNAKE_BODY_END, i / (len - 1));
      P.roundRect(ctx, px + padding, py + padding, c - padding * 2, c - padding * 2, radius);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      P.roundRect(ctx, px + padding + 1, py + padding + 1, c - padding * 2 - 2, (c - padding * 2) * 0.4, radius);
      ctx.fill();
    }
  }

  // A wide, triangular reptile head
  function drawHead(head, direction, followPointer) {
    const c = cellSize();
    const hx = head.x * c + c / 2;
    const hy = head.y * c + c / 2;

    let headDir = direction;
    if (followPointer && mouseOverCanvas && mousePos) {
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
    ctx.shadowColor = P.SNAKE_HEAD;
    ctx.shadowBlur = 12;

    const headGrad = ctx.createRadialGradient(hx, hy, 0, hx, hy, headW * 1.3);
    headGrad.addColorStop(0, '#5ce892');
    headGrad.addColorStop(0.5, P.SNAKE_HEAD);
    headGrad.addColorStop(1, '#1a9a4a');
    ctx.fillStyle = headGrad;

    // Start from the snout and go around
    ctx.beginPath();
    ctx.moveTo(tipX + perpX * snoutW, tipY + perpY * snoutW);
    ctx.quadraticCurveTo(jaw1X + headDir.x * headL * 0.3, jaw1Y + headDir.y * headL * 0.3, jaw1X, jaw1Y);
    ctx.quadraticCurveTo(rearX + perpX * headW * 0.8, rearY + perpY * headW * 0.8, rearX, rearY);
    ctx.quadraticCurveTo(rearX - perpX * headW * 0.8, rearY - perpY * headW * 0.8, jaw2X, jaw2Y);
    ctx.quadraticCurveTo(jaw2X + headDir.x * headL * 0.3, jaw2Y + headDir.y * headL * 0.3, tipX - perpX * snoutW, tipY - perpY * snoutW);
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
      ctx.quadraticCurveTo(rx - headDir.x * headL * 0.08, ry - headDir.y * headL * 0.08, rx - perpX * sw, ry - perpY * sw);
      ctx.stroke();
    }

    // Top highlight
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.beginPath();
    ctx.ellipse(hx + headDir.x * headL * 0.1, hy + headDir.y * headL * 0.1, headW * 0.5, headL * 0.35, angle, 0, Math.PI * 2);
    ctx.fill();

    // Nostrils
    const nostrilDist = snoutW * 0.5;
    const nostrilForward = headL * 0.75;
    const nostrilR = headW * 0.06;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath(); ctx.arc(hx + headDir.x * nostrilForward + perpX * nostrilDist, hy + headDir.y * nostrilForward + perpY * nostrilDist, nostrilR, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(hx + headDir.x * nostrilForward - perpX * nostrilDist, hy + headDir.y * nostrilForward - perpY * nostrilDist, nostrilR, 0, Math.PI * 2); ctx.fill();

    ctx.restore();

    drawEyes(hx, hy, headW, headDir);
  }

  function drawFood(food) {
    if (!food) return;
    const c = cellSize();
    const fx = food.x * c + c / 2;
    const fy = food.y * c + c / 2;

    foodBobPhase += 0.06;
    const bob = Math.sin(foodBobPhase) * 1.5;
    const pulse = 1 + Math.sin(foodBobPhase * 1.5) * 0.08;
    const r = (c / 2 - 3) * pulse;

    const glow = ctx.createRadialGradient(fx, fy + bob, r * 0.3, fx, fy + bob, r * 2.5);
    glow.addColorStop(0, 'rgba(239, 68, 68, 0.15)');
    glow.addColorStop(1, 'rgba(239, 68, 68, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(fx, fy + bob, r * 2.5, 0, Math.PI * 2); ctx.fill();

    const foodGrad = ctx.createRadialGradient(fx - r * 0.3, fy + bob - r * 0.3, r * 0.1, fx, fy + bob, r);
    foodGrad.addColorStop(0, P.FOOD_GLOW);
    foodGrad.addColorStop(1, P.FOOD_COLOR);
    ctx.fillStyle = foodGrad;
    ctx.beginPath(); ctx.arc(fx, fy + bob, r, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.beginPath(); ctx.arc(fx - r * 0.25, fy + bob - r * 0.25, r * 0.25, 0, Math.PI * 2); ctx.fill();
  }

  // The dead snake: segments shrink away one after another, head (red) first.
  function drawDyingSnake(segments, frame) {
    const c = cellSize();
    const len = segments.length;
    segments.forEach((seg, i) => {
      const t = segmentDissolve(i, frame);
      if (t <= 0) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = i === 0 ? P.FOOD_COLOR : P.lerpColor(P.SNAKE_BODY_START, P.SNAKE_BODY_END, len > 1 ? i / (len - 1) : 0);
        P.roundRect(ctx, seg.x * c + 1.5, seg.y * c + 1.5, c - 3, c - 3, c * 0.28);
        ctx.fill();
      } else if (t < 1) {
        const size = (c - 3) * (1 - t);
        ctx.globalAlpha = 1 - t;
        ctx.fillStyle = i === 0 ? P.FOOD_COLOR : P.SNAKE_HEAD;
        P.roundRect(ctx, seg.x * c + c / 2 - size / 2, seg.y * c + c / 2 - size / 2, size, size, size * 0.3);
        ctx.fill();
      }
    });
    ctx.globalAlpha = 1;
  }

  // state: { snake, food, direction, isPlaying, death? }
  // death: { segments, frame, steps } while the death animation runs.
  function draw(state) {
    drawBackground();
    drawGrid();
    drawWalls();

    if (state.death) {
      const { segments, frame, steps } = state.death;
      Effects.drawTrail(ctx, true, steps);
      drawDyingSnake(segments, frame);
      Effects.drawParticles(ctx);
      Effects.update(steps);
      return;
    }

    Effects.drawTrail(ctx, false);
    drawFood(state.food);
    drawBody(state.snake);
    if (state.snake.length > 0) drawHead(state.snake[0], state.direction, !state.isPlaying);
    Effects.drawParticles(ctx);
    Effects.update();
  }

  O.Board = {
    init, resize, cellSize, reset, draw,
    get canvas() { return canvas; }
  };
})(window.Ouroboros);
