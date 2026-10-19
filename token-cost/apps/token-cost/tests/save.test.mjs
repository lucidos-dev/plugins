// Saving from Settings, found in the 2026-10-10 hardening pass and carried
// over when prices moved onto Lucidos's price table (2026-10-19):
//
//   in flight  an edit typed while a save was being written was marked saved
//              with it and never written
//   stale      a tab held the table it opened with, so its next autosave
//              wrote that old copy over a newer file (another tab, the phone,
//              the price check, a hand edit) and silently undid the change
//   override   a price edit lands in config/model-prices.json, never in the
//              shipped cards; only the edited model is written, and every
//              other card and field in the file is kept as it was
//   ignored    while Lucidos ignores the override, its cards are not in the
//              table, so a price edit must not write over them
//   settings   producer labels and exchange rates go to settings.json
import fs from 'fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const src = html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/)[1];

// --- minimal DOM / SDK stubs -------------------------------------------------
const els = new Map();
function mkEl(id){
  const e = {
    id, children: [], dataset:{}, style:{}, classList:{
      _s:new Set(), add(...c){c.forEach(x=>this._s.add(x));}, remove(...c){c.forEach(x=>this._s.delete(x));},
      toggle(c,on){ on?this._s.add(c):this._s.delete(c); }, contains(c){return this._s.has(c);} },
    _text:'', set textContent(v){this._text=String(v);}, get textContent(){return this._text;},
    set innerHTML(v){ this._html=v; if(v==='')this.children=[]; }, get innerHTML(){return this._html||'';},
    setAttribute(){}, getAttribute(){return null;}, addEventListener(){}, appendChild(c){this.children.push(c);},
    insertBefore(c,b){ const i=b?this.children.indexOf(b):-1; if(i<0)this.children.push(c); else this.children.splice(i,0,c); },
    removeChild(c){ const i=this.children.indexOf(c); if(i>=0)this.children.splice(i,1); },
    querySelector(){ return mkEl('q'); }, querySelectorAll(){return [];}, get firstChild(){return this.children[0]||null;},
    get lastChild(){return this.children[this.children.length-1]||null;},
    get offsetWidth(){return 1;}, getBoundingClientRect(){return {top:0,left:0,width:0,height:0,bottom:0};},
    value:'7', focus(){}, click(){},
  };
  return e;
}
function getEl(id){ if(!els.has(id)) els.set(id, mkEl(id)); return els.get(id); }

global.document = {
  getElementById:getEl, querySelector:()=>null, querySelectorAll:()=>[],
  createElement:()=>mkEl('new'), addEventListener(){}, body:{appendChild(){}}, hidden:false, baseURI:'https://x/ws/app/token-cost/',
};
global.location = { pathname:'/dev/app/token-cost/', origin:'https://host', href:'https://host/dev/app/token-cost/' };
global.window = { addEventListener(){}, innerWidth:1200, AudioContext:null, location:global.location };
Object.defineProperty(globalThis,'navigator',{value:{platform:'MacIntel',userAgent:'node',maxTouchPoints:0},configurable:true});
global.performance = { now:()=>Date.now() };
global.localStorage = { getItem:()=>null, setItem(){}, };
global.setInterval = ()=>0;
// Timers are collected and fired by hand, so a test decides when the
// autosave debounce runs.
let timers = [];
global.setTimeout = (f)=>{ timers.push(f); return timers.length; };
global.clearTimeout = ()=>{};
global.fetch = async () => ({ ok:true, json: async()=>[] });
global.URL = URL;
global.Intl = Intl;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.log('  FAIL ' + m); } };
const settle = async () => { for (let i = 0; i < 16; i++) await new Promise((r) => setImmediate(r)); };
const runTimers = async () => { const t = timers; timers = []; t.forEach((f) => f()); await settle(); };

const OVERRIDE = 'config/model-prices.json';
const SETTINGS = 'artifacts/token-cost/settings.json';
const SHIPPED = {
  currency: 'USD', checked: '2026-10-16',
  models: {
    'claude-opus-5': [{ uncached_in: 5, cache_write: 6.25, cache_write_1h: 10, cache_read: 0.5, out: 25, source: 'shipped opus' }],
    'gpt-6.1-sol': [{ uncached_in: 2, cache_write: 2.5, cache_read: 0.1, out: 10, source: 'shipped sol' }],
  },
};
const override = (models, extra = {}) => JSON.stringify({ checked: '2026-10-19', currency: 'USD',
  sources: { openai: 'https://developers.openai.com/api/docs/pricing' },
  failures: { openai: { count: 0, last_ok: '2026-10-19' } }, models, ...extra }, null, 2);
const ACME = [{ uncached_in: 1, cache_write: 0, cache_read: 0.1, out: 4, source: 'acme page', note: 'kept' }];

/** The engine's merge (llm/model_prices.rs): an override card replaces the
 *  shipped card from the same day and joins the list otherwise. A file with
 *  another currency, a negative rate, or a card missing a rate or `source`
 *  is ignored whole. */
function merged(text) {
  const models = {};
  for (const [id, cards] of Object.entries(SHIPPED.models)) models[id] = cards.map((c) => ({ ...c, origin: 'shipped' }));
  const state = { path: 'data/' + OVERRIDE, present: text != null, checked: null, error: null };
  if (text != null) {
    let doc = null;
    try { doc = JSON.parse(text); } catch (e) { state.error = 'expected value at line 1'; }
    const bad = doc && Object.entries(doc.models || {}).find(([, cards]) => cards.some((c) =>
      !c.source || ['uncached_in', 'cache_write', 'cache_read', 'out'].some((k) => typeof c[k] !== 'number' || c[k] < 0)));
    if (doc && doc.currency && doc.currency !== 'USD') state.error = 'its currency is ' + doc.currency;
    else if (bad) state.error = `${bad[0]} has a bad card`;
    if (doc && !state.error) {
      state.checked = doc.checked || null;
      for (const [id, cards] of Object.entries(doc.models || {})) {
        const list = models[id] || (models[id] = []);
        for (const c of cards) {
          const i = list.findIndex((o) => (o.from || '') === (c.from || ''));
          if (i >= 0) list.splice(i, 1);
          list.push({ ...c, origin: 'override' });
        }
        list.sort((a, b) => String(a.from || '').localeCompare(String(b.from || '')));
      }
    }
  }
  return { currency: 'USD', checked: state.checked && state.checked > SHIPPED.checked ? state.checked : SHIPPED.checked,
           unpriced_cache_shares: { read: 0.1, write_5m: 1.25, write_1h: 2 }, models, override: state };
}

/** Boot a fresh copy of the app against an override and settings file the
 *  test controls (null: no file). */
async function boot(first, { readFails = false, settings = null, noTable = false } = {}) {
  const disk = { [OVERRIDE]: first, [SETTINGS]: settings, readFails, gate: null };
  const writes = [];
  const asked = [];
  const toasts = [];
  const sse = {};
  let answer = false;
  const notFound = () => { const e = new Error('HTTP 404'); e.httpCode = 404; return e; };
  global.lucidos = {
    apiUrl: (s) => '/dev/api/v1' + (s.startsWith('/') ? s : '/' + s),
    ui: { applyPreferences() {}, watchPreferences() {}, enhanceSelects() {}, toast: (m) => toasts.push(m),
          confirm: async (o) => { asked.push(o); return answer; },
          Select: { create: (o) => ({ element: mkEl('sel'), getValue: () => o.value, setValue() {}, setOptions() {}, destroy() {} }) } },
    priceTable: { get: async () => merged(disk.readFails ? null : disk[OVERRIDE]) },
    data: {
      read: async (p) => {
        if (p === OVERRIDE || p === SETTINGS) {
          if (disk.readFails && p === OVERRIDE) { const e = new Error('HTTP 500'); e.httpCode = 500; throw e; }
          if (disk[p] === null) throw notFound();
          return disk[p];
        }
        if (p.includes('ui-state')) return '{}';
        return JSON.stringify({ days: {}, hours: {}, last_sequence: 0 });
      },
      write: async (p, c) => {
        if (p !== OVERRIDE && p !== SETTINGS) return { success: true };
        if (disk.gate) await disk.gate;
        writes.push({ p, c }); disk[p] = c; return { success: true };
      },
      url: (p) => '/dev/data/' + p,
    },
    events: { query: async () => [] }, request: async () => [],
    sse: { connect() {}, on(name, fn) { sse[name] = fn; } },
    utils: { escapeHtml: (s) => String(s), escapeHtmlAttr: (s) => String(s), timeAgo: () => '1m ago' },
  };
  if (noTable) delete global.lucidos.priceTable;
  global.window.lucidos = global.lucidos;
  timers = [];
  new Function(src + `;globalThis.__tc = { markDirty, saveNow, flushSave, renderSettings, rateFor, touchCard,
    get draft(){ return draft; }, get dirty(){ return dirty; }, get pricing(){ return pricing; } };`)();
  await settle();
  const tc = globalThis.__tc;
  tc.renderSettings();
  const of = (p) => writes.filter((w) => w.p === p);
  /** Change one rate on a model's card the way the Settings field does. */
  const editRate = (id, key, v, i = 0) => {
    const cards = tc.draft.models[id] || (tc.draft.models[id] = [{ origin: 'override' }]);
    cards[i][key] = v;
    tc.touchCard(cards, cards[i]);
    tc.markDirty();
  };
  return { tc, disk, writes, asked, toasts, sse, editRate, setAnswer: (a) => { answer = a; },
    overrideWrites: () => of(OVERRIDE), settingsWrites: () => of(SETTINGS),
    written: (p = OVERRIDE) => { const w = of(p); return w.length ? JSON.parse(w[w.length - 1].c) : null; } };
}

console.log('\n1. an edit typed while a save is in flight is saved after it');
{
  const t = await boot(override({ 'acme-1': ACME }));
  let release;
  t.disk.gate = new Promise((r) => { release = r; });
  t.editRate('claude-opus-5', 'out', 30);
  await runTimers();                      // the first save starts and blocks
  t.editRate('gpt-6.1-sol', 'out', 12);
  await runTimers();                      // its debounce fires mid-write
  t.disk.gate = null;
  release();
  await settle();
  ok(t.overrideWrites().length === 1 && !('gpt-6.1-sol' in t.written().models), 'the first write holds only the first edit');
  ok(t.tc.dirty === true, 'and the tab is still dirty, not "Saved"');
  await runTimers();
  ok(t.overrideWrites().length === 2 && t.written().models['gpt-6.1-sol']?.[0]?.out === 12 &&
     t.written().models['claude-opus-5']?.[0]?.out === 30, 'the second edit is written next, with the first');
  ok(t.tc.dirty === false, 'and only then is the tab clean');
}

console.log('\n2. a price edit writes an override card, never the shipped one');
{
  const t = await boot(override({ 'acme-1': ACME }, { _hand: 'a field the app does not know' }));
  ok(t.tc.draft.models['claude-opus-5'][0].origin === 'shipped' && t.tc.draft.models['acme-1'][0].origin === 'override',
     'each card shows where it comes from');
  t.editRate('claude-opus-5', 'out', 30);
  await runTimers();
  const w = t.written();
  const opus = w.models['claude-opus-5'];
  ok(opus.length === 1 && opus[0].out === 30 && opus[0].cache_write_1h === 10 && opus[0].source === 'shipped opus',
     'the edited card lands whole, its 1-hour write and source carried along');
  ok(!('origin' in opus[0]), 'and without an origin field');
  ok(!('gpt-6.1-sol' in w.models), 'an untouched shipped model stays out of the override');
  ok(JSON.stringify(w.models['acme-1']) === JSON.stringify(ACME), 'an untouched override model is kept exactly, fields the app does not know included');
  ok(w.checked === '2026-10-19' && w.sources.openai && w.failures.openai.count === 0 && w._hand,
     'checked, sources, failures and any other field are carried through');
  ok(t.settingsWrites().length === 0, 'and settings.json is not touched');
  ok(t.tc.rateFor('claude-opus-5')?.out === 30, 'the dashboard prices from the edit');
  ok(t.tc.pricing.models['claude-opus-5'][0].origin === 'override', 'and after the engine merges it, the card reads as override');
}

console.log('\n3. the first price edit creates the override, a new model included');
{
  const t = await boot(null);
  t.editRate('acme-new', 'uncached_in', 2);
  await runTimers();
  const w = t.written();
  ok(w && w.currency === 'USD' && w.models['acme-new'][0].uncached_in === 2 && w.models['acme-new'][0].out === 0,
     'it is written with the table\'s currency and all four rates');
  ok(/Set by hand in Token Cost/.test(w.models['acme-new'][0].source), 'and a source, which Lucidos requires');
  ok(t.tc.rateFor('acme-new')?.uncached_in === 2, 'the engine takes it');
}

console.log('\n4. producer labels and exchange rates go to settings.json');
{
  const t = await boot(override({ 'acme-1': ACME }), { settings: JSON.stringify({ producers: { main_llm: 'Agent' }, fx: { rates: { NOK: 10 } } }) });
  ok(t.tc.pricing.producers.main_llm === 'Agent' && t.tc.pricing.fx.rates.NOK === 10, 'they load from settings.json');
  t.tc.draft.producers.codex = 'Codex CLI';
  t.tc.draft.fx.rates.EUR = 0.9;
  t.tc.markDirty();
  await runTimers();
  const w = t.written(SETTINGS);
  ok(w && w.producers.codex === 'Codex CLI' && w.fx.rates.EUR === 0.9 && w.fx.rates.NOK === 10, 'an edit is written there');
  ok(t.overrideWrites().length === 0, 'and the override is not rewritten for it');
  ok(!('long_context_multiplier' in w) && !('models' in w), 'settings.json holds no prices and no multiplier');
}

console.log('\n5. a newer override is never overwritten without asking');
{
  const t = await boot(override({ 'acme-1': ACME }));
  // The price check writes a new card while this tab still holds the old file.
  t.disk[OVERRIDE] = override({ 'acme-1': ACME, 'gpt-6.1-sol': [{ uncached_in: 3, cache_write: 3.75, cache_read: 0.3, out: 15, source: 'check' }] });
  t.editRate('claude-opus-5', 'out', 30);
  t.setAnswer(false);                     // Reload
  await runTimers();
  ok(t.asked.length === 1, 'the save asks first');
  ok(t.writes.length === 0, 'and Reload writes nothing');
  ok(t.tc.rateFor('gpt-6.1-sol')?.out === 15, 'the dashboard takes the newer file');
  ok(t.tc.dirty === false && t.tc.draft.models['claude-opus-5'][0].out === 25, 'and Settings shows it, the unsaved edit dropped');

  const u = await boot(override({ 'acme-1': ACME }));
  u.disk[OVERRIDE] = override({ 'acme-1': ACME, 'gpt-6.1-sol': [{ uncached_in: 3, cache_write: 3.75, cache_read: 0.3, out: 15, source: 'check' }] });
  u.editRate('claude-opus-5', 'out', 30);
  u.setAnswer(true);                      // Overwrite
  await runTimers();
  ok(u.overrideWrites().length === 1 && u.written().models['claude-opus-5'][0].out === 30,
     'Overwrite writes this tab\'s version, as asked');
  ok(u.tc.dirty === false, 'and the tab is clean');
}

console.log('\n6. a clean tab follows an override written elsewhere');
{
  const t = await boot(override({ 'acme-1': ACME }));
  t.disk[OVERRIDE] = override({ 'acme-1': ACME, 'gpt-6.1-sol': [{ uncached_in: 3, cache_write: 3.75, cache_read: 0.3, out: 15, source: 'check' }] });
  t.sse.DataFileWritten({ path: 'data/' + OVERRIDE });
  await settle();
  ok(t.tc.rateFor('gpt-6.1-sol')?.out === 15, 'the dashboard prices from the new file');
  ok(t.tc.draft.models['gpt-6.1-sol'][0].origin === 'override', 'Settings shows it as an override card');
  t.editRate('claude-opus-5', 'out', 30);
  await runTimers();
  ok(t.asked.length === 0 && t.writes.length === 1, 'the next edit saves without a question');
  ok('gpt-6.1-sol' in t.written().models, 'and keeps the other writer\'s card');
  // Its own write comes back as the same event, and must change nothing.
  t.sse.DataFileWritten({ path: OVERRIDE });
  await settle();
  ok(t.asked.length === 0 && t.tc.dirty === false && t.tc.rateFor('claude-opus-5')?.out === 30, 'its own write echoing back is a no-op');
  // The same JSON with other whitespace is the same file.
  t.disk[OVERRIDE] = JSON.stringify(JSON.parse(t.disk[OVERRIDE]));
  t.editRate('claude-opus-5', 'out', 31);
  await runTimers();
  ok(t.asked.length === 0 && t.written().models['claude-opus-5'][0].out === 31, 'a reformatted but equal file is no conflict');
}

console.log('\n7. an override Lucidos ignores is never written over');
{
  const broken = override({ 'acme-1': [{ uncached_in: -1, cache_write: 0, cache_read: 0, out: 1, source: 'typo' }] });
  const t = await boot(broken);
  ok(t.tc.rateFor('acme-1') === null && t.tc.rateFor('claude-opus-5')?.out === 25, 'only the shipped cards count');
  ok(t.toasts.some((m) => /ignoring config\/model-prices\.json/.test(m)), 'and the app says so');
  t.editRate('claude-opus-5', 'out', 30);
  await runTimers();
  ok(t.overrideWrites().length === 0 && t.disk[OVERRIDE] === broken, 'a price edit writes nothing over it');
  ok(t.tc.dirty === true, 'and stays unsaved');
  t.tc.draft.producers.codex = 'Codex CLI';
  t.tc.markDirty();
  await runTimers();
  ok(t.overrideWrites().length === 0, 'a settings edit does not write it either');
  ok(t.written(SETTINGS)?.producers.codex === 'Codex CLI', 'but the settings edit itself still saves');
  ok(t.tc.rateFor('claude-opus-5')?.out === 25 && t.tc.dirty === true, 'and the blocked price edit stays unsaved and unpriced');
}

console.log('\n8. a negative rate is refused, never written');
{
  const t = await boot(override({ 'acme-1': ACME }));
  t.editRate('claude-opus-5', 'out', -3);
  await runTimers();
  ok(t.writes.length === 0 && t.toasts.some((m) => /negative rate/.test(m)), 'nothing is written, and the app says why');
}

console.log('\n9. a tab that could not read the override never writes over it blind');
{
  const t = await boot(override({ 'acme-1': ACME }), { readFails: true });
  ok(t.tc.rateFor('acme-1') === null, 'an unreadable override prices none of its cards');
  t.disk.readFails = false;
  t.tc.draft.producers.codex = 'Codex CLI';
  t.tc.markDirty();
  await runTimers();
  ok(t.overrideWrites().length === 0, 'a settings edit leaves it alone');
  t.editRate('claude-opus-5', 'out', 30);
  t.setAnswer(false);
  await runTimers();
  ok(t.asked.length === 1 && t.overrideWrites().length === 0, 'a price edit finds the file and asks, writing nothing');
  ok(t.tc.rateFor('acme-1')?.out === 4, 'Reload then prices from it');
}

console.log('\n10. a broken override is not overwritten unasked');
{
  const t = await boot('{"models": {"acme-1": ');
  ok(t.tc.rateFor('claude-opus-5')?.out === 25, 'the shipped cards still price');
  t.editRate('claude-opus-5', 'out', 30);
  await runTimers();
  ok(t.overrideWrites().length === 0, 'a save writes nothing over it');
}

console.log('\n11. a timer left over from before a Reload writes nothing');
{
  const t = await boot(override({ 'acme-1': ACME }));
  t.disk[OVERRIDE] = override({ 'acme-1': ACME, 'gpt-6.1-sol': [{ uncached_in: 3, cache_write: 3.75, cache_read: 0.3, out: 15, source: 'check' }] });
  t.editRate('claude-opus-5', 'out', 30);
  t.setAnswer(false);
  await runTimers();
  await t.tc.saveNow();
  ok(t.writes.length === 0, 'saveNow with nothing unsaved writes nothing');
}

console.log('\n12. an older Lucidos with no price table prices nothing, and says why');
{
  const t = await boot(override({ 'acme-1': ACME }), { noTable: true });
  ok(t.tc.rateFor('claude-opus-5') === null && t.tc.rateFor('acme-1') === null, 'every model is unpriced, never guessed');
  ok(t.toasts.some((m) => /price table/.test(m)), 'and the app says it could not read the price table');
  t.editRate('claude-opus-5', 'out', 30);
  await runTimers();
  ok(t.overrideWrites().length === 0, 'and a price edit writes nothing');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
