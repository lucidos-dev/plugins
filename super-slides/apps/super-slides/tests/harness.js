/* ══════════════════════════════════════════════════════
   Super Slides — Test Harness
   ══════════════════════════════════════════════════════
   Lightweight test framework. Supports suites, setup/
   teardown, sync and async tests.

   Usage:
     suite('My Suite', (t) => {
       t.beforeEach(() => { ... });
       t.test('does thing', () => { assertEqual(1, 1, 'one'); });
     });
     renderResults('results');
   ══════════════════════════════════════════════════════ */

const _testResults = [];
const _pendingSuites = [];
let _currentSuite = null;

function suite(name, fn) {
  const s = { name, tests: [], beforeEach: null, afterEach: null };
  _currentSuite = s;
  const t = {
    beforeEach(fn) { s.beforeEach = fn; },
    afterEach(fn) { s.afterEach = fn; },
    test(name, fn) {
      s.tests.push({ name, fn });
    },
  };
  fn(t);
  // Run all tests in this suite
  _testResults.push({ suite: name });
  for (const test of s.tests) {
    try {
      if (s.beforeEach) s.beforeEach();
      test.fn();
      if (s.afterEach) s.afterEach();
      _testResults.push({ name: test.name, pass: true });
    } catch (e) {
      _testResults.push({ name: test.name, pass: false, error: e.message });
    }
  }
  _currentSuite = null;
}

/* ── Async suites ──────────────────────────────────
   Same shape as suite(), but test/beforeEach/afterEach fns may be async.
   asuite() kicks off immediately and registers its promise on
   _pendingSuites; bootstrap() (see index.html) awaits all of them before
   rendering, so async results land in _testResults before renderResults runs. */
function asuite(name, fn) {
  const s = { name, tests: [], beforeEach: null, afterEach: null };
  const t = {
    beforeEach(fn) { s.beforeEach = fn; },
    afterEach(fn) { s.afterEach = fn; },
    test(name, fn) { s.tests.push({ name, fn }); },
  };
  const p = (async () => {
    await fn(t);
    _testResults.push({ suite: name });
    for (const test of s.tests) {
      try {
        if (s.beforeEach) await s.beforeEach();
        await test.fn();
        if (s.afterEach) await s.afterEach();
        _testResults.push({ name: test.name, pass: true });
      } catch (e) {
        _testResults.push({ name: test.name, pass: false, error: e.message });
      }
    }
  })();
  _pendingSuites.push(p);
  return p;
}

/* Await every registered async suite, then render. Call once after all
   <script> test files have loaded (replaces a bare renderResults call). */
async function bootstrap(containerId) {
  try { await Promise.all(_pendingSuites); }
  catch (e) { /* individual failures are already captured per-test */ }
  return renderResults(containerId);
}

/* ── Async assertions ──────────────────────────────── */

async function assertThrowsAsync(fn, label) {
  let threw = false;
  try { await fn(); } catch (e) { threw = true; }
  if (!threw) throw new Error(`${label || 'assertThrowsAsync'}: expected the call to throw`);
}

/* ── Assertions ──────────────────────────────────── */

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label || 'assertEqual'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertNotEqual(actual, expected, label) {
  if (actual === expected) {
    throw new Error(`${label || 'assertNotEqual'}: expected NOT ${JSON.stringify(expected)}`);
  }
}

function assertDeepEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${label || 'assertDeepEqual'}: expected ${b}, got ${a}`);
  }
}

function assertGreater(actual, than, label) {
  if (!(actual > than)) {
    throw new Error(`${label || 'assertGreater'}: expected ${actual} > ${than}`);
  }
}

function assertGreaterOrEqual(actual, than, label) {
  if (!(actual >= than)) {
    throw new Error(`${label || 'assertGreaterOrEqual'}: expected ${actual} >= ${than}`);
  }
}

/* ── Render Results ──────────────────────────────── */

function renderResults(containerId) {
  const container = document.getElementById(containerId);
  let totalPass = 0, totalFail = 0;
  let html = '';
  let inSuite = false;

  _testResults.forEach(r => {
    if (r.suite) {
      if (inSuite) html += '</div>';
      inSuite = true;
      html += `<div class="suite"><h2>${r.suite}</h2>`;
      return;
    }
    if (r.pass) {
      totalPass++;
      html += `<div class="test pass"><span class="icon">✓</span> ${r.name}</div>`;
    } else {
      totalFail++;
      html += `<div class="test fail"><span class="icon">✗</span> ${r.name}</div>`;
      html += `<div class="fail detail">${r.error}</div>`;
    }
  });
  if (inSuite) html += '</div>';

  const allPass = totalFail === 0;
  html += `<div class="summary ${allPass ? 'all-pass' : 'has-fail'}">
    ${allPass ? '✓' : '✗'} ${totalPass} passed, ${totalFail} failed — ${totalPass + totalFail} total
  </div>`;

  container.innerHTML = html;
  return { pass: totalPass, fail: totalFail };
}
