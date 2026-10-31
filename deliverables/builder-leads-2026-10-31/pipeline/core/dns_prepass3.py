import sys, json, threading, queue, time, os, importlib.util
_argv = sys.argv; sys.argv = ['x', 'a', 'b', 'c']
spec = importlib.util.spec_from_file_location('e3', '/tmp/leads/scripts/enrich_v3.py'); e3 = importlib.util.module_from_spec(spec); spec.loader.exec_module(e3)
sys.argv = _argv
inputs, out, prior = sys.argv[1:-2], sys.argv[-2], sys.argv[-1]
known = set()
for l in open(prior): known.add(l.split('\t', 1)[0])
doms = []; seen = set()
for f in inputs:
    for l in open(f):
        for d, k in e3.candidate_domains(json.loads(l)):
            if d not in seen and d not in known: seen.add(d); doms.append(d)
print('new candidate domains', len(doms), flush=True)
q = queue.Queue(); [q.put(d) for d in doms]; lock = threading.Lock(); fo = open(out, 'a'); cnt = [0, 0]; t0 = time.time()
def run():
    while True:
        try: d = q.get_nowait()
        except queue.Empty: return
        v = e3.e2.dns_state(d); res = [(d, v)]
        if v == 'Z': res.append(('www.' + d, e3.e2.dns_state('www.' + d)))
        with lock:
            for a, b in res: fo.write(f'{a}\t{b}\n')
            cnt[0] += 1; cnt[1] += v != 'N'
            if cnt[0] % 20000 == 0: print(cnt, f'{time.time()-t0:.0f}s', flush=True); fo.flush()
ths = [threading.Thread(target=run) for _ in range(int(os.environ.get('NT', '400')))]
[t.start() for t in ths]; [t.join() for t in ths]; fo.close()
print('DONE', cnt, f'{time.time()-t0:.0f}s')
