# Fetch NT BPB practitioner detail pages (result.jsp?id=...) for ids found in saved ACTIVE category result lists. Polite: ~1.1s/request.
import re, os, sys, time, glob, urllib.request, urllib.error
RAW = sys.argv[1]; OUT = os.path.join(RAW, 'details')
ids = []
for f in sorted(glob.glob(os.path.join(RAW, 'results_*_ACTIVE.html'))):
    for m in re.finditer(r'href="result\.jsp\?id=(\d+)"', open(f, errors='replace').read()):
        if m.group(1) not in ids: ids.append(m.group(1))
print('ids', len(ids), flush=True)
UA = 'leads-research-script (python-urllib; contact admin)'
n = 0
for i in ids:
    fp = os.path.join(OUT, f'{i}.html')
    if os.path.exists(fp) and os.path.getsize(fp) > 1000: continue
    url = f'https://ntlis.nt.gov.au/building-practitioners/result.jsp?id={i}'
    backoff = 5
    for attempt in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(url), timeout=60) as r:
                b = r.read()
            if b'Practitioner Details' not in b:
                raise SystemExit(f'STOP unexpected page for {i}: {b[:300]!r}')
            open(fp, 'wb').write(b); break
        except urllib.error.HTTPError as e:
            if e.code in (401, 403, 429) and attempt >= 1 or e.code in (401, 403):
                raise SystemExit(f'STOP HTTP {e.code} on {i}')
            print(f'HTTP {e.code} {i} backoff {backoff}', flush=True)
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            print(f'net {e} {i} backoff {backoff}', flush=True)
        time.sleep(backoff); backoff *= 2
    else:
        raise SystemExit(f'STOP repeated failures on {i}')
    n += 1
    if n % 50 == 0: print(time.strftime('%H:%M:%S'), n, flush=True)
    time.sleep(1.1)
print('FINISHED', n, flush=True)
