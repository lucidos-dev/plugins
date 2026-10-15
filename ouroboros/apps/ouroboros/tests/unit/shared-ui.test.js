// Ouroboros follows the shared Lucidos UI rules: hovers that wait for a real
// pointer, the SDK tooltip, and the shared stylesheet that paints it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '../..');
const read = name => fs.readFileSync(path.join(APP_DIR, name), 'utf8');

// Every rule whose selector names :hover, with the at-rule preludes around it.
function hoverRules(css) {
  const rules = [];
  const stack = [];
  let prelude = '';
  for (const ch of css.replace(/\/\*[\s\S]*?\*\//g, '')) {
    if (ch === '{') {
      const p = prelude.trim();
      if (!p.startsWith('@') && p.includes(':hover')) rules.push({ selector: p, within: [...stack] });
      stack.push(p);
      prelude = '';
    } else if (ch === '}') {
      stack.pop();
      prelude = '';
    } else if (ch === ';') {
      prelude = '';
    } else {
      prelude += ch;
    }
  }
  return rules;
}

const gated = rule => rule.within.some(p => /^@media[^{]*\(\s*hover\s*:\s*hover\s*\)/.test(p));

test('the hover check sees an ungated rule', () => {
  const rules = hoverRules('.a:hover { color: red; } @media (hover: hover) { .b:hover { color: blue; } }');
  assert.deepEqual(rules.filter(r => !gated(r)).map(r => r.selector), ['.a:hover']);
});

test('every :hover rule waits for a real pointer, so a tap on a phone leaves no hover behind', () => {
  const sticky = [];
  let total = 0;
  for (const file of fs.readdirSync(path.join(APP_DIR, 'css')).filter(f => f.endsWith('.css'))) {
    const rules = hoverRules(read(`css/${file}`));
    total += rules.length;
    for (const r of rules) if (!gated(r)) sticky.push(`${file}: ${r.selector}`);
  }
  assert.ok(total > 0, 'the stylesheets have hover rules to check');
  assert.deepEqual(sticky, []);
});

test('the page links the shared stylesheet before its own, so tooltips and labels are painted', () => {
  const html = read('index.html');
  const shared = html.indexOf('href="/api/v1/sdk-iframe.css"');
  assert.ok(shared > 0, 'index.html links /api/v1/sdk-iframe.css');
  assert.ok(shared < html.indexOf('href="css/base.css"'), 'it comes before css/base.css, so the game\'s own rules win');
});

test('no control uses a browser title tooltip', () => {
  for (const file of ['index.html', 'js/ui/storage-screen.js', 'js/ui/scoreboard.js']) {
    assert.doesNotMatch(read(file), /\stitle="|\.title\s*=/, `${file} still sets a title tooltip`);
  }
});

test('the header icon buttons carry a tooltip and a name for screen readers', () => {
  const html = read('index.html');
  for (const [id, name] of [['toggle-music', 'Music'], ['toggle-sfx', 'Sound effects'], ['btn-storage', 'Leaderboard storage']]) {
    const tag = html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`));
    assert.ok(tag, `#${id} is a button`);
    assert.match(tag[0], new RegExp(`data-tooltip="${name}"`), `#${id} tooltip`);
    assert.match(tag[0], new RegExp(`aria-label="${name}"`), `#${id} aria-label`);
  }
});

test('the player badge is a button you can tab to, and the replay marker is a shared label', () => {
  const html = read('index.html');
  assert.match(html, /<button type="button" class="player-badge hidden" id="player-badge" data-tooltip="Switch player">/);
  assert.match(html, /<span class="label header-replay-badge hidden" id="header-replay-badge">/);
});
