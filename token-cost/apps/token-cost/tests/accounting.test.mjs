import fs from 'fs';
import path from 'path';
const WS = process.env.LUCIDOS_WORKSPACE ||
  path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..');
const P = (p) => path.join(WS, p);

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

const daily = JSON.parse(fs.readFileSync(P('data/artifacts/token-cost/daily.json'),'utf8'));
const pricingRaw = fs.readFileSync(P('data/artifacts/token-cost/pricing.json'),'utf8');

global.lucidos = {
  // Both engine calls go over the SDK bridge: the pager through
  // lucidos.events.query and /models through lucidos.request. An app frame
  // runs at an opaque origin, so its own fetch of the engine is CORS-refused.
  apiUrl: (s) => '/dev/api/v1' + (s.startsWith('/') ? s : '/' + s),
  ui:{ applyPreferences(){}, watchPreferences(){}, enhanceSelects(){}, toast(){},
       Select:{ create:(o)=>({element:mkEl('sel'), getValue:()=>o.value, setValue(){}, setOptions(){}, destroy(){}}) } },
  data:{ read: async (p)=> p.includes('pricing') ? pricingRaw : p.includes('ui-state') ? '{}' : JSON.stringify(daily), write: async()=>({success:true}), url:(p)=> p.startsWith('system-knowhow/') ? '/dev/api/v1/data/'+p : '/dev/data/'+p },
  // The pager goes through lucidos.events.query; stubbed empty here because
  // these tests drive the accounting directly via pushLive. `/models` goes
  // through the generic bridged call, which has no labels to give.
  events:{ query: async () => [] }, request: async () => [],
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
  cardOn, cardsOf, savedModels, checkFrom, servedAsSent, pricedModel,
  setDaily(d){ daily = d; }, setPricing(p){ pricing = p; },
  get daily(){ return daily; },
  get metaText(){ return document.getElementById('meta').textContent; },
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
  event:{type:'ContextCaptured',model,producer,usage:{input_tokens:u[0],cache_read_tokens:u[1],cache_creation_tokens:u[2],output_tokens:u[3]}}});

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
  long_context_multiplier:{ threshold_tokens:200000, in_multiplier:1, out_multiplier:1 },
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
ok(tc.longThreshold('claude-opus-5[1m]') === 200000, 'a card with no tier falls back to the global split');
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
  long_context_multiplier:{ threshold_tokens:200000, in_multiplier:1, out_multiplier:1 },
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

console.log('\n15. pricing.json is the only table');
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
const foot = document.getElementById('tfoot').innerHTML;
ok(/Total.*priced.*\$5\.00/.test(foot) && /Unpriced.*not in total/.test(foot), 'the footer splits priced and unpriced');
ok(!/\$40\.00/.test(foot), 'and nothing anywhere folds the unpriced calls in at the Opus card');
tc.setDaily({ ...empty, days:{ [today]: { 'main_llm|claude-opus-5': bucket(2, 1e6, 0) } }, hours:{} });
tc.render();
ok(document.getElementById('hero-unpriced').hidden === true, 'with every model priced the note hides');
ok(!/Unpriced/.test(document.getElementById('tfoot').innerHTML), 'and the footer is one row again');

console.log('\n18. the day selector names the zone days are cut in');
// run.sh pins TZ=Europe/Oslo.
ok(tc.dayZoneLabel(new Date('2026-07-01T12:00:00Z')) === 'Days in Europe/Oslo (UTC+2)',
   'summer: '+tc.dayZoneLabel(new Date('2026-07-01T12:00:00Z')));
ok(tc.dayZoneLabel(new Date('2026-01-15T12:00:00Z')) === 'Days in Europe/Oslo (UTC+1)',
   'winter: '+tc.dayZoneLabel(new Date('2026-01-15T12:00:00Z')));
ok(document.getElementById('tz-note').textContent.startsWith('Days in Europe/Oslo'),
   'render writes it next to the selector');


// --- price history ---------------------------------------------------------
// A provider changes its prices. A day must be priced at the card in force ON
// that day, so a later price change never reprices the days before it.
const dayOffset = (n) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n); return tc.localDay(d); };
const D2 = dayOffset(-2), D1 = dayOffset(-1);
const tableWith = (models) => ({ currency:'USD', models,
  long_context_multiplier:{ threshold_tokens:200000, in_multiplier:1, out_multiplier:1 }, producers:{}, fx:{ rates:{USD:1} } });
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
ok(/Total.*\$59\.00/.test(document.getElementById('tfoot').innerHTML), 'and the footer');

console.log('\n20. a plain object card still loads, as one undated card');
tc.setPricing(tableWith({ 'acme-1': { uncached_in:5, cache_write:0, cache_read:0.5, out:30 } }));
ok(near(tc.costOf('acme-1', oneM, oneM.long, '2020-01-01'), 35), 'priced on an old day');
ok(near(tc.costOf('acme-1', oneM, oneM.long, today), 35), 'and today');
ok(near(tc.costOf('acme-1', oneM, oneM.long), 35), 'and with no day given');
const saved = tc.savedModels({ 'acme-1': { uncached_in:5, out:30 }, 'acme-2': [
  { from:'2026-08-21', uncached_in:4, out:20, source:'b' }, { uncached_in:5, out:30, source:'a' } ] });
ok(Array.isArray(saved['acme-1']) && saved['acme-1'].length === 1 && !('from' in saved['acme-1'][0]),
   'a save writes the plain card as a one-card list');
ok(saved['acme-2'][0].source === 'a' && Object.keys(saved['acme-2'][1])[0] === 'from',
   'cards are saved oldest first, `from` leading a dated card');

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

console.log('\n25. a card without a usable threshold falls back to the global one');
const withGlobal = (models, t) => ({ ...tableWith(models), long_context_multiplier:{ threshold_tokens:t, in_multiplier:1, out_multiplier:1 } });
tc.setPricing(withGlobal({ 'acme-1': { uncached_in:1, out:1 },
  'acme-2': { uncached_in:1, out:1, long:{ threshold_tokens:'abc', uncached_in:2, out:2 } } }, 150000));
ok(tc.longThreshold('acme-1', today) === 150000, 'a tier-less card splits at the global threshold, as the rollup does');
ok(tc.longThreshold('acme-2', today) === 150000, 'a threshold that is not a number is skipped');
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
same.event.served_model = 'gemini-3.6-flash-001';
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

console.log('\n'+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
