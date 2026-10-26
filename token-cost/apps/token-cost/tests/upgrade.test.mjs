// An update from Token Cost 0.4.4, end to end, on the dashboard.
//
// 0.4.4 kept its prices in artifacts/token-cost/pricing.json. 0.5.0 read
// Lucidos's price table instead and moved nothing over, so every model the
// shipped cards miss went unpriced. These boot the app on the table the
// engine serves before and after scripts/token-cost/migrate_prices.py has
// run against a real (sanitized) 0.4.4 file, and pin that:
//
//   before   the unpriced calls are named in the hero, and Settings says the
//            old prices move on the next rollup
//   after    the moved cards price calls at 0.4.4's rates with 0.4.4's
//            sources and history, the hero warning is gone, and Settings
//            says what moved
//   report   a card that could not move is named with its reason, and a
//            toast points at Settings
//   labels   a settings.json holding only custom producer labels keeps the
//            default labels for every other producer
//
// The engine is tests/fake_lucidos.py, which merges like llm/model_prices.rs.
import fs from 'fs';
import path from 'path';
import { fakeWorkspace as workspace, LEGACY_TEXT } from './fake-engine.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const html = fs.readFileSync(path.join(HERE, '../index.html'), 'utf8');
const src = html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/)[1];
const LEGACY = JSON.parse(LEGACY_TEXT);

// --- the engine, before and after the migration ------------------------------
const before = workspace(true);
const shippedTable = before.table();
const after = workspace(true);
after.migrate();
const migratedTable = after.table();
const migratedReport = after.read('artifacts/token-cost/price-migration.json');

// --- minimal DOM / SDK stubs -------------------------------------------------
let els = new Map();
function mkEl(id) {
  return {
    id, children: [], dataset: {}, style: {}, hidden: false, className: '', classList: {
      _s: new Set(), add(...c) { c.forEach((x) => this._s.add(x)); }, remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    _text: '', set textContent(v) { this._text = String(v); }, get textContent() { return this._text; },
    set innerHTML(v) { this._html = v; if (v === '') this.children = []; }, get innerHTML() { return this._html || ''; },
    setAttribute() {}, getAttribute() { return null; }, addEventListener() {}, appendChild(c) { this.children.push(c); },
    insertBefore(c) { this.children.push(c); }, removeChild() {},
    querySelector() { return mkEl('q'); }, querySelectorAll() { return []; }, get firstChild() { return this.children[0] || null; },
    get lastChild() { return this.children[this.children.length - 1] || null; },
    get offsetWidth() { return 1; }, getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, bottom: 0 }; },
    value: '7', focus() {}, click() {},
  };
}
const getEl = (id) => { if (!els.has(id)) els.set(id, mkEl(id)); return els.get(id); };
global.document = {
  getElementById: getEl, querySelector: () => null, querySelectorAll: () => [],
  createElement: () => mkEl('new'), addEventListener() {}, body: { appendChild() {} }, hidden: false, baseURI: 'https://x/ws/app/token-cost/',
};
global.location = { pathname: '/dev/app/token-cost/', origin: 'https://host', href: 'https://host/dev/app/token-cost/' };
global.window = { addEventListener() {}, innerWidth: 1200, AudioContext: null, location: global.location };
Object.defineProperty(globalThis, 'navigator', { value: { platform: 'MacIntel', userAgent: 'node', maxTouchPoints: 0 }, configurable: true });
global.performance = { now: () => Date.now() };
global.localStorage = { getItem: () => null, setItem() {} };
global.setInterval = () => 0;
global.setTimeout = () => 0;
global.clearTimeout = () => {};
global.fetch = async () => ({ ok: true, json: async () => [] });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.log('  FAIL ' + m); } };
const settle = async () => { for (let i = 0; i < 16; i++) await new Promise((r) => setImmediate(r)); };

const REPORT = 'artifacts/token-cost/price-migration.json';
const LEGACY_PATH = 'artifacts/token-cost/pricing.json';
const SETTINGS = 'artifacts/token-cost/settings.json';

/** Boot a fresh copy of the app on this price table and these files. */
async function boot(table, files) {
  els = new Map();
  const toasts = [];
  const notFound = () => Object.assign(new Error('HTTP 404'), { httpCode: 404 });
  global.lucidos = {
    apiUrl: (s) => '/dev/api/v1' + (s.startsWith('/') ? s : '/' + s),
    ui: { applyPreferences() {}, watchPreferences() {}, enhanceSelects() {}, toast: (m) => toasts.push(m),
          Select: { create: (o) => ({ element: mkEl('sel'), getValue: () => o.value, setValue() {}, setOptions() {}, destroy() {} }) } },
    priceTable: { get: async () => JSON.parse(JSON.stringify(table)) },
    data: {
      read: async (p) => {
        if (p in files) { if (files[p] == null) throw notFound(); return files[p]; }
        if (p.includes('ui-state')) return '{}';
        if (p.includes('daily.json')) return JSON.stringify({ days: {}, hours: {}, last_sequence: 0, bucket_edges: [0, 32000, 64000, 128000, 200000, 400000] });
        throw notFound();
      },
      write: async () => ({ success: true }), url: (p) => '/dev/data/' + p,
    },
    events: { query: async () => [] }, request: async () => [],
    sse: { connect() {}, on() {} },
    utils: { escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
             escapeHtmlAttr: (s) => String(s).replace(/"/g, '&quot;'), timeAgo: () => '1m ago' },
  };
  global.window.lucidos = global.lucidos;
  new Function(src + `;globalThis.__tc = { rateFor, costOf, pushLive, render, renderSettings, producerLabel, localDay };`)();
  await settle();
  const tc = globalThis.__tc;
  tc.renderSettings();
  return { tc, toasts, el: getEl };
}

const now = new Date();
const gemini = (seq) => ({ seq, created: now.toISOString(), thread_id: 't1',
  event: { type: 'ContextCaptured', model: 'gemini-3-flash-preview', producer: 'auxiliary:memory',
           usage: { input_tokens: 1_000_000, cache_read_tokens: 0, cache_creation_tokens: 0, output_tokens: 100_000 } } });
const today = () => globalThis.__tc.localDay(new Date());

console.log('\n1. updated, not yet migrated: the gap is named, not hidden');
{
  const t = await boot(shippedTable, { 'config/model-prices.json': null, [SETTINGS]: null, [REPORT]: null, [LEGACY_PATH]: LEGACY_TEXT });
  ok(t.tc.rateFor('gemini-3-flash-preview', today()) === null, 'gemini-3-flash-preview has no card in the shipped table');
  t.tc.pushLive(gemini(1));
  t.tc.render();
  ok(t.el('hero-unpriced').hidden === false, 'the hero says some spend is not included');
  ok(/1 call on 1 unpriced model/.test(t.el('hero-unpriced-text').textContent), 'and names it: ' + t.el('hero-unpriced-text').textContent);
  const note = t.el('migration-note');
  ok(note.hidden === false, 'Settings shows a migration note');
  ok(/pricing\.json/.test(note.innerHTML) && /next rollup/.test(note.innerHTML), 'it says the 0.4 prices move on the next rollup');
}

console.log('\n2. after the migration: 0.4.4 prices, sources and history, and no warning');
{
  const t = await boot(migratedTable, { 'config/model-prices.json': after.read('config/model-prices.json'), [SETTINGS]: null,
                                         [REPORT]: migratedReport, [LEGACY_PATH]: LEGACY_TEXT });
  const card = t.tc.rateFor('gemini-3-flash-preview', today());
  ok(card && card.source === LEGACY.models['gemini-3-flash-preview'][0].source, 'gemini-3-flash-preview is priced with its 0.4.4 source');
  const cost = t.tc.costOf('gemini-3-flash-preview', { in: 1_000_000, cache_read: 0, cache_write: 0, out: 100_000 }, null, today());
  ok(Math.abs(cost - 0.8) < 1e-9, `at 0.4.4's rates: 1M in at 0.50 + 100k out at 3.00 = 0.80 (got ${cost})`);
  ok(t.tc.rateFor('gpt-5.6-sol', '2026-08-20').uncached_in === 5 && t.tc.rateFor('gpt-5.6-sol', '2026-08-21').uncached_in === 4,
     'gpt-5.6-sol keeps its dated history');
  ok(t.tc.rateFor('gpt-5.5', today()).long.threshold_tokens === 272000, 'gpt-5.5 keeps its long tier');
  ok(t.tc.rateFor('haiku', '2026-06-01').source === LEGACY.models.haiku[0].source, 'the bare haiku alias keeps its own 0.4.4 card');
  ok(t.tc.rateFor('claude-sonnet-4-5-20250929', today()).origin === 'shipped', 'the dated sonnet id prices from the shipped undated card');
  t.tc.pushLive(gemini(1));
  t.tc.render();
  ok(t.el('hero-unpriced').hidden === true, 'the hero warning is gone: every call is priced');
  const note = t.el('migration-note');
  ok(note.hidden === false && /10 cards for 8 models/.test(note.innerHTML), 'Settings says what moved: ' + note.innerHTML.replace(/<[^>]+>/g, '').slice(0, 140));
  ok(!note.className.includes('dirty-dot'), 'with no warning');
  ok(t.toasts.length === 0, 'and no toast');
}

console.log('\n3. a card that could not move is named, with its reason');
{
  const report = JSON.parse(migratedReport);
  report.unsupported = [{ model: 'odd-model', from: '2026-05-01', reason: 'out is negative (-1)' }];
  report.errors = ['lucidos data write config/model-prices.json failed: 500'];
  report.settings.unsupported = [{ field: 'long_context_multiplier', reason: 'the price table has no global long-context multiplier' }];
  const t = await boot(migratedTable, { 'config/model-prices.json': after.read('config/model-prices.json'), [SETTINGS]: null,
                                         [REPORT]: JSON.stringify(report), [LEGACY_PATH]: LEGACY_TEXT });
  const note = t.el('migration-note');
  ok(/odd-model/.test(note.innerHTML) && /2026-05-01/.test(note.innerHTML) && /out is negative/.test(note.innerHTML), 'the card, its day and the reason');
  ok(/data write/.test(note.innerHTML), 'the error');
  ok(/long_context_multiplier/.test(note.innerHTML), 'the setting that has no place in the price table');
  ok(note.className.includes('dirty-dot'), 'as a warning');
  ok(t.toasts.some((m) => /Settings/.test(m)), 'and a toast points at Settings');
}

console.log('\n4. no 0.4 file and no report: no note');
{
  const t = await boot(shippedTable, { 'config/model-prices.json': null, [SETTINGS]: null, [REPORT]: null, [LEGACY_PATH]: null });
  ok(t.el('migration-note').hidden === true, 'nothing to say');
}

console.log('\n5. a settings.json with one custom label keeps every default label');
{
  const t = await boot(shippedTable, { 'config/model-prices.json': null, [SETTINGS]: JSON.stringify({ producers: { main_llm: 'My agent' } }),
                                       [REPORT]: null, [LEGACY_PATH]: null });
  ok(t.tc.producerLabel('main_llm') === 'My agent', 'the custom label');
  ok(t.tc.producerLabel('auxiliary:memory') === 'Memory', 'a default label the file does not hold');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
