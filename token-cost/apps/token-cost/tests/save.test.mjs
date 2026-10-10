// Saving pricing.json from Settings, found in the 2026-10-10 hardening pass:
//
//   in flight  an edit typed while a save was being written was marked saved
//              with it and never written
//   stale      a tab held the table it opened with, so its next autosave
//              wrote that old copy over a newer pricing.json (another tab,
//              the phone, a hand edit) and silently undid the change
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
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };
const runTimers = async () => { const t = timers; timers = []; t.forEach((f) => f()); await settle(); };

const table = (models) => JSON.stringify({ currency: 'USD', models,
  long_context_multiplier: { threshold_tokens: 200000, in_multiplier: 1, out_multiplier: 1 },
  producers: { main_llm: 'Lucidos Agent' }, fx: { rates: { USD: 1 } } }, null, 2);
const OPUS = [{ uncached_in: 5, cache_write: 6.25, cache_read: 0.5, out: 25 }];

/** Boot a fresh copy of the app against a pricing.json the test controls. */
async function boot(first, { readFails = false } = {}) {
  const disk = { text: first, readFails, gate: null };
  const writes = [];
  const asked = [];
  const sse = {};
  let answer = false;
  global.lucidos = {
    apiUrl: (s) => '/dev/api/v1' + (s.startsWith('/') ? s : '/' + s),
    ui: { applyPreferences() {}, watchPreferences() {}, enhanceSelects() {}, toast() {},
          confirm: async (o) => { asked.push(o); return answer; },
          Select: { create: (o) => ({ element: mkEl('sel'), getValue: () => o.value, setValue() {}, setOptions() {}, destroy() {} }) } },
    data: {
      read: async (p) => {
        if (p.includes('pricing')) {
          if (disk.readFails) { const e = new Error('HTTP 500'); e.httpCode = 500; throw e; }
          if (disk.text === null) { const e = new Error('HTTP 404'); e.httpCode = 404; throw e; }
          return disk.text;
        }
        if (p.includes('ui-state')) return '{}';
        return JSON.stringify({ days: {}, hours: {}, last_sequence: 0 });
      },
      write: async (p, c) => {
        if (!p.includes('pricing')) return { success: true };
        if (disk.gate) await disk.gate;
        writes.push(c); disk.text = c; return { success: true };
      },
      url: (p) => '/dev/data/' + p,
    },
    events: { query: async () => [] }, request: async () => [],
    sse: { connect() {}, on(name, fn) { sse[name] = fn; } },
    utils: { escapeHtml: (s) => String(s), escapeHtmlAttr: (s) => String(s), timeAgo: () => '1m ago' },
  };
  global.window.lucidos = global.lucidos;
  timers = [];
  new Function(src + `;globalThis.__tc = { markDirty, saveNow, flushSave, renderSettings, rateFor,
    get draft(){ return draft; }, get dirty(){ return dirty; }, get pricing(){ return pricing; } };`)();
  await settle();
  const tc = globalThis.__tc;
  tc.renderSettings();
  return { tc, disk, writes, asked, sse, setAnswer: (a) => { answer = a; },
    written: () => (writes.length ? JSON.parse(writes[writes.length - 1]) : null) };
}

console.log('\n1. an edit typed while a save is in flight is saved after it');
{
  const t = await boot(table({ 'claude-opus-5': OPUS }));
  let release;
  t.disk.gate = new Promise((r) => { release = r; });
  t.tc.draft.currency = 'EUR';
  t.tc.markDirty();
  await runTimers();                      // the first save starts and blocks
  t.tc.draft.models['acme-1'] = [{ uncached_in: 1 }];
  t.tc.markDirty();
  await runTimers();                      // its debounce fires mid-write
  t.disk.gate = null;
  release();
  await settle();
  ok(t.writes.length === 1 && !('acme-1' in t.written().models), 'the first write holds only the first edit');
  ok(t.tc.dirty === true, 'and the tab is still dirty, not "Saved"');
  await runTimers();
  ok(t.writes.length === 2 && 'acme-1' in t.written().models && t.written().currency === 'EUR',
     'the second edit is written next, with the first');
  ok(t.tc.dirty === false, 'and only then is the tab clean');
}

console.log('\n2. a newer pricing.json is never overwritten without asking');
{
  const t = await boot(table({ 'claude-opus-5': OPUS }));
  // The phone saves a new model while this tab still holds the old table.
  t.disk.text = table({ 'claude-opus-5': OPUS, 'gpt-6.1-sol': [{ uncached_in: 2, out: 10 }] });
  t.tc.draft.currency = 'NOK';
  t.tc.markDirty();
  t.setAnswer(false);                     // Reload
  await runTimers();
  ok(t.asked.length === 1, 'the save asks first');
  ok(t.writes.length === 0, 'and Reload writes nothing');
  ok(t.tc.rateFor('gpt-6.1-sol')?.out === 10, 'the dashboard takes the newer file');
  ok(t.tc.dirty === false && 'gpt-6.1-sol' in t.tc.draft.models && t.tc.draft.currency === 'USD',
     'and Settings shows it, the unsaved edit dropped');

  const u = await boot(table({ 'claude-opus-5': OPUS }));
  u.disk.text = table({ 'claude-opus-5': OPUS, 'gpt-6.1-sol': [{ uncached_in: 2, out: 10 }] });
  u.tc.draft.currency = 'NOK';
  u.tc.markDirty();
  u.setAnswer(true);                      // Overwrite
  await runTimers();
  ok(u.writes.length === 1 && u.written().currency === 'NOK' && !('gpt-6.1-sol' in u.written().models),
     'Overwrite writes this tab\'s version, as asked');
  ok(u.tc.dirty === false, 'and the tab is clean');
}

console.log('\n3. a clean tab follows a pricing.json written elsewhere');
{
  const t = await boot(table({ 'claude-opus-5': OPUS }));
  t.disk.text = table({ 'claude-opus-5': OPUS, 'gpt-6.1-sol': [{ uncached_in: 2, out: 10 }] });
  t.sse.DataFileWritten({ path: 'artifacts/token-cost/pricing.json' });
  await settle();
  ok(t.tc.rateFor('gpt-6.1-sol')?.out === 10, 'the dashboard prices from the new file');
  ok('gpt-6.1-sol' in t.tc.draft.models, 'Settings shows it');
  t.tc.draft.currency = 'EUR';
  t.tc.markDirty();
  await runTimers();
  ok(t.asked.length === 0 && t.writes.length === 1, 'the next edit saves without a question');
  ok('gpt-6.1-sol' in t.written().models, 'and keeps the other writer\'s model');
  // Its own write comes back as the same event, and must change nothing.
  t.sse.DataFileWritten({ path: 'artifacts/token-cost/pricing.json' });
  await settle();
  ok(t.asked.length === 0 && t.tc.dirty === false && t.tc.draft.currency === 'EUR', 'its own write echoing back is a no-op');
  // The same JSON with other whitespace is the same file.
  t.disk.text = JSON.stringify(JSON.parse(t.disk.text));
  t.tc.draft.currency = 'SEK';
  t.tc.markDirty();
  await runTimers();
  ok(t.asked.length === 0 && t.written().currency === 'SEK', 'a reformatted but equal file is no conflict');
}

console.log('\n4. a tab that could not read pricing.json never writes over it blind');
{
  const t = await boot(table({ 'claude-opus-5': OPUS }), { readFails: true });
  ok(t.tc.rateFor('claude-opus-5') === null, 'an unreadable file prices nothing for now');
  t.disk.readFails = false;
  t.tc.draft.currency = 'EUR';
  t.tc.markDirty();
  t.setAnswer(false);
  await runTimers();
  ok(t.asked.length === 1 && t.writes.length === 0, 'the first save finds the file and asks, writing nothing');
  ok(t.tc.rateFor('claude-opus-5')?.out === 25, 'Reload then prices from it');
}

console.log('\n5. a broken pricing.json is not overwritten with the empty fallback unasked');
{
  const t = await boot('{"models": {"claude-opus-5": ');
  ok(t.tc.rateFor('claude-opus-5') === null, 'a broken file prices nothing');
  t.tc.draft.currency = 'EUR';
  t.tc.markDirty();
  t.setAnswer(false);
  await runTimers();
  ok(t.asked.length === 1 && t.writes.length === 0, 'a save asks before writing over it');
}

console.log('\n6. a timer left over from before a Reload writes nothing');
{
  const t = await boot(table({ 'claude-opus-5': OPUS }));
  t.disk.text = table({ 'claude-opus-5': OPUS, 'gpt-6.1-sol': [{ uncached_in: 2, out: 10 }] });
  t.tc.draft.currency = 'NOK';
  t.tc.markDirty();
  t.setAnswer(false);
  await runTimers();
  await t.tc.saveNow();
  ok(t.writes.length === 0, 'saveNow with nothing unsaved writes nothing');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
