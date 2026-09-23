import fs from 'fs';
import path from 'path';
const WS = process.env.LUCIDOS_WORKSPACE ||
  path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..');
const P = (p) => path.join(WS, p);

const html = fs.readFileSync(P('data/apps/token-cost/index.html'),'utf8');
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
global.window.lucidos = null;  // set after the SDK stub is built
Object.defineProperty(globalThis,'navigator',{value:{platform:'MacIntel',userAgent:'node',maxTouchPoints:0},configurable:true});
global.performance = { now:()=>Date.now() };
global.localStorage = { getItem:()=>null, setItem(){}, };
global.setInterval = ()=>0;
global.setTimeout = (f)=>{ return 0; };
global.clearTimeout = ()=>{};
globalThis.__store = [];         // newest-first rows the fake event store returns
globalThis.__queryFail = false;  // when set, lucidos.events.query throws
globalThis.__queryCalls = 0;
globalThis.__modelsFail = false; // when set, lucidos.request('/models') throws
globalThis.__fetchFail = false;
globalThis.__fetchCalls = 0;
// Nothing in the app should raw-fetch the engine any more: the pager reads the
// store through lucidos.events.query and /models goes through lucidos.request,
// both stubbed below. The stub counts calls so a test can assert there are none.
global.fetch = async () => {
  globalThis.__fetchCalls++;
  if (globalThis.__fetchFail) throw new TypeError('Load failed');
  return { ok:true, json: async()=>[] };
};
global.URL = URL;
global.Intl = Intl;

const daily = JSON.parse(fs.readFileSync(P('data/artifacts/token-cost/daily.json'),'utf8'));
const pricingRaw = fs.readFileSync(P('data/artifacts/token-cost/pricing.json'),'utf8');

global.lucidos = {
  apiUrl: (s) => '/dev/api/v1' + (s.startsWith('/') ? s : '/' + s),
  ui:{ applyPreferences(){}, watchPreferences(){}, enhanceSelects(){}, toast(){},
       Select:{ create:(o)=>({element:mkEl('sel'), getValue:()=>o.value, setValue(){}, setOptions(){}, destroy(){}}) } },
  data:{ read: async (p)=> p.includes('pricing') ? pricingRaw : p.includes('ui-state') ? '{}' : JSON.stringify(daily), write: async()=>({success:true}), url:(p)=> p.startsWith('system-knowhow/') ? '/dev/api/v1/data/'+p : '/dev/data/'+p },
  events:{
    // The catch-up pager reads the store through here now, not a raw fetch: an
    // app frame has an opaque origin (ADR 0227), so a direct fetch of the
    // engine is CORS-refused, and the SDK bridge is the only path. Mirrors the
    // engine's /events/query: newest-first, filtered by `since` and the
    // exclusive `before_event_id` cursor, clamped to `limit`.
    query: async ({ since, limit, before_event_id } = {}) => {
      globalThis.__queryCalls++;
      if (globalThis.__queryFail) throw new Error('offline');
      const from = new Date(since).getTime();
      let rows = globalThis.__store.filter(r => new Date(r.created).getTime() >= from);
      if (before_event_id) { const i = rows.findIndex(r=>r.id===before_event_id); rows = i<0?rows:rows.slice(i+1); }
      return rows.slice(0, limit);
    },
  },
  // `/models` has no SDK namespace, so it goes through the generic bridged
  // call. Same reason: this frame's own fetch cannot reach the engine.
  request: async () => { if (globalThis.__modelsFail) throw new Error('offline'); return []; },
  sse:{ connect(){}, on(){} },
  utils:{ escapeHtml:(s)=>String(s), timeAgo:()=>'1m ago' },
};

// expose internals for assertions
const harness = src + `
;globalThis.__tc = {
  pushLive, render, get live(){return live;}, countedLive, get seenSeq(){return seenSeq;},
  seriesForDay, selectedDays, knownDays, localDay, costOf,
  setDaily(d){ daily = d; }, setPricing(p){ pricing = p; },
  get daily(){ return daily; },
  get metaText(){ return document.getElementById('meta').textContent; },
  resetLive(){ live=[]; seenSeq=new Set(); liveRevision++; }, setSseOpenedAt(t){ sseOpenedAt=t; }, resetHealth(){ streamMissed=0; lastCatchUpFailed=false; lastCatchUpError=null; lastCatchUpAt=0; }, catchUp, loadModelLabels, get modelLabelsUnavailable(){return modelLabelsUnavailable;}, get lastCatchUpFailed(){return lastCatchUpFailed;}, get streamMissed(){return streamMissed;}, isStale, get feedRows(){ return document.getElementById('feed').children.map(c=>c.dataset.at); }, renderFeed,
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

const empty = {generated:new Date().toISOString(), last_sequence:0,
  bucket_edges:[0,32000,64000,128000,200000,400000], days:{}, hours:{}};
const row=(seq,at,producer,u)=>({ id:'e'+seq, sequence:seq, created:at, thread_id:'t1',
  payload:{model:'claude-opus-5',producer,usage:{input_tokens:u[0],cache_read_tokens:u[1],cache_creation_tokens:u[2],output_tokens:u[3]}}});

console.log('\n11. a dead stream is recovered by the reconcile');
tc.setDaily({...empty, days:{}});
tc.resetLive();
const now = Date.now();
// The store has five calls. SSE delivered NONE of them: this is the frozen
// dashboard Kenneth saw, connected-looking and hours behind.
//
// They are stamped AFTER `sseOpenedAt`, which the harness pins to the epoch
// below. The app deliberately exempts anything older than the moment this
// page opened its stream, because no EventSource here could have carried it,
// so past-stamped rows would be recovered without ever being counted missed.
// That exemption is real behaviour (added 2026-08-20 against a false "dropped
// 18 calls" on a tab forty-five seconds old), and test 11 is about the OTHER
// case: calls the stream genuinely should have delivered.
tc.setSseOpenedAt(now - 10 * 60000);
globalThis.__store = [4,3,2,1,0].map(i =>
  row(500+i, new Date(now - i*60000).toISOString(), 'main_llm', [100+i,0,0,10]));
ok(tc.countedLive().length===0, 'starts with nothing live');
await tc.catchUp();
ok(tc.countedLive().length===5, 'the reconcile recovers all five, got '+tc.countedLive().length);
ok(tc.streamMissed===5, 'and records that the stream missed them, got '+tc.streamMissed);
ok(tc.metaText.includes('live stream dropped 5 calls'), 'the header says so: '+tc.metaText);

console.log('\n12. a second pass over the same store adds nothing');
const n12 = tc.countedLive().length;
await tc.catchUp();
ok(tc.countedLive().length===n12, 'the reconcile is idempotent, got '+tc.countedLive().length);

console.log('\n13. SSE and the reconcile racing over one call');
globalThis.__store.unshift(row(510, new Date(now+60000).toISOString(),'main_llm',[999,0,0,9]));
tc.pushLive({seq:510, created:new Date(now+60000).toISOString(), thread_id:'t1',
  event:{type:'ContextCaptured',model:'claude-opus-5',producer:'main_llm',
    usage:{input_tokens:999,cache_read_tokens:0,cache_creation_tokens:0,output_tokens:9}}});
const n13 = tc.countedLive().length;
await tc.catchUp();
ok(tc.countedLive().length===n13, 'the call is counted once, got '+tc.countedLive().length);

console.log('\n14. a hole behind the stream is still filled');
tc.setDaily({...empty, days:{}});
tc.resetLive();
globalThis.__store = [603,602,601,600].map(s =>
  row(s, new Date(now - (610-s)*60000).toISOString(),'main_llm',[s,0,0,1]));
// SSE delivered only the newest and the oldest; 601 and 602 were dropped.
for (const s of [600,603]) {
  const r = globalThis.__store.find(x=>x.sequence===s);
  tc.pushLive({seq:r.sequence, created:r.created, thread_id:'t1', event:{...r.payload,type:'ContextCaptured'}});
}
ok(tc.countedLive().length===2, 'two of four arrived over SSE');
await tc.catchUp();
ok(tc.countedLive().length===4, 'the reconcile fills the hole between them, got '+tc.countedLive().length);

console.log('\n15. a failing reconcile says so instead of going quiet');
globalThis.__queryFail = true;
await tc.catchUp();
ok(tc.lastCatchUpFailed===true, 'the failure is recorded');
ok(tc.isStale()===true, 'and the dashboard reads as stale');
ok(/not reaching the event store \(.+\)/.test(tc.metaText), 'the header says so: '+tc.metaText);
globalThis.__queryFail = false;
await tc.catchUp();
ok(tc.lastCatchUpFailed===false, 'recovery clears it');
ok(!tc.metaText.includes('not reaching'), 'and the header stops warning: '+tc.metaText);

console.log('\n16. an overdue rollup is visible');
tc.setDaily({...empty, generated:new Date(now - 3*3600*1000).toISOString()});
tc.render();
ok(tc.isStale()===true, 'a three-hour-old rollup is stale');
ok(tc.metaText.includes('rollup overdue'), 'the header says so: '+tc.metaText);

console.log('\n17. a healthy dashboard stays quiet');
tc.setDaily({...empty, generated:new Date().toISOString()});
tc.resetLive();
tc.resetHealth();
tc.render();
ok(tc.isStale()===false, 'fresh rollup, no warning');
ok(!/stale|overdue|dropped|not reaching/.test(tc.metaText), 'header carries no scare text: '+tc.metaText);

console.log('\n18. the reconcile window covers an unrolled tail from before today');
tc.setDaily({...empty, days:{}, generated:new Date(now - 26*3600*1000).toISOString()});
tc.resetLive();
tc.resetHealth();
globalThis.__store = [row(700, new Date(now - 20*3600*1000).toISOString(),'main_llm',[70,0,0,7])];
await tc.catchUp();
ok(tc.countedLive().length===1, 'a call from 20h ago, older than midnight, is recovered');

console.log('\n19. the catch-up pager goes through the SDK, never a raw fetch');
tc.setDaily({...empty, days:{}});
tc.resetLive(); tc.resetHealth();
globalThis.__store = [row(800, new Date(now).toISOString(),'main_llm',[80,0,0,8])];
globalThis.__queryCalls = 0;
let rawEventsFetch = false;
const realFetch = global.fetch;
global.fetch = async (u) => { if (String(u).includes('/events/query')) rawEventsFetch = true; return realFetch(u); };
await tc.catchUp();
ok(globalThis.__queryCalls > 0, 'it reads the store via lucidos.events.query, got '+globalThis.__queryCalls+' calls');
ok(rawEventsFetch === false, 'and never raw-fetches /events/query, the CORS-refused path that froze the dashboard in a frame');
ok(tc.countedLive().length===1, 'and still recovers the call, got '+tc.countedLive().length);
global.fetch = realFetch;

console.log('\n20. an unreachable model registry is surfaced, not hidden');
globalThis.__modelsFail = true;
await tc.loadModelLabels();
tc.render();
ok(tc.modelLabelsUnavailable===true, 'the failure is recorded');
ok(document.getElementById('model-label-note').hidden===false, 'the "By model" note is shown');
globalThis.__modelsFail = false;
await tc.loadModelLabels();
tc.render();
ok(tc.modelLabelsUnavailable===false, 'a reachable registry clears it');
ok(document.getElementById('model-label-note').hidden===true, 'and the note is hidden again');

console.log('\n'+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
