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
  // The app resolves its events endpoint through the SDK and throws without
  // one, so the harness has to provide it the same way freshness.test.mjs does.
  apiUrl: (s) => '/dev/api/v1' + (s.startsWith('/') ? s : '/' + s),
  ui:{ applyPreferences(){}, watchPreferences(){}, enhanceSelects(){}, toast(){},
       Select:{ create:(o)=>({element:mkEl('sel'), getValue:()=>o.value, setValue(){}, setOptions(){}, destroy(){}}) } },
  data:{ read: async (p)=> p.includes('pricing') ? pricingRaw : JSON.stringify(daily), write: async()=>({success:true}), url:(p)=> p.startsWith('system-knowhow/') ? '/dev/api/v1/data/'+p : '/dev/data/'+p },
  events:{}, sse:{ connect(){}, on(){} },
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

console.log('\n'+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
