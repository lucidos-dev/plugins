// Defaults, and a fix from 2026-10-02 that failed only inside the real app frame:
//
//   rows    Lucidos's price table is the only price table. The app carries
//           no prices, so a model the table lacks is unpriced rather than
//           wrong, and opening the app never writes a file.
//   sounds  an app frame has an opaque origin, so fetch() of the app's own
//           sounds/*.m4a failed ("Failed to fetch"). Built-ins now decode from
//           the bundled base64 copy; an uploaded clip falls back to <audio>.
import fs from 'fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const src = html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/)[1];
const soundsJs = fs.readFileSync(new URL('../sounds/sounds.js', import.meta.url), 'utf8');

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
    querySelector(sel){ if(sel && sel.includes('empty-state')) return this._emptied?null:(this._emptied=true,mkEl('empty'));
      this._q = this._q || {}; if(!this._q[sel]) this._q[sel]=mkEl('q'); return this._q[sel]; }, querySelectorAll(){return [];}, get firstChild(){return this.children[0]||null;},
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
global.setTimeout = (f)=>{ return 0; };
global.clearTimeout = ()=>{};
global.fetch = async () => ({ ok:true, json: async()=>[] });
global.URL = URL;
global.Intl = Intl;


let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.log('  FAIL ' + m); } };
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };

/** Boot a fresh copy of the app against a price table (null: an older
 *  Lucidos with none) and no override or settings file. */
async function boot(table) {
  const writes = [];
  global.lucidos = {
    apiUrl: (s) => '/dev/api/v1' + (s.startsWith('/') ? s : '/' + s),
    ui: { applyPreferences() {}, watchPreferences() {}, enhanceSelects() {}, toast() {},
          Select: { create: (o) => ({ element: mkEl('sel'), getValue: () => o.value, setValue() {}, setOptions() {}, destroy() {} }) } },
    ...(table ? { priceTable: { get: async () => JSON.parse(JSON.stringify(table)) } } : {}),
    data: {
      read: async (p) => {
        if (p.includes('model-prices') || p.includes('settings.json')) { const e = new Error('HTTP 404'); e.httpCode = 404; throw e; }
        if (p.includes('ui-state')) return '{}';
        return JSON.stringify({ days: {}, hours: {}, last_sequence: 0 });
      },
      write: async (p, c) => { writes.push({ p, c }); return { success: true }; },
      url: (p) => '/dev/data/' + p,
    },
    events: { query: async () => [] }, request: async () => [],
    sse: { connect() {}, on() {} },
    utils: { escapeHtml: (s) => String(s), escapeHtmlAttr: (s) => String(s), timeAgo: () => '1m ago' },
  };
  global.window.lucidos = global.lucidos;
  new Function(src + ';globalThis.__tc = { loadSound, DEFAULT_SETTINGS, rateFor, get pricing(){ return pricing; } };')();
  await settle();
  return { tc: globalThis.__tc, writes: writes.filter((w) => !w.p.includes('ui-state')) };
}

console.log('\n1. the app carries no prices of its own');
{
  // The price table is the one price table. A second copy in the app drifted
  // from it and had to be edited in step with every provider change.
  const { tc } = await boot(null);
  ok(!('models' in tc.DEFAULT_SETTINGS), 'DEFAULT_SETTINGS holds no models');
  ok(!/uncached_in:\s*\d/.test(html.slice(html.indexOf('const DEFAULT_SETTINGS'), html.indexOf('const CURRENCY_NAMES'))),
     'and no rate appears anywhere in the built-in block');
  ok(!/pricing\.json/.test(html), 'and the app never names the old pricing.json');
}

const TABLE = { currency: 'USD', checked: '2026-10-16', unpriced_cache_shares: { read: 0.1, write_5m: 1.25, write_1h: 2 },
  override: { path: 'data/config/model-prices.json', present: false, checked: null, error: null },
  models: {
    'claude-opus-5': [{ uncached_in: 5, cache_write: 6.25, cache_write_1h: 10, cache_read: 0.5, out: 25, source: 's', origin: 'shipped' }],
    'gemini-3.8-flash': [
      { uncached_in: 0.75, cache_write: 0.75, cache_read: 0.075, out: 3.75, source: 's', origin: 'shipped' },
      { from: '2027-01-01', uncached_in: 1.5, cache_write: 1.5, cache_read: 0.15, out: 7.5, source: 's', origin: 'shipped' } ],
  } };

console.log('\n2. an older Lucidos with no price table is unpriced, not an error');
{
  const { tc, writes } = await boot(null);
  ok(writes.length === 0, 'nothing is written on open: ' + writes.length);
  ok(tc.rateFor('claude-opus-5') === null, 'a model has no price until the table loads');
  ok(tc.pricing.producers.main_llm === 'Lucidos Agent', 'the producer labels still load');
}

console.log('\n3. the price table is read as it is, and opening the app writes nothing');
{
  const { tc, writes } = await boot(TABLE);
  ok(writes.length === 0, 'no file is written on open: ' + writes.length);
  ok(tc.rateFor('claude-opus-5')?.out === 25, 'a shipped card prices the model');
  ok(tc.rateFor('gemini-3.8-flash', '2026-12-31')?.out === 3.75 && tc.rateFor('gemini-3.8-flash', '2027-01-01')?.out === 7.5,
     'and each day reads its own card');
  ok(tc.rateFor('anthropic/claude-opus-5[1m]')?.out === 25, 'the app\'s own id normalisation runs over the merged models');
  ok(tc.rateFor('acme-mystery-7b') === null, 'a model the table lacks is unpriced');
  ok(tc.pricing.currency === 'USD' && tc.pricing.checked === '2026-10-16', 'the table\'s currency and checked day are read');
}

console.log('\n4. a built-in sound decodes from the bundled copy, never fetch');
{
  new Function(soundsJs.replace('window.TC_SOUND_DATA', 'globalThis.window.TC_SOUND_DATA'))();
  const { tc } = await boot(null);
  let fetched = 0;
  global.fetch = async () => { fetched++; throw new TypeError('Failed to fetch'); };
  const ac = { decodeAudioData: (b, res) => res({ bytes: b.byteLength }) };
  for (const f of ['arcade.m4a', 'register.m4a', 'coinbox.m4a']) {
    const want = fs.statSync(new URL('../sounds/' + f, import.meta.url)).size;
    const buf = await tc.loadSound(ac, '/dev/app/token-cost/sounds/' + f, f).catch((e) => ({ err: e.message }));
    ok(buf.bytes === want, `${f} decodes from sounds.js at its real size (${buf.bytes ?? buf.err} of ${want} bytes)`);
  }
  ok(fetched === 0, 'and the refused fetch is never tried');
}

console.log('\n5. an uploaded clip the frame cannot fetch plays through <audio>');
{
  const { tc } = await boot(null);
  global.fetch = async () => { throw new TypeError('Failed to fetch'); };
  global.Audio = class { constructor() { this.l = {}; } addEventListener(t, f) { this.l[t] = f; }
    load() { setImmediate(() => this.l.canplaythrough && this.l.canplaythrough()); } };
  const ac = { decodeAudioData: () => { throw new Error('not reached'); } };
  const got = await tc.loadSound(ac, '/dev/data/artifacts/imported/ding.mp3').catch((e) => ({ err: e.message }));
  ok(got.element === '/dev/data/artifacts/imported/ding.mp3', 'it resolves to the element path: ' + JSON.stringify(got));
  global.Audio = class { constructor() { this.l = {}; } addEventListener(t, f) { this.l[t] = f; }
    load() { setImmediate(() => this.l.error && this.l.error()); } };
  const bad = await tc.loadSound(ac, '/dev/data/artifacts/imported/bad.xyz').then(() => null, (e) => e.message);
  ok(/cannot play/.test(bad || ''), 'a clip the browser cannot play still fails at load: ' + bad);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
