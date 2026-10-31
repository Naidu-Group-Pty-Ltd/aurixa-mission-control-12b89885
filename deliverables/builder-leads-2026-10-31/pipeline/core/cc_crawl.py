# Verify Common Crawl candidate domains and collect emails (same rules as enrich_v3: robots.txt, ABN or full name + state,
# Cloudflare-protected pages skipped, own-domain/mailbox-provider addresses only).
import sys, json, threading, queue, time, importlib.util
_argv = sys.argv; sys.argv = ['x', 'a', 'b', 'c']
spec = importlib.util.spec_from_file_location('e3', '/tmp/leads/scripts/enrich_v3.py'); e3 = importlib.util.module_from_spec(spec); spec.loader.exec_module(e3)
sys.argv = _argv
e2 = e3.e2
from urllib.parse import urlparse
import re
AUS = re.compile(r'australia|\+61|\(0[2378]\)|\b0[2378] \d{4} \d{4}\b|\b04\d{2} ?\d{3} ?\d{3}\b|\b1[38]00 ?\d{3} ?\d{3}\b|queensland|victoria|new south wales|tasmania|northern territory|canberra|\.com\.au', re.I)
INP, OUT, RQ = sys.argv[1], sys.argv[2], sys.argv[3]
def work(rec):
    abn = rec['abn']
    for d in rec['candidates']:
        body = None
        for host in ('www.' + d, d):
            if not e2.robots_ok('https://' + host + '/'): continue
            url, body = e2.get('https://' + host + '/')
            if body: break
        if not body: continue
        conf = e2.verify(body, rec, abn, 'suffix')   # 'suffix' = no keyword-only matches
        if not conf: continue
        if d.endswith('.com') and not conf.startswith('Verified') and not AUS.search(e2.text_of(body)): continue  # overseas namesake
        em, pg, cfp, abn_seen, rq = e3.crawl3(url, body, abn)
        if abn_seen and not conf.startswith('Verified'): conf = 'Verified: ABN shown on website'
        if rec.get('ind') and not conf.startswith('Verified') and not e3.e2.re.search(r'(build|construct|home|renovat|carpent|project|develop|roof|kitchen|bathroom|joiner|concret|deck|extension|maint|struct|frame)', d):
            continue
        return dict(abn=abn, website='https://' + urlparse(url).netloc.split(':')[0], web_conf=conf + ' (found via Common Crawl domain list)', emails=em, pages=pg, cf_pages=cfp, render=rq, status='ok')
    return dict(abn=abn, website=None, status='no verified candidate')
done = set()
try:
    for l in open(OUT): done.add(json.loads(l)['abn'])
except FileNotFoundError: pass
q = queue.Queue(); [q.put(r) for r in (json.loads(l) for l in open(INP)) if r['abn'] not in done]
total = q.qsize(); cnt = [0, 0, 0]; t0 = time.time(); lock = threading.Lock(); fo = open(OUT, 'a'); fr = open(RQ, 'a')
def run():
    while True:
        try: rec = q.get_nowait()
        except queue.Empty: return
        try: res = work(rec)
        except Exception as ex: res = dict(abn=rec['abn'], website=None, status='error ' + str(ex)[:60])
        with lock:
            fo.write(json.dumps(res) + '\n'); fo.flush()
            for u in res.get('render') or []: fr.write(json.dumps(dict(abn=res['abn'], url=u, website=res.get('website'), web_conf=res.get('web_conf', ''))) + '\n')
            fr.flush(); cnt[0] += 1; cnt[1] += bool(res.get('website')); cnt[2] += bool(res.get('emails'))
            if cnt[0] % 250 == 0: print(f'{cnt[0]}/{total} sites {cnt[1]} emails {cnt[2]} {time.time()-t0:.0f}s', flush=True)
ths = [threading.Thread(target=run, daemon=True) for _ in range(120)]; [t.start() for t in ths]; [t.join() for t in ths]
print('DONE', cnt, flush=True)
