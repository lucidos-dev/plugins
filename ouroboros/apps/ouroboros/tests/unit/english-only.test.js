// The UI is English. v0.3.0 was rebuilt from an old Norwegian source and
// shipped Norwegian strings again after v0.2.0 had translated them. This test
// scans every shipped text file in the plugin so that cannot happen twice.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_ROOT = path.resolve(__dirname, '../..');
// The plugin root (manifest.toml, media/) sits two levels above the app. Fall
// back to the app alone when the app is checked out without it.
const PLUGIN_ROOT = fs.existsSync(path.resolve(APP_ROOT, '../../manifest.toml'))
  ? path.resolve(APP_ROOT, '../..')
  : APP_ROOT;

const TEXT_EXTENSIONS = new Set(['.html', '.js', '.cjs', '.mjs', '.css', '.md', '.json', '.toml', '.svg']);
const SKIP_DIRS = new Set(['node_modules', '.git']);
const SELF = path.resolve(__filename);

// Written as escapes so this file holds no Norwegian letters itself.
const NORWEGIAN_LETTERS = /[\u00e6\u00f8\u00e5\u00c6\u00d8\u00c5]/;

// Norwegian UI words that have shipped in this app before. Matched as whole
// words, case-insensitive. Player names in fixtures (KENNETH, MORMOR) are fine.
const NORWEGIAN_WORDS = [
  'spiller', 'spillere', 'spilleren', 'toppliste', 'topplister', 'topplisten',
  'poeng', 'rekord', 'rekorden', 'dagens', 'beste', 'legender', 'legende',
  'klar', 'bytt', 'bytte', 'heter', 'hva', 'ny', 'nytt', 'nye', 'navn', 'navnet',
  'lagre', 'lagret', 'lagring', 'slett', 'avbryt', 'ferdig', 'fjern',
  'feil', 'feilet', 'ukjent', 'finnes', 'allerede', 'kreves', 'etikett',
  'ingen', 'ikke', 'eller', 'kun', 'privat', 'delt', 'lokalt', 'familien',
  'kopiert', 'kopier', 'virker', 'lesing', 'skriving', 'stopp',
  'musikk', 'lydeffekter', 'klikk', 'hysj'
];
const WORD_RE = new RegExp(`(?<![\\p{L}\\p{N}_])(${NORWEGIAN_WORDS.join('|')})(?![\\p{L}\\p{N}_])`, 'iu');

function shippedTextFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...shippedTextFiles(full));
    } else if (TEXT_EXTENSIONS.has(path.extname(entry.name)) && full !== SELF) {
      out.push(full);
    }
  }
  return out.sort();
}

test('the scan finds the files it is meant to guard', () => {
  const rel = shippedTextFiles(PLUGIN_ROOT).map(f => path.relative(APP_ROOT, f));
  for (const f of ['index.html', 'js/ui/screens.js', 'js/ui/storage-screen.js', 'js/store.js', 'css/overlay.css', 'knowhow/storage-backends.md']) {
    assert.ok(rel.includes(f), `expected the scan to include ${f}`);
  }
});

test('no shipped text file contains Norwegian letters or UI words', () => {
  const hits = [];
  for (const file of shippedTextFiles(PLUGIN_ROOT)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const letter = NORWEGIAN_LETTERS.exec(line);
      const word = WORD_RE.exec(line);
      if (!letter && !word) return;
      const found = [letter && `letter "${letter[0]}"`, word && `word "${word[1]}"`].filter(Boolean).join(', ');
      hits.push(`  ${path.relative(PLUGIN_ROOT, file)}:${i + 1}: ${found}: ${line.trim().slice(0, 140)}`);
    });
  }
  if (hits.length) {
    assert.fail(`Norwegian text found in ${hits.length} line(s). The UI is English; translate these:\n${hits.join('\n')}`);
  }
});

test('index.html declares lang="en"', () => {
  const html = fs.readFileSync(path.join(APP_ROOT, 'index.html'), 'utf8');
  assert.match(html, /<html[^>]*\blang="en"/);
});
