// The "Cost by trigger" panel: what each trigger's fires cost.
//
// Pins the plan's four panel invariants: a renamed trigger is one row, a fire
// with no thread counts at $0, the panel prices a fire's threads exactly as
// the Thread grouping does, and a missing triggers.json reads as a sentence.
import fs from 'fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const src = html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/)[1];

// --- minimal DOM / SDK stubs -------------------------------------------------
const els = new Map();
function mkEl(id) {
  return {
    id, children: [], dataset: {}, style: {}, open: false,
    classList: { _s: new Set(), add(...c) { c.forEach((x) => this._s.add(x)); }, remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    _text: '', set textContent(v) { this._text = String(v); }, get textContent() { return this._text; },
    insertAdjacentHTML(_w, h) { this._html = h + (this._html || ''); },
    set innerHTML(v) { this._html = v; if (v === '') this.children = []; }, get innerHTML() { return this._html || ''; },
    setAttribute() {}, getAttribute() { return null; }, addEventListener() {}, appendChild(c) { this.children.push(c); },
    insertBefore(c) { this.children.push(c); }, removeChild() {},
    querySelector(sel) { this._q = this._q || {}; if (!this._q[sel]) this._q[sel] = mkEl('q'); return this._q[sel]; },
    querySelectorAll() { return []; }, get firstChild() { return this.children[0] || null; },
    get lastChild() { return this.children[this.children.length - 1] || null; },
    get offsetWidth() { return 1; }, getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, bottom: 0 }; },
    value: '7', focus() {}, click() {},
  };
}
function getEl(id) { if (!els.has(id)) els.set(id, mkEl(id)); return els.get(id); }

global.document = { getElementById: getEl, querySelector: () => null, querySelectorAll: () => [],
  createElement: () => mkEl('new'), addEventListener() {}, body: { appendChild() {} }, hidden: false, baseURI: 'https://x/ws/app/token-cost/' };
global.location = { pathname: '/dev/app/token-cost/', origin: 'https://host', href: 'https://host/dev/app/token-cost/' };
global.window = { addEventListener() {}, innerWidth: 1200, AudioContext: null, location: global.location };
Object.defineProperty(globalThis, 'navigator', { value: { platform: 'MacIntel', userAgent: 'node', maxTouchPoints: 0 }, configurable: true });
global.performance = { now: () => Date.now() };
global.localStorage = { getItem: () => null, setItem() {} };
global.setInterval = () => 0;
global.setTimeout = () => 0;
global.clearTimeout = () => {};
global.fetch = async () => ({ ok: true, json: async () => [] });

const priceTableRaw = fs.readFileSync(new URL('./fixtures/price-table.json', import.meta.url), 'utf8');
const emptyDaily = { generated: new Date().toISOString(), last_sequence: 0, bucket_edges: [0, 32000, 64000, 128000, 200000, 400000], days: {}, hours: {} };
const reject = () => Promise.reject(Object.assign(new Error('HTTP 404'), { httpCode: 404 }));
// What the SDK hands back; each test sets the files and the live lists.
const disk = { triggers: null, threads: null };
let liveTriggers = [];
let liveThreads = [];

const sseHandlers = new Map();
global.lucidos = {
  apiUrl: (s) => '/dev/api/v1' + (s.startsWith('/') ? s : '/' + s),
  ui: { applyPreferences() {}, watchPreferences() {}, enhanceSelects() {}, toast() {}, navigate() {},
    Select: { create: (o) => { const sel = { element: mkEl('sel'), options: o.options, value: o.value, getValue: () => sel.value,
      setValue(v) { sel.value = v; }, setOptions(x) { sel.options = x; }, destroy() {} }; return sel; } } },
  priceTable: { get: async () => JSON.parse(priceTableRaw) },
  data: {
    read: async (p) => {
      if (p.includes('triggers.json')) return disk.triggers ? JSON.stringify(disk.triggers) : reject();
      if (p.includes('threads-daily')) return disk.threads ? JSON.stringify(disk.threads) : reject();
      if (p.includes('ui-state')) return '{}';
      if (p.includes('daily.json')) return JSON.stringify(emptyDaily);
      return reject();
    },
    write: async () => ({ success: true }), url: (p) => '/dev/data/' + p,
  },
  events: { query: async () => [] }, request: async () => [],
  threads: { list: async () => liveThreads },
  triggers: { list: async () => liveTriggers },
  sse: { connect() {}, on(type, handler) { sseHandlers.set(type, handler); } },
  utils: { escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    escapeHtmlAttr: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    timeAgo: () => '1m ago' },
};

const harness = src + `
;globalThis.__tc = {
  triggerRows, renderTriggers, triggerCallFacts, factsFor, groupLevel, threadMeta, localDay, triggerOpen,
  setPricing(p){ pricing = p; },
  reset(){ threadsDaily = null; threadsState = 'idle'; triggersDoc = null; triggersState = 'idle';
           triggerNames.clear(); threadMeta.clear(); threadLookupAt = 0; triggerOpen.clear(); },
};
`;
new Function(harness)();
global.window.lucidos = global.lucidos;
const tc = globalThis.__tc;
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };
await settle();

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.log('  FAIL ' + m); } };
const near = (a, b) => Math.abs(a - b) < 1e-9;

// acme-1 costs $1 per million uncached input tokens, acme-2 $2.
tc.setPricing({ currency: 'USD', producers: {}, fx: { rates: { USD: 1 } }, models: {
  'acme-1': { uncached_in: 1, cache_write: 0, cache_read: 0, out: 0 },
  'acme-2': { uncached_in: 2, cache_write: 0, cache_read: 0, out: 0 },
} });

const dayOffset = (n) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n); return tc.localDay(d); };
const today = dayOffset(0), d3 = dayOffset(-3), d20 = dayOffset(-20);
const at = (day, hh) => new Date(`${day}T${hh}:00:00`).toISOString();
const F = ['calls', 'cached_calls', 'in'];

// Trigger "trg-a" fired twice, under two titles (it was renamed), and one fire
// opened a sub-thread. "trg-s" is a script trigger: three fires, no thread.
// "trg-p" is a script fire whose proxied calls landed on the home thread.
const threadsFile = () => ({
  last_sequence: 0, fields: F, hours: {},
  threads: { a1: ['Daily digest', null], a2: ['Morning digest', null], a2kid: ['Digest helper', 'a2'],
             home: ['Home', null], solo: ['Unrelated', null] },
  days: {
    [today]: { a1: { 'trigger|acme-1|': [1, 0, 1e6] }, a2kid: { 'claude_code|acme-2|high': [1, 0, 2e6] },
               home: { 'main_llm|acme-1|': [1, 0, 5e6] }, solo: { 'main_llm|acme-1|': [1, 0, 7e6] } },
    [d3]: { a2: { 'trigger|acme-1|': [1, 0, 3e6] } },
    [d20]: { a1: { 'trigger|acme-1|': [1, 0, 1e6] } },
  },
});
const triggersFile = () => ({
  generated: new Date().toISOString(), last_sequence: 0, timezone: 'Europe/Oslo', fields: F,
  triggers: {
    'trg-a': { name: 'Morning digest', fires: { [today]: 1, [d3]: 1, [d20]: 1 } },
    'trg-s': { name: 'Inbox sweep', fires: { [today]: 3 } },
    'trg-p': { name: null, fires: {} },
  },
  threads: { a1: ['trg-a', at(today, '08')], a2: ['trg-a', at(d3, '08')] },
  calls: { [today]: { 'trg-p': { 'script|acme-1|': [1, 0, 4e6] } } },
});

async function openPanel() {
  getEl('trigger-block').open = true;
  tc.renderTriggers([today, d3], 'all');
  await settle();
  tc.renderTriggers([today, d3], 'all');
}
const dayFactsFor = (days) => new Map(days.map((d) => [d, tc.factsFor(d, null, true).concat(tc.triggerCallFacts(d))]));

console.log('\n1. a missing triggers.json reads as a sentence, not an error or zeros');
tc.reset(); disk.triggers = null; disk.threads = threadsFile();
let threw = null;
try { await openPanel(); } catch (e) { threw = e; }
ok(!threw, 'opening the panel does not throw: ' + (threw && threw.message));
ok(/no trigger rollup yet/i.test(getEl('tg-note').textContent) && !getEl('tg-note').hidden, 'the note says there is no trigger rollup yet');
ok(getEl('tg-body').innerHTML === '', 'and no rows pose as zeros');

console.log('\n2. a closed panel reads neither file');
tc.reset(); disk.triggers = triggersFile(); disk.threads = threadsFile();
getEl('trigger-block').open = false;
tc.renderTriggers([today], 'all');
await settle();
ok(getEl('tg-body').innerHTML === '', 'nothing renders while folded');

console.log('\n3. a renamed trigger is one row, named by its live name');
tc.reset(); liveTriggers = [{ id: 'trg-a', name: 'Digest (renamed)' }];
await openPanel();
const days = [today, d3];
const out = tc.triggerRows(dayFactsFor([...new Set([...days, ...Array.from({ length: 30 }, (_, i) => dayOffset(-i))])]), JSON.parse(JSON.stringify(triggersFile())), days, today);
const a = out.filter((r) => r.id === 'trg-a');
ok(a.length === 1, 'two titles, one trigger id: one row (' + a.length + ')');
ok(near(a[0].cost, 1 + 3 + 4), 'its range cost holds both fires and the sub-thread: ' + a[0].cost);
ok(near(a[0].today, 5) && near(a[0].d7, 8) && near(a[0].d30, 9), `today, 7 and 30 days: ${a[0].today}, ${a[0].d7}, ${a[0].d30}`);
ok(a[0].fires === 2 && near(a[0].avg, 4), 'fires over the range and avg per fire: ' + a[0].fires + ', ' + a[0].avg);
ok(a[0].fireList.map((f) => f.root).join() === 'a1,a2', 'its fires list newest first');
ok(near(a[0].fireList[1].cost, 7) && a[0].fireList[1].model === 'acme-2', 'a fire carries its sub-thread, and names its costliest model');
const body = getEl('tg-body').innerHTML;
ok(/Digest \(renamed\)/.test(body) && !/Morning digest<\/td>/.test(body), 'the row shows the live name');

console.log('\n4. fires with no thread count at $0');
const s = out.find((r) => r.id === 'trg-s');
ok(s && s.fires === 3 && s.cost === 0 && s.noThread === 3, 'three script fires, $0, three with no thread');
tc.triggerOpen.add('trg-s');
tc.renderTriggers(days, 'all');
ok(/3 fires with no thread/.test(getEl('tg-body').innerHTML), 'expanded, they collapse into one line');

console.log('\n5. a script fire\'s proxied calls count for its trigger');
const p = out.find((r) => r.id === 'trg-p');
ok(p && near(p.cost, 4) && p.fires === 0 && p.avg === null, 'proxied calls cost $4 with no fire to divide by');
ok(/Unnamed trigger/.test(getEl('tg-body').innerHTML), 'a trigger with no known name says so');

console.log('\n6. the panel prices fire threads exactly as the Thread grouping does');
const facts = days.flatMap((d) => tc.factsFor(d, null, true));
const roots = new Set(Object.keys(triggersFile().threads));
const byThread = tc.groupLevel(facts, ['thread'], '').filter((n) => roots.has(n.id)).reduce((t, n) => t + n.cost, 0);
const fireCost = out.flatMap((r) => r.fireList).reduce((t, f) => t + f.cost, 0);
ok(near(byThread, fireCost) && near(fireCost, 8), `Thread grouping ${byThread} = panel ${fireCost}`);
ok(!out.some((r) => r.fireList.some((f) => f.root === 'home' || f.root === 'solo')), 'threads in no fire tree belong to no trigger');

console.log('\n7. a fire newer than the rollup joins through the thread list');
tc.reset(); liveTriggers = [];
const tf = threadsFile();
tf.days[today].fresh = { 'trigger|acme-1|': [1, 0, 2e6] };
disk.threads = tf; disk.triggers = triggersFile();
liveThreads = [{ thread_id: 'fresh', title: 'Brand new fire', parent_thread_id: null, trigger_id: 'trg-a', created_at: at(today, '11') }];
await openPanel();
await settle();
tc.renderTriggers(days, 'all');
const out7 = tc.triggerRows(dayFactsFor(days), triggersFile(), days, today);
const a7 = out7.find((r) => r.id === 'trg-a');
ok(a7 && a7.fireList[0].root === 'fresh' && near(a7.cost, 10), 'the live fire is listed first and its cost counts: ' + (a7 && a7.cost));

// Writes can arrive separately. Wait for matching snapshots, then recover live.
disk.threads = { ...tf, last_sequence: 1 };
sseHandlers.get('DataFileWritten')({ path: 'artifacts/token-cost/threads-daily.json' });
await settle();
ok(getEl('tg-note').textContent.includes('out of sync') && !getEl('tg-body').innerHTML,
  'the panel hides totals while the rollup cursors differ');
disk.triggers = { ...triggersFile(), last_sequence: 1 };
sseHandlers.get('DataFileWritten')({ path: 'artifacts/token-cost/triggers.json' });
await settle();
ok(getEl('tg-note').hidden && getEl('tg-body').innerHTML.includes('Unnamed trigger'),
  'the panel refreshes automatically when the matching trigger snapshot arrives');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
