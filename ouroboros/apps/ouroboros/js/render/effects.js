// Ouroboros: canvas particles (splashes) and the fading trail behind the snake.
//
// Positions are in canvas pixels; callers pass the cell size `c`.
(function (O) {
  'use strict';

  const P = O.Palette;

  let particles = [];
  let trail = [];

  function reset() {
    particles = [];
    trail = [];
  }

  function droplet(x, y, angle, spd, extra) {
    particles.push({ x, y, vx: Math.cos(angle) * spd, vy: Math.sin(angle) * spd, life: 1, type: 'droplet', ...extra });
  }

  function spawnEat(cellX, cellY, c) {
    const cx = cellX * c + c / 2;
    const cy = cellY * c + c / 2;
    // Splat particles
    for (let i = 0; i < 12; i++) {
      droplet(cx, cy, (Math.PI * 2 / 12) * i + Math.random() * 0.5, 2 + Math.random() * 3.5, {
        decay: 0.02 + Math.random() * 0.015,
        size: 2 + Math.random() * 3,
        color: Math.random() > 0.5 ? P.FOOD_COLOR : P.FOOD_GLOW,
        gravity: 0.06
      });
    }
    // Green splash
    for (let i = 0; i < 6; i++) {
      droplet(cx, cy, Math.random() * Math.PI * 2, 1.5 + Math.random() * 2.5, {
        decay: 0.025 + Math.random() * 0.02,
        size: 1.5 + Math.random() * 2.5,
        color: Math.random() > 0.4 ? P.SNAKE_HEAD : '#88eaaa',
        gravity: 0.04
      });
    }
  }

  function spawnDeath(snake, c) {
    const hx = snake[0].x * c + c / 2;
    const hy = snake[0].y * c + c / 2;

    // Big splash droplets from the impact point
    for (let j = 0; j < 18; j++) {
      const angle = Math.random() * Math.PI * 2;
      const spd = 3 + Math.random() * 6;
      particles.push({
        x: hx, y: hy,
        vx: Math.cos(angle) * spd, vy: Math.sin(angle) * spd - 2,
        life: 1, decay: 0.012 + Math.random() * 0.01,
        size: 2.5 + Math.random() * 4,
        color: Math.random() > 0.4 ? P.SNAKE_HEAD : '#88eaaa',
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

    // Every segment drips as it dissolves, head first
    snake.forEach((seg, i) => {
      const cx = seg.x * c + c / 2;
      const cy = seg.y * c + c / 2;
      for (let j = 0; j < 4; j++) {
        const angle = Math.random() * Math.PI * 2;
        const spd = 1 + Math.random() * 2;
        particles.push({
          x: cx, y: cy,
          vx: Math.cos(angle) * spd, vy: Math.sin(angle) * spd + 0.5,
          life: 1, decay: 0.015 + Math.random() * 0.01,
          size: 1.5 + Math.random() * 2.5,
          color: i === 0 ? P.FOOD_COLOR : P.SNAKE_HEAD,
          type: 'droplet', delay: i * 5, gravity: 0.1
        });
      }
    });
  }

  // Advance the particles by `steps` frames.
  function update(steps = 1) {
    for (let s = 0; s < steps; s++) {
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        if (p.delay && p.delay > 0) { p.delay--; continue; }
        p.x += p.vx;
        p.y += p.vy;
        if (p.gravity) p.vy += p.gravity;
        p.vx *= 0.96;
        p.vy *= 0.96;
        p.life -= p.decay;
        if (p.life <= 0) particles.splice(i, 1);
      }
    }
  }

  function drawParticles(ctx) {
    particles.forEach(p => {
      if (p.delay && p.delay > 0) return;
      // Round wet blobs that stretch slightly in the direction of movement
      const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
      const stretch = Math.min(1.6, 1 + speed * 0.08);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(Math.atan2(p.vy, p.vx));
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
    });
    ctx.globalAlpha = 1;
  }

  function addTrail(seg, c) {
    trail.push({ x: seg.x * c + c / 2, y: seg.y * c + c / 2, life: 1, size: c * 0.3 });
    if (trail.length > 60) trail.shift();
  }

  // Fade the trail by `steps` frames and draw it. It lingers longer and a
  // little brighter while frozen (during the death animation).
  function drawTrail(ctx, frozen, steps = 1) {
    trail.forEach(t => {
      t.life -= (frozen ? 0.012 : 0.018) * steps;
      if (t.life <= 0) return;
      ctx.globalAlpha = t.life * (frozen ? 0.25 : 0.15);
      ctx.fillStyle = P.SNAKE_HEAD;
      ctx.beginPath();
      ctx.arc(t.x, t.y, t.size * t.life, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
    while (trail.length > 0 && trail[0].life <= 0) trail.shift();
  }

  O.Effects = { reset, spawnEat, spawnDeath, update, drawParticles, addTrail, drawTrail };
})(window.Ouroboros);
