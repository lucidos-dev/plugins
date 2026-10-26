import fs from 'fs';
import path from 'path';
// The app under test is the one beside this file, not the workspace's live
// copy: run from a worktree, the live copy is the code BEFORE the change.
const html = fs.readFileSync(new URL('../index.html', import.meta.url),'utf8');
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

const daily = { generated: new Date().toISOString(), last_sequence: 100,
  bucket_edges: [0, 32000, 64000, 128000, 200000, 400000], days: {}, hours: {} };
// The price table as lucidos.priceTable.get() returns it: the cards Lucidos
// shipped on 2026-10-16 merged with this workspace's migrated override.
const priceTableRaw = fs.readFileSync(new URL('./fixtures/price-table.json', import.meta.url),'utf8');

const selects = [];
global.lucidos = {
  // Both engine calls go over the SDK bridge: the pager through
  // lucidos.events.query and /models through lucidos.request. An app frame
  // runs at an opaque origin, so its own fetch of the engine is CORS-refused.
  apiUrl: (s) => '/dev/api/v1' + (s.startsWith('/') ? s : '/' + s),
  ui:{ applyPreferences(){}, watchPreferences(){}, enhanceSelects(){}, toast(){},
       Select:{ create:(o)=>{ const sel={ element:mkEl('sel'), options:o.options, value:o.value, getValue:()=>sel.value,
         setValue(v){ sel.value=v; }, setOptions(x){ sel.options=x; }, destroy(){} }; selects.push(sel); return sel; } } },
  priceTable:{ get: async () => JSON.parse(priceTableRaw) },
  data:{ read: async (p)=> p.includes('model-prices') || p.includes('settings.json') ? Promise.reject(Object.assign(new Error('HTTP 404'), { httpCode: 404 })) : p.includes('ui-state') ? '{}' : JSON.stringify(daily), write: async()=>({success:true}), url:(p)=> p.startsWith('system-knowhow/') ? '/dev/api/v1/data/'+p : '/dev/data/'+p },
  // The pager goes through lucidos.events.query; stubbed empty here because
  // these tests drive the accounting directly via pushLive. `/models` goes
  // through the generic bridged call, which has no labels to give.
  events:{ query: async () => [] }, request: async () => [],
  threads:{ list: async () => [] },
  sse:{ connect(){}, on(){} },
  // As the SDK has them: the text escape leaves quotes raw, the attribute
  // escape does not, so a test can tell which one an attribute used.
  utils:{ escapeHtml:(s)=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'), escapeHtmlAttr:(s)=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'), timeAgo:()=>'1m ago' },
};

// expose internals for assertions
const harness = src + `
;globalThis.__tc = {
  pushLive, render, get live(){return live;}, countedLive, get seenSeq(){return seenSeq;},
  seriesForDay, selectedDays, knownDays, localDay, costOf, longThreshold, isLongCall, rateFor, dayZoneLabel,
  cardOn, cardsOf, overrideModels, checkFrom, servedAsSent, pricedModel, rowModel, modelName, loadModelLabels,
  setDaily(d){ daily = d; }, setPricing(p){ pricing = p; },
  setGroups(g){ groups = g; expanded.clear(); }, expand(p){ expanded.add(p); }, threadMeta,
  setThreads(t){ threadsDaily = t; threadsState = t ? 'ready' : 'missing'; },
  setHandoffs(d){ handoffsDoc = d; handoffsState = d ? 'ready' : 'missing'; }, measureHandoff, handoffOpen,
  priceCacheCall, priceCacheSaving, cacheRows, renderCacheStats, loadCacheStats,
  writeBundle, costParts, foldCall, rowToU,
  setCache(d){ cacheDoc = d; cacheState = d ? 'ready' : 'missing'; },
  get daily(){ return daily; },
  get metaText(){ return document.getElementById('meta').textContent; },
  noteKeepAliveAnchor, dimLabel, producerLabel, typeParent, dims: DIMS, producerMatches, syncProducerFilter, pickDim, chooseDim, oneOfEachFamily,
  noteThreadOrigins, originOfSummary, learnThreadOrigins, lookupOrigins, threadOrigins, resetOrigins(){ threadOrigins.clear(); originAsked.clear(); originLookupAt = 0; },
  resetLive(){ live=[]; seenSeq=new Set(); liveRevision++; }, get feedRows(){ return document.getElementById('feed').children.map(c=>c.dataset.at); }, renderFeed,
};
`;
new Function(harness)();
global.window.lucidos = global.lucidos;
const tc = globalThis.__tc;

// wait for load()'s awaits to settle
await new Promise(r=>setImmediate(r));
await new Promise(r=>setImmediate(r));
await new Promise(r=>setImmediate(r));

let pass=0, fail=0;
const ok=(c,m)=>{ if(c){pass++;console.log('  ok  '+m);} else {fail++;console.log('  FAIL '+m);} };

const cursor = tc.daily.last_sequence;
const mk=(seq,at,producer,model,u)=>({ seq, created:at, thread_id:'t1',
  event:{type:'ContextCaptured',model,producer,usage:{input_tokens:u[0],cache_read_tokens:u[1],cache_creation_tokens:u[2],cache_creation_1h_tokens:0,output_tokens:u[3]}}});

console.log('\n1. SSE and catch-up racing over the same call');
tc.pushLive(mk(cursor+10,'2026-08-13T14:10:00Z','main_llm','claude-opus-5',[1000,500,100,200]));
const n1 = tc.countedLive().length;
tc.pushLive(mk(cursor+10,'2026-08-13T14:10:00Z','main_llm','claude-opus-5',[1000,500,100,200]), {quiet:true});
ok(tc.countedLive().length===n1, 'same sequence delivered twice counts once');

console.log('\n2. a row the rollup already absorbed is rejected');
const n2=tc.countedLive().length;
tc.pushLive(mk(cursor-5,'2026-08-13T13:00:00Z','main_llm','claude-opus-5',[1,1,1,1]));
ok(tc.countedLive().length===n2, 'seq below the cursor is not double counted');

console.log('\n3. claude_code frame dedupe still collapses repeats');
const n3=tc.countedLive().length;
tc.pushLive(mk(cursor+20,'2026-08-13T14:11:00Z','claude_code','claude-opus-5',[900,800,50,60]));
tc.pushLive(mk(cursor+21,'2026-08-13T14:11:01Z','claude_code','claude-opus-5',[900,800,50,60]));
ok(tc.countedLive().length===n3+1, 'a repeated usage tuple on one thread is one call');
tc.pushLive(mk(cursor+22,'2026-08-13T14:11:02Z','claude_code','claude-opus-5',[901,800,50,60]));
ok(tc.countedLive().length===n3+2, 'a different tuple after it still counts');

console.log('\n4. an out-of-order catch-up row cannot resurrect a collapsed duplicate');
const n4=tc.countedLive().length;
tc.pushLive(mk(cursor+19,'2026-08-13T14:10:59Z','claude_code','claude-opus-5',[900,800,50,60]),{quiet:true});
ok(tc.countedLive().length===n4, 'an older duplicate arriving late is still dropped');

console.log('\n5. codex is never collapsed');
const n5=tc.countedLive().length;
tc.pushLive(mk(cursor+30,'2026-08-13T14:12:00Z','codex','gpt-5.5',[100,0,0,10]));
tc.pushLive(mk(cursor+31,'2026-08-13T14:12:01Z','codex','gpt-5.5',[100,0,0,10]));
ok(tc.countedLive().length===n5+2, 'two identical codex calls both count');

console.log('\n6. feed rows are newest first by timestamp');
tc.renderFeed(); const rows = tc.feedRows;
const sorted = [...rows].sort().reverse();
ok(JSON.stringify(rows)===JSON.stringify(sorted), 'feed order is descending by time: '+rows.slice(0,3).join(' '));

console.log('\n7. today is always a column');
const today = tc.localDay(new Date());
ok(tc.knownDays().includes(today), 'knownDays contains today');
const empty = {generated:new Date().toISOString(), last_sequence:0, bucket_edges:[0,32000,64000,128000,200000,400000], days:{}, hours:{}};
tc.setDaily(empty);
ok(tc.knownDays().length>=1 && tc.knownDays().includes(today), 'an empty rollup still yields today');

console.log('\n8. a live call folds into its own day, not only today');
tc.setDaily({...empty, days:{}});
tc.resetLive();
// Midday yesterday local, so the assertion is not about a UTC/local edge.
const yAt = '2026-08-12T10:00:00Z';
tc.pushLive(mk(999001, yAt,'main_llm','claude-opus-5',[1000,0,0,100]),{quiet:true});
const dayOfCall = tc.localDay(new Date(yAt));
const s8 = tc.seriesForDay(dayOfCall);
ok(Object.keys(s8).length===1, 'the call lands in its own day ('+dayOfCall+'), keys='+Object.keys(s8).length);
ok(tc.knownDays().includes(dayOfCall), 'that day is a column');
const todayS = tc.seriesForDay(today);
ok(Object.keys(todayS).length===0, 'and NOT into today');

console.log('\n9. a hole between known rows is filled, not skipped');
tc.setDaily({...empty, days:{}});
// SSE delivered 100 and 103; the stream dropped 101 and 102 in between.
tc.pushLive(mk(100,'2026-08-13T10:00:00Z','main_llm','claude-opus-5',[10,0,0,1]));
tc.pushLive(mk(103,'2026-08-13T10:03:00Z','main_llm','claude-opus-5',[13,0,0,1]));
const before9 = tc.countedLive().length;
// A catch-up pass walks past the known rows and delivers the missing pair.
tc.pushLive(mk(102,'2026-08-13T10:02:00Z','main_llm','claude-opus-5',[12,0,0,1]),{quiet:true});
tc.pushLive(mk(101,'2026-08-13T10:01:00Z','main_llm','claude-opus-5',[11,0,0,1]),{quiet:true});
ok(tc.countedLive().length===before9+2, 'both dropped calls are recovered');
const seqs = tc.countedLive().map(c=>c.seq);
ok(JSON.stringify(seqs)===JSON.stringify([...seqs].sort((a,b)=>a-b)), 'the collapsed view is in sequence order');

console.log('\n10. delivery order does not change the total');
function totalFor(order){
  tc.setDaily({...empty, days:{}});
  tc.resetLive();
  for(const [seq,at,prod,u] of order) tc.pushLive(mk(seq,at,prod,'claude-opus-5',u),{quiet:true});
  return tc.countedLive().length;
}
const calls = [
  [200,'2026-08-13T11:00:00Z','claude_code',[500,400,10,20]],
  [201,'2026-08-13T11:00:01Z','claude_code',[500,400,10,20]],  // re-delivered frame
  [202,'2026-08-13T11:00:05Z','claude_code',[600,400,10,25]],
  [203,'2026-08-13T11:00:09Z','main_llm',[700,0,0,30]],
];
const inOrder = totalFor(calls);
const reversed = totalFor([...calls].reverse());
const shuffled = totalFor([calls[2],calls[0],calls[3],calls[1]]);
ok(inOrder===3, 'in order: 3 priced calls, got '+inOrder);
ok(reversed===inOrder, 'reversed delivery gives the same total, got '+reversed);
ok(shuffled===inOrder, 'shuffled delivery gives the same total, got '+shuffled);

console.log('\n11. a voice model billed by the minute');
tc.setPricing({
  currency:'USD',
  models:{
    'default': { uncached_in:5, cache_write:6.25, cache_read:0.5, out:25 },
    'gpt-live-1': { uncached_in:0, cache_write:0, cache_read:0, out:0, per_minute:0.05 },
    'gpt-5.5': { uncached_in:5, cache_write:0, cache_read:0.5, out:30,
                 long:{ threshold_tokens:272000, uncached_in:10, cache_write:0, cache_read:1, out:45 } },
    'claude-opus-5': { uncached_in:5, cache_write:6.25, cache_read:0.5, out:25 },
  },
  producers:{}, fx:{ rates:{USD:1} },
});
const zeroTokens = { calls:1, in:0, cache_read:0, cache_write:0, out:0, seconds:120,
                     long:{in:0,out:0,cache_read:0,cache_write:0} };
ok(Math.abs(tc.costOf('gpt-live-1', zeroTokens, zeroTokens.long) - 0.10) < 1e-9,
   'two minutes of GPT-Live costs $0.10, not $0.00, got '+tc.costOf('gpt-live-1', zeroTokens, zeroTokens.long));
const noSeconds = { ...zeroTokens, seconds:0 };
ok(tc.costOf('gpt-live-1', noSeconds, noSeconds.long) === 0, 'a session with no duration costs nothing');
// A per-minute card must not also charge for whatever tokens happen to arrive.
const withTokens = { calls:1, in:10000, cache_read:0, cache_write:0, out:5000, seconds:60,
                     long:{in:0,out:0,cache_read:0,cache_write:0} };
ok(Math.abs(tc.costOf('gpt-live-1', withTokens, withTokens.long) - 0.05) < 1e-9,
   'per_minute replaces the token rates rather than adding to them');

console.log('\n12. the long-context tier is the provider\'s, not one global number');
// 240k on GPT-5.5 is under OpenAI's 272k tier, so it is priced at the short rate
// even though it is over the 200k the global multiplier used to split at.
const short240 = { calls:1, in:240000, cache_read:0, cache_write:0, out:1000, seconds:0,
                   long:{in:0,out:0,cache_read:0,cache_write:0} };
const expShort = (240000*5 + 1000*30)/1e6;
ok(Math.abs(tc.costOf('gpt-5.5', short240, short240.long) - expShort) < 1e-9,
   'a 240k GPT-5.5 call is priced short, got '+tc.costOf('gpt-5.5', short240, short240.long).toFixed(4)+' want '+expShort.toFixed(4));
ok(tc.longThreshold('gpt-5.5') === 272000, 'GPT-5.5 splits at 272k, got '+tc.longThreshold('gpt-5.5'));
ok(tc.longThreshold('claude-opus-5[1m]') === 200000, 'a card with no tier splits at 200k');
// Over the tier, every token of the call takes the long rate.
const long300 = { calls:1, in:300000, cache_read:0, cache_write:0, out:1000, seconds:0,
                  long:{in:300000,out:1000,cache_read:0,cache_write:0} };
const expLong = (300000*10 + 1000*45)/1e6;
ok(Math.abs(tc.costOf('gpt-5.5', long300, long300.long) - expLong) < 1e-9,
   'a 300k GPT-5.5 call takes the long card whole, got '+tc.costOf('gpt-5.5', long300, long300.long).toFixed(4));

// --- unpriced models -----------------------------------------------------------
// A gateway's own model ids used to fall to a `default` row holding the Opus 5
// card. That priced an undated Haiku 5x high and looked exactly like a real
// rate, which is how this dashboard read higher than the gateway's ledger.
const OPUS5 = { uncached_in:5, cache_write:6.25, cache_read:0.5, out:25 };
const storedWithDefault = () => ({
  currency:'USD',
  models:{
    'default': OPUS5,
    'claude-opus-5': OPUS5,
    'claude-haiku-4-5-20251001': { uncached_in:1, cache_write:1.25, cache_read:0.1, out:5 },
    'gpt-5.5': { uncached_in:5, cache_write:0, cache_read:0.5, out:30,
                 long:{ threshold_tokens:272000, uncached_in:10, cache_write:0, cache_read:1, out:45 } },
    'x-ai/grok-4.6': { uncached_in:2, cache_write:0, cache_read:0.5, out:6 },
  },
  producers:{}, fx:{ rates:{USD:1} },
});
const oneM = { calls:1, in:1e6, cache_read:0, cache_write:0, out:1e6, seconds:0,
               long:{in:0,out:0,cache_read:0,cache_write:0} };
const priceOf = (m) => tc.costOf(m, oneM, oneM.long);

console.log('\n13. an unknown model is unpriced, never priced as Opus');
tc.setPricing(storedWithDefault());
ok(tc.rateFor('acme-mystery-7b') === null, 'an unknown id has no card, even with a `default` row stored');
ok(priceOf('acme-mystery-7b') === null, 'and costOf says null, not a number');
ok(tc.rateFor('default') === null, 'the `default` row is not a card for a model literally called default');

console.log('\n14. gateway decorations resolve to the real card');
const haiku = 1 + 5;
for (const id of ['claude-haiku-4-5', 'anthropic/claude-haiku-4-5', 'anthropic.claude-haiku-4-5-20251001-v1:0',
                  'us.anthropic.claude-haiku-4-5-20251001-v1:0', 'anthropic/claude-haiku-4.5',
                  'claude-haiku-4-5@20251001', 'Claude-Haiku-4-5']) {
  ok(priceOf(id) === haiku, `${id} prices as Haiku 4.5 ($${haiku}), got ${priceOf(id)}`);
}
ok(priceOf('openai/gpt-5.5') === 35, 'openai/gpt-5.5 prices as GPT-5.5');
ok(tc.longThreshold('openai/gpt-5.5') === 272000, 'and keeps its 272k long tier');
ok(priceOf('x-ai/grok-4.6') === 8, 'a key that IS a prefixed id still matches literally');
ok(priceOf('claude-opus-5@default[1m]') === 30, 'the engine\'s own decorations still strip');

console.log('\n15. the price table is the only table');
// The app used to carry its own copy of every price and fill gaps from it.
// Now a model the stored table does not list is unpriced, never priced from
// a second copy that drifts.
ok(priceOf('claude-sonnet-5-5') === null, 'a model the stored table lacks is unpriced, got '+priceOf('claude-sonnet-5-5'));
const custom = storedWithDefault();
custom.models['claude-sonnet-5-5'] = { uncached_in:1.5, cache_write:0, cache_read:0, out:7.5 };
tc.setPricing(custom);
ok(priceOf('claude-sonnet-5-5') === 9, 'a stored rate prices it');
ok(priceOf('claude-sonnet-5-5[1m]') === 9, 'and its [1m] variant');
ok(priceOf('anthropic/claude-sonnet-5.5') === 9, 'and a gateway spelling of it');

console.log('\n16. an empty card is unpriced, a partial one is priced');
const blank = storedWithDefault();
blank.models['acme-mystery-7b'] = {};
blank.models['acme-half'] = { uncached_in:2 };
tc.setPricing(blank);
ok(priceOf('acme-mystery-7b') === null, 'a row "Add rate" left empty prices nothing');
ok(priceOf('acme-half') === 2, 'a blank field on a priced row counts as 0, not NaN, got '+priceOf('acme-half'));

console.log('\n17. the totals leave unpriced spend out and say so');
// The rows below are model rows, so group by Model alone.
tc.setGroups(['model']);
tc.setPricing(storedWithDefault());
const bucket = (calls, inT, out) => ({ calls, in:inT, cache_read:0, cache_write:0, out, seconds:0,
  buckets:[calls,0,0,0,0,0], long:{in:0,out:0,cache_read:0,cache_write:0} });
tc.resetLive();
tc.setDaily({ ...empty, days:{ [today]: {
  'main_llm|claude-opus-5': bucket(2, 1e6, 0),          // $5.00
  'main_llm|acme-mystery-7b': bucket(3, 2e6, 1e6),      // unpriced: $35 at the Opus card
}}, hours:{} });
tc.render();
const hero = document.getElementById('hero-cost').querySelector('.live').textContent;
ok(hero === '$5.00', 'the hero is the priced spend only, got '+hero);
ok(document.getElementById('hero-unpriced').hidden === false, 'the unpriced note is shown');
const note = document.getElementById('hero-unpriced-text').textContent;
ok(/3 calls on 1 unpriced model/.test(note), 'and counts the calls left out: '+note);
ok(document.getElementById('hero-unpriced-btn').dataset.addRate === 'acme-mystery-7b',
   'its button offers a rate for that model');
ok(/\$2\.50 per call/.test(document.getElementById('hero-sub').textContent),
   'per call averages over priced calls only: '+document.getElementById('hero-sub').textContent);
const rowsHtml = document.getElementById('tbody').children.map((r) => r.innerHTML);
ok(/data-add-rate="acme-mystery-7b"/.test(rowsHtml[0]) && /Unpriced/.test(rowsHtml[0]),
   'the unpriced row leads the table with an Add rate button');
ok(/\$5\.00/.test(rowsHtml[1]), 'the priced row keeps its cost');
const foot = document.getElementById('an-total').innerHTML;
ok(/Total.*priced.*\$5\.00/.test(foot) && /Unpriced.*not in total/.test(foot), 'the footer splits priced and unpriced');
ok(!/\$40\.00/.test(foot), 'and nothing anywhere folds the unpriced calls in at the Opus card');
tc.setDaily({ ...empty, days:{ [today]: { 'main_llm|claude-opus-5': bucket(2, 1e6, 0) } }, hours:{} });
tc.render();
ok(document.getElementById('hero-unpriced').hidden === true, 'with every model priced the note hides');
ok(!/Unpriced/.test(document.getElementById('an-total').innerHTML), 'and the footer is one row again');

console.log('\n18. the day selector names the zone days are cut in');
// run.sh pins TZ=Europe/Oslo.
ok(tc.dayZoneLabel(new Date('2026-07-01T12:00:00Z')) === 'Days in Europe/Oslo (UTC+2)',
   'summer: '+tc.dayZoneLabel(new Date('2026-07-01T12:00:00Z')));
ok(tc.dayZoneLabel(new Date('2026-01-15T12:00:00Z')) === 'Days in Europe/Oslo (UTC+1)',
   'winter: '+tc.dayZoneLabel(new Date('2026-01-15T12:00:00Z')));
ok(!html.includes('id="tz-note"'),
   'the controls row no longer carries a day-zone note (removed 2026-10-20)');


// --- price history ---------------------------------------------------------
// A provider changes its prices. A day must be priced at the card in force ON
// that day, so a later price change never reprices the days before it.
const dayOffset = (n) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n); return tc.localDay(d); };
const D2 = dayOffset(-2), D1 = dayOffset(-1);
const tableWith = (models) => ({ currency:'USD', models, producers:{}, fx:{ rates:{USD:1} } });
const near = (a, b) => a !== null && Math.abs(a - b) < 1e-9;

console.log('\n19. a price change mid-range prices each side at its own card');
tc.setPricing(tableWith({
  'acme-1': [
    { uncached_in:5, cache_write:0, cache_read:0.5, out:30 },
    { from:D1, uncached_in:4, cache_write:0, cache_read:0.4, out:20 },
  ],
}));
ok(near(tc.costOf('acme-1', oneM, oneM.long, D2), 35), 'the day before the change takes the old card: '+tc.costOf('acme-1', oneM, oneM.long, D2));
ok(near(tc.costOf('acme-1', oneM, oneM.long, D1), 24), 'the change day takes the new card: '+tc.costOf('acme-1', oneM, oneM.long, D1));
ok(near(tc.costOf('acme-1', oneM, oneM.long, today), 24), 'and it stays in force after');
ok(near(tc.costOf('acme-1', oneM, oneM.long, '2020-01-01'), 35), 'an undated first card covers the beginning');
// The range total is a SUM of per-day costs. Pricing the summed tokens once
// would charge both days at one card: 48 at the new rate, 70 at the old.
tc.resetLive();
tc.setDaily({ ...empty, days:{
  [D2]: { 'main_llm|acme-1': bucket(1, 1e6, 1e6) },
  [D1]: { 'main_llm|acme-1': bucket(1, 1e6, 1e6) },
}, hours:{} });
tc.render();
const hero19 = document.getElementById('hero-cost').querySelector('.live').textContent;
ok(hero19 === '$59.00', 'the hero over both days is 35 + 24 = $59.00, got '+hero19);
ok(/\$59\.00/.test(document.getElementById('tbody').children[0].innerHTML), 'and so is the model row');
ok(/Total.*\$59\.00/.test(document.getElementById('an-total').innerHTML), 'and the footer');

console.log('\n20. a plain object card still loads, as one undated card');
tc.setPricing(tableWith({ 'acme-1': { uncached_in:5, cache_write:0, cache_read:0.5, out:30 } }));
ok(near(tc.costOf('acme-1', oneM, oneM.long, '2020-01-01'), 35), 'priced on an old day');
ok(near(tc.costOf('acme-1', oneM, oneM.long, today), 35), 'and today');
ok(near(tc.costOf('acme-1', oneM, oneM.long), 35), 'and with no day given');
// The override is written as the engine reads it (llm/model_prices.rs): all
// four rates on every card and a `source`, or Lucidos ignores the whole file.
const saved = tc.overrideModels({ 'acme-1': { uncached_in:5, out:30, origin:'override' }, 'acme-2': [
  { from:'2026-08-21', uncached_in:4, out:20, source:'b', origin:'override' }, { uncached_in:5, out:30, source:'a', origin:'shipped' } ],
  'acme-3': [{ origin:'override' }] });
ok(Array.isArray(saved['acme-1']) && saved['acme-1'].length === 1 && !('from' in saved['acme-1'][0]),
   'a save writes the plain card as a one-card list');
ok(saved['acme-1'][0].cache_write === 0 && saved['acme-1'][0].cache_read === 0 && /Set by hand in Token Cost/.test(saved['acme-1'][0].source),
   'a blank rate is written as 0, and a card with no source gets one');
ok(!('origin' in saved['acme-1'][0]), 'the origin is the table\'s to say, never written');
ok(saved['acme-2'].length === 1 && Object.keys(saved['acme-2'][0])[0] === 'from',
   'a shipped card stays out of the override, `from` leads a dated card');
ok(!('acme-3' in saved), 'an "Add rate" card with no number stays out');

console.log('\n21. a future-dated card waits for its day');
tc.setPricing(tableWith({
  'acme-flash': [
    { uncached_in:0.75, cache_write:0, cache_read:0.075, out:3.75 },
    { from:'2099-01-01', uncached_in:1.5, cache_write:0, cache_read:0.15, out:7.5 },
  ],
  'acme-later': [ { from:'2099-01-01', uncached_in:1, out:1 } ],
}));
ok(near(tc.costOf('acme-flash', oneM, oneM.long, today), 4.5), 'today is still the introductory card: '+tc.costOf('acme-flash', oneM, oneM.long, today));
ok(near(tc.costOf('acme-flash', oneM, oneM.long, '2099-01-01'), 9), 'the new card is in force from its day');
ok(tc.costOf('acme-later', oneM, oneM.long, today) === null, 'a model whose first card starts later is unpriced before it');

console.log('\n22. the long tier follows the card in force');
tc.setPricing(tableWith({
  'acme-mini': [
    { uncached_in:1, cache_write:0, cache_read:0.1, out:5 },
    { from:D1, uncached_in:0.1, cache_write:0, cache_read:0.01, out:0.5,
      long:{ threshold_tokens:100000, uncached_in:0.5, cache_write:0, cache_read:0.05, out:2.5 } },
  ],
}));
ok(tc.longThreshold('acme-mini', D2) === 200000, 'before the tier exists the split is the global 200k: '+tc.longThreshold('acme-mini', D2));
ok(tc.longThreshold('acme-mini', D1) === 100000, 'from its day it is the card\'s 100k: '+tc.longThreshold('acme-mini', D1));
const call150k = { calls:1, in:150000, cache_read:0, cache_write:0, out:1000, seconds:0,
                   long:{ in:150000, out:1000, cache_read:0, cache_write:0 } };
ok(near(tc.costOf('acme-mini', call150k, call150k.long, D1), (150000*0.5 + 1000*2.5)/1e6),
   'a 150k call on the tier day takes the long rates whole');
ok(near(tc.costOf('acme-mini', call150k, null, D2), (150000*1 + 1000*5)/1e6),
   'the day before, the old card has no tier and prices it flat');
// A live call is split at the threshold of ITS day, not today's.
tc.resetLive();
tc.setDaily({ ...empty, days:{}, hours:{} });
tc.pushLive(mk(999500, D2+'T10:00:00', 'main_llm', 'acme-mini', [150000,0,0,1000]), {quiet:true});
tc.pushLive(mk(999501, D1+'T10:00:00', 'main_llm', 'acme-mini', [150000,0,0,1000]), {quiet:true});
ok(tc.seriesForDay(D2)['main_llm|acme-mini'].long.in === 0, 'the old day\'s live call is not long');
ok(tc.seriesForDay(D1)['main_llm|acme-mini'].long.in === 150000, 'the tier day\'s live call is long');

console.log('\n23. odd histories stay honest');
tc.setPricing(tableWith({
  'acme-1': [
    { uncached_in:5, out:30 },
    { from:D1 },                                   // a price change not filled in yet
    { from:'next tuesday', uncached_in:99, out:99 } // not a date
  ],
}));
ok(near(tc.costOf('acme-1', oneM, oneM.long, D1), 35), 'an empty card leaves the old price standing');
ok(near(tc.costOf('acme-1', oneM, oneM.long, '2099-12-31'), 35), 'a card whose from is not a date is ignored');
const hist = [ { uncached_in:5 }, { from:'2026-08-21', uncached_in:4 } ];
ok(tc.checkFrom(hist, hist[1], '2026-08-21') === null, 'a card may keep its own day');
ok(/already starts/.test(tc.checkFrom(hist, {}, '2026-08-21') || ''), 'two cards cannot share a day');
ok(/no From day/.test(tc.checkFrom(hist, hist[1], '') || ''), 'and only one card may be undated');
ok(/like 2026/.test(tc.checkFrom(hist, hist[1], '21.08.2026') || ''), 'a malformed day is refused');
ok(/real date/.test(tc.checkFrom(hist, hist[1], '2026-02-30') || ''), 'a day that does not exist is refused');
ok(/real date/.test(tc.checkFrom(hist, hist[1], '2026-13-01') || ''), 'and so is a month that does not exist');
ok(tc.checkFrom(hist, hist[1], '2028-02-29') === null, 'a real leap day is fine');

console.log('\n24. the edge of the long tier is the provider\'s');
// OpenAI (">272K"), Google ("> 200k") and Anthropic ("over 100,000") bill the
// long rates only ABOVE the threshold. xAI bills from a prompt that reaches
// it, and its card says so with `inclusive`.
tc.setPricing(tableWith({
  'gpt-5.5': { uncached_in:5, cache_write:0, cache_read:0.5, out:30,
               long:{ threshold_tokens:272000, uncached_in:10, cache_write:0, cache_read:1, out:45 } },
  'grok-4.6': { uncached_in:2, cache_write:0, cache_read:0.5, out:6,
                long:{ threshold_tokens:200000, inclusive:true, uncached_in:4, cache_write:0, cache_read:1, out:12 } },
  'claude-opus-5': { uncached_in:5, cache_write:6.25, cache_read:0.5, out:25 },
}));
ok(tc.isLongCall('gpt-5.5', 272000, today) === false, 'a GPT prompt of exactly 272,000 is short');
ok(tc.isLongCall('gpt-5.5', 272001, today) === true, 'one token over is long');
ok(tc.isLongCall('grok-4.6', 200000, today) === true, 'an xAI prompt of exactly 200,000 is long');
ok(tc.isLongCall('grok-4.6', 199999, today) === false, 'one token under is short');
ok(tc.isLongCall('claude-opus-5', 200000, today) === false, 'a tier-less card at exactly the global 200k is short');
tc.resetLive();
tc.setDaily({ ...empty, days:{}, hours:{} });
const edgeAt = today + 'T10:00:00';
tc.pushLive(mk(999600, edgeAt, 'codex', 'gpt-5.5', [272000,0,0,1000]), {quiet:true});
ok(tc.seriesForDay(today)['codex|gpt-5.5'].long.in === 0, 'a live 272,000-token call folds in as short');
const exact = { calls:1, in:272000, cache_read:0, cache_write:0, out:1000, seconds:0, long:{in:0,out:0,cache_read:0,cache_write:0} };
ok(near(tc.costOf('gpt-5.5', exact, exact.long, today), (272000*5 + 1000*30)/1e6), 'and is priced at the base card');

console.log('\n25. a card without a usable threshold splits at 200k');
tc.setPricing(tableWith({ 'acme-1': { uncached_in:1, out:1 },
  'acme-2': { uncached_in:1, out:1, long:{ threshold_tokens:'abc', uncached_in:2, out:2 } } }));
ok(tc.longThreshold('acme-1', today) === 200000, 'a tier-less card splits at 200k, as the rollup does');
ok(tc.longThreshold('acme-2', today) === 200000, 'a threshold that is not a number is skipped');
ok(tc.isLongCall('acme-2', 10, today) === false, 'and never compared as text');


console.log('\n26. a call is priced as the model that actually served it');
// The engine records `served_model`, the model the reply names. A provider
// that reroutes a retired id does it silently, so the reply is the truth.
for (const [sent, served] of [['gemini-3.5-flash','gemini-3.6-flash'], ['claude-opus-5','claude-opus-5-5'],
                              ['gemini-3.8-flash','gemini-3.8-flash-lite']]) {
  ok(!tc.servedAsSent(sent, served) && tc.pricedModel(sent, served) === served, `${sent} answered by ${served} is priced as ${served}`);
}
for (const [sent, served] of [['claude-haiku-4-5','claude-haiku-4-5-20251001'], ['gpt-5.6-luna','gpt-5.6-luna-2026-04-01'],
                              ['gemini-3.8-flash','gemini-3.8-flash-001'], ['google/gemini-3.8-flash','gemini-3.8-flash'],
                              ['claude-opus-5[1m]','claude-opus-5'], ['claude-opus-4-5','claude-opus-4-5@20251101'],
                              ['qwen3','qwen3:latest'], ['GPT-5.6-Luna','gpt-5.6-luna']]) {
  ok(tc.servedAsSent(sent, served) && tc.pricedModel(sent, served) === sent, `${sent} answered by ${served} keeps the requested id`);
}
ok(tc.pricedModel('claude-opus-5-5[1m]', undefined) === 'claude-opus-5-5[1m]', 'no served model keeps the requested one');
tc.setPricing(tableWith({
  'gemini-3.5-flash': { uncached_in:1.5, cache_write:0, cache_read:0.15, out:9 },
  'gemini-3.6-flash': { uncached_in:0.75, cache_write:0, cache_read:0.075, out:3.75 },
}));
tc.resetLive();
tc.setDaily({ ...empty, days:{}, hours:{} });
const rerouted = mk(999600, today+'T10:00:00', 'auxiliary', 'gemini-3.5-flash', [1e6,0,0,1e6]);
rerouted.event.served_model = 'gemini-3.6-flash';
tc.pushLive(rerouted, {quiet:true});
const same = mk(999601, today+'T10:01:00', 'auxiliary', 'gemini-3.6-flash', [1e6,0,0,1e6]);
same.event.served_model = 'gemini-3.6-flash';
tc.pushLive(same, {quiet:true});
const s24 = tc.seriesForDay(today);
ok(!s24['auxiliary|gemini-3.5-flash'], 'nothing is filed under the id that was asked for');
const b24 = s24['auxiliary|gemini-3.6-flash'];
ok(b24 && b24.calls === 2, 'both calls are filed under the model that ran: '+JSON.stringify(b24 && b24.calls));
ok(JSON.stringify(b24.routed_from) === '{"gemini-3.5-flash":1}', 'and the rerouted one is counted by what was asked: '+JSON.stringify(b24.routed_from));
tc.render();
ok(document.getElementById('hero-cost').querySelector('.live').textContent === '$9.00', 'priced at the served card, 2 x $4.50');
ok(/asked for gemini-3\.5-flash/.test(document.getElementById('tbody').children[0].innerHTML), 'the row says what was asked for');
// The rollup stores the same count; a stored row folds it the same way.
tc.resetLive();
tc.setDaily({ ...empty, days:{ [today]: { 'auxiliary|gemini-3.6-flash': { ...bucket(3, 3e6, 0), routed_from:{ 'gemini-3.5-flash':3 } } } }, hours:{} });
ok(tc.seriesForDay(today)['auxiliary|gemini-3.6-flash'].routed_from['gemini-3.5-flash'] === 3, 'a stored routed_from count survives the merge');

console.log('\n26b. a call is filed under the id the provider answered with');
// Claude Code sends `claude-opus-5-5[1m]`, the provider answers
// `claude-opus-5-5`. Both are one model, so they are one row, priced as now.
ok(tc.rowModel('claude-opus-5-5[1m]', 'claude-opus-5-5') === 'claude-opus-5-5', 'a [1m] call answered as the bare id files under it');
ok(tc.rowModel('claude-opus-5-5[1m]', 'claude-opus-5') === 'claude-opus-5', 'a reroute files under the model that ran');
ok(tc.rowModel('claude-haiku-4-5', 'claude-haiku-4-5-20251001') === 'claude-haiku-4-5-20251001', 'a snapshot files under the id the reply names');
ok(tc.rowModel('claude-opus-5-5[1m]', undefined) === 'claude-opus-5-5', 'a row with no served model keeps its model, less [1m]');
ok(tc.rowModel('claude-opus-5-5[1m]', '') === 'claude-opus-5-5', 'an empty served model too');
ok(tc.rowModel('claude-opus-5@default[1m]', undefined) === 'claude-opus-5@default', 'only the [1m] suffix goes');
tc.setPricing(tableWith({ 'claude-opus-5-5': { uncached_in:5, cache_write:6.25, cache_read:0.5, out:25 } }));
tc.resetLive();
tc.setDaily({ ...empty, days:{}, hours:{} });
const twin = mk(999650, today+'T10:00:00', 'claude_code', 'claude-opus-5-5[1m]', [1e6,0,0,1e6]);
twin.event.served_model = 'claude-opus-5-5';
tc.pushLive(twin, {quiet:true});
// Other counts, or the claude_code frame collapse takes it for a re-delivery.
const plain = mk(999651, today+'T10:01:00', 'claude_code', 'claude-opus-5-5', [2e6,0,0,1e6]);
plain.event.served_model = 'claude-opus-5-5';
tc.pushLive(plain, {quiet:true});
const s26b = tc.seriesForDay(today);
ok(!s26b['claude_code|claude-opus-5-5[1m]'], 'nothing is filed under the [1m] id');
const b26b = s26b['claude_code|claude-opus-5-5'];
ok(b26b && b26b.calls === 2, 'both calls share one row: '+JSON.stringify(b26b && b26b.calls));
ok(JSON.stringify(b26b.routed_from) === '{}', 'and neither counts as a reroute');
ok(tc.costOf('claude-opus-5-5', b26b, b26b.long, today) ===
   tc.costOf('claude-opus-5-5[1m]', { in:1e6, cache_read:0, cache_write:0, out:1e6 }, null, today)
   + tc.costOf('claude-opus-5-5', { in:2e6, cache_read:0, cache_write:0, out:1e6 }, null, today),
   'the row costs what the two calls cost under their requested ids');
tc.render();
ok(document.getElementById('hero-cost').querySelector('.live').textContent === '$65.00', 'priced at the one card, $30 + $35');
ok(document.getElementById('tbody').children.length === 1, 'the By model table has one row');

// The registry labels an undated id; the reply can name a snapshot of it.
const request26b = lucidos.request;
lucidos.request = async () => [{ id:'claude-haiku-4-5', label:'Haiku 4.5' }, { id:'claude-opus-5-5', label:'Opus 5.5' }];
await tc.loadModelLabels();
ok(tc.modelName('claude-haiku-4-5-20251001') === 'Haiku 4.5', 'a snapshot id takes its undated label');
ok(tc.modelName('claude-opus-5-5') === 'Opus 5.5', 'a bare id takes its own label');
ok(tc.modelName('gemini-9') === 'gemini-9', 'an id the registry lacks prints as itself');
lucidos.request = request26b;
await tc.loadModelLabels();

console.log('\n27. a served model with no card is unpriced, never priced as the one asked for');
tc.setPricing(tableWith({ 'gemini-3.5-flash': { uncached_in:1.5, cache_write:0, cache_read:0.15, out:9 } }));
tc.resetLive();
tc.setDaily({ ...empty, days:{}, hours:{} });
const orphan = mk(999700, today+'T10:00:00', 'auxiliary', 'gemini-3.5-flash', [1e6,0,0,1e6]);
orphan.event.served_model = 'gemini-3.9-flash';
tc.pushLive(orphan, {quiet:true});
tc.render();
ok(!/[1-9]/.test(document.getElementById('hero-cost').querySelector('.live').textContent), 'nothing is added at the requested card: '+document.getElementById('hero-cost').querySelector('.live').textContent);
ok(!document.getElementById('hero-unpriced').hidden, 'the call is counted as unpriced');
ok(/data-add-rate="gemini-3\.9-flash"/.test(document.getElementById('tbody').children[0].innerHTML), 'and the served id is the one offered a rate');
ok(tc.isLongCall('gemini-3.9-flash', 200001, today) === true, 'an unpriced served model splits at the global default, as the rollup does');

console.log('\n28. a model id cannot break out of an attribute');
// The asked id is the request body's, the served id the provider reply's.
// Neither is ours, so a quote in one must not close the attribute it sits in.
tc.resetLive();
const hostile = mk(999710, today+'T10:00:00', 'auxiliary', 'x" onmouseover="alert(1)', [10,0,0,10]);
hostile.event.served_model = 'y" onfocus="alert(2)';
tc.pushLive(hostile, {quiet:true});
tc.render();
const row26 = document.getElementById('tbody').children[0].innerHTML;
// Only the attributes matter: in text position a quote is harmless.
const tags26 = row26.match(/<[^>]*>/g).join('');
ok(!/onmouseover="/.test(tags26), 'the asked id stays inside the tooltip');
ok(!/onfocus="/.test(tags26), 'the served id stays inside the add-rate button');
ok(tags26.includes('data-add-rate="y&quot; onfocus=&quot;alert(2)"'), 'and arrives escaped');
// An older host's SDK has no escapeHtmlAttr. Render must neither throw nor
// fall back to the text escape.
const attrEsc = lucidos.utils.escapeHtmlAttr;
delete lucidos.utils.escapeHtmlAttr;
let threw = null;
try { tc.render(); } catch (e) { threw = e; }
lucidos.utils.escapeHtmlAttr = attrEsc;
ok(!threw, 'an SDK without escapeHtmlAttr still renders: '+(threw && threw.message));
const oldTags = document.getElementById('tbody').children[0].innerHTML.match(/<[^>]*>/g).join('');
ok(!/onmouseover="|onfocus="/.test(oldTags), 'and still escapes the quotes itself');

console.log('\n29. a call served on the Flex tier takes the card\'s Flex rates');
tc.setPricing({
  currency:'USD',
  models:{
    'gpt-6.1-sol': { uncached_in:2, cache_write:2.5, cache_read:0.1, out:10,
                     flex:{ uncached_in:1, cache_write:1.25, cache_read:0.05, out:5 } },
    'gpt-5.5': { uncached_in:5, cache_write:0, cache_read:0.5, out:30 },
  },
  producers:{}, fx:{ rates:{USD:1} },
});
const noTier = { in:0, out:0, cache_read:0, cache_write:0 };
const flexCall = { in:7000, cache_read:5000, cache_write:1500, out:100 };
const stdUsd = (500*2 + 1500*2.5 + 5000*0.1 + 100*10)/1e6;
const flexUsd = (500*1 + 1500*1.25 + 5000*0.05 + 100*5)/1e6;
const nearUsd = (a, b) => Math.abs(a - b) < 1e-12;
const allFlex = { calls:1, ...flexCall, seconds:0, long:noTier, flex:{...flexCall} };
ok(nearUsd(tc.costOf('gpt-6.1-sol', allFlex, allFlex.long), flexUsd),
   'a Flex call costs the Flex card, got '+tc.costOf('gpt-6.1-sol', allFlex, allFlex.long));
const mixed = { calls:2, in:14000, cache_read:10000, cache_write:3000, out:200, seconds:0,
                long:noTier, flex:{...flexCall} };
ok(nearUsd(tc.costOf('gpt-6.1-sol', mixed, mixed.long), stdUsd + flexUsd),
   'a bundle prices its Flex share at Flex and the rest at the base card');
const plainCard = { calls:1, ...flexCall, seconds:0, long:noTier, flex:{...flexCall} };
ok(nearUsd(tc.costOf('gpt-5.5', plainCard, plainCard.long), (500*5 + 5000*0.5 + 100*30)/1e6),
   'a card with no Flex block prices Flex tokens at its base rates');
tc.setDaily({...empty, days:{}});
tc.resetLive();
const flexAt = '2026-08-12T11:00:00Z';
const flexEv = mk(999101, flexAt, 'auxiliary', 'gpt-6.1-sol', [7000,5000,1500,100]);
flexEv.event.usage.service_tier = 'flex';
tc.pushLive(flexEv, {quiet:true});
const s29 = tc.seriesForDay(tc.localDay(new Date(flexAt)));
const bucket29 = Object.values(s29)[0];
ok(bucket29 && bucket29.flex.in === 7000 && bucket29.flex.cache_write === 1500,
   'a live Flex call lands in the flex bucket, got '+JSON.stringify(bucket29 && bucket29.flex));

console.log('\n30. the analysis tree: chip order nests, threads fold their subs');
tc.setPricing(tableWith({ 'acme-1': { uncached_in:1, cache_write:0, cache_read:0, out:0 },
                          'acme-2': { uncached_in:2, cache_write:0, cache_read:0, out:0 } }));
tc.resetLive();
tc.setDaily({ ...empty, days:{ [today]: {
  'main_llm|acme-1': { ...bucket(2, 1e6, 0), cached_calls:1 },
  'claude_code|acme-2': { ...bucket(4, 2e6, 0), cached_calls:4 },
}}, hours:{} });
const rowsOf = () => document.getElementById('tbody').children.map((r) => r.innerHTML);
tc.setGroups(['type', 'model']);
tc.render();
let r30 = rowsOf();
ok(r30.length === 2, 'Type then Model shows the two types, folded: '+r30.length);
ok(/Claude Code/.test(r30[0]) && /\$4\.00/.test(r30[0]), 'the dearer type leads, under its built-in name');
tc.expand('/type:claude_code');
tc.render();
r30 = rowsOf();
ok(r30.length === 3 && /acme-2/.test(r30[1]), 'opening a type shows its models under it');
ok(/4 <span class="muted">\/ 0/.test(r30[0]), 'cached / cold calls are counted: '+r30[0].match(/<td class="num">4[^<]*<span[^>]*>[^<]*/));
tc.setGroups(['model', 'type']);
tc.render();
ok(/acme-2/.test(rowsOf()[0]), 'clicking Model first puts models on top');
// An old rollup row has no cached_calls, so its split is unknown, not all cold.
tc.setDaily({ ...empty, days:{ [today]: { 'main_llm|acme-1': bucket(2, 1e6, 0) } }, hours:{} });
tc.render();
ok(/Not counted yet/.test(rowsOf()[0]), 'a row from before the count says so instead of guessing');

// Threads: a parent with a sub-thread rolls up into one row.
tc.threadMeta.set('root', { title:'Parent thread', parent:null });
tc.threadMeta.set('kid', { title:'Sub thread', parent:'root' });
tc.threadMeta.set('solo', { title:'Lone thread', parent:null });
tc.setDaily({ ...empty, last_sequence:0, days:{ [today]: { 'main_llm|acme-1': { ...bucket(6, 6e6, 0), cached_calls:6 } } }, hours:{} });
tc.setThreads({ last_sequence:0, fields:['calls','cached_calls','in','cache_read','cache_write','out'],
  days:{ [today]: {
    root: { 'main_llm|acme-1': [1, 1, 1e6] },
    kid:  { 'main_llm|acme-1': [3, 3, 3e6] },
    solo: { 'main_llm|acme-1': [2, 2, 2e6] },
  } }, hours:{} });
tc.setGroups(['thread']);
tc.render();
r30 = rowsOf();
ok(r30.length === 2, 'one row per root thread, the sub folded in: '+r30.length);
ok(/Parent thread/.test(r30[0]) && /\$4\.00/.test(r30[0]) && /\+1 sub/.test(r30[0]), 'the parent carries its sub\'s cost and says so');
tc.expand('/thread:root');
tc.render();
r30 = rowsOf();
ok(/Sub thread/.test(r30[1]) && /\$3\.00/.test(r30[1]), 'opening it lists the sub-thread with its own cost');
ok(/Total.*\$6\.00/.test(document.getElementById('an-total').innerHTML), 'and the total is the same with or without threads');
tc.setThreads(null);
tc.render();
ok(!/Parent thread/.test(rowsOf().join('')) && /no per-thread rollup/.test(document.getElementById('an-note').textContent),
   'with no thread file, Thread is left out and the note says why');
tc.setThreads({ last_sequence:0, fields:[], days:{}, hours:{} });

console.log('\n31. a cache keep-alive call is its own type');
tc.resetLive();
const kaAt = '2026-08-12T12:00:00Z';
const kaEv = (seq, req, u) => { const e = mk(seq, kaAt, 'claude_code', 'claude-opus-5', u); e.event.request_event_id = req; e.thread_id = req; return e; };
const KEEP_ALIVE_ORIGIN = { origin: { kind: 'engine', reason: { kind: 'cache_keep_alive' } } };
tc.pushLive(kaEv(999201, 'anchor-1', [5000,4900,50,10]), {quiet:true});
tc.pushLive(kaEv(999202, 'turn-1', [6000,5000,900,40]), {quiet:true});
ok(tc.countedLive().every((c) => c.producer === 'claude_code'), 'before its anchor is seen, a ping reads as Claude Code');
ok(tc.noteKeepAliveAnchor('anchor-1', KEEP_ALIVE_ORIGIN) === true, 'a keep-alive anchor is noted');
ok(tc.noteKeepAliveAnchor('anchor-1', KEEP_ALIVE_ORIGIN) === false, 'and noted once');
ok(tc.noteKeepAliveAnchor('turn-1', { origin: { kind: 'engine', reason: { kind: 'event_wait' } } }) === false,
   'another engine prompt is no keep-alive anchor');
const kaCalls = tc.countedLive();
ok(kaCalls.find((c) => c.seq === 999201)?.producer === 'cache_keep_alive', 'an anchor seen late still relabels its call');
ok(kaCalls.find((c) => c.seq === 999202)?.producer === 'claude_code', 'an ordinary turn stays Claude Code');
tc.pushLive(kaEv(999203, 'anchor-1', [5000,4900,50,10]), {quiet:true});
ok(tc.countedLive().length === 2, 'a re-delivered keep-alive frame is still collapsed');
const kaSeries = tc.seriesForDay(tc.localDay(new Date(kaAt)));
ok(Object.keys(kaSeries).includes('cache_keep_alive|claude-opus-5'), 'the series files it under its own type');
ok(tc.dimLabel('type', 'cache_keep_alive') === 'Cache keep-alive',
   'it is labelled even when the saved settings predate it');

console.log('\n32. Model:effort splits a model by the thinking level it asked for');
tc.setPricing(tableWith({ 'acme-1': { uncached_in:1, cache_write:0, cache_read:0, out:0 } }));
tc.resetLive();
tc.setDaily({ ...empty, days:{ [today]: {
  'main_llm|acme-1|high': bucket(3, 3e6, 0),
  'main_llm|acme-1|medium': bucket(1, 1e6, 0),
  'main_llm|acme-1': bucket(2, 2e6, 0),
}}, hours:{} });
tc.setGroups(['model']);
tc.render();
ok(rowsOf().length === 1 && /\$6\.00/.test(rowsOf()[0]), 'Model alone still sums every effort into one row');
tc.setGroups(['model_effort']);
tc.render();
const r32 = rowsOf();
ok(r32.length === 3, 'Model:effort shows one row per effort: '+r32.length);
ok(/acme-1 · high/.test(r32[0]) && /\$3\.00/.test(r32[0]), 'the dearest effort leads, named after its model');
ok(r32.some((r) => /acme-1 · effort unknown/.test(r)), 'a row from before effort was recorded says so');
const effAt = new Date().toISOString();
const effEv = mk(999301, effAt, 'main_llm', 'acme-1', [1000,0,0,10]);
effEv.event.reasoning_effort = 'low';
tc.pushLive(effEv, {quiet:true});
ok(Object.keys(tc.seriesForDay(tc.localDay(new Date(effAt)))).includes('main_llm|acme-1|low'),
   'a live call is filed under its effort');

console.log('\n33. every auxiliary purpose is its own producer');
tc.setPricing({ ...tableWith({ 'acme-1': { uncached_in:1, cache_write:0, cache_read:0, out:0 } }), producers:{ main_llm:'Lucidos Agent' } });
tc.resetLive();
const auxEv = (seq, purpose, tokens) => { const e = mk(seq, new Date().toISOString(), 'auxiliary', 'acme-1', [tokens,0,0,0]); if (purpose !== undefined) e.event.purpose = purpose; return e; };
tc.pushLive(auxEv(999401, 'memory', 1000), {quiet:true});
tc.pushLive(auxEv(999402, 'summary_compaction', 2000), {quiet:true});
tc.pushLive(auxEv(999403, undefined, 4000), {quiet:true});
tc.pushLive(auxEv(999404, '', 8000), {quiet:true});
tc.pushLive(auxEv(999405, 'a|b', 16000), {quiet:true});
tc.pushLive(mk(999406, new Date().toISOString(), 'main_llm', 'acme-1', [32000,0,0,0]), {quiet:true});
const auxLive = tc.countedLive();
ok(auxLive.find((c) => c.seq === 999401)?.producer === 'auxiliary:memory', 'a live call is filed under auxiliary:<purpose>');
ok(auxLive.find((c) => c.seq === 999402)?.producer === 'auxiliary:summary_compaction', 'a purpose with an underscore');
ok(auxLive.find((c) => c.seq === 999403)?.producer === 'auxiliary', 'no purpose stays bare auxiliary');
ok(auxLive.find((c) => c.seq === 999404)?.producer === 'auxiliary', 'an empty purpose stays bare auxiliary');
ok(auxLive.find((c) => c.seq === 999405)?.producer === 'auxiliary:a_b', 'a pipe in a purpose cannot split the row key, as in the rollup');
ok(auxLive.find((c) => c.seq === 999406)?.producer === 'main_llm', 'another producer keeps its id');
const auxKeys = Object.keys(tc.seriesForDay(tc.localDay(new Date())));
ok(auxKeys.includes('auxiliary:memory|acme-1') && auxKeys.includes('auxiliary:summary_compaction|acme-1'), 'the series keeps them apart');

console.log('\n34. labels for the sub-producers');
ok(tc.producerLabel('auxiliary:summary_compaction') === 'Compaction', 'compaction');
ok(tc.producerLabel('auxiliary:memory') === 'Memory', 'memory');
ok(tc.producerLabel('auxiliary:title') === 'Title', 'title');
ok(tc.producerLabel('auxiliary:query_classification') === 'Query classification', 'query classification');
ok(tc.producerLabel('auxiliary:command_judge') === 'Command judge', 'command judge');
ok(tc.producerLabel('auxiliary:image_describe') === 'Image describe', 'image describe');
ok(tc.producerLabel('auxiliary:change_summary') === 'Change summary', 'an unknown purpose reads as its name, not the raw id');
ok(tc.producerLabel('auxiliary:voice') === 'Voice', 'voice');
ok(tc.producerLabel('auxiliary') === 'Auxiliary', 'bare auxiliary has a name too');
ok(tc.producerLabel('mystery') === 'mystery', 'a non-auxiliary unknown id still shows raw');
tc.setPricing({ ...tableWith({}), producers:{ 'auxiliary:memory':'Memory calls' } });
ok(tc.producerLabel('auxiliary:memory') === 'Memory calls', 'a workspace label beats the built-in one');
ok(tc.producerLabel('auxiliary:title') === 'Title', 'and leaves the others on theirs');

console.log('\n35. the producer filter lists each sub-producer and matches by prefix');
ok(tc.producerMatches('all', 'auxiliary:memory') && tc.producerMatches('all', 'main_llm'), 'All matches everything');
ok(tc.producerMatches('auxiliary:*', 'auxiliary:memory') && tc.producerMatches('auxiliary:*', 'auxiliary:title'), 'Auxiliary (all) matches every sub-producer');
ok(tc.producerMatches('auxiliary:*', 'auxiliary'), 'and the bare auxiliary id');
ok(!tc.producerMatches('auxiliary:*', 'main_llm') && !tc.producerMatches('auxiliary:*', 'claude_code'), 'but no typed producer');
ok(tc.producerMatches('auxiliary:memory', 'auxiliary:memory') && !tc.producerMatches('auxiliary:memory', 'auxiliary:title'), 'one sub-producer matches only itself');
ok(!tc.producerMatches('auxiliary:memory', 'auxiliary'), 'and not the bare id');
ok(tc.producerMatches('main_llm', 'main_llm') && !tc.producerMatches('main_llm', 'auxiliary:memory'), 'a plain producer matches only itself');

tc.setPricing({ ...tableWith({ 'acme-1': { uncached_in:1, cache_write:0, cache_read:0, out:0 } }), producers:{ main_llm:'Lucidos Agent', codex:'Codex', 'auxiliary:title':'Title' } });
tc.setDaily({ ...empty, days:{ [today]: {
  'main_llm|acme-1': bucket(1, 1e6, 0),
  'auxiliary:memory|acme-1': bucket(1, 2e6, 0),
  'auxiliary:summary_compaction|acme-1': bucket(1, 4e6, 0),
  'auxiliary:change_summary|acme-1': bucket(1, 8e6, 0),
  'claude_code|acme-1': bucket(1, 16e6, 0),
  'cache_keep_alive|acme-1': bucket(1, 32e6, 0),
  'mystery|acme-1': bucket(1, 64e6, 0),
}}, hours:{} });
tc.resetLive();
tc.syncProducerFilter();
const lastSelect = selects.find((x) => x.options.some((o) => o.label === 'All producers'));
const opts = lastSelect.options;
const labelOf = (v) => opts.find((o) => o.value === v)?.label;
ok(opts[0].value === 'all', 'All producers leads');
ok(labelOf('auxiliary:*') === 'Auxiliary (all)', 'an Auxiliary (all) option is offered');
ok(labelOf('auxiliary:memory') === 'Memory' && labelOf('auxiliary:summary_compaction') === 'Compaction', 'each sub-producer is listed, labelled');
ok(labelOf('auxiliary:change_summary') === 'Change summary', 'including one with no built-in label');
ok(!opts.some((o) => o.value === 'auxiliary'), 'the bare id is not listed when no row has it');
ok(!opts.some((o) => o.value === 'codex' || o.value === 'auxiliary:title'), 'a labelled producer with no data is not listed');
ok(opts.length === 1 + 1 + 7, 'only All, Auxiliary (all) and the seven producers with data: '+opts.length);
ok(opts.findIndex((o) => o.value === 'auxiliary:*') < opts.findIndex((o) => o.value === 'auxiliary:memory'), 'the group sits before its members');
tc.setGroups(['type']);
lastSelect.setValue('all'); tc.render();
const r35 = rowsOf();
ok(r35.length === 3, 'Group by Type has one row per typed producer, plus Auxiliary for the rest: '+r35.length);
ok(/Auxiliary/.test(r35[0]) && /\$110\.00/.test(r35[0]), 'Auxiliary carries purposes, keep-alive pings and the untyped call');
ok(/Claude Code/.test(r35[1]) && /\$16\.00/.test(r35[1]), 'Claude Code keeps only its own turns');
ok(!rowsOf().some((r) => /Memory/.test(r)), 'Type alone does not open into sub-types');
// Sub-types are the Type:subtype chip's level, not a Type row's own.
tc.setGroups(['type', 'subtype']); tc.expand('/type:auxiliary'); tc.render();
const r35b = rowsOf();
ok(r35b.length === 8, 'opening Auxiliary lists every sub-type: '+r35b.length);
ok(/Compaction/.test(r35b.join('')) && /Memory/.test(r35b.join('')) && /Change summary/.test(r35b.join('')), 'purposes read capitalised, without a prefix');
ok(!/Aux: /.test(r35b.join('')), 'no row carries the prefix');
ok(r35b.some((r) => /Cache keep-alive/.test(r) && /\$32\.00/.test(r)), 'the keep-alive pings are a sub-type, with their own cost');
ok(r35b.some((r) => />mystery</.test(r) && /\$64\.00/.test(r)), 'a producer with no type is a sub-type under its raw id');
tc.expand('/type:claude_code'); tc.render();
ok(rowsOf().length === 8, 'Claude Code has no sub-types to open');
tc.expand('/type:main_llm'); tc.render();
// A legacy agent row (no origin recorded) still opens, into Origin unknown,
// so it is never shown as if it were chat or trigger.
ok(rowsOf().length === 9 && /Origin unknown/.test(rowsOf().join('')), 'a legacy agent row opens into Origin unknown: '+rowsOf().length);
tc.setGroups(['type', 'model']); tc.expand('/type:main_llm'); tc.render();
ok(rowsOf().length === 4 && /acme-1/.test(rowsOf().join('')), 'with a Model chip after it, a typed producer opens straight into models: '+rowsOf().length);
tc.setGroups(['type', 'subtype']); tc.expand('/type:auxiliary');
lastSelect.setValue('auxiliary:*'); tc.render();
ok(rowsOf().length === 6 && /\$110\.00/.test(document.getElementById('an-total').innerHTML), 'Auxiliary (all) keeps the whole family: '+rowsOf().length);
lastSelect.setValue('auxiliary:memory'); tc.render();
ok(rowsOf().length === 2 && /\$2\.00/.test(document.getElementById('an-total').innerHTML), 'one sub-producer keeps only its own cost');
tc.setGroups(['type']);
lastSelect.setValue('main_llm'); tc.render();
ok(rowsOf().length === 1 && /\$1\.00/.test(document.getElementById('an-total').innerHTML), 'a typed producer excludes every auxiliary row');
lastSelect.setValue('cache_keep_alive'); tc.render();
ok(/\$32\.00/.test(document.getElementById('an-total').innerHTML), 'the keep-alive filter still works on its own id');
lastSelect.setValue('all');

console.log('\n36. the type hierarchy');
ok(tc.typeParent('auxiliary:memory') === 'auxiliary' && tc.typeParent('auxiliary') === 'auxiliary', 'every auxiliary id sits under auxiliary');
ok(tc.typeParent('cache_keep_alive') === 'auxiliary', 'a keep-alive ping sits under auxiliary');
ok(tc.typeParent('unknown') === 'auxiliary' && tc.typeParent('mystery') === 'auxiliary', 'so does any producer with no type');
ok(['main_llm', 'claude_code', 'codex', 'jev_browser'].every((p) => tc.typeParent(p) === p), 'a typed producer is its own row');
ok(tc.producerMatches('auxiliary:*', 'cache_keep_alive') && tc.producerMatches('auxiliary:*', 'mystery') && !tc.producerMatches('auxiliary:*', 'claude_code'),
   'Auxiliary (all) matches the whole family');
ok(tc.dimLabel('type', 'claude_code') === 'Claude Code' && tc.dimLabel('type', 'auxiliary') === 'Auxiliary', 'a top row is labelled by its family');
ok(tc.dimLabel('subtype', 'cache_keep_alive') === 'Cache keep-alive' && tc.dimLabel('subtype', 'auxiliary:title') === 'Title', 'a sub-type by its own label');
ok(tc.dimLabel('subtype', 'auxiliary') === 'Auxiliary (unspecified)', 'a call with no purpose says it is an unspecified auxiliary call');
ok(!tc.dims.some((d) => d.id === 'producer'), 'there is no separate Producer chip');
tc.setGroups(['type', 'model']);

console.log('\n37. the chips are built once, not on every render (a rebuild flickers the hover)');
tc.setGroups(['type']); tc.render();
const chipsHost = document.getElementById('an-chips');
ok((chipsHost.innerHTML.match(/<button/g) || []).length > 0, 'the chips are built on first render');
chipsHost.innerHTML = chipsHost.innerHTML + '<!--kept-->';
tc.setGroups(['type', 'model']); tc.render();
ok(/<!--kept-->/.test(chipsHost.innerHTML), 'a later render leaves the same buttons in place');
tc.setGroups(['type', 'model']);

console.log('\n38. one variant per chip family: Model or Model:effort, Type or Type:subtype');
const J = (x) => JSON.stringify(x);
ok(J(tc.pickDim(['type', 'model'], 'model_effort')) === J(['type', 'model_effort']), 'picking Model:effort swaps out Model in its place');
ok(J(tc.pickDim(['model', 'type'], 'subtype')) === J(['model', 'subtype']), 'picking Type:subtype swaps out Type in its place');
ok(J(tc.pickDim(['type', 'model'], 'model')) === J(['type']), 'the face on an on chip turns it off');
ok(J(tc.pickDim(['type'], 'model_effort')) === J(['type', 'model_effort']), 'a family not on is appended');
ok(J(tc.chooseDim(['type', 'model'], 'model')) === J(['type', 'model']), 'a menu pick of the current variant keeps it on');
ok(J(tc.oneOfEachFamily(['model', 'type', 'model_effort', 'subtype', 'thread'])) === J(['model', 'type', 'thread']), 'a stored pick with both variants keeps the first');

console.log('\n39. Lucidos Agent splits into Chat and Trigger by the thread it ran in');
// $1 per million uncached input tokens, so a row's cost is its millions.
tc.setPricing({ ...tableWith({ 'acme-1': { uncached_in:1, cache_write:0, cache_read:0, out:0 } }), producers:{ main_llm:'Lucidos Agent' } });
tc.resetLive(); tc.resetOrigins();
const money = () => document.getElementById('an-total').innerHTML;
const heroMoney = () => document.getElementById('hero-cost').querySelector('.live').textContent;
const agentSel = () => selects.find((x) => x.options.some((o) => o.label === 'All producers'));
const row39 = (rows, re) => rows.find((r) => re.test(r)) || '';
tc.setDaily({ ...empty, days:{ [today]: {
  'main_llm:chat|acme-1': bucket(1, 1e6, 0),
  'main_llm:trigger|acme-1': bucket(1, 2e6, 0),
  'main_llm|acme-1': bucket(1, 4e6, 0),              // rolled up before origin was recorded
  'main_llm:other|acme-1': bucket(1, 8e6, 0),
  'auxiliary:title|acme-1': bucket(1, 16e6, 0),
  'claude_code|acme-1': bucket(1, 32e6, 0),
}}, hours:{} });
tc.syncProducerFilter();
agentSel().setValue('all');

ok(tc.typeParent('main_llm:chat') === 'main_llm' && tc.typeParent('main_llm:trigger') === 'main_llm'
   && tc.typeParent('main_llm:other') === 'main_llm' && tc.typeParent('main_llm') === 'main_llm', 'every origin sits under Lucidos Agent');
ok(tc.typeParent('auxiliary:title') === 'auxiliary', 'an auxiliary call does not');
ok(tc.dimLabel('type', tc.typeParent('main_llm:trigger')) === 'Lucidos Agent', 'the Type row keeps its name');
ok(tc.dimLabel('subtype', 'main_llm:chat') === 'Chat' && tc.dimLabel('subtype', 'main_llm:trigger') === 'Trigger', 'the sub-types read Chat and Trigger');
ok(tc.dimLabel('subtype', 'main_llm') === 'Origin unknown', 'a legacy row reads Origin unknown, never Chat');
ok(tc.dimLabel('subtype', 'main_llm:other') === 'Other origin', 'a system-started thread reads Other origin');

tc.setGroups(['type']); tc.render();
const r39 = rowsOf();
ok(r39.length === 3, 'Type keeps one Lucidos Agent row: '+r39.length);
ok(/Lucidos Agent/.test(row39(r39, /Lucidos Agent/)) && /\$15\.00/.test(row39(r39, /Lucidos Agent/)), 'it carries every origin, the unknown one too');
ok(/\$16\.00/.test(row39(r39, /Auxiliary/)), 'auxiliary calls stay in their own row, never under Lucidos Agent');
ok(/\$63\.00/.test(money()) && heroMoney() === '$63.00', 'the total is unchanged by the split: '+heroMoney());

tc.setGroups(['type', 'subtype']); tc.expand('/type:main_llm'); tc.render();
const r39b = rowsOf();
ok(r39b.length === 3 + 4, 'Type:subtype opens Lucidos Agent into its four origins: '+r39b.length);
ok(/\$1\.00/.test(row39(r39b, />Chat</)) && /\$2\.00/.test(row39(r39b, />Trigger</)), 'Chat and Trigger each keep their own cost');
ok(/\$4\.00/.test(row39(r39b, /Origin unknown/)), 'the legacy row is its own sub-type');
ok(/\$8\.00/.test(row39(r39b, /Other origin/)), 'and so is a system-started thread');
tc.expand('/type:claude_code'); tc.render();
ok(rowsOf().length === 7, 'Claude Code still has no sub-types');

tc.setGroups(['subtype']); tc.render();
ok(rowsOf().length === 6 && /\$63\.00/.test(money()), 'flat Type:subtype lists all six and sums to the same total');
tc.setGroups(['model', 'subtype']); tc.expand('/model:acme-1'); tc.render();
ok(rowsOf().length === 1 + 6 && /\$63\.00/.test(money()), 'Model then Type:subtype: the same six under the model');
tc.setGroups(['subtype', 'model']); tc.expand('/subtype:main_llm:trigger'); tc.render();
ok(rowsOf().length === 6 + 1 && /\$2\.00/.test(row39(rowsOf(), />Trigger</)), 'Type:subtype then Model: a sub-type opens into its models');

const opts39 = agentSel().options;
const label39 = (v) => opts39.find((o) => o.value === v)?.label;
ok(label39('main_llm:*') === 'Lucidos Agent (all)', 'the filter offers Lucidos Agent (all)');
ok(label39('main_llm:chat') === 'Lucidos Agent · Chat' && label39('main_llm:trigger') === 'Lucidos Agent · Trigger', 'and each origin, named after the agent');
ok(label39('main_llm') === 'Lucidos Agent · Origin unknown', 'the legacy rows are listed as unknown');
ok(opts39.findIndex((o) => o.value === 'main_llm:*') < opts39.findIndex((o) => o.value === 'main_llm:chat'), 'the group sits before its members');
ok(tc.producerMatches('main_llm:*', 'main_llm') && tc.producerMatches('main_llm:*', 'main_llm:trigger') && !tc.producerMatches('main_llm:*', 'auxiliary:title'),
   'Lucidos Agent (all) matches every origin and no auxiliary call');
tc.setGroups(['type']);
agentSel().setValue('main_llm:*'); tc.render();
ok(heroMoney() === '$15.00', 'Lucidos Agent (all) is the whole family: '+heroMoney());
agentSel().setValue('main_llm:trigger'); tc.render();
ok(heroMoney() === '$2.00', 'Trigger alone: '+heroMoney());
agentSel().setValue('main_llm'); tc.render();
ok(heroMoney() === '$4.00', 'the bare id is the unknown rows only: '+heroMoney());
agentSel().setValue('all');

console.log('\n40. the thread origin rule, as the rollup applies it');
const byId = new Map();
const sum = (t) => { byId.set(t.thread_id, t); return t; };
const look = (id) => tc.originOfSummary(byId.get(id), (pid) => byId.get(pid));
sum({ thread_id:'trig', channel:'trigger', initiator:'system', trigger_id:'x' });
sum({ thread_id:'trig-in-chat', channel:'chat', initiator:'system', trigger_id:'x' });
sum({ thread_id:'chat', channel:'chat', initiator:'user' });
sum({ thread_id:'sys', channel:'chat', initiator:'system' });
sum({ thread_id:'kid-of-trig', channel:'chat', initiator:'system', parent_thread_id:'trig' });
sum({ thread_id:'grandkid', channel:'chat', initiator:'system', parent_thread_id:'kid-of-trig' });
sum({ thread_id:'kid-of-chat', channel:'chat', initiator:'system', parent_thread_id:'chat' });
sum({ thread_id:'orphan', channel:'chat', initiator:'user', parent_thread_id:'gone' });
sum({ thread_id:'loop-a', channel:'chat', initiator:'user', parent_thread_id:'loop-b' });
sum({ thread_id:'loop-b', channel:'chat', initiator:'user', parent_thread_id:'loop-a' });
sum({ thread_id:'blank-trigger', channel:'chat', initiator:'user', trigger_id:'' });
ok(look('trig') === 'trigger' && look('trig-in-chat') === 'trigger', 'a thread a trigger opened is Trigger');
ok(look('chat') === 'chat', 'a thread a person started is Chat');
ok(look('sys') === 'other', 'a thread the system started, with no trigger and no parent, is Other');
ok(look('kid-of-trig') === 'trigger' && look('grandkid') === 'trigger', 'a sub-thread inherits its root: Trigger');
ok(look('kid-of-chat') === 'chat', 'and Chat');
ok(look('orphan') === null, 'a sub-thread whose parent is gone is unknown, not guessed');
ok(look('loop-a') === null, 'a parent cycle is unknown, and terminates');
ok(look('blank-trigger') === 'chat', 'an empty trigger id is no trigger');
ok(tc.originOfSummary(undefined, look) === null, 'a thread with no summary is unknown');

console.log('\n41. a live call is filed by origin, exactly as the rollup files it');
const mkT = (seq, tid, producer, inT, purpose) => {
  const e = { seq, created:new Date().toISOString(), thread_id:tid,
    event:{ type:'ContextCaptured', model:'acme-1', producer, usage:{ input_tokens:inT, cache_read_tokens:0, cache_creation_tokens:0, output_tokens:0 } } };
  if (purpose) e.event.purpose = purpose;
  return e;
};
const liveCalls = [
  mkT(999501, 'th-chat', 'main_llm', 1e6),
  mkT(999502, 'th-trig', 'main_llm', 2e6),
  mkT(999503, 'th-none', 'main_llm', 4e6),
  mkT(999504, 'th-sys', 'main_llm', 8e6),
  mkT(999505, 'th-trig', 'auxiliary', 16e6, 'title'),
  mkT(999506, 'th-chat', 'claude_code', 32e6),
];
const origins41 = { chat:['th-chat'], trigger:['th-trig'], other:['th-sys'] };
const subtypeTable = () => {
  tc.setGroups(['type', 'subtype']); tc.expand('/type:main_llm'); tc.render();
  return rowsOf().map((r) => r.replace(/\s+/g, ' ')).sort().join('\n') + '\n' + money();
};
// Historical: the same calls as the rollup would file them, with every field
// a current rollup writes, so the two tables can be compared whole.
const hb = (inT) => ({ ...bucket(1, inT, 0), cached_calls:0, max_in:inT });
tc.resetLive(); tc.resetOrigins();
tc.setDaily({ ...empty, thread_origins: origins41, days:{ [today]: {
  'main_llm:chat|acme-1': hb(1e6), 'main_llm:trigger|acme-1': hb(2e6),
  'main_llm|acme-1': hb(4e6), 'main_llm:other|acme-1': hb(8e6),
  'auxiliary:title|acme-1': hb(16e6), 'claude_code|acme-1': hb(32e6),
}}, hours:{} });
const historical = subtypeTable();
// Live: no stored rows, the calls arrive over the stream.
tc.resetLive(); tc.resetOrigins();
tc.setDaily({ ...empty, thread_origins: origins41, days:{}, hours:{} });
tc.noteThreadOrigins(origins41);
for (const e of liveCalls) tc.pushLive(e, { quiet:true });
const liveTable = subtypeTable();
ok(liveTable === historical, 'live and historical give the same Type:subtype table');
ok(/noteThreadOrigins\(daily\.thread_origins\)/.test(src), "a load reads the rollup's origin map");
ok(/\$63\.00/.test(liveTable), 'and the same total');
const liveKeys = Object.keys(tc.seriesForDay(today));
ok(liveKeys.includes('main_llm:chat|acme-1') && liveKeys.includes('main_llm:trigger|acme-1'), 'the live series keys carry the origin');
ok(liveKeys.includes('main_llm|acme-1'), 'a thread no source names stays unknown');
ok(liveKeys.includes('auxiliary:title|acme-1') && !liveKeys.includes('auxiliary:title:trigger|acme-1'), 'an auxiliary call in a trigger thread stays auxiliary');
ok(tc.countedLive().find((c) => c.seq === 999506).producer === 'claude_code', 'Claude Code in a chat thread stays Claude Code');
tc.setThreads({ last_sequence:0, fields:['calls','cached_calls','in'], threads:{}, days:{}, hours:{} });
tc.setGroups(['thread', 'subtype']); tc.render();
ok(/\$63\.00/.test(money()), 'the Thread view sums to the same total');
tc.setThreads(null);

console.log('\n42. an origin learned after the call moves it, and moves no money');
tc.resetLive(); tc.resetOrigins();
tc.setDaily({ ...empty, days:{}, hours:{} });
tc.pushLive(mkT(999601, 'th-new', 'main_llm', 2e6), { quiet:true });
tc.pushLive(mkT(999602, 'th-new-kid', 'main_llm', 1e6), { quiet:true });
ok(tc.countedLive().every((c) => c.producer === 'main_llm'), 'before its thread is known, a call is Origin unknown');
tc.setGroups(['type']); tc.render();
const before42 = heroMoney();
const added42 = tc.learnThreadOrigins([
  { thread_id:'th-new-kid', channel:'chat', initiator:'system', parent_thread_id:'th-new' },
  { thread_id:'th-new', channel:'trigger', initiator:'system', trigger_id:'x' },
]);
ok(added42 === 2, 'the thread list teaches both, the sub-thread through its parent: '+added42);
ok(tc.countedLive().every((c) => c.producer === 'main_llm:trigger'), 'both calls move to Trigger');
tc.render();
ok(heroMoney() === before42 && before42 === '$3.00', 'the total does not move: '+before42+' -> '+heroMoney());
ok(tc.learnThreadOrigins([{ thread_id:'th-new', channel:'chat', initiator:'user' }]) === 0, 'an origin once known is not overwritten');
ok(tc.threadOrigins.get('th-new') === 'trigger', 'it stays Trigger');

console.log('\n43. the live lookup asks the thread list for an unknown thread, and not forever');
tc.resetLive(); tc.resetOrigins();
let listCalls = 0;
lucidos.threads = { list: async (o) => { listCalls++; return [{ thread_id:'th-late', channel:'chat', initiator:'user' }]; } };
tc.pushLive(mkT(999701, 'th-late', 'main_llm', 1e6), { quiet:true });
tc.pushLive(mkT(999702, 'th-lost', 'main_llm', 1e6), { quiet:true });
await tc.lookupOrigins();
ok(listCalls === 1, 'one list call for the unknown threads');
ok(tc.countedLive().find((c) => c.seq === 999701).producer === 'main_llm:chat', 'the listed thread is filed as Chat');
ok(tc.countedLive().find((c) => c.seq === 999702).producer === 'main_llm', 'the missing one stays unknown, not guessed');
await tc.lookupOrigins();
ok(listCalls === 1, 'a second lookup within the throttle does not call again');
lucidos.threads = { list: async () => [] };
tc.resetLive(); tc.resetOrigins();

console.log('\n44. a thread with two agent sessions shows one row per session');
tc.setPricing(tableWith({ 'acme-1': { uncached_in:1, cache_write:0, cache_read:0, out:0 } }));
tc.resetLive();
tc.threadMeta.set('two', { title:'Two-session thread', parent:null });
tc.threadMeta.set('old', { title:'Old chain', parent:null });
tc.threadMeta.set('old2', { title:'Old chain, continued', parent:null, before:'old' });
const F44 = ['calls','cached_calls','in','cache_read','cache_write','out','seconds','max_in'];
tc.setDaily({ ...empty, last_sequence:0, days:{ [today]: {
  'claude_code|acme-1|high': { ...bucket(2, 2e6, 0), cached_calls:2 },
  'codex|acme-1': { ...bucket(1, 1e6, 0), cached_calls:1 },
  'claude_code|acme-1': { ...bucket(3, 3e6, 0), cached_calls:3 },
} }, hours:{} });
tc.setThreads({ last_sequence:0, fields:F44, days:{ [today]: {
  'two@1': { 'claude_code|acme-1|high': [2, 2, 2e6, 0, 0, 0, 0, 150000] },
  'two@2': { 'codex|acme-1': [1, 1, 1e6, 0, 0, 0, 0, 40000] },
  'old':   { 'claude_code|acme-1': [1, 1, 1e6, 0, 0, 0, 0, 90000] },
  'old2':  { 'claude_code|acme-1': [2, 2, 2e6, 0, 0, 0, 0, 80000] },
} }, hours:{} });
tc.setGroups(['thread']);
tc.render();
let r44 = rowsOf();
const row44 = (rows, re) => rows.find((r) => re.test(r)) || '';
ok(r44.length === 2, 'one row per piece of work, the legacy chain folded into one: '+r44.length);
ok(/\$3\.00/.test(row44(r44, /Two-session thread/)), 'the thread row carries both sessions');
ok(/150\.0k · 40\.0k/.test(row44(r44, /Two-session thread/)), 'its context column shows each session\'s peak, not one max');
ok(/Peak per session/.test(row44(r44, /Two-session thread/)), 'and names them');
ok(/\$3\.00/.test(row44(r44, /Old chain</)) && /\+1 sub/.test(row44(r44, /Old chain</)), 'a legacy chain is one row, its successor folded in');
tc.expand('/thread:two');
tc.render();
r44 = rowsOf();
const s1 = row44(r44, /Session 1 · /), s2 = row44(r44, /Session 2 · /);
ok(/Claude Code · acme-1 · high/.test(s1) && /\$2\.00/.test(s1), 'session 1 names its implementer and its own cost: '+s1.slice(0, 160));
ok(/Codex · acme-1/.test(s2) && /\$1\.00/.test(s2), 'session 2 names its own backend and cost');
ok(/\/ 150\.0k/.test(s1) && /\/ 40\.0k/.test(s2), 'each session row shows its own peak');
ok(r44.indexOf(s1) < r44.indexOf(s2), 'sessions read oldest first');
tc.expand('/thread:old');
tc.render();
ok(/successor thread/.test(row44(rowsOf(), /Old chain, continued/)), 'the old successor thread says what it is');
ok(/Total.*\$6\.00/.test(document.getElementById('an-total').innerHTML), 'the total is unchanged by the session split');

// One session still draws its row, with its time span and its keep-alive
// pings on their own line under it.
tc.setThreads({ last_sequence:0, fields:F44, days:{ [today]: { 'two@1': {
  'claude_code|acme-1|high': [2, 2, 2e6, 0, 0, 0, 0, 150000],
  'cache_keep_alive|acme-1|high': [3, 3, 5e5, 0, 0, 0, 0, 150000],
} } }, sessions:{ 'two@1': [today+'T08:05:00Z', today+'T09:40:00Z'] }, hours:{} });
tc.expand('/thread:two');
tc.render();
let r44b = rowsOf();
const one = row44(r44b, /Session 1 · /);
ok(/Claude Code · acme-1 · high/.test(one) && /\$2\.50/.test(one), 'a one-session thread shows its session row, keep-alive in its cost: '+one.slice(0, 200));
ok(!/\+1 model/.test(one), 'keep-alive pings never name the session or count as another model');
const hm = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
ok(one.includes(`${hm(today+'T08:05:00Z')}–${hm(today+'T09:40:00Z')}`), 'the session row shows its first and last call');
const ka = row44(r44b, /Cache keep-alive/);
ok(/\$0\.50/.test(ka) && r44b.indexOf(ka) === r44b.indexOf(one) + 1, 'its keep-alive pings sit on their own line right under it');
ok(!/class="an-row kids/.test(one) && !/▸|▾/.test(one), 'the session row has no twisty: its keep-alive line always shows');
// A live call above the cursor stretches the span.
const late = mk(999700, today+'T10:15:00Z', 'claude_code', 'acme-1', [1000, 0, 0, 10]);
late.thread_id = 'two'; late.event.session = 1;
tc.pushLive(late, { quiet:true });
tc.render();
ok(row44(rowsOf(), /Session 1 · /).includes(`–${hm(today+'T10:15:00Z')}`), 'a live call moves the session\'s last call');
tc.resetLive();
// No span on file and no live call: the row shows no time.
tc.setThreads({ last_sequence:0, fields:F44, days:{ [today]: { 'two@1': { 'claude_code|acme-1|high': [2, 2, 2e6, 0, 0, 0, 0, 150000] } } }, hours:{} });
tc.render();
r44b = rowsOf();
ok(!/an-span/.test(row44(r44b, /Session 1 · /)), 'a session with no span on file shows no time');
ok(!/Cache keep-alive/.test(r44b.join('')), 'a session with no keep-alive ping draws no keep-alive line');
// Calls from before sessions were stamped draw no session row on their own.
tc.setThreads({ last_sequence:0, fields:F44, days:{ [today]: { 'two': { 'claude_code|acme-1|high': [2, 2, 2e6, 0, 0, 0, 0, 150000] } } }, hours:{} });
tc.render();
ok(!/Before sessions were recorded/.test(rowsOf().join('')), 'a thread from before sessions shows no session row');

// The live frame dedupe never compares across a session boundary.
tc.setDaily({ ...empty, last_sequence:0, days:{}, hours:{} });
tc.resetLive();
const at44 = new Date().toISOString();
const ses = (seq, session) => { const e = mk(seq, at44, 'claude_code', 'acme-1', [5000, 4000, 0, 50]); e.event.session = session; return e; };
tc.pushLive(ses(999801, 1), { quiet:true });
tc.pushLive(ses(999802, 1), { quiet:true });
ok(tc.countedLive().length === 1, 'a repeat inside one session is a re-delivered frame');
tc.pushLive(ses(999803, 2), { quiet:true });
ok(tc.countedLive().length === 2, 'the same usage as the first call of the next session is a new call');
ok(tc.countedLive()[1].session === '2', 'a live call keeps its session');
tc.resetLive();
tc.setThreads({ last_sequence:0, fields:[], days:{}, hours:{} });
tc.setGroups(['type', 'model']);

console.log('\n45. the handoff view: narrative cost, cost per call either side, verdicts held');
tc.setPricing(tableWith({ 'acme-1': { uncached_in:1, cache_write:0, cache_read:0, out:0 } }));
const HF = ['calls','cached_calls','in','cache_read','cache_write','out','seconds','max_in'];
const ho = (o) => ({ kind:'session', thread:'two', to_thread:'two', from_session:1, to_session:2, day:today,
  at:today+'T10:00:00Z', opening:'narrative', checkpoint:'phase-commit', progress:'2/5', pays:true,
  from:'claude_code|acme-1|high', to:'codex|acme-1', narrative:{ 'claude_code|acme-1|high': [2, 2, 1e6] },
  before:{ 'claude_code|acme-1|high': [10, 10, 4e6] }, after:{ 'codex|acme-1': [10, 10, 1e6] }, ...o });
// Warm and paid: 0.40 a call before, 0.10 after. Cold, said pays, got dearer.
// A legacy successor thread with no recorded opening. One with no checkpoint.
tc.setHandoffs({ fields:HF, threads:{ two:'Two-session thread', old:'Old chain' }, handoffs:[
  ho({}),
  ho({ at:today+'T11:00:00Z', opening:'brief', narrative:null, from_session:2, to_session:3,
       before:{ 'codex|acme-1': [10, 10, 1e6] }, after:{ 'claude_code|acme-1': [10, 10, 2e6] } }),
  ho({ kind:'thread', thread:'old', to_thread:'old2', from_session:null, to_session:null, opening:null, pays:false,
       before:{ 'claude_code|acme-1': [10, 10, 2e6] }, after:{ 'claude_code|acme-1': [10, 10, 3e6] } }),
  ho({ checkpoint:null, pays:null }),
  ho({ day:'2001-01-01' }),
] });
const m45 = tc.measureHandoff(ho({}), HF);
ok(Math.abs(m45.narrative.cost - 1) < 1e-9, 'a warm handoff\'s narrative turn is priced: '+m45.narrative.cost);
ok(Math.abs(m45.perBefore - 0.4) < 1e-9 && Math.abs(m45.perAfter - 0.1) < 1e-9, 'cost per call either side');
ok(Math.abs(m45.change + 0.75) < 1e-9 && m45.held === true, 'calls got 75% cheaper, so a pays verdict held');
const block45 = document.getElementById('handoff-block');
block45.open = true;
tc.render();
const body45 = () => document.getElementById('ho-body').innerHTML;
ok(/phase-commit/.test(body45()) && /No checkpoint/.test(body45()), 'one row per checkpoint, and one for none');
ok(/>3 <span class="muted">1 warm · 1 cold · 1 successor thread<\/span>/.test(body45()), 'the group counts warm, cold and legacy handoffs: '+(body45().match(/>3 <span[^<]*<\/span>/)||[''])[0]);
ok(/2 of 3/.test(body45()), 'the warm pays and the legacy no-pay held, the cold pays did not');
ok(!/2001/.test(body45()), 'a handoff outside the range is left out');
tc.handoffOpen.add('phase-commit');
tc.render();
ok(/session 1 → 2/.test(body45()) && /Claude Code · acme-1 · high → Codex · acme-1/.test(body45()), 'a handoff names its sessions and the implementer change');
ok(/successor thread/.test(body45()) && /opening not recorded/.test(body45()), 'a legacy handoff says what it is and that its opening is unknown');
ok(/cold/.test(body45()) && /pays · missed/.test(body45()), 'the cold handoff got dearer, so its pays verdict missed');
block45.open = false;
tc.handoffOpen.clear();
tc.setHandoffs(null);

console.log('\n46. Cache spend uses reported lifetime prices and dated, served-model cards');
const cacheDay = '2026-10-20', cacheNext = '2026-10-21';
const cacheCard = { uncached_in:2, cache_read:0.2, cache_write:2.5, cache_write_1h:4, cache_write_12h:5, out:10,
  long:{ threshold_tokens:200000, uncached_in:4, cache_read:0.4, cache_write:5, cache_write_1h:8, cache_write_12h:10, out:20 },
  flex:{ uncached_in:1, cache_read:0.1, cache_write:1.25, cache_write_1h:2, cache_write_12h:2.5, out:5 } };
tc.setPricing(tableWith({ 'cache-model': [{ ...cacheCard }, { ...cacheCard, from:cacheNext, cache_write_1h:6 }] }));
const cacheCall = (o={}) => ({ day:cacheDay, model:'cache-model', producer:'claude_code', thread:'cache-thread', session:'1', effort:'high',
  usage:{ input_tokens:100000, cache_read_tokens:30000, cache_creation_tokens:50000, output_tokens:1000 },
  parts:{'5m':20000,'1h':30000}, ping:false, cause:'unknown', ...o });
const cp = tc.priceCacheCall(cacheCall());
ok(Math.abs(cp.write - 0.17) < 1e-9 && Math.abs(cp.read - 0.006) < 1e-9 && Math.abs(cp.fresh - 0.04) < 1e-9,
  'writes split by lifetime; uncached input subtracts both cache classes');
ok(Math.abs(cp.ping - 0.226) < 1e-9, 'ping spend includes output as well as all input components');
ok(Math.abs(tc.priceCacheCall(cacheCall({ day:cacheNext })).write - 0.23) < 1e-9, 'the card in force on each call day prices that day');
const longCache = cacheCall(); longCache.usage.input_tokens = 250000;
ok(Math.abs(tc.priceCacheCall(longCache).write - 0.34) < 1e-9, 'long-context cache write uses long lifetime rates');
const flexCache = cacheCall(); flexCache.usage.service_tier = 'flex';
ok(Math.abs(tc.priceCacheCall(flexCache).write - 0.085) < 1e-9, 'Flex uses its own lifetime rates');
flexCache.usage.input_tokens = 250000;
ok(Math.abs(tc.priceCacheCall(flexCache).write - 0.34) < 1e-9, 'long and Flex are exclusive, as in the existing accounting');
ok(tc.priceCacheCall(cacheCall({ model:'no-price' })).read === null, 'unpriced cache calls remain unknown');
ok(Math.abs(tc.priceCacheCall(cacheCall({ parts:null })).write - 0.125) < 1e-9, 'a missing TTL prices at the base write rate, never a guessed premium');
ok(Math.abs(tc.priceCacheCall(cacheCall({ parts:{'12h':50000} })).write - 0.25) < 1e-9, '12-hour writes use the price-table premium');

console.log('\n47. Keep-alive savings price only evidenced token rewrites');
const cacheSaving = (o={}) => ({ day:cacheDay, model:'cache-model', producer:'cache_keep_alive', thread:'cache-thread', effort:'high',
  tokens:100000, ttl:'1h', prompt:100000, ...o });
ok(Math.abs(tc.priceCacheSaving(cacheSaving()) - 0.4) < 1e-9, 'avoided rewrite spend comes from tokens and the current price table');
ok(Math.abs(tc.priceCacheSaving(cacheSaving({ day:cacheNext })) - 0.6) < 1e-9, 'avoided rewrites respect dated price cards');
ok(tc.priceCacheSaving(cacheSaving({ tokens:null })) === null && tc.priceCacheSaving(cacheSaving({ ttl:null })) === null,
  'missing saving or TTL stays unknown');
ok(tc.priceCacheSaving(cacheSaving({ model:'no-price' })) === null, 'an unpriced saved rewrite is unknown');

console.log('\n48. Cache views share range, groups and type filter without losing unknowns');
const cacheDoc = { version:1, generated:'2026-10-20T10:00:00Z', calls:[
  cacheCall(), cacheCall({ cause:'ttl_expiry' }), cacheCall({ cause:'handoff' }), cacheCall({ cause:'model_switch' }),
  cacheCall({ ping:true, producer:'cache_keep_alive', cause:null }),
  cacheCall({ day:cacheNext }), cacheCall({ model:'no-price', cause:'unknown' }),
], savings:[cacheSaving(), cacheSaving({ tokens:null, ttl:null })] };
tc.setGroups(['model']);
let cr = tc.cacheRows(cacheDoc, [cacheDay], 'all');
const pricedCacheRow = cr.find((r) => r.labels[0][1] === 'cache-model');
ok(cr.length === 2 && Math.abs(pricedCacheRow.money.write - 0.85) < 1e-9, 'range excludes later calls; spend sums per call');
ok(Object.values(pricedCacheRow.causes).every((n) => n === 1), 'the four cause buckets count evidence, including unknown');
ok(pricedCacheRow.pings === 1 && pricedCacheRow.runs === 2 && pricedCacheRow.unknown.saved === 1,
  'known savings and unknown runs are both retained');
ok(cr.find((r) => r.labels[0][1] === 'no-price').unknown.write === 1, 'unpriced spend carries an unknown count');
cr = tc.cacheRows(cacheDoc, [cacheDay], 'cache_keep_alive');
ok(cr.length === 1 && cr[0].pings === 1 && cr[0].runs === 2 && Object.values(cr[0].causes).every((n) => n === 0),
  'the keep-alive type filter includes pings and savings only');
tc.setGroups(['thread', 'type']);
cr = tc.cacheRows(cacheDoc, [cacheDay], 'all');
ok(cr.every((r) => r.labels.map(([d]) => d).join(',') === 'thread,type,model'), 'model stays visible alongside the chosen grouping');
tc.setGroups(['model_effort']);
cr = tc.cacheRows(cacheDoc, [cacheDay], 'all');
ok(cr[0].labels.length === 1 && cr[0].labels[0][1].includes('|high'), 'model:effort grouping keeps its effort without a duplicate model');
tc.setGroups(['model']);
tc.setCache(cacheDoc);
document.getElementById('cache-block').open = true;
tc.renderCacheStats([cacheDay], 'all');
ok(/unknown/.test(document.getElementById('cache-keep').innerHTML) && /unknown/.test(document.getElementById('cache-spend').innerHTML),
  'rendered savings and spend expose unknown amounts');
ok(/TTL expiry/.test(document.getElementById('cache-causes').innerHTML) && /Model switch/.test(document.getElementById('cache-causes').innerHTML),
  'rendered cause view names the evidence buckets');
ok(/next rollup/.test(document.getElementById('cache-note').textContent), 'cache view states its freshness separately from live totals');
tc.setCache(null);
tc.renderCacheStats([cacheDay], 'all');
ok(/unavailable/.test(document.getElementById('cache-note').textContent) && document.getElementById('cache-spend').innerHTML === '',
  'older snapshots without cache evidence show a missing state, never stale numbers');
const oldReadCache = lucidos.data.read;
lucidos.data.read = async () => JSON.stringify({ generated:'old', days:{} });
await tc.loadCacheStats();
ok(/unavailable/.test(document.getElementById('cache-note').textContent), 'an older or unsupported cache file is rejected visibly');
lucidos.data.read = oldReadCache;
document.getElementById('cache-block').open = false;

console.log('\n49. Existing totals keep TTL evidence through live, rollup, tier and compact-row paths');
const ttlUsage = cacheCall().usage;
const ttlBundle = { in:ttlUsage.input_tokens, cache_read:ttlUsage.cache_read_tokens, cache_write:ttlUsage.cache_creation_tokens,
  out:ttlUsage.output_tokens, ...tc.writeBundle({ ...ttlUsage, cache_creation_1h_tokens:30000 }) };
ok(Math.abs(tc.costOf('cache-model', ttlBundle, null, cacheDay) - cp.ping) < 1e-9,
  'existing totals agree with the cache view for mixed 5-minute and 1-hour writes');
const legacyTTL = { ...ttlBundle }; for (const k of ['cache_write_known', 'cache_write_1h', 'cache_write_12h']) delete legacyTTL[k];
// 20,000 fresh at 2 + 30,000 read at 0.2 + 50,000 written at the base 2.5 + 1,000 out at 10.
ok(Math.abs(tc.costOf('cache-model', legacyTTL, null, cacheDay) - 0.181) < 1e-9,
  'an older aggregate without lifetime evidence prices its write at the base rate, never unpriced');
tc.resetLive(); tc.setDaily({ ...empty, days:{}, hours:{} });
const ttlEvent = mk(101, cacheDay+'T12:00:00Z', 'claude_code', 'cache-model', [100000,30000,50000,1000]);
ttlEvent.event.usage.cache_creation_1h_tokens = 30000;
tc.pushLive(ttlEvent, { quiet:true });
const liveTTL = Object.values(tc.seriesForDay(cacheDay))[0];
ok(liveTTL.cache_write_known === 50000 && liveTTL.cache_write_1h === 30000
  && Math.abs(tc.costOf('cache-model', liveTTL, liveTTL.long, cacheDay) - cp.ping) < 1e-9,
  'SSE preserves write evidence while folding a live call');
tc.setDaily({ ...empty, last_sequence:101, days:{ [cacheDay]:{ 'claude_code|cache-model':liveTTL } }, hours:{} });
tc.resetLive();
const rolledTTL = Object.values(tc.seriesForDay(cacheDay))[0];
ok(Math.abs(tc.costOf('cache-model', rolledTTL, rolledTTL.long, cacheDay) - cp.ping) < 1e-9,
  'the rolled-up form preserves that same cost');
const compactTTL = tc.rowToU([100000,30000,50000,1000,50000,30000,0],
  ['in','cache_read','cache_write','out','cache_write_known','cache_write_1h','cache_write_12h']);
ok(Math.abs(tc.costOf('cache-model', compactTTL, compactTTL.long, cacheDay) - cp.ping) < 1e-9,
  'compact thread and handoff rows preserve the appended optional fields');
const mixedTTL = {};
let expectedTTL = 0;
for (const [i, flex] of [[100000,false],[250000,false],[100000,true]]) {
  const c = { ...ttlBundle, in:i, flex, model:'cache-model', producer:'claude_code', at:cacheDay+'T12:00:00Z' };
  tc.foldCall(mixedTTL, c);
  expectedTTL += tc.priceCacheCall(cacheCall({ usage:{ ...ttlUsage, input_tokens:i, ...(flex ? {service_tier:'flex'} : {}) } })).ping;
}
const mix = Object.values(mixedTTL)[0];
ok(Math.abs(tc.costOf('cache-model', mix, mix.long, cacheDay) - expectedTTL) < 1e-9,
  'normal, long and Flex write premiums remain exclusive when aggregated together');
ok(tc.writeBundle({cache_creation_tokens:100,cache_creation_requested_ttl:'12h'}).cache_write_12h === 100,
  'requested 12-hour evidence is retained by live accounting');
ok(tc.writeBundle({cache_creation_tokens:100,cache_creation_30m_tokens:10}).cache_write_known === 0,
  'an incomplete OpenAI split cannot establish the rest of the lifetime');
tc.resetLive(); tc.setDaily({ ...empty, days:{}, hours:{} });
const knownEvent = structuredClone(ttlEvent), unknownEvent = structuredClone(ttlEvent);
knownEvent.seq = 201; unknownEvent.seq = 202;
unknownEvent.event.producer = 'codex'; knownEvent.event.producer = 'codex';
delete unknownEvent.event.usage.cache_creation_1h_tokens;
tc.pushLive(knownEvent, { quiet:true }); tc.pushLive(unknownEvent, { quiet:true });
const separated = Object.values(tc.seriesForDay(cacheDay));
ok(separated.length === 2 && separated.every((u) => tc.costOf('cache-model', u, u.long, cacheDay) !== null),
  'a missing TTL stays in a separate bucket, and both calls are priced');
ok(Math.abs(separated.reduce((sum, u) => sum + tc.costOf('cache-model', u, u.long, cacheDay), 0) - (cp.ping + 0.181)) < 1e-9,
  'the known call keeps its premium; the unknown one adds its base-rate floor');

console.log('\n50. The hero counts calls priced at the base write rate and says why');
tc.setGroups(['model']);
tc.resetLive(); tc.setDaily({ ...empty, days:{ [today]:{
  'codex|cache-model|high|cache_ttl_unknown': { calls:2, in:200000, cache_read:0, cache_write:100000, out:0 },
  'claude_code|cache-model||cache_ttl_unknown': { calls:5, in:500000, cache_read:0, cache_write:250000, out:0 },
  'auxiliary:memory|cache-model||cache_ttl_unknown': { calls:1, in:100000, cache_read:0, cache_write:50000, out:0 },
  'claude_code|cache-model|high': { calls:9, in:900000, cache_read:0, cache_write:0, out:0 },
} }, hours:{} });
tc.render();
const ttlNote = document.getElementById('hero-ttl');
ok(ttlNote.hidden === false, 'the lifetime note shows when the range holds such calls');
ok(/Includes 8 calls with an unknown cache lifetime/.test(document.getElementById('hero-ttl-text').textContent),
  'it counts only the lifetime-unknown calls: ' + document.getElementById('hero-ttl-text').textContent);
const why = document.getElementById('hero-ttl-why').innerHTML;
ok(/<b>Claude Code<\/b>, 5 calls: Recorded before Lucidos 0\.49\.0/.test(why), 'Claude Code calls name the release that began saving the split: ' + why);
ok(/<b>Codex<\/b>, 2 calls: Codex reports one cache-write total, without the lifetime split/.test(why), 'Codex calls say Codex sends no split');
ok(/<b>Other calls<\/b>, 1 call: Recorded before Lucidos 0\.50\.0/.test(why), 'other calls name 0.50.0 or a route without the split');
ok(/base cache write rate/.test(why), 'and the note says what rate their writes got');
ok(document.getElementById('hero-unpriced').hidden === true, 'none of them is unpriced');

console.log('\n'+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
