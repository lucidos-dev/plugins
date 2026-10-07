// End-to-end tests in real Chromium and WebKit (Safari's engine).
//
//   npm run test:e2e
//
// Needs Playwright's browsers and the `playwright-core` package. It is not a
// dependency of the app: point PLAYWRIGHT_CORE at an installed copy, e.g.
//   PLAYWRIGHT_CORE=~/projects/lucidos/node_modules/playwright-core npm run test:e2e
// Without it the suite reports itself as skipped.
//
// The app is served from a tiny local server with a stub Lucidos SDK, so no
// engine is needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const Timing = require('../../js/core/timing.js');

const APP_DIR = path.resolve(__dirname, '../..');

function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_CORE, 'playwright-core', 'playwright'].filter(Boolean);
  for (const c of candidates) {
    try { return require(c.replace(/^~(?=\/)/, process.env.HOME)); } catch (e) {}
  }
  return null;
}

const pw = loadPlaywright();

// Stub SDK: in-memory lucidos.data, with the app's own bundled files served
// for apps/ouroboros/... paths (that is how the app loads its audio clips).
const SDK_STUB = `
window.__files = window.__files || {};
window.lucidos = {
  data: {
    async read(p) {
      if (p.startsWith('apps/ouroboros/')) {
        const res = await fetch('/app/' + p.slice('apps/ouroboros/'.length));
        return res.ok ? res.text() : null;
      }
      return window.__files[p] ?? null;
    },
    async write(p, body) { window.__files[p] = body; }
  },
  ui: { applyPreferences() {}, watchPreferences() {} },
  // Every proxy is an in-memory Firebase RTDB
  proxy: name => ({
    async fetch(path, init = {}) {
      const key = name + path, method = init.method || 'GET';
      window.__rtdb = window.__rtdb || {};
      if (method === 'PUT') window.__rtdb[key] = init.body;
      if (method === 'DELETE') delete window.__rtdb[key];
      const body = method === 'GET' ? (window.__rtdb[key] ?? 'null') : '';
      return { ok: true, status: 200, text: async () => body };
    }
  })
};`;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/v1/sdk.js') return res.end(SDK_STUB);
    if (url.pathname.startsWith('/api/v1/')) { res.setHeader('content-type', 'text/javascript'); return res.end(''); }
    if (!url.pathname.startsWith('/app/')) { res.statusCode = 404; return res.end(); }
    const file = path.join(APP_DIR, decodeURIComponent(url.pathname.slice(5)));
    if (!file.startsWith(APP_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end(); }
    res.setHeader('content-type', MIME[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Records one sample per animation frame from the moment GAME OVER appears.
function installSampler() {
  window.__samples = [];
  const svg = document.getElementById('game-over-svg');
  const texts = svg.querySelectorAll('text');
  const label = document.getElementById('go-highscore');
  const t0 = performance.now();
  const rect = el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
  function sample() {
    const t = performance.now() - t0;
    window.__samples.push({
      t,
      dissolving: svg.classList.contains('dissolving'),
      svg: rect(svg),
      words: Array.from(texts, el => ({
        visible: el.style.opacity === '0.95',
        rect: rect(el),
        y: Number((el.getAttribute('transform') || 'translate(0, NaN)').match(/translate\(0, ([^)]+)\)/)[1])
      })),
      label: { text: label.textContent, opacity: Number(label.style.opacity || 0) }
    });
    if (t < 6500) requestAnimationFrame(sample);
  }
  requestAnimationFrame(sample);
}

async function openApp(browserType, baseUrl, { fps30 = false } = {}) {
  const browser = await browserType.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem('snake-player', 'TEST'));
  if (fps30) {
    // Simulate Safari's 30 Hz cap (Low Power Mode): run callbacks every other frame
    await page.addInitScript(() => {
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = cb => raf(() => raf(cb));
    });
  }
  await page.goto(baseUrl + '/app/index.html');
  await page.waitForSelector('#btn-start', { state: 'visible' });
  return { browser, page, errors };
}

// Put the first food right in front of the snake so the round scores a point
// and the placement label ("NR 1, ...") shows.
async function scoreOnePoint(page) {
  await page.evaluate(() => {
    const G = window.Ouroboros.Game;
    const original = G.spawnFood;
    let first = true;
    G.spawnFood = (...args) => (first ? (first = false, { x: 12, y: 10 }) : original(...args));
  });
}

const fanfare = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'audio/clips/fanfare.json'), 'utf8'));
const EXPECTED_DISSOLVE_MS = Timing.dissolveDelay(Timing.fanfareTiming(fanfare.notes)) * 1000;

const VARIANTS = [
  { name: 'chromium', type: 'chromium' },
  { name: 'webkit', type: 'webkit' },
  { name: 'webkit at 30 fps', type: 'webkit', fps30: true }
];

test('e2e', { skip: pw ? false : 'playwright-core not found (set PLAYWRIGHT_CORE)' }, async t => {
  const server = await startServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());

  for (const v of VARIANTS) {
    await t.test(`${v.name}: the Game Over animation plays fully`, async () => {
      const { browser, page, errors } = await openApp(pw[v.type], baseUrl, v);
      try {
        await scoreOnePoint(page);
        await page.click('#btn-start');
        await page.waitForFunction(() => document.getElementById('game-over-svg').classList.contains('falling'), null, { timeout: 10000 });
        await page.evaluate(installSampler);
        await page.waitForFunction(() => window.__samples.at(-1)?.t >= 6500, null, { timeout: 15000 });
        const samples = await page.evaluate(() => window.__samples);

        // The words are never clipped: whenever one is visible it lies inside
        // the SVG box (WebKit clips a filtered SVG to that box).
        for (const s of samples) {
          s.words.forEach((w, i) => {
            if (!w.visible) return;
            assert.ok(w.rect.top >= s.svg.top - 1 && w.rect.bottom <= s.svg.bottom + 1,
              `word ${i} at ${Math.round(s.t)} ms is outside the SVG box: ${JSON.stringify(w.rect)} vs ${JSON.stringify(s.svg)}`);
          });
        }

        // They visibly fall in from well above their resting place
        const firstVisible = samples.find(s => s.words[0].visible);
        assert.ok(firstVisible.words[0].y < -150, `GAME first seen at y=${firstVisible.words[0].y}`);

        // Both have settled when the dissolve starts, and it starts on the beat
        const dissolveAt = samples.find(s => s.dissolving);
        assert.ok(dissolveAt, 'the dissolve started');
        dissolveAt.words.forEach((w, i) => assert.ok(Math.abs(w.y) < 2, `word ${i} still moving at dissolve: y=${w.y}`));
        assert.ok(Math.abs(dissolveAt.t - EXPECTED_DISSOLVE_MS) < 300, `dissolve at ${Math.round(dissolveAt.t)} ms, expected ~${Math.round(EXPECTED_DISSOLVE_MS)}`);

        // The placement label faded in fully before the dissolve
        const before = samples.filter(s => !s.dissolving);
        assert.equal(before.at(-1).label.text, 'NR 1, DU ER EN LEGENDE!');
        assert.equal(before.at(-1).label.opacity, 1);

        // The sequence finishes on the start screen with nothing left over
        await page.waitForFunction(() =>
          !document.getElementById('start-screen').classList.contains('hidden') &&
          document.getElementById('dissolution-canvas').classList.contains('hidden') &&
          !document.getElementById('overlay').classList.contains('dissolve-fade-in'), null, { timeout: 5000 });
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
      }
    });
  }

  await t.test('webkit: storage screen opens and closes', async () => {
    const { browser, page, errors } = await openApp(pw.webkit, baseUrl);
    try {
      await page.click('#btn-storage');
      await page.waitForSelector('#storage-screen', { state: 'visible' });
      assert.match(await page.textContent('#board-list'), /Lokalt/);
      await page.click('#btn-storage-close');
      await page.waitForSelector('#start-screen', { state: 'visible' });
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });

  await t.test('webkit: a snake-storage-* proxy shows up as a shared board and can be picked', async () => {
    const { browser, page, errors } = await openApp(pw.webkit, baseUrl);
    try {
      await page.evaluate(() => {
        window.__files['config/apis.json'] = JSON.stringify({ openai: {}, 'snake-storage-familien': { base_url: 'https://example.firebaseio.com' } });
        window.__rtdb = { 'snake-storage-familien/snake/highscores.json': JSON.stringify({
          highscores: [{ name: 'MORMOR', score: 42, date: '2026-01-01' }], dailyScores: [], dailyDate: ''
        }) };
      });
      await page.click('#btn-storage');
      await page.waitForSelector('[data-action="pick-shared"][data-proxy="snake-storage-familien"]');
      assert.match(await page.textContent('#board-list'), /Familien/);
      assert.equal(await page.$('[data-action="remove"][data-proxy="snake-storage-familien"]'), null, 'discovered boards have no remove button');
      await page.click('[data-action="pick-shared"][data-proxy="snake-storage-familien"]');
      await page.waitForFunction(() => document.getElementById('btn-storage').textContent === '☁');
      await page.waitForFunction(() => document.querySelector('#highscores-list .hs-name')?.textContent === 'MORMOR');
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });

  await t.test('chromium: scoreboard data cannot inject markup', async () => {
    const { browser, page, errors } = await openApp(pw.chromium, baseUrl);
    try {
      await page.evaluate(() => {
        window.__files['artifacts/games/snake-highscores.json'] = JSON.stringify({
          highscores: [{ name: '<img src=x onerror="window.__pwned=1">', score: '"><b id="pwn">', date: '2026-01-01' }],
          dailyScores: [], dailyDate: ''
        });
      });
      // Reload the board the way a board switch does
      await page.click('#btn-storage');
      await page.click('[data-action="pick-local"]');
      await page.waitForFunction(() => document.querySelector('#highscores-list .hs-name'));
      assert.equal(await page.textContent('#highscores-list .hs-name'), '<img src=x onerror="window.__pwned=1">');
      assert.equal(await page.$('#pwn'), null);
      assert.equal(await page.evaluate(() => window.__pwned), undefined);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
});
