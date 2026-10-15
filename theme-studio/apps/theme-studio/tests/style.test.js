// Theme Studio: the stylesheet and the Specimen follow the shared Lucidos rules.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..');
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

test('every :hover rule waits for a real pointer, so a tap on a phone leaves no hover behind', () => {
  const rules = hoverRules(read('style.css'));
  assert.ok(rules.length > 0, 'style.css has hover rules to check');
  const sticky = rules.filter(r => !gated(r)).map(r => r.selector);
  assert.deepEqual(sticky, [], 'hover rules outside @media (hover: hover)');
});

test('the hover check sees an ungated rule', () => {
  const rules = hoverRules('.a:hover { color: red; } @media (hover: hover) { .b:hover { color: blue; } }');
  assert.deepEqual(rules.filter(r => !gated(r)).map(r => r.selector), ['.a:hover']);
});

test('the Specimen status chips are the shared .label tones', () => {
  const html = read('index.html');
  const chips = [...html.matchAll(/<span class="([^"]*)">(Applied|Caution|Error)<\/span>/g)]
    .map(m => [m[2], m[1]]);
  assert.deepEqual(chips, [
    ['Applied', 'label label-success'],
    ['Caution', 'label label-warning'],
    ['Error', 'label label-error'],
  ]);
});

test('no hand-drawn chip is left in the stylesheet', () => {
  assert.doesNotMatch(read('style.css'), /\.spec-chip|\.spec-ok|\.spec-warn|\.spec-err/);
});
