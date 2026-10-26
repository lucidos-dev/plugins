// The Thread cost widget (apps/thread-cost/index.html) after an update from
// Token Cost 0.4.4.
//
//   prices     a live call on a model priced only in 0.4.4's pricing.json is
//              priced once the migration has moved its card, at that card's
//              rate, through the table the engine serves
//   unpriced   a call no card prices is never folded in as $0 without a
//              word: the snapshot's per-thread count and the live calls both
//              show as "Not included: N unpriced calls"
//
// The widget's script runs headless against small DOM and SDK stubs.
import fs from 'fs';
import path from 'path';
import { fakeWorkspace } from './fake-engine.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const html = fs.readFileSync(path.join(HERE, '../../thread-cost/index.html'), 'utf8');
const src = html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/)[1];

const shippedTable = fakeWorkspace(true).table();
const migrated = fakeWorkspace(true);
migrated.migrate();
const migratedTable = migrated.table();

// --- minimal DOM / SDK stubs -------------------------------------------------
let els = new Map();
function mkEl(id) {
  const e = {
    id, hidden: false, children: [], dataset: {}, style: {}, className: '', _html: '', _text: '',
    set textContent(v) { this._text = String(v); }, get textContent() { return this._text; },
    set innerHTML(v) { this._html = String(v); }, get innerHTML() { return this._html; },
    get firstElementChild() { return this._first || (this._first = mkEl(id + '>span')); },
    get lastElementChild() { return this.children[this.children.length - 1] || null; },
    appendChild(c) { c._parent = this; this.children.push(c); }, addEventListener() {}, setAttribute() {}, removeAttribute() {},
    querySelectorAll() { return []; }, getClientRects() { return [1]; },
    remove() { if (this._parent) this._parent.children.splice(this._parent.children.indexOf(this), 1); },
  };
  return e;
}
const getEl = (id) => { if (!els.has(id)) els.set(id, mkEl(id)); return els.get(id); };
global.document = {
  getElementById: getEl, querySelectorAll: () => [], createElement: () => mkEl('new'),
  body: { addEventListener() {}, scrollHeight: 0, clientHeight: 0 },
  documentElement: { dataset: {}, classList: { contains: () => false, add() {} } },
};
global.window = { addEventListener() {} };
global.localStorage = { getItem: () => null, setItem() {} };
global.setInterval = () => 0;
global.clearInterval = () => {};

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.log('  FAIL ' + m); } };
const settle = async () => { for (let i = 0; i < 16; i++) await new Promise((r) => setImmediate(r)); };

const now = new Date();
const opus = { all: 4, today: 4, calls: 2 };
function snapshot({ unpriced = 0, restUnpriced = 0 } = {}) {
  return {
    ttl_pricing: 1, generated: now.toISOString(), day: now.toISOString().slice(0, 10), last_sequence: 100,
    total_all: 5, total_today: 4, threads: 2, rates: {},
    top_all: [{ id: 't1', title: 'Thread one', all: 4, today: 4, calls: 2 + unpriced, last: null,
                models: { 'claude-opus-5-5': opus }, ...(unpriced ? { unpriced } : {}) }],
    top_today: [],
    rest: { t9: ['Old thread', 1, 0, 2 + restUnpriced, null, {}, ...(restUnpriced ? [restUnpriced] : [])] },
    unpriced_calls: unpriced + restUnpriced,
  };
}

async function boot(table, snap, focus = 't1', read = async () => JSON.stringify(snap)) {
  els = new Map();
  global.lucidos = {
    ui: { applyPreferences() {}, watchPreferences() {}, navigate() {}, ready() {},
          focusedThread: async () => focus, onFocusedThreadChange() {} },
    threads: { list: async () => [] },
    data: { read },
    priceTable: { get: async () => JSON.parse(JSON.stringify(table)) },
    events: { query: async () => globalThis.__events || [] },
    sse: { connect() {}, on(name, fn) { (globalThis.__sse ||= {})[name] = fn; } },
    params: () => ({}),
  };
  new Function(src + ';globalThis.__w = { fold, render, threadCost, find, sessionRows, priceCall, ratesFromTable };')();
  await settle();
  return globalThis.__w;
}

const gemini = { model: 'gemini-3-flash-preview', producer: 'auxiliary:memory',
                 usage: { input_tokens: 1_000_000, cache_read_tokens: 0, cache_creation_tokens: 0, output_tokens: 100_000 } };

console.log('\n1. the snapshot says how many calls its total leaves out');
{
  const w = await boot(shippedTable, snapshot({ unpriced: 3 }));
  ok(getEl('total').textContent === '$4.00', 'the total is the priced spend: ' + getEl('total').textContent);
  ok(getEl('unpriced').hidden === false, 'the unpriced line shows');
  ok(getEl('unpriced').textContent === 'Not included: 3 unpriced calls', getEl('unpriced').textContent);
  w.fold(101, 't1', gemini);
  w.render();
  ok(getEl('total').textContent === '$4.00', 'an unpriced live call adds nothing to the total');
  ok(getEl('unpriced').textContent === 'Not included: 4 unpriced calls', 'but adds to the count: ' + getEl('unpriced').textContent);
  ok(w.threadCost('t1').calls === 6, 'and to the calls, as the snapshot counts them');
}

console.log('\n2. after the migration, the same live call is priced at the 0.4.4 card');
{
  const w = await boot(migratedTable, snapshot());
  ok(getEl('unpriced').hidden === true, 'nothing is left out, so no line');
  w.fold(101, 't1', gemini);
  w.render();
  ok(getEl('total').textContent === '$4.80', 'opus 4.00 plus gemini 0.50 + 0.30: ' + getEl('total').textContent);
  ok(getEl('unpriced').hidden === true, 'and still no line');
}

console.log('\n3. a thread from the compact list carries its count too');
{
  await boot(shippedTable, snapshot({ restUnpriced: 2 }), 't9');
  ok(getEl('unpriced').textContent === 'Not included: 2 unpriced calls', getEl('unpriced').textContent);
}

console.log('\n4. one unpriced call reads in the singular');
{
  await boot(shippedTable, snapshot({ unpriced: 1 }));
  ok(getEl('unpriced').textContent === 'Not included: 1 unpriced call', getEl('unpriced').textContent);
}

console.log('\n5. compact rows retain unpriced counts beside sessions');
{
  const snap = snapshot({ restUnpriced: 2 });
  snap.rest.t9.push([[1, 1, 'claude-opus-5-5', 'claude_code']]);
  const w = await boot(shippedTable, snap, 't9');
  ok(w.find('t9').unpriced === 2 && w.find('t9').sessions.length === 1, 'the merged compact format keeps both fields');
  snap.rest.t9[6] = snap.rest.t9.pop();
  const legacy = await boot(shippedTable, snap, 't9');
  ok(legacy.find('t9').unpriced === 0 && legacy.find('t9').sessions.length === 1, 'workspace session-only snapshots still read');
}

console.log('\n6. session boundaries keep identical first calls');
{
  const w = await boot(migratedTable, snapshot());
  const p = { ...gemini, producer: 'claude_code', session: 1 };
  w.fold(101, 't1', p);
  w.fold(102, 't1', p);
  w.fold(103, 't1', { ...p, session: 2 });
  const t = w.threadCost('t1');
  ok(t.calls === 4, 'a repeated frame is dropped only inside its own session');
  ok(t.sessions.filter(s => s.n > 0).length === 2, 'each named session keeps its spend');
  ok(Math.abs(t.all - 5.6) < 1e-9, 'both session opening calls are priced');
}

console.log('\n7. a head that omits the focus waits for the full snapshot');
{
  const snap = snapshot();
  let finish;
  const full = new Promise(resolve => { finish = resolve; });
  const reads = [];
  await boot(shippedTable, snap, 't1', async path => {
    reads.push(path);
    return path.endsWith('-head.json') ? JSON.stringify({ ...snap, closed: [], top_all: [], rest: {} }) : full;
  });
  ok(getEl('total').textContent !== '$0.00', 'an uncovered thread never paints as zero');
  finish(JSON.stringify(snap));
  await settle();
  ok(getEl('total').textContent === '$4.00', 'the full snapshot paints its actual total');
  ok(reads.some(p => p.endsWith('-head.json')) && reads.some(p => p.endsWith('threads-cost.json')), 'both snapshot paths were read');
}

console.log('\n8. a reload keeps the live calls its snapshot does not hold');
{
  // The snapshot script reads its cursor first and writes some seconds later,
  // so a call can land after the cursor and before the reload. The widget
  // already folded it live; the reload must fold it again, not drop it.
  const snap = snapshot();
  const w = await boot(migratedTable, snap);
  const call = { ...gemini, producer: 'claude_code', session: 1 };
  w.fold(101, 't1', call);
  w.render();
  ok(getEl('total').textContent === '$4.80', 'the live call is in the total: ' + getEl('total').textContent);
  globalThis.__events = [{ sequence: 101, thread_id: 't1', payload: call }];
  globalThis.__sse.ArtifactUpdated({ artifact_path: 'token-cost/threads-cost.json' });
  await settle();
  ok(getEl('total').textContent === '$4.80', 'and still in it after the reload: ' + getEl('total').textContent);
  ok(w.threadCost('t1').calls === 3, 'counted once, not twice');
  globalThis.__events = [];
}

console.log('\n9. Widget live pricing uses evidenced write lifetimes, tiers and safe old-snapshot fallback');
{
  const card = {uncached_in:2,cache_read:0.2,cache_write:2.5,cache_write_1h:4,cache_write_12h:5,out:10,
    long:{threshold_tokens:200000,uncached_in:4,cache_read:0.4,cache_write:5,cache_write_1h:8,cache_write_12h:10,out:20},
    flex:{uncached_in:1,cache_read:0.1,cache_write:1.25,cache_write_1h:2,cache_write_12h:2.5,out:5}};
  const w = await boot({models:{'cache-model':[card]}}, snapshot());
  const p = {model:'cache-model',usage:{input_tokens:100000,cache_read_tokens:30000,cache_creation_tokens:50000,
    cache_creation_1h_tokens:30000,output_tokens:1000}};
  ok(Math.abs(w.priceCall(p).cost - 0.226) < 1e-9, 'widget prices mixed 5-minute and 1-hour writes');
  const long = structuredClone(p); long.usage.input_tokens = 250000;
  ok(Math.abs(w.priceCall(long).cost - 1.052) < 1e-9, 'widget applies long-tier lifetime rates');
  const flex = structuredClone(p); flex.usage.service_tier = 'flex';
  ok(Math.abs(w.priceCall(flex).cost - 0.113) < 1e-9, 'widget applies Flex lifetime rates');
  const twelve = structuredClone(p); delete twelve.usage.cache_creation_1h_tokens; twelve.usage.cache_creation_requested_ttl='12h';
  ok(Math.abs(w.priceCall(twelve).cost - 0.306) < 1e-9, 'widget prices requested 12-hour writes');
  const missing = structuredClone(p); delete missing.usage.cache_creation_1h_tokens;
  // 20,000 fresh at 2 + 30,000 read at 0.2 + 50,000 written at the base 2.5 + 1,000 out at 10.
  const floor = w.priceCall(missing);
  ok(Math.abs(floor.cost - 0.181) < 1e-9 && floor.ttlUnknown === true,
     'a write with no lifetime evidence prices at the base write rate, flagged: ' + floor.cost);
  w.fold(101,'t1',{ ...missing, producer: 'codex' }); w.render();
  ok(w.threadCost('t1').unpriced === 0, 'a lifetime-unknown call is not unpriced: its input, reads and output are known');
  ok(getEl('total').textContent === '$4.18', 'it is in the total at the floor: ' + getEl('total').textContent);
  ok(getEl('unpriced').textContent === '1 call at the base cache write rate, lifetime unknown (Codex reports no lifetime split)',
     'and the widget says how many and why: ' + getEl('unpriced').textContent);
  ok(getEl('unpriced').title === getEl('unpriced').textContent, 'the whole note survives the one-line ellipsis as its title');
  const known = await boot({models:{'cache-model':[card]}}, { ...snapshot(), ttl_unknown: { t1: { claude_code: 2, 'auxiliary:memory': 1 } } });
  known.render();
  ok(getEl('unpriced').textContent === '3 calls at the base cache write rate, lifetime unknown (Claude Code before Lucidos 0.49.0; calls before Lucidos 0.50.0 or on routes without the split)',
     'snapshot counts carry their reasons: ' + getEl('unpriced').textContent);
  const old = snapshot(); delete old.ttl_pricing;
  const legacy = await boot(undefined, { ...old, rates:{'cache-model':{in:2,cr:0.2,cw:2.5,out:10}} });
  ok(/predates cache lifetime pricing/.test(getEl('unpriced').textContent), 'an old snapshot visibly marks its historic totals until refreshed');
  ok(legacy.priceCall(p) === null, 'old compact rates without premiums cannot silently underprice new writes');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
