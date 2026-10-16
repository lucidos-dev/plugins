#!/usr/bin/env python3
"""Per-thread cost snapshot for the Thread cost widget.

Prices every ContextCaptured call per thread at the dated, served-model rates in
artifacts/token-cost/pricing.json (same rules as the Token Cost rollup), then
writes artifacts/token-cost/threads-cost.json through `lucidos data write`, so
the write is committed and announced. The snapshot carries `last_sequence` and
today's rate cards, so the widget prices calls after the cursor live.
"""
import os, sys, json, re, subprocess, datetime, pathlib
WS = os.environ.get('LUCIDOS_WORKSPACE')
if not WS: raise SystemExit('LUCIDOS_WORKSPACE is not set: run this from a Lucidos trigger, run_python or run_bash')
# The engine sets no PG* vars (ADR 0481); the workspace URL is the only way in.
if not os.environ.get('LUCIDOS_DATABASE_URL'): raise SystemExit('LUCIDOS_DATABASE_URL is not set: run this from a Lucidos trigger, run_python or run_bash')
os.chdir(WS)
def local_tz():
    # Same rule as apps/token-cost/scripts/rollup.py: days are bucketed in the
    # machine's own IANA timezone, read from /etc/localtime, then TZ, then UTC.
    try:
        parts=pathlib.Path('/etc/localtime').resolve().parts
        if 'zoneinfo' in parts:
            i=len(parts)-1-parts[::-1].index('zoneinfo'); name='/'.join(parts[i+1:])
            if name: return name
    except OSError: pass
    return os.environ.get('TZ') or 'UTC'
def psql(sql):
    r=subprocess.run(["psql",os.environ["LUCIDOS_DATABASE_URL"],"-A","-t","-c",sql],capture_output=True,text=True)
    if r.returncode: raise SystemExit(r.stderr)
    return r.stdout
TZ=local_tz()
sql=f"""SELECT coalesce(json_agg(t),'[]') FROM (
SELECT thread_id::text AS tid, dy, mdl, producer, count(*) AS calls, sum(i) AS i, sum(cr) AS cr, sum(cw) AS cw, sum(o) AS o,
 coalesce(sum(i) FILTER (WHERE i>272000),0) AS li, coalesce(sum(cr) FILTER (WHERE i>272000),0) AS lcr, coalesce(sum(cw) FILTER (WHERE i>272000),0) AS lcw, coalesce(sum(o) FILTER (WHERE i>272000),0) AS lo
FROM (SELECT thread_id, ((created AT TIME ZONE '{TZ}')::date)::text AS dy,
  lower(coalesce(nullif(payload->>'served_model',''), payload->>'model')) AS mdl, payload->>'producer' AS producer,
  (payload->'usage'->>'input_tokens')::bigint AS i,
  coalesce((payload->'usage'->>'cache_read_tokens')::bigint,0) AS cr,
  coalesce((payload->'usage'->>'cache_creation_tokens')::bigint,0) AS cw,
  (payload->'usage'->>'output_tokens')::bigint AS o,
  ((payload->'usage') IS NOT DISTINCT FROM LAG(payload->'usage') OVER (PARTITION BY thread_id ORDER BY sequence)
    AND payload->>'producer'='claude_code') AS dup
 FROM events WHERE event_type='ContextCaptured' AND payload->'usage' IS NOT NULL) s
WHERE NOT dup GROUP BY 1,2,3,4) t"""
max_seq=int(psql("SELECT coalesce(max(sequence),0) FROM events WHERE event_type='ContextCaptured'").strip())
sql=sql.replace("WHERE event_type='ContextCaptured' AND",f"WHERE event_type='ContextCaptured' AND sequence<={max_seq} AND")
rows=json.loads(psql(sql))
P=json.load(open('data/artifacts/token-cost/pricing.json'))['models']
def key(m):
    m=re.sub(r'@[^\[]*','',m); m=m.replace('[1m]','')
    if m in P: return m
    m=re.sub(r'^(?:[a-z]{2,6}\.)?anthropic\.','',m)
    if m not in P: m=re.sub(r'^(?:[a-z0-9_-]+/)+','',m)
    m=re.sub(r'-v\d+(?::\d+)?$','',m)
    if m.startswith('claude-'): m=re.sub(r'(\d)\.(\d)',r'\1-\2',m)
    if m not in P: m=re.sub(r'-\d{3,}(-\d+)*$','',m)
    return m if m in P else None
def card(k,day):
    best=None
    for c in P[k]:
        if c.get('from','0000')<=day: best=c
    return best
unpriced={}; per={}
def price(i,cr,cw,o,cc):
    return ((i-cr-cw)*cc['uncached_in']+cr*(cc.get('cache_read') or 0)+cw*(cc.get('cache_write') or 0)+o*cc['out'])/1e6
for r in rows:
    m=r['mdl'] or ''
    k=key(m); c=card(k,r['dy']) if k else None
    if not (c and isinstance(c.get('uncached_in'),(int,float)) and isinstance(c.get('out'),(int,float))):
        unpriced[m]=unpriced.get(m,0)+r['calls']; cost=0
    else:
        lg=c.get('long')
        if lg and r['li'] and lg.get('threshold_tokens')==272000:
            cost=price(r['i']-r['li'],r['cr']-r['lcr'],r['cw']-r['lcw'],r['o']-r['lo'],c)+price(r['li'],r['lcr'],r['lcw'],r['lo'],{**c,**lg})
        else: cost=price(r['i'],r['cr'],r['cw'],r['o'],c)
    t=per.setdefault(r['tid'],{'cost':0,'calls':0,'models':{},'first':r['dy'],'last':r['dy'],'producers':set(),'today':0})
    t['cost']+=cost; t['calls']+=r['calls']
    tm=t['models'].setdefault(k or m,{'all':0,'today':0,'calls':0}); tm['all']+=cost; tm['calls']+=r['calls']
    t['first']=min(t['first'],r['dy']); t['last']=max(t['last'],r['dy']); t['producers'].add(r['producer'])
    if r['dy']==datetime.date.today().isoformat(): t['today']+=cost; tm['today']+=cost
titles={}
try: titles=json.loads(psql("SELECT json_object_agg(thread_id::text, coalesce(title,'')) FROM thread_summaries")) or {}
except SystemExit as e: print('titles err',str(e)[:200])
total=sum(t['cost'] for t in per.values()); today=sum(t['today'] for t in per.values())
lst=[{'thread_id':tid,'title':titles.get(tid,''),'cost_usd':round(t['cost'],2),'today_usd':round(t['today'],2),'calls':t['calls'],'first':t['first'],'last':t['last'],
      'producers':sorted(p for p in t['producers'] if p),'top_model':max(t['models'],key=lambda mk:t['models'][mk]['all']),
      'models':{mk:{'all':round(v['all'],4),'today':round(v['today'],4),'calls':v['calls']} for mk,v in t['models'].items()}} for tid,t in per.items()]
lst.sort(key=lambda x:-x['cost_usd'])
json.dump({'generated':datetime.datetime.now(datetime.UTC).isoformat(),'total_usd':round(total,2),'today_usd':round(today,2),'threads':len(lst),'unpriced_calls':unpriced,'items':lst},open(os.path.join(os.environ.get('LUCIDOS_WORKSPACE','.'),'.lucidos/tmp/threads-cost-full.json'),'w'),indent=1)
print('total',round(total,2),'today',round(today,2),'threads',len(lst))
print('unpriced',sorted(unpriced.items(),key=lambda x:-x[1])[:10])
for x in lst[:20]: print(f"{x['cost_usd']:>9.2f} {x['calls']:>6} {x['first']}..{x['last']} {x['top_model'][:18]:18} {','.join(x['producers'])[:20]:20} {x['title'][:55]} {x['thread_id']}")
print('top20 share', round(sum(x['cost_usd'] for x in lst[:20])/total*100,1))
td=sorted(lst,key=lambda x:-x['today_usd'])[:10]
print('TODAY'); [print(f"{x['today_usd']:>8.2f} {x['title'][:60]} {x['thread_id']}") for x in td]
bands=[(1000,1e9),(100,1000),(10,100),(1,10),(0,1)]
for a,b in bands: s=[x for x in lst if a<=x['cost_usd']<b]; print(a,b,len(s),round(sum(x['cost_usd'] for x in s),2))

lastts=json.loads(psql(f"SELECT coalesce(json_object_agg(t,l),'{{}}') FROM (SELECT thread_id::text t, max(created) l FROM events WHERE event_type='ContextCaptured' AND sequence<={max_seq} AND thread_id IS NOT NULL GROUP BY 1) x"))
def slim(x): return {'id':x['thread_id'],'title':x['title'] or 'Untitled','all':x['cost_usd'],'today':x['today_usd'],'calls':x['calls'],'models':x['models'],'last':lastts.get(x['thread_id'])}
day=datetime.date.today().isoformat()
rates={}
for k in P:
    c=card(k,day)
    if c and isinstance(c.get('uncached_in'),(int,float)) and isinstance(c.get('out'),(int,float)):
        e={'in':c['uncached_in'],'cr':c.get('cache_read') or 0,'cw':c.get('cache_write') or 0,'out':c['out']}
        lg=c.get('long')
        if isinstance(lg,dict) and lg.get('threshold_tokens'):
            e['long']={'t':lg['threshold_tokens'],'inclusive':lg.get('inclusive') is True,'in':lg.get('uncached_in',e['in']),'cr':lg.get('cache_read',e['cr']) or 0,'cw':lg.get('cache_write',e['cw']) or 0,'out':lg.get('out',e['out'])}
        rates[k]=e
top_all=[slim(x) for x in lst[:300]]
top_today=[slim(x) for x in sorted(lst,key=lambda x:-x['today_usd'])[:400] if x['today_usd']>0]
listed={r['id'] for r in top_all+top_today}
# Every other thread, compact: [title, all, today, calls, last, {model: [all, today, calls]}].
# The widget looks a thread up here when it is in neither list, so it never reads $0.
rest={x['thread_id']:[x['title'],x['cost_usd'],x['today_usd'],x['calls'],lastts.get(x['thread_id']),{mk:[v['all'],v['today'],v['calls']] for mk,v in x['models'].items()}]
      for x in lst if x['thread_id'] not in listed}
out={'generated':datetime.datetime.now(datetime.UTC).isoformat(timespec='seconds'),'day':day,'last_sequence':max_seq,
 'total_all':round(total,2),'total_today':round(today,2),'threads':len(lst),'rates':rates,
 'top_all':top_all,'top_today':top_today,'rest':rest}
w=subprocess.run(['lucidos','data','write','artifacts/token-cost/threads-cost.json','--from','-'],input=json.dumps(out),capture_output=True,text=True)
if w.returncode: raise SystemExit('lucidos data write failed: '+w.stderr[:400])
print('wrote snapshot, cursor',max_seq)
