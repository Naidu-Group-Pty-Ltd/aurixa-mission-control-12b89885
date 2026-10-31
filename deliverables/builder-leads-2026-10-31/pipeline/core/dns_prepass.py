# Resolve every candidate domain once, in bulk, so the crawl only touches domains that exist.
import sys, json, threading, queue, time
sys.argv = [sys.argv[0]] + sys.argv[1:]
import importlib.util
spec = importlib.util.spec_from_file_location('e2', '/tmp/leads/scripts/enrich_v2.py'); e2 = importlib.util.module_from_spec(spec)
sys_argv = sys.argv; sys.argv = ['x']; spec.loader.exec_module(e2); sys.argv = sys_argv
inputs, out = sys.argv[1:-1], sys.argv[-1]
doms = []
seen = set()
for f in inputs:
    for l in open(f):
        r = json.loads(l)
        for st, kind in e2.stems(r['names'], not r.get('ind')):
            for tld in (('.com.au', '.au', '.com') if kind == 'name' else ('.com.au',)):
                d = st + tld
                if d not in seen: seen.add(d); doms.append(d)
print('candidate domains', len(doms), flush=True)
done = {}
try:
    for l in open(out): d, v = l.rstrip('\n').split('\t'); done[d] = v
except FileNotFoundError: pass
q = queue.Queue(); [q.put(d) for d in doms if d not in done]
lock = threading.Lock(); fo = open(out, 'a'); cnt = [0, 0]; t0 = time.time()
def run():
    while True:
        try: d = q.get_nowait()
        except queue.Empty: return
        v = e2.dns_state(d); res = [(d, v)]
        if v == 'Z': res.append(('www.' + d, e2.dns_state('www.' + d)))
        with lock:
            for a, b in res: fo.write(f'{a}\t{b}\n')
            cnt[0] += 1; cnt[1] += v != 'N'
            if cnt[0] % 20000 == 0: print(cnt, f'{time.time()-t0:.0f}s', flush=True); fo.flush()
ths = [threading.Thread(target=run) for _ in range(int(__import__('os').environ.get('NT', '200')))]
[t.start() for t in ths]; [t.join() for t in ths]; fo.close()
print('DONE', cnt, f'{time.time()-t0:.0f}s')
